import type Database from "better-sqlite3";
import { StatementPort } from "../database/statements/statement-port";
import { MEMORY_STATEMENTS, type MemoryStatementName } from "./memory-statements";
import type { MEMORY_UNITS } from "./memory-units";

export type MemoryStatementPort = StatementPort<MemoryStatementName, typeof MEMORY_UNITS>;

/** The memory domain's statement port: worker-backed when the runtime routes memory. */
export function createMemoryStatementPort(db: Database.Database): MemoryStatementPort {
  return new StatementPort(db, "memory", MEMORY_STATEMENTS);
}
