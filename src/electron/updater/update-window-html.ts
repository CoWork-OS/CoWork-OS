/**
 * The software update window's page: a small native-looking dialog in the style of
 * a macOS Sparkle updater. It is loaded from a data: URL, so it has no preload;
 * the main process pushes state with `window.__setUpdateState(state)` and the page
 * reports clicks and its height as console messages prefixed with
 * UPDATE_WINDOW_MESSAGE_PREFIX.
 */

export const UPDATE_WINDOW_MESSAGE_PREFIX = "__COWORK_UPDATE__:";

export type UpdateWindowAction =
  | "install"
  | "skip"
  | "later"
  | "cancel"
  | "relaunch"
  | "close"
  | "auto-download-on"
  | "auto-download-off";

export const UPDATE_WINDOW_ACTIONS: readonly UpdateWindowAction[] = [
  "install",
  "skip",
  "later",
  "cancel",
  "relaunch",
  "close",
  "auto-download-on",
  "auto-download-off",
];

export type UpdateWindowState =
  | {
      view: "available";
      currentVersion: string;
      latestVersion: string;
      /** Only packaged builds can download on their own. */
      showAutoDownload: boolean;
      autoDownload: boolean;
    }
  | {
      /** The compact "Updating CoWork OS" window: checking, downloading, verifying, installing. */
      view: "progress";
      title: string;
      /** Omitted for an indeterminate bar. */
      percent?: number;
      detail?: string;
      cancellable: boolean;
    }
  | { view: "ready"; latestVersion: string }
  | { view: "up-to-date"; title: string; detail: string }
  | { view: "error"; title: string; detail: string };

export function isUpdateWindowAction(value: string): value is UpdateWindowAction {
  return (UPDATE_WINDOW_ACTIONS as readonly string[]).includes(value);
}

/** Read a console message from the page: an action, a content height, or nothing of ours. */
export function parseUpdateWindowMessage(
  message: string,
): { kind: "action"; action: UpdateWindowAction } | { kind: "height"; height: number } | null {
  if (!message.startsWith(UPDATE_WINDOW_MESSAGE_PREFIX)) return null;
  const body = message.slice(UPDATE_WINDOW_MESSAGE_PREFIX.length);
  if (body.startsWith("height:")) {
    const height = Number(body.slice("height:".length));
    return Number.isFinite(height) && height > 0 && height < 2000
      ? { kind: "height", height: Math.ceil(height) }
      : null;
  }
  return isUpdateWindowAction(body) ? { kind: "action", action: body } : null;
}

/** Decimal sizes like Finder: "96.2 MB of 100.4 MB" (locale decides the separator). */
export function formatUpdateBytes(downloaded: number, total: number, locale?: string): string {
  const format = (bytes: number) => {
    const units = ["KB", "MB", "GB"] as const;
    let value = bytes / 1000;
    let unit: (typeof units)[number] = units[0];
    for (const next of units.slice(1)) {
      if (value < 1000) break;
      value /= 1000;
      unit = next;
    }
    let text: string;
    try {
      text = value.toLocaleString(locale, { minimumFractionDigits: 1, maximumFractionDigits: 1 });
    } catch {
      text = value.toFixed(1);
    }
    return `${text} ${unit}`;
  };
  return `${format(Math.max(0, downloaded))} of ${format(Math.max(0, total))}`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

export function buildUpdateWindowHtml(options: {
  appName: string;
  /** A data: URL of the app icon, or omitted for a plain tile. */
  iconDataUrl?: string;
  /** macOS draws the traffic lights over the page, so the page leaves room and draws the title. */
  drawsTitleBar: boolean;
}): string {
  const icon =
    options.iconDataUrl && options.iconDataUrl.startsWith("data:image/")
      ? `<img class="icon" alt="" src="${escapeHtml(options.iconDataUrl)}" />`
      : `<div class="icon icon-fallback" aria-hidden="true"></div>`;
  const prefix = JSON.stringify(UPDATE_WINDOW_MESSAGE_PREFIX);
  const appNameJson = JSON.stringify(options.appName);

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <!-- Loaded from a data: URL, so the renderer's CSP does not apply. Only our own
       inline script runs; state arrives as data and is written with textContent. -->
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'; base-uri 'none'; frame-src 'none'; connect-src 'none';" />
  <title>Software Update</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #ffffff;
      --text: #1d1d1f;
      --muted: #6e6e73;
      --hairline: rgba(0, 0, 0, 0.1);
      --button: rgba(0, 0, 0, 0.07);
      --button-hover: rgba(0, 0, 0, 0.11);
      --button-text: #1d1d1f;
      --accent: #0a7aff;
      --accent-hover: #006ae6;
      --track: rgba(0, 0, 0, 0.08);
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #2a2a2c;
        --text: #f5f5f7;
        --muted: #a1a1a6;
        --hairline: rgba(255, 255, 255, 0.1);
        --button: rgba(255, 255, 255, 0.12);
        --button-hover: rgba(255, 255, 255, 0.17);
        --button-text: #f5f5f7;
        --accent: #0a84ff;
        --accent-hover: #2b95ff;
        --track: rgba(255, 255, 255, 0.12);
      }
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    html, body {
      background: var(--bg);
      color: var(--text);
      font: 13px/1.38 -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
      -webkit-font-smoothing: antialiased;
      overflow: hidden;
      user-select: none;
      cursor: default;
    }
    .titlebar {
      height: ${options.drawsTitleBar ? "28px" : "0"};
      -webkit-app-region: drag;
    }
    .titlebar.with-title {
      height: ${options.drawsTitleBar ? "32px" : "0"};
      display: flex;
      align-items: center;
      padding-left: 78px;
      border-bottom: 1px solid var(--hairline);
      font-weight: 600;
      color: var(--muted);
    }
    .titlebar.with-title .title-text { display: ${options.drawsTitleBar ? "block" : "none"}; }
    .titlebar .title-text { display: none; }
    .content { display: flex; gap: 16px; padding: 12px 20px 18px; }
    .available-view .content { padding-bottom: 0; }
    .progress-view .content { padding: 14px 20px 16px; gap: 14px; align-items: flex-start; }
    .icon { width: 64px; height: 64px; flex: none; border-radius: 14px; object-fit: contain; }
    .progress-view .icon { width: 52px; height: 52px; border-radius: 12px; }
    .icon-fallback { background: linear-gradient(145deg, #3a3a3c, #1c1c1e); }
    .body { flex: 1; min-width: 0; }
    h1 { font-size: 13px; font-weight: 700; margin: 2px 0 4px; }
    .progress-view h1 { margin: 4px 0 8px; }
    p { color: var(--text); }
    .muted { color: var(--muted); }
    .check {
      display: flex; align-items: center; gap: 7px;
      margin: 14px 20px 0;
    }
    .check input { width: 15px; height: 15px; accent-color: var(--accent); margin: 0; }
    .actions { display: flex; gap: 10px; align-items: center; padding: 12px 20px 18px; }
    .actions .spacer { flex: 1; }
    button {
      -webkit-app-region: no-drag;
      font: inherit; font-size: 13px;
      height: 28px; padding: 0 16px; min-width: 76px;
      border: none; border-radius: 999px;
      background: var(--button); color: var(--button-text);
      cursor: default;
    }
    button:hover:not(:disabled) { background: var(--button-hover); }
    button:focus-visible { outline: 3px solid color-mix(in srgb, var(--accent) 45%, transparent); outline-offset: 1px; }
    button.primary { background: var(--accent); color: #fff; }
    button.primary:hover:not(:disabled) { background: var(--accent-hover); }
    button:disabled { opacity: 0.45; }
    .bar { height: 6px; border-radius: 999px; background: var(--track); overflow: hidden; margin-bottom: 10px; }
    .fill { height: 100%; border-radius: 999px; background: var(--accent); transition: width 0.25s ease; }
    .bar.indeterminate .fill { width: 30% !important; animation: slide 1.2s ease-in-out infinite; }
    @keyframes slide { 0% { transform: translateX(-110%); } 100% { transform: translateX(360%); } }
    @media (prefers-reduced-motion: reduce) {
      .fill { transition: none; }
      .bar.indeterminate .fill { animation: none; width: 100% !important; opacity: 0.4; }
    }
    .row { display: flex; align-items: center; gap: 12px; min-height: 28px; }
    .row .detail { flex: 1; font-variant-numeric: tabular-nums; }
    [hidden] { display: none !important; }
  </style>
</head>
<body>
  <div id="root"></div>
  <template id="icon">${icon}</template>
  <script>
    (function () {
      var PREFIX = ${prefix};
      var APP = ${appNameJson};
      var root = document.getElementById("root");
      var iconTemplate = document.getElementById("icon");

      function send(message) { console.log(PREFIX + message); }
      function el(tag, className, text) {
        var node = document.createElement(tag);
        if (className) node.className = className;
        if (text !== undefined) node.textContent = text;
        return node;
      }
      function button(label, action, primary, disabled) {
        var node = el("button", primary ? "primary" : "", label);
        node.type = "button";
        node.disabled = Boolean(disabled);
        node.addEventListener("click", function () { send(action); });
        return node;
      }
      function icon() { return iconTemplate.content.firstElementChild.cloneNode(true); }
      function titlebar(title) {
        var bar = el("div", title ? "titlebar with-title" : "titlebar");
        if (title) bar.appendChild(el("span", "title-text", title));
        return bar;
      }

      function renderAvailable(state) {
        root.className = "available-view";
        root.appendChild(titlebar());
        var content = el("div", "content");
        content.appendChild(icon());
        var body = el("div", "body");
        body.appendChild(el("h1", "", "A new version of " + APP + " is available!"));
        body.appendChild(el("p", "", APP + " " + state.latestVersion + " is now available\\u2014you have " +
          state.currentVersion + ". Would you like to download it now?"));
        content.appendChild(body);
        root.appendChild(content);
        if (state.showAutoDownload) {
          var label = el("label", "check");
          var box = el("input");
          box.type = "checkbox";
          box.checked = Boolean(state.autoDownload);
          box.addEventListener("change", function () {
            send(box.checked ? "auto-download-on" : "auto-download-off");
          });
          label.appendChild(box);
          label.appendChild(el("span", "", "Automatically download updates in the future"));
          root.appendChild(label);
        }
        var actions = el("div", "actions");
        actions.appendChild(button("Skip This Version", "skip"));
        actions.appendChild(el("span", "spacer"));
        actions.appendChild(button("Remind Me Later", "later"));
        var install = button("Install Update", "install", true);
        actions.appendChild(install);
        root.appendChild(actions);
      }

      function renderStatus(title, percent, detail, buttonLabel, action, primary, disabled) {
        root.className = "progress-view";
        root.appendChild(titlebar("Updating " + APP));
        var content = el("div", "content");
        content.appendChild(icon());
        var body = el("div", "body");
        body.appendChild(el("h1", "", title));
        var bar = el("div", typeof percent === "number" ? "bar" : "bar indeterminate");
        bar.setAttribute("role", "progressbar");
        bar.setAttribute("aria-label", title);
        if (typeof percent === "number") bar.setAttribute("aria-valuenow", String(Math.round(percent)));
        var fill = el("div", "fill");
        fill.style.width = (typeof percent === "number" ? Math.max(0, Math.min(100, percent)) : 0) + "%";
        bar.appendChild(fill);
        body.appendChild(bar);
        var row = el("div", "row");
        row.appendChild(el("span", "detail muted", detail || ""));
        var control = button(buttonLabel, action, primary, disabled);
        row.appendChild(control);
        body.appendChild(row);
        content.appendChild(body);
        root.appendChild(content);
      }

      function renderMessage(title, detail) {
        root.className = "message-view";
        root.appendChild(titlebar());
        var content = el("div", "content");
        content.appendChild(icon());
        var body = el("div", "body");
        body.appendChild(el("h1", "", title));
        body.appendChild(el("p", "", detail));
        content.appendChild(body);
        root.appendChild(content);
        var actions = el("div", "actions");
        actions.appendChild(el("span", "spacer"));
        var ok = button("OK", "close", true);
        actions.appendChild(ok);
        root.appendChild(actions);
      }

      window.__setUpdateState = function (state) {
        root.textContent = "";
        if (state.view === "available") renderAvailable(state);
        else if (state.view === "progress")
          renderStatus(state.title, state.percent, state.detail, "Cancel", "cancel", false, !state.cancellable);
        else if (state.view === "ready")
          renderStatus("Ready to Install", 100, "", "Install and Relaunch", "relaunch", true, false);
        else renderMessage(state.title, state.detail);
        requestAnimationFrame(function () { send("height:" + root.getBoundingClientRect().bottom); });
      };

      // Return presses the blue default button, Escape closes, as in a native alert.
      document.addEventListener("keydown", function (event) {
        if (event.key === "Escape") send("close");
        if (event.key === "Enter" && !(document.activeElement instanceof HTMLButtonElement)) {
          var primary = root.querySelector("button.primary:not(:disabled)");
          if (primary) primary.click();
        }
      });
    })();
  </script>
</body>
</html>`;
}
