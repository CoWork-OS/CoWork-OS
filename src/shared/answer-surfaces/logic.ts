import { z } from "zod";
import type { ExpressionValue } from "./expression";
import { isValidIdentifier } from "./expression";

/**
 * Surface logic: model-written JavaScript behind native answer components, for work the
 * formula language cannot express (loops, schedules, simulations, sorting). The code
 * never runs in the app. A hidden runner page on the sandboxed `cowork-preview://` origin
 * (opaque, no network, its own process) starts one Web Worker per surface from the code;
 * the app sends control values in and gets named outputs back, validated here before any
 * component shows them. Event handlers and DOM never exist on the worker side.
 */

export const LOGIC_PROTOCOL_VERSION = 1;
export const MAX_LOGIC_CODE_CHARS = 20_000;
export const MAX_LOGIC_OUTPUTS = 30;
export const MAX_LOGIC_LIST_ITEMS = 500;
export const MAX_LOGIC_TABLE_ROWS = 200;
export const MAX_LOGIC_TABLE_COLUMNS = 12;
export const MAX_LOGIC_RESULT_CHARS = 128 * 1024;
/** A run that takes longer is stopped and its worker restarted. */
export const LOGIC_RUN_TIMEOUT_MS = 1000;
/** Workers the runner keeps at once; the least recently used is stopped first. */
export const MAX_LOGIC_WORKERS = 12;

export type AnswerSurfaceLogic = { code: string; outputs: string[] };

/** Names an output may not take: they would collide with built-in object members. */
export function isReservedOutputName(name: string): boolean {
  return name === "__proto__" || name in Object.prototype;
}

export const AnswerSurfaceLogicSchema = z
  .object({
    code: z.string().trim().min(1).max(MAX_LOGIC_CODE_CHARS),
    outputs: z
      .array(
        z
          .string()
          .trim()
          .refine(isValidIdentifier, "must be a simple identifier")
          .refine((name) => !isReservedOutputName(name), "is a reserved name"),
      )
      .min(1)
      .max(MAX_LOGIC_OUTPUTS),
  })
  .strict();

const cell = z.union([z.number().finite(), z.string().max(200), z.boolean(), z.null()]);

/** One output: a scalar for formulas, a list for chart labels or series, or table rows. */
export const LogicOutputValueSchema = z.union([
  z.number().finite(),
  z.string().max(500),
  z.boolean(),
  z.array(cell).max(MAX_LOGIC_LIST_ITEMS),
  z.array(z.array(cell).max(MAX_LOGIC_TABLE_COLUMNS)).max(MAX_LOGIC_TABLE_ROWS),
]);

export type LogicOutputValue = z.infer<typeof LogicOutputValueSchema>;
export type LogicCell = z.infer<typeof cell>;

export type SurfaceLogicOutputs = {
  /** Scalars, readable by formulas like control values. */
  scope: Record<string, ExpressionValue>;
  /** Lists and tables, readable through `{"bind": "name"}`. */
  data: Record<string, LogicCell[] | LogicCell[][]>;
};

/** Parses a runner result (JSON text) into the declared outputs. */
export function readLogicResultJson(
  json: string,
  declared: readonly string[],
): SurfaceLogicOutputs {
  try {
    return readLogicOutputs(JSON.parse(json), declared);
  } catch {
    return readLogicOutputs(null, declared);
  }
}

/**
 * Keeps only declared outputs that fit the schema; anything else the code returned is
 * dropped. Non-finite numbers inside lists become null rather than failing the run.
 */
export function readLogicOutputs(raw: unknown, declared: readonly string[]): SurfaceLogicOutputs {
  // No prototype: an output name can never reach inherited members.
  const outputs: SurfaceLogicOutputs = { scope: Object.create(null), data: Object.create(null) };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return outputs;
  const record = raw as Record<string, unknown>;
  for (const name of declared) {
    if (isReservedOutputName(name) || !Object.prototype.hasOwnProperty.call(record, name)) continue;
    const value = normalizeNumbers(record[name]);
    const parsed = LogicOutputValueSchema.safeParse(value);
    if (!parsed.success) continue;
    if (Array.isArray(parsed.data)) outputs.data[name] = parsed.data as LogicCell[] | LogicCell[][];
    else outputs.scope[name] = parsed.data;
  }
  return outputs;
}

function normalizeNumbers(value: unknown): unknown {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(normalizeNumbers);
  return value;
}

/** Messages the runner page may send to the app. */
export const LogicRunnerMessageSchema = z.discriminatedUnion("type", [
  z
    .object({
      coworkLogic: z.literal(LOGIC_PROTOCOL_VERSION),
      nonce: z.string().min(16).max(64),
      type: z.literal("ready"),
    })
    .strict(),
  z
    .object({
      coworkLogic: z.literal(LOGIC_PROTOCOL_VERSION),
      nonce: z.string().min(16).max(64),
      type: z.literal("result"),
      id: z.string().min(1).max(80),
      seq: z.number().int().nonnegative(),
      json: z.string().max(MAX_LOGIC_RESULT_CHARS),
    })
    .strict(),
  z
    .object({
      coworkLogic: z.literal(LOGIC_PROTOCOL_VERSION),
      nonce: z.string().min(16).max(64),
      type: z.literal("error"),
      id: z.string().min(1).max(80),
      seq: z.number().int(),
      message: z.string().max(300),
    })
    .strict(),
]);

export type LogicRunnerMessage = z.infer<typeof LogicRunnerMessageSchema>;

/** Shown when the runner no longer holds a surface's worker; the app loads it again. */
export const LOGIC_NOT_LOADED_MESSAGE = "Surface logic is not loaded";
/** Runs that may compute at once across all surfaces; the rest wait their turn. */
export const MAX_CONCURRENT_LOGIC_RUNS = 3;
/** Timeouts or crashes after which a surface's logic is switched off. */
export const MAX_LOGIC_FAILURES = 3;

/*
 * Each run gets a fresh worker that is terminated as soon as it answers, so nothing the
 * code schedules (timers, promise chains) can outlive the run's time limit. Before the
 * model's code, the prelude keeps the real postMessage in a closure and removes the
 * worker's ways to reach out or multiply: the network (also blocked by the CSP), nested
 * workers, script imports, and stray messages to the runner.
 */
export const LOGIC_WORKER_PRELUDE = `"use strict";
var __coworkPost = self.postMessage.bind(self);
var __coworkOnce = false;
["fetch", "XMLHttpRequest", "WebSocket", "EventSource", "Worker", "SharedWorker", "importScripts", "postMessage", "BroadcastChannel", "WebTransport"].forEach(function (name) {
  try {
    Object.defineProperty(self, name, { value: undefined, configurable: false, writable: false });
  } catch (e) {}
});
`;

/**
 * Runs after the model's code: answers one run with compute(state), as a JSON string so
 * the runner can check its size without cloning arbitrary objects.
 */
export const LOGIC_WORKER_POSTLUDE = `
;self.onmessage = function (event) {
  if (__coworkOnce) return;
  __coworkOnce = true;
  var reply;
  try {
    if (typeof compute !== "function") throw new Error("Define function compute(state)");
    var values = compute(Object.freeze(Object.assign({}, event.data.state)));
    var json = JSON.stringify(values === undefined ? null : values);
    reply = json.length > ${MAX_LOGIC_RESULT_CHARS}
      ? { ok: false, message: "The result is too large" }
      : { ok: true, json: json };
  } catch (error) {
    reply = { ok: false, message: String((error && error.message) || error).slice(0, 300) };
  }
  __coworkPost(reply);
};
`;

/**
 * The runner page. It only relays between the app and the workers: it accepts messages
 * from its parent alone, runs at most ${MAX_CONCURRENT_LOGIC_RUNS} workers at a time with
 * a ${LOGIC_RUN_TIMEOUT_MS} ms limit each, switches a surface off after repeated failures,
 * and forwards results as size-checked JSON text. Served with the preview CSP (no
 * network) on an opaque origin, in its own renderer process.
 */
export const LOGIC_RUNNER_HTML = `<!doctype html>
<html><head><meta charset="utf-8"><title>Surface logic</title></head><body><script>
(function () {
  "use strict";
  var V = ${LOGIC_PROTOCOL_VERSION};
  var host = window.parent;
  var nonce = null;
  var surfaces = new Map();
  var queue = [];
  var active = 0;
  var PRELUDE = ${JSON.stringify(LOGIC_WORKER_PRELUDE)};
  var POSTLUDE = ${JSON.stringify(LOGIC_WORKER_POSTLUDE)};
  function send(message) {
    message.coworkLogic = V;
    message.nonce = nonce;
    host.postMessage(message, "*");
  }
  function finish(entry, run) {
    if (run.timer) clearTimeout(run.timer);
    run.worker.terminate();
    if (entry.current === run) entry.current = null;
    active -= 1;
    pump();
  }
  function fail(id, entry, seq, message) {
    entry.failures += 1;
    if (entry.failures >= ${MAX_LOGIC_FAILURES}) entry.disabled = message;
    send({ type: "error", id: id, seq: seq, message: message });
  }
  function start(id, entry) {
    var run = { seq: entry.pending.seq, worker: null, timer: null };
    var state = entry.pending.state;
    entry.pending = null;
    entry.current = run;
    active += 1;
    try {
      run.worker = new Worker(entry.url);
    } catch (e) {
      active -= 1;
      entry.current = null;
      fail(id, entry, run.seq, "The calculation could not start");
      return;
    }
    var answered = false;
    run.worker.onmessage = function (event) {
      if (answered) return;
      answered = true;
      var data = event.data;
      finish(entry, run);
      if (!data || typeof data !== "object") return fail(id, entry, run.seq, "The calculation failed");
      if (data.ok === true && typeof data.json === "string" && data.json.length <= ${MAX_LOGIC_RESULT_CHARS}) {
        entry.failures = 0;
        send({ type: "result", id: id, seq: run.seq, json: data.json });
      } else {
        send({ type: "error", id: id, seq: run.seq, message: String(data.message || "The calculation failed").slice(0, 300) });
      }
      if (entry.pending) schedule(id, entry);
    };
    run.worker.onerror = function (event) {
      event.preventDefault();
      if (answered) return;
      answered = true;
      finish(entry, run);
      fail(id, entry, run.seq, String((event && event.message) || "The calculation failed").slice(0, 300));
      if (entry.pending) schedule(id, entry);
    };
    run.timer = setTimeout(function () {
      if (answered) return;
      answered = true;
      finish(entry, run);
      fail(id, entry, run.seq, "The calculation took too long and was stopped");
      if (entry.pending) schedule(id, entry);
    }, ${LOGIC_RUN_TIMEOUT_MS});
    run.worker.postMessage({ state: state });
  }
  function pump() {
    while (active < ${MAX_CONCURRENT_LOGIC_RUNS} && queue.length) {
      var id = queue.shift();
      var entry = surfaces.get(id);
      if (entry && entry.pending && !entry.current) start(id, entry);
    }
  }
  function schedule(id, entry) {
    if (entry.disabled) {
      send({ type: "error", id: id, seq: entry.pending.seq, message: entry.disabled });
      entry.pending = null;
      return;
    }
    if (entry.current || queue.indexOf(id) !== -1) return;
    queue.push(id);
    pump();
  }
  function drop(id) {
    var entry = surfaces.get(id);
    if (!entry) return;
    if (entry.current) finish(entry, entry.current);
    URL.revokeObjectURL(entry.url);
    surfaces.delete(id);
    var at = queue.indexOf(id);
    if (at !== -1) queue.splice(at, 1);
  }
  window.addEventListener("message", function (event) {
    if (event.source !== host) return;
    var data = event.data;
    if (!data || data.coworkLogic !== V || typeof data.type !== "string") return;
    if (data.type === "hello") {
      if (nonce || typeof data.nonce !== "string") return;
      nonce = data.nonce;
      send({ type: "ready" });
      return;
    }
    if (data.nonce !== nonce || typeof data.id !== "string") return;
    var id = data.id;
    if (data.type === "load" && typeof data.code === "string" && data.code.length <= ${MAX_LOGIC_CODE_CHARS}) {
      drop(id);
      var url = URL.createObjectURL(new Blob([PRELUDE, data.code, POSTLUDE], { type: "text/javascript" }));
      surfaces.set(id, { url: url, pending: null, current: null, failures: 0, disabled: null });
      while (surfaces.size > ${MAX_LOGIC_WORKERS}) drop(surfaces.keys().next().value);
      return;
    }
    if (data.type === "run" && typeof data.seq === "number") {
      var entry = surfaces.get(id);
      if (!entry) {
        send({ type: "error", id: id, seq: data.seq, message: ${JSON.stringify(LOGIC_NOT_LOADED_MESSAGE)} });
        return;
      }
      // Newest wins: a queued run is replaced; a running one finishes first.
      entry.pending = { seq: data.seq, state: data.state && typeof data.state === "object" ? data.state : {} };
      surfaces.delete(id);
      surfaces.set(id, entry);
      schedule(id, entry);
    } else if (data.type === "dispose") {
      drop(id);
    }
  });
})();
</script></body></html>`;
