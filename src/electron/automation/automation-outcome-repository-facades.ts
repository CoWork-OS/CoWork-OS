import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import { AutomationRunOutcomeStore } from "./AutomationRunOutcomeRepository";

const AUTOMATIONRUNOUTCOMEREPOSITORY_METHODS = [
  "create",
  "findLatestByNotificationKey",
  "findById",
  "list",
  "summarize",
  "markNotificationDelivered",
  "markNotificationSkipped",
] as const;

/**
 * Async facade for automation run outcomes (async SQLite migration plan, DB6). new
 * AutomationRunOutcomeRepository(db) keeps its signature and ensures the table on the
 * host; every method runs one services-domain unit over AutomationRunOutcomeStore.
 */
export type AutomationRunOutcomeRepository = AsyncStore<
  AutomationRunOutcomeStore,
  (typeof AUTOMATIONRUNOUTCOMEREPOSITORY_METHODS)[number]
>;
export const AutomationRunOutcomeRepository = serviceRepositoryFacade<
  AutomationRunOutcomeStore,
  (typeof AUTOMATIONRUNOUTCOMEREPOSITORY_METHODS)[number]
>("automationOutcome_", AUTOMATIONRUNOUTCOMEREPOSITORY_METHODS, {
  hooks: (_facade, db) => void new AutomationRunOutcomeStore(db),
});
