import type Database from "better-sqlite3";
import type { UnitCatalog } from "./statements/statement-catalog";
import { storeUnit } from "./statements/store-units";
import {
  AnnotationStore,
  ApprovalStore,
  ArtifactStore,
  AuditLogStore,
  BotNotificationPreferenceStore,
  ChannelMessageStore,
  ChannelSessionStore,
  ChannelSpecializationStore,
  ChannelStore,
  ChannelUserStore,
  ComparisonSessionStore,
  CuratedMemoryStore,
  DeliveryTrackingStore,
  InputRequestStore,
  LLMModelStore,
  MemoryEmbeddingStore,
  MemorySettingsStore,
  MemoryStore,
  MemorySummaryStore,
  MessageQueueStore,
  PendingMemoryWriteStore,
  RateLimitStore,
  SEALED_CHANNEL_CONFIG_CODEC,
  ScheduledMessageStore,
  SkillStore,
  TaskSessionMetadataStore,
  TaskAdmissionStore,
  BrowserTaskCancelReceiptStore,
  TaskEventRepository,
  TaskStore,
  WorkspacePermissionRuleStore,
  WorkspaceStore,
  WorktreeInfoStore,
} from "./repositories";
import { ComposerDraftStore } from "./composer-draft-repository";
import { TaskLabelStore } from "./TaskLabelRepository";
import { DeviceProfileStore } from "./DeviceProfileRepository";
import { WorkSessionProtocolRepository } from "./WorkSessionProtocolRepository";

/**
 * Storage-layer transaction units, slice A (async SQLite migration plan, DB6): one per
 * public method of the leaf repositories' synchronous stores. Generated from the classes;
 * a method is a write when it, or a method it calls, writes or opens a transaction.
 */
export const STORAGE_UNITS = {
  browserTaskCancelReceipt_reserve: storeUnit(
    (db: Database.Database) => new BrowserTaskCancelReceiptStore(db),
    "reserve",
    { readonly: false },
  ),
  browserTaskCancelReceipt_complete: storeUnit(
    (db: Database.Database) => new BrowserTaskCancelReceiptStore(db),
    "complete",
    { readonly: false },
  ),
  browserTaskCancelReceipt_get: storeUnit(
    (db: Database.Database) => new BrowserTaskCancelReceiptStore(db),
    "get",
    { readonly: true },
  ),
  taskAdmission_admit: storeUnit((db: Database.Database) => new TaskAdmissionStore(db), "admit", {
    readonly: false,
  }),
  taskAdmission_findByOperationKey: storeUnit(
    (db: Database.Database) => new TaskAdmissionStore(db),
    "findByOperationKey",
    { readonly: true },
  ),
  taskEvent_getCommittedMutationCursor: storeUnit(
    (db: Database.Database) => new TaskEventRepository(db),
    "getCommittedMutationCursor",
    { readonly: true },
  ),
  taskEvent_findCommittedMutationPage: storeUnit(
    (db: Database.Database) => new TaskEventRepository(db),
    "findCommittedMutationPage",
    { readonly: true },
  ),
  taskEvent_findTimelinePage: storeUnit(
    (db: Database.Database) => new TaskEventRepository(db),
    "findTimelinePage",
    { readonly: true },
  ),
  taskEvent_findEventDetailById: storeUnit(
    (db: Database.Database) => new TaskEventRepository(db),
    "findEventDetailById",
    { readonly: true },
  ),
  taskEvent_findScopedTimelineSnapshot: storeUnit(
    (db: Database.Database) => new TaskEventRepository(db),
    "findScopedTimelineSnapshot",
    { readonly: true },
  ),
  taskEvent_findScopedTimelineHistoryPage: storeUnit(
    (db: Database.Database) => new TaskEventRepository(db),
    "findScopedTimelineHistoryPage",
    { readonly: true },
  ),
  taskEvent_findScopedMutationPage: storeUnit(
    (db: Database.Database) => new TaskEventRepository(db),
    "findScopedMutationPage",
    { readonly: true },
  ),
  taskSessionMetadata_findBySessionId: storeUnit(
    (db: Database.Database) => new TaskSessionMetadataStore(db),
    "findBySessionId",
    { readonly: true },
  ),
  taskSessionMetadata_findBySessionIds: storeUnit(
    (db: Database.Database) => new TaskSessionMetadataStore(db),
    "findBySessionIds",
    { readonly: true },
  ),
  taskSessionMetadata_upsert: storeUnit(
    (db: Database.Database) => new TaskSessionMetadataStore(db),
    "upsert",
    { readonly: false },
  ),
  taskSessionMetadata_rename: storeUnit(
    (db: Database.Database) => new TaskSessionMetadataStore(db),
    "rename",
    { readonly: false },
  ),
  taskSessionMetadata_archive: storeUnit(
    (db: Database.Database) => new TaskSessionMetadataStore(db),
    "archive",
    { readonly: false },
  ),
  taskSessionMetadata_unarchive: storeUnit(
    (db: Database.Database) => new TaskSessionMetadataStore(db),
    "unarchive",
    { readonly: false },
  ),
  taskSessionMetadata_delete: storeUnit(
    (db: Database.Database) => new TaskSessionMetadataStore(db),
    "delete",
    { readonly: false },
  ),
  botNotificationPreference_findByAgentRoleId: storeUnit(
    (db: Database.Database) => new BotNotificationPreferenceStore(db),
    "findByAgentRoleId",
    { readonly: true },
  ),
  botNotificationPreference_upsert: storeUnit(
    (db: Database.Database) => new BotNotificationPreferenceStore(db),
    "upsert",
    { readonly: false },
  ),
  artifact_create: storeUnit((db: Database.Database) => new ArtifactStore(db), "create", {
    readonly: false,
  }),
  artifact_findByTaskId: storeUnit(
    (db: Database.Database) => new ArtifactStore(db),
    "findByTaskId",
    { readonly: true },
  ),
  artifact_findByTaskIdPage: storeUnit(
    (db: Database.Database) => new ArtifactStore(db),
    "findByTaskIdPage",
    { readonly: true },
  ),
  artifact_findById: storeUnit((db: Database.Database) => new ArtifactStore(db), "findById", {
    readonly: true,
  }),
  artifact_findLatestByPath: storeUnit(
    (db: Database.Database) => new ArtifactStore(db),
    "findLatestByPath",
    { readonly: true },
  ),
  annotation_create: storeUnit((db: Database.Database) => new AnnotationStore(db), "create", {
    readonly: false,
  }),
  annotation_update: storeUnit((db: Database.Database) => new AnnotationStore(db), "update", {
    readonly: false,
  }),
  annotation_markAddressing: storeUnit(
    (db: Database.Database) => new AnnotationStore(db),
    "markAddressing",
    { readonly: false },
  ),
  annotation_markAddressed: storeUnit(
    (db: Database.Database) => new AnnotationStore(db),
    "markAddressed",
    { readonly: false },
  ),
  annotation_findById: storeUnit((db: Database.Database) => new AnnotationStore(db), "findById", {
    readonly: true,
  }),
  annotation_list: storeUnit((db: Database.Database) => new AnnotationStore(db), "list", {
    readonly: true,
  }),
  annotation_listOpenByTask: storeUnit(
    (db: Database.Database) => new AnnotationStore(db),
    "listOpenByTask",
    { readonly: true },
  ),
  approval_create: storeUnit((db: Database.Database) => new ApprovalStore(db), "create", {
    readonly: false,
  }),
  approval_update: storeUnit((db: Database.Database) => new ApprovalStore(db), "update", {
    readonly: false,
  }),
  approval_findById: storeUnit((db: Database.Database) => new ApprovalStore(db), "findById", {
    readonly: true,
  }),
  approval_findPendingByTaskId: storeUnit(
    (db: Database.Database) => new ApprovalStore(db),
    "findPendingByTaskId",
    { readonly: true },
  ),
  approval_findPending: storeUnit((db: Database.Database) => new ApprovalStore(db), "findPending", {
    readonly: true,
  }),
  approval_findAllPending: storeUnit(
    (db: Database.Database) => new ApprovalStore(db),
    "findAllPending",
    { readonly: true },
  ),
  workspacePermissionRule_listByWorkspaceId: storeUnit(
    (db: Database.Database) => new WorkspacePermissionRuleStore(db),
    "listByWorkspaceId",
    { readonly: true },
  ),
  workspacePermissionRule_findById: storeUnit(
    (db: Database.Database) => new WorkspacePermissionRuleStore(db),
    "findById",
    { readonly: true },
  ),
  workspacePermissionRule_create: storeUnit(
    (db: Database.Database) => new WorkspacePermissionRuleStore(db),
    "create",
    { readonly: false },
  ),
  workspacePermissionRule_deleteById: storeUnit(
    (db: Database.Database) => new WorkspacePermissionRuleStore(db),
    "deleteById",
    { readonly: false },
  ),
  workspacePermissionRule_deleteByWorkspaceAndId: storeUnit(
    (db: Database.Database) => new WorkspacePermissionRuleStore(db),
    "deleteByWorkspaceAndId",
    { readonly: false },
  ),
  inputRequest_create: storeUnit((db: Database.Database) => new InputRequestStore(db), "create", {
    readonly: false,
  }),
  inputRequest_resolve: storeUnit((db: Database.Database) => new InputRequestStore(db), "resolve", {
    readonly: false,
  }),
  inputRequest_findById: storeUnit(
    (db: Database.Database) => new InputRequestStore(db),
    "findById",
    { readonly: true },
  ),
  inputRequest_findPendingByTaskId: storeUnit(
    (db: Database.Database) => new InputRequestStore(db),
    "findPendingByTaskId",
    { readonly: true },
  ),
  inputRequest_findAllPending: storeUnit(
    (db: Database.Database) => new InputRequestStore(db),
    "findAllPending",
    { readonly: true },
  ),
  inputRequest_list: storeUnit((db: Database.Database) => new InputRequestStore(db), "list", {
    readonly: true,
  }),
  skill_create: storeUnit((db: Database.Database) => new SkillStore(db), "create", {
    readonly: false,
  }),
  skill_findAll: storeUnit((db: Database.Database) => new SkillStore(db), "findAll", {
    readonly: true,
  }),
  skill_findById: storeUnit((db: Database.Database) => new SkillStore(db), "findById", {
    readonly: true,
  }),
  lLMModel_findAll: storeUnit((db: Database.Database) => new LLMModelStore(db), "findAll", {
    readonly: true,
  }),
  lLMModel_findByKey: storeUnit((db: Database.Database) => new LLMModelStore(db), "findByKey", {
    readonly: true,
  }),
  lLMModel_findById: storeUnit((db: Database.Database) => new LLMModelStore(db), "findById", {
    readonly: true,
  }),
  channelSpecialization_upsert: storeUnit(
    (db: Database.Database) => new ChannelSpecializationStore(db),
    "upsert",
    { readonly: false },
  ),
  channelSpecialization_create: storeUnit(
    (db: Database.Database) => new ChannelSpecializationStore(db),
    "create",
    { readonly: false },
  ),
  channelSpecialization_update: storeUnit(
    (db: Database.Database) => new ChannelSpecializationStore(db),
    "update",
    { readonly: false },
  ),
  channelSpecialization_delete: storeUnit(
    (db: Database.Database) => new ChannelSpecializationStore(db),
    "delete",
    { readonly: false },
  ),
  channelSpecialization_findById: storeUnit(
    (db: Database.Database) => new ChannelSpecializationStore(db),
    "findById",
    { readonly: true },
  ),
  channelSpecialization_findByScope: storeUnit(
    (db: Database.Database) => new ChannelSpecializationStore(db),
    "findByScope",
    { readonly: true },
  ),
  channelSpecialization_listByChannel: storeUnit(
    (db: Database.Database) => new ChannelSpecializationStore(db),
    "listByChannel",
    { readonly: true },
  ),
  channelSpecialization_resolve: storeUnit(
    (db: Database.Database) => new ChannelSpecializationStore(db),
    "resolve",
    { readonly: true },
  ),
  channelMessage_create: storeUnit(
    (db: Database.Database) => new ChannelMessageStore(db),
    "create",
    { readonly: false },
  ),
  channelMessage_findBySessionId: storeUnit(
    (db: Database.Database) => new ChannelMessageStore(db),
    "findBySessionId",
    { readonly: true },
  ),
  channelMessage_findByChatId: storeUnit(
    (db: Database.Database) => new ChannelMessageStore(db),
    "findByChatId",
    { readonly: true },
  ),
  channelMessage_deleteByChannelId: storeUnit(
    (db: Database.Database) => new ChannelMessageStore(db),
    "deleteByChannelId",
    { readonly: false },
  ),
  channelMessage_getDistinctChatIds: storeUnit(
    (db: Database.Database) => new ChannelMessageStore(db),
    "getDistinctChatIds",
    { readonly: true },
  ),
  messageQueue_enqueue: storeUnit((db: Database.Database) => new MessageQueueStore(db), "enqueue", {
    readonly: false,
  }),
  messageQueue_update: storeUnit((db: Database.Database) => new MessageQueueStore(db), "update", {
    readonly: false,
  }),
  messageQueue_findPending: storeUnit(
    (db: Database.Database) => new MessageQueueStore(db),
    "findPending",
    { readonly: true },
  ),
  messageQueue_findById: storeUnit(
    (db: Database.Database) => new MessageQueueStore(db),
    "findById",
    { readonly: true },
  ),
  messageQueue_delete: storeUnit((db: Database.Database) => new MessageQueueStore(db), "delete", {
    readonly: false,
  }),
  messageQueue_deleteOld: storeUnit(
    (db: Database.Database) => new MessageQueueStore(db),
    "deleteOld",
    { readonly: false },
  ),
  scheduledMessage_create: storeUnit(
    (db: Database.Database) => new ScheduledMessageStore(db),
    "create",
    { readonly: false },
  ),
  scheduledMessage_update: storeUnit(
    (db: Database.Database) => new ScheduledMessageStore(db),
    "update",
    { readonly: false },
  ),
  scheduledMessage_findDue: storeUnit(
    (db: Database.Database) => new ScheduledMessageStore(db),
    "findDue",
    { readonly: true },
  ),
  scheduledMessage_findById: storeUnit(
    (db: Database.Database) => new ScheduledMessageStore(db),
    "findById",
    { readonly: true },
  ),
  scheduledMessage_findByChatId: storeUnit(
    (db: Database.Database) => new ScheduledMessageStore(db),
    "findByChatId",
    { readonly: true },
  ),
  scheduledMessage_cancel: storeUnit(
    (db: Database.Database) => new ScheduledMessageStore(db),
    "cancel",
    { readonly: false },
  ),
  scheduledMessage_delete: storeUnit(
    (db: Database.Database) => new ScheduledMessageStore(db),
    "delete",
    { readonly: false },
  ),
  deliveryTracking_create: storeUnit(
    (db: Database.Database) => new DeliveryTrackingStore(db),
    "create",
    { readonly: false },
  ),
  deliveryTracking_update: storeUnit(
    (db: Database.Database) => new DeliveryTrackingStore(db),
    "update",
    { readonly: false },
  ),
  deliveryTracking_findByMessageId: storeUnit(
    (db: Database.Database) => new DeliveryTrackingStore(db),
    "findByMessageId",
    { readonly: true },
  ),
  deliveryTracking_findByChatId: storeUnit(
    (db: Database.Database) => new DeliveryTrackingStore(db),
    "findByChatId",
    { readonly: true },
  ),
  deliveryTracking_deleteOld: storeUnit(
    (db: Database.Database) => new DeliveryTrackingStore(db),
    "deleteOld",
    { readonly: false },
  ),
  rateLimit_getOrCreate: storeUnit(
    (db: Database.Database) => new RateLimitStore(db),
    "getOrCreate",
    { readonly: false },
  ),
  rateLimit_update: storeUnit((db: Database.Database) => new RateLimitStore(db), "update", {
    readonly: false,
  }),
  rateLimit_resetWindow: storeUnit(
    (db: Database.Database) => new RateLimitStore(db),
    "resetWindow",
    { readonly: false },
  ),
  auditLog_log: storeUnit((db: Database.Database) => new AuditLogStore(db), "log", {
    readonly: false,
  }),
  auditLog_find: storeUnit((db: Database.Database) => new AuditLogStore(db), "find", {
    readonly: true,
  }),
  auditLog_deleteOld: storeUnit((db: Database.Database) => new AuditLogStore(db), "deleteOld", {
    readonly: false,
  }),
  curatedMemory_create: storeUnit((db: Database.Database) => new CuratedMemoryStore(db), "create", {
    readonly: false,
  }),
  curatedMemory_update: storeUnit((db: Database.Database) => new CuratedMemoryStore(db), "update", {
    readonly: false,
  }),
  curatedMemory_findById: storeUnit(
    (db: Database.Database) => new CuratedMemoryStore(db),
    "findById",
    { readonly: true },
  ),
  curatedMemory_findByNormalizedKey: storeUnit(
    (db: Database.Database) => new CuratedMemoryStore(db),
    "findByNormalizedKey",
    { readonly: true },
  ),
  curatedMemory_findFirstMatching: storeUnit(
    (db: Database.Database) => new CuratedMemoryStore(db),
    "findFirstMatching",
    { readonly: true },
  ),
  curatedMemory_list: storeUnit((db: Database.Database) => new CuratedMemoryStore(db), "list", {
    readonly: true,
  }),
  curatedMemory_archive: storeUnit(
    (db: Database.Database) => new CuratedMemoryStore(db),
    "archive",
    { readonly: false },
  ),
  memorySummary_create: storeUnit((db: Database.Database) => new MemorySummaryStore(db), "create", {
    readonly: false,
  }),
  memorySummary_findByWorkspaceAndPeriod: storeUnit(
    (db: Database.Database) => new MemorySummaryStore(db),
    "findByWorkspaceAndPeriod",
    { readonly: true },
  ),
  memorySummary_findByWorkspace: storeUnit(
    (db: Database.Database) => new MemorySummaryStore(db),
    "findByWorkspace",
    { readonly: true },
  ),
  memorySummary_deleteByWorkspace: storeUnit(
    (db: Database.Database) => new MemorySummaryStore(db),
    "deleteByWorkspace",
    { readonly: false },
  ),
  memorySettings_getOrCreate: storeUnit(
    (db: Database.Database) => new MemorySettingsStore(db),
    "getOrCreate",
    { readonly: false },
  ),
  memorySettings_update: storeUnit(
    (db: Database.Database) => new MemorySettingsStore(db),
    "update",
    { readonly: false },
  ),
  memorySettings_delete: storeUnit(
    (db: Database.Database) => new MemorySettingsStore(db),
    "delete",
    { readonly: false },
  ),
  pendingMemoryWrite_create: storeUnit(
    (db: Database.Database) => new PendingMemoryWriteStore(db),
    "create",
    { readonly: false },
  ),
  pendingMemoryWrite_findById: storeUnit(
    (db: Database.Database) => new PendingMemoryWriteStore(db),
    "findById",
    { readonly: true },
  ),
  pendingMemoryWrite_list: storeUnit(
    (db: Database.Database) => new PendingMemoryWriteStore(db),
    "list",
    { readonly: true },
  ),
  pendingMemoryWrite_countPending: storeUnit(
    (db: Database.Database) => new PendingMemoryWriteStore(db),
    "countPending",
    { readonly: true },
  ),
  pendingMemoryWrite_updateStatus: storeUnit(
    (db: Database.Database) => new PendingMemoryWriteStore(db),
    "updateStatus",
    { readonly: false },
  ),
  pendingMemoryWrite_updateStatusIfCurrent: storeUnit(
    (db: Database.Database) => new PendingMemoryWriteStore(db),
    "updateStatusIfCurrent",
    { readonly: false },
  ),
  pendingMemoryWrite_rejectPending: storeUnit(
    (db: Database.Database) => new PendingMemoryWriteStore(db),
    "rejectPending",
    { readonly: false },
  ),
  worktreeInfo_create: storeUnit((db: Database.Database) => new WorktreeInfoStore(db), "create", {
    readonly: false,
  }),
  worktreeInfo_findByTaskId: storeUnit(
    (db: Database.Database) => new WorktreeInfoStore(db),
    "findByTaskId",
    { readonly: true },
  ),
  worktreeInfo_findByWorkspaceId: storeUnit(
    (db: Database.Database) => new WorktreeInfoStore(db),
    "findByWorkspaceId",
    { readonly: true },
  ),
  worktreeInfo_update: storeUnit((db: Database.Database) => new WorktreeInfoStore(db), "update", {
    readonly: false,
  }),
  worktreeInfo_delete: storeUnit((db: Database.Database) => new WorktreeInfoStore(db), "delete", {
    readonly: false,
  }),
  comparisonSession_create: storeUnit(
    (db: Database.Database) => new ComparisonSessionStore(db),
    "create",
    { readonly: false },
  ),
  comparisonSession_findById: storeUnit(
    (db: Database.Database) => new ComparisonSessionStore(db),
    "findById",
    { readonly: false },
  ),
  comparisonSession_findByWorkspaceId: storeUnit(
    (db: Database.Database) => new ComparisonSessionStore(db),
    "findByWorkspaceId",
    { readonly: false },
  ),
  comparisonSession_update: storeUnit(
    (db: Database.Database) => new ComparisonSessionStore(db),
    "update",
    { readonly: false },
  ),
  comparisonSession_delete: storeUnit(
    (db: Database.Database) => new ComparisonSessionStore(db),
    "delete",
    { readonly: false },
  ),
  comparisonSession_syncTaskIdsFromTasks: storeUnit(
    (db: Database.Database) => new ComparisonSessionStore(db),
    "syncTaskIdsFromTasks",
    { readonly: false },
  ),
  composerDraft_get: storeUnit((db: Database.Database) => new ComposerDraftStore(db), "get", {
    readonly: true,
  }),
  composerDraft_upsertIfNewer: storeUnit(
    (db: Database.Database) => new ComposerDraftStore(db),
    "upsertIfNewer",
    { readonly: false },
  ),
  composerDraft_clear: storeUnit((db: Database.Database) => new ComposerDraftStore(db), "clear", {
    readonly: false,
  }),
  composerDraft_rekey: storeUnit((db: Database.Database) => new ComposerDraftStore(db), "rekey", {
    readonly: false,
  }),
  composerDraft_canRekey: storeUnit(
    (db: Database.Database) => new ComposerDraftStore(db),
    "canRekey",
    { readonly: true },
  ),
  composerDraft_pruneExpired: storeUnit(
    (db: Database.Database) => new ComposerDraftStore(db),
    "pruneExpired",
    { readonly: false },
  ),
  composerDraft_listExpired: storeUnit(
    (db: Database.Database) => new ComposerDraftStore(db),
    "listExpired",
    { readonly: true },
  ),
  composerDraft_listLiveAttachmentRefs: storeUnit(
    (db: Database.Database) => new ComposerDraftStore(db),
    "listLiveAttachmentRefs",
    { readonly: true },
  ),
  taskLabel_create: storeUnit((db: Database.Database) => new TaskLabelStore(db), "create", {
    readonly: false,
  }),
  taskLabel_findById: storeUnit((db: Database.Database) => new TaskLabelStore(db), "findById", {
    readonly: true,
  }),
  taskLabel_findByName: storeUnit((db: Database.Database) => new TaskLabelStore(db), "findByName", {
    readonly: true,
  }),
  taskLabel_list: storeUnit((db: Database.Database) => new TaskLabelStore(db), "list", {
    readonly: true,
  }),
  taskLabel_update: storeUnit((db: Database.Database) => new TaskLabelStore(db), "update", {
    readonly: false,
  }),
  taskLabel_delete: storeUnit((db: Database.Database) => new TaskLabelStore(db), "delete", {
    readonly: false,
  }),
  taskLabel_deleteByWorkspace: storeUnit(
    (db: Database.Database) => new TaskLabelStore(db),
    "deleteByWorkspace",
    { readonly: false },
  ),
  taskLabel_getByIds: storeUnit((db: Database.Database) => new TaskLabelStore(db), "getByIds", {
    readonly: true,
  }),
  deviceProfile_upsert: storeUnit((db: Database.Database) => new DeviceProfileStore(db), "upsert", {
    readonly: false,
  }),
  deviceProfile_get: storeUnit((db: Database.Database) => new DeviceProfileStore(db), "get", {
    readonly: true,
  }),
  deviceProfile_list: storeUnit((db: Database.Database) => new DeviceProfileStore(db), "list", {
    readonly: true,
  }),
  deviceProfile_updateCustomName: storeUnit(
    (db: Database.Database) => new DeviceProfileStore(db),
    "updateCustomName",
    { readonly: false },
  ),
  deviceProfile_updateLastSeen: storeUnit(
    (db: Database.Database) => new DeviceProfileStore(db),
    "updateLastSeen",
    { readonly: false },
  ),
  channel_create: storeUnit(
    (db: Database.Database) => new ChannelStore(db, SEALED_CHANNEL_CONFIG_CODEC),
    "create",
    { readonly: false },
  ),
  channel_createIfTypeAbsent: storeUnit(
    (db: Database.Database) => new ChannelStore(db, SEALED_CHANNEL_CONFIG_CODEC),
    "createIfTypeAbsent",
    { readonly: false },
  ),
  channel_update: storeUnit(
    (db: Database.Database) => new ChannelStore(db, SEALED_CHANNEL_CONFIG_CODEC),
    "update",
    { readonly: false },
  ),
  channel_findById: storeUnit(
    (db: Database.Database) => new ChannelStore(db, SEALED_CHANNEL_CONFIG_CODEC),
    "findById",
    { readonly: true },
  ),
  channel_findByType: storeUnit(
    (db: Database.Database) => new ChannelStore(db, SEALED_CHANNEL_CONFIG_CODEC),
    "findByType",
    { readonly: true },
  ),
  channel_findAllByType: storeUnit(
    (db: Database.Database) => new ChannelStore(db, SEALED_CHANNEL_CONFIG_CODEC),
    "findAllByType",
    { readonly: true },
  ),
  channel_findAll: storeUnit(
    (db: Database.Database) => new ChannelStore(db, SEALED_CHANNEL_CONFIG_CODEC),
    "findAll",
    { readonly: true },
  ),
  channel_findEnabled: storeUnit(
    (db: Database.Database) => new ChannelStore(db, SEALED_CHANNEL_CONFIG_CODEC),
    "findEnabled",
    { readonly: true },
  ),
  channel_delete: storeUnit(
    (db: Database.Database) => new ChannelStore(db, SEALED_CHANNEL_CONFIG_CODEC),
    "delete",
    { readonly: false },
  ),
  channelUser_findOrCreateByChannelUser: storeUnit(
    (db: Database.Database) => new ChannelUserStore(db),
    "findOrCreateByChannelUser",
    { readonly: false },
  ),
  channelUser_create: storeUnit((db: Database.Database) => new ChannelUserStore(db), "create", {
    readonly: false,
  }),
  channelUser_update: storeUnit((db: Database.Database) => new ChannelUserStore(db), "update", {
    readonly: false,
  }),
  channelUser_findById: storeUnit((db: Database.Database) => new ChannelUserStore(db), "findById", {
    readonly: true,
  }),
  channelUser_findByChannelUserId: storeUnit(
    (db: Database.Database) => new ChannelUserStore(db),
    "findByChannelUserId",
    { readonly: true },
  ),
  channelUser_findByChannelId: storeUnit(
    (db: Database.Database) => new ChannelUserStore(db),
    "findByChannelId",
    { readonly: true },
  ),
  channelUser_findAllowedByChannelId: storeUnit(
    (db: Database.Database) => new ChannelUserStore(db),
    "findAllowedByChannelId",
    { readonly: true },
  ),
  channelUser_deleteByChannelId: storeUnit(
    (db: Database.Database) => new ChannelUserStore(db),
    "deleteByChannelId",
    { readonly: false },
  ),
  channelUser_delete: storeUnit((db: Database.Database) => new ChannelUserStore(db), "delete", {
    readonly: false,
  }),
  channelUser_deleteExpiredPending: storeUnit(
    (db: Database.Database) => new ChannelUserStore(db),
    "deleteExpiredPending",
    { readonly: false },
  ),
  channelUser_deletePendingByChannel: storeUnit(
    (db: Database.Database) => new ChannelUserStore(db),
    "deletePendingByChannel",
    { readonly: false },
  ),
  channelUser_deleteExpiredPendingAll: storeUnit(
    (db: Database.Database) => new ChannelUserStore(db),
    "deleteExpiredPendingAll",
    { readonly: false },
  ),
  channelUser_findByPairingCode: storeUnit(
    (db: Database.Database) => new ChannelUserStore(db),
    "findByPairingCode",
    { readonly: true },
  ),
  channelSession_findOrCreateByChat: storeUnit(
    (db: Database.Database) => new ChannelSessionStore(db),
    "findOrCreateByChat",
    { readonly: false },
  ),
  channelSession_create: storeUnit(
    (db: Database.Database) => new ChannelSessionStore(db),
    "create",
    { readonly: false },
  ),
  channelSession_update: storeUnit(
    (db: Database.Database) => new ChannelSessionStore(db),
    "update",
    { readonly: false },
  ),
  channelSession_findById: storeUnit(
    (db: Database.Database) => new ChannelSessionStore(db),
    "findById",
    { readonly: true },
  ),
  channelSession_findByChatId: storeUnit(
    (db: Database.Database) => new ChannelSessionStore(db),
    "findByChatId",
    { readonly: true },
  ),
  channelSession_findByTaskId: storeUnit(
    (db: Database.Database) => new ChannelSessionStore(db),
    "findByTaskId",
    { readonly: true },
  ),
  channelSession_findActiveByChannelId: storeUnit(
    (db: Database.Database) => new ChannelSessionStore(db),
    "findActiveByChannelId",
    { readonly: true },
  ),
  channelSession_deleteIdleOlderThan: storeUnit(
    (db: Database.Database) => new ChannelSessionStore(db),
    "deleteIdleOlderThan",
    { readonly: false },
  ),
  channelSession_deleteByChannelId: storeUnit(
    (db: Database.Database) => new ChannelSessionStore(db),
    "deleteByChannelId",
    { readonly: false },
  ),
  memory_insertCaptured: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "insertCaptured",
    { readonly: false },
  ),
  memory_create: storeUnit((db: Database.Database) => new MemoryStore(db), "create", {
    readonly: false,
  }),
  memory_update: storeUnit((db: Database.Database) => new MemoryStore(db), "update", {
    readonly: false,
  }),
  memory_findById: storeUnit((db: Database.Database) => new MemoryStore(db), "findById", {
    readonly: true,
  }),
  memory_findByIds: storeUnit((db: Database.Database) => new MemoryStore(db), "findByIds", {
    readonly: true,
  }),
  memory_search: storeUnit((db: Database.Database) => new MemoryStore(db), "search", {
    readonly: true,
  }),
  memory_searchImportedGlobal: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "searchImportedGlobal",
    { readonly: true },
  ),
  memory_searchLocalForPromptRecall: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "searchLocalForPromptRecall",
    { readonly: true },
  ),
  memory_searchByContentMarker: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "searchByContentMarker",
    { readonly: true },
  ),
  memory_getTimelineContext: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "getTimelineContext",
    { readonly: true },
  ),
  memory_getFullDetails: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "getFullDetails",
    { readonly: true },
  ),
  memory_getRecentForWorkspace: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "getRecentForWorkspace",
    { readonly: true },
  ),
  memory_getRecentImportedGlobal: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "getRecentImportedGlobal",
    { readonly: true },
  ),
  memory_getUncompressed: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "getUncompressed",
    { readonly: true },
  ),
  memory_listWorkspaceIds: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "listWorkspaceIds",
    { readonly: true },
  ),
  memory_getApproxStorageBytes: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "getApproxStorageBytes",
    { readonly: true },
  ),
  memory_getOldestForWorkspace: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "getOldestForWorkspace",
    { readonly: true },
  ),
  memory_deleteByIds: storeUnit((db: Database.Database) => new MemoryStore(db), "deleteByIds", {
    readonly: false,
  }),
  memory_findByWorkspace: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "findByWorkspace",
    { readonly: true },
  ),
  memory_findByTask: storeUnit((db: Database.Database) => new MemoryStore(db), "findByTask", {
    readonly: true,
  }),
  memory_deleteOlderThan: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "deleteOlderThan",
    { readonly: false },
  ),
  memory_deleteByWorkspace: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "deleteByWorkspace",
    { readonly: false },
  ),
  memory_deleteByWorkspaceAndId: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "deleteByWorkspaceAndId",
    { readonly: false },
  ),
  memory_getStats: storeUnit((db: Database.Database) => new MemoryStore(db), "getStats", {
    readonly: true,
  }),
  memory_getImportedStats: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "getImportedStats",
    { readonly: true },
  ),
  memory_findImported: storeUnit((db: Database.Database) => new MemoryStore(db), "findImported", {
    readonly: true,
  }),
  memory_deleteImported: storeUnit(
    (db: Database.Database) => new MemoryStore(db),
    "deleteImported",
    { readonly: false },
  ),
  memoryEmbedding_upsert: storeUnit(
    (db: Database.Database) => new MemoryEmbeddingStore(db),
    "upsert",
    { readonly: false },
  ),
  memoryEmbedding_upsertBackfillBatch: storeUnit(
    (db: Database.Database) => new MemoryEmbeddingStore(db),
    "upsertBackfillBatch",
    { readonly: false },
  ),
  memoryEmbedding_getByWorkspace: storeUnit(
    (db: Database.Database) => new MemoryEmbeddingStore(db),
    "getByWorkspace",
    { readonly: true },
  ),
  memoryEmbedding_getStats: storeUnit(
    (db: Database.Database) => new MemoryEmbeddingStore(db),
    "getStats",
    { readonly: true },
  ),
  memoryEmbedding_findMissingOrStale: storeUnit(
    (db: Database.Database) => new MemoryEmbeddingStore(db),
    "findMissingOrStale",
    { readonly: true },
  ),
  memoryEmbedding_getImportedGlobal: storeUnit(
    (db: Database.Database) => new MemoryEmbeddingStore(db),
    "getImportedGlobal",
    { readonly: true },
  ),
  memoryEmbedding_findMissingOrStaleImportedGlobal: storeUnit(
    (db: Database.Database) => new MemoryEmbeddingStore(db),
    "findMissingOrStaleImportedGlobal",
    { readonly: true },
  ),
  memoryEmbedding_deleteByWorkspace: storeUnit(
    (db: Database.Database) => new MemoryEmbeddingStore(db),
    "deleteByWorkspace",
    { readonly: false },
  ),
  memoryEmbedding_deleteByMemoryIds: storeUnit(
    (db: Database.Database) => new MemoryEmbeddingStore(db),
    "deleteByMemoryIds",
    { readonly: false },
  ),
  memoryEmbedding_deleteImported: storeUnit(
    (db: Database.Database) => new MemoryEmbeddingStore(db),
    "deleteImported",
    { readonly: false },
  ),
  // The work-session repositories stay synchronous stores shared by the session services
  // on the host and in the worker; host-only readers use these units.
  workSessionProtocol_findSessionIdForTask: storeUnit(
    (db: Database.Database) => new WorkSessionProtocolRepository(db),
    "findSessionIdForTask",
    { readonly: true },
  ),
  workSessionProtocol_listAllItems: storeUnit(
    (db: Database.Database) => new WorkSessionProtocolRepository(db),
    "listAllItems",
    { readonly: true },
  ),
  task_create: storeUnit((db: Database.Database) => new TaskStore(db), "create", {
    readonly: false,
  }),
  task_update: storeUnit((db: Database.Database) => new TaskStore(db), "update", {
    readonly: false,
  }),
  task_togglePin: storeUnit((db: Database.Database) => new TaskStore(db), "togglePin", {
    readonly: false,
  }),
  task_touch: storeUnit((db: Database.Database) => new TaskStore(db), "touch", { readonly: false }),
  task_findById: storeUnit((db: Database.Database) => new TaskStore(db), "findById", {
    readonly: true,
  }),
  task_findAll: storeUnit((db: Database.Database) => new TaskStore(db), "findAll", {
    readonly: true,
  }),
  task_findBotConversations: storeUnit(
    (db: Database.Database) => new TaskStore(db),
    "findBotConversations",
    { readonly: true },
  ),
  task_search: storeUnit((db: Database.Database) => new TaskStore(db), "search", {
    readonly: true,
  }),
  task_findSidebarSummaries: storeUnit(
    (db: Database.Database) => new TaskStore(db),
    "findSidebarSummaries",
    { readonly: true },
  ),
  task_findByStatus: storeUnit((db: Database.Database) => new TaskStore(db), "findByStatus", {
    readonly: true,
  }),
  task_findByWorkspace: storeUnit((db: Database.Database) => new TaskStore(db), "findByWorkspace", {
    readonly: true,
  }),
  task_findBySessionId: storeUnit((db: Database.Database) => new TaskStore(db), "findBySessionId", {
    readonly: true,
  }),
  task_countByWorkspace: storeUnit(
    (db: Database.Database) => new TaskStore(db),
    "countByWorkspace",
    { readonly: true },
  ),
  task_findByCreatedAtRange: storeUnit(
    (db: Database.Database) => new TaskStore(db),
    "findByCreatedAtRange",
    { readonly: true },
  ),
  task_delete: storeUnit((db: Database.Database) => new TaskStore(db), "delete", {
    readonly: false,
  }),
  task_findByTargetNodeId: storeUnit(
    (db: Database.Database) => new TaskStore(db),
    "findByTargetNodeId",
    { readonly: true },
  ),
  task_findByTargetNodeIds: storeUnit(
    (db: Database.Database) => new TaskStore(db),
    "findByTargetNodeIds",
    { readonly: true },
  ),
  task_pruneByTargetNodeIds: storeUnit(
    (db: Database.Database) => new TaskStore(db),
    "pruneByTargetNodeIds",
    { readonly: false },
  ),
  task_findIdsByCompany: storeUnit(
    (db: Database.Database) => new TaskStore(db),
    "findIdsByCompany",
    {
      readonly: true,
    },
  ),
  task_findByParent: storeUnit((db: Database.Database) => new TaskStore(db), "findByParent", {
    readonly: true,
  }),
  task_findByBoardColumn: storeUnit(
    (db: Database.Database) => new TaskStore(db),
    "findByBoardColumn",
    { readonly: true },
  ),
  task_getTaskBoard: storeUnit((db: Database.Database) => new TaskStore(db), "getTaskBoard", {
    readonly: true,
  }),
  task_moveToColumn: storeUnit((db: Database.Database) => new TaskStore(db), "moveToColumn", {
    readonly: false,
  }),
  task_setPriority: storeUnit((db: Database.Database) => new TaskStore(db), "setPriority", {
    readonly: false,
  }),
  task_setDueDate: storeUnit((db: Database.Database) => new TaskStore(db), "setDueDate", {
    readonly: false,
  }),
  task_setEstimate: storeUnit((db: Database.Database) => new TaskStore(db), "setEstimate", {
    readonly: false,
  }),
  task_addLabel: storeUnit((db: Database.Database) => new TaskStore(db), "addLabel", {
    readonly: false,
  }),
  task_removeLabel: storeUnit((db: Database.Database) => new TaskStore(db), "removeLabel", {
    readonly: false,
  }),
  task_assignAgentRole: storeUnit((db: Database.Database) => new TaskStore(db), "assignAgentRole", {
    readonly: false,
  }),
  workspace_create: storeUnit((db: Database.Database) => new WorkspaceStore(db), "create", {
    readonly: false,
  }),
  workspace_findById: storeUnit((db: Database.Database) => new WorkspaceStore(db), "findById", {
    readonly: true,
  }),
  workspace_findAll: storeUnit((db: Database.Database) => new WorkspaceStore(db), "findAll", {
    readonly: true,
  }),
  workspace_existsByPath: storeUnit(
    (db: Database.Database) => new WorkspaceStore(db),
    "existsByPath",
    { readonly: true },
  ),
  workspace_findByPath: storeUnit((db: Database.Database) => new WorkspaceStore(db), "findByPath", {
    readonly: true,
  }),
  workspace_updatePermissions: storeUnit(
    (db: Database.Database) => new WorkspaceStore(db),
    "updatePermissions",
    { readonly: false },
  ),
  workspace_updateLastUsedAt: storeUnit(
    (db: Database.Database) => new WorkspaceStore(db),
    "updateLastUsedAt",
    { readonly: false },
  ),
  workspace_updatePath: storeUnit((db: Database.Database) => new WorkspaceStore(db), "updatePath", {
    readonly: false,
  }),
  workspace_delete: storeUnit((db: Database.Database) => new WorkspaceStore(db), "delete", {
    readonly: false,
  }),
  workspace_upsertWithId: storeUnit(
    (db: Database.Database) => new WorkspaceStore(db),
    "upsertWithId",
    { readonly: false },
  ),
} satisfies UnitCatalog;
