import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { TaskProposalSqlStore } from "./task-proposal-sql";

const make = (db: Database.Database) => new TaskProposalSqlStore(db);

/** Suggested-task proposal units (async SQLite migration plan, DB6), in the services domain. */
export const TASK_PROPOSAL_UNITS = {
  taskProposal_insert: storeUnit(make, "insert", { readonly: false }),
  taskProposal_get: storeUnit(make, "get", { readonly: true }),
  taskProposal_listForTask: storeUnit(make, "listForTask", { readonly: true }),
  taskProposal_findByStartedTask: storeUnit(make, "findByStartedTask", { readonly: true }),
  taskProposal_settle: storeUnit(make, "settle", { readonly: false }),
  taskProposal_setStartedTask: storeUnit(make, "setStartedTask", { readonly: false }),
  taskProposal_reopen: storeUnit(make, "reopen", { readonly: false }),
} satisfies UnitCatalog;
