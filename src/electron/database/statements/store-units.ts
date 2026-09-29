import type Database from "better-sqlite3";
import {
  defineReadUnit,
  defineUnit,
  StatementCatalogError,
  type TransactionUnit,
} from "./statement-catalog";
import { json } from "./unit-args";

/**
 * Units for a synchronous store class (async SQLite migration plan, DB6): one unit per
 * method, run on a store built over the unit's connection. The method keeps its own
 * logic, so its reads and writes share one transaction. Arguments are checked as a
 * JSON-compatible argument list; the store binds each value to a typed statement
 * parameter.
 */

// oxlint-disable-next-line typescript/no-explicit-any -- store methods have arbitrary signatures
type Method = (...args: any[]) => unknown;
type MethodKeys<S> = { [K in keyof S]: S[K] extends Method ? K : never }[keyof S] & string;

const MAX_ARGS = 9;

/** Functions do not survive a worker boundary, and JSON would drop them silently. */
function rejectFunctions(value: unknown, path: string, depth = 0): void {
  if (typeof value === "function") {
    throw new StatementCatalogError(`${path} must not be a function`);
  }
  if (depth > 32 || !value || typeof value !== "object") return;
  for (const [key, entry] of Object.entries(value))
    rejectFunctions(entry, `${path}.${key}`, depth + 1);
}

function validateArgs<A extends unknown[]>(args: unknown): A {
  if (!Array.isArray(args) || args.length > MAX_ARGS) {
    throw new StatementCatalogError(`args must be an array of at most ${MAX_ARGS} values`);
  }
  rejectFunctions(args, "args");
  json(args, "args");
  return args as A;
}

export function storeUnit<S, K extends MethodKeys<S>>(
  make: (db: Database.Database) => S,
  method: K,
  options: { readonly: boolean; report?: boolean },
): TransactionUnit<Parameters<Extract<S[K], Method>>, ReturnType<Extract<S[K], Method>>> {
  type A = Parameters<Extract<S[K], Method>>;
  type R = ReturnType<Extract<S[K], Method>>;
  const run = (db: Database.Database, args: A): R =>
    (make(db)[method] as unknown as (...values: A) => R)(...args);
  if (!options.readonly) return defineUnit(validateArgs<A>, run);
  const unit = defineReadUnit(validateArgs<A>, run);
  return options.report ? { ...unit, report: true } : unit;
}

/**
 * A unit for a store that reads a clock. The facade passes the caller's clock reading as
 * the first argument, so the store sees the same time on either backend (tests inject
 * clocks); the store is built with that reading as its clock.
 */
export function clockedStoreUnit<S, K extends MethodKeys<S>>(
  make: (db: Database.Database, now: () => number) => S,
  method: K,
  options: { readonly: boolean },
): TransactionUnit<
  [number, ...Parameters<Extract<S[K], Method>>],
  ReturnType<Extract<S[K], Method>>
> {
  type A = [number, ...Parameters<Extract<S[K], Method>>];
  type R = ReturnType<Extract<S[K], Method>>;
  const validate = (args: unknown): A => {
    const values = validateArgs<A>(args);
    if (typeof values[0] !== "number" || !Number.isFinite(values[0])) {
      throw new StatementCatalogError("args[0] must be the caller's clock reading");
    }
    return values;
  };
  const run = (db: Database.Database, [nowMs, ...args]: A): R =>
    (make(db, () => nowMs)[method] as unknown as (...values: unknown[]) => R)(...args);
  return options.readonly ? defineReadUnit(validate, run) : defineUnit(validate, run);
}

/**
 * A unit for a store built with host-only context, such as settings read from disk on the
 * host. The facade passes the context as the first argument; `context` checks it before
 * the store is built with it.
 */
export function contextStoreUnit<C, S, K extends MethodKeys<S>>(
  make: (db: Database.Database, context: C) => S,
  method: K,
  options: { readonly: boolean; context: (value: unknown) => C },
): TransactionUnit<[C, ...Parameters<Extract<S[K], Method>>], ReturnType<Extract<S[K], Method>>> {
  type A = [C, ...Parameters<Extract<S[K], Method>>];
  type R = ReturnType<Extract<S[K], Method>>;
  const validate = (args: unknown): A => {
    const values = validateArgs<A>(args);
    if (values.length === 0) throw new StatementCatalogError("args[0] must be the store context");
    values[0] = options.context(values[0]);
    return values;
  };
  const run = (db: Database.Database, [context, ...args]: A): R =>
    (make(db, context)[method] as unknown as (...values: unknown[]) => R)(...args);
  return options.readonly ? defineReadUnit(validate, run) : defineUnit(validate, run);
}

/** A store's methods, each returning a promise of its result. */
export type AsyncStore<S, K extends keyof S> = {
  [M in K]: S[M] extends (...args: infer A) => infer R ? (...args: A) => Promise<R> : never;
};

/**
 * The async facade over a store's units: each method runs `<prefix><method>` through
 * `run`, typically a statement port's `unit`.
 */
export function storeFacade<S, K extends MethodKeys<S>>(
  prefix: string,
  methods: readonly K[],
  run: (name: string, args: unknown[]) => Promise<unknown>,
): AsyncStore<S, K> {
  const facade: Record<string, (...args: unknown[]) => Promise<unknown>> = {};
  for (const method of methods) {
    facade[method] = (...args: unknown[]) => run(`${prefix}${method}`, args);
  }
  return facade as AsyncStore<S, K>;
}
