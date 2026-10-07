import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { AcpStore } from "./acp-sql";

const make = (db: Database.Database) => new AcpStore(db);

/** ACP persistence units (async SQLite migration plan, DB6), in the services domain. */
export const ACP_UNITS = {
  acp_remoteAgentRows: storeUnit(make, "remoteAgentRows", { readonly: true }),
  acp_persistRemoteAgent: storeUnit(make, "persistRemoteAgent", { readonly: false }),
  acp_scrubRemoteAgentCard: storeUnit(make, "scrubRemoteAgentCard", { readonly: false }),
  acp_deleteRemoteAgent: storeUnit(make, "deleteRemoteAgent", { readonly: false }),
  acp_taskRows: storeUnit(make, "taskRows", { readonly: true }),
  acp_persistTask: storeUnit(make, "persistTask", { readonly: false }),
} satisfies UnitCatalog;
