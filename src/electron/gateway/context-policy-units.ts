import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { ContextPolicyStore } from "./context-policy";

const make = (db: Database.Database) => new ContextPolicyStore(db);

/** Context policy transaction units (async SQLite migration plan, DB6), in the services domain. */
export const CONTEXT_POLICY_UNITS = {
  contextPolicy_getPolicy: storeUnit(make, "getPolicy", { readonly: false }),
  contextPolicy_getPolicyForChat: storeUnit(make, "getPolicyForChat", { readonly: false }),
  contextPolicy_findPolicy: storeUnit(make, "findPolicy", { readonly: true }),
  contextPolicy_getPoliciesForChannel: storeUnit(make, "getPoliciesForChannel", { readonly: true }),
  contextPolicy_create: storeUnit(make, "create", { readonly: false }),
  contextPolicy_update: storeUnit(make, "update", { readonly: false }),
  contextPolicy_updateByContext: storeUnit(make, "updateByContext", { readonly: false }),
  contextPolicy_delete: storeUnit(make, "delete", { readonly: false }),
  contextPolicy_deleteByChannel: storeUnit(make, "deleteByChannel", { readonly: false }),
  contextPolicy_isToolAllowed: storeUnit(make, "isToolAllowed", { readonly: false }),
  contextPolicy_getDeniedTools: storeUnit(make, "getDeniedTools", { readonly: false }),
  contextPolicy_createDefaultPolicies: storeUnit(make, "createDefaultPolicies", {
    readonly: false,
  }),
} satisfies UnitCatalog;
