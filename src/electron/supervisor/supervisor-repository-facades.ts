import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import type { SupervisorExchangeStore } from "./SupervisorExchangeRepository";

const SUPERVISOREXCHANGEREPOSITORY_METHODS = [
  "create",
  "update",
  "findById",
  "findBySourceMessageId",
  "findByDiscordMessageId",
  "list",
  "addMessage",
  "listMessages",
  "findMessageByDiscordMessageId",
] as const;

/**
 * Async facade for supervisor exchanges (async SQLite migration plan, DB6). new
 * SupervisorExchangeRepository(db) keeps its signature; every method runs one services-
 * domain unit over SupervisorExchangeStore.
 */
export type SupervisorExchangeRepository = AsyncStore<
  SupervisorExchangeStore,
  (typeof SUPERVISOREXCHANGEREPOSITORY_METHODS)[number]
>;
export const SupervisorExchangeRepository = serviceRepositoryFacade<
  SupervisorExchangeStore,
  (typeof SUPERVISOREXCHANGEREPOSITORY_METHODS)[number]
>("supervisorExchange_", SUPERVISOREXCHANGEREPOSITORY_METHODS);
