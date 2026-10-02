import type Database from "better-sqlite3";
import type { AdminPolicies } from "../admin/policies";
import { StatementCatalogError, type UnitCatalog } from "../database/statements/statement-catalog";
import { contextStoreUnit } from "../database/statements/store-units";
import { EverydayAgentStore } from "./EverydayAgentService";

const everydayAgentStore = (db: Database.Database, policies: AdminPolicies | null) =>
  new EverydayAgentStore(db, policies);

/** The host's admin policies, or `null` when they failed to load. */
function policiesArg(value: unknown): AdminPolicies | null {
  if (value === null) return null;
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new StatementCatalogError("args[0] must be the admin policies or null");
  }
  return value as AdminPolicies;
}

/**
 * Everyday Agent transaction units (async SQLite migration plan, DB6), in the services
 * domain. Each takes the host's admin policies first. Reads of the profile create it on
 * first use, so every profile operation is a write unit.
 */
export const EVERYDAY_AGENT_UNITS = {
  everydayAgent_getProfile: contextStoreUnit(everydayAgentStore, "getProfile", {
    readonly: false,
    context: policiesArg,
  }),
  everydayAgent_updateProfile: contextStoreUnit(everydayAgentStore, "updateProfile", {
    readonly: false,
    context: policiesArg,
  }),
  everydayAgent_commitConsent: contextStoreUnit(everydayAgentStore, "commitConsent", {
    readonly: false,
    context: policiesArg,
  }),
  everydayAgent_pause: contextStoreUnit(everydayAgentStore, "pause", {
    readonly: false,
    context: policiesArg,
  }),
  everydayAgent_revokeCapability: contextStoreUnit(everydayAgentStore, "revokeCapability", {
    readonly: false,
    context: policiesArg,
  }),
  everydayAgent_listReceipts: contextStoreUnit(everydayAgentStore, "listReceipts", {
    readonly: true,
    context: policiesArg,
  }),
  everydayAgent_clearData: contextStoreUnit(everydayAgentStore, "clearData", {
    readonly: false,
    context: policiesArg,
  }),
  // Admin policies are not consulted; callers pass null.
  everydayAgent_getActionPreviewJson: contextStoreUnit(everydayAgentStore, "getActionPreviewJson", {
    readonly: true,
    context: policiesArg,
  }),
  everydayAgent_previewAction: contextStoreUnit(everydayAgentStore, "previewAction", {
    readonly: false,
    context: policiesArg,
  }),
  everydayAgent_approveAction: contextStoreUnit(everydayAgentStore, "approveAction", {
    readonly: false,
    context: policiesArg,
  }),
  everydayAgent_compilePolicy: contextStoreUnit(everydayAgentStore, "compilePolicy", {
    readonly: false,
    context: policiesArg,
  }),
} satisfies UnitCatalog;
