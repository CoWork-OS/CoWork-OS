/**
 * Statement catalogs (async SQLite migration plan, DB6): each migrated domain lists the
 * SQL it runs, by name. The database worker executes only catalogued statements, so a
 * domain's database work stays reviewable in one place and nothing else reaches the
 * worker connection. A statement is fixed SQL text or a builder: a pure function of a
 * small, validated shape (a table alias, whether a filter applies, a list length) that
 * returns SQL, so host and worker build the same text.
 *
 * A domain can also register transaction units: named functions that run several
 * statements, with logic between them, in one IMMEDIATE transaction. A unit validates its
 * own arguments, touches only the connection it is given, and never calls the keychain,
 * the network or a timer, so it runs unchanged on the host and in the worker.
 *
 * Free of Electron and service imports: catalogs load in the worker.
 */
import type Database from "better-sqlite3";

export type SqlParam = string | number | bigint | null | Uint8Array;
export type StatementShape = Record<string, string | number | boolean>;
export type StatementBuilder = (shape: StatementShape) => string;
export type StatementCatalog = Readonly<Record<string, string | StatementBuilder>>;

export class StatementCatalogError extends Error {
  readonly code = "invalid_statement";
}

export interface TransactionUnit<A, R> {
  /** Throws `StatementCatalogError` unless `args` is exactly what `run` expects. */
  validate(args: unknown): A;
  /**
   * Runs inside an IMMEDIATE transaction, or a deferred one (a consistent snapshot) for a
   * read-only unit; the result must be structured-cloneable.
   */
  run(db: Database.Database, args: A): R;
  /** Reads only: runs as a read, without taking the write lock. */
  readonly?: boolean;
  /**
   * A report-style scan (read-only): runs on the reporting reader when one is running, so
   * it never queues ahead of the domain's other statements on the write connection.
   */
  report?: boolean;
}

// oxlint-disable-next-line typescript/no-explicit-any -- units have heterogeneous argument types
export type UnitCatalog = Readonly<Record<string, TransactionUnit<any, unknown>>>;
export type UnitArgs<U> = U extends { validate(args: unknown): infer A } ? A : never;
export type UnitResult<U> = U extends { run(db: never, args: never): infer R } ? R : never;

export function defineUnit<A, R>(
  validate: (args: unknown) => A,
  run: (db: Database.Database, args: A) => R,
): TransactionUnit<A, R> {
  return { validate, run };
}

/** A unit that only reads: several queries against one snapshot, in one round trip. */
export function defineReadUnit<A, R>(
  validate: (args: unknown) => A,
  run: (db: Database.Database, args: A) => R,
): TransactionUnit<A, R> {
  return { validate, run, readonly: true };
}

export function resolveUnit(
  units: UnitCatalog | undefined,
  name: string,
): TransactionUnit<unknown, unknown> {
  const unit = units && Object.prototype.hasOwnProperty.call(units, name) ? units[name] : undefined;
  if (!unit) throw new StatementCatalogError(`Unknown transaction unit: ${name}`);
  return unit as TransactionUnit<unknown, unknown>;
}

export function resolveStatementSql(
  catalog: StatementCatalog,
  name: string,
  shape?: StatementShape,
): string {
  const definition = Object.prototype.hasOwnProperty.call(catalog, name)
    ? catalog[name]
    : undefined;
  if (definition === undefined) throw new StatementCatalogError(`Unknown statement: ${name}`);
  if (typeof definition === "string") {
    if (shape !== undefined) throw new StatementCatalogError(`Statement ${name} takes no shape`);
    return definition;
  }
  if (!shape || typeof shape !== "object" || Array.isArray(shape)) {
    throw new StatementCatalogError(`Statement ${name} needs a shape`);
  }
  for (const value of Object.values(shape)) {
    if (!["string", "number", "boolean"].includes(typeof value)) {
      throw new StatementCatalogError(`Statement ${name} has an invalid shape`);
    }
  }
  return definition(shape);
}

/** Whether a statement only reads: SELECT, or WITH without a data-changing clause. */
export function isReadStatement(sql: string): boolean {
  const text = sql.replace(/\/\*[\s\S]*?\*\//g, " ").trimStart();
  if (/^SELECT\b/i.test(text)) return true;
  if (/^WITH\b/i.test(text)) return !/\b(INSERT|UPDATE|DELETE|REPLACE)\b/i.test(text);
  return false;
}

export function requireSqlParams(value: unknown): SqlParam[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > 999) {
    throw new StatementCatalogError("params must be an array of at most 999 values");
  }
  for (const param of value) {
    const ok =
      param === null ||
      typeof param === "string" ||
      typeof param === "bigint" ||
      (typeof param === "number" && Number.isFinite(param)) ||
      param instanceof Uint8Array;
    if (!ok) {
      throw new StatementCatalogError(
        "params must be strings, finite numbers, bigints, byte arrays or null",
      );
    }
  }
  return value as SqlParam[];
}

/** Helpers for builders. */
export function requireShapeInteger(shape: StatementShape, key: string, max = 999): number {
  const value = shape[key];
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > max) {
    throw new StatementCatalogError(`shape.${key} must be an integer between 0 and ${max}`);
  }
  return value;
}

export function requireShapeEnum<T extends string>(
  shape: StatementShape,
  key: string,
  allowed: readonly T[],
): T {
  const value = shape[key];
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    throw new StatementCatalogError(`shape.${key} must be one of ${allowed.join(", ")}`);
  }
  return value as T;
}

export function placeholders(count: number): string {
  return Array.from({ length: count }, () => "?").join(", ");
}
