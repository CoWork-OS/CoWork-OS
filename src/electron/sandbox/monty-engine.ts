import crypto from "crypto";
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

type MontyModule = typeof import("@pydantic/monty");

let montyModulePromise: Promise<MontyModule> | null = null;

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

export function createMontySafeStdlib(): MontyStdlib {
  return {
    json_parse: (text: unknown) => {
      const s = typeof text === "string" ? text : stableJsonStringify(text);
      return JSON.parse(s);
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

export class MontyProgramCache {
  private entries = new Map<string, Buffer>();

  constructor(private maxEntries = 32) {}

  get(key: string): Buffer | undefined {
    const existing = this.entries.get(key);
    if (!existing) return undefined;
    this.entries.delete(key);
    this.entries.set(key, existing);
    return existing;
  }

  set(key: string, dump: Buffer): void {
    if (this.entries.has(key)) {
      this.entries.delete(key);
    }
    this.entries.set(key, dump);
    while (this.entries.size > this.maxEntries) {
      const firstKey = this.entries.keys().next().value as string | undefined;
      if (!firstKey) break;
      this.entries.delete(firstKey);
    }
  }
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

export type RunMontyOptions = {
  code: string;
  input?: unknown;
  scriptName?: string;
  limits?: MontyResourceLimits;
  externalFunctions?: Record<string, (...args: unknown[]) => unknown>;
  cache?: MontyProgramCache;
  cacheKey?: string;
};

export async function runMontyCode(options: RunMontyOptions): Promise<MontyRunResult> {
  const code = typeof options.code === "string" ? options.code : "";
  if (!code.trim()) {
    return { ok: false, error: { kind: "syntax", message: "monty code is empty" } };
  }

  let mod: MontyModule;
  try {
    mod = await loadMontyModule();
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
  const externalFnNames = Object.keys(externalFunctions);
  const scriptName = options.scriptName || "monty.py";

  const cacheKey = options.cacheKey;
  const cache = options.cache;

  try {
    const { Monty, runMontyAsync } = mod;

    let dump: Buffer | undefined;
    if (cache && cacheKey) {
      dump = cache.get(cacheKey);
    }

    if (!dump) {
      const m = new Monty(code, {
        scriptName,
        inputs: ["input"],
        externalFunctions: externalFnNames,
        typeCheck: false,
      });
      dump = m.dump();
      if (cache && cacheKey) {
        cache.set(cacheKey, dump);
      }
    }

    const m = Monty.load(dump);
    const out = await runMontyAsync(m, {
      inputs: { input: options.input ?? null },
      externalFunctions,
      limits: options.limits,
    });

    return { ok: true, output: montyValueToJs(out) };
  } catch (err: Any) {
    try {
      const { MontySyntaxError, MontyTypingError, MontyRuntimeError } = mod;
      if (err instanceof MontySyntaxError) {
        return {
          ok: false,
          error: { kind: "syntax", message: err.message, display: err.display("type-msg") },
        };
      }
      if (err instanceof MontyTypingError) {
        return {
          ok: false,
          error: {
            kind: "typing",
            message: err.message,
            display: err.displayDiagnostics("concise", false),
          },
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
    } catch {
      // ignore classification failure
    }
    return { ok: false, error: { kind: "unknown", message: err?.message || String(err) } };
  }
}
