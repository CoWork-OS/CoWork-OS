import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import type { RecurringApprovalStore } from "./recurring-approval-service";

const RECURRINGAPPROVALSERVICE_METHODS = ["findActive", "create", "list", "revoke"] as const;

/**
 * Async facade for recurring approval rules (async SQLite migration plan, DB6). new
 * RecurringApprovalService(db) keeps its signature; every method runs one services-
 * domain unit over RecurringApprovalStore.
 */
export type RecurringApprovalService = AsyncStore<
  RecurringApprovalStore,
  (typeof RECURRINGAPPROVALSERVICE_METHODS)[number]
>;
export const RecurringApprovalService = serviceRepositoryFacade<
  RecurringApprovalStore,
  (typeof RECURRINGAPPROVALSERVICE_METHODS)[number]
>("recurringApproval_", RECURRINGAPPROVALSERVICE_METHODS);
