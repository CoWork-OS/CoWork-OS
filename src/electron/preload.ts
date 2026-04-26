import * as path from "path";
import { contextBridge, ipcRenderer } from "electron";
import * as fs from "fs";
import * as os from "os";
import { randomBytes } from "crypto";
import { IPC_CHANNELS as SHARED_IPC_CHANNELS } from "../shared/types";
import type {
  ApplyOnboardingProfileRequest,
  ApplyOnboardingProfileResult,
} from "../shared/onboarding";
import type {
  AgentTeam,
  AgentTeamItem,
  AgentTeamMember,
  AgentTeamRun,
  AgentThought,
  AgentWorkspaceMembership,
  AgentWorkspacePermissionSnapshot,
  AgentPerformanceReview,
  AgentReviewGenerateRequest,
  AgentTemplate,
  AppProfileSummary,
  AudioSummaryConfig,
  AudioSummaryResult,
  ProfileExportResult,
  EvalBaselineMetrics,
  EvalCase,
  EvalRun,
  EvalSuite,
  InfraSettings,
  InfraStatus,
  ImprovementCampaign,
  ImprovementCandidate,
  ImprovementEligibility,
  ImprovementHistoryResetResult,
  ImprovementLoopSettings,
  WalletInfo,
  CreateAgentTeamItemRequest,
  CreateAgentTeamMemberRequest,
  CreateAgentTeamRequest,
  CreateAgentTeamRunRequest,
  CreateManagedAgentRoutineRequest,
  CoreEvalCase,
  CoreFailureCluster,
  CoreFailureRecord,
  CoreHarnessExperiment,
  CoreLearningsEntry,
  CoreMemoryCandidate,
  CoreMemoryDistillRun,
  CoreTrace,
  TaskTraceRunDetail,
  TaskTraceRunSummary,
  GetCoreTraceResult,
  ImageAttachment,
  LLMProviderType,
  ManagedAgentAuditEntry,
  ManagedAgentConversionResult,
  ManagedAgentInsights,
  ManagedAgentRoutineRecord,
  ManagedAgentSlackDeploymentHealth,
  ImageGenProfile,
  MemoryFeaturesSettings,
  MemoryLayerPreviewPayload,
  ManagedAgent,
  ManagedAgentRuntimeToolCatalog,
  ManagedAgentVersion,
  ManagedEnvironment,
  ManagedSession,
  ManagedSessionCreateInput,
  ManagedSessionEvent,
  ManagedSessionWorkpaper,
  UpdateManagedAgentRoutineRequest,
  ConvertAgentRoleToManagedAgentRequest,
  ConvertAutomationProfileToManagedAgentRequest,
  SupermemoryConfigStatus,
  SupermemorySettings,
  WorkspaceKitInitRequest,
  WorkspaceKitProjectCreateRequest,
  WorkspaceKitStatus,
  UpdateAgentTeamItemRequest,
  UpdateAgentTeamMemberRequest,
  UpdateAgentTeamRequest,
  AddChannelRequest,
  DocumentEditRequest,
  DocumentEditorSession,
  DocumentVersionEntry,
  ApprovalResponse,
  InputRequest,
  InputRequestResponse,
  QuotedAssistantMessage,
  Workspace,
  GuardrailSettings,
  PersistedPermissionRule,
  PermissionSettingsData,
  CouncilConfig,
  CouncilMemo,
  CouncilRun,
  CreateCouncilConfigRequest,
  UpdateCouncilConfigRequest,
  PdfReviewSummary,
  TaskLearningProgress,
  UnifiedRecallResponse,
  UnifiedRecallSourceType,
  ChronicleSettings,
  ChronicleCaptureStatus,
  ChronicleResolvedContext,
  ShellSessionInfo,
  ShellSessionLifecycleEvent,
  LLMRoutingRuntimeState,
  SupervisorExchange,
  SupervisorExchangeEvent,
  SupervisorExchangeStatus,
  AgentMailApiKeySummary,
  AgentMailConnectionTestResult,
  AgentMailDomain,
  AgentMailInbox,
  AgentMailListEntry,
  AgentMailPod,
  AgentMailSettingsData,
  AgentMailStatus,
  AgentMailWorkspaceBinding,
} from "../shared/types";
import type {
  SubconsciousBrainSummary,
  SubconsciousHistoryResetResult,
  SubconsciousRefreshResult,
  SubconsciousRun,
  SubconsciousSettings,
  SubconsciousTargetDetail,
  SubconsciousTargetSummary,
} from "../shared/subconscious";
import type {
  HealthDashboard,
  HealthSource,
  HealthSourceInput,
  HealthSyncResult,
  HealthWorkflow,
  HealthWorkflowRequest,
  HealthWritebackPreview,
  HealthWritebackRequest,
  HealthSourceConnectionMode,
} from "../shared/health";
import type {
  ChannelPreferenceSummary,
  ContactIdentity,
  ContactIdentityCandidate,
  ContactIdentityCoverageStats,
  ContactIdentityResolution,
  ContactIdentityReplyTarget,
  ContactIdentitySearchResult,
  MailboxApplyActionInput,
  MailboxAskInput,
  MailboxAskResult,
  MailboxAttachmentRecord,
  MailboxAutomationRecord,
  MailboxAutomationStatus,
  MailboxClientState,
  MailboxComposeDraft,
  MailboxComposeDraftInput,
  MailboxComposeDraftPatch,
  MailboxForwardRecipe,
  MailboxRuleRecipe,
  MailboxScheduleRecipe,
  MailboxBulkReviewResult,
  MailboxCommitment,
  MailboxCommitmentState,
  MailboxDigestSnapshot,
  MailboxDraftOptions,
  MailboxDraftSuggestion,
  MailboxEvent,
  MailboxListThreadsInput,
  MailboxMissionControlHandoffPreview,
  MailboxMissionControlHandoffRecord,
  MailboxMissionControlHandoffRequest,
  MailboxQuickReplySuggestionsResult,
  MailboxOutgoingMessage,
  MailboxQueuedAction,
  MailboxSavedViewPreviewResult,
  MailboxSavedViewRecord,
  MailboxSnippetRecord,
  MailboxReclassifyInput,
  MailboxReclassifyResult,
  MailboxResearchResult,
  MailboxSummaryCard,
  MailboxSyncResult,
  MailboxSyncStatus,
  MailboxSenderCleanupDigest,
  MailboxThreadDetail,
  MailboxThreadListItem,
  MailboxTodayDigest,
  RelationshipTimelineEvent,
  RelationshipTimelineQuery,
} from "../shared/mailbox";
import type { UiTimelineEvent } from "../shared/timeline-events";

const ALLOWED_MESSAGE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
const ALLOWED_IMAGE_FILE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const MAX_IMAGES_PER_MESSAGE = 5;
const MAX_TOTAL_TASK_IMAGE_BYTES = 125 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MANAGED_IMAGE_TEMP_PREFIX = "cowork-image-";
const MIME_TYPE_EXTENSION_MAP: Record<string, string> = {
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/gif": ".gif",
  "image/webp": ".webp",
};

const isManagedImageTempFile = (filePath: string): boolean => {
  if (!path.isAbsolute(filePath)) {
    return false;
  }

  const normalizedDir = path.normalize(os.tmpdir());
  const normalizedTarget = path.normalize(filePath);
  const tmpPrefix = normalizedDir.endsWith(path.sep)
    ? normalizedDir
    : `${normalizedDir}${path.sep}`;
  if (!normalizedTarget.startsWith(tmpPrefix)) {
    return false;
  }

  return path.basename(filePath).startsWith(MANAGED_IMAGE_TEMP_PREFIX);
};

const deleteTempFiles = (paths: string[]): void => {
  for (const filePath of paths) {
    if (!isManagedImageTempFile(filePath)) {
      continue;
    }
    try {
      fs.unlinkSync(filePath);
    } catch {
      // Best-effort cleanup.
    }
  }
};

const normalizeAttachmentName = (value: unknown): string => {
  const base = typeof value === "string" ? value.trim() : "";
  if (!base) {
    return "image";
  }
  const noExt = path.parse(base).name;
  const sanitized = noExt
    .replace(/[^\w.-]/g, "_")
    .replace(/_+/g, "_")
    .replace(/^\.+|\.{2,}/g, "_")
    .slice(0, 80);
  return sanitized || "image";
};

const writeBase64ImageToTempFile = (
  imageData: string,
  mimeType: string,
  filename?: string,
): string => {
  const extension = MIME_TYPE_EXTENSION_MAP[mimeType] || ".img";
  const safeName = normalizeAttachmentName(filename);
  const random = randomBytes(12).toString("hex");
  const fileName = `${MANAGED_IMAGE_TEMP_PREFIX}${safeName}-${random}${extension}`;
  const filePath = path.join(os.tmpdir(), fileName);
  const buffer = Buffer.from(imageData, "base64");
  if (!buffer.length) {
    throw new Error("Image data could not be decoded.");
  }
  if (buffer.length > MAX_IMAGE_ATTACHMENT_BYTES) {
    throw new Error("Image attachment exceeds maximum size.");
  }
  fs.writeFileSync(filePath, buffer, { mode: 0o600 });
  return filePath;
};

const isAbsoluteImagePath = (value: unknown): value is string =>
  typeof value === "string" && value.trim().length > 0;

function validateSendMessageAttachments(images?: ImageAttachment[]): ImageAttachment[] | undefined {
  if (images === undefined) {
    return undefined;
  }

  if (!Array.isArray(images)) {
    throw new Error("Invalid images payload. Must be an array.");
  }

  if (images.length > MAX_IMAGES_PER_MESSAGE) {
    throw new Error(`Too many image attachments. Maximum allowed is ${MAX_IMAGES_PER_MESSAGE}.`);
  }

  let totalBytes = 0;
  const createdTempFiles: string[] = [];

  try {
    return images.map((image, index) => {
      if (!image || typeof image !== "object") {
        throw new Error(`Invalid image attachment at index ${index}.`);
      }

      const mimeType = image.mimeType;
      if (!ALLOWED_MESSAGE_IMAGE_TYPES.includes(mimeType)) {
        throw new Error(
          `Image attachment at index ${index} has unsupported mime type: ${String(mimeType)}.`,
        );
      }

      const hasData = typeof image.data === "string" && image.data.trim().length > 0;
      const hasFilePath = isAbsoluteImagePath(image.filePath);
      if (hasData === hasFilePath) {
        throw new Error(
          `Image attachment at index ${index} must provide exactly one of data or filePath.`,
        );
      }

      let data: string | undefined;
      let filePath: string | undefined;
      let resolvedFileSize: number | undefined;
      if (hasFilePath && image.filePath) {
        if (!path.isAbsolute(image.filePath)) {
          throw new Error(`Image attachment at index ${index} filePath must be an absolute path.`);
        }
        const extension = path.extname(image.filePath).toLowerCase();
        if (!ALLOWED_IMAGE_FILE_EXTENSIONS.has(extension)) {
          throw new Error(
            `Image attachment at index ${index} has unsupported file extension: ${extension}.`,
          );
        }
        let stat: fs.Stats;
        try {
          stat = fs.statSync(image.filePath);
        } catch (error) {
          throw new Error(
            `Image attachment at index ${index} filePath could not be read: ${String((error as Error).message)}`,
          );
        }
        if (!stat.isFile()) {
          throw new Error(
            `Image attachment at index ${index} filePath must point to a regular file.`,
          );
        }
        if (
          stat.size === 0 ||
          !Number.isInteger(stat.size) ||
          stat.size <= 0 ||
          stat.size > MAX_IMAGE_ATTACHMENT_BYTES
        ) {
          throw new Error(`Image attachment at index ${index} file size is invalid.`);
        }
        resolvedFileSize = stat.size;
        filePath = image.filePath;
      } else {
        data = image.data as string;
        const tempFile = writeBase64ImageToTempFile(data, mimeType, image.filename);
        createdTempFiles.push(tempFile);
        filePath = tempFile;
        data = undefined;
      }

      const sizeBytes = Number(image.sizeBytes);
      if (hasFilePath && typeof resolvedFileSize === "number" && sizeBytes !== resolvedFileSize) {
        throw new Error(`Image attachment at index ${index} sizeBytes must match attachment size.`);
      }
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || !Number.isInteger(sizeBytes)) {
        throw new Error(`Image attachment at index ${index} has invalid sizeBytes.`);
      }
      if (sizeBytes > MAX_IMAGE_ATTACHMENT_BYTES) {
        throw new Error(
          `Image attachment at index ${index} exceeds ${MAX_IMAGE_ATTACHMENT_BYTES} bytes.`,
        );
      }

      totalBytes += sizeBytes;
      if (totalBytes > MAX_TOTAL_TASK_IMAGE_BYTES) {
        throw new Error("Total image payload exceeds 125MB limit.");
      }

      return {
        data,
        filePath,
        tempFile: hasData ? true : false,
        mimeType,
        sizeBytes,
        filename: image.filename,
      };
    });
  } catch (error) {
    deleteTempFiles(createdTempFiles);
    throw error;
  }
}

const IPC_CHANNELS = SHARED_IPC_CHANNELS;
/*
 * Legacy mirrored channel list retained temporarily to minimize churn in this
 * large file while runtime now sources channel names from shared/types.
 */
const LEGACY_IPC_CHANNELS_MIRROR = IPC_CHANNELS;
void LEGACY_IPC_CHANNELS_MIRROR;

// Mobile Companion Node types (inlined for sandboxed preload)
type NodePlatform = "ios" | "android" | "macos";
type NodeCapabilityType = "camera" | "location" | "screen" | "sms" | "voice" | "canvas" | "system";

interface NodeInfo {
  id: string;
  displayName: string;
  platform: NodePlatform;
  version: string;
  deviceId?: string;
  modelIdentifier?: string;
  capabilities: NodeCapabilityType[];
  commands: string[];
  permissions: Record<string, boolean>;
  connectedAt: number;
  lastActivityAt: number;
  isForeground?: boolean;
}

interface NodeEvent {
  type: "connected" | "disconnected" | "capabilities_changed" | "foreground_changed";
  nodeId: string;
  node?: NodeInfo;
  timestamp: number;
}

// Custom Skill types (inlined for sandboxed preload)
interface SkillParameter {
  name: string;
  type: "string" | "number" | "boolean" | "select";
  description: string;
  required?: boolean;
  default?: string | number | boolean;
  options?: string[];
}

type SkillSource = "bundled" | "managed" | "external" | "workspace";

interface SkillRequirements {
  tools?: string[];
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  config?: string[];
  os?: ("darwin" | "linux" | "win32")[];
}

interface SkillMetadata {
  version?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  tags?: string[];
  primaryEnv?: string;
}

interface CustomSkill {
  id: string;
  name: string;
  description: string;
  icon: string;
  prompt: string;
  parameters?: SkillParameter[];
  category?: string;
  enabled?: boolean;
  filePath?: string;
  source?: SkillSource;
  requires?: SkillRequirements;
  metadata?: SkillMetadata;
}

// Skill Registry types (inlined for sandboxed preload)
interface SkillRegistryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  source?: "cowork" | "clawhub";
  author?: string;
  downloads?: number;
  rating?: number;
  tags?: string[];
  icon?: string;
  category?: string;
  updatedAt?: string;
  homepage?: string;
}

interface SkillSearchResult {
  query: string;
  total: number;
  page: number;
  pageSize: number;
  results: SkillRegistryEntry[];
}

interface SkillStatusEntry extends CustomSkill {
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  requirements: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
}

interface SkillStatusReport {
  workspaceDir: string;
  managedSkillsDir: string;
  bundledSkillsDir: string;
  externalSkillDirs: string[];
  skills: SkillStatusEntry[];
  summary: {
    total: number;
    eligible: number;
    disabled: number;
    missingRequirements: number;
  };
}

interface SkillsConfig {
  skillsDirectory: string;
  externalSkillDirectories?: string[];
  enabledSkillIds: string[];
  registryUrl?: string;
  autoUpdate?: boolean;
  allowlist?: string[];
  denylist?: string[];
}

// MCP types (inlined for sandboxed preload)
type MCPTransportType = "stdio" | "sse" | "websocket";
type MCPConnectionStatus = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

interface MCPServerConfig {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  transport: MCPTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  connectionTimeout?: number;
  requestTimeout?: number;
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, Any>;
    required?: string[];
  };
}

interface MCPServerStatus {
  id: string;
  name: string;
  status: MCPConnectionStatus;
  error?: string;
  tools: MCPTool[];
  lastPing?: number;
}

interface MCPSettings {
  servers: MCPServerConfig[];
  autoConnect: boolean;
  toolNamePrefix: string;
  maxReconnectAttempts: number;
  reconnectDelayMs: number;
  registryEnabled: boolean;
  registryUrl?: string;
  hostEnabled: boolean;
  hostPort?: number;
}

interface MCPRegistryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  installMethod: "npm" | "pip" | "binary" | "docker";
  installCommand?: string;
  transport: MCPTransportType;
  defaultCommand?: string;
  tools: Array<{ name: string; description: string }>;
  tags: string[];
  verified: boolean;
}

interface MCPRegistry {
  version: string;
  lastUpdated: string;
  servers: MCPRegistryEntry[];
}

interface MCPUpdateInfo {
  serverId: string;
  currentVersion: string;
  latestVersion: string;
  registryEntry: MCPRegistryEntry;
}

// Canvas types (inlined for sandboxed preload)
type CanvasSessionStatus = "active" | "paused" | "closed";

interface CanvasSession {
  id: string;
  taskId: string;
  workspaceId: string;
  sessionDir: string;
  status: CanvasSessionStatus;
  title?: string;
  createdAt: number;
  lastUpdatedAt: number;
}

interface CanvasA2UIAction {
  actionName: string;
  sessionId: string;
  componentId?: string;
  context?: Record<string, unknown>;
  timestamp: number;
}

interface CanvasEvent {
  type:
    | "session_created"
    | "session_updated"
    | "session_closed"
    | "content_pushed"
    | "a2ui_action"
    | "window_opened"
    | "console_message"
    | "checkpoint_saved"
    | "checkpoint_restored";
  sessionId: string;
  taskId: string;
  session?: CanvasSession;
  action?: CanvasA2UIAction;
  console?: {
    level: "log" | "warn" | "error" | "info";
    message: string;
  };
  timestamp: number;
}

// Built-in Tools Settings types (inlined for sandboxed preload)
interface ToolCategoryConfig {
  enabled: boolean;
  priority: "high" | "normal" | "low";
  description?: string;
}

interface BuiltinToolsSettings {
  categories: {
    code: ToolCategoryConfig;
    webfetch: ToolCategoryConfig;
    browser: ToolCategoryConfig;
    search: ToolCategoryConfig;
    system: ToolCategoryConfig;
    file: ToolCategoryConfig;
    skill: ToolCategoryConfig;
    shell: ToolCategoryConfig;
    image: ToolCategoryConfig;
    chronicle: ToolCategoryConfig;
    computer_use: ToolCategoryConfig;
  };
  toolOverrides: Record<string, { enabled: boolean; priority?: "high" | "normal" | "low" }>;
  toolTimeouts: Record<string, number>;
  toolAutoApprove: Record<string, boolean>;
  runCommandApprovalMode: "per_command" | "single_bundle";
  codexRuntimeMode: "native" | "acpx";
  version: string;
}

// Tray (Menu Bar) Settings (inlined for sandboxed preload)
interface TraySettings {
  enabled: boolean;
  showDockIcon: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  showNotifications: boolean;
  showApprovalSavedNotifications: boolean;
}

// Cron (Scheduled Tasks) Types (inlined for sandboxed preload)
type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

type CronJobStatus =
  | "ok"
  | "partial_success"
  | "needs_user_action"
  | "error"
  | "skipped"
  | "timeout";
type CronDeliveryMode = "direct" | "outbox";
type CronDeliverableStatus = "none" | "queued" | "sent" | "dead_letter";

interface CronRunHistoryEntry {
  runAtMs: number;
  durationMs: number;
  status: CronJobStatus;
  error?: string;
  taskId?: string;
  deliveryMode?: CronDeliveryMode;
  deliveryAttempts?: number;
  deliverableStatus?: CronDeliverableStatus;
}

interface CronJobState {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: CronJobStatus;
  lastError?: string;
  lastDurationMs?: number;
  lastTaskId?: string;
  runHistory?: CronRunHistoryEntry[];
  totalRuns?: number;
  successfulRuns?: number;
  failedRuns?: number;
}

interface CronDeliveryConfig {
  enabled: boolean;
  channelType?:
    | "telegram"
    | "discord"
    | "slack"
    | "whatsapp"
    | "imessage"
    | "signal"
    | "mattermost"
    | "matrix"
    | "twitch"
    | "line"
    | "bluebubbles"
    | "email"
    | "teams"
    | "googlechat"
    | "x";
  channelId?: string;
  deliverOnSuccess?: boolean;
  deliverOnError?: boolean;
  summaryOnly?: boolean;
}

interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  shellAccess?: boolean;
  allowUserInput?: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  workspaceId: string;
  taskPrompt: string;
  taskTitle?: string;
  timeoutMs?: number;
  modelKey?: string;
  maxHistoryEntries?: number;
  delivery?: CronDeliveryConfig;
  state: CronJobState;
}

interface CronJobCreate {
  name: string;
  description?: string;
  enabled: boolean;
  shellAccess?: boolean;
  allowUserInput?: boolean;
  deleteAfterRun?: boolean;
  schedule: CronSchedule;
  workspaceId: string;
  taskPrompt: string;
  taskTitle?: string;
  timeoutMs?: number;
  modelKey?: string;
  maxHistoryEntries?: number;
  delivery?: CronDeliveryConfig;
}

interface CronJobPatch {
  name?: string;
  description?: string;
  enabled?: boolean;
  shellAccess?: boolean;
  allowUserInput?: boolean;
  deleteAfterRun?: boolean;
  schedule?: CronSchedule;
  workspaceId?: string;
  taskPrompt?: string;
  taskTitle?: string;
  timeoutMs?: number;
  modelKey?: string;
  maxHistoryEntries?: number;
  delivery?: CronDeliveryConfig;
}

interface CronRunHistoryResult {
  jobId: string;
  jobName: string;
  entries: CronRunHistoryEntry[];
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
}

interface CronWebhookStatus {
  enabled: boolean;
  host?: string;
  port?: number;
}

interface CronStatusSummary {
  enabled: boolean;
  storePath: string;
  jobCount: number;
  enabledJobCount: number;
  runningJobCount: number;
  maxConcurrentRuns: number;
  nextWakeAtMs: number | null;
  webhook?: CronWebhookStatus;
}

interface CronEvent {
  jobId: string;
  action: "added" | "updated" | "removed" | "started" | "finished";
  runAtMs?: number;
  durationMs?: number;
  status?: CronJobStatus;
  error?: string;
  taskId?: string;
  nextRunAtMs?: number;
}

// Notification Types (inlined for sandboxed preload)
type NotificationType =
  | "task_completed"
  | "task_failed"
  | "scheduled_task"
  | "input_required"
  | "companion_suggestion"
  | "info"
  | "warning"
  | "error";

interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  read: boolean;
  createdAt: number;
  taskId?: string;
  cronJobId?: string;
  workspaceId?: string;
  suggestionId?: string;
  recommendedDelivery?: "briefing" | "inbox" | "nudge";
  companionStyle?: "email" | "note";
}

interface NotificationEvent {
  type: "added" | "updated" | "removed" | "cleared";
  notification?: AppNotification;
  notifications?: AppNotification[];
}

// Memory System Types (inlined for sandboxed preload)
type MemoryType =
  | "observation"
  | "decision"
  | "error"
  | "insight"
  | "summary"
  | "preference"
  | "constraint"
  | "timing_preference"
  | "workflow_pattern"
  | "correction_rule";
type PrivacyMode = "normal" | "strict" | "disabled";

interface MemorySettings {
  workspaceId: string;
  enabled: boolean;
  autoCapture: boolean;
  compressionEnabled: boolean;
  retentionDays: number;
  maxStorageMb: number;
  privacyMode: PrivacyMode;
  excludedPatterns?: string[];
}

interface Memory {
  id: string;
  workspaceId: string;
  taskId?: string;
  type: MemoryType;
  content: string;
  summary?: string;
  tokens: number;
  isCompressed: boolean;
  isPrivate: boolean;
  createdAt: number;
  updatedAt: number;
}

type UserFactCategory =
  | "identity"
  | "preference"
  | "bio"
  | "work"
  | "goal"
  | "constraint"
  | "other";

interface UserFact {
  id: string;
  category: UserFactCategory;
  value: string;
  confidence: number;
  source: "conversation" | "feedback" | "manual";
  pinned?: boolean;
  firstSeenAt: number;
  lastUpdatedAt: number;
  lastTaskId?: string;
}

interface UserProfile {
  summary?: string;
  facts: UserFact[];
  updatedAt: number;
}

type MemorySearchResult =
  | {
      id: string;
      snippet: string;
      type: MemoryType;
      relevanceScore: number;
      createdAt: number;
      taskId?: string;
      source: "db";
    }
  | {
      id: string;
      snippet: string;
      type: MemoryType;
      relevanceScore: number;
      createdAt: number;
      taskId?: string;
      source: "markdown";
      path: string;
      startLine: number;
      endLine: number;
    };

interface MemoryTimelineEntry {
  id: string;
  content: string;
  type: MemoryType;
  createdAt: number;
  taskId?: string;
}

interface MemoryStats {
  count: number;
  totalTokens: number;
  compressedCount: number;
  compressionRatio: number;
}

// ChatGPT Import types (inlined for sandboxed preload)
interface ChatGPTImportOptions {
  workspaceId: string;
  filePath: string;
  maxConversations?: number;
  minMessages?: number;
  forcePrivate?: boolean;
  distillProvider?: string;
  distillModel?: string;
}

interface ChatGPTImportProgress {
  phase: "parsing" | "distilling" | "storing" | "done" | "error";
  current: number;
  total: number;
  conversationTitle?: string;
  memoriesCreated: number;
  error?: string;
}

interface ChatGPTImportResult {
  success: boolean;
  memoriesCreated: number;
  conversationsProcessed: number;
  skipped: number;
  errors: string[];
  sourceFileHash: string;
}

interface TextMemoryImportOptions {
  workspaceId: string;
  provider: string;
  pastedText: string;
  forcePrivate?: boolean;
}

interface TextMemoryImportResult {
  success: boolean;
  entriesDetected: number;
  memoriesCreated: number;
  duplicatesSkipped: number;
  truncated: number;
  errors: string[];
}

// Hooks types (inlined for sandboxed preload)
interface HooksSettings {
  enabled: boolean;
  token: string;
  path: string;
  maxBodyBytes: number;
  port: number;
  host: string;
  presets: string[];
  mappings: HookMapping[];
  gmail?: GmailHooksConfig;
  resend?: ResendHooksConfig;
}

interface HookMapping {
  id?: string;
  match?: {
    path?: string;
    source?: string;
    type?: string;
  };
  action?: "wake" | "agent";
  wakeMode?: "now" | "next-heartbeat";
  name?: string;
  sessionKey?: string;
  messageTemplate?: string;
  textTemplate?: string;
  deliver?: boolean;
  channel?: "telegram" | "discord" | "slack" | "whatsapp" | "imessage" | "last";
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
}

interface GmailHooksConfig {
  account?: string;
  label?: string;
  topic?: string;
  subscription?: string;
  pushToken?: string;
  hookUrl?: string;
  includeBody?: boolean;
  maxBytes?: number;
  renewEveryMinutes?: number;
  model?: string;
  thinking?: string;
  serve?: {
    bind?: string;
    port?: number;
    path?: string;
  };
  tailscale?: {
    mode?: "off" | "serve" | "funnel";
    path?: string;
    target?: string;
  };
}

interface ResendHooksConfig {
  webhookSecret?: string;
  allowUnsafeExternalContent?: boolean;
}

interface HooksStatus {
  enabled: boolean;
  serverRunning: boolean;
  serverAddress?: { host: string; port: number };
  gmailWatcherRunning: boolean;
  gmailAccount?: string;
  gogAvailable: boolean;
}

interface GmailHooksStatus {
  configured: boolean;
  running: boolean;
  account?: string;
  topic?: string;
  gogAvailable: boolean;
}

interface HooksEvent {
  action: "started" | "stopped" | "request" | "error";
  timestamp: number;
  path?: string;
  method?: string;
  statusCode?: number;
  error?: string;
}

// Control Plane types (inlined for sandboxed preload)
// NOTE: These types are intentionally duplicated from shared/types.ts because
// the preload script runs in a sandboxed context and cannot import from other modules.
// When updating these types, ensure shared/types.ts is also updated to stay in sync.
type TailscaleMode = "off" | "serve" | "funnel";
type ControlPlaneConnectionMode = "local" | "remote";

interface ControlPlaneSettingsData {
  enabled: boolean;
  port: number;
  host: string;
  token: string;
  handshakeTimeoutMs: number;
  heartbeatIntervalMs: number;
  maxPayloadBytes: number;
  tailscale: {
    mode: TailscaleMode;
    resetOnExit: boolean;
  };
  connectionMode?: ControlPlaneConnectionMode;
  remote?: RemoteGatewayConfig;
  savedRemoteDevices?: SavedRemoteGatewayDevice[];
  activeRemoteDeviceId?: string;
  managedDevices?: ManagedDevice[];
  activeManagedDeviceId?: string;
}

interface ControlPlaneClientInfo {
  id: string;
  remoteAddress: string;
  deviceName?: string;
  authenticated: boolean;
  scopes: string[];
  connectedAt: number;
  lastActivityAt: number;
}

interface ControlPlaneStatus {
  enabled: boolean;
  running: boolean;
  address?: {
    host: string;
    port: number;
    wsUrl: string;
  };
  clients: {
    total: number;
    authenticated: number;
    pending: number;
    list: ControlPlaneClientInfo[];
  };
  tailscale: {
    active: boolean;
    mode?: TailscaleMode;
    hostname?: string;
    httpsUrl?: string;
    wssUrl?: string;
  };
}

interface ControlPlaneEvent {
  action:
    | "started"
    | "stopped"
    | "client_connected"
    | "client_disconnected"
    | "client_authenticated"
    | "request"
    | "error";
  timestamp: number;
  clientId?: string;
  method?: string;
  error?: string;
  details?: unknown;
}

interface TailscaleAvailability {
  installed: boolean;
  funnelAvailable: boolean;
  hostname: string | null;
}

// Remote Gateway types
interface RemoteGatewayConfig {
  url: string;
  token: string;
  tlsFingerprint?: string;
  deviceName?: string;
  autoReconnect?: boolean;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
  sshTunnel?: SSHTunnelConfig;
}

interface SavedRemoteGatewayDevice {
  id: string;
  name: string;
  config: RemoteGatewayConfig;
  clientId?: string;
  connectedAt?: number;
  lastActivityAt?: number;
}

const LOCAL_MANAGED_DEVICE_ID = "local:this-device";
const LOCAL_MANAGED_DEVICE_NODE_ID = "local:this-device";
void LOCAL_MANAGED_DEVICE_ID;
void LOCAL_MANAGED_DEVICE_NODE_ID;

type ManagedDeviceRole = "local" | "remote";
type ManagedDevicePurpose =
  | "primary"
  | "work"
  | "personal"
  | "automation"
  | "archive"
  | "general";
type ManagedDeviceTransport = "local" | "direct" | "ssh" | "tailscale" | "unknown";
type ManagedDeviceAttentionState = "none" | "info" | "warning" | "critical";

interface ManagedDeviceStorageSummary {
  totalBytes?: number;
  freeBytes?: number;
  usedBytes?: number;
  usagePercent?: number;
  workspaceCount: number;
  artifactCount: number;
}

interface ManagedDeviceAppsSummary {
  channelsTotal: number;
  channelsEnabled: number;
  workspacesTotal: number;
  approvalsPending: number;
  inputRequestsPending: number;
  accountsTotal?: number;
}

interface ManagedDeviceAlert {
  id: string;
  level: ManagedDeviceAttentionState;
  title: string;
  description?: string;
  kind:
    | "approval"
    | "input_request"
    | "channel"
    | "connection"
    | "storage"
    | "status"
    | "warning";
}

interface ManagedDevice {
  id: string;
  name: string;
  role: ManagedDeviceRole;
  purpose: ManagedDevicePurpose;
  transport: ManagedDeviceTransport;
  status: RemoteGatewayConnectionState | "local";
  platform: "ios" | "android" | "macos" | "linux" | "windows";
  version?: string;
  modelIdentifier?: string;
  clientId?: string;
  connectedAt?: number;
  lastSeenAt?: number;
  taskNodeId?: string | null;
  tags?: string[];
  config?: RemoteGatewayConfig;
  autoConnect?: boolean;
  attentionState?: ManagedDeviceAttentionState;
  activeRunCount?: number;
  storageSummary?: ManagedDeviceStorageSummary;
  appsSummary?: ManagedDeviceAppsSummary;
}

interface ManagedDeviceSummary {
  device: ManagedDevice;
  runtime?: {
    platform?: string;
    arch?: string;
    node?: string;
    electron?: string;
    coworkVersion?: string;
    cwd?: string;
    userDataDir?: string;
    headless?: boolean;
  };
  tasks: {
    total: number;
    active: number;
    attention: number;
    recent: Any[];
  };
  apps: ManagedDeviceAppsSummary & {
    channels?: Any[];
    workspaces?: Any[];
    accounts?: Any[];
  };
  storage: ManagedDeviceStorageSummary & {
    workspaceRoots: Array<{ id: string; name: string; path: string }>;
  };
  alerts: ManagedDeviceAlert[];
  observer: Array<{
    id: string;
    timestamp: number;
    title: string;
    detail?: string;
    level: ManagedDeviceAttentionState;
  }>;
}

interface DeviceProxyRequest {
  deviceId: string;
  method: string;
  params?: unknown;
}

type RemoteGatewayConnectionState =
  | "disconnected"
  | "connecting"
  | "authenticating"
  | "connected"
  | "reconnecting"
  | "error";

interface RemoteGatewayStatus {
  state: RemoteGatewayConnectionState;
  url?: string;
  connectedAt?: number;
  clientId?: string;
  scopes?: string[];
  error?: string;
  reconnectAttempts?: number;
  lastActivityAt?: number;
  sshTunnel?: SSHTunnelStatus;
}

interface RemoteGatewayEvent {
  type: "stateChange" | "event";
  deviceId?: string;
  state?: RemoteGatewayConnectionState;
  event?: string;
  payload?: unknown;
  error?: string;
}

// SSH Tunnel types
type SSHTunnelState = "disconnected" | "connecting" | "connected" | "reconnecting" | "error";

interface SSHTunnelConfig {
  enabled: boolean;
  host: string;
  sshPort: number;
  username: string;
  keyPath?: string;
  localPort: number;
  remotePort: number;
  remoteBindAddress?: string;
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  connectionTimeoutMs?: number;
}

interface SSHTunnelStatus {
  state: SSHTunnelState;
  config?: Partial<SSHTunnelConfig>;
  connectedAt?: number;
  error?: string;
  reconnectAttempts?: number;
  pid?: number;
  localEndpoint?: string;
}

interface SSHTunnelEvent {
  type: "stateChange" | "connected" | "disconnected" | "error";
  state?: SSHTunnelState;
  reason?: string;
  error?: string;
}

// Agent Role (Agent Squad) types (inlined for sandboxed preload)
type AgentCapability =
  | "code"
  | "review"
  | "research"
  | "test"
  | "document"
  | "plan"
  | "design"
  | "analyze";

interface AgentToolRestrictions {
  allowedTools?: string[];
  deniedTools?: string[];
}

type AgentAutonomyLevel = "intern" | "specialist" | "lead";

interface AgentRoleData {
  id: string;
  name: string;
  roleKind?: import("../shared/types").AgentRoleKind;
  sourceTemplateId?: string;
  sourceTemplateVersion?: string;
  companyId?: string;
  displayName: string;
  description?: string;
  icon: string;
  color: string;
  personalityId?: string;
  modelKey?: string;
  providerType?: string;
  systemPrompt?: string;
  capabilities: AgentCapability[];
  toolRestrictions?: AgentToolRestrictions;
  isSystem: boolean;
  isActive: boolean;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  // Automation fields
  autonomyLevel?: AgentAutonomyLevel;
  soul?: string;
  heartbeatPolicy?: import("../shared/types").HeartbeatPolicy;
  heartbeatEnabled?: boolean;
  heartbeatIntervalMinutes?: number;
  heartbeatStaggerOffset?: number;
  pulseEveryMinutes?: number;
  dispatchCooldownMinutes?: number;
  maxDispatchesPerDay?: number;
  heartbeatProfile?: import("../shared/types").HeartbeatProfile;
  activeHours?: import("../shared/types").HeartbeatActiveHours;
  lastHeartbeatAt?: number;
  lastPulseAt?: number;
  lastDispatchAt?: number;
  heartbeatStatus?: HeartbeatStatus;
  operatorMandate?: string;
  allowedLoopTypes?: import("../shared/types").CompanyLoopType[];
  outputTypes?: import("../shared/types").CompanyOutputType[];
  suppressionPolicy?: string;
  maxAutonomousOutputsPerCycle?: number;
  lastUsefulOutputAt?: number;
  operatorHealthScore?: number;
}

interface CreateAgentRoleRequest {
  name: string;
  roleKind?: import("../shared/types").AgentRoleKind;
  sourceTemplateId?: string;
  sourceTemplateVersion?: string;
  companyId?: string;
  displayName: string;
  description?: string;
  icon?: string;
  color?: string;
  personalityId?: string;
  modelKey?: string;
  providerType?: string;
  systemPrompt?: string;
  capabilities: AgentCapability[];
  toolRestrictions?: AgentToolRestrictions;
  // Automation fields
  autonomyLevel?: AgentAutonomyLevel;
  soul?: string;
  operatorMandate?: string;
  allowedLoopTypes?: import("../shared/types").CompanyLoopType[];
  outputTypes?: import("../shared/types").CompanyOutputType[];
  suppressionPolicy?: string;
  maxAutonomousOutputsPerCycle?: number;
  lastUsefulOutputAt?: number;
  operatorHealthScore?: number;
}

interface UpdateAgentRoleRequest {
  id: string;
  roleKind?: import("../shared/types").AgentRoleKind;
  sourceTemplateId?: string | null;
  sourceTemplateVersion?: string | null;
  companyId?: string | null;
  displayName?: string;
  description?: string;
  icon?: string;
  color?: string;
  personalityId?: string;
  modelKey?: string;
  providerType?: string;
  systemPrompt?: string;
  capabilities?: AgentCapability[];
  toolRestrictions?: AgentToolRestrictions;
  isActive?: boolean;
  sortOrder?: number;
  // Automation fields
  autonomyLevel?: AgentAutonomyLevel;
  soul?: string;
  operatorMandate?: string;
  allowedLoopTypes?: import("../shared/types").CompanyLoopType[];
  outputTypes?: import("../shared/types").CompanyOutputType[];
  suppressionPolicy?: string;
  maxAutonomousOutputsPerCycle?: number;
  lastUsefulOutputAt?: number | null;
  operatorHealthScore?: number | null;
}

interface AutomationProfileData {
  id: string;
  agentRoleId: string;
  enabled: boolean;
  cadenceMinutes: number;
  staggerOffsetMinutes: number;
  dispatchCooldownMinutes: number;
  maxDispatchesPerDay: number;
  profile: import("../shared/types").HeartbeatProfile;
  activeHours?: import("../shared/types").HeartbeatActiveHours | null;
  heartbeatStatus: HeartbeatStatus;
  lastHeartbeatAt?: number;
  lastPulseAt?: number;
  lastDispatchAt?: number;
  lastPulseResult?: import("../shared/types").HeartbeatPulseResultKind;
  lastDispatchKind?: import("../shared/types").HeartbeatDispatchKind;
  createdAt: number;
  updatedAt: number;
}

// Activity Feed types (inlined for sandboxed preload)
type ActivityActorType = "agent" | "user" | "system";
type ActivityType =
  | "task_created"
  | "task_started"
  | "task_completed"
  | "task_failed"
  | "task_paused"
  | "task_resumed"
  | "comment"
  | "file_created"
  | "file_modified"
  | "file_deleted"
  | "command_executed"
  | "tool_used"
  | "mention"
  | "supervisor_exchange"
  | "agent_assigned"
  | "error"
  | "info";

interface ActivityData {
  id: string;
  workspaceId: string;
  taskId?: string;
  agentRoleId?: string;
  actorType: ActivityActorType;
  activityType: ActivityType;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
  isRead: boolean;
  isPinned: boolean;
  createdAt: number;
}

interface CreateActivityRequest {
  workspaceId: string;
  taskId?: string;
  agentRoleId?: string;
  actorType: ActivityActorType;
  activityType: ActivityType;
  title: string;
  description?: string;
  metadata?: Record<string, unknown>;
}

interface ActivityListQuery {
  workspaceId: string;
  taskId?: string;
  agentRoleId?: string;
  activityType?: ActivityType | ActivityType[];
  actorType?: ActivityActorType;
  isRead?: boolean;
  isPinned?: boolean;
  limit?: number;
  offset?: number;
}

interface ActivityEvent {
  type: "created" | "read" | "all_read" | "pinned" | "deleted";
  activity?: ActivityData;
  id?: string;
  workspaceId?: string;
}

// @Mention System types (inlined for sandboxed preload)
type MentionType = "request" | "handoff" | "review" | "fyi";
type MentionStatus = "pending" | "acknowledged" | "completed" | "dismissed";

interface MentionData {
  id: string;
  workspaceId: string;
  taskId: string;
  fromAgentRoleId?: string;
  toAgentRoleId: string;
  mentionType: MentionType;
  context?: string;
  status: MentionStatus;
  createdAt: number;
  acknowledgedAt?: number;
  completedAt?: number;
}

interface CreateMentionRequest {
  workspaceId: string;
  taskId: string;
  fromAgentRoleId?: string;
  toAgentRoleId: string;
  mentionType: MentionType;
  context?: string;
}

interface MentionListQuery {
  workspaceId?: string;
  taskId?: string;
  toAgentRoleId?: string;
  fromAgentRoleId?: string;
  status?: MentionStatus | MentionStatus[];
  limit?: number;
  offset?: number;
}

// SupervisorProtocolIntent, SupervisorExchangeStatus, SupervisorEvidenceRef,
// SupervisorExchange, and SupervisorExchangeEvent are imported from shared/types above.
// Use SupervisorExchange (not SupervisorExchange) as the canonical type.

interface MentionEvent {
  type: "created" | "acknowledged" | "completed" | "dismissed";
  mention?: MentionData;
}

// Mission Control types (inlined for sandboxed preload)
type HeartbeatStatus = "idle" | "running" | "sleeping" | "error";

interface HeartbeatResult {
  agentRoleId: string;
  status: "ok" | "work_done" | "error";
  pendingMentions: number;
  assignedTasks: number;
  relevantActivities: number;
  maintenanceChecks?: number;
  maintenanceWorkspaceId?: string;
  silent?: boolean;
  taskCreated?: string;
  triggerReason?: string;
  loopType?: import("../shared/types").CompanyLoopType;
  outputType?: import("../shared/types").CompanyOutputType;
  expectedOutputType?: import("../shared/types").CompanyOutputType;
  valueReason?: string;
  reviewRequired?: boolean;
  reviewReason?: import("../shared/types").CompanyReviewReason;
  evidenceRefs?: import("../shared/types").CompanyEvidenceRef[];
  companyPriority?: import("../shared/types").CompanyPriority;
  error?: string;
}

interface HeartbeatEvent {
  type:
    | "started"
    | "completed"
    | "work_found"
    | "no_work"
    | "error"
    | "wake_queued"
    | "wake_coalesced"
    | "wake_queue_saturated"
    | "wake_immediate_deferred";
  agentRoleId: string;
  agentName: string;
  timestamp: number;
  result?: HeartbeatResult;
  error?: string;
  wake?: {
    source: "hook" | "cron" | "api" | "manual";
    mode: "now" | "next-heartbeat";
    text: string;
    deferredMs?: number;
    reason?: "ready" | "drain";
  };
}

type SubscriptionReason = "assigned" | "mentioned" | "commented" | "manual";

interface TaskSubscription {
  id: string;
  taskId: string;
  agentRoleId: string;
  subscriptionReason: SubscriptionReason;
  subscribedAt: number;
}

interface SubscriptionEvent {
  type: "subscribed" | "unsubscribed";
  taskId: string;
  agentRoleId: string;
  subscription?: TaskSubscription;
}

interface StandupReport {
  id: string;
  workspaceId: string;
  reportDate: string;
  completedTaskIds: string[];
  inProgressTaskIds: string[];
  blockedTaskIds: string[];
  summary: string;
  deliveredToChannel?: string;
  createdAt: number;
}

// Task Board types (inlined for sandboxed preload)
type TaskBoardColumn = "backlog" | "todo" | "in_progress" | "review" | "done";

interface TaskLabelData {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  createdAt: number;
}

interface CreateTaskLabelRequest {
  workspaceId: string;
  name: string;
  color?: string;
}

interface UpdateTaskLabelRequest {
  name?: string;
  color?: string;
}

interface TaskLabelListQuery {
  workspaceId: string;
}

interface TaskBoardEvent {
  type:
    | "moved"
    | "priorityChanged"
    | "labelAdded"
    | "labelRemoved"
    | "dueDateChanged"
    | "estimateChanged";
  taskId: string;
  data?: {
    column?: TaskBoardColumn;
    priority?: number;
    labelId?: string;
    dueDate?: number | null;
    estimatedMinutes?: number | null;
  };
}

// Agent Working State types (inlined for sandboxed preload)
type WorkingStateType = "context" | "progress" | "notes" | "plan";

interface AgentWorkingStateData {
  id: string;
  agentRoleId: string;
  workspaceId: string;
  taskId?: string;
  stateType: WorkingStateType;
  content: string;
  fileReferences?: string[];
  isCurrent: boolean;
  createdAt: number;
  updatedAt: number;
}

interface UpdateWorkingStateRequest {
  agentRoleId: string;
  workspaceId: string;
  taskId?: string;
  stateType: WorkingStateType;
  content: string;
  fileReferences?: string[];
}

interface WorkingStateQuery {
  agentRoleId: string;
  workspaceId: string;
  taskId?: string;
  stateType?: WorkingStateType;
}

interface WorkingStateHistoryQuery {
  agentRoleId: string;
  workspaceId: string;
  limit?: number;
  offset?: number;
}

// Context Policy types (inlined for sandboxed preload)
type SecurityModeType = "open" | "allowlist" | "pairing";
type ContextTypeValue = "dm" | "group";

interface ContextPolicyData {
  id: string;
  channelId: string;
  contextType: ContextTypeValue;
  securityMode: SecurityModeType;
  toolRestrictions: string[];
  createdAt: number;
  updatedAt: number;
}

interface UpdateContextPolicyOptions {
  securityMode?: SecurityModeType;
  toolRestrictions?: string[];
}

interface ReadFileForViewerOptions {
  enableImageOcr?: boolean;
  imageOcrMaxChars?: number;
  includeImageContent?: boolean;
  includePdfBase64?: boolean;
}

export interface LlmWikiVaultEntry {
  path: string;
  name: string;
  section: "root" | "page" | "query" | "output" | "raw";
  updatedAt: string;
}

export interface LlmWikiVaultSummary {
  exists: boolean;
  vaultPath: string;
  displayPath: string;
  counts: {
    pages: number;
    queries: number;
    rawSources: number;
    outputs: number;
  };
  rootFiles: LlmWikiVaultEntry[];
  recentPages: LlmWikiVaultEntry[];
  recentQueries: LlmWikiVaultEntry[];
  recentOutputs: LlmWikiVaultEntry[];
  recentRawSources: LlmWikiVaultEntry[];
}

// Expose protected methods that allow the renderer process to use ipcRenderer
contextBridge.exposeInMainWorld("electronAPI", {
  // Dialog APIs
  selectFolder: (defaultPath?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FOLDER, defaultPath),
  selectFiles: (defaultPath?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DIALOG_SELECT_FILES, defaultPath),

  // File APIs
  openFile: (filePath: string, workspacePath?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_OPEN, filePath, workspacePath),
  showInFinder: (filePath: string, workspacePath?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_SHOW_IN_FINDER, filePath, workspacePath),
  readFileForViewer: (
    filePath: string,
    workspacePath?: string,
    options?: ReadFileForViewerOptions,
  ) => ipcRenderer.invoke(IPC_CHANNELS.FILE_READ_FOR_VIEWER, { filePath, workspacePath, ...options }),
  getLlmWikiVaultSummary: (data: { workspacePath: string; vaultPath?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_WIKI_GET_VAULT_SUMMARY, data) as Promise<LlmWikiVaultSummary>,
  importFilesToWorkspace: (data: { workspaceId: string; files: string[] }) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_IMPORT_TO_WORKSPACE, data),
  importDataToWorkspace: (data: {
    workspaceId: string;
    files: Array<{ name: string; data: string; mimeType?: string }>;
  }) => ipcRenderer.invoke(IPC_CHANNELS.FILE_IMPORT_DATA_TO_WORKSPACE, data),
  openDocumentEditorSession: (data: { filePath: string; workspacePath?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_OPEN_EDITOR_SESSION, data) as Promise<DocumentEditorSession>,
  listDocumentVersions: (data: { filePath: string; workspacePath?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_LIST_VERSIONS, data) as Promise<DocumentVersionEntry[]>,
  startDocumentEditTask: (data: DocumentEditRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_START_EDIT_TASK, data),
  getMailboxSyncStatus: () => ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_GET_SYNC_STATUS),
  getMailboxClientState: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_CLIENT_STATE) as Promise<MailboxClientState>,
  syncMailbox: (limit?: number) => ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SYNC, { limit }),
  listMailboxThreads: (query?: MailboxListThreadsInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_LIST_THREADS, query),
  getMailboxThread: (threadId: string) => ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_GET_THREAD, threadId),
  listMailboxEvents: (limit?: number, threadId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_LIST_EVENTS, { limit, threadId }) as Promise<MailboxEvent[]>,
  listMailboxAutomations: (query?: {
    workspaceId?: string;
    threadId?: string;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_LIST, query) as Promise<MailboxAutomationRecord[]>,
  listThreadMailboxAutomations: (threadId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_LIST_THREAD, threadId) as Promise<MailboxAutomationRecord[]>,
  createMailboxRule: (recipe: MailboxRuleRecipe) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_CREATE_RULE, { recipe }) as Promise<MailboxAutomationRecord>,
  updateMailboxRule: (
    id: string,
    patch: Partial<MailboxRuleRecipe> & { status?: MailboxAutomationStatus },
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_UPDATE_RULE, { id, patch }) as Promise<MailboxAutomationRecord | null>,
  deleteMailboxRule: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_DELETE_RULE, id) as Promise<boolean>,
  createMailboxSchedule: (recipe: MailboxScheduleRecipe) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_CREATE_SCHEDULE, { recipe }) as Promise<MailboxAutomationRecord>,
  updateMailboxSchedule: (
    id: string,
    patch: Partial<MailboxScheduleRecipe> & { status?: MailboxAutomationStatus },
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_UPDATE_SCHEDULE, { id, patch }) as Promise<MailboxAutomationRecord | null>,
  deleteMailboxSchedule: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_DELETE_SCHEDULE, id) as Promise<boolean>,
  createMailboxForward: (recipe: MailboxForwardRecipe) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_CREATE_FORWARD, { recipe }) as Promise<MailboxAutomationRecord>,
  updateMailboxForward: (
    id: string,
    patch: Partial<MailboxForwardRecipe> & { status?: MailboxAutomationStatus },
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_UPDATE_FORWARD, { id, patch }) as Promise<MailboxAutomationRecord | null>,
  deleteMailboxForward: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_DELETE_FORWARD, id) as Promise<boolean>,
  runMailboxForward: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_RUN_FORWARD, id) as Promise<string>,
  getMailboxDigest: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_GET_DIGEST, { workspaceId }) as Promise<MailboxDigestSnapshot>,
  getMailboxTodayDigest: (input?: { limitPerBucket?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_TODAY_DIGEST, input || {}) as Promise<MailboxTodayDigest>,
  getMailboxSenderCleanupDigest: (input?: { limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SENDER_CLEANUP_DIGEST, input || {}) as Promise<MailboxSenderCleanupDigest>,
  askMailbox: (input: MailboxAskInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_ASK, input) as Promise<MailboxAskResult>,
  extractMailboxAttachmentText: (attachmentId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_ATTACHMENT_EXTRACT_TEXT, { attachmentId }) as Promise<MailboxAttachmentRecord>,
  createMailboxDraft: (input: MailboxComposeDraftInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_CREATE_DRAFT, input) as Promise<MailboxComposeDraft>,
  updateMailboxDraft: (draftId: string, patch: MailboxComposeDraftPatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_UPDATE_DRAFT, { draftId, patch }) as Promise<MailboxComposeDraft>,
  sendMailboxDraft: (draftId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SEND_DRAFT, { draftId }) as Promise<MailboxOutgoingMessage>,
  scheduleMailboxSend: (draftId: string, scheduledAt: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SCHEDULE_SEND, { draftId, scheduledAt }) as Promise<MailboxComposeDraft>,
  discardMailboxDraft: (draftId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_DISCARD_COMPOSE_DRAFT, { draftId }) as Promise<boolean>,
  undoMailboxAction: (actionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_UNDO_ACTION, { actionId }) as Promise<MailboxQueuedAction>,
  summarizeMailboxThread: (threadId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SUMMARIZE_THREAD, { threadId }),
  generateMailboxDraft: (threadId: string, options?: MailboxDraftOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_GENERATE_DRAFT, { threadId, ...options }),
  extractMailboxCommitments: (threadId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_EXTRACT_COMMITMENTS, { threadId }),
  reviewMailboxBulkAction: (input: { type: "cleanup" | "follow_up"; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_REVIEW_BULK_ACTION, input),
  scheduleMailboxReply: (threadId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SCHEDULE_REPLY, { threadId }),
  researchMailboxContact: (threadId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_RESEARCH_CONTACT, { threadId }),
  resolveMailboxContactIdentity: (threadId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_RESOLVE, { threadId }) as Promise<ContactIdentityResolution | null>,
  getContactIdentity: (contactIdentityId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_GET, { contactIdentityId }) as Promise<ContactIdentity | null>,
  listContactIdentities: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_LIST, { workspaceId }) as Promise<ContactIdentity[]>,
  searchIdentityLinkTargets: (workspaceId: string, query: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_SEARCH, { workspaceId, query, limit }) as Promise<ContactIdentitySearchResult[]>,
  linkIdentityHandle: (input: {
    workspaceId: string;
    contactIdentityId: string;
    handleType: string;
    normalizedValue: string;
    displayValue: string;
    source?: string;
    channelId?: string;
    channelType?: string;
    channelUserId?: string;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_LINK, input) as Promise<ContactIdentity | null>,
  getMailboxRelationshipTimeline: (query: RelationshipTimelineQuery) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_TIMELINE, query) as Promise<RelationshipTimelineEvent[]>,
  listIdentityCandidates: (workspaceId?: string, status?: ContactIdentityCandidate["status"]) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_CANDIDATES, { workspaceId, status }) as Promise<ContactIdentityCandidate[]>,
  confirmIdentityLink: (candidateId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_CONFIRM, { candidateId }) as Promise<ContactIdentityCandidate | null>,
  rejectIdentityLink: (candidateId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_REJECT, { candidateId }) as Promise<ContactIdentityCandidate | null>,
  unlinkIdentityHandle: (handleId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_UNLINK, { handleId }) as Promise<boolean>,
  getChannelPreferenceSummary: (contactIdentityId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_PREFERENCE, { contactIdentityId }) as Promise<ChannelPreferenceSummary>,
  getContactIdentityCoverageStats: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_COVERAGE, { workspaceId }) as Promise<ContactIdentityCoverageStats>,
  replyViaChannel: (input: {
    threadId: string;
    handleId: string;
    channelType: "slack" | "teams" | "whatsapp" | "signal" | "imessage";
    message: string;
    parseMode?: "text" | "markdown";
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_REPLY_VIA_CHANNEL, input) as Promise<{
      ok: boolean;
      target: ContactIdentityReplyTarget;
    }>,
  previewMailboxMissionControlHandoff: (threadId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_MC_HANDOFF_PREVIEW, { threadId }) as Promise<MailboxMissionControlHandoffPreview | null>,
  createMailboxMissionControlHandoff: (request: MailboxMissionControlHandoffRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_MC_HANDOFF_CREATE, request) as Promise<MailboxMissionControlHandoffRecord>,
  listMailboxMissionControlHandoffs: (threadId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_MC_HANDOFF_LIST, { threadId }) as Promise<MailboxMissionControlHandoffRecord[]>,
  listMailboxSnippets: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SNIPPETS_LIST) as Promise<MailboxSnippetRecord[]>,
  upsertMailboxSnippet: (input: { id?: string; shortcut: string; body: string; subjectHint?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SNIPPET_UPSERT, input) as Promise<MailboxSnippetRecord>,
  deleteMailboxSnippet: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SNIPPET_DELETE, { id }) as Promise<boolean>,
  listMailboxSavedViews: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SAVED_VIEWS_LIST) as Promise<MailboxSavedViewRecord[]>,
  createMailboxSavedView: (input: {
    name: string;
    instructions: string;
    seedThreadId?: string;
    threadIds: string[];
    showInInbox?: boolean;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SAVED_VIEW_CREATE, input) as Promise<MailboxSavedViewRecord>,
  deleteMailboxSavedView: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SAVED_VIEW_DELETE, { id }) as Promise<boolean>,
  previewMailboxSavedViewSimilar: (input: { seedThreadId: string; name: string; instructions: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SAVED_VIEW_PREVIEW_SIMILAR, input) as Promise<MailboxSavedViewPreviewResult>,
  getMailboxQuickReplySuggestions: (threadId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_QUICK_REPLY_SUGGESTIONS, { threadId }) as Promise<MailboxQuickReplySuggestionsResult>,
  createMailboxSavedViewReviewSchedule: (viewId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SAVED_VIEW_REVIEW_SCHEDULE, { viewId }) as Promise<MailboxAutomationRecord>,
  applyMailboxAction: (input: MailboxApplyActionInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_APPLY_ACTION, input),
  updateMailboxCommitmentState: (
    commitmentId: string,
    state: MailboxCommitmentState,
  ) => ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_UPDATE_COMMITMENT_STATE, { commitmentId, state }),
  updateMailboxCommitmentDetails: (
    commitmentId: string,
    patch: {
      title?: string;
      dueAt?: number | null;
      ownerEmail?: string | null;
      state?: MailboxCommitmentState;
      sourceExcerpt?: string | null;
    },
  ) => ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_UPDATE_COMMITMENT_DETAILS, { commitmentId, patch }),
  reclassifyMailboxThread: (threadId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_RECLASSIFY_THREAD, { threadId }) as Promise<MailboxReclassifyResult>,
  reclassifyMailboxAccount: (input: MailboxReclassifyInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_RECLASSIFY_ACCOUNT, input) as Promise<MailboxReclassifyResult>,
  onMailboxEvent: (callback: (event: MailboxEvent) => void) => {
    const subscription = (_: Any, data: MailboxEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.MAILBOX_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MAILBOX_EVENT, subscription);
  },

  // Shell APIs
  openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, url),
  openSystemSettings: (target: "microphone" | "dictation") =>
    ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_OPEN_SETTINGS, target),

  // Task APIs
  createTask: (data: Any) => ipcRenderer.invoke(IPC_CHANNELS.TASK_CREATE, data),
  getTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_GET, id),
  listTasks: (opts?: { limit?: number; offset?: number; prioritizeSidebar?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_LIST, opts),
  exportTasksJson: (query?: Any) => ipcRenderer.invoke(IPC_CHANNELS.TASK_EXPORT_JSON, query),
  toggleTaskPin: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_PIN, taskId),
  cancelTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_CANCEL, id),
  wrapUpTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_WRAP_UP, id),
  pauseTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_PAUSE, id),
  resumeTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_RESUME, id),
  continueTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_CONTINUE, id),
  forkTaskSession: (data: {
    taskId: string;
    prompt?: string;
    branchLabel?: string;
    fromEventId?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.TASK_FORK_SESSION, data),
  sendStdin: (taskId: string, input: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_SEND_STDIN, { taskId, input }),
  killCommand: (taskId: string, force?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_KILL_COMMAND, { taskId, force }),
  renameTask: (id: string, title: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_RENAME, { id, title }),
  deleteTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_DELETE, id),

  // Task event streaming
  onTaskEvent: (callback: (event: Any) => void) => {
    const subscription = (_: Any, data: Any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.TASK_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TASK_EVENT, subscription);
  },
  onTaskLearningEvent: (callback: (event: TaskLearningProgress) => void) => {
    const subscription = (_: Any, data: TaskLearningProgress) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.TASK_LEARNING_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TASK_LEARNING_EVENT, subscription);
  },

  // Task event history (load from DB)
  getTaskEvents: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_EVENTS, taskId),
  getTaskLearningProgress: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_LEARNING_PROGRESS, taskId) as Promise<
      TaskLearningProgress[]
    >,

  // Semantic timeline projection (normalised UiTimelineEvent[] derived from task_events)
  getSemanticTimeline: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_SEMANTIC_TIMELINE, taskId),
  listTaskTraceRuns: (request?: import("../shared/types").ListTaskTraceRunsRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_TRACE_LIST, request) as Promise<TaskTraceRunSummary[]>,
  getTaskTraceRun: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_TRACE_GET, taskId) as Promise<TaskTraceRunDetail | undefined>,

  // Send follow-up message to a task (optionally with image attachments)
  sendMessage: (
    taskId: string,
    message: string,
    images?: ImageAttachment[],
    quotedAssistantMessage?: QuotedAssistantMessage,
  ) => {
    const validatedImages = validateSendMessageAttachments(images);
    return ipcRenderer.invoke(IPC_CHANNELS.TASK_SEND_MESSAGE, {
      taskId,
      message,
      images: validatedImages,
      quotedAssistantMessage,
    });
  },

  // Send step-level feedback on an in-progress step
  sendStepFeedback: (
    taskId: string,
    stepId: string,
    action: "retry" | "skip" | "stop" | "drift",
    message?: string,
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_STEP_FEEDBACK, {
      taskId,
      stepId,
      action,
      message,
    }),

  // Workspace APIs
  createWorkspace: (data: Any) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE, data),
  listWorkspaces: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST),
  selectWorkspace: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SELECT, id),
  getTempWorkspace: (options?: { createNew?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET_TEMP, options),
  touchWorkspace: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_TOUCH, id),
  updateWorkspacePermissions: (id: string, permissions: { shell?: boolean; network?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_UPDATE_PERMISSIONS, id, permissions),

  // Approval APIs
  respondToApproval: (data: ApprovalResponse) => ipcRenderer.invoke(IPC_CHANNELS.APPROVAL_RESPOND, data),
  setSessionAutoApprove: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.APPROVAL_SESSION_AUTO_APPROVE_SET, enabled),
  getSessionAutoApprove: () => ipcRenderer.invoke(IPC_CHANNELS.APPROVAL_SESSION_AUTO_APPROVE_GET),
  listInputRequests: (query?: {
    limit?: number;
    offset?: number;
    taskId?: string;
    status?: "pending" | "submitted" | "dismissed";
  }) => ipcRenderer.invoke(IPC_CHANNELS.INPUT_REQUEST_LIST, query),
  respondToInputRequest: (data: InputRequestResponse) =>
    ipcRenderer.invoke(IPC_CHANNELS.INPUT_REQUEST_RESPOND, data),

  // Artifact APIs
  listArtifacts: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.ARTIFACT_LIST, taskId),
  previewArtifact: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.ARTIFACT_PREVIEW, id),

  // Agents Hub APIs
  listManagedAgents: (params?: {
    limit?: number;
    offset?: number;
    status?: ManagedAgent["status"];
  }) => ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_LIST_IPC, params) as Promise<ManagedAgent[]>,
  getManagedAgent: (agentId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_GET_IPC, agentId) as Promise<
      { agent: ManagedAgent; currentVersion?: ManagedAgentVersion } | null
    >,
  getManagedAgentRuntimeToolCatalog: (agentId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_RUNTIME_TOOL_CATALOG_IPC, agentId) as Promise<
      ManagedAgentRuntimeToolCatalog
    >,
  createManagedAgent: (request: {
    name: string;
    description?: string;
    systemPrompt: string;
    executionMode: ManagedAgentVersion["executionMode"];
    model?: ManagedAgentVersion["model"];
    runtimeDefaults?: ManagedAgentVersion["runtimeDefaults"];
    skills?: string[];
    mcpServers?: string[];
    teamTemplate?: ManagedAgentVersion["teamTemplate"];
    metadata?: Record<string, unknown>;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_CREATE_IPC, request) as Promise<{
      agent: ManagedAgent;
      version: ManagedAgentVersion;
    }>,
  updateManagedAgent: (request: {
    agentId: string;
    name?: string;
    description?: string;
    systemPrompt?: string;
    executionMode?: ManagedAgentVersion["executionMode"];
    model?: ManagedAgentVersion["model"];
    runtimeDefaults?: ManagedAgentVersion["runtimeDefaults"];
    skills?: string[];
    mcpServers?: string[];
    teamTemplate?: ManagedAgentVersion["teamTemplate"];
    metadata?: Record<string, unknown>;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_UPDATE_IPC, request) as Promise<{
      agent: ManagedAgent;
      version: ManagedAgentVersion;
    }>,
  archiveManagedAgent: (agentId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_ARCHIVE_IPC, agentId) as Promise<
      ManagedAgent | null
    >,
  publishManagedAgent: (agentId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_PUBLISH_IPC, agentId) as Promise<
      ManagedAgent | null
    >,
  suspendManagedAgent: (agentId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_SUSPEND_IPC, agentId) as Promise<
      ManagedAgent | null
    >,
  listManagedAgentRoutines: (agentId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_ROUTINE_LIST_IPC, agentId) as Promise<
      ManagedAgentRoutineRecord[]
    >,
  createManagedAgentRoutine: (request: CreateManagedAgentRoutineRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_ROUTINE_CREATE_IPC, request) as Promise<
      ManagedAgentRoutineRecord
    >,
  updateManagedAgentRoutine: (request: UpdateManagedAgentRoutineRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_ROUTINE_UPDATE_IPC, request) as Promise<
      ManagedAgentRoutineRecord
    >,
  deleteManagedAgentRoutine: (agentId: string, routineId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_ROUTINE_DELETE_IPC, {
      agentId,
      routineId,
    }) as Promise<boolean>,
  getManagedAgentInsights: (agentId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_INSIGHTS_GET_IPC, agentId) as Promise<
      ManagedAgentInsights
    >,
  listManagedAgentAuditEntries: (agentId: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_AUDIT_LIST_IPC, {
      agentId,
      limit,
    }) as Promise<ManagedAgentAuditEntry[]>,
  getManagedAgentSlackDeploymentHealth: (agentId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_SLACK_HEALTH_GET_IPC, agentId) as Promise<
      ManagedAgentSlackDeploymentHealth
    >,
  convertAgentRoleToManagedAgent: (request: ConvertAgentRoleToManagedAgentRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_CONVERT_ROLE_IPC, request) as Promise<
      ManagedAgentConversionResult
    >,
  convertAutomationProfileToManagedAgent: (
    request: ConvertAutomationProfileToManagedAgentRequest,
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_CONVERT_AUTOMATION_IPC, request) as Promise<
      ManagedAgentConversionResult
    >,
  listManagedEnvironments: (params?: {
    limit?: number;
    offset?: number;
    status?: ManagedEnvironment["status"];
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_ENVIRONMENT_LIST_IPC, params) as Promise<
      ManagedEnvironment[]
    >,
  getManagedEnvironment: (environmentId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_ENVIRONMENT_GET_IPC, environmentId) as Promise<
      ManagedEnvironment | null
    >,
  createManagedEnvironment: (request: {
    name: string;
    kind?: ManagedEnvironment["kind"];
    config: ManagedEnvironment["config"];
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_ENVIRONMENT_CREATE_IPC, request) as Promise<
      ManagedEnvironment
    >,
  updateManagedEnvironment: (request: {
    environmentId: string;
    name?: string;
    config?: Partial<ManagedEnvironment["config"]>;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_ENVIRONMENT_UPDATE_IPC, request) as Promise<
      ManagedEnvironment | null
    >,
  archiveManagedEnvironment: (environmentId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_ENVIRONMENT_ARCHIVE_IPC, environmentId) as Promise<
      ManagedEnvironment | null
    >,
  listManagedSessions: (params?: {
    limit?: number;
    offset?: number;
    workspaceId?: string;
    status?: ManagedSession["status"];
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_SESSION_LIST_IPC, params) as Promise<ManagedSession[]>,
  getManagedSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_SESSION_GET_IPC, sessionId) as Promise<
      ManagedSession | null
    >,
  createManagedSession: (request: ManagedSessionCreateInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_SESSION_CREATE_IPC, request) as Promise<ManagedSession>,
  resumeManagedSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_SESSION_RESUME_IPC, sessionId) as Promise<{
      resumed: boolean;
      session?: ManagedSession;
    }>,
  cancelManagedSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_SESSION_CANCEL_IPC, sessionId) as Promise<
      ManagedSession | undefined
    >,
  listManagedSessionEvents: (sessionId: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_SESSION_EVENTS_LIST_IPC, {
      sessionId,
      limit,
    }) as Promise<ManagedSessionEvent[]>,
  getManagedSessionWorkpaper: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_SESSION_WORKPAPER_GET_IPC, sessionId) as Promise<
      ManagedSessionWorkpaper
    >,
  listAgentTemplates: () =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_TEMPLATE_LIST) as Promise<AgentTemplate[]>,
  listAgentWorkspaceMemberships: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_WORKSPACE_MEMBERSHIP_LIST_IPC, workspaceId) as Promise<
      AgentWorkspaceMembership[]
    >,
  updateAgentWorkspaceMembership: (request: {
    workspaceId: string;
    principalId: string;
    role: AgentWorkspaceMembership["role"];
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_WORKSPACE_MEMBERSHIP_UPDATE_IPC, request) as Promise<
      AgentWorkspaceMembership
    >,
  getMyAgentWorkspacePermissions: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_WORKSPACE_PERMISSION_SNAPSHOT_IPC, {
      workspaceId,
    }) as Promise<AgentWorkspacePermissionSnapshot>,
  listImageGenProfiles: () =>
    ipcRenderer.invoke(IPC_CHANNELS.IMAGE_GEN_PROFILE_LIST) as Promise<ImageGenProfile[]>,
  createImageGenProfile: (request: {
    name: string;
    description?: string;
    isDefault?: boolean;
    referencePhotoPaths?: string[];
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMAGE_GEN_PROFILE_CREATE, request) as Promise<ImageGenProfile>,
  updateImageGenProfile: (request: {
    id: string;
    name?: string;
    description?: string;
    isDefault?: boolean;
    addReferencePhotoPaths?: string[];
    removeReferencePhotoIds?: string[];
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMAGE_GEN_PROFILE_UPDATE, request) as Promise<
      ImageGenProfile | null
    >,
  deleteImageGenProfile: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMAGE_GEN_PROFILE_DELETE, id) as Promise<boolean>,
  generateManagedSessionAudioSummary: (
    sessionId: string,
    config?: Partial<AudioSummaryConfig>,
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_SESSION_GENERATE_AUDIO_SUMMARY, {
      sessionId,
      config,
    }) as Promise<AudioSummaryResult>,

  // Skill APIs
  listSkills: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_LIST),
  getSkill: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_GET, id),

  // LLM Settings APIs
  getLLMSettings: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_SETTINGS),
  saveLLMSettings: (settings: Any) => ipcRenderer.invoke(IPC_CHANNELS.LLM_SAVE_SETTINGS, settings),
  resetLLMProviderCredentials: (providerType: LLMProviderType) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_RESET_PROVIDER_CREDENTIALS, providerType),
  testLLMProvider: (config: Any) => ipcRenderer.invoke(IPC_CHANNELS.LLM_TEST_PROVIDER, config),
  getLLMModels: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_MODELS),
  getLLMConfigStatus: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_CONFIG_STATUS),
  setLLMModel: (
    selection:
      | string
      | {
          providerType?: LLMProviderType;
          modelKey: string;
          reasoningEffort?: "low" | "medium" | "high" | "extra_high";
        },
  ) => ipcRenderer.invoke(IPC_CHANNELS.LLM_SET_MODEL, selection),
  getProviderModels: (providerType: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_PROVIDER_MODELS, providerType),
  getAnthropicModels: (credentials?: {
    apiKey?: string;
    subscriptionToken?: string;
    authMethod?: "api_key" | "subscription";
  }) => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_ANTHROPIC_MODELS, credentials),
  refreshCustomProviderModels: (
    providerType: string,
    overrides?: { apiKey?: string; baseUrl?: string },
  ) => ipcRenderer.invoke(IPC_CHANNELS.LLM_REFRESH_CUSTOM_PROVIDER_MODELS, providerType, overrides),
  getOllamaModels: (baseUrl?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_OLLAMA_MODELS, baseUrl),
  getGeminiModels: (apiKey?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_GEMINI_MODELS, apiKey),
  getOpenRouterModels: (apiKey?: string, baseUrl?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_OPENROUTER_MODELS, apiKey, baseUrl),
  getOpenAIModels: (apiKey?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_OPENAI_MODELS, apiKey),
  getGroqModels: (apiKey?: string, baseUrl?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_GROQ_MODELS, apiKey, baseUrl),
  getXAIModels: (apiKey?: string, baseUrl?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_XAI_MODELS, apiKey, baseUrl),
  getKimiModels: (apiKey?: string, baseUrl?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_KIMI_MODELS, apiKey, baseUrl),
  getPiModels: (piProvider?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_PI_MODELS, piProvider),
  getPiProviders: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_PI_PROVIDERS),
  getOpenAICompatibleModels: (baseUrl: string, apiKey?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_OPENAI_COMPATIBLE_MODELS, baseUrl, apiKey),
  // Local AI (hf-agents + llama.cpp)
  checkHf: () => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_AI_CHECK_HF),
  detectHardware: () => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_AI_DETECT_HARDWARE),
  startLocalAIServer: (model?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LOCAL_AI_START_SERVER, model),
  stopLocalAIServer: () => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_AI_STOP_SERVER),
  getLocalAIServerStatus: () => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_AI_GET_SERVER_STATUS),
  getLocalAIServerLog: () => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_AI_GET_SERVER_LOG),
  openaiOAuthStart: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_OPENAI_OAUTH_START),
  openaiOAuthLogout: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_OPENAI_OAUTH_LOGOUT),
  getBedrockModels: (config?: {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    profile?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_BEDROCK_MODELS, config),

  // Gateway / Channel APIs
  getGatewayChannels: () => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_GET_CHANNELS),
  addGatewayChannel: (data: AddChannelRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_ADD_CHANNEL, data),
  updateGatewayChannel: (data: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_UPDATE_CHANNEL, data),
  removeGatewayChannel: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_REMOVE_CHANNEL, id),
  enableGatewayChannel: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_ENABLE_CHANNEL, id),
  disableGatewayChannel: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_DISABLE_CHANNEL, id),
  testGatewayChannel: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_TEST_CHANNEL, id),
  getGatewayUsers: (channelId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_GET_USERS, channelId),
  getGatewayChats: (channelId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_LIST_CHATS, channelId) as Promise<
      Array<{ chatId: string; lastTimestamp: number }>
    >,
  sendGatewayTestMessage: (data: { channelType: string; channelDbId?: string; chatId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_SEND_TEST_MESSAGE, data) as Promise<{ ok: boolean }>,
  grantGatewayAccess: (channelId: string, userId: string, displayName?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_GRANT_ACCESS, { channelId, userId, displayName }),
  revokeGatewayAccess: (channelId: string, userId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_REVOKE_ACCESS, { channelId, userId }),
  generateGatewayPairing: (channelId: string, userId: string, displayName?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_GENERATE_PAIRING, { channelId, userId, displayName }),

  // Gateway event listener
  onGatewayMessage: (callback: (data: Any) => void) => {
    const subscription = (_: Any, data: Any) => callback(data);
    ipcRenderer.on("gateway:message", subscription);
    return () => ipcRenderer.removeListener("gateway:message", subscription);
  },
  onGatewayUsersUpdated: (callback: (data: { channelId: string; channelType: string }) => void) => {
    const subscription = (_: Any, data: { channelId: string; channelType: string }) =>
      callback(data);
    ipcRenderer.on("gateway:users-updated", subscription);
    return () => ipcRenderer.removeListener("gateway:users-updated", subscription);
  },

  // WhatsApp-specific APIs
  getWhatsAppInfo: () => ipcRenderer.invoke(IPC_CHANNELS.WHATSAPP_GET_INFO),
  whatsAppLogout: () => ipcRenderer.invoke(IPC_CHANNELS.WHATSAPP_LOGOUT),

  // WhatsApp event listeners
  onWhatsAppQRCode: (callback: (event: Any, qr: string) => void) => {
    ipcRenderer.on("whatsapp:qr-code", callback);
  },
  onWhatsAppConnected: (callback: () => void) => {
    ipcRenderer.on("whatsapp:connected", callback);
  },
  onWhatsAppStatus: (callback: (event: Any, data: { status: string; error?: string }) => void) => {
    ipcRenderer.on("whatsapp:status", callback);
  },

  // Search Settings APIs
  getSearchSettings: () => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_GET_SETTINGS),
  saveSearchSettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.SEARCH_SAVE_SETTINGS, settings),
  getSearchConfigStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_GET_CONFIG_STATUS),
  testSearchProvider: (providerType: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SEARCH_TEST_PROVIDER, providerType),
  listProfiles: () => ipcRenderer.invoke(IPC_CHANNELS.PROFILE_LIST) as Promise<AppProfileSummary[]>,
  createProfile: (name: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILE_CREATE, name) as Promise<AppProfileSummary>,
  switchProfile: (profileId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILE_SWITCH, profileId) as Promise<{
      success: true;
      relaunching: true;
    }>,
  exportProfile: (profileId: string, destinationRoot: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILE_EXPORT, {
      profileId,
      destinationRoot,
    }) as Promise<ProfileExportResult>,
  importProfile: (sourcePath: string, profileName?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROFILE_IMPORT, {
      sourcePath,
      profileName,
    }) as Promise<AppProfileSummary>,

  // X/Twitter Settings APIs
  getXSettings: () => ipcRenderer.invoke(IPC_CHANNELS.X_GET_SETTINGS),
  saveXSettings: (settings: Any) => ipcRenderer.invoke(IPC_CHANNELS.X_SAVE_SETTINGS, settings),
  testXConnection: () => ipcRenderer.invoke(IPC_CHANNELS.X_TEST_CONNECTION),
  getXStatus: () => ipcRenderer.invoke(IPC_CHANNELS.X_GET_STATUS),

  // Notion Settings APIs
  getNotionSettings: () => ipcRenderer.invoke(IPC_CHANNELS.NOTION_GET_SETTINGS),
  saveNotionSettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.NOTION_SAVE_SETTINGS, settings),
  testNotionConnection: () => ipcRenderer.invoke(IPC_CHANNELS.NOTION_TEST_CONNECTION),
  getNotionStatus: () => ipcRenderer.invoke(IPC_CHANNELS.NOTION_GET_STATUS),

  // Box Settings APIs
  getBoxSettings: () => ipcRenderer.invoke(IPC_CHANNELS.BOX_GET_SETTINGS),
  saveBoxSettings: (settings: Any) => ipcRenderer.invoke(IPC_CHANNELS.BOX_SAVE_SETTINGS, settings),
  testBoxConnection: () => ipcRenderer.invoke(IPC_CHANNELS.BOX_TEST_CONNECTION),
  getBoxStatus: () => ipcRenderer.invoke(IPC_CHANNELS.BOX_GET_STATUS),

  // OneDrive Settings APIs
  getOneDriveSettings: () => ipcRenderer.invoke(IPC_CHANNELS.ONEDRIVE_GET_SETTINGS),
  saveOneDriveSettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.ONEDRIVE_SAVE_SETTINGS, settings),
  testOneDriveConnection: () => ipcRenderer.invoke(IPC_CHANNELS.ONEDRIVE_TEST_CONNECTION),
  getOneDriveStatus: () => ipcRenderer.invoke(IPC_CHANNELS.ONEDRIVE_GET_STATUS),

  // Google Workspace Settings APIs
  getGoogleWorkspaceSettings: () => ipcRenderer.invoke(IPC_CHANNELS.GOOGLE_WORKSPACE_GET_SETTINGS),
  saveGoogleWorkspaceSettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.GOOGLE_WORKSPACE_SAVE_SETTINGS, settings),
  testGoogleWorkspaceConnection: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GOOGLE_WORKSPACE_TEST_CONNECTION),
  getGoogleWorkspaceStatus: () => ipcRenderer.invoke(IPC_CHANNELS.GOOGLE_WORKSPACE_GET_STATUS),
  startGoogleWorkspaceOAuth: (payload: {
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    loginHint?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.GOOGLE_WORKSPACE_OAUTH_START, payload),
  getGoogleWorkspaceOAuthLink: (payload: {
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    loginHint?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.GOOGLE_WORKSPACE_OAUTH_GET_LINK, payload),

  // AgentMail Settings APIs
  getAgentMailSettings: () => ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_GET_SETTINGS),
  saveAgentMailSettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_SAVE_SETTINGS, settings),
  testAgentMailConnection: () => ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_TEST_CONNECTION),
  getAgentMailStatus: () => ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_GET_STATUS),
  listAgentMailPods: () => ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_LIST_PODS),
  getAgentMailWorkspaceBinding: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_GET_WORKSPACE_BINDING, workspaceId),
  bindAgentMailWorkspacePod: (payload: { workspaceId: string; podId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_BIND_WORKSPACE_POD, payload),
  createAgentMailWorkspacePod: (payload: { workspaceId: string; podName?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_CREATE_WORKSPACE_POD, payload),
  listAgentMailInboxes: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_LIST_INBOXES, workspaceId),
  createAgentMailInbox: (payload: {
    workspaceId: string;
    username?: string;
    domain?: string;
    displayName?: string;
    clientId?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_CREATE_INBOX, payload),
  updateAgentMailInbox: (payload: {
    workspaceId: string;
    inboxId: string;
    displayName: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_UPDATE_INBOX, payload),
  deleteAgentMailInbox: (payload: { workspaceId: string; inboxId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_DELETE_INBOX, payload),
  listAgentMailDomains: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_LIST_DOMAINS, workspaceId),
  createAgentMailDomain: (payload: {
    workspaceId: string;
    domain: string;
    feedbackEnabled?: boolean;
  }) => ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_CREATE_DOMAIN, payload),
  verifyAgentMailDomain: (payload: { workspaceId: string; domainId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_VERIFY_DOMAIN, payload),
  deleteAgentMailDomain: (payload: { workspaceId: string; domainId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_DELETE_DOMAIN, payload),
  listAgentMailListEntries: (payload: {
    workspaceId: string;
    inboxId?: string;
    direction?: AgentMailListEntry["direction"];
    listType?: AgentMailListEntry["listType"];
  }) => ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_LIST_LIST_ENTRIES, payload),
  createAgentMailListEntry: (payload: {
    workspaceId: string;
    inboxId?: string;
    direction: AgentMailListEntry["direction"];
    listType: AgentMailListEntry["listType"];
    entry: string;
    reason?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_CREATE_LIST_ENTRY, payload),
  deleteAgentMailListEntry: (payload: {
    workspaceId: string;
    inboxId?: string;
    direction: AgentMailListEntry["direction"];
    listType: AgentMailListEntry["listType"];
    entry: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_DELETE_LIST_ENTRY, payload),
  listAgentMailInboxApiKeys: (payload: { workspaceId: string; inboxId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_LIST_INBOX_API_KEYS, payload),
  createAgentMailInboxApiKey: (payload: {
    workspaceId: string;
    inboxId: string;
    name?: string;
    permissions?: Record<string, boolean>;
  }) => ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_CREATE_INBOX_API_KEY, payload),
  deleteAgentMailInboxApiKey: (payload: {
    workspaceId: string;
    inboxId: string;
    apiKeyId: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_DELETE_INBOX_API_KEY, payload),
  refreshAgentMailWorkspace: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_REFRESH_WORKSPACE, workspaceId),

  // Dropbox Settings APIs
  getDropboxSettings: () => ipcRenderer.invoke(IPC_CHANNELS.DROPBOX_GET_SETTINGS),
  saveDropboxSettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.DROPBOX_SAVE_SETTINGS, settings),
  testDropboxConnection: () => ipcRenderer.invoke(IPC_CHANNELS.DROPBOX_TEST_CONNECTION),
  getDropboxStatus: () => ipcRenderer.invoke(IPC_CHANNELS.DROPBOX_GET_STATUS),

  // SharePoint Settings APIs
  getSharePointSettings: () => ipcRenderer.invoke(IPC_CHANNELS.SHAREPOINT_GET_SETTINGS),
  saveSharePointSettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHAREPOINT_SAVE_SETTINGS, settings),
  testSharePointConnection: () => ipcRenderer.invoke(IPC_CHANNELS.SHAREPOINT_TEST_CONNECTION),
  getSharePointStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SHAREPOINT_GET_STATUS),

  // Health Platform APIs
  getHealthDashboard: () => ipcRenderer.invoke(IPC_CHANNELS.HEALTH_GET_DASHBOARD),
  listHealthSources: () => ipcRenderer.invoke(IPC_CHANNELS.HEALTH_LIST_SOURCES),
  upsertHealthSource: (source: HealthSourceInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.HEALTH_UPSERT_SOURCE, source),
  removeHealthSource: (sourceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.HEALTH_REMOVE_SOURCE, sourceId),
  syncHealthSource: (sourceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.HEALTH_SYNC_SOURCE, sourceId),
  importHealthFiles: (sourceId: string, filePaths: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.HEALTH_IMPORT_FILES, { sourceId, filePaths }),
  generateHealthWorkflow: (request: HealthWorkflowRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.HEALTH_GENERATE_WORKFLOW, request),
  getAppleHealthStatus: (sourceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.HEALTH_APPLE_STATUS, sourceId),
  connectAppleHealth: (payload: {
    sourceId?: string;
    connectionMode?: HealthSourceConnectionMode;
  }) => ipcRenderer.invoke(IPC_CHANNELS.HEALTH_APPLE_CONNECT, payload),
  disconnectAppleHealth: (sourceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.HEALTH_APPLE_DISCONNECT, sourceId),
  resetAppleHealth: (sourceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.HEALTH_APPLE_RESET, sourceId),
  previewAppleHealthWriteback: (request: HealthWritebackRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.HEALTH_APPLE_PREVIEW_WRITEBACK, request),
  applyAppleHealthWriteback: (request: HealthWritebackRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.HEALTH_APPLE_APPLY_WRITEBACK, request),

  // App Update APIs
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION),
  checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.APP_CHECK_UPDATES),
  downloadUpdate: (updateInfo: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_DOWNLOAD_UPDATE, updateInfo),
  installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.APP_INSTALL_UPDATE),

  // Update event listeners
  onUpdateProgress: (callback: (progress: Any) => void) => {
    const subscription = (_: Any, data: Any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.APP_UPDATE_PROGRESS, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_UPDATE_PROGRESS, subscription);
  },
  onUpdateDownloaded: (callback: (info: Any) => void) => {
    const subscription = (_: Any, data: Any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.APP_UPDATE_DOWNLOADED, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_UPDATE_DOWNLOADED, subscription);
  },
  onUpdateError: (callback: (error: Any) => void) => {
    const subscription = (_: Any, data: Any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.APP_UPDATE_ERROR, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_UPDATE_ERROR, subscription);
  },

  // Guardrail Settings APIs
  getGuardrailSettings: () => ipcRenderer.invoke(IPC_CHANNELS.GUARDRAIL_GET_SETTINGS),
  saveGuardrailSettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.GUARDRAIL_SAVE_SETTINGS, settings),
  getGuardrailDefaults: () => ipcRenderer.invoke(IPC_CHANNELS.GUARDRAIL_GET_DEFAULTS),

  // Permission Settings APIs
  getPermissionSettings: () => ipcRenderer.invoke(IPC_CHANNELS.PERMISSIONS_GET_SETTINGS),
  savePermissionSettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.PERMISSIONS_SAVE_SETTINGS, settings),
  getWorkspacePermissionRules: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PERMISSIONS_GET_WORKSPACE_RULES, workspaceId),
  deleteWorkspacePermissionRule: (payload: { workspaceId: string; ruleId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PERMISSIONS_DELETE_WORKSPACE_RULE, payload),

  // Appearance Settings APIs
  getAppearanceSettings: () => ipcRenderer.invoke(IPC_CHANNELS.APPEARANCE_GET_SETTINGS),
  saveAppearanceSettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.APPEARANCE_SAVE_SETTINGS, settings),
  getAppearanceRuntimeInfo: () => ipcRenderer.invoke(IPC_CHANNELS.APPEARANCE_GET_RUNTIME_INFO),

  // Personality Settings APIs
  getPersonalitySettings: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_GET_SETTINGS),
  savePersonalitySettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_SAVE_SETTINGS, settings),
  getPersonalityDefinitions: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_GET_DEFINITIONS),
  getPersonaDefinitions: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_GET_PERSONAS),
  getRelationshipStats: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_GET_RELATIONSHIP_STATS),
  setActivePersonality: (personalityId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_SET_ACTIVE, personalityId),
  setActivePersona: (personaId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_SET_PERSONA, personaId),
  resetPersonalitySettings: (preserveRelationship?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_RESET, preserveRelationship),
  getPersonalityConfigV2: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_GET_CONFIG_V2),
  savePersonalityConfigV2: (config: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_SAVE_CONFIG_V2, config),
  exportPersonalityProfile: (format?: "json" | "md") =>
    ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_EXPORT, format),
  importPersonalityProfile: (data: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_IMPORT, data),
  getPersonalityPreview: (draft: Any, contextMode?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_PREVIEW, draft, contextMode),
  getPersonalityTraitPresets: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_GET_TRAIT_PRESETS),
  onPersonalitySettingsChanged: (callback: (settings: Any) => void) => {
    const subscription = (_: Any, data: Any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.PERSONALITY_SETTINGS_CHANGED, subscription);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.PERSONALITY_SETTINGS_CHANGED, subscription);
  },

  // Queue APIs
  getQueueStatus: () => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_GET_STATUS),
  getQueueSettings: () => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_GET_SETTINGS),
  saveQueueSettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.QUEUE_SAVE_SETTINGS, settings),
  clearQueue: () => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_CLEAR),
  onQueueUpdate: (callback: (status: Any) => void) => {
    const subscription = (_: Any, data: Any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.QUEUE_UPDATE, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.QUEUE_UPDATE, subscription);
  },

  // Custom Skills APIs
  listCustomSkills: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_LIST),
  listTaskSkills: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_LIST_TASKS),
  listGuidelineSkills: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_LIST_GUIDELINES),
  getCustomSkill: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_GET, id),
  createCustomSkill: (skill: Any) => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_CREATE, skill),
  updateCustomSkill: (id: string, updates: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_UPDATE, id, updates),
  deleteCustomSkill: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_DELETE, id),
  reloadCustomSkills: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_RELOAD),
  openCustomSkillsFolder: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_OPEN_FOLDER),
  getCustomSkillSettings: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_GET_SETTINGS),
  setExternalSkillDirectories: (dirs: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_SET_EXTERNAL_DIRS, dirs),
  openExternalSkillFolder: (dir: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_OPEN_EXTERNAL_FOLDER, dir),

  // Skill Registry (SkillHub) APIs
  searchSkillRegistry: (query: string, options?: { page?: number; pageSize?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_SEARCH, query, options),
  searchClawHubSkills: (query: string, options?: { page?: number; pageSize?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_CLAWHUB_SEARCH, query, options),
  getSkillDetails: (skillId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_GET_DETAILS, skillId),
  installSkillFromRegistry: (skillId: string, version?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_INSTALL, skillId, version),
  installSkillFromClawHub: (identifierOrUrl: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_INSTALL_CLAWHUB, identifierOrUrl),
  installSkillFromUrl: (url: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_INSTALL_URL, url),
  installSkillFromGit: (gitUrl: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_INSTALL_GIT, gitUrl),
  updateSkillFromRegistry: (skillId: string, version?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_UPDATE, skillId, version),
  updateAllSkills: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_UPDATE_ALL),
  uninstallSkill: (skillId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_UNINSTALL, skillId),
  listManagedSkills: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_LIST_MANAGED),
  checkSkillUpdates: (skillId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_CHECK_UPDATES, skillId),
  getSkillStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_GET_STATUS),
  getEligibleSkills: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_GET_ELIGIBLE),

  // MCP (Model Context Protocol) APIs
  getMCPSettings: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_SETTINGS),
  saveMCPSettings: (settings: Any) => ipcRenderer.invoke(IPC_CHANNELS.MCP_SAVE_SETTINGS, settings),
  addMCPServer: (config: Any) => ipcRenderer.invoke(IPC_CHANNELS.MCP_ADD_SERVER, config),
  updateMCPServer: (id: string, updates: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_UPDATE_SERVER, id, updates),
  removeMCPServer: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_REMOVE_SERVER, id),
  connectMCPServer: (serverId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_CONNECT_SERVER, serverId),
  disconnectMCPServer: (serverId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_DISCONNECT_SERVER, serverId),
  getMCPStatus: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_STATUS),
  getMCPServerStatus: (serverId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_SERVER_STATUS, serverId),
  getMCPAllTools: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_ALL_TOOLS),
  getMCPServerTools: (serverId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_SERVER_TOOLS, serverId),
  testMCPServer: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_TEST_SERVER, serverId),

  // MCP Connector OAuth
  startConnectorOAuth: (payload: {
    provider:
      | "salesforce"
      | "jira"
      | "hubspot"
      | "zendesk"
      | "google-calendar"
      | "google-drive"
      | "gmail"
      | "google-workspace"
      | "docusign"
      | "outreach"
      | "slack"
      | "microsoft-email";
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    loginUrl?: string;
    subdomain?: string;
    teamDomain?: string;
    tenant?: string;
    loginHint?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MCP_CONNECTOR_OAUTH_START, payload),

  // MCP Status change event listener
  onMCPStatusChange: (callback: (status: Any[]) => void) => {
    const subscription = (_: Any, data: Any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.MCP_SERVER_STATUS_CHANGE, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MCP_SERVER_STATUS_CHANGE, subscription);
  },

  // MCP Registry APIs
  fetchMCPRegistry: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_REGISTRY_FETCH),
  searchMCPRegistry: (query: string, tags?: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_REGISTRY_SEARCH, { query, tags }),
  installMCPServer: (entryId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_REGISTRY_INSTALL, entryId),
  uninstallMCPServer: (serverId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_REGISTRY_UNINSTALL, serverId),
  checkMCPUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_REGISTRY_CHECK_UPDATES),
  updateMCPServerFromRegistry: (serverId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_REGISTRY_UPDATE_SERVER, serverId),

  // MCP Host APIs
  startMCPHost: (port?: number) => ipcRenderer.invoke(IPC_CHANNELS.MCP_HOST_START, port),
  stopMCPHost: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_HOST_STOP),
  getMCPHostStatus: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_HOST_GET_STATUS),

  // Infrastructure APIs
  infraGetStatus: () => ipcRenderer.invoke(IPC_CHANNELS.INFRA_GET_STATUS),
  infraGetSettings: () => ipcRenderer.invoke(IPC_CHANNELS.INFRA_GET_SETTINGS),
  infraSaveSettings: (settings: InfraSettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.INFRA_SAVE_SETTINGS, settings),
  infraSetup: () => ipcRenderer.invoke(IPC_CHANNELS.INFRA_SETUP),
  infraGetWallet: () => ipcRenderer.invoke(IPC_CHANNELS.INFRA_GET_WALLET),
  infraWalletRestore: () => ipcRenderer.invoke(IPC_CHANNELS.INFRA_WALLET_RESTORE),
  infraWalletVerify: () => ipcRenderer.invoke(IPC_CHANNELS.INFRA_WALLET_VERIFY),
  infraReset: () => ipcRenderer.invoke(IPC_CHANNELS.INFRA_RESET),
  onInfraStatusChange: (callback: (status: InfraStatus) => void) => {
    const subscription = (_: unknown, status: InfraStatus) => callback(status);
    ipcRenderer.on(IPC_CHANNELS.INFRA_STATUS_CHANGE, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.INFRA_STATUS_CHANGE, subscription);
  },

  // Scraping (Scrapling) APIs
  scrapingGetSettings: () => ipcRenderer.invoke(IPC_CHANNELS.SCRAPING_GET_SETTINGS),
  scrapingSaveSettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.SCRAPING_SAVE_SETTINGS, settings),
  scrapingGetStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SCRAPING_GET_STATUS),
  scrapingReset: () => ipcRenderer.invoke(IPC_CHANNELS.SCRAPING_RESET),

  // Built-in Tools Settings APIs
  getBuiltinToolsSettings: () => ipcRenderer.invoke(IPC_CHANNELS.BUILTIN_TOOLS_GET_SETTINGS),
  saveBuiltinToolsSettings: (settings: BuiltinToolsSettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.BUILTIN_TOOLS_SAVE_SETTINGS, settings),
  getBuiltinToolsCategories: () => ipcRenderer.invoke(IPC_CHANNELS.BUILTIN_TOOLS_GET_CATEGORIES),
  getChronicleSettings: () => ipcRenderer.invoke(IPC_CHANNELS.CHRONICLE_GET_SETTINGS),
  saveChronicleSettings: (settings: Partial<ChronicleSettings>) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHRONICLE_SAVE_SETTINGS, settings),
  getChronicleStatus: () => ipcRenderer.invoke(IPC_CHANNELS.CHRONICLE_GET_STATUS),
  queryChronicleRecentContext: (input: {
    query: string;
    limit?: number;
    useFallback?: boolean;
  }) => ipcRenderer.invoke(IPC_CHANNELS.CHRONICLE_QUERY_RECENT_CONTEXT, input),
  listChronicleObservations: (input: { workspaceId: string; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHRONICLE_LIST_OBSERVATIONS, input),
  deleteChronicleObservation: (input: { workspaceId: string; observationId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHRONICLE_DELETE_OBSERVATION, input),
  clearChronicleObservations: (input: { workspaceId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHRONICLE_CLEAR_OBSERVATIONS, input),

  getComputerUseStatus: () => ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_USE_GET_STATUS),
  endComputerUseSession: () => ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_USE_END_SESSION),
  openComputerUseAccessibilitySettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_USE_OPEN_ACCESSIBILITY),
  openComputerUseScreenRecordingSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_USE_OPEN_SCREEN_RECORDING),
  onComputerUseEvent: (callback: (event: Any) => void) => {
    const channel = IPC_CHANNELS.COMPUTER_USE_EVENT;
    const listener = (_e: Any, payload: Any) => callback(payload);
    ipcRenderer.on(channel, listener);
    return () => ipcRenderer.removeListener(channel, listener);
  },

  // Tray (Menu Bar) APIs
  getTraySettings: () => ipcRenderer.invoke(IPC_CHANNELS.TRAY_GET_SETTINGS),
  saveTraySettings: (settings: Partial<TraySettings>) =>
    ipcRenderer.invoke(IPC_CHANNELS.TRAY_SAVE_SETTINGS, settings),

  // Tray event listeners (for renderer to respond to tray actions)
  onTrayNewTask: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.TRAY_NEW_TASK, callback);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TRAY_NEW_TASK, callback);
  },
  onTraySelectWorkspace: (callback: (event: Any, workspaceId: string) => void) => {
    ipcRenderer.on(IPC_CHANNELS.TRAY_SELECT_WORKSPACE, callback);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TRAY_SELECT_WORKSPACE, callback);
  },
  onTrayOpenSettings: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.TRAY_OPEN_SETTINGS, callback);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TRAY_OPEN_SETTINGS, callback);
  },
  onTrayOpenAbout: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.TRAY_OPEN_ABOUT, callback);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TRAY_OPEN_ABOUT, callback);
  },
  onTrayCheckUpdates: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.TRAY_CHECK_UPDATES, callback);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TRAY_CHECK_UPDATES, callback);
  },
  onTrayQuickTask: (
    callback: (event: Any, data: { task: string; workspaceId?: string }) => void,
  ) => {
    ipcRenderer.on(IPC_CHANNELS.TRAY_QUICK_TASK, callback);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TRAY_QUICK_TASK, callback);
  },

  // Quick Input APIs (for the floating quick input window)
  quickInputSubmit: (task: string, workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.QUICK_INPUT_SUBMIT, task, workspaceId),
  quickInputClose: () => ipcRenderer.invoke(IPC_CHANNELS.QUICK_INPUT_CLOSE),

  // Cron (Scheduled Tasks) APIs
  getCronStatus: () => ipcRenderer.invoke(IPC_CHANNELS.CRON_GET_STATUS),
  listCronJobs: (opts?: { includeDisabled?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CRON_LIST_JOBS, opts),
  getCronJob: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CRON_GET_JOB, id),
  addCronJob: (job: CronJobCreate) => ipcRenderer.invoke(IPC_CHANNELS.CRON_ADD_JOB, job),
  updateCronJob: (id: string, patch: CronJobPatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.CRON_UPDATE_JOB, id, patch),
  removeCronJob: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CRON_REMOVE_JOB, id),
  runCronJob: (id: string, mode?: "due" | "force") =>
    ipcRenderer.invoke(IPC_CHANNELS.CRON_RUN_JOB, id, mode),
  onCronEvent: (callback: (event: CronEvent) => void) => {
    const subscription = (_: Any, data: CronEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.CRON_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CRON_EVENT, subscription);
  },
  getCronRunHistory: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CRON_GET_RUN_HISTORY, id),
  clearCronRunHistory: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CRON_CLEAR_RUN_HISTORY, id),
  getCronWebhookStatus: () => ipcRenderer.invoke(IPC_CHANNELS.CRON_GET_WEBHOOK_STATUS),
  listCouncils: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_LIST, { workspaceId }) as Promise<CouncilConfig[]>,
  getCouncil: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_GET, id) as Promise<CouncilConfig | null>,
  createCouncil: (data: CreateCouncilConfigRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_CREATE, data) as Promise<CouncilConfig>,
  updateCouncil: (data: UpdateCouncilConfigRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_UPDATE, data) as Promise<CouncilConfig | null>,
  deleteCouncil: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_DELETE, id) as Promise<boolean>,
  runCouncilNow: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_RUN_NOW, id) as Promise<CouncilRun | null>,
  listCouncilRuns: (payload: { councilConfigId: string; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_LIST_RUNS, payload) as Promise<CouncilRun[]>,
  getCouncilMemo: (query: string | { id?: string; councilConfigId?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_GET_MEMO, query) as Promise<CouncilMemo | null>,
  setCouncilEnabled: (id: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.COUNCIL_SET_ENABLED, { id, enabled }) as Promise<CouncilConfig | null>,

  // Notification APIs
  listNotifications: () => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_LIST),
  addNotification: (data: {
    type: NotificationType;
    title: string;
    message: string;
    taskId?: string;
    cronJobId?: string;
    workspaceId?: string;
    suggestionId?: string;
    recommendedDelivery?: "briefing" | "inbox" | "nudge";
    companionStyle?: "email" | "note";
  }) => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_ADD, data),
  getUnreadNotificationCount: () => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_UNREAD_COUNT),
  markNotificationRead: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_MARK_READ, id),
  markAllNotificationsRead: () => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_MARK_ALL_READ),
  deleteNotification: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_DELETE, id),
  deleteAllNotifications: () => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_DELETE_ALL),
  onNotificationEvent: (callback: (event: NotificationEvent) => void) => {
    const subscription = (_: Any, data: NotificationEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.NOTIFICATION_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.NOTIFICATION_EVENT, subscription);
  },
  onNavigateToTask: (callback: (taskId: string) => void) => {
    const subscription = (_: Any, taskId: string) => callback(taskId);
    ipcRenderer.on(IPC_CHANNELS.NAVIGATE_TO_TASK, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.NAVIGATE_TO_TASK, subscription);
  },

  // Hooks (Webhooks & Gmail Pub/Sub) APIs
  getHooksSettings: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_GET_SETTINGS),
  saveHooksSettings: (settings: Partial<HooksSettings>) =>
    ipcRenderer.invoke(IPC_CHANNELS.HOOKS_SAVE_SETTINGS, settings),
  enableHooks: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_ENABLE),
  disableHooks: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_DISABLE),
  regenerateHookToken: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_REGENERATE_TOKEN),
  getHooksStatus: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_GET_STATUS),
  addHookMapping: (mapping: HookMapping) =>
    ipcRenderer.invoke(IPC_CHANNELS.HOOKS_ADD_MAPPING, mapping),
  removeHookMapping: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_REMOVE_MAPPING, id),
  configureGmailHooks: (config: GmailHooksConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.HOOKS_CONFIGURE_GMAIL, config),
  getGmailHooksStatus: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_GET_GMAIL_STATUS),
  startGmailWatcher: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_START_GMAIL_WATCHER),
  stopGmailWatcher: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_STOP_GMAIL_WATCHER),
  onHooksEvent: (callback: (event: HooksEvent) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: HooksEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.HOOKS_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.HOOKS_EVENT, subscription);
  },

  // Control Plane (WebSocket Gateway)
  getControlPlaneSettings: () => ipcRenderer.invoke(IPC_CHANNELS.CONTROL_PLANE_GET_SETTINGS),
  saveControlPlaneSettings: (settings: ControlPlaneSettingsData) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONTROL_PLANE_SAVE_SETTINGS, settings),
  enableControlPlane: () => ipcRenderer.invoke(IPC_CHANNELS.CONTROL_PLANE_ENABLE),
  disableControlPlane: () => ipcRenderer.invoke(IPC_CHANNELS.CONTROL_PLANE_DISABLE),
  startControlPlane: () => ipcRenderer.invoke(IPC_CHANNELS.CONTROL_PLANE_START),
  stopControlPlane: () => ipcRenderer.invoke(IPC_CHANNELS.CONTROL_PLANE_STOP),
  getControlPlaneStatus: () => ipcRenderer.invoke(IPC_CHANNELS.CONTROL_PLANE_GET_STATUS),
  getControlPlaneToken: () => ipcRenderer.invoke(IPC_CHANNELS.CONTROL_PLANE_GET_TOKEN),
  regenerateControlPlaneToken: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CONTROL_PLANE_REGENERATE_TOKEN),
  onControlPlaneEvent: (callback: (event: ControlPlaneEvent) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: ControlPlaneEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.CONTROL_PLANE_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CONTROL_PLANE_EVENT, subscription);
  },

  // Tailscale
  checkTailscaleAvailability: () => ipcRenderer.invoke(IPC_CHANNELS.TAILSCALE_CHECK_AVAILABILITY),
  getTailscaleStatus: () => ipcRenderer.invoke(IPC_CHANNELS.TAILSCALE_GET_STATUS),
  setTailscaleMode: (mode: TailscaleMode) =>
    ipcRenderer.invoke(IPC_CHANNELS.TAILSCALE_SET_MODE, mode),

  // Remote Gateway
  connectRemoteGateway: (config?: RemoteGatewayConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.REMOTE_GATEWAY_CONNECT, config),
  disconnectRemoteGateway: () => ipcRenderer.invoke(IPC_CHANNELS.REMOTE_GATEWAY_DISCONNECT),
  getRemoteGatewayStatus: () => ipcRenderer.invoke(IPC_CHANNELS.REMOTE_GATEWAY_GET_STATUS),
  saveRemoteGatewayConfig: (config: RemoteGatewayConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.REMOTE_GATEWAY_SAVE_CONFIG, config),
  testRemoteGatewayConnection: (config: RemoteGatewayConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.REMOTE_GATEWAY_TEST_CONNECTION, config),
  onRemoteGatewayEvent: (callback: (event: RemoteGatewayEvent) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: RemoteGatewayEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.REMOTE_GATEWAY_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.REMOTE_GATEWAY_EVENT, subscription);
  },

  // SSH Tunnel
  connectSSHTunnel: (config: SSHTunnelConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_CONNECT, config),
  disconnectSSHTunnel: () => ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_DISCONNECT),
  getSSHTunnelStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_GET_STATUS),
  saveSSHTunnelConfig: (config: SSHTunnelConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_SAVE_CONFIG, config),
  testSSHTunnelConnection: (config: SSHTunnelConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_TEST_CONNECTION, config),
  onSSHTunnelEvent: (callback: (event: SSHTunnelEvent) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: SSHTunnelEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SSH_TUNNEL_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SSH_TUNNEL_EVENT, subscription);
  },

  // Device Fleet
  listManagedDevices: () => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_LIST_MANAGED),
  getDeviceSummary: (deviceId: string) => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_GET_SUMMARY, deviceId),
  connectDevice: (deviceId: string) => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_CONNECT, deviceId),
  disconnectDevice: (deviceId: string) => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_DISCONNECT, deviceId),
  deviceProxyRequest: (request: DeviceProxyRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.DEVICE_PROXY_REQUEST, request),

  // Live Canvas APIs
  canvasCreate: (data: { taskId: string; workspaceId: string; title?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_CREATE, data),
  canvasGetSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_GET_SESSION, sessionId),
  canvasListSessions: (taskId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_LIST_SESSIONS, taskId),
  canvasShow: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.CANVAS_SHOW, sessionId),
  canvasHide: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.CANVAS_HIDE, sessionId),
  canvasClose: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.CANVAS_CLOSE, sessionId),
  canvasPush: (data: { sessionId: string; content: string; filename?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_PUSH, data),
  canvasEval: (data: { sessionId: string; script: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_EVAL, data),
  canvasSnapshot: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_SNAPSHOT, sessionId),
  canvasExportHTML: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_EXPORT_HTML, sessionId),
  canvasExportToFolder: (data: { sessionId: string; targetDir: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_EXPORT_TO_FOLDER, data),
  canvasOpenInBrowser: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_OPEN_IN_BROWSER, sessionId),
  canvasOpenUrl: (data: { sessionId: string; url: string; show?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_OPEN_URL, data),
  canvasGetSessionDir: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_GET_SESSION_DIR, sessionId),
  canvasCheckpointSave: (data: { sessionId: string; label?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_CHECKPOINT_SAVE, data),
  canvasCheckpointList: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_CHECKPOINT_LIST, sessionId),
  canvasCheckpointRestore: (data: { sessionId: string; checkpointId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_CHECKPOINT_RESTORE, data),
  canvasCheckpointDelete: (data: { sessionId: string; checkpointId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_CHECKPOINT_DELETE, data),
  canvasGetContent: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_GET_CONTENT, sessionId),
  onCanvasEvent: (callback: (event: CanvasEvent) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: CanvasEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.CANVAS_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CANVAS_EVENT, subscription);
  },

  // Mobile Companion Nodes
  nodeList: () => ipcRenderer.invoke(IPC_CHANNELS.NODE_LIST),
  nodeGet: (nodeId: string) => ipcRenderer.invoke(IPC_CHANNELS.NODE_GET, nodeId),
  nodeInvoke: (params: {
    nodeId: string;
    command: string;
    params?: Record<string, unknown>;
    timeoutMs?: number;
  }) => ipcRenderer.invoke(IPC_CHANNELS.NODE_INVOKE, params),
  onNodeEvent: (
    callback: (event: { type: string; nodeId: string; node?: Any; timestamp: number }) => void,
  ) => {
    const subscription = (_: Electron.IpcRendererEvent, data: Any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.NODE_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.NODE_EVENT, subscription);
  },

  // Device Management APIs
  deviceListTasks: (nodeId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DEVICE_LIST_TASKS, nodeId),
  deviceListFiles: (params: { nodeId: string; workspaceId: string; path?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.DEVICE_LIST_FILES, params),
  deviceListRemoteWorkspaces: (nodeId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DEVICE_LIST_REMOTE_WORKSPACES, nodeId),
  deviceAssignTask: (params: {
    nodeId: string;
    prompt: string;
    workspaceId?: string;
    agentConfig?: Any;
    shellAccess?: boolean;
  }) => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_ASSIGN_TASK, params),
  deviceGetProfiles: () => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_GET_PROFILES),
  deviceUpdateProfile: (deviceId: string, data: { customName?: string; platform?: string; modelIdentifier?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.DEVICE_UPDATE_PROFILE, deviceId, data),

  // Memory System APIs
  getMemorySettings: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_SETTINGS, workspaceId),
  saveMemorySettings: (data: { workspaceId: string; settings: Partial<MemorySettings> }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SAVE_SETTINGS, data),
  searchMemories: (data: { workspaceId: string; query: string; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SEARCH, data),
  getMemoryTimeline: (data: { memoryId: string; windowSize?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_TIMELINE, data),
  getMemoryDetails: (ids: string[]) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_DETAILS, ids),
  getRecentMemories: (data: { workspaceId: string; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_RECENT, data),
  getMemoryStats: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_STATS, workspaceId),
  clearMemory: (workspaceId: string) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CLEAR, workspaceId),
  onMemoryEvent: (callback: (event: { type: string; workspaceId: string }) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: Any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.MEMORY_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MEMORY_EVENT, subscription);
  },

  // Imported Memory APIs
  getImportedMemoryStats: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_IMPORTED_STATS, workspaceId),
  findImportedMemories: (data: { workspaceId: string; limit?: number; offset?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FIND_IMPORTED, data),
  deleteImportedMemories: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DELETE_IMPORTED, workspaceId),
  deleteImportedMemoryEntry: (data: { workspaceId: string; memoryId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DELETE_IMPORTED_ENTRY, data),
  setImportedMemoryPromptRecallIgnored: (data: {
    workspaceId: string;
    memoryId: string;
    ignored: boolean;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SET_IMPORTED_RECALL_IGNORED, data),
  getUserProfile: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_USER_PROFILE),
  addUserFact: (data: {
    category: UserFactCategory;
    value: string;
    confidence?: number;
    source?: "conversation" | "feedback" | "manual";
    pinned?: boolean;
    taskId?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_ADD_USER_FACT, data),
  updateUserFact: (data: {
    id: string;
    category?: UserFactCategory;
    value?: string;
    confidence?: number;
    pinned?: boolean;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_UPDATE_USER_FACT, data),
  deleteUserFact: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_DELETE_USER_FACT, id),
  listRelationshipMemory: (data?: {
    layer?: "identity" | "preferences" | "context" | "history" | "commitments";
    includeDone?: boolean;
    limit?: number;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_RELATIONSHIP_LIST, data || {}),
  updateRelationshipMemory: (data: {
    id: string;
    text?: string;
    confidence?: number;
    status?: "open" | "done";
    dueAt?: number | null;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_RELATIONSHIP_UPDATE, data),
  deleteRelationshipMemory: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_RELATIONSHIP_DELETE, id),
  cleanupRecurringRelationshipHistory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_RELATIONSHIP_CLEANUP_RECURRING),
  getOpenCommitments: (limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_COMMITMENTS_GET, { limit }),
  getDueSoonCommitments: (windowHours?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_COMMITMENTS_DUE_SOON, { windowHours }),
  getAwarenessConfig: () => ipcRenderer.invoke(IPC_CHANNELS.AWARENESS_GET_CONFIG),
  saveAwarenessConfig: (config: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.AWARENESS_SAVE_CONFIG, config),
  listAwarenessBeliefs: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AWARENESS_LIST_BELIEFS, workspaceId),
  updateAwarenessBelief: (id: string, patch: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.AWARENESS_UPDATE_BELIEF, { id, patch }),
  deleteAwarenessBelief: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AWARENESS_DELETE_BELIEF, id),
  getAwarenessSummary: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AWARENESS_GET_SUMMARY, workspaceId),
  getAwarenessSnapshot: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AWARENESS_GET_SNAPSHOT, workspaceId),
  listAwarenessEvents: (params?: { workspaceId?: string; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.AWARENESS_LIST_EVENTS, params),
  getAutonomyConfig: () => ipcRenderer.invoke(IPC_CHANNELS.AUTONOMY_GET_CONFIG),
  saveAutonomyConfig: (config: Any) => ipcRenderer.invoke(IPC_CHANNELS.AUTONOMY_SAVE_CONFIG, config),
  getAutonomyState: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTONOMY_GET_STATE, workspaceId),
  listAutonomyDecisions: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTONOMY_LIST_DECISIONS, workspaceId),
  listAutonomyActions: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTONOMY_LIST_ACTIONS, workspaceId),
  updateAutonomyDecision: (id: string, patch: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTONOMY_UPDATE_DECISION, { id, patch }),
  triggerAutonomyEvaluation: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTONOMY_TRIGGER_EVALUATION, workspaceId),

  // Memory Features APIs
  getMemoryFeaturesSettings: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FEATURES_GET_SETTINGS),
  saveMemoryFeaturesSettings: (settings: MemoryFeaturesSettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FEATURES_SAVE_SETTINGS, settings),
  getMemoryLayerPreview: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FEATURES_GET_LAYER_PREVIEW, workspaceId),
  getSupermemorySettings: () => ipcRenderer.invoke(IPC_CHANNELS.SUPERMEMORY_GET_SETTINGS),
  saveSupermemorySettings: (settings: SupermemorySettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUPERMEMORY_SAVE_SETTINGS, settings),
  testSupermemoryConnection: () => ipcRenderer.invoke(IPC_CHANNELS.SUPERMEMORY_TEST_CONNECTION),
  getSupermemoryStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SUPERMEMORY_GET_STATUS),

  // Self-improvement loop APIs
  getImprovementSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPROVEMENT_GET_SETTINGS) as Promise<ImprovementLoopSettings>,
  getImprovementEligibility: () =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPROVEMENT_GET_ELIGIBILITY) as Promise<ImprovementEligibility>,
  saveImprovementOwnerEnrollment: (token: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPROVEMENT_SAVE_OWNER_ENROLLMENT, token) as Promise<ImprovementEligibility>,
  clearImprovementOwnerEnrollment: () =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPROVEMENT_CLEAR_OWNER_ENROLLMENT) as Promise<ImprovementEligibility>,
  saveImprovementSettings: (settings: ImprovementLoopSettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPROVEMENT_SAVE_SETTINGS, settings) as Promise<ImprovementLoopSettings>,
  listImprovementCandidates: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPROVEMENT_LIST_CANDIDATES, workspaceId) as Promise<
      ImprovementCandidate[]
    >,
  listImprovementCampaigns: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPROVEMENT_LIST_RUNS, workspaceId) as Promise<ImprovementCampaign[]>,
  refreshImprovementCandidates: () =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPROVEMENT_REFRESH) as Promise<{ candidateCount: number }>,
  runNextImprovementExperiment: () =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPROVEMENT_RUN_NEXT) as Promise<ImprovementCampaign | null>,
  resetImprovementHistory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPROVEMENT_RESET_HISTORY) as Promise<ImprovementHistoryResetResult>,
  retryImprovementCampaign: (campaignId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPROVEMENT_RETRY_RUN, campaignId) as Promise<ImprovementCampaign | null>,
  dismissImprovementCandidate: (candidateId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPROVEMENT_DISMISS_CANDIDATE, candidateId) as Promise<
      ImprovementCandidate | undefined
    >,
  reviewImprovementCampaign: (campaignId: string, reviewStatus: "accepted" | "dismissed") =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPROVEMENT_REVIEW_RUN, campaignId, reviewStatus) as Promise<
      ImprovementCampaign | undefined
    >,

  // Subconscious loop APIs
  getSubconsciousSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBCONSCIOUS_GET_SETTINGS) as Promise<SubconsciousSettings>,
  saveSubconsciousSettings: (settings: SubconsciousSettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBCONSCIOUS_SAVE_SETTINGS, settings) as Promise<SubconsciousSettings>,
  getSubconsciousBrain: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBCONSCIOUS_GET_BRAIN) as Promise<SubconsciousBrainSummary>,
  listSubconsciousTargets: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBCONSCIOUS_LIST_TARGETS, workspaceId) as Promise<
      SubconsciousTargetSummary[]
    >,
  listSubconsciousRuns: (targetKey?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBCONSCIOUS_LIST_RUNS, targetKey) as Promise<SubconsciousRun[]>,
  getSubconsciousTargetDetail: (targetKey: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBCONSCIOUS_GET_TARGET_DETAIL, targetKey) as Promise<
      SubconsciousTargetDetail | null
    >,
  refreshSubconsciousTargets: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBCONSCIOUS_REFRESH) as Promise<SubconsciousRefreshResult>,
  runSubconsciousNow: (targetKey?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBCONSCIOUS_RUN_NOW, targetKey) as Promise<SubconsciousRun | null>,
  retrySubconsciousRun: (runId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBCONSCIOUS_RETRY_RUN, runId) as Promise<SubconsciousRun | null>,
  reviewSubconsciousRun: (runId: string, reviewStatus: "accepted" | "dismissed") =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBCONSCIOUS_REVIEW_RUN, runId, reviewStatus) as Promise<
      SubconsciousRun | undefined
    >,
  dismissSubconsciousTarget: (targetKey: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBCONSCIOUS_DISMISS_TARGET, targetKey) as Promise<
      SubconsciousTargetSummary | undefined
    >,
  resetSubconsciousHistory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBCONSCIOUS_RESET_HISTORY) as Promise<SubconsciousHistoryResetResult>,

  // Workspace Kit (.cowork) APIs
  getWorkspaceKitStatus: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.KIT_GET_STATUS, workspaceId) as Promise<WorkspaceKitStatus>,
  initWorkspaceKit: (request: WorkspaceKitInitRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.KIT_INIT, request) as Promise<WorkspaceKitStatus>,
  applyOnboardingProfile: (request: ApplyOnboardingProfileRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.KIT_APPLY_ONBOARDING_PROFILE, request) as Promise<ApplyOnboardingProfileResult>,
  createWorkspaceKitProject: (request: WorkspaceKitProjectCreateRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.KIT_PROJECT_CREATE, request) as Promise<{
      success: boolean;
      projectId: string;
    }>,
  openWorkspaceKitFile: (args: { workspaceId: string; relPath: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.KIT_OPEN_FILE, args) as Promise<boolean>,
  resetAdaptiveStyle: () =>
    ipcRenderer.invoke(IPC_CHANNELS.KIT_RESET_ADAPTIVE_STYLE) as Promise<void>,
  submitMessageFeedback: (payload: {
    taskId: string;
    messageId?: string;
    decision: "accepted" | "rejected";
    reason?: string;
    note?: string;
    kind?: "message" | "task";
  }) => ipcRenderer.invoke(IPC_CHANNELS.KIT_SUBMIT_MESSAGE_FEEDBACK, payload) as Promise<void>,

  // ChatGPT Import APIs
  importChatGPT: (options: ChatGPTImportOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_IMPORT_CHATGPT, options),
  onChatGPTImportProgress: (callback: (progress: ChatGPTImportProgress) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: ChatGPTImportProgress) =>
      callback(data);
    ipcRenderer.on(IPC_CHANNELS.MEMORY_IMPORT_CHATGPT_PROGRESS, subscription);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.MEMORY_IMPORT_CHATGPT_PROGRESS, subscription);
  },
  cancelChatGPTImport: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_IMPORT_CHATGPT_CANCEL) as Promise<{
      cancelled: boolean;
    }>,
  importMemoryFromText: (options: TextMemoryImportOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_IMPORT_TEXT, options) as Promise<TextMemoryImportResult>,

  // Migration Status APIs
  getMigrationStatus: () => ipcRenderer.invoke(IPC_CHANNELS.MIGRATION_GET_STATUS),
  dismissMigrationNotification: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MIGRATION_DISMISS_NOTIFICATION),

  // Extensions / Plugin APIs
  getExtensions: () => ipcRenderer.invoke(IPC_CHANNELS.EXTENSIONS_LIST),
  getExtension: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.EXTENSIONS_GET, name),
  enableExtension: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.EXTENSIONS_ENABLE, name),
  disableExtension: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.EXTENSIONS_DISABLE, name),
  reloadExtension: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.EXTENSIONS_RELOAD, name),
  getExtensionConfig: (name: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXTENSIONS_GET_CONFIG, name),
  setExtensionConfig: (name: string, config: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC_CHANNELS.EXTENSIONS_SET_CONFIG, { name, config }),
  discoverExtensions: () => ipcRenderer.invoke(IPC_CHANNELS.EXTENSIONS_DISCOVER),

  // Webhook Tunnel APIs
  getTunnelStatus: () => ipcRenderer.invoke(IPC_CHANNELS.TUNNEL_GET_STATUS),
  startTunnel: (config: {
    provider: string;
    port: number;
    ngrokAuthToken?: string;
    ngrokRegion?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.TUNNEL_START, config),
  stopTunnel: () => ipcRenderer.invoke(IPC_CHANNELS.TUNNEL_STOP),

  // Agent Role (Agent Squad) APIs
  getAgentRoles: (includeInactive?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_ROLE_LIST, includeInactive),
  getAgentRole: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ROLE_GET, id),
  createAgentRole: (request: {
    name: string;
    companyId?: string;
    displayName: string;
    description?: string;
    icon?: string;
    color?: string;
    personalityId?: string;
    modelKey?: string;
    providerType?: string;
    systemPrompt?: string;
    capabilities: string[];
    toolRestrictions?: { allowedTools?: string[]; deniedTools?: string[] };
  }) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ROLE_CREATE, request),
  updateAgentRole: (request: {
    id: string;
    companyId?: string | null;
    displayName?: string;
    description?: string;
    icon?: string;
    color?: string;
    personalityId?: string;
    modelKey?: string;
    providerType?: string;
    systemPrompt?: string;
    capabilities?: string[];
    toolRestrictions?: { allowedTools?: string[]; deniedTools?: string[] };
    isActive?: boolean;
    sortOrder?: number;
  }) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ROLE_UPDATE, request),
  deleteAgentRole: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ROLE_DELETE, id),
  assignAgentRoleToTask: (taskId: string, agentRoleId: string | null) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_ROLE_ASSIGN_TO_TASK, taskId, agentRoleId),
  getDefaultAgentRoles: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ROLE_GET_DEFAULTS),
  seedDefaultAgentRoles: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ROLE_SEED_DEFAULTS),
  syncDefaultAgentRoles: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ROLE_SYNC_DEFAULTS),

  // Persona Templates (Digital Twins) APIs
  listPersonaTemplates: (filter?: { category?: string; tag?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PERSONA_TEMPLATE_LIST, filter),
  getPersonaTemplate: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.PERSONA_TEMPLATE_GET, id),
  activatePersonaTemplate: (request: {
    templateId: string;
    customization?: {
      companyId?: string;
      displayName?: string;
      icon?: string;
      color?: string;
      modelKey?: string;
      providerType?: string;
    };
  }) => ipcRenderer.invoke(IPC_CHANNELS.PERSONA_TEMPLATE_ACTIVATE, request),
  previewPersonaTemplate: (templateId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PERSONA_TEMPLATE_PREVIEW, templateId),
  getPersonaTemplateCategories: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PERSONA_TEMPLATE_GET_CATEGORIES),

  // Mission Control - Company Ops / Planner
  listCompanies: () => ipcRenderer.invoke(IPC_CHANNELS.MC_COMPANY_LIST),
  getCompany: (companyId: string) => ipcRenderer.invoke(IPC_CHANNELS.MC_COMPANY_GET, companyId),
  createCompany: (input: import("../shared/types").CompanyCreateInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_COMPANY_CREATE, input),
  updateCompany: (request: { companyId: string } & import("../shared/types").CompanyUpdate) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_COMPANY_UPDATE, request),
  listCompanyPackageSources: (companyId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_COMPANY_PACKAGE_SOURCE_LIST, companyId),
  previewCompanyPackageImport: (request: import("../shared/types").CompanyPackageImportRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_COMPANY_PACKAGE_PREVIEW_IMPORT, request) as Promise<
      import("../shared/types").CompanyImportPreview
    >,
  importCompanyPackage: (request: import("../shared/types").CompanyPackageImportRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_COMPANY_PACKAGE_IMPORT, request) as Promise<
      import("../shared/types").CompanyPackageImportResult
    >,
  getCompanyGraph: (companyId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_COMPANY_GRAPH_GET, companyId) as Promise<
      import("../shared/types").ResolvedCompanyGraph
    >,
  listCompanySyncStates: (companyId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_COMPANY_SYNC_LIST, companyId) as Promise<
      import("../shared/types").CompanySyncState[]
    >,
  linkCompanyOrgNodeToRole: (request: {
    companyId: string;
    orgNodeId: string;
    agentRoleId: string | null;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MC_COMPANY_ORG_LINK_ROLE, request) as Promise<
    import("../shared/types").CompanySyncState | null
  >,
  getCommandCenterSummary: (companyId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_COMMAND_CENTER_SUMMARY, companyId) as Promise<
      import("../shared/types").CompanyCommandCenterSummary
    >,
  listCompanyGoals: (companyId: string) => ipcRenderer.invoke(IPC_CHANNELS.MC_GOAL_LIST, companyId),
  getGoal: (goalId: string) => ipcRenderer.invoke(IPC_CHANNELS.MC_GOAL_GET, goalId),
  createGoal: (input: import("../shared/types").GoalCreateInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_GOAL_CREATE, input),
  updateGoal: (request: { goalId: string } & import("../shared/types").GoalUpdate) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_GOAL_UPDATE, request),
  listCompanyProjects: (companyId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_PROJECT_LIST, companyId),
  getProject: (projectId: string) => ipcRenderer.invoke(IPC_CHANNELS.MC_PROJECT_GET, projectId),
  createProject: (input: import("../shared/types").ProjectCreateInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_PROJECT_CREATE, input),
  updateProject: (request: { projectId: string } & import("../shared/types").ProjectUpdate) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_PROJECT_UPDATE, request),
  listCompanyIssues: (companyId: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_ISSUE_LIST, { companyId, limit }),
  getIssue: (issueId: string) => ipcRenderer.invoke(IPC_CHANNELS.MC_ISSUE_GET, issueId),
  createIssue: (input: import("../shared/types").IssueCreateInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_ISSUE_CREATE, input),
  updateIssue: (request: { issueId: string } & import("../shared/types").IssueUpdate) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_ISSUE_UPDATE, request),
  listIssueComments: (issueId: string) => ipcRenderer.invoke(IPC_CHANNELS.MC_ISSUE_COMMENT_LIST, issueId),
  listCompanyRuns: (companyId: string, issueId?: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_RUN_LIST, { companyId, issueId, limit }),
  listRunEvents: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.MC_RUN_EVENT_LIST, runId),
  getPlannerConfig: (companyId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_PLANNER_GET_CONFIG, companyId),
  updatePlannerConfig: (request: {
    companyId: string;
    enabled?: boolean;
    intervalMinutes?: number;
    planningWorkspaceId?: string | null;
    plannerAgentRoleId?: string | null;
    autoDispatch?: boolean;
    approvalPreset?: "manual" | "safe_autonomy" | "founder_edge";
    maxIssuesPerRun?: number;
    staleIssueDays?: number;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MC_PLANNER_UPDATE_CONFIG, request),
  runPlanner: (companyId: string) => ipcRenderer.invoke(IPC_CHANNELS.MC_PLANNER_RUN, companyId),
  listPlannerRuns: (companyId: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_PLANNER_LIST_RUNS, { companyId, limit }),

  // Plugin Packs (Customize panel) APIs
  listPluginPacks: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_PACK_LIST),
  getPluginPack: (name: string) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_PACK_GET, name),
  togglePluginPack: (name: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_PACK_TOGGLE, name, enabled),
  getActiveContext: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_PACK_GET_CONTEXT),
  togglePluginPackSkill: (packName: string, skillId: string, enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_PACK_TOGGLE_SKILL, packName, skillId, enabled),

  // Plugin Pack Distribution APIs
  scaffoldPluginPack: (options: {
    name: string;
    displayName: string;
    description?: string;
    category?: string;
    icon?: string;
    author?: string;
    personaTemplateId?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_PACK_SCAFFOLD, options),
  installPluginPackFromGit: (gitUrl: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_PACK_INSTALL_GIT, gitUrl),
  installPluginPackFromUrl: (url: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_PACK_INSTALL_URL, url),
  uninstallPluginPack: (packName: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_PACK_UNINSTALL, packName),
  searchPackRegistry: (
    query: string,
    options?: { page?: number; pageSize?: number; category?: string },
  ) => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_PACK_REGISTRY_SEARCH, query, options),
  getPackRegistryDetails: (packId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_PACK_REGISTRY_DETAILS, packId),
  getPackRegistryCategories: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_PACK_REGISTRY_CATEGORIES),
  checkPackUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_PACK_CHECK_UPDATES),
  listQuarantinedImports: () => ipcRenderer.invoke(IPC_CHANNELS.IMPORT_SECURITY_LIST_QUARANTINED),
  getImportSecurityReport: (request: import("../shared/types").ImportSecurityReportRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPORT_SECURITY_GET_REPORT, request),
  retryQuarantinedImport: (recordId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPORT_SECURITY_RETRY_QUARANTINED, recordId),
  removeQuarantinedImport: (recordId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPORT_SECURITY_REMOVE_QUARANTINED, recordId),

  // Admin Policies APIs
  getAdminPolicies: () => ipcRenderer.invoke(IPC_CHANNELS.ADMIN_POLICIES_GET),
  updateAdminPolicies: (updates: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC_CHANNELS.ADMIN_POLICIES_UPDATE, updates),
  checkPackPolicy: (packId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ADMIN_POLICIES_CHECK_PACK, packId),

  // Agent Teams APIs
  listTeams: (workspaceId: string, includeInactive?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEAM_LIST, workspaceId, includeInactive),
  createTeam: (request: CreateAgentTeamRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEAM_CREATE, request),
  updateTeam: (request: UpdateAgentTeamRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEAM_UPDATE, request),
  deleteTeam: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_DELETE, id),
  listTeamMembers: (teamId: string) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_MEMBER_LIST, teamId),
  addTeamMember: (request: CreateAgentTeamMemberRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEAM_MEMBER_ADD, request),
  updateTeamMember: (request: UpdateAgentTeamMemberRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEAM_MEMBER_UPDATE, request),
  removeTeamMember: (teamId: string, agentRoleId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEAM_MEMBER_REMOVE, { teamId, agentRoleId }),
  reorderTeamMembers: (teamId: string, orderedMemberIds: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEAM_MEMBER_REORDER, { teamId, orderedMemberIds }),
  listTeamRuns: (teamId: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEAM_RUN_LIST, { teamId, limit }),
  createTeamRun: (request: CreateAgentTeamRunRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEAM_RUN_CREATE, request),
  resumeTeamRun: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_RUN_RESUME, runId),
  pauseTeamRun: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_RUN_PAUSE, runId),
  cancelTeamRun: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_RUN_CANCEL, runId),
  wrapUpTeamRun: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_RUN_WRAP_UP, runId),
  listTeamItems: (teamRunId: string) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_ITEM_LIST, teamRunId),
  createTeamItem: (request: CreateAgentTeamItemRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEAM_ITEM_CREATE, request),
  updateTeamItem: (request: UpdateAgentTeamItemRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEAM_ITEM_UPDATE, request),
  deleteTeamItem: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TEAM_ITEM_DELETE, id),
  moveTeamItem: (request: { id: string; parentItemId: string | null; sortOrder: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEAM_ITEM_MOVE, request),
  onTeamRunEvent: (callback: (event: Any) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: Any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.TEAM_RUN_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TEAM_RUN_EVENT, subscription);
  },

  // Collaborative Thoughts APIs
  listTeamThoughts: (teamRunId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEAM_THOUGHT_LIST, teamRunId),
  onTeamThoughtEvent: (callback: (event: Any) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: Any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.TEAM_THOUGHT_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TEAM_THOUGHT_EVENT, subscription);
  },
  findTeamRunByRootTask: (rootTaskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEAM_RUN_FIND_BY_ROOT_TASK, rootTaskId),

  // Activity Feed APIs
  listActivities: (query: ActivityListQuery) =>
    ipcRenderer.invoke(IPC_CHANNELS.ACTIVITY_LIST, query),
  createActivity: (request: CreateActivityRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.ACTIVITY_CREATE, request),
  markActivityRead: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.ACTIVITY_MARK_READ, id),
  markAllActivitiesRead: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ACTIVITY_MARK_ALL_READ, workspaceId),
  pinActivity: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.ACTIVITY_PIN, id),
  deleteActivity: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.ACTIVITY_DELETE, id),
  onActivityEvent: (callback: (event: ActivityEvent) => void) => {
    const subscription = (_: Any, data: ActivityEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.ACTIVITY_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ACTIVITY_EVENT, subscription);
  },

  // @Mention System APIs
  listMentions: (query: MentionListQuery) => ipcRenderer.invoke(IPC_CHANNELS.MENTION_LIST, query),
  createMention: (request: CreateMentionRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.MENTION_CREATE, request),
  acknowledgeMention: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MENTION_ACKNOWLEDGE, id),
  completeMention: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MENTION_COMPLETE, id),
  dismissMention: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MENTION_DISMISS, id),
  onMentionEvent: (callback: (event: MentionEvent) => void) => {
    const subscription = (_: Any, data: MentionEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.MENTION_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MENTION_EVENT, subscription);
  },
  listSupervisorExchanges: (query: {
    workspaceId: string;
    status?: SupervisorExchangeStatus | SupervisorExchangeStatus[];
    limit?: number;
  }) => ipcRenderer.invoke(IPC_CHANNELS.SUPERVISOR_EXCHANGE_LIST, query),
  resolveSupervisorExchange: (request: {
    id: string;
    resolution: string;
    mirrorToDiscord?: boolean;
  }) => ipcRenderer.invoke(IPC_CHANNELS.SUPERVISOR_EXCHANGE_RESOLVE, request),
  onSupervisorExchangeEvent: (callback: (event: SupervisorExchangeEvent) => void) => {
    const subscription = (_: Any, data: SupervisorExchangeEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SUPERVISOR_EXCHANGE_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SUPERVISOR_EXCHANGE_EVENT, subscription);
  },

  // ============ Mission Control APIs ============

  // Heartbeat System
  getHeartbeatConfig: (agentRoleId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.HEARTBEAT_GET_CONFIG, agentRoleId),
  updateHeartbeatConfig: (
    agentRoleId: string,
    config: {
      heartbeatEnabled?: boolean;
      heartbeatIntervalMinutes?: number;
      heartbeatStaggerOffset?: number;
    },
  ) => ipcRenderer.invoke(IPC_CHANNELS.HEARTBEAT_UPDATE_CONFIG, agentRoleId, config),
  triggerHeartbeat: (agentRoleId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.HEARTBEAT_TRIGGER, agentRoleId),
  getHeartbeatStatus: (agentRoleId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.HEARTBEAT_GET_STATUS, agentRoleId),
  getAllHeartbeatStatus: () => ipcRenderer.invoke(IPC_CHANNELS.HEARTBEAT_GET_ALL_STATUS),
  onHeartbeatEvent: (callback: (event: HeartbeatEvent) => void) => {
    const subscription = (_: Any, data: HeartbeatEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.HEARTBEAT_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.HEARTBEAT_EVENT, subscription);
  },
  listAutomationProfiles: () => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_PROFILE_LIST),
  getAutomationProfile: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_PROFILE_GET, id),
  createAutomationProfile: (request: import("../shared/types").CreateAutomationProfileRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_PROFILE_CREATE, request),
  updateAutomationProfile: (request: import("../shared/types").UpdateAutomationProfileRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_PROFILE_UPDATE, request),
  deleteAutomationProfile: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_PROFILE_DELETE, id),
  attachAutomationProfileToAgentRole: (
    agentRoleId: string,
    request?: Partial<import("../shared/types").CreateAutomationProfileRequest>,
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_PROFILE_ATTACH, agentRoleId, request),
  detachAutomationProfileFromAgentRole: (agentRoleId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_PROFILE_DETACH, agentRoleId),
  listHeartbeatRunsForAutomationProfile: (profileId: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_PROFILE_LIST_HEARTBEAT_RUNS, { profileId, limit }),
  listSubconsciousRunsForAutomationProfile: (profileId: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_PROFILE_LIST_SUBCONSCIOUS_RUNS, { profileId, limit }),
  listCoreTraces: (request?: import("../shared/types").ListCoreTracesRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_TRACE_LIST, request) as Promise<CoreTrace[]>,
  getCoreTrace: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_TRACE_GET, id) as Promise<GetCoreTraceResult | undefined>,
  listCoreTracesForAutomationProfile: (profileId: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_TRACE_LIST_BY_PROFILE, { profileId, limit }) as Promise<CoreTrace[]>,
  listCoreFailureRecords: (request?: import("../shared/types").ListCoreFailureRecordsRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_FAILURE_LIST, request) as Promise<CoreFailureRecord[]>,
  listCoreFailureClusters: (request?: import("../shared/types").ListCoreFailureClustersRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_FAILURE_CLUSTER_LIST, request) as Promise<CoreFailureCluster[]>,
  reviewCoreFailureCluster: (
    request: import("../shared/types").ReviewCoreFailureClusterRequest,
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_FAILURE_CLUSTER_REVIEW, request) as Promise<
      CoreFailureCluster | undefined
    >,
  listCoreEvalCases: (request?: import("../shared/types").ListCoreEvalCasesRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_EVAL_CASE_LIST, request) as Promise<CoreEvalCase[]>,
  reviewCoreEvalCase: (request: import("../shared/types").ReviewCoreEvalCaseRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_EVAL_CASE_REVIEW, request) as Promise<
      CoreEvalCase | undefined
    >,
  listCoreExperiments: (request?: import("../shared/types").ListCoreExperimentsRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_EXPERIMENT_LIST, request) as Promise<
      CoreHarnessExperiment[]
    >,
  runCoreExperiment: (request: import("../shared/types").RunCoreExperimentRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_EXPERIMENT_RUN, request) as Promise<{
      experiment: CoreHarnessExperiment;
      run: import("../shared/types").CoreHarnessExperimentRun;
      gate: import("../shared/types").CoreRegressionGateResult;
    }>,
  reviewCoreExperiment: (request: import("../shared/types").ReviewCoreExperimentRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_EXPERIMENT_REVIEW, request) as Promise<
      CoreHarnessExperiment | undefined
    >,
  listCoreLearnings: (request?: import("../shared/types").ListCoreLearningsRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_LEARNINGS_LIST, request) as Promise<CoreLearningsEntry[]>,
  listCoreMemoryCandidates: (request?: import("../shared/types").ListCoreMemoryCandidatesRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_MEMORY_LIST_CANDIDATES, request) as Promise<CoreMemoryCandidate[]>,
  reviewCoreMemoryCandidate: (request: import("../shared/types").ReviewCoreMemoryCandidateRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_MEMORY_REVIEW_CANDIDATE, request) as Promise<
      CoreMemoryCandidate | undefined
    >,
  listCoreMemoryDistillRuns: (profileId: string, workspaceId?: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_MEMORY_LIST_DISTILL_RUNS, {
      profileId,
      workspaceId,
      limit,
    }) as Promise<CoreMemoryDistillRun[]>,
  runCoreMemoryDistillNow: (request: import("../shared/types").RunCoreMemoryDistillNowRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_MEMORY_RUN_DISTILL_NOW, request) as Promise<CoreMemoryDistillRun>,

  // Task Subscriptions
  listSubscriptions: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_LIST, taskId),
  addSubscription: (taskId: string, agentRoleId: string, reason: SubscriptionReason) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_ADD, taskId, agentRoleId, reason),
  removeSubscription: (taskId: string, agentRoleId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_REMOVE, taskId, agentRoleId),
  getTaskSubscribers: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_GET_SUBSCRIBERS, taskId),
  getAgentSubscriptions: (agentRoleId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBSCRIPTION_GET_FOR_AGENT, agentRoleId),
  onSubscriptionEvent: (callback: (event: SubscriptionEvent) => void) => {
    const subscription = (_: Any, data: SubscriptionEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SUBSCRIPTION_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SUBSCRIPTION_EVENT, subscription);
  },

  // Standup Reports
  generateStandupReport: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.STANDUP_GENERATE, workspaceId),
  getLatestStandupReport: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.STANDUP_GET_LATEST, workspaceId),
  listStandupReports: (workspaceId: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.STANDUP_LIST, workspaceId, limit),
  deliverStandupReport: (reportId: string, channelType: string, channelId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.STANDUP_DELIVER, reportId, channelType, channelId),

  // Agent Performance Reviews
  generateAgentReview: (request: AgentReviewGenerateRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.REVIEW_GENERATE, request),
  getLatestAgentReview: (workspaceId: string, agentRoleId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.REVIEW_GET_LATEST, workspaceId, agentRoleId),
  listAgentReviews: (query: { workspaceId: string; agentRoleId?: string; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.REVIEW_LIST, query),
  deleteAgentReview: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.REVIEW_DELETE, id),
  listEvalSuites: (options?: { windowDays?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.EVAL_LIST_SUITES, options),
  runEvalSuite: (suiteId: string) => ipcRenderer.invoke(IPC_CHANNELS.EVAL_RUN_SUITE, suiteId),
  getEvalRun: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.EVAL_GET_RUN, runId),
  getEvalCase: (caseId: string) => ipcRenderer.invoke(IPC_CHANNELS.EVAL_GET_CASE, caseId),
  createEvalCaseFromTask: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.EVAL_CREATE_CASE_FROM_TASK, { taskId }),

  // Task Board APIs
  moveTaskToColumn: (taskId: string, column: TaskBoardColumn) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_MOVE_COLUMN, taskId, column),
  setTaskPriority: (taskId: string, priority: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_SET_PRIORITY, taskId, priority),
  setTaskDueDate: (taskId: string, dueDate: number | null) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_SET_DUE_DATE, taskId, dueDate),
  setTaskEstimate: (taskId: string, estimatedMinutes: number | null) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_SET_ESTIMATE, taskId, estimatedMinutes),
  addTaskLabel: (taskId: string, labelId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_ADD_LABEL, taskId, labelId),
  removeTaskLabel: (taskId: string, labelId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_REMOVE_LABEL, taskId, labelId),
  onTaskBoardEvent: (callback: (event: TaskBoardEvent) => void) => {
    const subscription = (_: Any, data: TaskBoardEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.TASK_BOARD_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TASK_BOARD_EVENT, subscription);
  },

  // Unified recall
  queryUnifiedRecall: (query: {
    workspaceId?: string;
    query: string;
    limit?: number;
    sourceTypes?: UnifiedRecallSourceType[];
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.UNIFIED_RECALL_QUERY, query) as Promise<UnifiedRecallResponse>,

  // Shell sessions
  onShellSessionEvent: (callback: (event: ShellSessionLifecycleEvent) => void) => {
    const subscription = (_: Any, data: ShellSessionLifecycleEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SHELL_SESSION_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SHELL_SESSION_EVENT, subscription);
  },
  getShellSessionInfo: (
    taskId: string,
    workspaceId: string,
    scope?: "task" | "workspace",
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_SESSION_GET, { taskId, workspaceId, scope }) as Promise<
      ShellSessionInfo | null
    >,
  listShellSessions: (taskId?: string, workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_SESSION_LIST, { taskId, workspaceId }) as Promise<
      ShellSessionInfo[]
    >,
  resetShellSession: (
    taskId: string,
    workspaceId: string,
    scope?: "task" | "workspace",
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_SESSION_RESET, { taskId, workspaceId, scope }) as Promise<
      ShellSessionInfo | null
    >,
  closeShellSession: (
    taskId: string,
    workspaceId: string,
    scope?: "task" | "workspace",
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHELL_SESSION_CLOSE, { taskId, workspaceId, scope }) as Promise<
      ShellSessionInfo | null
    >,

  // LLM routing observability
  getLLMRoutingStatus: () =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_ROUTING_STATUS) as Promise<LLMRoutingRuntimeState>,
  onLLMRoutingEvent: (callback: (event: LLMRoutingRuntimeState) => void) => {
    const subscription = (_: Any, data: LLMRoutingRuntimeState) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.LLM_ROUTING_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.LLM_ROUTING_EVENT, subscription);
  },

  // Task Label APIs
  listTaskLabels: (query: TaskLabelListQuery) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_LABEL_LIST, query),
  createTaskLabel: (request: CreateTaskLabelRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_LABEL_CREATE, request),
  updateTaskLabel: (id: string, request: UpdateTaskLabelRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_LABEL_UPDATE, id, request),
  deleteTaskLabel: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_LABEL_DELETE, id),

  // Agent Working State APIs
  getWorkingState: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKING_STATE_GET, id),
  getCurrentWorkingState: (query: WorkingStateQuery) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKING_STATE_GET_CURRENT, query),
  updateWorkingState: (request: UpdateWorkingStateRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKING_STATE_UPDATE, request),
  getWorkingStateHistory: (query: WorkingStateHistoryQuery) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKING_STATE_HISTORY, query),
  restoreWorkingState: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKING_STATE_RESTORE, id),
  deleteWorkingState: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKING_STATE_DELETE, id),
  listWorkingStatesForTask: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKING_STATE_LIST_FOR_TASK, taskId),

  // Context Policy APIs (per-context security DM vs group)
  getContextPolicy: (channelId: string, contextType: ContextTypeValue) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONTEXT_POLICY_GET, channelId, contextType),
  getContextPolicyForChat: (channelId: string, chatId: string, isGroup: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONTEXT_POLICY_GET_FOR_CHAT, channelId, chatId, isGroup),
  listContextPolicies: (channelId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONTEXT_POLICY_LIST, channelId),
  updateContextPolicy: (
    channelId: string,
    contextType: ContextTypeValue,
    options: UpdateContextPolicyOptions,
  ) => ipcRenderer.invoke(IPC_CHANNELS.CONTEXT_POLICY_UPDATE, channelId, contextType, options),
  deleteContextPolicies: (channelId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONTEXT_POLICY_DELETE, channelId),
  createDefaultContextPolicies: (channelId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONTEXT_POLICY_CREATE_DEFAULTS, channelId),
  isToolAllowedInContext: (
    channelId: string,
    contextType: ContextTypeValue,
    toolName: string,
    toolGroups: string[],
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.CONTEXT_POLICY_IS_TOOL_ALLOWED,
      channelId,
      contextType,
      toolName,
      toolGroups,
    ),

  // Voice Mode
  getVoiceSettings: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_GET_SETTINGS),
  saveVoiceSettings: (settings: Partial<VoiceSettingsData>) =>
    ipcRenderer.invoke(IPC_CHANNELS.VOICE_SAVE_SETTINGS, settings),
  getVoiceState: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_GET_STATE),
  voiceSpeak: (text: string) => ipcRenderer.invoke(IPC_CHANNELS.VOICE_SPEAK, text),
  voiceStopSpeaking: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_STOP_SPEAKING),
  voiceTranscribe: (audioData: ArrayBuffer) =>
    ipcRenderer.invoke(IPC_CHANNELS.VOICE_TRANSCRIBE, Array.from(new Uint8Array(audioData))),
  getElevenLabsVoices: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_GET_ELEVENLABS_VOICES),
  testElevenLabsConnection: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_TEST_ELEVENLABS),
  testOpenAIVoiceConnection: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_TEST_OPENAI),
  testAzureVoiceConnection: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_TEST_AZURE),
  onVoiceEvent: (callback: (event: VoiceEventData) => void) => {
    const handler = (_event: Electron.IpcRendererEvent, data: VoiceEventData) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.VOICE_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.VOICE_EVENT, handler);
  },

  // Git Worktree APIs
  getWorktreeInfo: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_GET_INFO, taskId),
  listWorktrees: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_LIST, workspaceId),
  mergeWorktree: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_MERGE, taskId),
  cleanupWorktree: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_CLEANUP, taskId),
  getWorktreeDiff: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_GET_DIFF, taskId),
  getWorktreeSettings: () => ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_GET_SETTINGS),
  saveWorktreeSettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_SAVE_SETTINGS, settings),

  // Agent Comparison APIs
  createComparison: (params: Any) => ipcRenderer.invoke(IPC_CHANNELS.COMPARISON_CREATE, params),
  getComparison: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.COMPARISON_GET, sessionId),
  listComparisons: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPARISON_LIST, workspaceId),
  cancelComparison: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPARISON_CANCEL, sessionId),
  getComparisonResult: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPARISON_GET_RESULT, sessionId),

  // Usage Insights
  getUsageInsights: (workspaceId: string, periodDays?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.USAGE_INSIGHTS_GET, workspaceId, periodDays),

  getUsageInsightsEarliest: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.USAGE_INSIGHTS_EARLIEST, workspaceId),

  // Daily Briefing
  generateDailyBriefing: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DAILY_BRIEFING_GENERATE, workspaceId),
  generateBriefing: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DAILY_BRIEFING_GENERATE, workspaceId),

  // Proactive Suggestions
  listSuggestions: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUGGESTIONS_LIST, workspaceId),
  listSuggestionsForWorkspaces: (workspaceIds: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUGGESTIONS_LIST_FOR_WORKSPACES, workspaceIds),
  refreshSuggestions: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUGGESTIONS_REFRESH, workspaceId),
  refreshSuggestionsForWorkspaces: (workspaceIds: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUGGESTIONS_REFRESH_FOR_WORKSPACES, workspaceIds),
  dismissSuggestion: (workspaceId: string, suggestionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUGGESTIONS_DISMISS, workspaceId, suggestionId),
  snoozeSuggestion: (workspaceId: string, suggestionId: string, snoozedUntil: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUGGESTIONS_SNOOZE, workspaceId, suggestionId, snoozedUntil),
  editSuggestion: (workspaceId: string, suggestionId: string, editedPrompt: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUGGESTIONS_EDIT, workspaceId, suggestionId, editedPrompt),
  actOnSuggestion: (workspaceId: string, suggestionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUGGESTIONS_ACT, workspaceId, suggestionId),

  // Citation Engine
  getCitationsForTask: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CITATION_GET_FOR_TASK, taskId),

  // Event Triggers
  listTriggers: (workspaceId: string) => ipcRenderer.invoke(IPC_CHANNELS.TRIGGER_LIST, workspaceId),
  addTrigger: (data: Any) => ipcRenderer.invoke(IPC_CHANNELS.TRIGGER_ADD, data),
  updateTrigger: (id: string, updates: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.TRIGGER_UPDATE, { id, updates }),
  removeTrigger: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TRIGGER_REMOVE, id),
  getTriggerHistory: (triggerId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TRIGGER_HISTORY, triggerId),

  // Routines
  listRoutines: () => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_LIST),
  getRoutine: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_GET, id),
  listRoutineRuns: (routineId?: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_LIST_RUNS, { routineId, limit }),
  createRoutine: (data: Any) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_CREATE, data),
  updateRoutine: (id: string, updates: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_UPDATE, { id, updates }),
  removeRoutine: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_REMOVE, id),
  runRoutineNow: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_RUN_NOW, id),
  regenerateRoutineApiToken: (routineId: string, triggerId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_REGENERATE_API_TOKEN, { routineId, triggerId }),

  // Daily Briefing (extended)
  getLatestBriefing: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.BRIEFING_GET_LATEST, workspaceId),
  getBriefingConfig: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.BRIEFING_GET_CONFIG, workspaceId),
  saveBriefingConfig: (workspaceId: string, config: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.BRIEFING_SAVE_CONFIG, { workspaceId, config }),

  // File Hub
  listHubFiles: (options: Any) => ipcRenderer.invoke(IPC_CHANNELS.FILEHUB_LIST, options),
  searchHubFiles: (query: string, sources?: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILEHUB_SEARCH, { query, sources }),
  getRecentHubFiles: (limit?: number) => ipcRenderer.invoke(IPC_CHANNELS.FILEHUB_RECENT, limit),
  getHubSources: () => ipcRenderer.invoke(IPC_CHANNELS.FILEHUB_SOURCES),

  // Web Access
  getWebAccessSettings: () => ipcRenderer.invoke(IPC_CHANNELS.WEBACCESS_GET_SETTINGS),
  saveWebAccessSettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.WEBACCESS_SAVE_SETTINGS, settings),
  getWebAccessStatus: () => ipcRenderer.invoke(IPC_CHANNELS.WEBACCESS_GET_STATUS),

  // Playwright QA APIs
  qaGetRuns: () => ipcRenderer.invoke(IPC_CHANNELS.QA_GET_RUNS),
  qaGetRun: (runId: string) => ipcRenderer.invoke(IPC_CHANNELS.QA_GET_RUN, runId),
  qaStartRun: (data: { taskId: string; workspaceId: string; config: Any }) =>
    ipcRenderer.invoke(IPC_CHANNELS.QA_START_RUN, data),
  qaStopRun: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.QA_STOP_RUN, taskId),
  onQAEvent: (callback: (event: Any) => void) => {
    const handler = (_: Any, event: Any) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.QA_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.QA_EVENT, handler);
  },

  // Window control APIs (for custom title bar on Windows)
  windowMinimize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
  windowMaximize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MAXIMIZE),
  windowClose: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
  windowIsMaximized: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_IS_MAXIMIZED) as Promise<boolean>,
  getPlatform: () => process.platform,
});

// Type declarations for TypeScript
export interface FileViewerResult {
  success: boolean;
  data?: {
    path: string;
    fileName: string;
    fileType:
      | "markdown"
      | "code"
      | "text"
      | "docx"
      | "pdf"
      | "latex"
      | "image"
      | "video"
      | "pptx"
      | "xlsx"
      | "html"
      | "unsupported";
    content: string | null;
    htmlContent?: string;
    ocrText?: string;
    pdfThumbnailDataUrl?: string;
    pdfDataBase64?: string;
    pdfReviewSummary?: PdfReviewSummary;
    presentationPreview?: {
      slideCount: number;
      title?: string;
      slides: Array<{
        index: number;
        title?: string;
        text: string;
        notes?: string;
        imageDataUrl?: string;
      }>;
      renderStatus: "rendered" | "text_only" | "failed";
      renderMessage?: string;
    };
    playbackUrl?: string;
    mimeType?: string;
    durationMs?: number;
    posterDataUrl?: string;
    size: number;
  };
  error?: string;
}

export type { TraySettings };
export type { DocumentEditorSession, DocumentVersionEntry, DocumentEditRequest };

// Export Agent Role types
export type {
  AgentCapability,
  AgentToolRestrictions,
  AgentRoleData,
  CreateAgentRoleRequest,
  UpdateAgentRoleRequest,
};

// Export Activity Feed types
export type {
  ActivityActorType,
  ActivityType,
  ActivityData,
  ActivityListQuery,
  ActivityEvent,
  SupervisorExchange,
  SupervisorExchangeEvent,
};

// Export @Mention System types
export type {
  MentionType,
  MentionStatus,
  MentionData,
  CreateMentionRequest,
  MentionListQuery,
  MentionEvent,
};

// Export Task Board types
export type {
  TaskBoardColumn,
  TaskLabelData,
  CreateTaskLabelRequest,
  UpdateTaskLabelRequest,
  TaskLabelListQuery,
  TaskBoardEvent,
};

// Export Agent Working State types
export type {
  WorkingStateType,
  AgentWorkingStateData,
  UpdateWorkingStateRequest,
  WorkingStateQuery,
  WorkingStateHistoryQuery,
};

// Export Context Policy types
export type { SecurityModeType, ContextTypeValue, ContextPolicyData, UpdateContextPolicyOptions };

// Export Mission Control types
export type {
  HeartbeatStatus,
  HeartbeatResult,
  HeartbeatEvent,
  SubscriptionReason,
  TaskSubscription,
  SubscriptionEvent,
  StandupReport,
  AgentAutonomyLevel,
};

export interface ElectronAPI {
  selectFolder: (defaultPath?: string) => Promise<string | null>;
  selectFiles: (defaultPath?: string) => Promise<
    Array<{ path: string; name: string; size: number; mimeType?: string }>
  >;
  openFile: (filePath: string, workspacePath?: string) => Promise<string>;
  showInFinder: (filePath: string, workspacePath?: string) => Promise<void>;
  readFileForViewer: (
    filePath: string,
    workspacePath?: string,
    options?: ReadFileForViewerOptions,
  ) => Promise<FileViewerResult>;
  getLlmWikiVaultSummary: (data: {
    workspacePath: string;
    vaultPath?: string;
  }) => Promise<LlmWikiVaultSummary>;
  importFilesToWorkspace: (data: {
    workspaceId: string;
    files: string[];
  }) => Promise<Array<{ relativePath: string; fileName: string; size: number; mimeType?: string }>>;
  importDataToWorkspace: (data: {
    workspaceId: string;
    files: Array<{ name: string; data: string; mimeType?: string }>;
  }) => Promise<Array<{ relativePath: string; fileName: string; size: number; mimeType?: string }>>;
  openDocumentEditorSession: (data: {
    filePath: string;
    workspacePath?: string;
  }) => Promise<DocumentEditorSession>;
  listDocumentVersions: (data: {
    filePath: string;
    workspacePath?: string;
  }) => Promise<DocumentVersionEntry[]>;
  startDocumentEditTask: (data: DocumentEditRequest) => Promise<Any>;
  getMailboxSyncStatus: () => Promise<MailboxSyncStatus>;
  getMailboxClientState: () => Promise<MailboxClientState>;
  syncMailbox: (limit?: number) => Promise<MailboxSyncResult>;
  listMailboxThreads: (query?: MailboxListThreadsInput) => Promise<MailboxThreadListItem[]>;
  getMailboxThread: (threadId: string) => Promise<MailboxThreadDetail | null>;
  listMailboxEvents: (limit?: number, threadId?: string) => Promise<MailboxEvent[]>;
  listMailboxAutomations: (query?: {
    workspaceId?: string;
    threadId?: string;
  }) => Promise<MailboxAutomationRecord[]>;
  listThreadMailboxAutomations: (threadId: string) => Promise<MailboxAutomationRecord[]>;
  createMailboxRule: (recipe: MailboxRuleRecipe) => Promise<MailboxAutomationRecord>;
  updateMailboxRule: (
    id: string,
    patch: Partial<MailboxRuleRecipe> & { status?: MailboxAutomationStatus },
  ) => Promise<MailboxAutomationRecord | null>;
  deleteMailboxRule: (id: string) => Promise<boolean>;
  createMailboxSchedule: (recipe: MailboxScheduleRecipe) => Promise<MailboxAutomationRecord>;
  updateMailboxSchedule: (
    id: string,
    patch: Partial<MailboxScheduleRecipe> & { status?: MailboxAutomationStatus },
  ) => Promise<MailboxAutomationRecord | null>;
  deleteMailboxSchedule: (id: string) => Promise<boolean>;
  createMailboxForward: (recipe: MailboxForwardRecipe) => Promise<MailboxAutomationRecord>;
  updateMailboxForward: (
    id: string,
    patch: Partial<MailboxForwardRecipe> & { status?: MailboxAutomationStatus },
  ) => Promise<MailboxAutomationRecord | null>;
  deleteMailboxForward: (id: string) => Promise<boolean>;
  runMailboxForward: (id: string) => Promise<string>;
  getMailboxDigest: (workspaceId?: string) => Promise<MailboxDigestSnapshot>;
  getMailboxTodayDigest: (input?: { limitPerBucket?: number }) => Promise<MailboxTodayDigest>;
  getMailboxSenderCleanupDigest: (input?: { limit?: number }) => Promise<MailboxSenderCleanupDigest>;
  askMailbox: (input: MailboxAskInput) => Promise<MailboxAskResult>;
  extractMailboxAttachmentText: (attachmentId: string) => Promise<MailboxAttachmentRecord>;
  createMailboxDraft: (input: MailboxComposeDraftInput) => Promise<MailboxComposeDraft>;
  updateMailboxDraft: (draftId: string, patch: MailboxComposeDraftPatch) => Promise<MailboxComposeDraft>;
  sendMailboxDraft: (draftId: string) => Promise<MailboxOutgoingMessage>;
  scheduleMailboxSend: (draftId: string, scheduledAt: number) => Promise<MailboxComposeDraft>;
  discardMailboxDraft: (draftId: string) => Promise<boolean>;
  undoMailboxAction: (actionId: string) => Promise<MailboxQueuedAction>;
  summarizeMailboxThread: (threadId: string) => Promise<MailboxSummaryCard | null>;
  generateMailboxDraft: (
    threadId: string,
    options?: MailboxDraftOptions,
  ) => Promise<MailboxDraftSuggestion | null>;
  extractMailboxCommitments: (threadId: string) => Promise<MailboxCommitment[]>;
  reviewMailboxBulkAction: (input: {
    type: "cleanup" | "follow_up";
    limit?: number;
  }) => Promise<MailboxBulkReviewResult>;
  scheduleMailboxReply: (threadId: string) => Promise<{
    threadId: string;
    suggestions: string[];
    summary: string;
  }>;
  researchMailboxContact: (threadId: string) => Promise<MailboxResearchResult | null>;
  resolveMailboxContactIdentity: (threadId: string) => Promise<ContactIdentityResolution | null>;
  getContactIdentity: (contactIdentityId: string) => Promise<ContactIdentity | null>;
  listContactIdentities: (workspaceId?: string) => Promise<ContactIdentity[]>;
  searchIdentityLinkTargets: (workspaceId: string, query: string, limit?: number) => Promise<ContactIdentitySearchResult[]>;
  linkIdentityHandle: (input: {
    workspaceId: string;
    contactIdentityId: string;
    handleType: string;
    normalizedValue: string;
    displayValue: string;
    source?: string;
    channelId?: string;
    channelType?: string;
    channelUserId?: string;
  }) => Promise<ContactIdentity | null>;
  getMailboxRelationshipTimeline: (query: RelationshipTimelineQuery) => Promise<RelationshipTimelineEvent[]>;
  listIdentityCandidates: (
    workspaceId?: string,
    status?: ContactIdentityCandidate["status"],
  ) => Promise<ContactIdentityCandidate[]>;
  confirmIdentityLink: (candidateId: string) => Promise<ContactIdentityCandidate | null>;
  rejectIdentityLink: (candidateId: string) => Promise<ContactIdentityCandidate | null>;
  unlinkIdentityHandle: (handleId: string) => Promise<boolean>;
  getChannelPreferenceSummary: (contactIdentityId: string) => Promise<ChannelPreferenceSummary>;
  getContactIdentityCoverageStats: (workspaceId?: string) => Promise<ContactIdentityCoverageStats>;
  replyViaChannel: (input: {
    threadId: string;
    handleId: string;
    channelType: "slack" | "teams" | "whatsapp" | "signal" | "imessage";
    message: string;
    parseMode?: "text" | "markdown";
  }) => Promise<{
    ok: boolean;
    target: ContactIdentityReplyTarget;
  }>;
  previewMailboxMissionControlHandoff: (threadId: string) => Promise<MailboxMissionControlHandoffPreview | null>;
  createMailboxMissionControlHandoff: (
    request: MailboxMissionControlHandoffRequest,
  ) => Promise<MailboxMissionControlHandoffRecord>;
  listMailboxMissionControlHandoffs: (threadId: string) => Promise<MailboxMissionControlHandoffRecord[]>;
  listMailboxSnippets: () => Promise<MailboxSnippetRecord[]>;
  upsertMailboxSnippet: (input: {
    id?: string;
    shortcut: string;
    body: string;
    subjectHint?: string;
  }) => Promise<MailboxSnippetRecord>;
  deleteMailboxSnippet: (id: string) => Promise<boolean>;
  listMailboxSavedViews: () => Promise<MailboxSavedViewRecord[]>;
  createMailboxSavedView: (input: {
    name: string;
    instructions: string;
    seedThreadId?: string;
    threadIds: string[];
    showInInbox?: boolean;
  }) => Promise<MailboxSavedViewRecord>;
  deleteMailboxSavedView: (id: string) => Promise<boolean>;
  previewMailboxSavedViewSimilar: (input: {
    seedThreadId: string;
    name: string;
    instructions: string;
  }) => Promise<MailboxSavedViewPreviewResult>;
  getMailboxQuickReplySuggestions: (threadId: string) => Promise<MailboxQuickReplySuggestionsResult>;
  createMailboxSavedViewReviewSchedule: (viewId: string) => Promise<MailboxAutomationRecord>;
  applyMailboxAction: (input: MailboxApplyActionInput) => Promise<{
    success: boolean;
    action: string;
    threadId?: string;
  }>;
  updateMailboxCommitmentState: (
    commitmentId: string,
    state: MailboxCommitmentState,
  ) => Promise<MailboxCommitment | null>;
  updateMailboxCommitmentDetails: (
    commitmentId: string,
    patch: {
      title?: string;
      dueAt?: number | null;
      ownerEmail?: string | null;
      state?: MailboxCommitmentState;
      sourceExcerpt?: string | null;
    },
  ) => Promise<MailboxCommitment | null>;
  reclassifyMailboxThread: (threadId: string) => Promise<MailboxReclassifyResult>;
  reclassifyMailboxAccount: (input: MailboxReclassifyInput) => Promise<MailboxReclassifyResult>;
  onMailboxEvent: (callback: (event: MailboxEvent) => void) => () => void;
  openExternal: (url: string) => Promise<void>;
  openSystemSettings: (
    target: "microphone" | "dictation",
  ) => Promise<{ success: boolean; error?: string }>;
  createTask: (data: Any) => Promise<Any>;
  getTask: (id: string) => Promise<Any>;
  listTasks: (opts?: { limit?: number; offset?: number; prioritizeSidebar?: boolean }) => Promise<Any[]>;
  exportTasksJson: (query?: Any) => Promise<Any>;
  toggleTaskPin: (taskId: string) => Promise<Any>;
  cancelTask: (id: string) => Promise<void>;
  wrapUpTask: (id: string) => Promise<void>;
  pauseTask: (id: string) => Promise<void>;
  resumeTask: (id: string) => Promise<void>;
  continueTask: (id: string) => Promise<void>;
  forkTaskSession: (data: {
    taskId: string;
    prompt?: string;
    branchLabel?: string;
    fromEventId?: string;
  }) => Promise<Any>;
  sendStdin: (taskId: string, input: string) => Promise<boolean>;
  killCommand: (taskId: string, force?: boolean) => Promise<boolean>;
  renameTask: (id: string, title: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  onTaskEvent: (callback: (event: Any) => void) => () => void;
  onTaskLearningEvent: (callback: (event: TaskLearningProgress) => void) => () => void;
  getTaskEvents: (taskId: string) => Promise<Any[]>;
  /** Normalized semantic timeline projection for a task */
  getSemanticTimeline: (taskId: string) => Promise<UiTimelineEvent[]>;
  getTaskLearningProgress: (taskId: string) => Promise<TaskLearningProgress[]>;
  sendMessage: (
    taskId: string,
    message: string,
    images?: ImageAttachment[],
    quotedAssistantMessage?: QuotedAssistantMessage,
  ) => Promise<void>;
  sendStepFeedback: (
    taskId: string,
    stepId: string,
    action: "retry" | "skip" | "stop" | "drift",
    message?: string,
  ) => Promise<void>;
  queryUnifiedRecall: (query: {
    workspaceId?: string;
    query: string;
    limit?: number;
    sourceTypes?: UnifiedRecallSourceType[];
  }) => Promise<UnifiedRecallResponse>;
  getShellSessionInfo: (
    taskId: string,
    workspaceId: string,
    scope?: "task" | "workspace",
  ) => Promise<ShellSessionInfo | null>;
  listShellSessions: (
    taskId?: string,
    workspaceId?: string,
  ) => Promise<ShellSessionInfo[]>;
  resetShellSession: (
    taskId: string,
    workspaceId: string,
    scope?: "task" | "workspace",
  ) => Promise<ShellSessionInfo | null>;
  closeShellSession: (
    taskId: string,
    workspaceId: string,
    scope?: "task" | "workspace",
  ) => Promise<ShellSessionInfo | null>;
  onShellSessionEvent: (callback: (event: ShellSessionLifecycleEvent) => void) => () => void;
  createWorkspace: (data: Any) => Promise<Workspace>;
  listWorkspaces: () => Promise<Workspace[]>;
  selectWorkspace: (id: string) => Promise<Workspace>;
  getTempWorkspace: (options?: { createNew?: boolean }) => Promise<Workspace | null>;
  touchWorkspace: (id: string) => Promise<Any>;
  updateWorkspacePermissions: (
    id: string,
    permissions: { shell?: boolean; network?: boolean },
  ) => Promise<Any>;
  respondToApproval: (data: ApprovalResponse) => Promise<void>;
  setSessionAutoApprove: (enabled: boolean) => Promise<void>;
  getSessionAutoApprove: () => Promise<boolean>;
  listInputRequests: (query?: {
    limit?: number;
    offset?: number;
    taskId?: string;
    status?: "pending" | "submitted" | "dismissed";
  }) => Promise<InputRequest[]>;
  respondToInputRequest: (data: InputRequestResponse) => Promise<{
    status: "handled" | "duplicate" | "not_found" | "in_progress";
    requestId: string;
  }>;
  listArtifacts: (taskId: string) => Promise<Any[]>;
  previewArtifact: (id: string) => Promise<Any>;
  listManagedAgents: (params?: {
    limit?: number;
    offset?: number;
    status?: ManagedAgent["status"];
  }) => Promise<ManagedAgent[]>;
  getManagedAgent: (
    agentId: string,
  ) => Promise<{ agent: ManagedAgent; currentVersion?: ManagedAgentVersion } | null>;
  getManagedAgentRuntimeToolCatalog: (agentId: string) => Promise<ManagedAgentRuntimeToolCatalog>;
  createManagedAgent: (request: {
    name: string;
    description?: string;
    systemPrompt: string;
    executionMode: ManagedAgentVersion["executionMode"];
    model?: ManagedAgentVersion["model"];
    runtimeDefaults?: ManagedAgentVersion["runtimeDefaults"];
    skills?: string[];
    mcpServers?: string[];
    teamTemplate?: ManagedAgentVersion["teamTemplate"];
    metadata?: Record<string, unknown>;
  }) => Promise<{ agent: ManagedAgent; version: ManagedAgentVersion }>;
  updateManagedAgent: (request: {
    agentId: string;
    name?: string;
    description?: string;
    systemPrompt?: string;
    executionMode?: ManagedAgentVersion["executionMode"];
    model?: ManagedAgentVersion["model"];
    runtimeDefaults?: ManagedAgentVersion["runtimeDefaults"];
    skills?: string[];
    mcpServers?: string[];
    teamTemplate?: ManagedAgentVersion["teamTemplate"];
    metadata?: Record<string, unknown>;
  }) => Promise<{ agent: ManagedAgent; version: ManagedAgentVersion }>;
  archiveManagedAgent: (agentId: string) => Promise<ManagedAgent | null>;
  publishManagedAgent: (agentId: string) => Promise<ManagedAgent | null>;
  suspendManagedAgent: (agentId: string) => Promise<ManagedAgent | null>;
  listManagedAgentRoutines: (agentId: string) => Promise<ManagedAgentRoutineRecord[]>;
  createManagedAgentRoutine: (
    request: CreateManagedAgentRoutineRequest,
  ) => Promise<ManagedAgentRoutineRecord>;
  updateManagedAgentRoutine: (
    request: UpdateManagedAgentRoutineRequest,
  ) => Promise<ManagedAgentRoutineRecord>;
  deleteManagedAgentRoutine: (agentId: string, routineId: string) => Promise<boolean>;
  getManagedAgentInsights: (agentId: string) => Promise<ManagedAgentInsights>;
  listManagedAgentAuditEntries: (agentId: string, limit?: number) => Promise<ManagedAgentAuditEntry[]>;
  getManagedAgentSlackDeploymentHealth: (agentId: string) => Promise<ManagedAgentSlackDeploymentHealth>;
  convertAgentRoleToManagedAgent: (
    request: ConvertAgentRoleToManagedAgentRequest,
  ) => Promise<ManagedAgentConversionResult>;
  convertAutomationProfileToManagedAgent: (
    request: ConvertAutomationProfileToManagedAgentRequest,
  ) => Promise<ManagedAgentConversionResult>;
  listManagedEnvironments: (params?: {
    limit?: number;
    offset?: number;
    status?: ManagedEnvironment["status"];
  }) => Promise<ManagedEnvironment[]>;
  getManagedEnvironment: (environmentId: string) => Promise<ManagedEnvironment | null>;
  createManagedEnvironment: (request: {
    name: string;
    kind?: ManagedEnvironment["kind"];
    config: ManagedEnvironment["config"];
  }) => Promise<ManagedEnvironment>;
  updateManagedEnvironment: (request: {
    environmentId: string;
    name?: string;
    config?: Partial<ManagedEnvironment["config"]>;
  }) => Promise<ManagedEnvironment | null>;
  archiveManagedEnvironment: (environmentId: string) => Promise<ManagedEnvironment | null>;
  listManagedSessions: (params?: {
    limit?: number;
    offset?: number;
    workspaceId?: string;
    status?: ManagedSession["status"];
  }) => Promise<ManagedSession[]>;
  getManagedSession: (sessionId: string) => Promise<ManagedSession | null>;
  createManagedSession: (request: ManagedSessionCreateInput) => Promise<ManagedSession>;
  resumeManagedSession: (sessionId: string) => Promise<{ resumed: boolean; session?: ManagedSession }>;
  cancelManagedSession: (sessionId: string) => Promise<ManagedSession | undefined>;
  listManagedSessionEvents: (sessionId: string, limit?: number) => Promise<ManagedSessionEvent[]>;
  getManagedSessionWorkpaper: (sessionId: string) => Promise<ManagedSessionWorkpaper>;
  listAgentTemplates: () => Promise<AgentTemplate[]>;
  listAgentWorkspaceMemberships: (workspaceId?: string) => Promise<AgentWorkspaceMembership[]>;
  updateAgentWorkspaceMembership: (request: {
    workspaceId: string;
    principalId: string;
    role: AgentWorkspaceMembership["role"];
  }) => Promise<AgentWorkspaceMembership>;
  getMyAgentWorkspacePermissions: (workspaceId: string) => Promise<AgentWorkspacePermissionSnapshot>;
  listImageGenProfiles: () => Promise<ImageGenProfile[]>;
  createImageGenProfile: (request: {
    name: string;
    description?: string;
    isDefault?: boolean;
    referencePhotoPaths?: string[];
  }) => Promise<ImageGenProfile>;
  updateImageGenProfile: (request: {
    id: string;
    name?: string;
    description?: string;
    isDefault?: boolean;
    addReferencePhotoPaths?: string[];
    removeReferencePhotoIds?: string[];
  }) => Promise<ImageGenProfile | null>;
  deleteImageGenProfile: (id: string) => Promise<boolean>;
  generateManagedSessionAudioSummary: (
    sessionId: string,
    config?: Partial<AudioSummaryConfig>,
  ) => Promise<AudioSummaryResult>;
  listSkills: () => Promise<Any[]>;
  getSkill: (id: string) => Promise<Any>;
  // LLM Settings
  getLLMSettings: () => Promise<Any>;
  saveLLMSettings: (settings: Any) => Promise<{ success: boolean }>;
  resetLLMProviderCredentials: (providerType: LLMProviderType) => Promise<{ success: boolean }>;
  testLLMProvider: (config: Any) => Promise<{ success: boolean; error?: string }>;
  getLLMModels: () => Promise<Array<{ key: string; displayName: string; description: string }>>;
  getLLMConfigStatus: () => Promise<{
    currentProvider: LLMProviderType;
    currentModel: string;
    currentReasoningEffort?: "low" | "medium" | "high" | "extra_high";
    providers: Array<{
      type: LLMProviderType;
      name: string;
      configured: boolean;
      source?: string;
    }>;
    models: Array<{
      key: string;
      displayName: string;
      description: string;
      reasoningEfforts?: Array<"low" | "medium" | "high" | "extra_high">;
    }>;
  }>;
  getLLMRoutingStatus: () => Promise<LLMRoutingRuntimeState>;
  onLLMRoutingEvent: (callback: (event: LLMRoutingRuntimeState) => void) => () => void;
  setLLMModel: (
    selection:
      | string
      | {
          providerType?: LLMProviderType;
          modelKey: string;
          reasoningEffort?: "low" | "medium" | "high" | "extra_high";
        },
  ) => Promise<{ success: boolean }>;
  getProviderModels: (
    providerType: string,
  ) => Promise<Array<{
    key: string;
    displayName: string;
    description: string;
    reasoningEfforts?: Array<"low" | "medium" | "high" | "extra_high">;
  }>>;
  getAnthropicModels: (credentials?: {
    apiKey?: string;
    subscriptionToken?: string;
    authMethod?: "api_key" | "subscription";
  }) => Promise<Array<{ id: string; displayName: string; description: string }>>;
  refreshCustomProviderModels: (
    providerType: string,
    overrides?: { apiKey?: string; baseUrl?: string },
  ) => Promise<Array<{ key: string; displayName: string; description: string }>>;
  getOllamaModels: (
    baseUrl?: string,
  ) => Promise<Array<{ name: string; size: number; modified: string }>>;
  getGeminiModels: (
    apiKey?: string,
  ) => Promise<Array<{ name: string; displayName: string; description: string }>>;
  getOpenRouterModels: (
    apiKey?: string,
    baseUrl?: string,
  ) => Promise<Array<{ id: string; name: string; context_length: number }>>;
  getOpenAIModels: (
    apiKey?: string,
  ) => Promise<Array<{ id: string; name: string; description: string }>>;
  getGroqModels: (
    apiKey?: string,
    baseUrl?: string,
  ) => Promise<Array<{ id: string; name: string }>>;
  getXAIModels: (apiKey?: string, baseUrl?: string) => Promise<Array<{ id: string; name: string }>>;
  getKimiModels: (
    apiKey?: string,
    baseUrl?: string,
  ) => Promise<Array<{ id: string; name: string }>>;
  getPiModels: (
    piProvider?: string,
  ) => Promise<Array<{ id: string; name: string; description: string }>>;
  getPiProviders: () => Promise<Array<{ id: string; name: string }>>;
  getOpenAICompatibleModels: (
    baseUrl: string,
    apiKey?: string,
  ) => Promise<Array<{ key: string; displayName: string; description: string }>>;
  // Local AI (hf-agents + llama.cpp)
  checkHf?: () => Promise<{
    installed: boolean;
    hfInstalled?: boolean;
    version?: string;
    message?: string;
    mlxInstalled?: "ok" | "broken" | false;
    mlxMessage?: string;
    isMac?: boolean;
  }>;
  detectHardware?: () => Promise<{ ok: boolean; models: string[]; output: string; error?: string }>;
  startLocalAIServer?: (model?: string) => Promise<{ ok: boolean; pid?: number; alreadyRunning?: boolean; error?: string }>;
  stopLocalAIServer?: () => Promise<{ ok: boolean; wasRunning?: boolean; error?: string }>;
  getLocalAIServerStatus?: () => Promise<{
    serverRunning: boolean;
    processAlive: boolean;
    pid?: number;
    models?: string[];
    lastError?: string | null;
  }>;
  getLocalAIServerLog?: () => Promise<{
    lines: string[];
    state: "idle" | "downloading" | "loading" | "ready" | "error";
    downloadingFile?: string;
  }>;
  openaiOAuthStart: () => Promise<{ success: boolean; error?: string }>;
  openaiOAuthLogout: () => Promise<{ success: boolean }>;
  getBedrockModels: (config?: {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    profile?: string;
  }) => Promise<Array<{ id: string; name: string; provider: string; description: string }>>;
  // Gateway / Channel APIs
  getGatewayChannels: () => Promise<Any[]>;
  addGatewayChannel: (data: AddChannelRequest) => Promise<Any>;
  updateGatewayChannel: (data: {
    id: string;
    name?: string;
    securityMode?: string;
    config?: {
      selfChatMode?: boolean;
      responsePrefix?: string;
      ingestNonSelfChatsInSelfChatMode?: boolean;
      groupRoutingMode?: string;
      trustedGroupMemoryOptIn?: boolean;
      sendReadReceipts?: boolean;
      deduplicationEnabled?: boolean;
      [key: string]: unknown;
    };
  }) => Promise<void>;
  removeGatewayChannel: (id: string) => Promise<void>;
  enableGatewayChannel: (id: string) => Promise<void>;
  disableGatewayChannel: (id: string) => Promise<void>;
  testGatewayChannel: (
    id: string,
  ) => Promise<{ success: boolean; error?: string; botUsername?: string }>;
  getGatewayUsers: (channelId: string) => Promise<Any[]>;
  getGatewayChats: (channelId: string) => Promise<Array<{ chatId: string; lastTimestamp: number }>>;
  sendGatewayTestMessage: (data: {
    channelType: string;
    channelDbId?: string;
    chatId: string;
  }) => Promise<{ ok: boolean }>;
  grantGatewayAccess: (channelId: string, userId: string, displayName?: string) => Promise<void>;
  revokeGatewayAccess: (channelId: string, userId: string) => Promise<void>;
  generateGatewayPairing: (
    channelId: string,
    userId: string,
    displayName?: string,
  ) => Promise<string>;
  onGatewayMessage: (callback: (data: Any) => void) => () => void;
  onGatewayUsersUpdated: (
    callback: (data: { channelId: string; channelType: string }) => void,
  ) => () => void;
  // WhatsApp-specific APIs
  getWhatsAppInfo: () => Promise<{ qrCode?: string; phoneNumber?: string; status?: string }>;
  whatsAppLogout: () => Promise<void>;
  onWhatsAppQRCode: (callback: (event: Any, qr: string) => void) => void;
  onWhatsAppConnected: (callback: () => void) => void;
  onWhatsAppStatus: (
    callback: (event: Any, data: { status: string; error?: string }) => void,
  ) => void;
  // Search Settings
  getSearchSettings: () => Promise<{
    primaryProvider: "tavily" | "brave" | "serpapi" | "google" | "duckduckgo" | null;
    fallbackProvider: "tavily" | "brave" | "serpapi" | "google" | "duckduckgo" | null;
  }>;
  saveSearchSettings: (settings: Any) => Promise<{ success: boolean }>;
  getSearchConfigStatus: () => Promise<{
    primaryProvider: "tavily" | "brave" | "serpapi" | "google" | "duckduckgo" | null;
    fallbackProvider: "tavily" | "brave" | "serpapi" | "google" | "duckduckgo" | null;
    providers: Array<{
      type: "tavily" | "brave" | "serpapi" | "google" | "duckduckgo";
      name: string;
      description: string;
      configured: boolean;
      supportedTypes: Array<"web" | "news" | "images">;
    }>;
    isConfigured: boolean;
  }>;
  testSearchProvider: (providerType: string) => Promise<{ success: boolean; error?: string }>;
  listProfiles: () => Promise<AppProfileSummary[]>;
  createProfile: (name: string) => Promise<AppProfileSummary>;
  switchProfile: (profileId: string) => Promise<{ success: true; relaunching: true }>;
  exportProfile: (profileId: string, destinationRoot: string) => Promise<ProfileExportResult>;
  importProfile: (sourcePath: string, profileName?: string) => Promise<AppProfileSummary>;
  // X/Twitter Settings
  getXSettings: () => Promise<{
    enabled: boolean;
    authMethod: "browser" | "manual";
    authToken?: string;
    ct0?: string;
    cookieSource?: string[];
    chromeProfile?: string;
    chromeProfileDir?: string;
    firefoxProfile?: string;
    timeoutMs?: number;
    cookieTimeoutMs?: number;
    quoteDepth?: number;
    mentionTrigger: {
      enabled: boolean;
      commandPrefix: string;
      allowedAuthors: string[];
      pollIntervalSec: number;
      fetchCount: number;
      workspaceMode: "temporary";
    };
  }>;
  saveXSettings: (settings: Any) => Promise<{ success: boolean }>;
  testXConnection: () => Promise<{
    success: boolean;
    error?: string;
    username?: string;
    userId?: string;
  }>;
  getXStatus: () => Promise<{
    installed: boolean;
    connected: boolean;
    username?: string;
    error?: string;
    mentionTriggerStatus: {
      mode: "bridge" | "native" | "disabled";
      running: boolean;
      lastPollAt?: number;
      lastSuccessAt?: number;
      lastError?: string;
      acceptedCount: number;
      ignoredCount: number;
      lastTaskId?: string;
    };
  }>;
  // Notion Settings
  getNotionSettings: () => Promise<{
    enabled: boolean;
    apiKey?: string;
    notionVersion?: string;
    timeoutMs?: number;
  }>;
  saveNotionSettings: (settings: Any) => Promise<{ success: boolean }>;
  testNotionConnection: () => Promise<{
    success: boolean;
    error?: string;
    name?: string;
    userId?: string;
  }>;
  getNotionStatus: () => Promise<{
    configured: boolean;
    connected: boolean;
    name?: string;
    error?: string;
  }>;
  // Box Settings
  getBoxSettings: () => Promise<{
    enabled: boolean;
    accessToken?: string;
    timeoutMs?: number;
  }>;
  saveBoxSettings: (settings: Any) => Promise<{ success: boolean }>;
  testBoxConnection: () => Promise<{
    success: boolean;
    error?: string;
    name?: string;
    userId?: string;
  }>;
  getBoxStatus: () => Promise<{
    configured: boolean;
    connected: boolean;
    name?: string;
    error?: string;
  }>;
  // OneDrive Settings
  getOneDriveSettings: () => Promise<{
    enabled: boolean;
    accessToken?: string;
    driveId?: string;
    timeoutMs?: number;
  }>;
  saveOneDriveSettings: (settings: Any) => Promise<{ success: boolean }>;
  testOneDriveConnection: () => Promise<{
    success: boolean;
    error?: string;
    name?: string;
    userId?: string;
    driveId?: string;
  }>;
  getOneDriveStatus: () => Promise<{
    configured: boolean;
    connected: boolean;
    name?: string;
    error?: string;
  }>;
  // Google Workspace Settings
  getGoogleWorkspaceSettings: () => Promise<{
    enabled: boolean;
    clientId?: string;
    clientSecret?: string;
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    scopes?: string[];
    timeoutMs?: number;
  }>;
  saveGoogleWorkspaceSettings: (settings: Any) => Promise<{ success: boolean }>;
  testGoogleWorkspaceConnection: () => Promise<{
    success: boolean;
    error?: string;
    name?: string;
    userId?: string;
    email?: string;
  }>;
  getGoogleWorkspaceStatus: () => Promise<{
    configured: boolean;
    connected: boolean;
    name?: string;
    error?: string;
  }>;
  startGoogleWorkspaceOAuth: (payload: {
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    loginHint?: string;
  }) => Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    tokenType?: string;
    scopes?: string[];
  }>;
  getGoogleWorkspaceOAuthLink: (payload: {
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    loginHint?: string;
  }) => Promise<{ url: string }>;
  // AgentMail Settings
  getAgentMailSettings: () => Promise<AgentMailSettingsData>;
  saveAgentMailSettings: (settings: Any) => Promise<{ success: boolean }>;
  testAgentMailConnection: () => Promise<AgentMailConnectionTestResult>;
  getAgentMailStatus: () => Promise<AgentMailStatus>;
  listAgentMailPods: () => Promise<AgentMailPod[]>;
  getAgentMailWorkspaceBinding: (workspaceId: string) => Promise<AgentMailWorkspaceBinding | null>;
  bindAgentMailWorkspacePod: (payload: {
    workspaceId: string;
    podId: string;
  }) => Promise<AgentMailWorkspaceBinding>;
  createAgentMailWorkspacePod: (payload: {
    workspaceId: string;
    podName?: string;
  }) => Promise<AgentMailWorkspaceBinding>;
  listAgentMailInboxes: (workspaceId: string) => Promise<AgentMailInbox[]>;
  createAgentMailInbox: (payload: {
    workspaceId: string;
    username?: string;
    domain?: string;
    displayName?: string;
    clientId?: string;
  }) => Promise<AgentMailInbox>;
  updateAgentMailInbox: (payload: {
    workspaceId: string;
    inboxId: string;
    displayName: string;
  }) => Promise<AgentMailInbox>;
  deleteAgentMailInbox: (payload: {
    workspaceId: string;
    inboxId: string;
  }) => Promise<{ success: boolean }>;
  listAgentMailDomains: (workspaceId: string) => Promise<AgentMailDomain[]>;
  createAgentMailDomain: (payload: {
    workspaceId: string;
    domain: string;
    feedbackEnabled?: boolean;
  }) => Promise<AgentMailDomain>;
  verifyAgentMailDomain: (payload: {
    workspaceId: string;
    domainId: string;
  }) => Promise<AgentMailDomain | null>;
  deleteAgentMailDomain: (payload: {
    workspaceId: string;
    domainId: string;
  }) => Promise<{ success: boolean }>;
  listAgentMailListEntries: (payload: {
    workspaceId: string;
    inboxId?: string;
    direction?: AgentMailListEntry["direction"];
    listType?: AgentMailListEntry["listType"];
  }) => Promise<AgentMailListEntry[]>;
  createAgentMailListEntry: (payload: {
    workspaceId: string;
    inboxId?: string;
    direction: AgentMailListEntry["direction"];
    listType: AgentMailListEntry["listType"];
    entry: string;
    reason?: string;
  }) => Promise<AgentMailListEntry>;
  deleteAgentMailListEntry: (payload: {
    workspaceId: string;
    inboxId?: string;
    direction: AgentMailListEntry["direction"];
    listType: AgentMailListEntry["listType"];
    entry: string;
  }) => Promise<{ success: boolean }>;
  listAgentMailInboxApiKeys: (payload: {
    workspaceId: string;
    inboxId: string;
  }) => Promise<AgentMailApiKeySummary[]>;
  createAgentMailInboxApiKey: (payload: {
    workspaceId: string;
    inboxId: string;
    name?: string;
    permissions?: Record<string, boolean>;
  }) => Promise<AgentMailApiKeySummary & { apiKey?: string }>;
  deleteAgentMailInboxApiKey: (payload: {
    workspaceId: string;
    inboxId: string;
    apiKeyId: string;
  }) => Promise<{ success: boolean }>;
  refreshAgentMailWorkspace: (workspaceId: string) => Promise<{
    binding: AgentMailWorkspaceBinding;
    inboxes: AgentMailInbox[];
    domains: AgentMailDomain[];
  }>;
  // Dropbox Settings
  getDropboxSettings: () => Promise<{
    enabled: boolean;
    accessToken?: string;
    timeoutMs?: number;
  }>;
  saveDropboxSettings: (settings: Any) => Promise<{ success: boolean }>;
  testDropboxConnection: () => Promise<{
    success: boolean;
    error?: string;
    name?: string;
    userId?: string;
    email?: string;
  }>;
  getDropboxStatus: () => Promise<{
    configured: boolean;
    connected: boolean;
    name?: string;
    error?: string;
  }>;
  // SharePoint Settings
  getSharePointSettings: () => Promise<{
    enabled: boolean;
    accessToken?: string;
    siteId?: string;
    driveId?: string;
    timeoutMs?: number;
  }>;
  saveSharePointSettings: (settings: Any) => Promise<{ success: boolean }>;
  testSharePointConnection: () => Promise<{
    success: boolean;
    error?: string;
    name?: string;
    userId?: string;
  }>;
  getSharePointStatus: () => Promise<{
    configured: boolean;
    connected: boolean;
    name?: string;
    error?: string;
  }>;
  // Health Platform
  getHealthDashboard: () => Promise<HealthDashboard>;
  listHealthSources: () => Promise<HealthSource[]>;
  upsertHealthSource: (source: HealthSourceInput) => Promise<HealthSource>;
  removeHealthSource: (sourceId: string) => Promise<{ success: boolean }>;
  syncHealthSource: (sourceId: string) => Promise<HealthSyncResult>;
  importHealthFiles: (
    sourceId: string,
    filePaths: string[],
  ) => Promise<HealthSyncResult>;
  generateHealthWorkflow: (
    request: HealthWorkflowRequest,
  ) => Promise<{ success: boolean; workflow?: HealthWorkflow; error?: string }>;
  getAppleHealthStatus: (sourceId?: string) => Promise<{
    available: boolean;
    authorizationStatus: string;
    readableTypes: string[];
    writableTypes: string[];
    sourceMode: HealthSourceConnectionMode;
    lastSyncedAt?: number;
    lastError?: string;
  }>;
  connectAppleHealth: (payload: {
    sourceId?: string;
    connectionMode?: HealthSourceConnectionMode;
  }) => Promise<{ success: boolean; source?: HealthSource; error?: string }>;
  disconnectAppleHealth: (sourceId: string) => Promise<{ success: boolean }>;
  resetAppleHealth: (sourceId?: string) => Promise<{ success: boolean; removedCount: number }>;
  previewAppleHealthWriteback: (request: HealthWritebackRequest) => Promise<
    { success: boolean; preview?: HealthWritebackPreview; error?: string }
  >;
  applyAppleHealthWriteback: (request: HealthWritebackRequest) => Promise<
    { success: boolean; writtenCount?: number; warnings?: string[]; error?: string }
  >;
  // App Updates
  getAppVersion: () => Promise<{
    version: string;
    isDev: boolean;
    isGitRepo: boolean;
    isNpmGlobal: boolean;
    gitBranch?: string;
    gitCommit?: string;
  }>;
  checkForUpdates: () => Promise<{
    available: boolean;
    currentVersion: string;
    latestVersion: string;
    releaseNotes?: string;
    releaseUrl?: string;
    publishedAt?: string;
    updateMode: "git" | "npm" | "electron-updater";
  }>;
  downloadUpdate: (updateInfo: Any) => Promise<{ success: boolean }>;
  installUpdate: () => Promise<{ success: boolean }>;
  onUpdateProgress: (
    callback: (progress: {
      phase: "checking" | "downloading" | "extracting" | "installing" | "complete" | "error";
      percent?: number;
      message: string;
      bytesDownloaded?: number;
      bytesTotal?: number;
    }) => void,
  ) => () => void;
  onUpdateDownloaded: (
    callback: (info: { requiresRestart: boolean; message: string }) => void,
  ) => () => void;
  onUpdateError: (callback: (error: { error: string }) => void) => () => void;
  // Guardrail Settings
  getGuardrailSettings: () => Promise<GuardrailSettings>;
  saveGuardrailSettings: (settings: Any) => Promise<{ success: boolean }>;
  getGuardrailDefaults: () => Promise<GuardrailSettings>;
  // Permission Settings
  getPermissionSettings: () => Promise<PermissionSettingsData>;
  savePermissionSettings: (settings: PermissionSettingsData) => Promise<{ success: boolean }>;
  getWorkspacePermissionRules: (workspaceId: string) => Promise<PersistedPermissionRule[]>;
  deleteWorkspacePermissionRule: (payload: {
    workspaceId: string;
    ruleId: string;
  }) => Promise<{ success: boolean; removed: boolean; dbRemoved?: boolean; manifestRemoved?: boolean; manifestPath?: string; manifestError?: string }>;
  // Appearance Settings
  getAppearanceSettings: () => Promise<{
    themeMode: "light" | "dark" | "system";
    visualTheme: "terminal" | "warm" | "oblivion";
    transparencyEffectsEnabled?: boolean;
    accentColor:
      | "cyan"
      | "blue"
      | "purple"
      | "pink"
      | "rose"
      | "orange"
      | "green"
      | "teal"
      | "coral";
    uiDensity?: "focused" | "full" | "power";
    timelineVerbosity?: "summary" | "verbose";
    language?: string;
    devRunLoggingEnabled?: boolean;
    disclaimerAccepted?: boolean;
    onboardingCompleted?: boolean;
    onboardingCompletedAt?: string;
    assistantName?: string;
  }>;
  getAppearanceRuntimeInfo: () => Promise<{
    prefersReducedTransparency: boolean;
    devLogCaptureEnabled: boolean;
  }>;
  saveAppearanceSettings: (settings: {
    themeMode?: "light" | "dark" | "system";
    visualTheme?: "terminal" | "warm" | "oblivion";
    transparencyEffectsEnabled?: boolean;
    accentColor?:
      | "cyan"
      | "blue"
      | "purple"
      | "pink"
      | "rose"
      | "orange"
      | "green"
      | "teal"
      | "coral";
    uiDensity?: "focused" | "full" | "power";
    timelineVerbosity?: "summary" | "verbose";
    language?: string;
    devRunLoggingEnabled?: boolean;
    disclaimerAccepted?: boolean;
    onboardingCompleted?: boolean;
    onboardingCompletedAt?: string;
    assistantName?: string;
  }) => Promise<{ success: boolean }>;
  // Personality Settings
  getPersonalitySettings: () => Promise<{
    activePersonality:
      | "professional"
      | "friendly"
      | "concise"
      | "creative"
      | "technical"
      | "casual"
      | "custom";
    customPrompt?: string;
    customName?: string;
    agentName?: string;
    activePersona?:
      | "none"
      | "jarvis"
      | "friday"
      | "hal"
      | "computer"
      | "alfred"
      | "intern"
      | "sensei"
      | "pirate"
      | "noir"
      | "companion";
    responseStyle?: {
      emojiUsage: "none" | "minimal" | "moderate" | "expressive";
      responseLength: "terse" | "balanced" | "detailed";
      codeCommentStyle: "minimal" | "moderate" | "verbose";
      explanationDepth: "expert" | "balanced" | "teaching";
    };
    quirks?: {
      catchphrase?: string;
      signOff?: string;
      analogyDomain:
        | "none"
        | "cooking"
        | "sports"
        | "space"
        | "music"
        | "nature"
        | "gaming"
        | "movies"
        | "construction";
    };
    relationship?: {
      userName?: string;
      tasksCompleted: number;
      firstInteraction?: number;
      lastMilestoneCelebrated: number;
      projectsWorkedOn: string[];
    };
    workStyle?: "planner" | "flexible";
  }>;
  savePersonalitySettings: (settings: {
    activePersonality?:
      | "professional"
      | "friendly"
      | "concise"
      | "creative"
      | "technical"
      | "casual"
      | "custom";
    customPrompt?: string;
    customName?: string;
    agentName?: string;
    activePersona?:
      | "none"
      | "jarvis"
      | "friday"
      | "hal"
      | "computer"
      | "alfred"
      | "intern"
      | "sensei"
      | "pirate"
      | "noir"
      | "companion";
    responseStyle?: {
      emojiUsage?: "none" | "minimal" | "moderate" | "expressive";
      responseLength?: "terse" | "balanced" | "detailed";
      codeCommentStyle?: "minimal" | "moderate" | "verbose";
      explanationDepth?: "expert" | "balanced" | "teaching";
    };
    quirks?: {
      catchphrase?: string;
      signOff?: string;
      analogyDomain?:
        | "none"
        | "cooking"
        | "sports"
        | "space"
        | "music"
        | "nature"
        | "gaming"
        | "movies"
        | "construction";
    };
    relationship?: {
      userName?: string;
      tasksCompleted?: number;
      firstInteraction?: number;
      lastMilestoneCelebrated?: number;
      projectsWorkedOn?: string[];
    };
    workStyle?: "planner" | "flexible";
  }) => Promise<{ success: boolean }>;
  getPersonalityDefinitions: () => Promise<
    Array<{
      id: "professional" | "friendly" | "concise" | "creative" | "technical" | "casual" | "custom";
      name: string;
      description: string;
      icon: string;
      traits: string[];
      promptTemplate: string;
    }>
  >;
  getPersonaDefinitions: () => Promise<
    Array<{
      id:
        | "none"
        | "jarvis"
        | "friday"
        | "hal"
        | "computer"
        | "alfred"
        | "intern"
        | "sensei"
        | "pirate"
        | "noir"
        | "companion";
      name: string;
      description: string;
      icon: string;
      promptTemplate: string;
      suggestedName?: string;
      sampleCatchphrase?: string;
      sampleSignOff?: string;
    }>
  >;
  getRelationshipStats: () => Promise<{
    tasksCompleted: number;
    projectsCount: number;
    daysTogether: number;
    nextMilestone: number | null;
  }>;
  setActivePersonality: (personalityId: string) => Promise<{ success: boolean }>;
  setActivePersona: (personaId: string) => Promise<{ success: boolean }>;
  resetPersonalitySettings: (preserveRelationship?: boolean) => Promise<{ success: boolean }>;
  getPersonalityConfigV2: () => Promise<Any>;
  savePersonalityConfigV2: (config: Any) => Promise<{ success: boolean }>;
  exportPersonalityProfile: (format?: "json" | "md") => Promise<string>;
  importPersonalityProfile: (data: string) => Promise<{ success: boolean }>;
  getPersonalityPreview: (draft: Any, contextMode?: string) => Promise<Any>;
  getPersonalityTraitPresets: () => Promise<Any>;
  onPersonalitySettingsChanged: (callback: (settings: Any) => void) => () => void;
  // Queue APIs
  getQueueStatus: () => Promise<{
    runningCount: number;
    queuedCount: number;
    runningTaskIds: string[];
    queuedTaskIds: string[];
    maxConcurrent: number;
  }>;
  getQueueSettings: () => Promise<{
    maxConcurrentTasks: number;
    taskTimeoutMinutes: number;
  }>;
  saveQueueSettings: (settings: {
    maxConcurrentTasks?: number;
    taskTimeoutMinutes?: number;
  }) => Promise<{ success: boolean }>;
  clearQueue: () => Promise<{ success: boolean; clearedRunning: number; clearedQueued: number }>;
  onQueueUpdate: (
    callback: (status: {
      runningCount: number;
      queuedCount: number;
      runningTaskIds: string[];
      queuedTaskIds: string[];
      maxConcurrent: number;
    }) => void,
  ) => () => void;
  // Custom Skills APIs
  listCustomSkills: () => Promise<CustomSkill[]>;
  listTaskSkills: () => Promise<CustomSkill[]>;
  listGuidelineSkills: () => Promise<CustomSkill[]>;
  getCustomSkill: (id: string) => Promise<CustomSkill | undefined>;
  createCustomSkill: (skill: Omit<CustomSkill, "filePath">) => Promise<CustomSkill>;
  updateCustomSkill: (id: string, updates: Partial<CustomSkill>) => Promise<CustomSkill>;
  deleteCustomSkill: (id: string) => Promise<boolean>;
  reloadCustomSkills: () => Promise<CustomSkill[]>;
  openCustomSkillsFolder: () => Promise<void>;
  getCustomSkillSettings: () => Promise<SkillsConfig>;
  setExternalSkillDirectories: (dirs: string[]) => Promise<SkillsConfig>;
  openExternalSkillFolder: (dir: string) => Promise<void>;
  // Skill Registry (SkillHub) APIs
  searchSkillRegistry: (
    query: string,
    options?: { page?: number; pageSize?: number },
  ) => Promise<SkillSearchResult>;
  searchClawHubSkills: (
    query: string,
    options?: { page?: number; pageSize?: number },
  ) => Promise<SkillSearchResult>;
  getSkillDetails: (skillId: string) => Promise<SkillRegistryEntry | null>;
  installSkillFromRegistry: (
    skillId: string,
    version?: string,
  ) => Promise<{
    success: boolean;
    skill?: CustomSkill;
    error?: string;
    security?: import("../shared/types").InstallSecurityOutcome;
  }>;
  installSkillFromClawHub: (
    identifierOrUrl: string,
  ) => Promise<{
    success: boolean;
    skill?: CustomSkill;
    error?: string;
    security?: import("../shared/types").InstallSecurityOutcome;
  }>;
  installSkillFromUrl: (url: string) => Promise<{
    success: boolean;
    skill?: CustomSkill;
    error?: string;
    security?: import("../shared/types").InstallSecurityOutcome;
  }>;
  installSkillFromGit: (
    gitUrl: string,
  ) => Promise<{
    success: boolean;
    skill?: CustomSkill;
    error?: string;
    security?: import("../shared/types").InstallSecurityOutcome;
  }>;
  updateSkillFromRegistry: (
    skillId: string,
    version?: string,
  ) => Promise<{
    success: boolean;
    skill?: CustomSkill;
    error?: string;
    security?: import("../shared/types").InstallSecurityOutcome;
  }>;
  updateAllSkills: () => Promise<{ updated: string[]; failed: string[] }>;
  uninstallSkill: (skillId: string) => Promise<{ success: boolean; error?: string }>;
  listManagedSkills: () => Promise<CustomSkill[]>;
  checkSkillUpdates: (
    skillId: string,
  ) => Promise<{ hasUpdate: boolean; currentVersion: string | null; latestVersion: string | null }>;
  getSkillStatus: () => Promise<SkillStatusReport>;
  getEligibleSkills: () => Promise<CustomSkill[]>;
  listQuarantinedImports: () => Promise<import("../shared/types").QuarantinedImportRecord[]>;
  getImportSecurityReport: (
    request: import("../shared/types").ImportSecurityReportRequest,
  ) => Promise<import("../shared/types").CapabilitySecurityReport | null>;
  retryQuarantinedImport: (
    recordId: string,
  ) => Promise<import("../shared/types").RetryQuarantinedImportResult>;
  removeQuarantinedImport: (
    recordId: string,
  ) => Promise<{ success: boolean; error?: string }>;
  // MCP (Model Context Protocol)
  getMCPSettings: () => Promise<MCPSettings>;
  saveMCPSettings: (settings: MCPSettings) => Promise<{ success: boolean }>;
  addMCPServer: (config: Omit<MCPServerConfig, "id">) => Promise<MCPServerConfig>;
  updateMCPServer: (id: string, updates: Partial<MCPServerConfig>) => Promise<MCPServerConfig>;
  removeMCPServer: (id: string) => Promise<void>;
  connectMCPServer: (serverId: string) => Promise<void>;
  disconnectMCPServer: (serverId: string) => Promise<void>;
  getMCPStatus: () => Promise<MCPServerStatus[]>;
  getMCPServerStatus: (serverId: string) => Promise<MCPServerStatus | null>;
  getMCPAllTools: () => Promise<MCPTool[]>;
  getMCPServerTools: (serverId: string) => Promise<MCPTool[]>;
  testMCPServer: (
    serverId: string,
  ) => Promise<{ success: boolean; error?: string; tools?: number }>;
  deviceListFiles: (params: {
    nodeId: string;
    workspaceId: string;
    path?: string;
  }) => Promise<{
    ok: boolean;
    files?: Array<{ name: string; type: "file" | "directory"; size: number }>;
    error?: string;
  }>;
  deviceListRemoteWorkspaces: (nodeId: string) => Promise<{
    ok: boolean;
    workspaces?: Array<{ id: string; name: string }>;
    error?: string;
  }>;
  startConnectorOAuth: (payload: {
    provider:
      | "salesforce"
      | "jira"
      | "hubspot"
      | "zendesk"
      | "google-calendar"
      | "google-drive"
      | "gmail"
      | "google-workspace"
      | "docusign"
      | "outreach"
      | "slack"
      | "microsoft-email";
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    loginUrl?: string;
    subdomain?: string;
    teamDomain?: string;
    tenant?: string;
    loginHint?: string;
  }) => Promise<{
    provider:
      | "salesforce"
      | "jira"
      | "hubspot"
      | "zendesk"
      | "google-calendar"
      | "google-drive"
      | "gmail"
      | "google-workspace"
      | "docusign"
      | "outreach"
      | "slack"
      | "microsoft-email";
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    tokenType?: string;
    scopes?: string[];
    instanceUrl?: string;
    resources?: Array<{ id: string; name: string; url: string; scopes?: string[] }>;
  }>;
  onMCPStatusChange: (callback: (status: MCPServerStatus[]) => void) => () => void;
  // MCP Registry
  fetchMCPRegistry: () => Promise<MCPRegistry>;
  searchMCPRegistry: (query: string, tags?: string[]) => Promise<MCPRegistryEntry[]>;
  installMCPServer: (entryId: string) => Promise<MCPServerConfig>;
  uninstallMCPServer: (serverId: string) => Promise<void>;
  checkMCPUpdates: () => Promise<MCPUpdateInfo[]>;
  updateMCPServerFromRegistry: (serverId: string) => Promise<MCPServerConfig>;
  // MCP Host
  startMCPHost: (port?: number) => Promise<{ success: boolean; port?: number }>;
  stopMCPHost: () => Promise<void>;
  getMCPHostStatus: () => Promise<{ running: boolean; port?: number }>;
  // Infrastructure
  infraGetStatus: () => Promise<InfraStatus>;
  infraGetSettings: () => Promise<InfraSettings>;
  infraSaveSettings: (settings: InfraSettings) => Promise<{ success: boolean }>;
  infraSetup: () => Promise<InfraStatus>;
  infraGetWallet: () => Promise<WalletInfo | null>;
  infraWalletRestore: () => Promise<{ success: boolean; address?: string; status: string }>;
  infraWalletVerify: () => Promise<{ status: string; address?: string }>;
  infraReset: () => Promise<{ success: boolean }>;
  onInfraStatusChange: (callback: (status: InfraStatus) => void) => () => void;
  // Scraping (Scrapling)
  scrapingGetSettings: () => Promise<Any>;
  scrapingSaveSettings: (settings: Any) => Promise<{ success: boolean }>;
  scrapingGetStatus: () => Promise<{
    installed: boolean;
    pythonAvailable: boolean;
    version: string | null;
    error?: string;
  }>;
  scrapingReset: () => Promise<{ success: boolean }>;
  // Built-in Tools Settings
  getBuiltinToolsSettings: () => Promise<BuiltinToolsSettings>;
  saveBuiltinToolsSettings: (settings: BuiltinToolsSettings) => Promise<{ success: boolean }>;
  getBuiltinToolsCategories: () => Promise<Record<string, string[]>>;
  getChronicleSettings: () => Promise<ChronicleSettings>;
  saveChronicleSettings: (
    settings: Partial<ChronicleSettings>,
  ) => Promise<{ success: boolean; settings: ChronicleSettings }>;
  getChronicleStatus: () => Promise<ChronicleCaptureStatus>;
  queryChronicleRecentContext: (input: {
    query: string;
    limit?: number;
    useFallback?: boolean;
  }) => Promise<ChronicleResolvedContext[]>;
  listChronicleObservations: (input: {
    workspaceId: string;
    limit?: number;
  }) => Promise<Any[]>;
  deleteChronicleObservation: (input: {
    workspaceId: string;
    observationId: string;
  }) => Promise<{ success: boolean }>;
  clearChronicleObservations: (input: {
    workspaceId: string;
  }) => Promise<{ success: boolean; deleted?: number }>;
  getComputerUseStatus: () => Promise<{
    activeTaskId: string | null;
    helperPath: string;
    sourcePath: string | null;
    installed: boolean;
    accessibilityTrusted: boolean;
    screenCaptureStatus: string;
    error: string | null;
  }>;
  endComputerUseSession: () => Promise<{ success: boolean }>;
  openComputerUseAccessibilitySettings: () => Promise<{ success: boolean }>;
  openComputerUseScreenRecordingSettings: () => Promise<{ success: boolean }>;
  onComputerUseEvent: (callback: (event: Any) => void) => () => void;
  // Tray (Menu Bar)
  getTraySettings: () => Promise<TraySettings>;
  saveTraySettings: (
    settings: Partial<TraySettings>,
  ) => Promise<{ success: boolean; settings: TraySettings }>;
  onTrayNewTask: (callback: () => void) => () => void;
  onTraySelectWorkspace: (callback: (event: Any, workspaceId: string) => void) => () => void;
  onTrayOpenSettings: (callback: () => void) => () => void;
  onTrayOpenAbout: (callback: () => void) => () => void;
  onTrayCheckUpdates: (callback: () => void) => () => void;
  // Cron (Scheduled Tasks)
  getCronStatus: () => Promise<CronStatusSummary>;
  listCronJobs: (opts?: { includeDisabled?: boolean }) => Promise<CronJob[]>;
  getCronJob: (id: string) => Promise<CronJob | null>;
  addCronJob: (
    job: CronJobCreate,
  ) => Promise<{ ok: true; job: CronJob } | { ok: false; error: string }>;
  updateCronJob: (
    id: string,
    patch: CronJobPatch,
  ) => Promise<{ ok: true; job: CronJob } | { ok: false; error: string }>;
  removeCronJob: (
    id: string,
  ) => Promise<{ ok: true; removed: boolean } | { ok: false; removed: false; error: string }>;
  runCronJob: (
    id: string,
    mode?: "due" | "force",
  ) => Promise<
    | { ok: true; ran: true; taskId: string }
    | { ok: true; ran: false; reason: "not-due" | "disabled" | "not-found" }
    | { ok: false; error: string }
  >;
  onCronEvent: (callback: (event: CronEvent) => void) => () => void;
  getCronRunHistory: (id: string) => Promise<CronRunHistoryResult | null>;
  clearCronRunHistory: (id: string) => Promise<boolean>;
  getCronWebhookStatus: () => Promise<CronWebhookStatus>;
  listCouncils: (workspaceId: string) => Promise<CouncilConfig[]>;
  getCouncil: (id: string) => Promise<CouncilConfig | null>;
  createCouncil: (data: CreateCouncilConfigRequest) => Promise<CouncilConfig>;
  updateCouncil: (data: UpdateCouncilConfigRequest) => Promise<CouncilConfig | null>;
  deleteCouncil: (id: string) => Promise<boolean>;
  runCouncilNow: (id: string) => Promise<CouncilRun | null>;
  listCouncilRuns: (payload: { councilConfigId: string; limit?: number }) => Promise<CouncilRun[]>;
  getCouncilMemo: (query: string | { id?: string; councilConfigId?: string }) => Promise<CouncilMemo | null>;
  setCouncilEnabled: (id: string, enabled: boolean) => Promise<CouncilConfig | null>;
  // Notifications
  listNotifications: () => Promise<AppNotification[]>;
  addNotification: (data: {
    type: NotificationType;
    title: string;
    message: string;
    taskId?: string;
    cronJobId?: string;
    workspaceId?: string;
    suggestionId?: string;
    recommendedDelivery?: "briefing" | "inbox" | "nudge";
    companionStyle?: "email" | "note";
  }) => Promise<AppNotification | null>;
  getUnreadNotificationCount: () => Promise<number>;
  markNotificationRead: (id: string) => Promise<AppNotification | null>;
  markAllNotificationsRead: () => Promise<void>;
  deleteNotification: (id: string) => Promise<boolean>;
  deleteAllNotifications: () => Promise<void>;
  onNotificationEvent: (callback: (event: NotificationEvent) => void) => () => void;
  onNavigateToTask: (callback: (taskId: string) => void) => () => void;
  // Hooks (Webhooks & Gmail Pub/Sub)
  getHooksSettings: () => Promise<HooksSettings>;
  saveHooksSettings: (settings: Partial<HooksSettings>) => Promise<HooksSettings>;
  enableHooks: () => Promise<{ enabled: boolean; gmailWatcherError?: string }>;
  disableHooks: () => Promise<{ enabled: boolean }>;
  regenerateHookToken: () => Promise<{ token: string }>;
  getHooksStatus: () => Promise<HooksStatus>;
  addHookMapping: (mapping: HookMapping) => Promise<{ ok: boolean }>;
  removeHookMapping: (id: string) => Promise<{ ok: boolean }>;
  configureGmailHooks: (
    config: GmailHooksConfig,
  ) => Promise<{ ok: boolean; gmail?: GmailHooksConfig }>;
  getGmailHooksStatus: () => Promise<GmailHooksStatus>;
  startGmailWatcher: () => Promise<{ ok: boolean; error?: string }>;
  stopGmailWatcher: () => Promise<{ ok: boolean }>;
  onHooksEvent: (callback: (event: HooksEvent) => void) => () => void;
  listRoutines: () => Promise<Any[]>;
  getRoutine: (id: string) => Promise<Any | null>;
  listRoutineRuns: (routineId?: string, limit?: number) => Promise<Any[]>;
  createRoutine: (data: Any) => Promise<Any>;
  updateRoutine: (id: string, updates: Any) => Promise<Any | null>;
  removeRoutine: (id: string) => Promise<boolean>;
  runRoutineNow: (id: string) => Promise<Any | null>;
  regenerateRoutineApiToken: (routineId: string, triggerId: string) => Promise<Any | null>;

  // Control Plane (WebSocket Gateway)
  getControlPlaneSettings: () => Promise<ControlPlaneSettingsData>;
  saveControlPlaneSettings: (
    settings: Partial<ControlPlaneSettingsData>,
  ) => Promise<{ ok: boolean; error?: string }>;
  enableControlPlane: () => Promise<{ ok: boolean; token?: string; error?: string }>;
  disableControlPlane: () => Promise<{ ok: boolean; error?: string }>;
  startControlPlane: () => Promise<{
    ok: boolean;
    address?: { host: string; port: number; wsUrl: string };
    tailscale?: { httpsUrl?: string; wssUrl?: string };
    error?: string;
  }>;
  stopControlPlane: () => Promise<{ ok: boolean; error?: string }>;
  getControlPlaneStatus: () => Promise<ControlPlaneStatus>;
  getControlPlaneToken: () => Promise<{
    ok: boolean;
    token?: string;
    remoteToken?: string;
    error?: string;
  }>;
  regenerateControlPlaneToken: () => Promise<{ ok: boolean; token?: string; error?: string }>;
  onControlPlaneEvent: (callback: (event: ControlPlaneEvent) => void) => () => void;

  // Tailscale
  checkTailscaleAvailability: () => Promise<TailscaleAvailability>;
  getTailscaleStatus: () => Promise<{ settings: Any; exposure: Any }>;
  setTailscaleMode: (mode: TailscaleMode) => Promise<{ ok: boolean; error?: string }>;

  // Remote Gateway
  connectRemoteGateway: (config?: RemoteGatewayConfig) => Promise<{ ok: boolean; error?: string }>;
  disconnectRemoteGateway: () => Promise<{ ok: boolean; error?: string }>;
  getRemoteGatewayStatus: () => Promise<RemoteGatewayStatus>;
  saveRemoteGatewayConfig: (
    config: RemoteGatewayConfig,
  ) => Promise<{ ok: boolean; error?: string }>;
  testRemoteGatewayConnection: (
    config: RemoteGatewayConfig,
  ) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  onRemoteGatewayEvent: (callback: (event: RemoteGatewayEvent) => void) => () => void;

  // SSH Tunnel
  connectSSHTunnel: (config: SSHTunnelConfig) => Promise<{ ok: boolean; error?: string }>;
  disconnectSSHTunnel: () => Promise<{ ok: boolean; error?: string }>;
  getSSHTunnelStatus: () => Promise<SSHTunnelStatus>;
  saveSSHTunnelConfig: (config: SSHTunnelConfig) => Promise<{ ok: boolean; error?: string }>;
  testSSHTunnelConnection: (
    config: SSHTunnelConfig,
  ) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  onSSHTunnelEvent: (callback: (event: SSHTunnelEvent) => void) => () => void;

  // Device Fleet
  listManagedDevices: () => Promise<{ ok: boolean; devices?: ManagedDevice[]; error?: string }>;
  getDeviceSummary: (
    deviceId: string,
  ) => Promise<{ ok: boolean; summary?: ManagedDeviceSummary; error?: string }>;
  connectDevice: (
    deviceId: string,
  ) => Promise<{ ok: boolean; status?: RemoteGatewayStatus; error?: string }>;
  disconnectDevice: (
    deviceId: string,
  ) => Promise<{ ok: boolean; status?: RemoteGatewayStatus; error?: string }>;
  deviceProxyRequest: (
    request: DeviceProxyRequest,
  ) => Promise<{ ok: boolean; payload?: unknown; error?: string }>;

  // Live Canvas APIs
  canvasCreate: (data: {
    taskId: string;
    workspaceId: string;
    title?: string;
  }) => Promise<CanvasSession>;
  canvasGetSession: (sessionId: string) => Promise<CanvasSession | null>;
  canvasListSessions: (taskId?: string) => Promise<CanvasSession[]>;
  canvasShow: (sessionId: string) => Promise<{ success: boolean }>;
  canvasHide: (sessionId: string) => Promise<{ success: boolean }>;
  canvasClose: (sessionId: string) => Promise<{ success: boolean }>;
  canvasPush: (data: {
    sessionId: string;
    content: string;
    filename?: string;
  }) => Promise<{ success: boolean }>;
  canvasEval: (data: { sessionId: string; script: string }) => Promise<{ result: unknown }>;
  canvasSnapshot: (
    sessionId: string,
  ) => Promise<{ imageBase64: string; width: number; height: number }>;
  canvasExportHTML: (sessionId: string) => Promise<{ content: string; filename: string }>;
  canvasExportToFolder: (data: {
    sessionId: string;
    targetDir: string;
  }) => Promise<{ files: string[]; targetDir: string }>;
  canvasOpenInBrowser: (sessionId: string) => Promise<{ success: boolean; path: string }>;
  canvasOpenUrl: (data: {
    sessionId: string;
    url: string;
    show?: boolean;
  }) => Promise<{ success: boolean; url: string }>;
  canvasGetSessionDir: (sessionId: string) => Promise<string | null>;
  canvasCheckpointSave: (data: {
    sessionId: string;
    label?: string;
  }) => Promise<{ id: string; label: string; createdAt: number }>;
  canvasCheckpointList: (
    sessionId: string,
  ) => Promise<Array<{ id: string; label: string; createdAt: number }>>;
  canvasCheckpointRestore: (data: {
    sessionId: string;
    checkpointId: string;
  }) => Promise<{ id: string; label: string }>;
  canvasCheckpointDelete: (data: {
    sessionId: string;
    checkpointId: string;
  }) => Promise<{ success: boolean }>;
  canvasGetContent: (sessionId: string) => Promise<Record<string, string>>;
  onCanvasEvent: (callback: (event: CanvasEvent) => void) => () => void;

  // Mobile Companion Nodes
  nodeList: () => Promise<{ ok: boolean; nodes?: NodeInfo[]; error?: string }>;
  nodeGet: (nodeId: string) => Promise<{ ok: boolean; node?: NodeInfo; error?: string }>;
  nodeInvoke: (params: {
    nodeId: string;
    command: string;
    params?: Record<string, unknown>;
    timeoutMs?: number;
  }) => Promise<{ ok: boolean; payload?: unknown; error?: { code: string; message: string } }>;
  onNodeEvent: (callback: (event: NodeEvent) => void) => () => void;

  // Device Management
  deviceListTasks: (nodeId: string) => Promise<{ ok: boolean; tasks?: Any[]; error?: string }>;
  deviceAssignTask: (params: {
    nodeId: string;
    prompt: string;
    workspaceId?: string;
    agentConfig?: Any;
    shellAccess?: boolean;
  }) => Promise<{ ok: boolean; taskId?: string; error?: string }>;
  deviceGetProfiles: () => Promise<{ ok: boolean; profiles?: Any[]; error?: string }>;
  deviceUpdateProfile: (deviceId: string, data: { customName?: string; platform?: string; modelIdentifier?: string }) => Promise<{ ok: boolean; error?: string }>;

  // Memory System
  getMemorySettings: (workspaceId: string) => Promise<MemorySettings>;
  saveMemorySettings: (data: {
    workspaceId: string;
    settings: Partial<MemorySettings>;
  }) => Promise<{ success: boolean }>;
  searchMemories: (data: {
    workspaceId: string;
    query: string;
    limit?: number;
  }) => Promise<MemorySearchResult[]>;
  getMemoryTimeline: (data: {
    memoryId: string;
    windowSize?: number;
  }) => Promise<MemoryTimelineEntry[]>;
  getMemoryDetails: (ids: string[]) => Promise<Memory[]>;
  getRecentMemories: (data: { workspaceId: string; limit?: number }) => Promise<Memory[]>;
  getMemoryStats: (workspaceId: string) => Promise<MemoryStats>;
  clearMemory: (workspaceId: string) => Promise<{ success: boolean }>;
  onMemoryEvent: (callback: (event: { type: string; workspaceId: string }) => void) => () => void;

  // Imported Memories
  getImportedMemoryStats: (workspaceId: string) => Promise<{ count: number; totalTokens: number }>;
  findImportedMemories: (data: {
    workspaceId: string;
    limit?: number;
    offset?: number;
  }) => Promise<Memory[]>;
  deleteImportedMemories: (workspaceId: string) => Promise<{ success: boolean; deleted: number }>;
  deleteImportedMemoryEntry: (data: {
    workspaceId: string;
    memoryId: string;
  }) => Promise<{ success: boolean }>;
  setImportedMemoryPromptRecallIgnored: (data: {
    workspaceId: string;
    memoryId: string;
    ignored: boolean;
  }) => Promise<{ success: boolean; memory: Memory | null }>;
  getUserProfile: () => Promise<UserProfile>;
  addUserFact: (data: {
    category: UserFactCategory;
    value: string;
    confidence?: number;
    source?: "conversation" | "feedback" | "manual";
    pinned?: boolean;
    taskId?: string;
  }) => Promise<UserFact>;
  updateUserFact: (data: {
    id: string;
    category?: UserFactCategory;
    value?: string;
    confidence?: number;
    pinned?: boolean;
  }) => Promise<UserFact | null>;
  deleteUserFact: (id: string) => Promise<{ success: boolean }>;
  listRelationshipMemory: (data?: {
    layer?: "identity" | "preferences" | "context" | "history" | "commitments";
    includeDone?: boolean;
    limit?: number;
  }) => Promise<Any[]>;
  updateRelationshipMemory: (data: {
    id: string;
    text?: string;
    confidence?: number;
    status?: "open" | "done";
    dueAt?: number | null;
  }) => Promise<Any | null>;
  deleteRelationshipMemory: (id: string) => Promise<{ success: boolean }>;
  cleanupRecurringRelationshipHistory: () => Promise<{
    success: boolean;
    collapsed: number;
    groupsCollapsed: number;
  }>;
  getOpenCommitments: (limit?: number) => Promise<Any[]>;
  getDueSoonCommitments: (windowHours?: number) => Promise<{ items: Any[]; reminderText: string }>;
  getAwarenessConfig: () => Promise<Any>;
  saveAwarenessConfig: (config: Any) => Promise<Any>;
  listAwarenessBeliefs: (workspaceId?: string) => Promise<Any[]>;
  updateAwarenessBelief: (id: string, patch: Any) => Promise<Any | null>;
  deleteAwarenessBelief: (id: string) => Promise<{ success: boolean }>;
  getAwarenessSummary: (workspaceId?: string) => Promise<Any>;
  getAwarenessSnapshot: (workspaceId?: string) => Promise<Any>;
  listAwarenessEvents: (params?: { workspaceId?: string; limit?: number }) => Promise<Any[]>;
  getAutonomyConfig: () => Promise<Any>;
  saveAutonomyConfig: (config: Any) => Promise<Any>;
  getAutonomyState: (workspaceId?: string) => Promise<Any>;
  listAutonomyDecisions: (workspaceId?: string) => Promise<Any[]>;
  listAutonomyActions: (workspaceId?: string) => Promise<Any[]>;
  updateAutonomyDecision: (id: string, patch: Any) => Promise<Any | null>;
  triggerAutonomyEvaluation: (workspaceId?: string) => Promise<Any>;

  // Memory Features (global toggles)
  getMemoryFeaturesSettings: () => Promise<MemoryFeaturesSettings>;
  saveMemoryFeaturesSettings: (settings: MemoryFeaturesSettings) => Promise<{ success: boolean }>;
  getMemoryLayerPreview: (workspaceId: string) => Promise<MemoryLayerPreviewPayload | null>;
  getSupermemorySettings: () => Promise<SupermemoryConfigStatus>;
  saveSupermemorySettings: (settings: SupermemorySettings) => Promise<{ success: boolean }>;
  testSupermemoryConnection: () => Promise<{ success: boolean; error?: string }>;
  getSupermemoryStatus: () => Promise<SupermemoryConfigStatus>;

  // Self-improvement loop
  getImprovementSettings: () => Promise<ImprovementLoopSettings>;
  getImprovementEligibility: () => Promise<ImprovementEligibility>;
  saveImprovementOwnerEnrollment: (token: string) => Promise<ImprovementEligibility>;
  clearImprovementOwnerEnrollment: () => Promise<ImprovementEligibility>;
  saveImprovementSettings: (settings: ImprovementLoopSettings) => Promise<ImprovementLoopSettings>;
  listImprovementCandidates: (workspaceId?: string) => Promise<ImprovementCandidate[]>;
  listImprovementCampaigns: (workspaceId?: string) => Promise<ImprovementCampaign[]>;
  refreshImprovementCandidates: () => Promise<{ candidateCount: number }>;
  runNextImprovementExperiment: () => Promise<ImprovementCampaign | null>;
  resetImprovementHistory: () => Promise<ImprovementHistoryResetResult>;
  retryImprovementCampaign: (campaignId: string) => Promise<ImprovementCampaign | null>;
  dismissImprovementCandidate: (candidateId: string) => Promise<ImprovementCandidate | undefined>;
  reviewImprovementCampaign: (
    campaignId: string,
    reviewStatus: "accepted" | "dismissed",
  ) => Promise<ImprovementCampaign | undefined>;

  // Subconscious loop
  getSubconsciousSettings: () => Promise<SubconsciousSettings>;
  saveSubconsciousSettings: (settings: SubconsciousSettings) => Promise<SubconsciousSettings>;
  getSubconsciousBrain: () => Promise<SubconsciousBrainSummary>;
  listSubconsciousTargets: (workspaceId?: string) => Promise<SubconsciousTargetSummary[]>;
  listSubconsciousRuns: (targetKey?: string) => Promise<SubconsciousRun[]>;
  getSubconsciousTargetDetail: (targetKey: string) => Promise<SubconsciousTargetDetail | null>;
  refreshSubconsciousTargets: () => Promise<SubconsciousRefreshResult>;
  runSubconsciousNow: (targetKey?: string) => Promise<SubconsciousRun | null>;
  retrySubconsciousRun: (runId: string) => Promise<SubconsciousRun | null>;
  reviewSubconsciousRun: (
    runId: string,
    reviewStatus: "accepted" | "dismissed",
  ) => Promise<SubconsciousRun | undefined>;
  dismissSubconsciousTarget: (targetKey: string) => Promise<SubconsciousTargetSummary | undefined>;
  resetSubconsciousHistory: () => Promise<SubconsciousHistoryResetResult>;

  // Workspace Kit (.cowork)
  getWorkspaceKitStatus: (workspaceId: string) => Promise<WorkspaceKitStatus>;
  initWorkspaceKit: (request: WorkspaceKitInitRequest) => Promise<WorkspaceKitStatus>;
  applyOnboardingProfile: (request: ApplyOnboardingProfileRequest) => Promise<ApplyOnboardingProfileResult>;
  createWorkspaceKitProject: (
    request: WorkspaceKitProjectCreateRequest,
  ) => Promise<{ success: boolean; projectId: string }>;
  openWorkspaceKitFile: (args: { workspaceId: string; relPath: string }) => Promise<boolean>;
  resetAdaptiveStyle: () => Promise<void>;
  submitMessageFeedback: (payload: {
    taskId: string;
    messageId?: string;
    decision: "accepted" | "rejected";
    reason?: string;
    note?: string;
    kind?: "message" | "task";
  }) => Promise<void>;

  // ChatGPT Import
  importChatGPT: (options: ChatGPTImportOptions) => Promise<ChatGPTImportResult>;
  onChatGPTImportProgress: (callback: (progress: ChatGPTImportProgress) => void) => () => void;
  cancelChatGPTImport: () => Promise<{ cancelled: boolean }>;
  importMemoryFromText: (options: TextMemoryImportOptions) => Promise<TextMemoryImportResult>;

  // Migration Status
  getMigrationStatus: () => Promise<MigrationStatus>;
  dismissMigrationNotification: () => Promise<{ success: boolean }>;

  // Extensions / Plugins
  getExtensions: () => Promise<ExtensionData[]>;
  getExtension: (name: string) => Promise<ExtensionData | null>;
  enableExtension: (name: string) => Promise<{ success: boolean; error?: string }>;
  disableExtension: (name: string) => Promise<{ success: boolean; error?: string }>;
  reloadExtension: (name: string) => Promise<{ success: boolean; error?: string }>;
  getExtensionConfig: (name: string) => Promise<Record<string, unknown>>;
  setExtensionConfig: (
    name: string,
    config: Record<string, unknown>,
  ) => Promise<{ success: boolean; error?: string }>;
  discoverExtensions: () => Promise<ExtensionData[]>;

  // Webhook Tunnel
  getTunnelStatus: () => Promise<TunnelStatusData>;
  startTunnel: (config: {
    provider: string;
    port: number;
    ngrokAuthToken?: string;
    ngrokRegion?: string;
  }) => Promise<{ success: boolean; url?: string; error?: string }>;
  stopTunnel: () => Promise<{ success: boolean; error?: string }>;

  // Agent Role (Agent Squad)
  getAgentRoles: (includeInactive?: boolean) => Promise<AgentRoleData[]>;
  getAgentRole: (id: string) => Promise<AgentRoleData | undefined>;
  createAgentRole: (request: CreateAgentRoleRequest) => Promise<AgentRoleData>;
  updateAgentRole: (request: UpdateAgentRoleRequest) => Promise<AgentRoleData | undefined>;
  deleteAgentRole: (id: string) => Promise<boolean>;
  assignAgentRoleToTask: (taskId: string, agentRoleId: string | null) => Promise<boolean>;
  getDefaultAgentRoles: () => Promise<Omit<AgentRoleData, "id" | "createdAt" | "updatedAt">[]>;
  seedDefaultAgentRoles: () => Promise<AgentRoleData[]>;

  // Persona Templates (Digital Twins)
  listPersonaTemplates: (filter?: { category?: string; tag?: string }) => Promise<unknown[]>;
  getPersonaTemplate: (id: string) => Promise<unknown | undefined>;
  activatePersonaTemplate: (request: {
    templateId: string;
    customization?: {
      companyId?: string;
      displayName?: string;
      icon?: string;
      color?: string;
      modelKey?: string;
      providerType?: string;
    };
  }) => Promise<{
    agentRole: AgentRoleData;
    installedSkillIds: string[];
    proactiveTaskCount: number;
    warnings: string[];
  }>;
  previewPersonaTemplate: (templateId: string) => Promise<{
    roleName: string;
    displayName: string;
    skills: Array<{ skillId: string; reason: string; required: boolean }>;
    proactiveTasks: Array<{
      id: string;
      name: string;
      description: string;
      category: string;
      promptTemplate: string;
      frequencyMinutes: number;
      priority: number;
      enabled: boolean;
    }>;
  } | null>;
  getPersonaTemplateCategories: () => Promise<
    Array<{
      id: string;
      label: string;
      count: number;
    }>
  >;

  // Mission Control - Company Ops / Planner
  listCompanies: () => Promise<import("../shared/types").Company[]>;
  getCompany: (companyId: string) => Promise<import("../shared/types").Company | undefined>;
  createCompany: (
    input: import("../shared/types").CompanyCreateInput,
  ) => Promise<import("../shared/types").Company>;
  updateCompany: (
    request: { companyId: string } & import("../shared/types").CompanyUpdate,
  ) => Promise<import("../shared/types").Company | undefined>;
  listCompanyPackageSources: (
    companyId?: string,
  ) => Promise<import("../shared/types").CompanyPackageSource[]>;
  previewCompanyPackageImport: (
    request: import("../shared/types").CompanyPackageImportRequest,
  ) => Promise<import("../shared/types").CompanyImportPreview>;
  importCompanyPackage: (
    request: import("../shared/types").CompanyPackageImportRequest,
  ) => Promise<import("../shared/types").CompanyPackageImportResult>;
  getCompanyGraph: (
    companyId: string,
  ) => Promise<import("../shared/types").ResolvedCompanyGraph>;
  listCompanySyncStates: (
    companyId: string,
  ) => Promise<import("../shared/types").CompanySyncState[]>;
  linkCompanyOrgNodeToRole: (request: {
    companyId: string;
    orgNodeId: string;
    agentRoleId: string | null;
  }) => Promise<import("../shared/types").CompanySyncState | null>;
  getCommandCenterSummary: (
    companyId: string,
  ) => Promise<import("../shared/types").CompanyCommandCenterSummary>;
  listCompanyGoals: (companyId: string) => Promise<import("../shared/types").Goal[]>;
  getGoal: (goalId: string) => Promise<import("../shared/types").Goal | undefined>;
  createGoal: (input: import("../shared/types").GoalCreateInput) => Promise<import("../shared/types").Goal>;
  updateGoal: (
    request: { goalId: string } & import("../shared/types").GoalUpdate,
  ) => Promise<import("../shared/types").Goal | undefined>;
  listCompanyProjects: (companyId: string) => Promise<import("../shared/types").Project[]>;
  getProject: (projectId: string) => Promise<import("../shared/types").Project | undefined>;
  createProject: (
    input: import("../shared/types").ProjectCreateInput,
  ) => Promise<import("../shared/types").Project>;
  updateProject: (
    request: { projectId: string } & import("../shared/types").ProjectUpdate,
  ) => Promise<import("../shared/types").Project | undefined>;
  listCompanyIssues: (
    companyId: string,
    limit?: number,
  ) => Promise<import("../shared/types").Issue[]>;
  getIssue: (issueId: string) => Promise<import("../shared/types").Issue | undefined>;
  createIssue: (
    input: import("../shared/types").IssueCreateInput,
  ) => Promise<import("../shared/types").Issue>;
  updateIssue: (
    request: { issueId: string } & import("../shared/types").IssueUpdate,
  ) => Promise<import("../shared/types").Issue | undefined>;
  listIssueComments: (issueId: string) => Promise<import("../shared/types").IssueComment[]>;
  listCompanyRuns: (
    companyId: string,
    issueId?: string,
    limit?: number,
  ) => Promise<import("../shared/types").HeartbeatRun[]>;
  listRunEvents: (runId: string) => Promise<import("../shared/types").HeartbeatRunEvent[]>;
  getPlannerConfig: (
    companyId: string,
  ) => Promise<import("../shared/types").StrategicPlannerConfig>;
  updatePlannerConfig: (request: {
    companyId: string;
    enabled?: boolean;
    intervalMinutes?: number;
    planningWorkspaceId?: string | null;
    plannerAgentRoleId?: string | null;
    autoDispatch?: boolean;
    approvalPreset?: "manual" | "safe_autonomy" | "founder_edge";
    maxIssuesPerRun?: number;
    staleIssueDays?: number;
  }) => Promise<import("../shared/types").StrategicPlannerConfig>;
  runPlanner: (companyId: string) => Promise<import("../shared/types").StrategicPlannerRun>;
  listPlannerRuns: (
    companyId: string,
    limit?: number,
  ) => Promise<import("../shared/types").StrategicPlannerRun[]>;

  // Plugin Packs (Customize panel)
  listPluginPacks: () => Promise<
    Array<{
      name: string;
      displayName: string;
      version: string;
      description: string;
      icon?: string;
      category?: string;
      scope?: "personal" | "organization";
      personaTemplateId?: string;
      recommendedConnectors?: string[];
      tryAsking?: string[];
      bestFitWorkflows?: ("support_ops" | "it_ops" | "sales_ops")[];
      outcomeExamples?: string[];
      skills: Array<{
        id: string;
        name: string;
        description: string;
        icon?: string;
        enabled?: boolean;
      }>;
      slashCommands: Array<{ name: string; description: string; skillId: string }>;
      agentRoles: Array<{
        name: string;
        displayName: string;
        description?: string;
        icon: string;
        color: string;
      }>;
      state: string;
      enabled: boolean;
      securityReport?: import("../shared/types").CapabilitySecurityReport;
    }>
  >;
  getPluginPack: (name: string) => Promise<{
    name: string;
    displayName: string;
    version: string;
    description: string;
    icon?: string;
    category?: string;
    personaTemplateId?: string;
    recommendedConnectors?: string[];
    tryAsking?: string[];
    skills: Array<{
      id: string;
      name: string;
      description: string;
      icon?: string;
      enabled?: boolean;
    }>;
    slashCommands: Array<{ name: string; description: string; skillId: string }>;
    agentRoles: Array<{
      name: string;
      displayName: string;
      description?: string;
      icon: string;
      color: string;
    }>;
    state: string;
    enabled: boolean;
    securityReport?: import("../shared/types").CapabilitySecurityReport;
  } | null>;
  togglePluginPack: (
    name: string,
    enabled: boolean,
  ) => Promise<{ success: boolean; name: string; enabled: boolean }>;
  getActiveContext: () => Promise<{
    connectors: Array<{ id: string; name: string; icon: string; status: string; tools: string[] }>;
    skills: Array<{ id: string; name: string; icon: string }>;
  }>;
  togglePluginPackSkill: (
    packName: string,
    skillId: string,
    enabled: boolean,
  ) => Promise<{ success: boolean; packName: string; skillId: string; enabled: boolean }>;

  // Plugin Pack Distribution
  scaffoldPluginPack: (options: {
    name: string;
    displayName: string;
    description?: string;
    category?: string;
    icon?: string;
    author?: string;
    personaTemplateId?: string;
  }) => Promise<{ success: boolean; path?: string; error?: string; filesCreated?: string[] }>;
  installPluginPackFromGit: (gitUrl: string) => Promise<{
    success: boolean;
    packName?: string;
    path?: string;
    error?: string;
    skillCount?: number;
    agentCount?: number;
    security?: import("../shared/types").InstallSecurityOutcome;
  }>;
  installPluginPackFromUrl: (url: string) => Promise<{
    success: boolean;
    packName?: string;
    path?: string;
    error?: string;
    skillCount?: number;
    agentCount?: number;
    security?: import("../shared/types").InstallSecurityOutcome;
  }>;
  uninstallPluginPack: (
    packName: string,
  ) => Promise<{ success: boolean; packName?: string; error?: string }>;
  searchPackRegistry: (
    query: string,
    options?: { page?: number; pageSize?: number; category?: string },
  ) => Promise<{
    query: string;
    total: number;
    page: number;
    pageSize: number;
    results: Array<{
      id: string;
      name: string;
      displayName: string;
      description: string;
      version: string;
      author: string;
      icon?: string;
      category?: string;
      tags?: string[];
      downloadUrl?: string;
      gitUrl?: string;
      skillCount?: number;
      agentCount?: number;
    }>;
  }>;
  getPackRegistryDetails: (packId: string) => Promise<{
    id: string;
    name: string;
    displayName: string;
    description: string;
    version: string;
    author: string;
    icon?: string;
    category?: string;
  } | null>;
  getPackRegistryCategories: () => Promise<string[]>;
  checkPackUpdates: () => Promise<
    Array<{ name: string; currentVersion: string; latestVersion: string }>
  >;

  // Admin Policies
  getAdminPolicies: () => Promise<{
    version: number;
    updatedAt: string;
    packs: { allowed: string[]; blocked: string[]; required: string[] };
    connectors: { blocked: string[] };
    agents: { maxHeartbeatFrequencySec: number; maxConcurrentAgents: number };
    general: {
      allowCustomPacks: boolean;
      allowGitInstall: boolean;
      allowUrlInstall: boolean;
      orgName?: string;
      orgPluginDir?: string;
    };
  }>;
  updateAdminPolicies: (updates: Record<string, unknown>) => Promise<{
    version: number;
    updatedAt: string;
    packs: { allowed: string[]; blocked: string[]; required: string[] };
    connectors: { blocked: string[] };
    agents: { maxHeartbeatFrequencySec: number; maxConcurrentAgents: number };
    general: {
      allowCustomPacks: boolean;
      allowGitInstall: boolean;
      allowUrlInstall: boolean;
      orgName?: string;
      orgPluginDir?: string;
    };
  }>;
  checkPackPolicy: (
    packId: string,
  ) => Promise<{ packId: string; allowed: boolean; required: boolean }>;

  // Agent Teams
  listTeams: (workspaceId: string, includeInactive?: boolean) => Promise<AgentTeam[]>;
  createTeam: (request: CreateAgentTeamRequest) => Promise<AgentTeam>;
  updateTeam: (request: UpdateAgentTeamRequest) => Promise<AgentTeam | undefined>;
  deleteTeam: (id: string) => Promise<{ success: boolean }>;
  listTeamMembers: (teamId: string) => Promise<AgentTeamMember[]>;
  addTeamMember: (request: CreateAgentTeamMemberRequest) => Promise<AgentTeamMember>;
  updateTeamMember: (request: UpdateAgentTeamMemberRequest) => Promise<AgentTeamMember | undefined>;
  removeTeamMember: (teamId: string, agentRoleId: string) => Promise<{ success: boolean }>;
  reorderTeamMembers: (teamId: string, orderedMemberIds: string[]) => Promise<AgentTeamMember[]>;
  listTeamRuns: (teamId: string, limit?: number) => Promise<AgentTeamRun[]>;
  createTeamRun: (request: CreateAgentTeamRunRequest) => Promise<AgentTeamRun>;
  resumeTeamRun: (runId: string) => Promise<{ success: boolean }>;
  pauseTeamRun: (runId: string) => Promise<{ success: boolean }>;
  cancelTeamRun: (runId: string) => Promise<{ success: boolean }>;
  wrapUpTeamRun: (runId: string) => Promise<{ success: boolean }>;
  listTeamItems: (teamRunId: string) => Promise<AgentTeamItem[]>;
  createTeamItem: (request: CreateAgentTeamItemRequest) => Promise<AgentTeamItem>;
  updateTeamItem: (request: UpdateAgentTeamItemRequest) => Promise<AgentTeamItem | undefined>;
  deleteTeamItem: (id: string) => Promise<{ success: boolean }>;
  moveTeamItem: (request: {
    id: string;
    parentItemId: string | null;
    sortOrder: number;
  }) => Promise<AgentTeamItem | undefined>;
  onTeamRunEvent: (callback: (event: Any) => void) => () => void;

  // Collaborative Thoughts
  listTeamThoughts: (teamRunId: string) => Promise<AgentThought[]>;
  onTeamThoughtEvent: (callback: (event: Any) => void) => () => void;
  findTeamRunByRootTask: (rootTaskId: string) => Promise<AgentTeamRun | null>;

  // Activity Feed
  listActivities: (query: ActivityListQuery) => Promise<ActivityData[]>;
  createActivity: (request: CreateActivityRequest) => Promise<ActivityData>;
  markActivityRead: (id: string) => Promise<{ success: boolean }>;
  markAllActivitiesRead: (workspaceId: string) => Promise<{ count: number }>;
  pinActivity: (id: string) => Promise<ActivityData | undefined>;
  deleteActivity: (id: string) => Promise<{ success: boolean }>;
  onActivityEvent: (callback: (event: ActivityEvent) => void) => () => void;

  // @Mention System
  listMentions: (query: MentionListQuery) => Promise<MentionData[]>;
  createMention: (request: CreateMentionRequest) => Promise<MentionData>;
  acknowledgeMention: (id: string) => Promise<MentionData | undefined>;
  completeMention: (id: string) => Promise<MentionData | undefined>;
  dismissMention: (id: string) => Promise<MentionData | undefined>;
  onMentionEvent: (callback: (event: MentionEvent) => void) => () => void;
  listSupervisorExchanges: (query: {
    workspaceId: string;
    status?: SupervisorExchangeStatus | SupervisorExchangeStatus[];
    limit?: number;
  }) => Promise<SupervisorExchange[]>;
  resolveSupervisorExchange: (request: {
    id: string;
    resolution: string;
    mirrorToDiscord?: boolean;
  }) => Promise<SupervisorExchange>;
  onSupervisorExchangeEvent: (callback: (event: SupervisorExchangeEvent) => void) => () => void;
  // Mission Control - Heartbeat APIs
  getHeartbeatConfig: (agentRoleId: string) => Promise<
    | {
        heartbeatEnabled: boolean;
        heartbeatIntervalMinutes: number;
        heartbeatStaggerOffset: number;
        pulseEveryMinutes?: number;
        dispatchCooldownMinutes?: number;
        maxDispatchesPerDay?: number;
        heartbeatProfile?: import("../shared/types").HeartbeatProfile;
        activeHours?: import("../shared/types").HeartbeatActiveHours;
        heartbeatStatus: HeartbeatStatus;
        lastHeartbeatAt?: number;
      }
    | undefined
  >;
  updateHeartbeatConfig: (
    agentRoleId: string,
    config: {
      heartbeatEnabled?: boolean;
      heartbeatIntervalMinutes?: number;
      heartbeatStaggerOffset?: number;
      pulseEveryMinutes?: number;
      dispatchCooldownMinutes?: number;
      maxDispatchesPerDay?: number;
      heartbeatProfile?: import("../shared/types").HeartbeatProfile;
      activeHours?: import("../shared/types").HeartbeatActiveHours | null;
    },
  ) => Promise<Any>;
  listAutomationProfiles: () => Promise<AutomationProfileData[]>;
  getAutomationProfile: (id: string) => Promise<AutomationProfileData | undefined>;
  createAutomationProfile: (
    request: import("../shared/types").CreateAutomationProfileRequest,
  ) => Promise<AutomationProfileData>;
  updateAutomationProfile: (
    request: import("../shared/types").UpdateAutomationProfileRequest,
  ) => Promise<AutomationProfileData | undefined>;
  deleteAutomationProfile: (id: string) => Promise<void>;
  attachAutomationProfileToAgentRole: (
    agentRoleId: string,
    request?: Partial<import("../shared/types").CreateAutomationProfileRequest>,
  ) => Promise<AutomationProfileData>;
  detachAutomationProfileFromAgentRole: (agentRoleId: string) => Promise<void>;
  listHeartbeatRunsForAutomationProfile: (profileId: string, limit?: number) => Promise<Any[]>;
  listSubconsciousRunsForAutomationProfile: (profileId: string, limit?: number) => Promise<Any[]>;
  listCoreTraces: (
    request?: import("../shared/types").ListCoreTracesRequest,
  ) => Promise<CoreTrace[]>;
  getCoreTrace: (id: string) => Promise<GetCoreTraceResult | undefined>;
  listCoreTracesForAutomationProfile: (profileId: string, limit?: number) => Promise<CoreTrace[]>;
  listTaskTraceRuns: (
    request?: import("../shared/types").ListTaskTraceRunsRequest,
  ) => Promise<TaskTraceRunSummary[]>;
  getTaskTraceRun: (taskId: string) => Promise<TaskTraceRunDetail | undefined>;
  listCoreFailureRecords: (
    request?: import("../shared/types").ListCoreFailureRecordsRequest,
  ) => Promise<CoreFailureRecord[]>;
  listCoreFailureClusters: (
    request?: import("../shared/types").ListCoreFailureClustersRequest,
  ) => Promise<CoreFailureCluster[]>;
  reviewCoreFailureCluster: (
    request: import("../shared/types").ReviewCoreFailureClusterRequest,
  ) => Promise<CoreFailureCluster | undefined>;
  listCoreEvalCases: (
    request?: import("../shared/types").ListCoreEvalCasesRequest,
  ) => Promise<CoreEvalCase[]>;
  reviewCoreEvalCase: (
    request: import("../shared/types").ReviewCoreEvalCaseRequest,
  ) => Promise<CoreEvalCase | undefined>;
  listCoreExperiments: (
    request?: import("../shared/types").ListCoreExperimentsRequest,
  ) => Promise<CoreHarnessExperiment[]>;
  runCoreExperiment: (
    request: import("../shared/types").RunCoreExperimentRequest,
  ) => Promise<{
    experiment: CoreHarnessExperiment;
    run: import("../shared/types").CoreHarnessExperimentRun;
    gate: import("../shared/types").CoreRegressionGateResult;
  }>;
  reviewCoreExperiment: (
    request: import("../shared/types").ReviewCoreExperimentRequest,
  ) => Promise<CoreHarnessExperiment | undefined>;
  listCoreLearnings: (
    request?: import("../shared/types").ListCoreLearningsRequest,
  ) => Promise<CoreLearningsEntry[]>;
  listCoreMemoryCandidates: (
    request?: import("../shared/types").ListCoreMemoryCandidatesRequest,
  ) => Promise<CoreMemoryCandidate[]>;
  reviewCoreMemoryCandidate: (
    request: import("../shared/types").ReviewCoreMemoryCandidateRequest,
  ) => Promise<CoreMemoryCandidate | undefined>;
  listCoreMemoryDistillRuns: (
    profileId: string,
    workspaceId?: string,
    limit?: number,
  ) => Promise<CoreMemoryDistillRun[]>;
  runCoreMemoryDistillNow: (
    request: import("../shared/types").RunCoreMemoryDistillNowRequest,
  ) => Promise<CoreMemoryDistillRun>;
  triggerHeartbeat: (agentRoleId: string) => Promise<HeartbeatResult>;
  getHeartbeatStatus: (agentRoleId: string) => Promise<
    | {
        heartbeatEnabled: boolean;
        heartbeatStatus: HeartbeatStatus;
        lastHeartbeatAt?: number;
        nextHeartbeatAt?: number;
        lastPulseResult?: import("../shared/types").HeartbeatPulseResultKind;
        lastDispatchKind?: string;
        deferred?: import("../shared/types").HeartbeatDeferredState;
        compressedSignalCount?: number;
        dueProactiveCount?: number;
        checklistDueCount?: number;
        dispatchCooldownUntil?: number;
        dispatchesToday?: number;
        maxDispatchesPerDay?: number;
        isRunning: boolean;
      }
    | undefined
  >;
  getAllHeartbeatStatus: () => Promise<
    Array<{
      agentRoleId: string;
      agentName: string;
      heartbeatEnabled: boolean;
      heartbeatStatus: HeartbeatStatus;
      lastHeartbeatAt?: number;
      nextHeartbeatAt?: number;
      lastPulseResult?: import("../shared/types").HeartbeatPulseResultKind;
      lastDispatchKind?: string;
      deferred?: import("../shared/types").HeartbeatDeferredState;
      compressedSignalCount?: number;
      dueProactiveCount?: number;
      checklistDueCount?: number;
      dispatchCooldownUntil?: number;
      dispatchesToday?: number;
      maxDispatchesPerDay?: number;
    }>
  >;
  onHeartbeatEvent: (callback: (event: HeartbeatEvent) => void) => () => void;
  // Mission Control - Task Subscription APIs
  listSubscriptions: (taskId: string) => Promise<TaskSubscription[]>;
  addSubscription: (
    taskId: string,
    agentRoleId: string,
    reason: SubscriptionReason,
  ) => Promise<TaskSubscription>;
  removeSubscription: (taskId: string, agentRoleId: string) => Promise<boolean>;
  getTaskSubscribers: (taskId: string) => Promise<TaskSubscription[]>;
  getAgentSubscriptions: (agentRoleId: string) => Promise<TaskSubscription[]>;
  onSubscriptionEvent: (callback: (event: SubscriptionEvent) => void) => () => void;
  // Mission Control - Standup Report APIs
  generateStandupReport: (workspaceId: string) => Promise<StandupReport>;
  getLatestStandupReport: (workspaceId: string) => Promise<StandupReport | undefined>;
  listStandupReports: (workspaceId: string, limit?: number) => Promise<StandupReport[]>;
  deliverStandupReport: (reportId: string, channelType: string, channelId: string) => Promise<void>;
  // Mission Control - Agent Performance Reviews
  generateAgentReview: (request: AgentReviewGenerateRequest) => Promise<AgentPerformanceReview>;
  getLatestAgentReview: (
    workspaceId: string,
    agentRoleId: string,
  ) => Promise<AgentPerformanceReview | undefined>;
  listAgentReviews: (query: {
    workspaceId: string;
    agentRoleId?: string;
    limit?: number;
  }) => Promise<AgentPerformanceReview[]>;
  deleteAgentReview: (id: string) => Promise<{ success: boolean }>;
  listEvalSuites: (options?: { windowDays?: number }) => Promise<{
    suites: Array<EvalSuite & { caseCount: number; latestRun?: Partial<EvalRun> }>;
    metrics: EvalBaselineMetrics;
  }>;
  runEvalSuite: (suiteId: string) => Promise<EvalRun>;
  getEvalRun: (runId: string) => Promise<(EvalRun & { caseRuns: Any[] }) | null>;
  getEvalCase: (caseId: string) => Promise<EvalCase | null>;
  createEvalCaseFromTask: (taskId: string) => Promise<EvalCase>;
  // Task Board APIs
  moveTaskToColumn: (taskId: string, column: TaskBoardColumn) => Promise<Any>;
  setTaskPriority: (taskId: string, priority: number) => Promise<Any>;
  setTaskDueDate: (taskId: string, dueDate: number | null) => Promise<Any>;
  setTaskEstimate: (taskId: string, estimatedMinutes: number | null) => Promise<Any>;
  addTaskLabel: (taskId: string, labelId: string) => Promise<Any>;
  removeTaskLabel: (taskId: string, labelId: string) => Promise<Any>;
  onTaskBoardEvent: (callback: (event: TaskBoardEvent) => void) => () => void;
  // Task Label APIs
  listTaskLabels: (query: TaskLabelListQuery) => Promise<TaskLabelData[]>;
  createTaskLabel: (request: CreateTaskLabelRequest) => Promise<TaskLabelData>;
  updateTaskLabel: (id: string, request: UpdateTaskLabelRequest) => Promise<TaskLabelData>;
  deleteTaskLabel: (id: string) => Promise<boolean>;
  // Agent Working State APIs
  getWorkingState: (id: string) => Promise<AgentWorkingStateData | undefined>;
  getCurrentWorkingState: (query: WorkingStateQuery) => Promise<AgentWorkingStateData | undefined>;
  updateWorkingState: (request: UpdateWorkingStateRequest) => Promise<AgentWorkingStateData>;
  getWorkingStateHistory: (query: WorkingStateHistoryQuery) => Promise<AgentWorkingStateData[]>;
  restoreWorkingState: (id: string) => Promise<AgentWorkingStateData | undefined>;
  deleteWorkingState: (id: string) => Promise<{ success: boolean }>;
  listWorkingStatesForTask: (taskId: string) => Promise<AgentWorkingStateData[]>;
  // Context Policy APIs
  getContextPolicy: (
    channelId: string,
    contextType: ContextTypeValue,
  ) => Promise<ContextPolicyData>;
  getContextPolicyForChat: (
    channelId: string,
    chatId: string,
    isGroup: boolean,
  ) => Promise<ContextPolicyData>;
  listContextPolicies: (channelId: string) => Promise<ContextPolicyData[]>;
  updateContextPolicy: (
    channelId: string,
    contextType: ContextTypeValue,
    options: UpdateContextPolicyOptions,
  ) => Promise<ContextPolicyData>;
  deleteContextPolicies: (channelId: string) => Promise<{ count: number }>;
  createDefaultContextPolicies: (channelId: string) => Promise<{ success: boolean }>;
  isToolAllowedInContext: (
    channelId: string,
    contextType: ContextTypeValue,
    toolName: string,
    toolGroups: string[],
  ) => Promise<{ allowed: boolean }>;
  // Voice Mode APIs
  getVoiceSettings: () => Promise<VoiceSettingsData>;
  saveVoiceSettings: (settings: Partial<VoiceSettingsData>) => Promise<VoiceSettingsData>;
  getVoiceState: () => Promise<VoiceStateData>;
  voiceSpeak: (
    text: string,
  ) => Promise<{ success: boolean; audioData?: number[] | null; error?: string }>;
  voiceStopSpeaking: () => Promise<{ success: boolean }>;
  voiceTranscribe: (audioData: ArrayBuffer) => Promise<{ text: string; error?: string }>;
  getElevenLabsVoices: () => Promise<ElevenLabsVoiceData[]>;
  testElevenLabsConnection: () => Promise<{
    success: boolean;
    voiceCount?: number;
    error?: string;
  }>;
  testOpenAIVoiceConnection: () => Promise<{ success: boolean; error?: string }>;
  testAzureVoiceConnection: () => Promise<{ success: boolean; error?: string }>;
  onVoiceEvent: (callback: (event: VoiceEventData) => void) => () => void;

  // Git Worktree APIs
  getWorktreeInfo: (taskId: string) => Promise<Any>;
  listWorktrees: (workspaceId: string) => Promise<Any[]>;
  mergeWorktree: (taskId: string) => Promise<Any>;
  cleanupWorktree: (taskId: string) => Promise<{ success: boolean }>;
  getWorktreeDiff: (taskId: string) => Promise<Any>;
  getWorktreeSettings: () => Promise<Any>;
  saveWorktreeSettings: (settings: Any) => Promise<{ success: boolean; error?: string }>;

  // Agent Comparison APIs
  createComparison: (params: Any) => Promise<Any>;
  getComparison: (sessionId: string) => Promise<Any>;
  listComparisons: (workspaceId: string) => Promise<Any[]>;
  cancelComparison: (sessionId: string) => Promise<{ success: boolean }>;
  getComparisonResult: (sessionId: string) => Promise<Any>;

  // Usage Insights
  getUsageInsights: (workspaceId: string, periodDays?: number) => Promise<Any>;
  getUsageInsightsEarliest: (workspaceId: string) => Promise<number | null>;

  // Daily Briefing
  generateDailyBriefing: (workspaceId: string) => Promise<Any>;
  generateBriefing: (workspaceId: string) => Promise<Any>;

  // Proactive Suggestions
  listSuggestions: (workspaceId: string) => Promise<Any[]>;
  listSuggestionsForWorkspaces: (
    workspaceIds: string[],
  ) => Promise<Array<{ workspaceId: string; suggestions: Any[] }>>;
  refreshSuggestions: (workspaceId: string) => Promise<{ success: boolean }>;
  refreshSuggestionsForWorkspaces: (workspaceIds: string[]) => Promise<{ success: boolean }>;
  dismissSuggestion: (workspaceId: string, suggestionId: string) => Promise<{ success: boolean }>;
  snoozeSuggestion: (
    workspaceId: string,
    suggestionId: string,
    snoozedUntil: number,
  ) => Promise<{ success: boolean }>;
  editSuggestion: (
    workspaceId: string,
    suggestionId: string,
    editedPrompt: string,
  ) => Promise<{ success: boolean }>;
  actOnSuggestion: (
    workspaceId: string,
    suggestionId: string,
  ) => Promise<{ actionPrompt: string | null }>;

  // Playwright QA APIs
  qaGetRuns: () => Promise<Any[]>;
  qaGetRun: (runId: string) => Promise<Any | null>;
  qaStartRun: (data: { taskId: string; workspaceId: string; config: Any }) => Promise<Any>;
  qaStopRun: (taskId: string) => Promise<{ success: boolean }>;
  onQAEvent: (callback: (event: Any) => void) => () => void;

  // Window control APIs (for custom title bar on Windows)
  windowMinimize: () => Promise<void>;
  windowMaximize: () => Promise<void>;
  windowClose: () => Promise<void>;
  windowIsMaximized: () => Promise<boolean>;
  getPlatform: () => string;
}

// Migration status type (for showing one-time notifications after app rename)
export interface MigrationStatus {
  migrated: boolean;
  notificationDismissed: boolean;
  timestamp?: string;
}

// Extension / Plugin types (duplicated from shared/types since preload is sandboxed)
export type ExtensionType = "channel" | "tool" | "provider" | "integration";
export type ExtensionState = "loading" | "loaded" | "registered" | "active" | "error" | "disabled";

export interface ExtensionData {
  name: string;
  displayName: string;
  version: string;
  description: string;
  author?: string;
  type: ExtensionType;
  state: ExtensionState;
  path: string;
  loadedAt: number;
  error?: string;
  capabilities?: Record<string, boolean>;
  configSchema?: Record<string, unknown>;
}

// Webhook Tunnel types
export type TunnelProvider = "ngrok" | "tailscale" | "cloudflare" | "localtunnel";
export type TunnelStatus = "stopped" | "starting" | "running" | "error";

export interface TunnelStatusData {
  status: TunnelStatus;
  provider?: TunnelProvider;
  url?: string;
  error?: string;
  startedAt?: number;
}

// Voice Mode types (inlined for sandboxed preload)
export type VoiceProvider = "elevenlabs" | "openai" | "azure" | "local";
export type VoiceInputMode = "push_to_talk" | "voice_activity" | "disabled";
export type VoiceResponseMode = "auto" | "manual" | "smart";

export interface VoiceSettingsData {
  enabled: boolean;
  ttsProvider: VoiceProvider;
  sttProvider: VoiceProvider;
  elevenLabsApiKey?: string;
  elevenLabsAgentsApiKey?: string;
  openaiApiKey?: string;
  elevenLabsVoiceId?: string;
  elevenLabsAgentId?: string;
  elevenLabsAgentPhoneNumberId?: string;
  openaiVoice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
  /** Azure OpenAI endpoint URL */
  azureEndpoint?: string;
  /** Azure OpenAI API key */
  azureApiKey?: string;
  /** Azure OpenAI TTS deployment name */
  azureTtsDeploymentName?: string;
  /** Azure OpenAI STT deployment name */
  azureSttDeploymentName?: string;
  /** Azure OpenAI API version */
  azureApiVersion?: string;
  /** Selected Azure voice */
  azureVoice?: "alloy" | "echo" | "fable" | "onyx" | "nova" | "shimmer";
  inputMode: VoiceInputMode;
  responseMode: VoiceResponseMode;
  pushToTalkKey: string;
  volume: number;
  speechRate: number;
  language: string;
  wakeWordEnabled: boolean;
  wakeWord?: string;
  silenceTimeout: number;
  audioFeedback: boolean;
}

export interface VoiceStateData {
  isActive: boolean;
  isListening: boolean;
  isSpeaking: boolean;
  isProcessing: boolean;
  audioLevel: number;
  partialTranscript?: string;
  error?: string;
}

export interface ElevenLabsVoiceData {
  voice_id: string;
  name: string;
  category?: string;
  description?: string;
  preview_url?: string;
  labels?: Record<string, string>;
}

export type VoiceEventType =
  | "voice:state-changed"
  | "voice:transcript"
  | "voice:partial-transcript"
  | "voice:speaking-start"
  | "voice:speaking-end"
  | "voice:error"
  | "voice:audio-level";

export interface VoiceEventData {
  type: VoiceEventType;
  data: VoiceStateData | string | number | { message: string };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
