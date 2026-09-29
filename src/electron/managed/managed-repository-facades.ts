import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import type { ManagedStore } from "./managed-sql";
import type {
  ManagedAgentStore,
  ManagedAgentVersionStore,
  ManagedEnvironmentStore,
  ManagedSessionEventStore,
  ManagedSessionStore,
} from "./repositories";

/**
 * Async facades for the Managed agent stores (async SQLite migration plan, DB6). `new XRepository(db)`
 * keeps its signature; every method runs one services-domain unit over the synchronous
 * `XStore`, in the database worker when `COWORK_DB_WORKER_SERVICES` routes the domain there
 * and on the host connection otherwise.
 */

const MANAGED_AGENT_METHODS = ["create", "update", "findById", "list"] as const;
export type ManagedAgentRepository = AsyncStore<
  ManagedAgentStore,
  (typeof MANAGED_AGENT_METHODS)[number]
>;
export const ManagedAgentRepository = serviceRepositoryFacade<
  ManagedAgentStore,
  (typeof MANAGED_AGENT_METHODS)[number]
>("managedAgent_", MANAGED_AGENT_METHODS);

const MANAGED_AGENT_VERSION_METHODS = ["create", "find", "list", "updateMetadata"] as const;
export type ManagedAgentVersionRepository = AsyncStore<
  ManagedAgentVersionStore,
  (typeof MANAGED_AGENT_VERSION_METHODS)[number]
>;
export const ManagedAgentVersionRepository = serviceRepositoryFacade<
  ManagedAgentVersionStore,
  (typeof MANAGED_AGENT_VERSION_METHODS)[number]
>("managedAgentVersion_", MANAGED_AGENT_VERSION_METHODS);

const MANAGED_ENVIRONMENT_METHODS = ["create", "update", "findById", "list"] as const;
export type ManagedEnvironmentRepository = AsyncStore<
  ManagedEnvironmentStore,
  (typeof MANAGED_ENVIRONMENT_METHODS)[number]
>;
export const ManagedEnvironmentRepository = serviceRepositoryFacade<
  ManagedEnvironmentStore,
  (typeof MANAGED_ENVIRONMENT_METHODS)[number]
>("managedEnvironment_", MANAGED_ENVIRONMENT_METHODS);

const MANAGED_SESSION_METHODS = [
  "create",
  "update",
  "findById",
  "findByBackingTaskId",
  "list",
] as const;
export type ManagedSessionRepository = AsyncStore<
  ManagedSessionStore,
  (typeof MANAGED_SESSION_METHODS)[number]
>;
export const ManagedSessionRepository = serviceRepositoryFacade<
  ManagedSessionStore,
  (typeof MANAGED_SESSION_METHODS)[number]
>("managedSession_", MANAGED_SESSION_METHODS);

const MANAGED_SESSION_EVENT_METHODS = [
  "create",
  "findById",
  "listBySessionId",
  "hasSourceTaskEvent",
] as const;
export type ManagedSessionEventRepository = AsyncStore<
  ManagedSessionEventStore,
  (typeof MANAGED_SESSION_EVENT_METHODS)[number]
>;
export const ManagedSessionEventRepository = serviceRepositoryFacade<
  ManagedSessionEventStore,
  (typeof MANAGED_SESSION_EVENT_METHODS)[number]
>("managedSessionEvent_", MANAGED_SESSION_EVENT_METHODS);

const MANAGED_METHODS = [
  "seedMembership",
  "workspaceRole",
  "listMembershipRows",
  "upsertMembership",
  "listAuditRows",
  "insertAudit",
  "listRoutineRows",
  "setRoutineEnabled",
  "routineRunRowsWithDefinition",
] as const;
/** The managed session service's own SQL (`ManagedStore`), through services-domain units. */
export type ManagedRepository = AsyncStore<ManagedStore, (typeof MANAGED_METHODS)[number]>;
export const ManagedRepository = serviceRepositoryFacade<
  ManagedStore,
  (typeof MANAGED_METHODS)[number]
>("managed_", MANAGED_METHODS);
