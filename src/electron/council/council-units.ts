import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { CouncilConfigStore, CouncilMemoStore, CouncilRunStore } from "./council-sql";

const councilConfig = (db: Database.Database) => new CouncilConfigStore(db);
const councilRun = (db: Database.Database) => new CouncilRunStore(db);
const councilMemo = (db: Database.Database) => new CouncilMemoStore(db);

/** Council transaction units (async SQLite migration plan, DB6), in the services domain. */
export const COUNCIL_UNITS = {
  councilConfig_listByWorkspace: storeUnit(councilConfig, "listByWorkspace", { readonly: true }),
  councilConfig_allIds: storeUnit(councilConfig, "allIds", { readonly: true }),
  councilConfig_findById: storeUnit(councilConfig, "findById", { readonly: true }),
  councilConfig_findByManagedCronJobId: storeUnit(councilConfig, "findByManagedCronJobId", {
    readonly: true,
  }),
  councilConfig_create: storeUnit(councilConfig, "create", { readonly: false }),
  councilConfig_update: storeUnit(councilConfig, "update", { readonly: false }),
  councilConfig_delete: storeUnit(councilConfig, "delete", { readonly: false }),
  councilRun_create: storeUnit(councilRun, "create", { readonly: false }),
  councilRun_listByCouncil: storeUnit(councilRun, "listByCouncil", { readonly: true }),
  councilRun_findById: storeUnit(councilRun, "findById", { readonly: true }),
  councilRun_findByTaskId: storeUnit(councilRun, "findByTaskId", { readonly: true }),
  councilRun_bindTask: storeUnit(councilRun, "bindTask", { readonly: false }),
  councilRun_complete: storeUnit(councilRun, "complete", { readonly: false }),
  councilMemo_create: storeUnit(councilMemo, "create", { readonly: false }),
  councilMemo_getLatestForCouncil: storeUnit(councilMemo, "getLatestForCouncil", {
    readonly: true,
  }),
  councilMemo_findById: storeUnit(councilMemo, "findById", { readonly: true }),
} satisfies UnitCatalog;
