import type Database from "better-sqlite3";
import { storeUnit } from "../database/statements/store-units";
import { SchedulerLeaseStore } from "./scheduler-lease-store";
export const SCHEDULER_LEASE_UNITS = {
  schedulerLease_acquire: storeUnit(
    (db: Database.Database) => new SchedulerLeaseStore(db),
    "acquire",
    { readonly: false },
  ),
  schedulerLease_release: storeUnit(
    (db: Database.Database) => new SchedulerLeaseStore(db),
    "release",
    { readonly: false },
  ),
  schedulerLease_validate: storeUnit(
    (db: Database.Database) => new SchedulerLeaseStore(db),
    "validate",
    { readonly: true },
  ),
};
