import type Database from "better-sqlite3";
import { StatementPort } from "../database/statements/statement-port";
import { storeFacade, type AsyncStore } from "../database/statements/store-units";
import type { REPORTS_UNITS } from "./reports-units";

export type ReportsStatementPort = StatementPort<never, typeof REPORTS_UNITS>;

const ports = new WeakMap<Database.Database, ReportsStatementPort>();

/** The reports port for `db` (`COWORK_DB_WORKER_REPORTS` routes it; reads use the reader). */
export function reportsStatements(db: Database.Database): ReportsStatementPort {
  let port = ports.get(db);
  if (!port) {
    port = new StatementPort(db, "reports", {});
    ports.set(db, port);
  }
  return port;
}

/** The async facade over a report store's units named `<prefix><method>`. */
export function reportsFacade<S, K extends keyof S & string>(
  db: Database.Database,
  prefix: string,
  methods: readonly K[],
): AsyncStore<S, K> {
  const sql = reportsStatements(db);
  return storeFacade<S, K & never>(prefix, methods as never, (name, args) =>
    sql.unit(name as never, args as never),
  ) as unknown as AsyncStore<S, K>;
}
