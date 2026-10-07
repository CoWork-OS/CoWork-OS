import type Database from "better-sqlite3";
import { storeUnit } from "../database/statements/store-units";
import { DispatchBudgetStore } from "./dispatch-budget-store";
export const DISPATCH_BUDGET_UNITS = {
  dispatchBudget_check: storeUnit((db: Database.Database) => new DispatchBudgetStore(db), "check", {
    readonly: true,
  }),
  dispatchBudget_reserve: storeUnit(
    (db: Database.Database) => new DispatchBudgetStore(db),
    "reserve",
    { readonly: false },
  ),
  dispatchBudget_refund: storeUnit(
    (db: Database.Database) => new DispatchBudgetStore(db),
    "refund",
    { readonly: false },
  ),
  dispatchBudget_snapshot: storeUnit(
    (db: Database.Database) => new DispatchBudgetStore(db),
    "snapshot",
    { readonly: true },
  ),
};
