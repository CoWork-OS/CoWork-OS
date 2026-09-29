import path from "path";
import type { SqlParam, StatementShape } from "./statement-catalog";

/**
 * The database worker client as statement ports use it: structural, so ports do not
 * import the worker client and its command graph.
 */
export interface StatementClient {
  execute(
    name: "statements.read" | "statements.write",
    args: {
      domain: string;
      name: string;
      mode: "get" | "all" | "run";
      params?: SqlParam[];
      shape?: StatementShape;
    },
  ): Promise<unknown>;
  execute(
    name: "statements.unit" | "statements.readUnit",
    args: { domain: string; name: string; args?: unknown },
  ): Promise<unknown>;
}

/** Which domains run their statements in the worker, per database file (DB6). */
const clients = new Map<string, Map<string, StatementClient>>();

export function setStatementClient(
  domain: string | null,
  dbPath: string | null,
  client: StatementClient | null,
): void {
  if (domain === null || dbPath === null) {
    clients.clear();
    return;
  }
  const byPath = clients.get(domain) ?? new Map<string, StatementClient>();
  if (client) byPath.set(path.resolve(dbPath), client);
  else byPath.delete(path.resolve(dbPath));
  clients.set(domain, byPath);
}

/** The reporting reader per database file, for report-style read units (DB6). */
const reportReaders = new Map<string, StatementClient>();

export function setReportReaderClient(dbPath: string | null, client: StatementClient | null): void {
  if (dbPath === null) {
    reportReaders.clear();
    return;
  }
  if (client) reportReaders.set(path.resolve(dbPath), client);
  else reportReaders.delete(path.resolve(dbPath));
}

export function reportReaderFor(db: { name: string; memory: boolean }): StatementClient | null {
  if (db.memory || typeof db.name !== "string") return null;
  return reportReaders.get(path.resolve(db.name)) ?? null;
}

export function statementClientFor(
  domain: string,
  db: { name: string; memory: boolean },
): StatementClient | null {
  // In-memory and test connections have no file a worker could share.
  if (db.memory || typeof db.name !== "string") return null;
  return clients.get(domain)?.get(path.resolve(db.name)) ?? null;
}
