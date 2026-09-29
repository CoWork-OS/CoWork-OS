import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import type { HookSessionStore } from "./HookSessionRepository";

const HOOKSESSIONREPOSITORY_METHODS = [
  "findBySessionKey",
  "create",
  "acquireLock",
  "releaseLock",
] as const;

/**
 * Async facade for hook sessions (async SQLite migration plan, DB6). new
 * HookSessionRepository(db) keeps its signature; every method runs one services-domain
 * unit over HookSessionStore.
 */
export type HookSessionRepository = AsyncStore<
  HookSessionStore,
  (typeof HOOKSESSIONREPOSITORY_METHODS)[number]
>;
export const HookSessionRepository = serviceRepositoryFacade<
  HookSessionStore,
  (typeof HOOKSESSIONREPOSITORY_METHODS)[number]
>("hookSession_", HOOKSESSIONREPOSITORY_METHODS);
