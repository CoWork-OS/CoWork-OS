import { z } from "zod";
import { SURFACE_ACTION_MAX_PROMPT_CHARS, SURFACE_ACTION_MAX_URL_CHARS } from "./actions";

/**
 * The bridge between an inline HTML answer surface and the app (SurfaceBridgeMessageV1).
 *
 * The surface runs on an opaque `cowork-preview://` origin with no network, so the only
 * way it can reach the app is `postMessage`. The app accepts a message only when it
 * comes from that frame's own window, carries the nonce the app sent at mount, and
 * passes the schemas below; everything else is dropped. The frame can ask for a height
 * (so it fits its content), to remember the user's inputs, and to report an error. It
 * can also ask to send a message or open a link (actions.ts), but only right after the
 * user clicked inside it, and only through the app's own confirmation. It cannot run
 * tools or read anything from the app.
 */

export const HTML_SURFACE_BRIDGE_VERSION = 1;
export const HTML_SURFACE_MAX_HTML_CHARS = 1_000_000;
export const HTML_SURFACE_MIN_HEIGHT = 48;
export const HTML_SURFACE_MAX_HEIGHT = 2400;
/** Matches the answer-state store, which validates the same shape again in main. */
export const HTML_SURFACE_MAX_STATE_KEYS = 60;
export const HTML_SURFACE_MAX_STATE_BYTES = 32 * 1024;
/** Messages per second a frame may send before the rest are dropped. */
export const HTML_SURFACE_MAX_MESSAGES_PER_SECOND = 40;

export const HtmlSurfaceStateSchema = z
  .record(
    z
      .string()
      .min(1)
      .max(40)
      .regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
    z.union([
      z.number().finite(),
      z.string().max(200),
      z.boolean(),
      z.array(z.string().max(60)).max(60),
    ]),
  )
  .refine((value) => Object.keys(value).length <= HTML_SURFACE_MAX_STATE_KEYS, "Too many values")
  .refine(
    (value) => JSON.stringify(value).length <= HTML_SURFACE_MAX_STATE_BYTES,
    "State is too large",
  );

export type HtmlSurfaceState = z.infer<typeof HtmlSurfaceStateSchema>;

const envelope = <T extends string, P extends z.ZodTypeAny>(type: T, payload: P) =>
  z
    .object({
      coworkSurface: z.literal(HTML_SURFACE_BRIDGE_VERSION),
      nonce: z.string().min(16).max(64),
      type: z.literal(type),
      payload,
    })
    .strict();

/** Messages a frame may send to the app. */
export const HtmlSurfaceFrameMessageSchema = z.discriminatedUnion("type", [
  envelope("resize", z.object({ height: z.number().finite().nonnegative() }).strict()),
  envelope("state.set", z.object({ state: HtmlSurfaceStateSchema }).strict()),
  envelope("error", z.object({ message: z.string().max(500) }).strict()),
  envelope(
    "action",
    z
      .object({
        id: z.number().int().nonnegative().max(1_000_000),
        action: z.union([
          z.object({ prompt: z.string().max(SURFACE_ACTION_MAX_PROMPT_CHARS) }).strict(),
          z.object({ open: z.string().max(SURFACE_ACTION_MAX_URL_CHARS) }).strict(),
        ]),
      })
      .strict(),
  ),
]);

export type HtmlSurfaceFrameMessage = z.infer<typeof HtmlSurfaceFrameMessageSchema>;

/** Messages the app sends to a frame. */
export type HtmlSurfaceHostMessage =
  | {
      coworkSurface: typeof HTML_SURFACE_BRIDGE_VERSION;
      type: "init";
      nonce: string;
      payload: {
        state: HtmlSurfaceState;
        theme: "light" | "dark";
        css: string | null;
        autosize: boolean;
      };
    }
  | {
      coworkSurface: typeof HTML_SURFACE_BRIDGE_VERSION;
      type: "theme";
      nonce: string;
      payload: { theme: "light" | "dark"; css: string | null };
    }
  | {
      coworkSurface: typeof HTML_SURFACE_BRIDGE_VERSION;
      type: "action.result";
      nonce: string;
      /** ok: the user approved and the app carried it out. */
      payload: { id: number; ok: boolean };
    };

export function clampSurfaceHeight(height: number): number {
  return Math.round(Math.min(HTML_SURFACE_MAX_HEIGHT, Math.max(HTML_SURFACE_MIN_HEIGHT, height)));
}

const MAX_SUMMARY_VALUE_CHARS = 80;

/** One value as inert, single-line text: page-written strings are quoted, never free prose. */
function summaryValue(value: HtmlSurfaceState[string]): string {
  const clean = (text: string) =>
    JSON.stringify(
      // Control characters and line breaks would let a page forge extra lines.
      text
        .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ")
        .slice(0, MAX_SUMMARY_VALUE_CHARS),
    );
  if (Array.isArray(value)) return `[${value.map(clean).join(", ")}]`;
  return typeof value === "string" ? clean(value) : String(value);
}

/**
 * "key: value" lines the next turn sees, so the model can build on the inputs. The page
 * chose these keys and values, so they are reported as quoted data; main recomputes this
 * from the validated state rather than trusting a summary sent by the renderer.
 */
export function summarizeHtmlSurfaceState(state: HtmlSurfaceState): string {
  return Object.entries(state)
    .map(([key, value]) => `${key}: ${summaryValue(value)}`)
    .join("\n")
    .slice(0, 2000);
}

/** The id of the injected design-language style, which theme messages replace. */
export const HTML_SURFACE_DESIGN_STYLE_ID = "cowork-rich-frame-design-language";

/**
 * Injected first into every served surface. It exposes `window.cowork` and talks to the
 * app; it runs inside the sandbox with the page's own privileges, which are none.
 */
export const HTML_SURFACE_BOOTSTRAP_SCRIPT = `(function () {
  "use strict";
  var V = ${HTML_SURFACE_BRIDGE_VERSION};
  var host = window.parent;
  if (!host || host === window) return;
  var nonce = null;
  var state = {};
  var theme = null;
  var autosize = false;
  var lastHeight = -1;
  var listeners = [];
  var actionSeq = 0;
  var actionWaiters = {};
  var resolveReady;
  var ready = new Promise(function (resolve) { resolveReady = resolve; });
  function send(type, payload) {
    if (!nonce) return;
    host.postMessage({ coworkSurface: V, nonce: nonce, type: type, payload: payload }, "*");
  }
  function measure() {
    if (!autosize || !document.body) return;
    var body = document.body;
    var style = window.getComputedStyle(body);
    var height = Math.ceil(body.getBoundingClientRect().height + parseFloat(style.marginTop || "0") + parseFloat(style.marginBottom || "0"));
    if (Math.abs(height - lastHeight) < 2) return;
    lastHeight = height;
    send("resize", { height: height });
  }
  var pending = false;
  function scheduleMeasure() {
    if (pending) return;
    pending = true;
    requestAnimationFrame(function () { pending = false; measure(); });
  }
  function applyTheme(nextTheme, css) {
    theme = nextTheme === "dark" ? "dark" : "light";
    var root = document.documentElement;
    root.setAttribute("data-cowork-theme", theme);
    root.style.colorScheme = theme;
    if (typeof css === "string") {
      var tag = document.getElementById("${HTML_SURFACE_DESIGN_STYLE_ID}");
      if (tag) tag.textContent = css;
    }
  }
  function isValue(value) {
    if (typeof value === "number") return isFinite(value);
    if (typeof value === "string") return value.length <= 200;
    if (typeof value === "boolean") return true;
    return Array.isArray(value) && value.length <= 60 && value.every(function (item) {
      return typeof item === "string" && item.length <= 60;
    });
  }
  window.addEventListener("message", function (event) {
    if (event.source !== host) return;
    var data = event.data;
    if (!data || data.coworkSurface !== V || typeof data.type !== "string") return;
    if (data.type === "init") {
      if (nonce || typeof data.nonce !== "string") return;
      nonce = data.nonce;
      var payload = data.payload || {};
      state = payload.state && typeof payload.state === "object" ? payload.state : {};
      autosize = payload.autosize === true;
      if (autosize) document.documentElement.classList.add("cowork-autosize");
      applyTheme(payload.theme, payload.css);
      resolveReady(api);
      listeners.slice().forEach(function (fn) { try { fn(Object.assign({}, state)); } catch (e) {} });
      scheduleMeasure();
      return;
    }
    if (data.nonce !== nonce) return;
    if (data.type === "theme" && data.payload) {
      applyTheme(data.payload.theme, data.payload.css);
      scheduleMeasure();
    }
    if (data.type === "action.result" && data.payload) {
      var waiter = actionWaiters[data.payload.id];
      if (waiter) {
        delete actionWaiters[data.payload.id];
        waiter(data.payload.ok === true);
      }
    }
  });
  function requestAction(request) {
    return new Promise(function (resolve) {
      var payload = null;
      if (request && typeof request.prompt === "string") payload = { prompt: request.prompt.slice(0, ${SURFACE_ACTION_MAX_PROMPT_CHARS}) };
      else if (request && typeof request.open === "string") payload = { open: request.open.slice(0, ${SURFACE_ACTION_MAX_URL_CHARS}) };
      if (!nonce || !payload || actionSeq >= 1000000) { resolve(false); return; }
      actionSeq += 1;
      actionWaiters[actionSeq] = resolve;
      send("action", { id: actionSeq, action: payload });
    });
  }
  // Design-kit helpers (icons, charts, formatting), when the kit was injected first.
  var kit = window.__coworkKit || {};
  try { delete window.__coworkKit; } catch (e) {}
  var api = Object.freeze({
    version: V,
    ready: ready,
    icon: kit.icon,
    renderIcons: kit.renderIcons,
    chart: kit.chart,
    format: kit.format,
    tween: kit.tween,
    theme: function () { return theme; },
    action: requestAction,
    state: Object.freeze({
      get: function () { return Object.assign({}, state); },
      set: function (patch) {
        if (!patch || typeof patch !== "object") return;
        var next = Object.assign({}, state);
        Object.keys(patch).forEach(function (key) {
          if (!/^[A-Za-z_][A-Za-z0-9_]{0,39}$/.test(key)) return;
          if (patch[key] === null || patch[key] === undefined) delete next[key];
          else if (isValue(patch[key])) next[key] = patch[key];
        });
        state = next;
        send("state.set", { state: next });
      },
      onChange: function (fn) { if (typeof fn === "function") listeners.push(fn); }
    })
  });
  Object.defineProperty(window, "cowork", { value: api, configurable: false, writable: false });
  // The CSP blocks fetch, images and forms but not WebRTC, whose ICE/STUN lookups could
  // carry typed data out. Removed before any page script runs; with frames blocked there
  // is no fresh window to recover them from.
  ["RTCPeerConnection", "webkitRTCPeerConnection", "RTCDataChannel", "RTCIceCandidate", "RTCSessionDescription"].forEach(function (name) {
    try { Object.defineProperty(window, name, { value: undefined, configurable: false, writable: false }); } catch (e) {}
  });
  window.addEventListener("error", function (event) {
    send("error", { message: String((event && event.message) || "Script error").slice(0, 500) });
  });
  function observe() {
    if (typeof ResizeObserver === "function") new ResizeObserver(scheduleMeasure).observe(document.documentElement);
    window.addEventListener("load", scheduleMeasure);
    scheduleMeasure();
  }
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", observe);
  else observe();
})();`;

/**
 * Lets an auto-sized surface report its natural height: the design language stretches
 * cards to the frame, which would otherwise pin the height to whatever it started at.
 */
export const HTML_SURFACE_AUTOSIZE_CSS = `html.cowork-autosize,
html.cowork-autosize body {
  min-height: 0 !important;
  height: auto !important;
  overflow: hidden;
}
html.cowork-autosize :where(.rf-card, .card, main, .frame) {
  min-height: 0 !important;
}`;

/** What the model is told about the runtime, next to the design-language prompt. */
export const HTML_SURFACE_RUNTIME_PROMPT = [
  "Inline HTML surface runtime:",
  "- Inline <script> and <style> run in a sandbox with no network: put all code, data, styles and SVG icons inside the document. External URLs, CDNs, fetch and remote images are blocked.",
  "- The frame grows to fit its content; don't set a fixed page height.",
  '- To remember the user\'s inputs across restarts and tell you what they chose, call `cowork.state.set({goal: 50000, plan: "basic"})` (flat keys; numbers, short strings, booleans or string lists). Restore them with `await cowork.ready; const saved = cowork.state.get();`.',
  '- A button can hand off to you or open a page: `cowork.action({prompt: "Book the 7:30 table for 4"})` sends a message to you, `cowork.action({open: "https://example.com/menu"})` opens an https link in the browser. Call it from a click handler; the app shows the exact message or link and acts only if the user approves. It resolves to true when done. A request that does not follow a click inside the page is ignored.',
  "- Never ask for passwords, card numbers or other secrets in a surface.",
].join("\n");
