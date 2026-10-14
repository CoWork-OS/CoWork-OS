import type Database from "better-sqlite3";
import { storeUnit } from "../database/statements/store-units";
import { ApplicationOperationStore } from "./application-operation-store";

const make = (db: Database.Database) => new ApplicationOperationStore(db);
export const APPLICATION_OPERATION_UNITS = {
  applicationOperation_create: storeUnit(make, "create", { readonly: false }),
  applicationOperation_get: storeUnit(make, "get", { readonly: true }),
  applicationOperation_list: storeUnit(make, "list", { readonly: true }),
  applicationOperation_recoverable: storeUnit(make, "recoverable", { readonly: true }),
  applicationOperation_recoverExpired: storeUnit(make, "recoverExpired", { readonly: false }),
  applicationOperation_claim: storeUnit(make, "claim", { readonly: false }),
  applicationOperation_renew: storeUnit(make, "renew", { readonly: false }),
  applicationOperation_finish: storeUnit(make, "finish", { readonly: false }),
  applicationOperation_requestCancel: storeUnit(make, "requestCancel", { readonly: false }),
  applicationOperation_requestExecute: storeUnit(make, "requestExecute", { readonly: false }),
  applicationOperation_resolveDecision: storeUnit(make, "resolveDecision", { readonly: false }),
  applicationOperation_resolveUnknown: storeUnit(make, "resolveUnknown", { readonly: false }),
  applicationOperation_attempts: storeUnit(make, "attempts", { readonly: true }),
  applicationOperation_events: storeUnit(make, "events", { readonly: true }),
  applicationOperation_authorizesToolAttempt: storeUnit(make, "authorizesToolAttempt", {
    readonly: true,
  }),
};
