import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { TempWorkspaceStore } from "./temp-workspace-sql";

const make = (db: Database.Database) => new TempWorkspaceStore(db);

/** Temp workspace pruning units (async SQLite migration plan, DB6), in the services domain. */
export const TEMP_WORKSPACE_UNITS = {
  tempWorkspace_tempWorkspaceRows: storeUnit(make, "tempWorkspaceRows", { readonly: true }),
  tempWorkspace_activeTaskWorkspaceIds: storeUnit(make, "activeTaskWorkspaceIds", {
    readonly: true,
  }),
  tempWorkspace_activeSessionWorkspaceIds: storeUnit(make, "activeSessionWorkspaceIds", {
    readonly: true,
  }),
  tempWorkspace_isReferenced: storeUnit(make, "isReferenced", { readonly: true }),
  tempWorkspace_deleteUnreferencedWorkspace: storeUnit(make, "deleteUnreferencedWorkspace", {
    readonly: false,
  }),
} satisfies UnitCatalog;
