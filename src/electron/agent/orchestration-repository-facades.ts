import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import type { OrchestrationStore } from "./OrchestrationRepository";

const ORCHESTRATIONREPOSITORY_METHODS = [
  "create",
  "update",
  "findById",
  "findByRootTaskId",
  "findRunning",
  "list",
] as const;

/**
 * Async facade for orchestration runs (async SQLite migration plan, DB6). new
 * OrchestrationRepository(db) keeps its signature; every method runs one services-domain
 * unit over OrchestrationStore.
 */
export type OrchestrationRepository = AsyncStore<
  OrchestrationStore,
  (typeof ORCHESTRATIONREPOSITORY_METHODS)[number]
>;
export const OrchestrationRepository = serviceRepositoryFacade<
  OrchestrationStore,
  (typeof ORCHESTRATIONREPOSITORY_METHODS)[number]
>("orchestration_", ORCHESTRATIONREPOSITORY_METHODS);
