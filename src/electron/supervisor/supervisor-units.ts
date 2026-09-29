import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { SupervisorExchangeStore } from "./SupervisorExchangeRepository";

const make = (db: Database.Database) => new SupervisorExchangeStore(db);

/** Supervisor exchange transaction units (async SQLite migration plan, DB6), in the services domain. */
export const SUPERVISOR_UNITS = {
  supervisorExchange_create: storeUnit(make, "create", { readonly: false }),
  supervisorExchange_update: storeUnit(make, "update", { readonly: false }),
  supervisorExchange_findById: storeUnit(make, "findById", { readonly: true }),
  supervisorExchange_findBySourceMessageId: storeUnit(make, "findBySourceMessageId", {
    readonly: true,
  }),
  supervisorExchange_findByDiscordMessageId: storeUnit(make, "findByDiscordMessageId", {
    readonly: true,
  }),
  supervisorExchange_list: storeUnit(make, "list", { readonly: true }),
  supervisorExchange_addMessage: storeUnit(make, "addMessage", { readonly: false }),
  supervisorExchange_listMessages: storeUnit(make, "listMessages", { readonly: true }),
  supervisorExchange_findMessageByDiscordMessageId: storeUnit(
    make,
    "findMessageByDiscordMessageId",
    { readonly: true },
  ),
} satisfies UnitCatalog;
