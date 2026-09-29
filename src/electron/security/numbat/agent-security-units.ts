import type Database from "better-sqlite3";
import type { UnitCatalog } from "../../database/statements/statement-catalog";
import { storeUnit } from "../../database/statements/store-units";
import { AgentSecurityStore } from "./AgentSecurityRepository";

const make = (db: Database.Database) => new AgentSecurityStore(db);

/** Agent security transaction units (async SQLite migration plan, DB6), in the services domain. */
export const AGENT_SECURITY_UNITS = {
  agentSecurity_upsertFinding: storeUnit(make, "upsertFinding", { readonly: false }),
  agentSecurity_listFindings: storeUnit(make, "listFindings", { readonly: true }),
  agentSecurity_getFinding: storeUnit(make, "getFinding", { readonly: true }),
  agentSecurity_updateFindingStatus: storeUnit(make, "updateFindingStatus", { readonly: false }),
  agentSecurity_upsertDecision: storeUnit(make, "upsertDecision", { readonly: false }),
  agentSecurity_listDecisions: storeUnit(make, "listDecisions", { readonly: true }),
  agentSecurity_updateDecisionHostOutcome: storeUnit(make, "updateDecisionHostOutcome", {
    readonly: false,
  }),
  agentSecurity_addDiagnostic: storeUnit(make, "addDiagnostic", { readonly: false }),
  agentSecurity_listDiagnostics: storeUnit(make, "listDiagnostics", { readonly: true }),
  agentSecurity_upsertInventory: storeUnit(make, "upsertInventory", { readonly: false }),
  agentSecurity_listInventory: storeUnit(make, "listInventory", { readonly: true }),
  agentSecurity_prune: storeUnit(make, "prune", { readonly: false }),
  agentSecurity_listOpenFindingTaskIds: storeUnit(make, "listOpenFindingTaskIds", {
    readonly: true,
  }),
  agentSecurity_applyIngest: storeUnit(make, "applyIngest", { readonly: false }),
} satisfies UnitCatalog;
