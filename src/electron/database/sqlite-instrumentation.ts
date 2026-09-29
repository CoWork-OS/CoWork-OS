import type Database from "better-sqlite3";
import { createHistogram, performance, type RecordableHistogram } from "perf_hooks";
import { createLogger } from "../utils/logger";

/**
 * Low-overhead timing for synchronous SQLite work on the calling thread.
 *
 * This is the DB0 baseline instrumentation from
 * docs/async-sqlite-migration-plan-2026-09-27.md. It wraps a connection's
 * `prepare`, `exec`, `pragma`, and `transaction` methods so every statement
 * execution is timed without touching the call sites. Labels are SQL
 * fingerprints with literals removed; bound parameters are never recorded.
 *
 * Busy-timeout waits happen inside SQLite and are included in the duration of
 * the statement that waited. They cannot be separated without replacing the
 * busy handler, which `better-sqlite3` does not expose.
 */

const logger = createLogger("DbPerf");

export type SqliteOperationKind = "read" | "write" | "exec" | "pragma" | "transaction";

const OPERATION_KINDS: readonly SqliteOperationKind[] = [
  "read",
  "write",
  "exec",
  "pragma",
  "transaction",
];

const DEFAULT_SLOW_OPERATION_MS = 100;
const SLOW_LOG_INTERVAL_MS = 60_000;
const MAX_LABELS = 2_000;
const OVERFLOW_LABEL = "(other)";
const FINGERPRINT_MAX_CHARS = 160;
const FINGERPRINT_CACHE_LIMIT = 5_000;
const CALL_SITE_FRAMES = 4;
const INSTRUMENTED = Symbol.for("cowork.sqliteInstrumented");

export interface SlowSqliteOperation {
  label: string;
  kind: SqliteOperationKind;
  durationMs: number;
  rows: number;
  /** Approximate parameter size: string length, byte length, or 8 per number. */
  paramSize: number;
  /** Nearest application frames, with paths trimmed to the source/dist tree. */
  callSite: string[];
  failed: boolean;
}

export interface SqliteInstrumentationOptions {
  /** Operations at or above this duration count as slow. Defaults to `COWORK_DB_SLOW_MS` or 100. */
  slowOperationMs?: number;
  /** Receives slow operations instead of the default rate-limited warning. */
  onSlowOperation?: ((operation: SlowSqliteOperation) => void) | null;
}

export interface DurationSummary {
  count: number;
  totalMs: number;
  p50Ms: number;
  p95Ms: number;
  p99Ms: number;
  maxMs: number;
}

export interface SqliteLabelSnapshot {
  label: string;
  kind: SqliteOperationKind;
  count: number;
  totalMs: number;
  maxMs: number;
  rows: number;
  paramSize: number;
  slowCount: number;
  errors: number;
}

export interface SqliteInstrumentationSnapshot {
  windowMs: number;
  /** Time spent in top-level SQLite calls; nested statements inside transactions are not double-counted. */
  hostMs: number;
  topLevelOperations: number;
  slowOperations: number;
  errors: number;
  busyErrors: number;
  byKind: Record<SqliteOperationKind, DurationSummary>;
  hostOperations: Record<string, DurationSummary>;
  labels: SqliteLabelSnapshot[];
  /** Number of labels folded into `(other)` after the label cap was reached. */
  overflowedLabels: number;
}

interface LabelStats {
  kind: SqliteOperationKind;
  count: number;
  totalMs: number;
  maxMs: number;
  rows: number;
  paramSize: number;
  slowCount: number;
  errors: number;
}

interface DurationStats {
  histogram: RecordableHistogram;
  totalMs: number;
  maxMs: number;
}

type AnyFunction = (...args: unknown[]) => unknown;

interface MutableStatement {
  reader: boolean;
  run: AnyFunction;
  get: AnyFunction;
  all: AnyFunction;
}

interface MutableDatabase {
  inTransaction: boolean;
  prepare: (source: string) => MutableStatement;
  exec: (source: string) => unknown;
  pragma: (source: string, options?: unknown) => unknown;
  transaction: (fn: AnyFunction) => TransactionFunction;
  [INSTRUMENTED]?: boolean;
}

interface TransactionFunction extends AnyFunction {
  default: AnyFunction;
  deferred: AnyFunction;
  immediate: AnyFunction;
  exclusive: AnyFunction;
  database: unknown;
}

const createDurationStats = (): DurationStats => ({
  histogram: createHistogram(),
  totalMs: 0,
  maxMs: 0,
});

const createKindStats = (): Record<SqliteOperationKind, DurationStats> => ({
  read: createDurationStats(),
  write: createDurationStats(),
  exec: createDurationStats(),
  pragma: createDurationStats(),
  transaction: createDurationStats(),
});

const state = {
  windowStartedAt: performance.now(),
  depth: 0,
  hostMs: 0,
  topLevelOperations: 0,
  slowOperations: 0,
  errors: 0,
  busyErrors: 0,
  overflowedLabels: 0,
  labels: new Map<string, LabelStats>(),
  byKind: createKindStats(),
  hostOperations: new Map<string, DurationStats>(),
  slowLoggedAt: new Map<string, number>(),
  fingerprints: new Map<string, string>(),
  slowOperationMs: readSlowOperationMs(),
  onSlowOperation: null as ((operation: SlowSqliteOperation) => void) | null,
};

function readSlowOperationMs(): number {
  const raw = Number(process.env.COWORK_DB_SLOW_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_SLOW_OPERATION_MS;
}

export function isSqliteInstrumentationEnabled(): boolean {
  const raw = (process.env.COWORK_DB_INSTRUMENTATION || "").trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

export function configureSqliteInstrumentation(options: SqliteInstrumentationOptions): void {
  if (options.slowOperationMs !== undefined) state.slowOperationMs = options.slowOperationMs;
  if (options.onSlowOperation !== undefined) state.onSlowOperation = options.onSlowOperation;
}

/**
 * Normalize SQL into a stable label: comments and literals removed, parameter
 * lists collapsed, whitespace folded, and length capped.
 */
export function fingerprintSql(sql: string): string {
  const cached = state.fingerprints.get(sql);
  if (cached !== undefined) return cached;
  let text = sql
    .replace(/--[^\n]*/g, " ")
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/'(?:[^']|'')*'/g, "?")
    .replace(/\b\d+(?:\.\d+)?\b/g, "?")
    .replace(/\?(?:\s*,\s*\?)+/g, "?, ...")
    .replace(/\s+/g, " ")
    .trim();
  if (text.length > FINGERPRINT_MAX_CHARS) text = `${text.slice(0, FINGERPRINT_MAX_CHARS)}...`;
  if (state.fingerprints.size >= FINGERPRINT_CACHE_LIMIT) state.fingerprints.clear();
  state.fingerprints.set(sql, text);
  return text;
}

/**
 * Wrap a connection so its statements are timed. Idempotent; returns the same
 * handle. Disabled when `COWORK_DB_INSTRUMENTATION=0`.
 */
export function instrumentDatabase<T extends Database.Database>(db: T): T {
  if (!isSqliteInstrumentationEnabled()) return db;
  const target = db as unknown as MutableDatabase;
  if (target[INSTRUMENTED]) return db;
  target[INSTRUMENTED] = true;

  const originalPrepare = target.prepare;
  target.prepare = function instrumentedPrepare(this: MutableDatabase, source: string) {
    const statement = originalPrepare.call(this, source);
    instrumentStatement(statement, source);
    return statement;
  };

  const originalExec = target.exec;
  target.exec = function instrumentedExec(this: MutableDatabase, source: string) {
    return measure(
      fingerprintSql(source),
      "exec",
      () => originalExec.call(this, source),
      [],
      noRows,
    );
  };

  const originalPragma = target.pragma;
  target.pragma = function instrumentedPragma(
    this: MutableDatabase,
    source: string,
    options?: unknown,
  ) {
    return measure(
      `PRAGMA ${fingerprintSql(source)}`,
      "pragma",
      () => originalPragma.call(this, source, options),
      [],
      countRows,
    );
  };

  const originalTransaction = target.transaction;
  target.transaction = function instrumentedTransaction(this: MutableDatabase, fn: AnyFunction) {
    const transaction = originalTransaction.call(this, fn);
    return wrapTransaction(target, transaction);
  };

  return db;
}

function instrumentStatement(statement: MutableStatement, source: string): void {
  const label = fingerprintSql(source);
  const kind: SqliteOperationKind = statement.reader ? "read" : "write";
  const originalRun = statement.run;
  const originalGet = statement.get;
  const originalAll = statement.all;
  statement.run = function instrumentedRun(this: unknown, ...args: unknown[]) {
    return measure(label, kind, () => originalRun.apply(this, args), args, countChanges);
  };
  statement.get = function instrumentedGet(this: unknown, ...args: unknown[]) {
    return measure(label, kind, () => originalGet.apply(this, args), args, countSingleRow);
  };
  statement.all = function instrumentedAll(this: unknown, ...args: unknown[]) {
    return measure(label, kind, () => originalAll.apply(this, args), args, countRows);
  };
}

function wrapTransaction(
  db: MutableDatabase,
  transaction: TransactionFunction,
): TransactionFunction {
  const wrapMode = (mode: string, variant: AnyFunction): AnyFunction =>
    function instrumentedTransactionMode(this: unknown, ...args: unknown[]) {
      // better-sqlite3 turns a transaction inside another into a savepoint.
      const label = db.inTransaction ? "SAVEPOINT" : `TRANSACTION ${mode}`;
      return measure(label, "transaction", () => variant.apply(this, args), [], noRows);
    };
  const variants = {
    default: wrapMode("default", transaction.default),
    deferred: wrapMode("deferred", transaction.deferred),
    immediate: wrapMode("immediate", transaction.immediate),
    exclusive: wrapMode("exclusive", transaction.exclusive),
  };
  const properties: PropertyDescriptorMap = {
    default: { value: variants.default },
    deferred: { value: variants.deferred },
    immediate: { value: variants.immediate },
    exclusive: { value: variants.exclusive },
    database: { value: transaction.database, enumerable: true },
  };
  for (const variant of Object.values(variants)) Object.defineProperties(variant, properties);
  return variants.default as TransactionFunction;
}

const noRows = (): number => 0;
const countRows = (result: unknown): number => (Array.isArray(result) ? result.length : 1);
const countSingleRow = (result: unknown): number => (result === undefined ? 0 : 1);
const countChanges = (result: unknown): number => {
  const changes = (result as { changes?: unknown } | undefined)?.changes;
  return typeof changes === "number" ? changes : 0;
};

function measure<R>(
  label: string,
  kind: SqliteOperationKind,
  execute: () => R,
  args: unknown[],
  rowCounter: (result: unknown) => number,
): R {
  const topLevel = state.depth === 0;
  state.depth += 1;
  const startedAt = performance.now();
  let result: unknown;
  let error: unknown;
  let failed = false;
  try {
    result = execute();
    return result as R;
  } catch (caught) {
    failed = true;
    error = caught;
    throw caught;
  } finally {
    state.depth -= 1;
    const durationMs = performance.now() - startedAt;
    try {
      record(label, kind, durationMs, topLevel, failed ? 0 : rowCounter(result), args, error);
    } catch {
      // Instrumentation must never change the outcome of a database call.
    }
  }
}

function record(
  label: string,
  kind: SqliteOperationKind,
  durationMs: number,
  topLevel: boolean,
  rows: number,
  args: unknown[],
  error: unknown,
): void {
  if (topLevel) {
    state.hostMs += durationMs;
    state.topLevelOperations += 1;
  }
  recordDuration(state.byKind[kind], durationMs);

  const paramSize = measureParams(args);
  const stats = getLabelStats(label, kind);
  stats.count += 1;
  stats.totalMs += durationMs;
  stats.maxMs = Math.max(stats.maxMs, durationMs);
  stats.rows += rows;
  stats.paramSize += paramSize;

  if (error !== undefined) {
    stats.errors += 1;
    state.errors += 1;
    const code = (error as { code?: unknown } | null)?.code;
    if (typeof code === "string" && code.startsWith("SQLITE_BUSY")) state.busyErrors += 1;
  }

  if (durationMs >= state.slowOperationMs) {
    stats.slowCount += 1;
    state.slowOperations += 1;
    reportSlowOperation({
      label,
      kind,
      durationMs: roundMs(durationMs),
      rows,
      paramSize,
      callSite: captureCallSite(),
      failed: error !== undefined,
    });
  }
}

function getLabelStats(label: string, kind: SqliteOperationKind): LabelStats {
  let stats = state.labels.get(label);
  if (stats) return stats;
  if (state.labels.size >= MAX_LABELS) {
    state.overflowedLabels += 1;
    stats = state.labels.get(OVERFLOW_LABEL);
    if (stats) return stats;
    label = OVERFLOW_LABEL;
  }
  stats = { kind, count: 0, totalMs: 0, maxMs: 0, rows: 0, paramSize: 0, slowCount: 0, errors: 0 };
  state.labels.set(label, stats);
  return stats;
}

function measureParams(args: unknown[]): number {
  let size = 0;
  for (const arg of args) size += measureParam(arg, true);
  return size;
}

function measureParam(value: unknown, descend: boolean): number {
  if (typeof value === "string") return value.length;
  if (typeof value === "number" || typeof value === "bigint") return 8;
  if (value instanceof Uint8Array) return value.byteLength;
  if (descend && value && typeof value === "object") {
    let size = 0;
    for (const nested of Object.values(value)) size += measureParam(nested, false);
    return size;
  }
  return 0;
}

function recordDuration(stats: DurationStats, durationMs: number): void {
  // The histogram stores integer microseconds; sub-microsecond calls round up to 1.
  stats.histogram.record(Math.max(1, Math.round(durationMs * 1000)));
  stats.totalMs += durationMs;
  stats.maxMs = Math.max(stats.maxMs, durationMs);
}

function reportSlowOperation(operation: SlowSqliteOperation): void {
  if (state.onSlowOperation) {
    state.onSlowOperation(operation);
    return;
  }
  const now = Date.now();
  const lastLoggedAt = state.slowLoggedAt.get(operation.label) ?? 0;
  if (now - lastLoggedAt < SLOW_LOG_INTERVAL_MS) return;
  if (state.slowLoggedAt.size >= MAX_LABELS) state.slowLoggedAt.clear();
  state.slowLoggedAt.set(operation.label, now);
  logger.warn(`[DbSlow] ${JSON.stringify(operation)}`);
}

function captureCallSite(): string[] {
  const previousLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = previousLimit;
  const frames: string[] = [];
  for (const line of stack.split("\n").slice(1)) {
    if (/sqlite-instrumentation\.(?:ts|js):/.test(line) || line.includes("better-sqlite3"))
      continue;
    const frame = trimFramePath(line.trim().replace(/^at\s+/, ""));
    if (!frame || frame.startsWith("node:")) continue;
    frames.push(frame);
    if (frames.length >= CALL_SITE_FRAMES) break;
  }
  return frames;
}

/** Keep paths relative to the source/dist tree, or their last two segments, so logs omit home directories. */
function trimFramePath(frame: string): string {
  const withoutScheme = frame.replace(/file:\/\//g, "");
  const relativeToTree = withoutScheme.replace(
    /(^|\(|\s)[^\s()]*?[/\\](?:src|dist|app\.asar)[/\\]/,
    "$1",
  );
  return relativeToTree.replace(
    /(^|\(|\s)(?:[A-Za-z]:)?[/\\][^\s()]*[/\\]([^/\\\s()]+[/\\][^/\\\s()]+)/,
    "$1$2",
  );
}

/** Record a named application-level timing, such as timeline event persistence. */
export function recordHostOperation(name: string, durationMs: number): void {
  if (!isSqliteInstrumentationEnabled()) return;
  let stats = state.hostOperations.get(name);
  if (!stats) {
    stats = createDurationStats();
    state.hostOperations.set(name, stats);
  }
  recordDuration(stats, durationMs);
}

function summarize(stats: DurationStats): DurationSummary {
  const { histogram } = stats;
  if (histogram.count === 0) {
    return { count: 0, totalMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, maxMs: 0 };
  }
  return {
    count: histogram.count,
    totalMs: roundMs(stats.totalMs),
    p50Ms: roundMs(histogram.percentile(50) / 1000),
    p95Ms: roundMs(histogram.percentile(95) / 1000),
    p99Ms: roundMs(histogram.percentile(99) / 1000),
    maxMs: roundMs(stats.maxMs),
  };
}

function roundMs(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Read the accumulated statistics. Intended for a single consumer per process
 * (the host perf monitor or a benchmark); `reset` starts a new window.
 */
export function getSqliteInstrumentationSnapshot(
  options: { reset?: boolean; topLabels?: number } = {},
): SqliteInstrumentationSnapshot {
  const topLabels = options.topLabels ?? 20;
  const byKind = {} as Record<SqliteOperationKind, DurationSummary>;
  for (const kind of OPERATION_KINDS) byKind[kind] = summarize(state.byKind[kind]);
  const hostOperations: Record<string, DurationSummary> = {};
  for (const [name, stats] of state.hostOperations) hostOperations[name] = summarize(stats);
  const labels = Array.from(state.labels, ([label, stats]) => ({
    label,
    ...stats,
    totalMs: roundMs(stats.totalMs),
    maxMs: roundMs(stats.maxMs),
  }))
    .sort((a, b) => b.totalMs - a.totalMs)
    .slice(0, Math.max(0, topLabels));

  const snapshot: SqliteInstrumentationSnapshot = {
    windowMs: roundMs(performance.now() - state.windowStartedAt),
    hostMs: roundMs(state.hostMs),
    topLevelOperations: state.topLevelOperations,
    slowOperations: state.slowOperations,
    errors: state.errors,
    busyErrors: state.busyErrors,
    byKind,
    hostOperations,
    labels,
    overflowedLabels: state.overflowedLabels,
  };
  if (options.reset) resetSqliteInstrumentation();
  return snapshot;
}

export function resetSqliteInstrumentation(): void {
  state.windowStartedAt = performance.now();
  state.hostMs = 0;
  state.topLevelOperations = 0;
  state.slowOperations = 0;
  state.errors = 0;
  state.busyErrors = 0;
  state.overflowedLabels = 0;
  state.labels.clear();
  for (const kind of OPERATION_KINDS) state.byKind[kind] = createDurationStats();
  state.hostOperations.clear();
}
