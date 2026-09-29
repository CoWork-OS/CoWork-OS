import type Database from "better-sqlite3";
import {
  isReadStatement,
  requireSqlParams,
  resolveStatementSql,
  resolveUnit,
  StatementCatalogError,
  type SqlParam,
  type StatementShape,
} from "../statements/statement-catalog";
import { STATEMENT_CATALOGS, STATEMENT_UNITS } from "../statements/statement-catalogs";
import { InvalidCommandArgumentsError } from "./command-errors";

/**
 * Catalogued statements in the database worker (async SQLite migration plan, DB6). A
 * migrated domain's service calls its statements by name; these commands resolve the
 * name in the domain's catalog (never raw SQL from the caller), validate the parameters,
 * and run the statement on the worker connection. Reads and writes are separate commands
 * so the worker schedules them by kind; a write runs in the worker's IMMEDIATE
 * transaction.
 */

export interface StatementRequest {
  domain: string;
  name: string;
  shape?: StatementShape;
  mode: "get" | "all" | "run";
  params?: SqlParam[];
}

export interface UnitRequest {
  domain: string;
  name: string;
  args?: unknown;
}

export interface StatementRunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

const statementCache = new WeakMap<Database.Database, Map<string, Database.Statement>>();

function prepareCached(db: Database.Database, sql: string): Database.Statement {
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map();
    statementCache.set(db, cache);
  }
  let statement = cache.get(sql);
  if (!statement) {
    statement = db.prepare(sql);
    cache.set(sql, statement);
  }
  return statement;
}

function resolveRequest(raw: unknown, kind: "read" | "write") {
  if (!raw || typeof raw !== "object") {
    throw new InvalidCommandArgumentsError("arguments must be an object");
  }
  const request = raw as Partial<StatementRequest>;
  const catalog =
    typeof request.domain === "string" &&
    Object.prototype.hasOwnProperty.call(STATEMENT_CATALOGS, request.domain)
      ? STATEMENT_CATALOGS[request.domain]
      : undefined;
  if (!catalog) throw new InvalidCommandArgumentsError("unknown statement domain");
  if (typeof request.name !== "string") {
    throw new InvalidCommandArgumentsError("name must be a statement name");
  }
  let sql: string;
  let params: SqlParam[];
  try {
    sql = resolveStatementSql(catalog, request.name, request.shape);
    params = requireSqlParams(request.params);
  } catch (error) {
    if (error instanceof StatementCatalogError) {
      throw new InvalidCommandArgumentsError(error.message);
    }
    throw error;
  }
  const read = isReadStatement(sql);
  if (kind === "read" && !read) {
    throw new InvalidCommandArgumentsError(`${request.name} writes; use statements.write`);
  }
  const mode = request.mode;
  if (mode !== "get" && mode !== "all" && mode !== "run") {
    throw new InvalidCommandArgumentsError("mode must be get, all or run");
  }
  return { sql, params, mode };
}

function execute(db: Database.Database, sql: string, params: SqlParam[], mode: string): unknown {
  const statement = prepareCached(db, sql);
  if (mode === "get") return statement.get(...params);
  if (mode === "all") return statement.all(...params);
  const result = statement.run(...params);
  return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
}

/**
 * Resolve and run a catalogued statement on `db`: the worker's commands and the host
 * backend of a statement port share this, so both run identical SQL.
 */
export function runCatalogStatement(db: Database.Database, request: StatementRequest): unknown {
  const catalog = STATEMENT_CATALOGS[request.domain];
  const kind =
    catalog && isReadStatement(resolveStatementSql(catalog, request.name, request.shape))
      ? "read"
      : "write";
  const { sql, params, mode } = resolveRequest(request, kind);
  return execute(db, sql, params, mode);
}

function resolveUnitRequest(raw: unknown) {
  if (!raw || typeof raw !== "object") {
    throw new InvalidCommandArgumentsError("arguments must be an object");
  }
  const request = raw as Partial<UnitRequest>;
  const units =
    typeof request.domain === "string" &&
    Object.prototype.hasOwnProperty.call(STATEMENT_UNITS, request.domain)
      ? STATEMENT_UNITS[request.domain]
      : undefined;
  if (!units) throw new InvalidCommandArgumentsError("unknown statement domain");
  if (typeof request.name !== "string") {
    throw new InvalidCommandArgumentsError("name must be a transaction unit name");
  }
  try {
    const unit = resolveUnit(units, request.name);
    return { unit, args: unit.validate(request.args) };
  } catch (error) {
    if (error instanceof StatementCatalogError) {
      throw new InvalidCommandArgumentsError(error.message);
    }
    throw error;
  }
}

/**
 * Run a transaction unit on `db` in its own IMMEDIATE transaction (a savepoint when the
 * host is already inside one): the host backend of a statement port.
 */
export function runCatalogUnit(db: Database.Database, request: UnitRequest): unknown {
  const { unit, args } = resolveUnitRequest(request);
  const transaction = db.transaction(() => unit.run(db, args));
  const begin = unit.readonly ? transaction.deferred : transaction.immediate;
  // Test doubles of the connection may return a plain function from `transaction`.
  return typeof begin === "function" ? begin.call(transaction) : transaction();
}

/** Whether a registered unit is a report-style read. */
export function isReportUnit(domain: string, name: string): boolean {
  const units = Object.prototype.hasOwnProperty.call(STATEMENT_UNITS, domain)
    ? STATEMENT_UNITS[domain]
    : undefined;
  return Boolean(
    units &&
    Object.prototype.hasOwnProperty.call(units, name) &&
    units[name].readonly &&
    units[name].report,
  );
}

/** Whether a registered unit only reads; unknown names are not. */
export function isReadUnit(domain: string, name: string): boolean {
  const units = Object.prototype.hasOwnProperty.call(STATEMENT_UNITS, domain)
    ? STATEMENT_UNITS[domain]
    : undefined;
  return Boolean(
    units && Object.prototype.hasOwnProperty.call(units, name) && units[name].readonly,
  );
}

export const STATEMENT_COMMANDS = {
  "statements.read": {
    kind: "read",
    tables: [],
    run(db: Database.Database, args: StatementRequest): unknown {
      const { sql, params, mode } = resolveRequest(args, "read");
      return execute(db, sql, params, mode);
    },
  },
  "statements.write": {
    kind: "write",
    tables: [],
    run(db: Database.Database, args: StatementRequest): unknown {
      const { sql, params, mode } = resolveRequest(args, "write");
      return execute(db, sql, params, mode);
    },
  },
  // The worker runs every write command in an IMMEDIATE transaction already.
  "statements.unit": {
    kind: "write",
    tables: [],
    run(db: Database.Database, args: UnitRequest): unknown {
      const { unit, args: validated } = resolveUnitRequest(args);
      if (unit.readonly)
        throw new InvalidCommandArgumentsError(`${args.name} reads; use statements.readUnit`);
      return unit.run(db, validated);
    },
  },
  "statements.readUnit": {
    kind: "read",
    tables: [],
    run(db: Database.Database, args: UnitRequest): unknown {
      const { unit, args: validated } = resolveUnitRequest(args);
      if (!unit.readonly) {
        throw new InvalidCommandArgumentsError(`${args.name} writes; use statements.unit`);
      }
      // One snapshot for all of the unit's queries.
      return db.transaction(() => unit.run(db, validated)).deferred();
    },
  },
} as const;
