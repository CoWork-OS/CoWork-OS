import type Database from "better-sqlite3";
import type { UnitCatalog } from "../database/statements/statement-catalog";
import { storeUnit } from "../database/statements/store-units";
import { AgentTeamItemStore } from "./AgentTeamItemRepository";
import { AgentTeamMemberStore } from "./AgentTeamMemberRepository";
import { AgentRoleStore } from "./AgentRoleRepository";
import { AgentTeamRunStore } from "./AgentTeamRunRepository";
import { AgentTeamThoughtStore } from "./AgentTeamThoughtRepository";
import { AutomationProfileStore } from "./AutomationProfileRepository";
import { AgentTeamStore } from "./AgentTeamRepository";
import { HeartbeatPolicyStore } from "./HeartbeatPolicyRepository";
import { HeartbeatRunStore } from "./HeartbeatRunRepository";
import { MentionStore } from "./MentionRepository";
import { TaskSubscriptionStore } from "./TaskSubscriptionRepository";
import { WorkingStateStore } from "./WorkingStateRepository";

/**
 * Agent transaction units (async SQLite migration plan, DB6): one per public method of
 * the synchronous stores, in the services domain. Generated from the classes; a method is
 * a write when it, or a method it calls, writes or opens a transaction.
 */
export const AGENT_UNITS = {
  agentTeamItem_create: storeUnit((db: Database.Database) => new AgentTeamItemStore(db), "create", {
    readonly: false,
  }),
  agentTeamItem_findById: storeUnit(
    (db: Database.Database) => new AgentTeamItemStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  agentTeamItem_listByRun: storeUnit(
    (db: Database.Database) => new AgentTeamItemStore(db),
    "listByRun",
    {
      readonly: true,
    },
  ),
  agentTeamItem_update: storeUnit((db: Database.Database) => new AgentTeamItemStore(db), "update", {
    readonly: false,
  }),
  agentTeamItem_delete: storeUnit((db: Database.Database) => new AgentTeamItemStore(db), "delete", {
    readonly: false,
  }),
  agentTeamItem_deleteByRun: storeUnit(
    (db: Database.Database) => new AgentTeamItemStore(db),
    "deleteByRun",
    {
      readonly: false,
    },
  ),
  agentTeamItem_setResultSummaryBySourceTaskId: storeUnit(
    (db: Database.Database) => new AgentTeamItemStore(db),
    "setResultSummaryBySourceTaskId",
    {
      readonly: false,
    },
  ),
  agentTeamItem_listBySourceTaskId: storeUnit(
    (db: Database.Database) => new AgentTeamItemStore(db),
    "listBySourceTaskId",
    {
      readonly: true,
    },
  ),
  agentTeamMember_add: storeUnit((db: Database.Database) => new AgentTeamMemberStore(db), "add", {
    readonly: false,
  }),
  agentTeamMember_findById: storeUnit(
    (db: Database.Database) => new AgentTeamMemberStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  agentTeamMember_findByTeamAndRole: storeUnit(
    (db: Database.Database) => new AgentTeamMemberStore(db),
    "findByTeamAndRole",
    {
      readonly: true,
    },
  ),
  agentTeamMember_listByTeam: storeUnit(
    (db: Database.Database) => new AgentTeamMemberStore(db),
    "listByTeam",
    {
      readonly: true,
    },
  ),
  agentTeamMember_update: storeUnit(
    (db: Database.Database) => new AgentTeamMemberStore(db),
    "update",
    {
      readonly: false,
    },
  ),
  agentTeamMember_remove: storeUnit(
    (db: Database.Database) => new AgentTeamMemberStore(db),
    "remove",
    {
      readonly: false,
    },
  ),
  agentTeamMember_removeByTeamAndRole: storeUnit(
    (db: Database.Database) => new AgentTeamMemberStore(db),
    "removeByTeamAndRole",
    {
      readonly: false,
    },
  ),
  agentTeamMember_deleteByTeam: storeUnit(
    (db: Database.Database) => new AgentTeamMemberStore(db),
    "deleteByTeam",
    {
      readonly: false,
    },
  ),
  agentTeamMember_reorder: storeUnit(
    (db: Database.Database) => new AgentTeamMemberStore(db),
    "reorder",
    {
      readonly: false,
    },
  ),
  agentRole_create: storeUnit((db: Database.Database) => new AgentRoleStore(db), "create", {
    readonly: false,
  }),
  agentRole_findById: storeUnit((db: Database.Database) => new AgentRoleStore(db), "findById", {
    readonly: true,
  }),
  agentRole_findByName: storeUnit((db: Database.Database) => new AgentRoleStore(db), "findByName", {
    readonly: true,
  }),
  agentRole_detachTemplatedRolesFromCoreAutomation: storeUnit(
    (db: Database.Database) => new AgentRoleStore(db),
    "detachTemplatedRolesFromCoreAutomation",
    { readonly: false },
  ),
  agentRole_findAll: storeUnit((db: Database.Database) => new AgentRoleStore(db), "findAll", {
    readonly: true,
  }),
  agentRole_findActive: storeUnit((db: Database.Database) => new AgentRoleStore(db), "findActive", {
    readonly: true,
  }),
  agentRole_findByCompanyId: storeUnit(
    (db: Database.Database) => new AgentRoleStore(db),
    "findByCompanyId",
    {
      readonly: true,
    },
  ),
  agentRole_update: storeUnit((db: Database.Database) => new AgentRoleStore(db), "update", {
    readonly: false,
  }),
  agentRole_delete: storeUnit((db: Database.Database) => new AgentRoleStore(db), "delete", {
    readonly: false,
  }),
  agentRole_seedDefaults: storeUnit(
    (db: Database.Database) => new AgentRoleStore(db),
    "seedDefaults",
    {
      readonly: false,
    },
  ),
  agentRole_hasAny: storeUnit((db: Database.Database) => new AgentRoleStore(db), "hasAny", {
    readonly: true,
  }),
  agentRole_syncNewDefaults: storeUnit(
    (db: Database.Database) => new AgentRoleStore(db),
    "syncNewDefaults",
    {
      readonly: false,
    },
  ),
  agentRole_findHeartbeatEnabled: storeUnit(
    (db: Database.Database) => new AgentRoleStore(db),
    "findHeartbeatEnabled",
    {
      readonly: true,
    },
  ),
  agentRole_updateHeartbeatConfig: storeUnit(
    (db: Database.Database) => new AgentRoleStore(db),
    "updateHeartbeatConfig",
    {
      readonly: false,
    },
  ),
  agentRole_updateHeartbeatStatus: storeUnit(
    (db: Database.Database) => new AgentRoleStore(db),
    "updateHeartbeatStatus",
    {
      readonly: false,
    },
  ),
  agentRole_updateHeartbeatRunTimestamps: storeUnit(
    (db: Database.Database) => new AgentRoleStore(db),
    "updateHeartbeatRunTimestamps",
    {
      readonly: false,
    },
  ),
  agentRole_updateSoul: storeUnit((db: Database.Database) => new AgentRoleStore(db), "updateSoul", {
    readonly: false,
  }),
  agentRole_updateAutonomyLevel: storeUnit(
    (db: Database.Database) => new AgentRoleStore(db),
    "updateAutonomyLevel",
    {
      readonly: false,
    },
  ),
  agentRole_findByAutonomyLevel: storeUnit(
    (db: Database.Database) => new AgentRoleStore(db),
    "findByAutonomyLevel",
    {
      readonly: true,
    },
  ),
  agentTeamRun_create: storeUnit((db: Database.Database) => new AgentTeamRunStore(db), "create", {
    readonly: false,
  }),
  agentTeamRun_findById: storeUnit(
    (db: Database.Database) => new AgentTeamRunStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  agentTeamRun_findByRootTaskId: storeUnit(
    (db: Database.Database) => new AgentTeamRunStore(db),
    "findByRootTaskId",
    {
      readonly: true,
    },
  ),
  agentTeamRun_listByTeam: storeUnit(
    (db: Database.Database) => new AgentTeamRunStore(db),
    "listByTeam",
    {
      readonly: true,
    },
  ),
  agentTeamRun_update: storeUnit((db: Database.Database) => new AgentTeamRunStore(db), "update", {
    readonly: false,
  }),
  agentTeamRun_delete: storeUnit((db: Database.Database) => new AgentTeamRunStore(db), "delete", {
    readonly: false,
  }),
  agentTeamThought_create: storeUnit(
    (db: Database.Database) => new AgentTeamThoughtStore(db),
    "create",
    {
      readonly: false,
    },
  ),
  agentTeamThought_findById: storeUnit(
    (db: Database.Database) => new AgentTeamThoughtStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  agentTeamThought_listByRun: storeUnit(
    (db: Database.Database) => new AgentTeamThoughtStore(db),
    "listByRun",
    {
      readonly: true,
    },
  ),
  agentTeamThought_listByAgent: storeUnit(
    (db: Database.Database) => new AgentTeamThoughtStore(db),
    "listByAgent",
    {
      readonly: true,
    },
  ),
  agentTeamThought_updateContent: storeUnit(
    (db: Database.Database) => new AgentTeamThoughtStore(db),
    "updateContent",
    {
      readonly: false,
    },
  ),
  agentTeamThought_deleteByRun: storeUnit(
    (db: Database.Database) => new AgentTeamThoughtStore(db),
    "deleteByRun",
    {
      readonly: false,
    },
  ),
  agentTeamThought_listBySourceTaskId: storeUnit(
    (db: Database.Database) => new AgentTeamThoughtStore(db),
    "listBySourceTaskId",
    {
      readonly: true,
    },
  ),
  automationProfile_listAll: storeUnit(
    (db: Database.Database) => new AutomationProfileStore(db),
    "listAll",
    {
      readonly: true,
    },
  ),
  automationProfile_listEnabled: storeUnit(
    (db: Database.Database) => new AutomationProfileStore(db),
    "listEnabled",
    {
      readonly: true,
    },
  ),
  automationProfile_findById: storeUnit(
    (db: Database.Database) => new AutomationProfileStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  automationProfile_findByAgentRoleId: storeUnit(
    (db: Database.Database) => new AutomationProfileStore(db),
    "findByAgentRoleId",
    {
      readonly: true,
    },
  ),
  automationProfile_create: storeUnit(
    (db: Database.Database) => new AutomationProfileStore(db),
    "create",
    {
      readonly: false,
    },
  ),
  automationProfile_createOrReplace: storeUnit(
    (db: Database.Database) => new AutomationProfileStore(db),
    "createOrReplace",
    {
      readonly: false,
    },
  ),
  automationProfile_update: storeUnit(
    (db: Database.Database) => new AutomationProfileStore(db),
    "update",
    {
      readonly: false,
    },
  ),
  automationProfile_updateByAgentRoleId: storeUnit(
    (db: Database.Database) => new AutomationProfileStore(db),
    "updateByAgentRoleId",
    {
      readonly: false,
    },
  ),
  automationProfile_updateRuntimeState: storeUnit(
    (db: Database.Database) => new AutomationProfileStore(db),
    "updateRuntimeState",
    {
      readonly: false,
    },
  ),
  automationProfile_deleteById: storeUnit(
    (db: Database.Database) => new AutomationProfileStore(db),
    "deleteById",
    {
      readonly: false,
    },
  ),
  automationProfile_deleteByAgentRoleId: storeUnit(
    (db: Database.Database) => new AutomationProfileStore(db),
    "deleteByAgentRoleId",
    {
      readonly: false,
    },
  ),
  agentTeam_create: storeUnit((db: Database.Database) => new AgentTeamStore(db), "create", {
    readonly: false,
  }),
  agentTeam_findById: storeUnit((db: Database.Database) => new AgentTeamStore(db), "findById", {
    readonly: true,
  }),
  agentTeam_findByName: storeUnit((db: Database.Database) => new AgentTeamStore(db), "findByName", {
    readonly: true,
  }),
  agentTeam_listByWorkspace: storeUnit(
    (db: Database.Database) => new AgentTeamStore(db),
    "listByWorkspace",
    {
      readonly: true,
    },
  ),
  agentTeam_update: storeUnit((db: Database.Database) => new AgentTeamStore(db), "update", {
    readonly: false,
  }),
  agentTeam_delete: storeUnit((db: Database.Database) => new AgentTeamStore(db), "delete", {
    readonly: false,
  }),
  agentTeam_listPersistent: storeUnit(
    (db: Database.Database) => new AgentTeamStore(db),
    "listPersistent",
    {
      readonly: true,
    },
  ),
  heartbeatPolicy_findByAgentRoleId: storeUnit(
    (db: Database.Database) => new HeartbeatPolicyStore(db),
    "findByAgentRoleId",
    {
      readonly: true,
    },
  ),
  heartbeatPolicy_listAll: storeUnit(
    (db: Database.Database) => new HeartbeatPolicyStore(db),
    "listAll",
    {
      readonly: true,
    },
  ),
  heartbeatPolicy_upsert: storeUnit(
    (db: Database.Database) => new HeartbeatPolicyStore(db),
    "upsert",
    {
      readonly: false,
    },
  ),
  heartbeatPolicy_deleteByAgentRoleId: storeUnit(
    (db: Database.Database) => new HeartbeatPolicyStore(db),
    "deleteByAgentRoleId",
    {
      readonly: false,
    },
  ),
  heartbeatRun_create: storeUnit((db: Database.Database) => new HeartbeatRunStore(db), "create", {
    readonly: false,
  }),
  heartbeatRun_finish: storeUnit((db: Database.Database) => new HeartbeatRunStore(db), "finish", {
    readonly: false,
  }),
  heartbeatRun_attachTask: storeUnit(
    (db: Database.Database) => new HeartbeatRunStore(db),
    "attachTask",
    {
      readonly: false,
    },
  ),
  heartbeatRun_recordEvent: storeUnit(
    (db: Database.Database) => new HeartbeatRunStore(db),
    "recordEvent",
    {
      readonly: false,
    },
  ),
  heartbeatRun_reconcileLegacyMigratedRuns: storeUnit(
    (db: Database.Database) => new HeartbeatRunStore(db),
    "reconcileLegacyMigratedRuns",
    { readonly: false },
  ),
  heartbeatRun_reconcileInterruptedAgentRuns: storeUnit(
    (db: Database.Database) => new HeartbeatRunStore(db),
    "reconcileInterruptedAgentRuns",
    {
      readonly: false,
    },
  ),
  heartbeatRun_get: storeUnit((db: Database.Database) => new HeartbeatRunStore(db), "get", {
    readonly: true,
  }),
  heartbeatRun_listRecentDispatches: storeUnit(
    (db: Database.Database) => new HeartbeatRunStore(db),
    "listRecentDispatches",
    {
      readonly: true,
    },
  ),
  heartbeatRun_getLatestRun: storeUnit(
    (db: Database.Database) => new HeartbeatRunStore(db),
    "getLatestRun",
    {
      readonly: true,
    },
  ),
  heartbeatRun_hasInFlightDispatch: storeUnit(
    (db: Database.Database) => new HeartbeatRunStore(db),
    "hasInFlightDispatch",
    {
      readonly: true,
    },
  ),
  mention_create: storeUnit((db: Database.Database) => new MentionStore(db), "create", {
    readonly: false,
  }),
  mention_findById: storeUnit((db: Database.Database) => new MentionStore(db), "findById", {
    readonly: true,
  }),
  mention_list: storeUnit((db: Database.Database) => new MentionStore(db), "list", {
    readonly: true,
  }),
  mention_getPendingForAgent: storeUnit(
    (db: Database.Database) => new MentionStore(db),
    "getPendingForAgent",
    {
      readonly: true,
    },
  ),
  mention_getPendingCount: storeUnit(
    (db: Database.Database) => new MentionStore(db),
    "getPendingCount",
    {
      readonly: true,
    },
  ),
  mention_acknowledge: storeUnit((db: Database.Database) => new MentionStore(db), "acknowledge", {
    readonly: false,
  }),
  mention_complete: storeUnit((db: Database.Database) => new MentionStore(db), "complete", {
    readonly: false,
  }),
  mention_dismiss: storeUnit((db: Database.Database) => new MentionStore(db), "dismiss", {
    readonly: false,
  }),
  mention_delete: storeUnit((db: Database.Database) => new MentionStore(db), "delete", {
    readonly: false,
  }),
  mention_deleteByTask: storeUnit((db: Database.Database) => new MentionStore(db), "deleteByTask", {
    readonly: false,
  }),
  taskSubscription_subscribe: storeUnit(
    (db: Database.Database) => new TaskSubscriptionStore(db),
    "subscribe",
    {
      readonly: false,
    },
  ),
  taskSubscription_autoSubscribe: storeUnit(
    (db: Database.Database) => new TaskSubscriptionStore(db),
    "autoSubscribe",
    {
      readonly: false,
    },
  ),
  taskSubscription_unsubscribe: storeUnit(
    (db: Database.Database) => new TaskSubscriptionStore(db),
    "unsubscribe",
    {
      readonly: false,
    },
  ),
  taskSubscription_findByTaskAndAgent: storeUnit(
    (db: Database.Database) => new TaskSubscriptionStore(db),
    "findByTaskAndAgent",
    {
      readonly: true,
    },
  ),
  taskSubscription_findById: storeUnit(
    (db: Database.Database) => new TaskSubscriptionStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  taskSubscription_getSubscribers: storeUnit(
    (db: Database.Database) => new TaskSubscriptionStore(db),
    "getSubscribers",
    {
      readonly: true,
    },
  ),
  taskSubscription_getSubscriberCount: storeUnit(
    (db: Database.Database) => new TaskSubscriptionStore(db),
    "getSubscriberCount",
    {
      readonly: true,
    },
  ),
  taskSubscription_getSubscriptionsForAgent: storeUnit(
    (db: Database.Database) => new TaskSubscriptionStore(db),
    "getSubscriptionsForAgent",
    {
      readonly: true,
    },
  ),
  taskSubscription_list: storeUnit(
    (db: Database.Database) => new TaskSubscriptionStore(db),
    "list",
    {
      readonly: true,
    },
  ),
  taskSubscription_deleteByTask: storeUnit(
    (db: Database.Database) => new TaskSubscriptionStore(db),
    "deleteByTask",
    {
      readonly: false,
    },
  ),
  taskSubscription_deleteByAgent: storeUnit(
    (db: Database.Database) => new TaskSubscriptionStore(db),
    "deleteByAgent",
    {
      readonly: false,
    },
  ),
  taskSubscription_isSubscribed: storeUnit(
    (db: Database.Database) => new TaskSubscriptionStore(db),
    "isSubscribed",
    {
      readonly: true,
    },
  ),
  taskSubscription_getSubscriberIds: storeUnit(
    (db: Database.Database) => new TaskSubscriptionStore(db),
    "getSubscriberIds",
    {
      readonly: true,
    },
  ),
  workingState_findById: storeUnit(
    (db: Database.Database) => new WorkingStateStore(db),
    "findById",
    {
      readonly: true,
    },
  ),
  workingState_getCurrent: storeUnit(
    (db: Database.Database) => new WorkingStateStore(db),
    "getCurrent",
    {
      readonly: true,
    },
  ),
  workingState_getAllCurrent: storeUnit(
    (db: Database.Database) => new WorkingStateStore(db),
    "getAllCurrent",
    {
      readonly: true,
    },
  ),
  workingState_update: storeUnit((db: Database.Database) => new WorkingStateStore(db), "update", {
    readonly: false,
  }),
  workingState_getHistory: storeUnit(
    (db: Database.Database) => new WorkingStateStore(db),
    "getHistory",
    {
      readonly: true,
    },
  ),
  workingState_listForTask: storeUnit(
    (db: Database.Database) => new WorkingStateStore(db),
    "listForTask",
    {
      readonly: true,
    },
  ),
  workingState_restore: storeUnit((db: Database.Database) => new WorkingStateStore(db), "restore", {
    readonly: false,
  }),
  workingState_delete: storeUnit((db: Database.Database) => new WorkingStateStore(db), "delete", {
    readonly: false,
  }),
  workingState_deleteByAgentAndWorkspace: storeUnit(
    (db: Database.Database) => new WorkingStateStore(db),
    "deleteByAgentAndWorkspace",
    {
      readonly: false,
    },
  ),
  workingState_deleteByTask: storeUnit(
    (db: Database.Database) => new WorkingStateStore(db),
    "deleteByTask",
    {
      readonly: false,
    },
  ),
  workingState_cleanupOldStates: storeUnit(
    (db: Database.Database) => new WorkingStateStore(db),
    "cleanupOldStates",
    {
      readonly: false,
    },
  ),
} satisfies UnitCatalog;
