import crypto from "crypto";
import * as os from "os";
import { extractJsonValues, stableJsonStringify } from "../utils/json-utils";

export type MontyResourceLimits = {
  maxAllocations?: number;
  maxDurationSecs?: number;
  maxMemory?: number;
  gcInterval?: number;
  maxRecursionDepth?: number;
};

export type MontyRunError = {
  kind: "load" | "syntax" | "typing" | "runtime" | "unknown";
  message: string;
  display?: string;
  traceback?: unknown[];
};

export type MontyRunResult = { ok: true; output: unknown } | { ok: false; error: MontyRunError };

// The package's typings come from its browser-neutral entry; the Node entry we load at runtime
// also exports `findMontyBinary`.
type MontyModule = typeof import("@pydantic/monty") & {
  findMontyBinary?: (explicit?: string) => string;
};
type MontyPool = Awaited<ReturnType<MontyModule["Monty"]["create"]>>;

let montyModulePromise: Promise<MontyModule> | null = null;
let montyPoolPromise: Promise<MontyPool> | null = null;
let montyPoolClosed = false;

async function loadMontyModule(): Promise<MontyModule> {
  if (montyModulePromise) return montyModulePromise;

  const isTest = !!process.env.VITEST || process.env.NODE_ENV === "test";
  if (isTest) {
    montyModulePromise = import("@pydantic/monty");
    return montyModulePromise;
  }

  // TypeScript downlevels `import()` under CJS builds. Use a native dynamic import wrapper.
  const dynamicImport = new Function("specifier", "return import(specifier)") as (
    specifier: string,
  ) => Promise<MontyModule>;
  montyModulePromise = dynamicImport("@pydantic/monty");
  return montyModulePromise;
}

/**
 * Where the `monty` worker binary is. electron-builder unpacks the platform package
 * (`@pydantic/monty-<platform>`) next to app.asar because it holds native code, but Electron's
 * asar shim still resolves it to the path inside the archive, which the native spawn cannot run.
 */
function resolveMontyBinaryPath(mod: MontyModule): string | undefined {
  const found = mod.findMontyBinary?.();
  if (!found) return undefined;
  return found.replace(/([\\/])app\.asar([\\/])/, "$1app.asar.unpacked$2");
}

/**
 * One pool of crash-isolated `monty` worker subprocesses, created on first use and shared by
 * every caller. A worker that crashes takes down only its own session; the pool replaces it. A
 * pool that fails to start is forgotten so the next run tries again.
 */
async function getMontyPool(mod: MontyModule): Promise<MontyPool> {
  if (montyPoolClosed) throw new Error("Monty sandbox is shut down");
  if (montyPoolPromise) return montyPoolPromise;

  const pending = mod.Monty.create({
    binaryPath: resolveMontyBinaryPath(mod),
    minProcesses: 1,
    maxProcesses: Math.max(1, Math.min(4, os.cpus().length)),
    // Fail a run rather than queue it forever when every worker is busy.
    checkoutTimeout: 30,
    // Backstop for code that wedges the interpreter between the checkpoints where the in-sandbox
    // duration limit is checked; the pool also kills a worker 1 s past its feed budget.
    requestTimeout: 60,
    // Retire workers periodically so one session's process state never lives for long.
    maxCheckoutsPerWorker: 200,
  });
  montyPoolPromise = pending;
  pending.catch(() => {
    if (montyPoolPromise === pending) montyPoolPromise = null;
  });
  return pending;
}

/** Shuts the worker pool down on app quit. Later runs fail with a `load` error. */
export async function closeMontyPool(): Promise<void> {
  montyPoolClosed = true;
  const pending = montyPoolPromise;
  montyPoolPromise = null;
  if (!pending) return;
  try {
    const pool = await pending;
    await pool.close();
  } catch {
    // A pool that never started has nothing to close.
  }
}

export function sha256Hex(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

export function montyValueToJs(value: unknown, seen = new WeakMap<object, unknown>()): unknown {
  if (value === null || value === undefined) return value;
  const t = typeof value;
  if (t === "string" || t === "number" || t === "boolean" || t === "bigint") return value;

  if (Buffer.isBuffer(value)) return value;
  if (Array.isArray(value)) return value.map((v) => montyValueToJs(v, seen));

  if (value instanceof Map) {
    const obj: Record<string, unknown> = {};
    for (const [k, v] of value.entries()) {
      obj[String(k)] = montyValueToJs(v, seen);
    }
    return obj;
  }

  if (value instanceof Set) {
    return Array.from(value.values()).map((v) => montyValueToJs(v, seen));
  }

  if (t === "object") {
    const obj = value as Record<string, unknown>;
    if (seen.has(obj as unknown as object)) return seen.get(obj as unknown as object);
    const out: Record<string, unknown> = {};
    seen.set(obj as unknown as object, out);
    for (const [k, v] of Object.entries(obj)) {
      out[k] = montyValueToJs(v, seen);
    }
    return out;
  }

  return value;
}

export type MontyStdlib = {
  json_parse: (text: unknown) => unknown;
  json_stringify: (value: unknown, options?: unknown) => string;
  json_extract: (text: unknown) => unknown[];
  b64_encode: (text: unknown) => string;
  b64_decode: (b64: unknown) => string;
  sha256_hex: (text: unknown) => string;
};

function montyTypeName(value: unknown): string {
  if (value === undefined) return "no value";
  if (value === null) return "None";
  if (Array.isArray(value)) return "list";
  if (value instanceof Map) return "dict";
  if (value instanceof Set) return "set";
  if (typeof value === "bigint") return "int";
  return typeof value;
}

export function createMontySafeStdlib(): MontyStdlib {
  return {
    json_parse: (text: unknown) => {
      // str or bytes only, like Python's json.loads. Round-tripping other values
      // through the serializer turned dicts (JS Maps) into {} and truncated
      // large lists into invalid JSON.
      if (typeof text === "string") return JSON.parse(text);
      if (Buffer.isBuffer(text)) return JSON.parse(text.toString("utf8"));
      throw new TypeError(`json_parse expects a JSON string or bytes, not ${montyTypeName(text)}`);
    },
    json_stringify: (value: unknown, options?: unknown) => {
      const opts = montyValueToJs(options) as Any;
      const indent = typeof opts?.indent === "number" ? opts.indent : 0;
      const sortKeys = !!opts?.sort_keys || !!opts?.sortKeys;
      const maxOutputChars =
        typeof opts?.max_output_chars === "number" ? opts.max_output_chars : opts?.maxOutputChars;
      return stableJsonStringify(montyValueToJs(value), { indent, sortKeys, maxOutputChars });
    },
    json_extract: (text: unknown) => {
      const s = typeof text === "string" ? text : String(text ?? "");
      return extractJsonValues(s, {
        maxResults: 20,
        allowRepair: true,
        maxCandidateChars: 200_000,
      });
    },
    b64_encode: (text: unknown) => {
      const s = typeof text === "string" ? text : String(text ?? "");
      return Buffer.from(s, "utf8").toString("base64");
    },
    b64_decode: (b64: unknown) => {
      const s = typeof b64 === "string" ? b64 : String(b64 ?? "");
      return Buffer.from(s, "base64").toString("utf8");
    },
    sha256_hex: (text: unknown) => {
      const s = typeof text === "string" ? text : String(text ?? "");
      return sha256Hex(s);
    },
  };
}

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(max, value));
}

export function clampMontyLimits(
  requested: MontyResourceLimits | undefined,
  maxima: MontyResourceLimits,
): MontyResourceLimits | undefined {
  if (!requested) return undefined;
  const out: MontyResourceLimits = {};

  const maxAllocations = clampNumber(
    requested.maxAllocations,
    1,
    maxima.maxAllocations ?? 2_000_000,
  );
  if (maxAllocations !== undefined) out.maxAllocations = maxAllocations;

  const maxDurationSecs = clampNumber(
    requested.maxDurationSecs,
    0.01,
    maxima.maxDurationSecs ?? 30,
  );
  if (maxDurationSecs !== undefined) out.maxDurationSecs = maxDurationSecs;

  const maxMemory = clampNumber(
    requested.maxMemory,
    1024 * 1024,
    maxima.maxMemory ?? 512 * 1024 * 1024,
  );
  if (maxMemory !== undefined) out.maxMemory = maxMemory;

  const gcInterval = clampNumber(requested.gcInterval, 1, maxima.gcInterval ?? 1_000_000);
  if (gcInterval !== undefined) out.gcInterval = gcInterval;

  const maxRecursionDepth = clampNumber(
    requested.maxRecursionDepth,
    10,
    maxima.maxRecursionDepth ?? 5000,
  );
  if (maxRecursionDepth !== undefined) out.maxRecursionDepth = maxRecursionDepth;

  return out;
}

type MontySandboxLimits = NonNullable<NonNullable<Parameters<MontyPool["checkout"]>[0]>["limits"]>;

/**
 * Maps our limits onto the worker's. `maxDurationSecs` becomes the per-feed budget (one run is
 * one feed). The worker has no allocation counter since 1.0, so `maxAllocations` is still clamped
 * for callers but not enforced; `maxMemory` and the duration budget bound the same abuse.
 */
function toSandboxLimits(limits: MontyResourceLimits | undefined): MontySandboxLimits | undefined {
  if (!limits) return undefined;
  const out: MontySandboxLimits = {};
  if (limits.maxDurationSecs !== undefined) out.maxFeedDurationSecs = limits.maxDurationSecs;
  if (limits.maxMemory !== undefined) out.maxMemory = Math.floor(limits.maxMemory);
  if (limits.gcInterval !== undefined) out.gcInterval = Math.floor(limits.gcInterval);
  if (limits.maxRecursionDepth !== undefined) {
    out.maxRecursionDepth = Math.floor(limits.maxRecursionDepth);
  }
  return out;
}

export type RunMontyOptions = {
  code: string;
  input?: unknown;
  scriptName?: string;
  limits?: MontyResourceLimits;
  externalFunctions?: Record<string, (...args: unknown[]) => unknown>;
};

// There is no compile cache: since 1.0 the worker parses each feed itself and exposes no
// compiled-program dump, only session and suspended-run snapshots.
export async function runMontyCode(options: RunMontyOptions): Promise<MontyRunResult> {
  const code = typeof options.code === "string" ? options.code : "";
  if (!code.trim()) {
    return { ok: false, error: { kind: "syntax", message: "monty code is empty" } };
  }

  let mod: MontyModule;
  let pool: MontyPool;
  try {
    mod = await loadMontyModule();
    pool = await getMontyPool(mod);
  } catch (err: Any) {
    return {
      ok: false,
      error: {
        kind: "load",
        message: `Failed to load @pydantic/monty: ${err?.message || String(err)}`,
      },
    };
  }

  const externalFunctions = options.externalFunctions || {};
  const scriptName = options.scriptName || "monty.py";

  let session: Awaited<ReturnType<MontyPool["checkout"]>> | undefined;
  try {
    session = await pool.checkout({
      scriptName,
      limits: toSandboxLimits(options.limits),
      typeCheck: false,
      // Sleeps do not count toward the duration budget, so make them return at once.
      osPolicy: { sleep: "zero" },
    });
    const out = await session.feedRun(code, {
      inputs: { input: options.input ?? null },
      externalLookup: { ...externalFunctions },
      // Sandbox output would otherwise go to the app's own stdout.
      printCallback: () => {},
    });

    return { ok: true, output: montyValueToJs(out) };
  } catch (err: Any) {
    try {
      const { MontySyntaxError, MontyTypingError, MontyRuntimeError, MontyCrashedError } = mod;
      if (err instanceof MontySyntaxError) {
        return {
          ok: false,
          error: { kind: "syntax", message: err.message, display: err.display("type-msg") },
        };
      }
      if (err instanceof MontyTypingError) {
        return {
          ok: false,
          error: { kind: "typing", message: err.message, display: err.display() },
        };
      }
      if (err instanceof MontyRuntimeError) {
        return {
          ok: false,
          error: {
            kind: "runtime",
            message: err.message,
            display: err.display("traceback"),
            traceback: err.traceback(),
          },
        };
      }
      // The worker died or was killed past its deadline; the pool replaces it.
      if (err instanceof MontyCrashedError) {
        return { ok: false, error: { kind: "runtime", message: err.message } };
      }
    } catch {
      // ignore classification failure
    }
    return { ok: false, error: { kind: "unknown", message: err?.message || String(err) } };
  } finally {
    await session?.close().catch(() => {});
  }
}
