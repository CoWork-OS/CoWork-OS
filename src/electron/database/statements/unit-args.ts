import { requireSqlParams, StatementCatalogError, type SqlParam } from "./statement-catalog";

/**
 * Argument checks for transaction units (DB6). A unit's `validate` rebuilds its
 * arguments from these, so the worker never runs a unit on a value of the wrong shape.
 */

type Record_ = Record<string, unknown>;

function fail(path: string, expected: string): never {
  throw new StatementCatalogError(`${path} must be ${expected}`);
}

export function record(value: unknown, path = "args"): Record_ {
  if (!value || typeof value !== "object" || Array.isArray(value)) fail(path, "an object");
  return value as Record_;
}

export function str(value: unknown, path: string, maxLength = 1_000_000): string {
  if (typeof value !== "string" || value.length > maxLength) fail(path, "a string");
  return value;
}

export function optStr(value: unknown, path: string, maxLength = 1_000_000): string | undefined {
  return value === undefined || value === null ? undefined : str(value, path, maxLength);
}

export function nullableStr(value: unknown, path: string, maxLength = 1_000_000): string | null {
  return value === undefined || value === null ? null : str(value, path, maxLength);
}

export function num(value: unknown, path: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) fail(path, "a finite number");
  return value;
}

export function optNum(value: unknown, path: string): number | undefined {
  return value === undefined || value === null ? undefined : num(value, path);
}

export function int(value: unknown, path: string, min = 0, max = Number.MAX_SAFE_INTEGER): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    fail(path, `an integer between ${min} and ${max}`);
  }
  return value;
}

export function bool(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") fail(path, "a boolean");
  return value;
}

export function optBool(value: unknown, path: string): boolean | undefined {
  return value === undefined || value === null ? undefined : bool(value, path);
}

export function oneOf<T extends string>(value: unknown, path: string, allowed: readonly T[]): T {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    fail(path, `one of ${allowed.join(", ")}`);
  }
  return value as T;
}

export function list<T>(
  value: unknown,
  path: string,
  item: (entry: unknown, path: string) => T,
  maxItems = 10_000,
): T[] {
  if (!Array.isArray(value) || value.length > maxItems) {
    fail(path, `an array of at most ${maxItems} items`);
  }
  return value.map((entry, index) => item(entry, `${path}[${index}]`));
}

export function params(value: unknown, path: string): SqlParam[] {
  try {
    return requireSqlParams(value);
  } catch {
    fail(path, "SQL parameters");
  }
}

type Check = (value: unknown, path: string) => unknown;
type Checked<S extends Record<string, Check>> = {
  [K in keyof S as undefined extends ReturnType<S[K]> ? never : K]: ReturnType<S[K]>;
} & {
  [K in keyof S as undefined extends ReturnType<S[K]> ? K : never]?: Exclude<
    ReturnType<S[K]>,
    undefined
  >;
};

/** A validator for an object whose fields each pass their check; other fields are dropped. */
export function fields<S extends Record<string, Check>>(spec: S): (args: unknown) => Checked<S> {
  return (args: unknown) => {
    const input = record(args);
    const out: Record<string, unknown> = {};
    for (const [key, check] of Object.entries(spec)) out[key] = check(input[key], `args.${key}`);
    return out as Checked<S>;
  };
}

/** Optional form of any check. */
export function opt<T>(check: (value: unknown, path: string) => T) {
  return (value: unknown, path: string): T | undefined =>
    value === undefined || value === null ? undefined : check(value, path);
}

/** A JSON-compatible value (objects, arrays, strings, finite numbers, booleans, null). */
export function json(value: unknown, path: string, maxBytes = 4_000_000): unknown {
  let text: string | undefined;
  try {
    text = JSON.stringify(value);
  } catch {
    fail(path, "JSON-compatible");
  }
  if (text === undefined || text.length > maxBytes) fail(path, "JSON-compatible");
  return value;
}

export function strList(value: unknown, path: string): string[] {
  return list(value, path, (entry, entryPath) => str(entry, entryPath));
}

type Checks = readonly ((value: unknown, path: string) => unknown)[];
type Tuple<C extends Checks> = { -readonly [K in keyof C]: ReturnType<C[K]> };

/** A validator for positional arguments, one check each; extra entries are refused. */
export function tuple<C extends Checks>(...checks: C): (args: unknown) => Tuple<C> {
  return (args: unknown) => {
    if (!Array.isArray(args) || args.length > checks.length) {
      fail("args", `an array of at most ${checks.length} values`);
    }
    return checks.map((check, index) => check(args[index], `args[${index}]`)) as Tuple<C>;
  };
}
