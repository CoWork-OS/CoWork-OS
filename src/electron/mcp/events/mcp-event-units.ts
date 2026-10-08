import type Database from "better-sqlite3";
import type { UnitCatalog } from "../../database/statements/statement-catalog";
import { storeUnit } from "../../database/statements/store-units";
import { MCPEventSqlStore } from "./mcp-event-sql";

const make = (db: Database.Database) => new MCPEventSqlStore(db);

export const MCP_EVENT_UNITS = {
  mcpEvent_list: storeUnit(make, "list", { readonly: true }),
  mcpEvent_get: storeUnit(make, "get", { readonly: true }),
  mcpEvent_insert: storeUnit(make, "insert", { readonly: false }),
  mcpEvent_insertError: storeUnit(make, "insertError", { readonly: false }),
  mcpEvent_setSecret: storeUnit(make, "setSecret", { readonly: false }),
  mcpEvent_setSubscribed: storeUnit(make, "setSubscribed", { readonly: false }),
  mcpEvent_setPolled: storeUnit(make, "setPolled", { readonly: false }),
  mcpEvent_delete: storeUnit(make, "delete", { readonly: false }),
  mcpEvent_setGap: storeUnit(make, "setGap", { readonly: false }),
  mcpEvent_setCursor: storeUnit(make, "setCursor", { readonly: false }),
  mcpEvent_setError: storeUnit(make, "setError", { readonly: false }),
} satisfies UnitCatalog;
