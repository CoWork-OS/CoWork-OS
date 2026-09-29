import { serviceRepositoryFacade } from "../database/service-statements";
import type { AsyncStore } from "../database/statements/store-units";
import type { AgentTeamItemStore } from "./AgentTeamItemRepository";
import type { AgentTeamMemberStore } from "./AgentTeamMemberRepository";
import type { AgentRoleStore } from "./AgentRoleRepository";
import type { AgentTeamRunStore } from "./AgentTeamRunRepository";
import type { AgentTeamThoughtStore } from "./AgentTeamThoughtRepository";
import type { AutomationProfileStore } from "./AutomationProfileRepository";
import type { AgentTeamStore } from "./AgentTeamRepository";
import type { HeartbeatPolicyStore } from "./HeartbeatPolicyRepository";
import { HeartbeatRunStore } from "./HeartbeatRunRepository";
import type { MentionStore } from "./MentionRepository";
import type { TaskSubscriptionStore } from "./TaskSubscriptionRepository";
import type { WorkingStateStore } from "./WorkingStateRepository";

/**
 * Async facades for the Agent stores (async SQLite migration plan, DB6). `new XRepository(db)`
 * keeps its signature; every method runs one services-domain unit over the synchronous
 * `XStore`, in the database worker when `COWORK_DB_WORKER_SERVICES` routes the domain there
 * and on the host connection otherwise.
 */

const AGENT_TEAM_ITEM_METHODS = [
  "create",
  "findById",
  "listByRun",
  "update",
  "delete",
  "deleteByRun",
  "setResultSummaryBySourceTaskId",
  "listBySourceTaskId",
] as const;
export type AgentTeamItemRepository = AsyncStore<
  AgentTeamItemStore,
  (typeof AGENT_TEAM_ITEM_METHODS)[number]
>;
export const AgentTeamItemRepository = serviceRepositoryFacade<
  AgentTeamItemStore,
  (typeof AGENT_TEAM_ITEM_METHODS)[number]
>("agentTeamItem_", AGENT_TEAM_ITEM_METHODS);

const AGENT_TEAM_MEMBER_METHODS = [
  "add",
  "findById",
  "findByTeamAndRole",
  "listByTeam",
  "update",
  "remove",
  "removeByTeamAndRole",
  "deleteByTeam",
  "reorder",
] as const;
export type AgentTeamMemberRepository = AsyncStore<
  AgentTeamMemberStore,
  (typeof AGENT_TEAM_MEMBER_METHODS)[number]
>;
export const AgentTeamMemberRepository = serviceRepositoryFacade<
  AgentTeamMemberStore,
  (typeof AGENT_TEAM_MEMBER_METHODS)[number]
>("agentTeamMember_", AGENT_TEAM_MEMBER_METHODS);

const AGENT_ROLE_METHODS = [
  "create",
  "detachTemplatedRolesFromCoreAutomation",
  "findById",
  "findByName",
  "findAll",
  "findActive",
  "findByCompanyId",
  "update",
  "delete",
  "seedDefaults",
  "hasAny",
  "syncNewDefaults",
  "findHeartbeatEnabled",
  "updateHeartbeatConfig",
  "updateHeartbeatStatus",
  "updateHeartbeatRunTimestamps",
  "updateSoul",
  "updateAutonomyLevel",
  "findByAutonomyLevel",
] as const;
export type AgentRoleRepository = AsyncStore<AgentRoleStore, (typeof AGENT_ROLE_METHODS)[number]>;
export const AgentRoleRepository = serviceRepositoryFacade<
  AgentRoleStore,
  (typeof AGENT_ROLE_METHODS)[number]
>("agentRole_", AGENT_ROLE_METHODS);

const AGENT_TEAM_RUN_METHODS = [
  "create",
  "findById",
  "findByRootTaskId",
  "listByTeam",
  "update",
  "delete",
] as const;
export type AgentTeamRunRepository = AsyncStore<
  AgentTeamRunStore,
  (typeof AGENT_TEAM_RUN_METHODS)[number]
>;
export const AgentTeamRunRepository = serviceRepositoryFacade<
  AgentTeamRunStore,
  (typeof AGENT_TEAM_RUN_METHODS)[number]
>("agentTeamRun_", AGENT_TEAM_RUN_METHODS);

const AGENT_TEAM_THOUGHT_METHODS = [
  "create",
  "findById",
  "listByRun",
  "listByAgent",
  "updateContent",
  "deleteByRun",
  "listBySourceTaskId",
] as const;
export type AgentTeamThoughtRepository = AsyncStore<
  AgentTeamThoughtStore,
  (typeof AGENT_TEAM_THOUGHT_METHODS)[number]
>;
export const AgentTeamThoughtRepository = serviceRepositoryFacade<
  AgentTeamThoughtStore,
  (typeof AGENT_TEAM_THOUGHT_METHODS)[number]
>("agentTeamThought_", AGENT_TEAM_THOUGHT_METHODS);

const AUTOMATION_PROFILE_METHODS = [
  "listAll",
  "listEnabled",
  "findById",
  "findByAgentRoleId",
  "create",
  "createOrReplace",
  "update",
  "updateByAgentRoleId",
  "updateRuntimeState",
  "deleteById",
  "deleteByAgentRoleId",
] as const;
export type AutomationProfileRepository = AsyncStore<
  AutomationProfileStore,
  (typeof AUTOMATION_PROFILE_METHODS)[number]
>;
export const AutomationProfileRepository = serviceRepositoryFacade<
  AutomationProfileStore,
  (typeof AUTOMATION_PROFILE_METHODS)[number]
>("automationProfile_", AUTOMATION_PROFILE_METHODS);

const AGENT_TEAM_METHODS = [
  "create",
  "findById",
  "findByName",
  "listByWorkspace",
  "update",
  "delete",
  "listPersistent",
] as const;
export type AgentTeamRepository = AsyncStore<AgentTeamStore, (typeof AGENT_TEAM_METHODS)[number]>;
export const AgentTeamRepository = serviceRepositoryFacade<
  AgentTeamStore,
  (typeof AGENT_TEAM_METHODS)[number]
>("agentTeam_", AGENT_TEAM_METHODS);

const HEARTBEAT_POLICY_METHODS = [
  "findByAgentRoleId",
  "listAll",
  "upsert",
  "deleteByAgentRoleId",
] as const;
export type HeartbeatPolicyRepository = AsyncStore<
  HeartbeatPolicyStore,
  (typeof HEARTBEAT_POLICY_METHODS)[number]
>;
export const HeartbeatPolicyRepository = serviceRepositoryFacade<
  HeartbeatPolicyStore,
  (typeof HEARTBEAT_POLICY_METHODS)[number]
>("heartbeatPolicy_", HEARTBEAT_POLICY_METHODS);

const HEARTBEAT_RUN_METHODS = [
  "create",
  "finish",
  "attachTask",
  "recordEvent",
  "reconcileInterruptedAgentRuns",
  "reconcileLegacyMigratedRuns",
  "get",
  "listRecentDispatches",
  "getLatestRun",
  "hasInFlightDispatch",
] as const;
export type HeartbeatRunRepository = AsyncStore<
  HeartbeatRunStore,
  (typeof HEARTBEAT_RUN_METHODS)[number]
>;
// Without a connection the store keeps runs in memory; the facade then uses it directly.
export const HeartbeatRunRepository = serviceRepositoryFacade<
  HeartbeatRunStore,
  (typeof HEARTBEAT_RUN_METHODS)[number]
>("heartbeatRun_", HEARTBEAT_RUN_METHODS, { memoryStore: () => new HeartbeatRunStore() });

const MENTION_METHODS = [
  "create",
  "findById",
  "list",
  "getPendingForAgent",
  "getPendingCount",
  "acknowledge",
  "complete",
  "dismiss",
  "delete",
  "deleteByTask",
] as const;
export type MentionRepository = AsyncStore<MentionStore, (typeof MENTION_METHODS)[number]>;
export const MentionRepository = serviceRepositoryFacade<
  MentionStore,
  (typeof MENTION_METHODS)[number]
>("mention_", MENTION_METHODS);

const TASK_SUBSCRIPTION_METHODS = [
  "subscribe",
  "autoSubscribe",
  "unsubscribe",
  "findByTaskAndAgent",
  "findById",
  "getSubscribers",
  "getSubscriberCount",
  "getSubscriptionsForAgent",
  "list",
  "deleteByTask",
  "deleteByAgent",
  "isSubscribed",
  "getSubscriberIds",
] as const;
export type TaskSubscriptionRepository = AsyncStore<
  TaskSubscriptionStore,
  (typeof TASK_SUBSCRIPTION_METHODS)[number]
>;
export const TaskSubscriptionRepository = serviceRepositoryFacade<
  TaskSubscriptionStore,
  (typeof TASK_SUBSCRIPTION_METHODS)[number]
>("taskSubscription_", TASK_SUBSCRIPTION_METHODS);

const WORKING_STATE_METHODS = [
  "findById",
  "getCurrent",
  "getAllCurrent",
  "update",
  "getHistory",
  "listForTask",
  "restore",
  "delete",
  "deleteByAgentAndWorkspace",
  "deleteByTask",
  "cleanupOldStates",
] as const;
export type WorkingStateRepository = AsyncStore<
  WorkingStateStore,
  (typeof WORKING_STATE_METHODS)[number]
>;
export const WorkingStateRepository = serviceRepositoryFacade<
  WorkingStateStore,
  (typeof WORKING_STATE_METHODS)[number]
>("workingState_", WORKING_STATE_METHODS);
