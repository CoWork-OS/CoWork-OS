import { serviceRepositoryFacade } from "../../database/service-statements";
import type { AsyncStore } from "../../database/statements/store-units";
import type { AgentSecurityStore } from "./AgentSecurityRepository";

const AGENTSECURITYREPOSITORY_METHODS = [
  "upsertFinding",
  "listFindings",
  "getFinding",
  "updateFindingStatus",
  "upsertDecision",
  "listDecisions",
  "updateDecisionHostOutcome",
  "addDiagnostic",
  "listDiagnostics",
  "upsertInventory",
  "listInventory",
  "prune",
  "listOpenFindingTaskIds",
  "applyIngest",
] as const;

/**
 * Async facade for agent security records (async SQLite migration plan, DB6). new
 * AgentSecurityRepository(db) keeps its signature; every method runs one services-domain
 * unit over AgentSecurityStore.
 */
export type AgentSecurityRepository = AsyncStore<
  AgentSecurityStore,
  (typeof AGENTSECURITYREPOSITORY_METHODS)[number]
>;
export const AgentSecurityRepository = serviceRepositoryFacade<
  AgentSecurityStore,
  (typeof AGENTSECURITYREPOSITORY_METHODS)[number]
>("agentSecurity_", AGENTSECURITYREPOSITORY_METHODS);
