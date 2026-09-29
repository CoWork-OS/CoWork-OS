import type Database from "better-sqlite3";
import { storeFacade, type AsyncStore } from "../database/statements/store-units";
import type { BoxBrainStore } from "./box-brain-sql";
import { BOX_BRAIN_READS, BOX_BRAIN_WRITES } from "./box-brain-units";
import { createMemoryStatementPort } from "./memory-statement-port";

export type {
  BoxBrainItemRecord,
  BoxBrainRunRecord,
  BoxBrainRunState,
  BoxBrainSourceRecord,
} from "./box-brain-sql";

type BoxBrainMethod = (typeof BOX_BRAIN_READS)[number] | (typeof BOX_BRAIN_WRITES)[number];

/**
 * Box brain storage (async SQLite migration plan, DB6): `BoxBrainStore`'s methods, each
 * one memory-domain transaction unit, in the database worker when memory is routed there
 * and one host transaction otherwise. The connection is used only to create the port.
 */
export type BoxBrainRepository = AsyncStore<BoxBrainStore, BoxBrainMethod>;

export function createBoxBrainRepository(db: Database.Database): BoxBrainRepository {
  const sql = createMemoryStatementPort(db);
  return storeFacade<BoxBrainStore, BoxBrainMethod>(
    "boxBrain_",
    [...BOX_BRAIN_READS, ...BOX_BRAIN_WRITES],
    (name, args) => sql.unit(name as never, args as never),
  );
}
