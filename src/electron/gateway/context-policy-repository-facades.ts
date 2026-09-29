import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import type { ContextPolicyStore } from "./context-policy";

const CONTEXTPOLICYMANAGER_METHODS = [
  "getPolicy",
  "getPolicyForChat",
  "findPolicy",
  "getPoliciesForChannel",
  "create",
  "update",
  "updateByContext",
  "delete",
  "deleteByChannel",
  "isToolAllowed",
  "getDeniedTools",
  "createDefaultPolicies",
] as const;

/**
 * Async facade for context policies (async SQLite migration plan, DB6). new
 * ContextPolicyManager(db) keeps its signature; every method runs one services-domain
 * unit over ContextPolicyStore. Tool checks fail closed: a corrupted restriction list
 * denies every tool, as before.
 */
export type ContextPolicyManager = AsyncStore<
  ContextPolicyStore,
  (typeof CONTEXTPOLICYMANAGER_METHODS)[number]
>;
export const ContextPolicyManager = serviceRepositoryFacade<
  ContextPolicyStore,
  (typeof CONTEXTPOLICYMANAGER_METHODS)[number]
>("contextPolicy_", CONTEXTPOLICYMANAGER_METHODS);
