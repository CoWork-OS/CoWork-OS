import type Database from "better-sqlite3";
import {
  isReadStatement,
  resolveStatementSql,
  type SqlParam,
  type StatementCatalog,
  type StatementShape,
  type UnitArgs,
  type UnitCatalog,
  type UnitResult,
} from "./statement-catalog";
import { reportReaderFor, statementClientFor } from "./statement-route";
import { burstGateFor, currentStatementContext, type StatementBurstGate } from "./statement-burst";
import {
  isReadUnit,
  isReportUnit,
  runCatalogStatement,
  runCatalogUnit,
  type StatementRunResult,
} from "../async/statement-commands";

/**
 * A migrated domain's database access (async SQLite migration plan, DB6). Services call
 * catalogued statements by name; the port runs them in the database worker when the
 * runtime routes the domain there, and on the host connection otherwise. Either way the
 * caller awaits, so moving a domain between backends changes no service code.
 *
 * On the host backend a statement runs when it is called, before the returned promise
 * settles, which keeps the ordering of the synchronous code it replaced. On the worker
 * backend statements run in call order on the worker connection.
 */
export class StatementPort<
  Name extends string,
  Units extends UnitCatalog = Readonly<Record<never, never>>,
> {
  private readonly gate: StatementBurstGate | null;
  private readonly readsOnReader: boolean;

  /**
   * `serializeBursts`: on the worker backend, keep each operation's statement sequences
   * uninterrupted (see `statement-burst.ts`). Domains whose multi-statement operations
   * are not transaction units opt in.
   *
   * `readsOnReader`: run read statements on the reporting reader when one is running, so
   * they do not queue behind other domains' writes on the write connection. They still
   * take their turn in the domain's bursts, so a read-then-write sequence stays
   * uninterrupted, and each read sees the committed writes its operation awaited.
   */
  constructor(
    private readonly db: Database.Database,
    private readonly domain: string,
    private readonly catalog: StatementCatalog,
    options: { serializeBursts?: boolean; readsOnReader?: boolean } = {},
  ) {
    this.gate = options.serializeBursts ? burstGateFor(domain, db) : null;
    this.readsOnReader = options.readsOnReader === true;
  }

  /** Run a worker request as part of the calling operation's burst. */
  private async gated<T>(send: () => Promise<T>): Promise<T> {
    const gate = this.gate;
    if (!gate) return send();
    const waiting = gate.enter(currentStatementContext() ?? { label: this.domain });
    if (waiting) await waiting;
    try {
      return await send();
    } finally {
      gate.finished();
    }
  }

  async get<T>(
    name: Name,
    params: SqlParam[] = [],
    shape?: StatementShape,
  ): Promise<T | undefined> {
    return (await this.call("get", name, params, shape)) as T | undefined;
  }

  async all<T>(name: Name, params: SqlParam[] = [], shape?: StatementShape): Promise<T[]> {
    return (await this.call("all", name, params, shape)) as T[];
  }

  async run(
    name: Name,
    params: SqlParam[] = [],
    shape?: StatementShape,
  ): Promise<StatementRunResult> {
    return (await this.call("run", name, params, shape)) as StatementRunResult;
  }

  /**
   * Run a registered transaction unit: its statements commit together or not at all, in
   * the worker's write transaction or in one host transaction.
   */
  unit<K extends keyof Units & string>(
    name: K,
    args: UnitArgs<Units[K]>,
  ): Promise<UnitResult<Units[K]>> {
    const request = { domain: this.domain, name, args };
    const client = statementClientFor(this.domain, this.db);
    if (!client) {
      try {
        return Promise.resolve(runCatalogUnit(this.db, request) as UnitResult<Units[K]>);
      } catch (error) {
        return Promise.reject(error);
      }
    }
    if (isReportUnit(this.domain, name)) {
      // A report reads committed data on its own connection, outside the domain's bursts.
      const reader = reportReaderFor(this.db);
      if (reader) {
        return reader.execute("statements.readUnit", request) as Promise<UnitResult<Units[K]>>;
      }
    }
    const command = isReadUnit(this.domain, name) ? "statements.readUnit" : "statements.unit";
    return this.gated(() => client.execute(command, request)) as Promise<UnitResult<Units[K]>>;
  }

  /** Whether this port currently runs its statements in the database worker. */
  usesWorker(): boolean {
    return statementClientFor(this.domain, this.db) !== null;
  }

  private call(
    mode: "get" | "all" | "run",
    name: Name,
    params: SqlParam[],
    shape: StatementShape | undefined,
  ): Promise<unknown> {
    const request = { domain: this.domain, name, mode, params, ...(shape ? { shape } : {}) };
    const client = statementClientFor(this.domain, this.db);
    if (!client) {
      try {
        return Promise.resolve(runCatalogStatement(this.db, request));
      } catch (error) {
        return Promise.reject(error);
      }
    }
    const read = isReadStatement(resolveStatementSql(this.catalog, name, shape));
    const reader = read && this.readsOnReader ? reportReaderFor(this.db) : null;
    if (reader) return this.gated(() => reader.execute("statements.read", request));
    return this.gated(() => client.execute(read ? "statements.read" : "statements.write", request));
  }
}
