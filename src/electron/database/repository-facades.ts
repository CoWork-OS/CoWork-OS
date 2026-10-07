import type { BotMessageStore } from "./bot-message-store";
import type { BotWorkResultStore } from "./bot-work-result-store";
import type { BotWorkStore } from "./bot-work-store";
import type { BotOutcomeMetricsStore } from "./bot-outcome-metrics-store";
import type Database from "better-sqlite3";
import { StatementPort } from "./statements/statement-port";
import { flushPendingTimelineTask } from "./timeline-write-registry";
import { storeFacade, type AsyncStore } from "./statements/store-units";
import { sealChannelConfig, unsealChannel } from "./repositories";
import type {
  AnnotationStore,
  ApprovalStore,
  ArtifactStore,
  AuditLogStore,
  BotNotificationPreferenceStore,
  Channel,
  ChannelMessageStore,
  ChannelSessionStore,
  ChannelSpecializationStore,
  ChannelStore,
  ChannelUserStore,
  ComparisonSessionStore,
  DeliveryTrackingStore,
  InputRequestStore,
  LLMModelStore,
  MemoryEmbeddingStore,
  MemorySettingsStore,
  MemoryStore,
  MessageQueueStore,
  PendingMemoryWriteStore,
  RateLimitStore,
  ScheduledMessageStore,
  SkillStore,
  TaskSessionMetadataStore,
  TaskEventRepository as TaskEventRepositoryStore,
  TaskStore,
  WorkspacePermissionRuleStore,
  WorkspaceStore,
  WorktreeInfoStore,
} from "./repositories";
import type {
  BrowserGitMutationReceiptStore,
  BrowserTaskCancelReceiptStore,
  TaskAdmissionStore,
} from "./browser-host-sql";
import type { ComposerDraftStore } from "./composer-draft-repository";
import type { TaskLabelStore } from "./TaskLabelRepository";
import type { DeviceProfileStore } from "./DeviceProfileRepository";
import type { WorkSessionProtocolRepository } from "./WorkSessionProtocolRepository";
import type { STORAGE_UNITS } from "./storage-units";

/**
 * Async facades for the storage layer's leaf repositories (async SQLite migration plan,
 * DB6, slice A). `new XRepository(db)` keeps its signature; every method runs one
 * storage-domain transaction unit over the synchronous `XStore`, in the database worker
 * when `COWORK_DB_WORKER_STORAGE` routes the storage domain there and on the host
 * connection otherwise. Code that already runs in the worker, or inside another store's
 * transaction, uses the store directly.
 */

export type StorageStatementPort = StatementPort<never, typeof STORAGE_UNITS>;

const ports = new WeakMap<Database.Database, StorageStatementPort>();

export function storageStatements(db: Database.Database): StorageStatementPort {
  let port = ports.get(db);
  if (!port) {
    port = new StatementPort(db, "storage", {});
    ports.set(db, port);
  }
  return port;
}

function repositoryFacade<S, K extends keyof S & string>(
  prefix: string,
  methods: readonly K[],
  // Host-side work around some methods, for state only the host holds.
  hooks?: (facade: AsyncStore<S, K>, db: Database.Database) => void,
): new (db: Database.Database) => AsyncStore<S, K> {
  return class {
    constructor(db: Database.Database) {
      const sql = storageStatements(db);
      const facade = storeFacade<S, K & never>(prefix, methods as never, (name, args) =>
        sql.unit(name as never, args as never),
      ) as AsyncStore<S, K>;
      hooks?.(facade, db);
      return facade;
    }
  } as unknown as new (db: Database.Database) => AsyncStore<S, K>;
}

const TASKSESSIONMETADATA_METHODS = [
  "findBySessionId",
  "findBySessionIds",
  "upsert",
  "rename",
  "archive",
  "unarchive",
  "delete",
] as const;
export type TaskSessionMetadataRepository = AsyncStore<
  TaskSessionMetadataStore,
  (typeof TASKSESSIONMETADATA_METHODS)[number]
>;
export const TaskSessionMetadataRepository = repositoryFacade<
  TaskSessionMetadataStore,
  (typeof TASKSESSIONMETADATA_METHODS)[number]
>("taskSessionMetadata_", TASKSESSIONMETADATA_METHODS);

const TASK_ADMISSION_METHODS = ["admit", "findByOperationKey"] as const;
export type TaskAdmissionRepository = AsyncStore<
  TaskAdmissionStore,
  (typeof TASK_ADMISSION_METHODS)[number]
>;
export const TaskAdmissionRepository = repositoryFacade<
  TaskAdmissionStore,
  (typeof TASK_ADMISSION_METHODS)[number]
>("taskAdmission_", TASK_ADMISSION_METHODS);

const BROWSER_TASK_CANCEL_RECEIPT_METHODS = ["reserve", "complete", "get"] as const;
export type BrowserTaskCancelReceiptRepository = AsyncStore<
  BrowserTaskCancelReceiptStore,
  (typeof BROWSER_TASK_CANCEL_RECEIPT_METHODS)[number]
>;
export const BrowserTaskCancelReceiptRepository = repositoryFacade<
  BrowserTaskCancelReceiptStore,
  (typeof BROWSER_TASK_CANCEL_RECEIPT_METHODS)[number]
>("browserTaskCancelReceipt_", BROWSER_TASK_CANCEL_RECEIPT_METHODS);

const BROWSER_GIT_MUTATION_RECEIPT_METHODS = ["reserve", "complete", "get"] as const;
export type BrowserGitMutationReceiptRepository = AsyncStore<
  BrowserGitMutationReceiptStore,
  (typeof BROWSER_GIT_MUTATION_RECEIPT_METHODS)[number]
>;
export const BrowserGitMutationReceiptRepository = repositoryFacade<
  BrowserGitMutationReceiptStore,
  (typeof BROWSER_GIT_MUTATION_RECEIPT_METHODS)[number]
>("browserGitMutationReceipt_", BROWSER_GIT_MUTATION_RECEIPT_METHODS);

const TASK_EVENT_REPLAY_METHODS = [
  "getCommittedMutationCursor",
  "findCommittedMutationPage",
  "findTimelinePage",
  "findEventDetailById",
  "findScopedTimelineSnapshot",
  "findScopedTimelineHistoryPage",
  "findScopedMutationPage",
  // Browser host "Memory used" per reply (hidden memory_used events with their replies).
  "findByTaskIdAndTypes",
] as const;
export type TaskEventReplayRepository = AsyncStore<
  TaskEventRepositoryStore,
  (typeof TASK_EVENT_REPLAY_METHODS)[number]
>;
export const TaskEventReplayRepository = repositoryFacade<
  TaskEventRepositoryStore,
  (typeof TASK_EVENT_REPLAY_METHODS)[number]
>("taskEvent_", TASK_EVENT_REPLAY_METHODS);

const BOTNOTIFICATIONPREFERENCE_METHODS = ["findByAgentRoleId", "upsert"] as const;
export type BotNotificationPreferenceRepository = AsyncStore<
  BotNotificationPreferenceStore,
  (typeof BOTNOTIFICATIONPREFERENCE_METHODS)[number]
>;
export const BotNotificationPreferenceRepository = repositoryFacade<
  BotNotificationPreferenceStore,
  (typeof BOTNOTIFICATIONPREFERENCE_METHODS)[number]
>("botNotificationPreference_", BOTNOTIFICATIONPREFERENCE_METHODS);

const ARTIFACT_METHODS = [
  "create",
  "findByTaskId",
  "findByTaskIdPage",
  "findById",
  "findLatestByPath",
] as const;
export type ArtifactRepository = AsyncStore<ArtifactStore, (typeof ARTIFACT_METHODS)[number]>;
export const ArtifactRepository = repositoryFacade<
  ArtifactStore,
  (typeof ARTIFACT_METHODS)[number]
>("artifact_", ARTIFACT_METHODS);

const ANNOTATION_METHODS = [
  "create",
  "update",
  "markAddressing",
  "markAddressed",
  "findById",
  "list",
  "listOpenByTask",
] as const;
export type AnnotationRepository = AsyncStore<AnnotationStore, (typeof ANNOTATION_METHODS)[number]>;
export const AnnotationRepository = repositoryFacade<
  AnnotationStore,
  (typeof ANNOTATION_METHODS)[number]
>("annotation_", ANNOTATION_METHODS);

const APPROVAL_METHODS = [
  "draftPreviews",
  "approvedRevisionCurrent",
  "resolvePending",
  "create",
  "update",
  "findById",
  "findPendingByTaskId",
  "findPending",
  "findAllPending",
] as const;
export type ApprovalRepository = AsyncStore<ApprovalStore, (typeof APPROVAL_METHODS)[number]>;
export const ApprovalRepository = repositoryFacade<
  ApprovalStore,
  (typeof APPROVAL_METHODS)[number]
>("approval_", APPROVAL_METHODS);

const WORKSPACEPERMISSIONRULE_METHODS = [
  "listByWorkspaceId",
  "findById",
  "create",
  "deleteById",
  "deleteByWorkspaceAndId",
] as const;
export type WorkspacePermissionRuleRepository = AsyncStore<
  WorkspacePermissionRuleStore,
  (typeof WORKSPACEPERMISSIONRULE_METHODS)[number]
>;
export const WorkspacePermissionRuleRepository = repositoryFacade<
  WorkspacePermissionRuleStore,
  (typeof WORKSPACEPERMISSIONRULE_METHODS)[number]
>("workspacePermissionRule_", WORKSPACEPERMISSIONRULE_METHODS);

const INPUTREQUEST_METHODS = [
  "create",
  "getApprovalBinding",
  "resolve",
  "findById",
  "findPendingByTaskId",
  "findAllPending",
  "list",
] as const;
export type InputRequestRepository = AsyncStore<
  InputRequestStore,
  (typeof INPUTREQUEST_METHODS)[number]
>;
export const InputRequestRepository = repositoryFacade<
  InputRequestStore,
  (typeof INPUTREQUEST_METHODS)[number]
>("inputRequest_", INPUTREQUEST_METHODS);

const SKILL_METHODS = ["create", "findAll", "findById"] as const;
export type SkillRepository = AsyncStore<SkillStore, (typeof SKILL_METHODS)[number]>;
export const SkillRepository = repositoryFacade<SkillStore, (typeof SKILL_METHODS)[number]>(
  "skill_",
  SKILL_METHODS,
);

const LLMMODEL_METHODS = ["findAll", "findByKey", "findById"] as const;
export type LLMModelRepository = AsyncStore<LLMModelStore, (typeof LLMMODEL_METHODS)[number]>;
export const LLMModelRepository = repositoryFacade<
  LLMModelStore,
  (typeof LLMMODEL_METHODS)[number]
>("lLMModel_", LLMMODEL_METHODS);

const CHANNELSPECIALIZATION_METHODS = [
  "upsert",
  "create",
  "update",
  "delete",
  "findById",
  "findByScope",
  "listByChannel",
  "resolve",
] as const;
export type ChannelSpecializationRepository = AsyncStore<
  ChannelSpecializationStore,
  (typeof CHANNELSPECIALIZATION_METHODS)[number]
>;
export const ChannelSpecializationRepository = repositoryFacade<
  ChannelSpecializationStore,
  (typeof CHANNELSPECIALIZATION_METHODS)[number]
>("channelSpecialization_", CHANNELSPECIALIZATION_METHODS);

const CHANNELMESSAGE_METHODS = [
  "create",
  "findBySessionId",
  "findByChatId",
  "deleteByChannelId",
  "getDistinctChatIds",
] as const;
export type ChannelMessageRepository = AsyncStore<
  ChannelMessageStore,
  (typeof CHANNELMESSAGE_METHODS)[number]
>;
export const ChannelMessageRepository = repositoryFacade<
  ChannelMessageStore,
  (typeof CHANNELMESSAGE_METHODS)[number]
>("channelMessage_", CHANNELMESSAGE_METHODS);

const MESSAGEQUEUE_METHODS = [
  "enqueue",
  "update",
  "findPending",
  "findById",
  "delete",
  "deleteOld",
] as const;
export type MessageQueueRepository = AsyncStore<
  MessageQueueStore,
  (typeof MESSAGEQUEUE_METHODS)[number]
>;
export const MessageQueueRepository = repositoryFacade<
  MessageQueueStore,
  (typeof MESSAGEQUEUE_METHODS)[number]
>("messageQueue_", MESSAGEQUEUE_METHODS);

const SCHEDULEDMESSAGE_METHODS = [
  "create",
  "update",
  "findDue",
  "findById",
  "findByChatId",
  "cancel",
  "delete",
] as const;
export type ScheduledMessageRepository = AsyncStore<
  ScheduledMessageStore,
  (typeof SCHEDULEDMESSAGE_METHODS)[number]
>;
export const ScheduledMessageRepository = repositoryFacade<
  ScheduledMessageStore,
  (typeof SCHEDULEDMESSAGE_METHODS)[number]
>("scheduledMessage_", SCHEDULEDMESSAGE_METHODS);

const DELIVERYTRACKING_METHODS = [
  "create",
  "update",
  "findByMessageId",
  "findByChatId",
  "deleteOld",
] as const;
export type DeliveryTrackingRepository = AsyncStore<
  DeliveryTrackingStore,
  (typeof DELIVERYTRACKING_METHODS)[number]
>;
export const DeliveryTrackingRepository = repositoryFacade<
  DeliveryTrackingStore,
  (typeof DELIVERYTRACKING_METHODS)[number]
>("deliveryTracking_", DELIVERYTRACKING_METHODS);

const RATELIMIT_METHODS = ["getOrCreate", "update", "resetWindow"] as const;
export type RateLimitRepository = AsyncStore<RateLimitStore, (typeof RATELIMIT_METHODS)[number]>;
export const RateLimitRepository = repositoryFacade<
  RateLimitStore,
  (typeof RATELIMIT_METHODS)[number]
>("rateLimit_", RATELIMIT_METHODS);

const AUDITLOG_METHODS = ["log", "find", "deleteOld"] as const;
export type AuditLogRepository = AsyncStore<AuditLogStore, (typeof AUDITLOG_METHODS)[number]>;
export const AuditLogRepository = repositoryFacade<
  AuditLogStore,
  (typeof AUDITLOG_METHODS)[number]
>("auditLog_", AUDITLOG_METHODS);

const MEMORYSETTINGS_METHODS = ["getOrCreate", "update", "delete"] as const;
export type MemorySettingsRepository = AsyncStore<
  MemorySettingsStore,
  (typeof MEMORYSETTINGS_METHODS)[number]
>;
export const MemorySettingsRepository = repositoryFacade<
  MemorySettingsStore,
  (typeof MEMORYSETTINGS_METHODS)[number]
>("memorySettings_", MEMORYSETTINGS_METHODS);

const PENDINGMEMORYWRITE_METHODS = [
  "create",
  "findById",
  "list",
  "countPending",
  "updateStatus",
  "updateStatusIfCurrent",
  "rejectPending",
] as const;
export type PendingMemoryWriteRepository = AsyncStore<
  PendingMemoryWriteStore,
  (typeof PENDINGMEMORYWRITE_METHODS)[number]
>;
export const PendingMemoryWriteRepository = repositoryFacade<
  PendingMemoryWriteStore,
  (typeof PENDINGMEMORYWRITE_METHODS)[number]
>("pendingMemoryWrite_", PENDINGMEMORYWRITE_METHODS);

const WORKTREEINFO_METHODS = [
  "create",
  "findByTaskId",
  "findByWorkspaceId",
  "update",
  "delete",
] as const;
export type WorktreeInfoRepository = AsyncStore<
  WorktreeInfoStore,
  (typeof WORKTREEINFO_METHODS)[number]
>;
export const WorktreeInfoRepository = repositoryFacade<
  WorktreeInfoStore,
  (typeof WORKTREEINFO_METHODS)[number]
>("worktreeInfo_", WORKTREEINFO_METHODS);

const COMPARISONSESSION_METHODS = [
  "create",
  "findById",
  "findByWorkspaceId",
  "update",
  "delete",
  "syncTaskIdsFromTasks",
] as const;
export type ComparisonSessionRepository = AsyncStore<
  ComparisonSessionStore,
  (typeof COMPARISONSESSION_METHODS)[number]
>;
export const ComparisonSessionRepository = repositoryFacade<
  ComparisonSessionStore,
  (typeof COMPARISONSESSION_METHODS)[number]
>("comparisonSession_", COMPARISONSESSION_METHODS);

const COMPOSERDRAFT_METHODS = [
  "get",
  "upsertIfNewer",
  "clear",
  "rekey",
  "canRekey",
  "pruneExpired",
  "listExpired",
  "listLiveAttachmentRefs",
] as const;
export type ComposerDraftRepository = AsyncStore<
  ComposerDraftStore,
  (typeof COMPOSERDRAFT_METHODS)[number]
>;
export const ComposerDraftRepository = repositoryFacade<
  ComposerDraftStore,
  (typeof COMPOSERDRAFT_METHODS)[number]
>("composerDraft_", COMPOSERDRAFT_METHODS);

const TASKLABEL_METHODS = [
  "create",
  "findById",
  "findByName",
  "list",
  "update",
  "delete",
  "deleteByWorkspace",
  "getByIds",
] as const;
export type TaskLabelRepository = AsyncStore<TaskLabelStore, (typeof TASKLABEL_METHODS)[number]>;
export const TaskLabelRepository = repositoryFacade<
  TaskLabelStore,
  (typeof TASKLABEL_METHODS)[number]
>("taskLabel_", TASKLABEL_METHODS);

const DEVICEPROFILE_METHODS = [
  "upsert",
  "get",
  "list",
  "updateCustomName",
  "updateLastSeen",
] as const;
export type DeviceProfileRepository = AsyncStore<
  DeviceProfileStore,
  (typeof DEVICEPROFILE_METHODS)[number]
>;
export const DeviceProfileRepository = repositoryFacade<
  DeviceProfileStore,
  (typeof DEVICEPROFILE_METHODS)[number]
>("deviceProfile_", DEVICEPROFILE_METHODS);

/**
 * Channels keep their config encrypted with OS secure storage, which only the host can
 * reach. The units store and return the encrypted value sealed; this facade seals config
 * before a write and unseals channels after a read.
 */
export class ChannelRepository {
  private readonly sql: StorageStatementPort;

  constructor(db: Database.Database) {
    this.sql = storageStatements(db);
  }

  async create(channel: Parameters<ChannelStore["create"]>[0]): Promise<Channel> {
    const created = await this.sql.unit("channel_create", [
      { ...channel, config: sealChannelConfig(channel.config) },
    ]);
    return { ...created, config: channel.config };
  }

  async createIfTypeAbsent(
    channel: Parameters<ChannelStore["createIfTypeAbsent"]>[0],
  ): Promise<Channel | undefined> {
    const created = await this.sql.unit("channel_createIfTypeAbsent", [
      { ...channel, config: sealChannelConfig(channel.config) },
    ]);
    return created ? { ...created, config: channel.config } : undefined;
  }

  async update(id: string, updates: Partial<Channel>): Promise<void> {
    if (updates.config === undefined) {
      await this.sql.unit("channel_update", [id, updates]);
      return;
    }
    const existing = await this.findById(id);
    if (existing?.configReadError) throw new Error(existing.configReadError);
    await this.sql.unit("channel_update", [
      id,
      { ...updates, config: sealChannelConfig(updates.config) },
    ]);
  }

  async findById(id: string): Promise<Channel | undefined> {
    const channel = await this.sql.unit("channel_findById", [id]);
    return channel ? unsealChannel(channel) : undefined;
  }

  async findByType(type: string): Promise<Channel | undefined> {
    const channel = await this.sql.unit("channel_findByType", [type]);
    return channel ? unsealChannel(channel) : undefined;
  }

  async findAllByType(type: string): Promise<Channel[]> {
    return (await this.sql.unit("channel_findAllByType", [type])).map(unsealChannel);
  }

  async findAll(): Promise<Channel[]> {
    return (await this.sql.unit("channel_findAll", [])).map(unsealChannel);
  }

  async findEnabled(): Promise<Channel[]> {
    return (await this.sql.unit("channel_findEnabled", [])).map(unsealChannel);
  }

  async delete(id: string): Promise<void> {
    await this.sql.unit("channel_delete", [id]);
  }
}

const CHANNELUSER_METHODS = [
  "findOrCreateByChannelUser",
  "create",
  "update",
  "findById",
  "findByChannelUserId",
  "findByChannelId",
  "findAllowedByChannelId",
  "deleteByChannelId",
  "delete",
  "deleteExpiredPending",
  "deletePendingByChannel",
  "deleteExpiredPendingAll",
  "findByPairingCode",
] as const;
export type ChannelUserRepository = AsyncStore<
  ChannelUserStore,
  (typeof CHANNELUSER_METHODS)[number]
>;
export const ChannelUserRepository = repositoryFacade<
  ChannelUserStore,
  (typeof CHANNELUSER_METHODS)[number]
>("channelUser_", CHANNELUSER_METHODS);

const CHANNELSESSION_METHODS = [
  "findOrCreateByChat",
  "create",
  "update",
  "findById",
  "findByChatId",
  "findByTaskId",
  "findActiveByChannelId",
  "deleteIdleOlderThan",
  "deleteByChannelId",
] as const;
export type ChannelSessionRepository = AsyncStore<
  ChannelSessionStore,
  (typeof CHANNELSESSION_METHODS)[number]
>;
export const ChannelSessionRepository = repositoryFacade<
  ChannelSessionStore,
  (typeof CHANNELSESSION_METHODS)[number]
>("channelSession_", CHANNELSESSION_METHODS);

const MEMORY_METHODS = [
  "insertCaptured",
  "create",
  "update",
  "findById",
  "findByIds",
  "search",
  "searchImportedGlobal",
  "searchLocalForPromptRecall",
  "searchByContentMarker",
  "getTimelineContext",
  "getFullDetails",
  "getRecentForWorkspace",
  "getRecentImportedGlobal",
  "getUncompressed",
  "listWorkspaceIds",
  "getApproxStorageBytes",
  "getOldestForWorkspace",
  "deleteByIds",
  "findByWorkspace",
  "findByTask",
  "deleteOlderThan",
  "deleteByWorkspace",
  "deleteByWorkspaceAndId",
  "getStats",
  "getImportedStats",
  "findImported",
  "deleteImported",
] as const;
export type MemoryRepository = AsyncStore<MemoryStore, (typeof MEMORY_METHODS)[number]>;
export const MemoryRepository = repositoryFacade<MemoryStore, (typeof MEMORY_METHODS)[number]>(
  "memory_",
  MEMORY_METHODS,
);

const MEMORYEMBEDDING_METHODS = [
  "upsert",
  "upsertBackfillBatch",
  "getByWorkspace",
  "getStats",
  "findMissingOrStale",
  "getImportedGlobal",
  "findMissingOrStaleImportedGlobal",
  "deleteByWorkspace",
  "deleteByMemoryIds",
  "deleteImported",
] as const;
export type MemoryEmbeddingRepository = AsyncStore<
  MemoryEmbeddingStore,
  (typeof MEMORYEMBEDDING_METHODS)[number]
>;
export const MemoryEmbeddingRepository = repositoryFacade<
  MemoryEmbeddingStore,
  (typeof MEMORYEMBEDDING_METHODS)[number]
>("memoryEmbedding_", MEMORYEMBEDDING_METHODS);

/**
 * Host-only reads of the canonical work-session stream. The repository itself stays a
 * synchronous store: the session services share it on the host and in the worker.
 */
const WORKSESSIONPROTOCOL_READ_METHODS = ["findSessionIdForTask", "listAllItems"] as const;
export type WorkSessionProtocolReader = AsyncStore<
  WorkSessionProtocolRepository,
  (typeof WORKSESSIONPROTOCOL_READ_METHODS)[number]
>;
export const WorkSessionProtocolReader = repositoryFacade<
  WorkSessionProtocolRepository,
  (typeof WORKSESSIONPROTOCOL_READ_METHODS)[number]
>("workSessionProtocol_", WORKSESSIONPROTOCOL_READ_METHODS);

const TASK_METHODS = [
  "create",
  "update",
  "togglePin",
  "touch",
  "findById",
  "findAll",
  "findBotConversations",
  "search",
  "findSidebarSummaries",
  "findByStatus",
  "findByWorkspace",
  "findByScheduledRun",
  "findBySessionId",
  "countByWorkspace",
  "findByCreatedAtRange",
  "searchByTerms",
  "delete",
  "findByTargetNodeId",
  "findByTargetNodeIds",
  "pruneByTargetNodeIds",
  "findByParent",
  "findIdsByCompany",
  "findByBoardColumn",
  "getTaskBoard",
  "moveToColumn",
  "setPriority",
  "setDueDate",
  "setEstimate",
  "addLabel",
  "removeLabel",
  "assignAgentRole",
] as const;
export type TaskRepository = AsyncStore<TaskStore, (typeof TASK_METHODS)[number]>;
export const TaskRepository = repositoryFacade<TaskStore, (typeof TASK_METHODS)[number]>(
  "task_",
  TASK_METHODS,
  (facade, db) => {
    const remove = facade.delete;
    // Commit the host timeline writer's pending rows for the task first, so none arrive
    // after the unit deletes it (the store does this itself when it runs on the host).
    facade.delete = async (id) => {
      flushPendingTimelineTask(db, id);
      return remove(id);
    };
  },
);

const WORKSPACE_METHODS = [
  "create",
  "findById",
  "findAll",
  "existsByPath",
  "findByPath",
  "updatePermissions",
  "updateLastUsedAt",
  "updatePath",
  "delete",
  "upsertWithId",
] as const;
export type WorkspaceRepository = AsyncStore<WorkspaceStore, (typeof WORKSPACE_METHODS)[number]>;
export const WorkspaceRepository = repositoryFacade<
  WorkspaceStore,
  (typeof WORKSPACE_METHODS)[number]
>("workspace_", WORKSPACE_METHODS);

/** A bot's chat history, a page of messages at a time, read in the database worker. */
export type BotMessageRepository = AsyncStore<BotMessageStore, "findPage">;
export const BotMessageRepository = repositoryFacade<BotMessageStore, "findPage">("botMessage_", [
  "findPage",
]);
export type BotWorkRepository = AsyncStore<BotWorkStore, "list">;
export const BotWorkRepository = repositoryFacade<BotWorkStore, "list">("botWork_", ["list"]);
export type BotOutcomeMetricsRepository = AsyncStore<BotOutcomeMetricsStore, "summary">;
export const BotOutcomeMetricsRepository = repositoryFacade<BotOutcomeMetricsStore, "summary">(
  "botOutcomeMetrics_",
  ["summary"],
);

export type BotWorkResultRepository = AsyncStore<BotWorkResultStore, "manifest">;
export const BotWorkResultRepository = repositoryFacade<BotWorkResultStore, "manifest">(
  "botWorkResult_",
  ["manifest"],
);
