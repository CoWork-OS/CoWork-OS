import type { ComputerViewState } from "../shared/computer-view";
import {
  BROWSER_TOOLBAR_MENU_POPUP,
  type BrowserToolbarMenuAction,
  type BrowserToolbarMenuRequest,
} from "../shared/browser-toolbar-menu";
import {
  BROWSER_VAULT_IPC,
  type BrowserCookieJarListing,
  type BrowserVaultItem,
  type BrowserVaultAnswer,
  type BrowserVaultCommand,
  type BrowserVaultPrompt,
} from "../shared/browser-vault";
import {
  SECRET_SOURCES_IPC,
  type SecretReferenceTestResult,
  type SecretSourcesSettingsUpdate,
  type SecretSourcesStatus,
} from "../shared/secret-references";
import {
  COMPOSER_PREDICTION_CHANNEL,
  COMPOSER_PREDICTION_CANCEL_CHANNEL,
} from "../shared/composer-predictions";
import type {
  ApprovalRequest,
  SpaceSandboxConfig,
  SandboxType,
  WatchdogSettings,
} from "../shared/types";
import type { AndroidPhoneSettings, AndroidPhoneStatus } from "../shared/android-phone";
import type {
  CuaSpaceConnectionResult,
  CuaSpaceDisplaySettings,
  CuaSpaceSettingsUpdate,
} from "../shared/cua-space";
import type {
  CamofoxConnectionResult,
  CamofoxDisplaySettings,
  CamofoxSettingsUpdate,
} from "../shared/camofox";
import type {
  ApprovalDraftPreview,
  InlineApprovalDraftReview,
} from "../shared/approval-draft-presentation";
import type {
  BotNotificationScope,
  BotNotificationRetry,
  BotNotificationUpdate,
  BotNotificationRoute,
  BotNotificationReceipt,
} from "../shared/bot-notification";
import type {
  BotResponsibility,
  BotResponsibilityEngine,
  BotResponsibilityPreview,
  BotResponsibilityScope,
  BotResponsibilitySave,
  BotResponsibilityRevise,
} from "../shared/bot-responsibility";
import type {
  BotWorkQuery,
  BotWorkPage,
  RemoteOAuthAuthorizeResult,
  RemoteOAuthServerRequest,
  RemoteOAuthServerUpdateRequest,
  WorkdayAdminConnectionRequest,
  WorkdayAdminConnectionSummary,
  WorkdayAdminSignInResult,
  WorkdayAgentListResult,
  WorkdayAgentSaveRequest,
  WorkdayAgentSaveResult,
  WorkdayAgentSearchRequest,
  WorkdayAgentSearchResult,
} from "../shared/types";
import * as path from "path";
import { contextBridge, ipcRenderer } from "electron";
import * as fs from "fs";
import * as os from "os";
import { randomBytes } from "crypto";
import { IPC_CHANNELS as SHARED_IPC_CHANNELS, isTempWorkspaceId } from "../shared/types";
import type {
  AgentImportDetection,
  AgentImportPreview,
  AgentImportRequest,
  AgentImportResult,
  AgentImportSource,
} from "../shared/types";
import type { BotOutcomeMetrics, BotOutcomeMetricsRequest } from "../shared/bot-outcome-metrics";
import type { TaskProposal, TaskProposalStartOptions } from "../shared/task-proposals";
import type { BotCapabilitiesRequest, BotCapabilitySummary } from "../shared/bot-capabilities";
import type {
  ChannelHealthResponse,
  MeetingArtifactProvider,
  MeetingArtifactSummary,
  TeamsMeetingSettingsUpdate,
  TeamsMeetingSettingsView,
  TeamsMeetingStatus,
} from "../shared/types";
import type {
  ApplyOnboardingProfileRequest,
  ApplyOnboardingProfileResult,
} from "../shared/onboarding";
import type {
  AgentSecurityDiagnostic,
  AgentSecurityFinding,
  AgentSecurityFindingQuery,
  AgentSecurityFindingStatus,
  AgentSecurityHookManagementResult,
  AgentSecurityInventoryItem,
  AgentSecurityRulesCheckResult,
  AgentSecurityRuntimeStatus,
  AgentSecurityScanResult,
} from "../shared/agent-security";
import type { SpreadsheetPreview } from "../shared/spreadsheet-preview";
import type {
  MemoryHubAddableKind,
  MemoryHubItemDetail,
  MemoryHubListRequest,
  MemoryHubListResult,
  MemoryHubMutationResult,
  MemoryHubWhy,
} from "../shared/memory-hub-types";
import type { MemoryUsedForTask } from "../shared/memory-used";
import type { MemoryReviewMutationResult, MemoryReviewState } from "../shared/memory-review-types";
import type { MemoryHealthReport, MemorySourcesReport } from "../shared/memory-health-types";
import type { AnswerImageRequest, AnswerImageResult } from "../shared/answer-surfaces/images";
import type {
  MemoryRepoCompactResult,
  MemoryRepoSyncNowResult,
  MemoryRepoBotMemoryReport,
  MemoryRepoDreamActionResult,
  MemoryRepoDreamNowResult,
  MemoryRepoDreamPart,
  MemoryRepoDreamsReport,
  MemoryRepoEntriesReport,
  MemoryRepoEntryActionResult,
  MemoryRepoImportResult,
  MemoryRepoKeepTarget,
  MemoryRepoLine,
  MemoryRepoStatusReport,
} from "../shared/memory-repo-types";
import type {
  PactAuthorizationSignIn,
  PactAuthorizationView,
  PactBusinessView,
  PactConversationView,
  PactEffectClass,
  PactGrantView,
  PactReceiptView,
  PactSendOutcome,
  PactSettings,
  PactStatusView,
} from "../shared/pact";

type PactSettingsUpdate = Partial<
  Pick<PactSettings, "enabled" | "preference" | "identity" | "providers">
>;
interface PactSendRequestInput {
  businessId: string;
  conversationId?: string;
  text: string;
  effect: PactEffectClass;
  requiredScopes?: string[];
  purpose?: string;
  reconcileOperationId?: string;
  confirmed?: boolean;
}
import type {
  SpreadsheetApplyPatchesResult,
  SpreadsheetOpenWorkbookResult,
  SpreadsheetPatch,
  SpreadsheetSaveWorkbookResult,
} from "../shared/spreadsheet-workbook";
import type { DocumentPreview, EditableDocumentBlock } from "../shared/document-preview";
import type {
  LocalPreviewCommandTemplate,
  LocalPreviewHealthResult,
  LocalPreviewProcessInfo,
  LocalPreviewStartRequest,
} from "../shared/local-preview";
import { shouldUseNativeWindowFrame } from "../shared/native-window-frame";
import type {
  AgentTeam,
  AgentTeamItem,
  AgentTeamMember,
  AgentTeamRun,
  AgentThought,
  AgentBuilderCreateRequest,
  AgentBuilderCreateResult,
  AgentBuilderPlan,
  AgentBuilderPlanRequest,
  AgentWorkspacePermissionSnapshot,
  AgentTemplate,
  AppProfileSummary,
  Annotation,
  AnnotationCreateInput,
  AnnotationListQuery,
  AnnotationUndoResult,
  AnnotationUpdateInput,
  BrowserAnnotationTargetRef,
  BrowserAnnotationTargetResolveResult,
  ProfileExportResult,
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
  TaskTraceRunDetail,
  TaskTraceRunSummary,
  ImageAttachment,
  JevTestProviderRequest,
  LLMReasoningEffort,
  LLMProviderType,
  ManagedAgentAuditEntry,
  ManagedAgentConversionResult,
  ManagedAgentInsights,
  ManagedAgentRoutineRecord,
  ManagedAgentSlackDeploymentHealth,
  ImageGenProfile,
  MemoryFeaturesSettings,
  MemoryLayerPreviewPayload,
  MemoryWriteApprovalItem,
  MemoryObservationBackfillStatus,
  MemoryObservationMetadata,
  MemoryObservationSearchQuery,
  MemoryObservationSearchResult,
  MemoryObservationTimelineEntry,
  ManagedAgent,
  ManagedAgentRuntimeToolCatalog,
  ManagedAgentVersion,
  ManagedEnvironment,
  ManagedSession,
  ManagedSessionCreateInput,
  SessionHandoffExportResult,
  ManagedSessionEvent,
  ManagedSessionRequirementCorrectionRequest,
  ManagedSessionUserMessageRequest,
  ManagedSessionWorkpaper,
  SessionHumanMember,
  SessionInviteCreateInput,
  SessionInviteCreateResult,
  SessionInviteAcceptInput,
  SessionInviteAcceptResult,
  SessionMemberUpdateInput,
  SessionMembersRequest,
  SessionShareSnapshot,
  SessionProgressState,
  AutomationRunOutcome,
  RecurringApprovalRuleSummary,
  ProtectedCredentialRequestSummary,
  ProtectedCredentialSummary,
  UpdateManagedAgentRoutineRequest,
  ConvertAgentRoleToManagedAgentRequest,
  ConvertAutomationProfileToManagedAgentRequest,
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
  ApprovalResponseStatus,
  InputRequest,
  InputRequestResponse,
  PermissionMode,
  QuotedAssistantMessage,
  Workspace,
  GuardrailSettings,
  PersistedPermissionRule,
  PermissionSettingsData,
  PermissionRuntimeInfo,
  PdfReviewSummary,
  TaskLearningProgress,
  UnifiedRecallResponse,
  UnifiedRecallSourceType,
  ChronicleSettings,
  ChronicleCaptureStatus,
  ShellSessionInfo,
  TerminalTabRunResult,
  TerminalTabOutputEvent,
  TerminalBlockRunRequest,
  TerminalBlockRunResult,
  TerminalBlockOutputEvent,
  AgentTerminalTab,
  AgentTerminalTabRequest,
  AgentTerminalEvent,
  MessageSurfaceOrigin,
  LLMRoutingRuntimeState,
  AgentMailApiKeySummary,
  AgentMailConnectionTestResult,
  AgentMailDomain,
  AgentMailInbox,
  AgentMailListEntry,
  AgentMailPod,
  AgentMailSettingsData,
  AgentMailStatus,
  AgentMailWorkspaceBinding,
  BoxBrainSettings,
  BoxBrainStatus,
  BoxBrainSyncResult,
  IntegrationMentionOption,
  IntegrationMentionSelection,
  TaskEventDetailRequest,
  TaskEventDetailResult,
  TaskTimelinePageRequest,
  TaskTimelinePageResult,
  Task,
  BotConversationListQuery,
  BotConversationReopenRequest,
  BotNotificationPolicy,
  UpdateBotNotificationPolicyRequest,
} from "../shared/types";
import type {
  ComposerDraft,
  ComposerDraftAttachmentPutRequest,
  ComposerDraftAttachmentReleaseRequest,
  ComposerDraftAttachmentResolveRequest,
  ComposerDraftClearRequest,
  ComposerDraftGetRequest,
  ComposerDraftRekeyRequest,
} from "../shared/composer-drafts";
import type { AccessProfileId } from "../shared/access-profiles";
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
  ContactIdentity,
  ContactIdentityCandidate,
  ContactIdentityCoverageStats,
  ContactIdentityReplyTarget,
  ContactIdentitySearchResult,
  MailboxApplyActionInput,
  MailboxAskInput,
  MailboxAskResult,
  MailboxAskRunEvent,
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
  MailboxSendOutcomeResolution,
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
} from "../shared/mailbox";
import type {
  ActivityActorType,
  ActivityListQuery,
  ActivityType,
  AgentAutonomyLevel,
  AgentCapability,
  AgentToolRestrictions,
  AppNotification,
  CanvasEvent,
  CanvasSession,
  ControlPlaneSettingsData,
  ControlPlaneStatus,
  CreateActivityRequest,
  CreateMentionRequest,
  CronSchedule,
  CustomSkill,
  DeviceProxyRequest,
  ExtensionData,
  ExtensionState,
  ExtensionType,
  HeartbeatEvent,
  HeartbeatResult,
  HeartbeatStatus,
  HooksStatus,
  HygieneReport,
  LifecycleKind,
  ManagedDevice,
  ManagedDeviceSummary,
  MentionListQuery,
  MentionStatus,
  MentionType,
  MergeReview,
  MigrationStatus,
  NotificationType,
  RemoteGatewayConfig,
  RemoteGatewayConnectionState,
  RemoteGatewayStatus,
  SSHTunnelConfig,
  SSHTunnelStatus,
  SkillSearchResult,
  SkillStatusReport,
  SkillsConfig,
  TailscaleAvailability,
  TailscaleMode,
  TaskLabelListQuery,
  TraySettings,
  TunnelProvider,
  TunnelStatus,
  TunnelStatusData,
  UserProfile,
  VoiceEventType,
  VoiceInputMode,
  VoiceProvider,
  VoiceResponseMode,
} from "../shared/types";
import type {
  AgentIdentityDirectoryResult,
  BrowserDataType,
  BrowserSettings,
  BrowserSettingsState,
  BrowserSitePermissionEntry,
} from "../shared/browser-settings";

const ALLOWED_MESSAGE_IMAGE_TYPES = ["image/jpeg", "image/png", "image/gif", "image/webp"] as const;
const ALLOWED_MESSAGE_VIDEO_TYPES = ["video/mp4", "video/quicktime", "video/webm"] as const;
const ALLOWED_MESSAGE_MEDIA_TYPES = [
  ...ALLOWED_MESSAGE_IMAGE_TYPES,
  ...ALLOWED_MESSAGE_VIDEO_TYPES,
] as const;
const ALLOWED_IMAGE_FILE_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const ALLOWED_VIDEO_FILE_EXTENSIONS = new Set([".mp4", ".mov", ".webm"]);
const MAX_IMAGES_PER_MESSAGE = 5;
const MAX_TOTAL_TASK_IMAGE_BYTES = 125 * 1024 * 1024;
const MAX_IMAGE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
const MAX_VIDEO_ATTACHMENT_BYTES = 500 * 1024 * 1024;
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

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const isUuidLike = (value: unknown): value is string =>
  typeof value === "string" && UUID_PATTERN.test(value);

const isWorkspaceIdLike = (value: unknown): value is string =>
  isUuidLike(value) || (typeof value === "string" && isTempWorkspaceId(value));

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
      if (!ALLOWED_MESSAGE_MEDIA_TYPES.includes(mimeType)) {
        throw new Error(
          `Attachment at index ${index} has unsupported mime type: ${String(mimeType)}.`,
        );
      }
      const isVideo = ALLOWED_MESSAGE_VIDEO_TYPES.includes(
        mimeType as (typeof ALLOWED_MESSAGE_VIDEO_TYPES)[number],
      );

      const hasData = typeof image.data === "string" && image.data.trim().length > 0;
      const hasFilePath = isAbsoluteImagePath(image.filePath);
      if (hasData === hasFilePath) {
        throw new Error(
          `Attachment at index ${index} must provide exactly one of data or filePath.`,
        );
      }
      if (isVideo && hasData) {
        throw new Error(`Video attachment at index ${index} must use filePath.`);
      }

      let data: string | undefined;
      let filePath: string | undefined;
      let resolvedFileSize: number | undefined;
      if (hasFilePath && image.filePath) {
        if (!path.isAbsolute(image.filePath)) {
          throw new Error(`Attachment at index ${index} filePath must be an absolute path.`);
        }
        const extension = path.extname(image.filePath).toLowerCase();
        const allowedExtensions = isVideo
          ? ALLOWED_VIDEO_FILE_EXTENSIONS
          : ALLOWED_IMAGE_FILE_EXTENSIONS;
        if (!allowedExtensions.has(extension)) {
          throw new Error(
            `Attachment at index ${index} has unsupported file extension: ${extension}.`,
          );
        }
        let stat: fs.Stats;
        try {
          stat = fs.statSync(image.filePath);
        } catch (error) {
          throw new Error(
            `Attachment at index ${index} filePath could not be read: ${String((error as Error).message)}`,
          );
        }
        if (!stat.isFile()) {
          throw new Error(`Attachment at index ${index} filePath must point to a regular file.`);
        }
        const maxAttachmentBytes = isVideo
          ? MAX_VIDEO_ATTACHMENT_BYTES
          : MAX_IMAGE_ATTACHMENT_BYTES;
        if (
          stat.size === 0 ||
          !Number.isInteger(stat.size) ||
          stat.size <= 0 ||
          stat.size > maxAttachmentBytes
        ) {
          throw new Error(`Attachment at index ${index} file size is invalid.`);
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
        throw new Error(`Attachment at index ${index} sizeBytes must match attachment size.`);
      }
      if (!Number.isFinite(sizeBytes) || sizeBytes <= 0 || !Number.isInteger(sizeBytes)) {
        throw new Error(`Attachment at index ${index} has invalid sizeBytes.`);
      }
      const maxAttachmentBytes = isVideo ? MAX_VIDEO_ATTACHMENT_BYTES : MAX_IMAGE_ATTACHMENT_BYTES;
      if (sizeBytes > maxAttachmentBytes) {
        throw new Error(`Attachment at index ${index} exceeds ${maxAttachmentBytes} bytes.`);
      }

      if (!isVideo) {
        totalBytes += sizeBytes;
      }
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

// MCP types
type MCPTransportType = "stdio" | "sse" | "websocket" | "streamable-http";
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
  registryId?: string;
  auth?: {
    type: "none" | "bearer" | "api-key" | "basic";
    token?: string;
    apiKey?: string;
    username?: string;
    password?: string;
    headerName?: string;
    refreshToken?: string;
    clientId?: string;
    clientSecret?: string;
    tokenUrl?: string;
    expiresAt?: number;
  };
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
  storageStatus?:
    | "success"
    | "not_found"
    | "decryption_failed"
    | "checksum_mismatch"
    | "os_encryption_unavailable";
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
  installMethod: "npm" | "pip" | "binary" | "docker" | "manual";
  installCommand?: string;
  transport: MCPTransportType;
  defaultCommand?: string;
  defaultUrl?: string;
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

// Built-in Tools Settings types
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
  computerUseAutomation: {
    browserAutomationMode: "background" | "visible" | "ask";
    nativeComputerUseMode: "background" | "background_first" | "ask_visible" | "visible";
  };
  version: string;
}

type CronJobStatus =
  | "ok"
  | "partial_success"
  | "needs_user_action"
  | "error"
  | "skipped"
  | "timeout"
  | "cancelled"
  | "unknown";
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
  outcomeCounts?: import("../shared/cron-outcomes").CronOutcomeCounts;
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
    | "line"
    | "bluebubbles"
    | "email"
    | "teams"
    | "googlechat"
    | "whatsapp_cloud"
    | "twilio_sms";
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
  accessProfileId?: string;
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
  accessProfileId?: string;
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
  accessProfileId?: string;
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
  outcomeCounts: import("../shared/cron-outcomes").CronOutcomeCountMap;
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
  nextWakeReason?: "scheduled_job" | "task_recovery_check" | "run_timeout_check";
  nextWakeScheduleKind?: "at" | "every" | "cron";
  nextWakeTimeZone?: string;
  scheduler: CronSchedulerObservation;
  webhook?: CronWebhookStatus;
}

interface CronSchedulerObservation {
  profileScope: "current_profile" | "unknown";
  runnerKind: "desktop" | "daemon" | "unknown";
  runnerHost?: string;
  state: "running" | "disabled" | "not_started" | "unavailable";
  observedAtMs: number;
  timeZone: string;
  runnerExclusivity: "not_verified" | "unknown";
}

interface CronEvent {
  jobId: string;
  action: "added" | "updated" | "removed" | "started" | "finished";
  runAtMs?: number;
  durationMs?: number;
  status?: CronJobStatus;
  error?: string;
  taskId?: string;
  taskStillRunning?: boolean;
  nextRunAtMs?: number;
}

interface NotificationEvent {
  type: "added" | "updated" | "removed" | "cleared";
  notification?: AppNotification;
  notifications?: AppNotification[];
}

// Memory System Types
type MemoryType =
  | "observation"
  | "decision"
  | "error"
  | "insight"
  | "screen_context"
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
  compressionTokensLast24h?: number;
  compressionDailyTokenBudget?: number;
}

// ChatGPT Import types
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
  /** Memories created per export category (instructions, identity, career, ...). */
  byCategory: Partial<Record<string, number>>;
  /** The pasted answer said more entries remain. */
  incomplete: boolean;
}

// Hooks types
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

interface GmailHooksStatus {
  configured: boolean;
  running: boolean;
  account?: string;
  topic?: string;
  gogAvailable: boolean;
}

const LOCAL_MANAGED_DEVICE_ID = "local:this-device";
const LOCAL_MANAGED_DEVICE_NODE_ID = "local:this-device";
void LOCAL_MANAGED_DEVICE_ID;
void LOCAL_MANAGED_DEVICE_NODE_ID;

interface RemoteGatewayEvent {
  type: "stateChange" | "event";
  deviceId?: string;
  state?: RemoteGatewayConnectionState;
  event?: string;
  payload?: unknown;
  error?: string;
}

/** What a reply-draft card's action did (see MailReplyDraftsService). */
type MailReplyDraftCardOutcome =
  | { ok: true; sendAfter?: number }
  | { ok: false; reason: "not_found" | "gone" | "too_late" | "failed"; message: string };

/** What a calendar card's action did (see CalendarProposalsService). */
type CalendarCardOutcome =
  | { ok: true; kind: "focus_hold" | "conflict" | "meeting_prep" }
  | { ok: false; reason: "not_connected" | "gone" | "not_allowed" | "failed"; message: string };

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
  /** "May do alone": the most access this agent's work gets. */
  accessProfileId?: string;
  /** Where this bot works; unset means Auto. */
  worksOn?: import("../shared/bot-computer").BotWorksOn;
  desktopHost?: string;
  desktopGroup?: string;
  /** Which files runs nobody started by hand work on; unset means its own folder. */
  fileAccess?: import("../shared/bot-containment").BotFileAccess;
  /** What its own desktop may reach on the network; unset means internet only. */
  executionEnvironment?: import("../shared/execution-environment").ExecutionEnvironmentSelection;
  desktopNetwork?: import("../shared/bot-computer").BotDesktopNetwork;
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
  worksOn?: import("../shared/bot-computer").BotWorksOn;
  desktopHost?: string;
  desktopGroup?: string;
  fileAccess?: import("../shared/bot-containment").BotFileAccess;
  executionEnvironment?: import("../shared/execution-environment").ExecutionEnvironmentSelection;
  desktopNetwork?: import("../shared/bot-computer").BotDesktopNetwork;
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
  /** The agent's access limit; null clears it. */
  accessProfileId?: string | null;
  worksOn?: import("../shared/bot-computer").BotWorksOn | null;
  desktopHost?: string | null;
  desktopGroup?: string | null;
  fileAccess?: import("../shared/bot-containment").BotFileAccess | null;
  executionEnvironment?:
    | import("../shared/execution-environment").ExecutionEnvironmentSelection
    | null;
  desktopNetwork?: import("../shared/bot-computer").BotDesktopNetwork | null;
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

interface ActivityEvent {
  type: "created" | "read" | "all_read" | "pinned" | "deleted";
  activity?: ActivityData;
  id?: string;
  workspaceId?: string;
}

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

interface MentionEvent {
  type: "created" | "acknowledged" | "completed" | "dismissed";
  mention?: MentionData;
}

// Task Board types
type TaskBoardColumn = "backlog" | "todo" | "in_progress" | "review" | "done";

interface TaskLabelData {
  id: string;
  workspaceId: string;
  name: string;
  color: string;
  createdAt: number;
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

// Context Policy types
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

interface ChannelSpecializationData {
  id: string;
  channelId: string;
  chatId?: string;
  threadId?: string;
  name?: string;
  workspaceId?: string;
  agentRoleId?: string;
  systemGuidance?: string;
  toolRestrictions?: string[];
  allowSharedContextMemory: boolean;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

interface CreateChannelSpecializationData {
  channelId: string;
  chatId?: string;
  threadId?: string;
  name?: string;
  workspaceId?: string;
  agentRoleId?: string;
  systemGuidance?: string;
  toolRestrictions?: string[];
  allowSharedContextMemory?: boolean;
  enabled?: boolean;
}

interface UpdateChannelSpecializationData {
  id: string;
  chatId?: string | null;
  threadId?: string | null;
  name?: string | null;
  workspaceId?: string | null;
  agentRoleId?: string | null;
  systemGuidance?: string | null;
  toolRestrictions?: string[];
  allowSharedContextMemory?: boolean;
  enabled?: boolean;
}

interface ReadFileForViewerOptions {
  enableImageOcr?: boolean;
  imageOcrMaxChars?: number;
  includeImageContent?: boolean;
  includePdfBase64?: boolean;
  presentationRenderMode?: "fast" | "full";
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

async function invokeTaskIpcWithRendererTiming<T>(channel: string, ...args: unknown[]): Promise<T> {
  const startedAt =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  const result = await ipcRenderer.invoke(channel, ...args);
  const receivedAt =
    typeof performance !== "undefined" && typeof performance.now === "function"
      ? performance.now()
      : Date.now();
  const rowCount = Array.isArray(result)
    ? result.length
    : result && typeof result === "object" && Array.isArray((result as { events?: unknown }).events)
      ? (result as { events: unknown[] }).events.length
      : result
        ? 1
        : 0;
  void ipcRenderer.invoke(IPC_CHANNELS.RENDERER_PERF_LOG, {
    timestamp: new Date().toISOString(),
    message: `[IpcRendererPerf] ${JSON.stringify({
      channel,
      receiveMs: Number((receivedAt - startedAt).toFixed(1)),
      rowCount,
    })}`,
  });
  return result as T;
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
  openFileWithApp: (filePath: string, workspacePath: string | undefined, appName: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_OPEN_WITH_APP, filePath, workspacePath, appName),
  showInFinder: (filePath: string, workspacePath?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_SHOW_IN_FINDER, filePath, workspacePath),
  readFileForViewer: (
    filePath: string,
    workspacePath?: string,
    options?: ReadFileForViewerOptions,
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_READ_FOR_VIEWER, { filePath, workspacePath, ...options }),
  updateSpreadsheetFile: (data: {
    filePath: string;
    workspacePath: string;
    preview: SpreadsheetPreview;
  }) => ipcRenderer.invoke(IPC_CHANNELS.FILE_UPDATE_SPREADSHEET, data) as Promise<FileViewerResult>,
  openSpreadsheetWorkbook: (data: {
    filePath: string;
    workspacePath: string;
    workspaceId?: string;
  }) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.SPREADSHEET_OPEN_WORKBOOK,
      data,
    ) as Promise<SpreadsheetOpenWorkbookResult>,
  applySpreadsheetPatches: (data: { sessionId: string; patches: SpreadsheetPatch[] }) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.SPREADSHEET_APPLY_PATCHES,
      data,
    ) as Promise<SpreadsheetApplyPatchesResult>,
  saveSpreadsheetWorkbook: (data: { sessionId: string }) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.SPREADSHEET_SAVE_WORKBOOK,
      data,
    ) as Promise<SpreadsheetSaveWorkbookResult>,
  closeSpreadsheetWorkbook: (data: { sessionId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SPREADSHEET_CLOSE_WORKBOOK, data) as Promise<{
      success: boolean;
    }>,
  updateDocumentFile: (data: {
    filePath: string;
    workspacePath: string;
    blocks: EditableDocumentBlock[];
  }) => ipcRenderer.invoke(IPC_CHANNELS.FILE_UPDATE_DOCUMENT, data) as Promise<FileViewerResult>,
  listTerminalTabs: (workspaceId: string, taskId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_TAB_LIST, {
      workspaceId,
      ...(taskId ? { taskId } : {}),
    }) as Promise<ShellSessionInfo[]>,
  createTerminalTab: (data: {
    workspaceId: string;
    taskId?: string;
    cwd?: string;
    title?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_TAB_CREATE, data) as Promise<ShellSessionInfo>,
  runTerminalTabCommand: (data: {
    tabId: string;
    workspaceId: string;
    taskId: string;
    command: string;
    cwd?: string;
    timeoutMs?: number;
  }) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_TAB_RUN, data) as Promise<TerminalTabRunResult>,
  writeTerminalTabInput: (data: {
    tabId: string;
    workspaceId: string;
    taskId?: string;
    input: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_TAB_WRITE, data) as Promise<ShellSessionInfo>,
  resizeTerminalTab: (data: {
    tabId: string;
    workspaceId: string;
    taskId?: string;
    cols: number;
    rows: number;
  }) => ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_TAB_RESIZE, data) as Promise<ShellSessionInfo>,
  stopTerminalTab: (data: { tabId: string; workspaceId: string; taskId?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_TAB_STOP, data) as Promise<ShellSessionInfo | null>,
  closeTerminalTab: (data: { tabId: string; workspaceId: string; taskId?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_TAB_CLOSE, data) as Promise<{ success: boolean }>,
  onTerminalTabOutput: (callback: (event: TerminalTabOutputEvent) => void) => {
    const handler = (_: Any, event: TerminalTabOutputEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_TAB_OUTPUT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_TAB_OUTPUT, handler);
  },
  runTerminalBlock: (data: TerminalBlockRunRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_BLOCK_RUN, data) as Promise<TerminalBlockRunResult>,
  stopTerminalBlock: (data: { runId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.TERMINAL_BLOCK_STOP, data) as Promise<{ stopped: boolean }>,
  onTerminalBlockOutput: (callback: (event: TerminalBlockOutputEvent) => void) => {
    const handler = (_: Any, event: TerminalBlockOutputEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.TERMINAL_BLOCK_OUTPUT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TERMINAL_BLOCK_OUTPUT, handler);
  },
  listAgentTerminalTabs: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_TERMINAL_LIST, { taskId }) as Promise<AgentTerminalTab[]>,
  readAgentTerminalTab: (data: AgentTerminalTabRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_TERMINAL_READ, data) as Promise<{
      output: string;
      truncated: boolean;
    }>,
  stopAgentTerminalTab: (data: AgentTerminalTabRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_TERMINAL_STOP, data) as Promise<AgentTerminalTab>,
  closeAgentTerminalTab: (data: AgentTerminalTabRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_TERMINAL_CLOSE, data) as Promise<{ success: boolean }>,
  onAgentTerminalEvent: (callback: (event: AgentTerminalEvent) => void) => {
    const handler = (_: Any, event: AgentTerminalEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.AGENT_TERMINAL_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.AGENT_TERMINAL_EVENT, handler);
  },
  listLocalPreviewTemplates: () =>
    ipcRenderer.invoke(IPC_CHANNELS.LOCAL_PREVIEW_TEMPLATES) as Promise<
      LocalPreviewCommandTemplate[]
    >,
  startLocalPreview: (request: LocalPreviewStartRequest) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.LOCAL_PREVIEW_START,
      request,
    ) as Promise<LocalPreviewProcessInfo>,
  stopLocalPreview: (previewId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.LOCAL_PREVIEW_STOP,
      previewId,
    ) as Promise<LocalPreviewProcessInfo>,
  restartLocalPreview: (previewId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.LOCAL_PREVIEW_RESTART,
      previewId,
    ) as Promise<LocalPreviewProcessInfo>,
  getLocalPreview: (previewId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.LOCAL_PREVIEW_GET,
      previewId,
    ) as Promise<LocalPreviewProcessInfo | null>,
  listLocalPreviews: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LOCAL_PREVIEW_LIST, workspaceId) as Promise<
      LocalPreviewProcessInfo[]
    >,
  checkLocalPreviewHealth: (previewId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.LOCAL_PREVIEW_HEALTH,
      previewId,
    ) as Promise<LocalPreviewHealthResult>,
  openLocalPreview: (previewId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.LOCAL_PREVIEW_OPEN,
      previewId,
    ) as Promise<LocalPreviewProcessInfo>,
  registerBrowserWorkbenchSession: (data: BrowserWorkbenchSessionRegistration) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_REGISTER, data) as Promise<{ success: true }>,
  unregisterBrowserWorkbenchSession: (data: {
    taskId: string;
    sessionId?: string;
    tabId?: string;
    webContentsId?: number;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_UNREGISTER, data) as Promise<{
      success: true;
    }>,
  updateBrowserWorkbenchStatus: (data: {
    taskId: string;
    sessionId?: string;
    tabId?: string;
    webContentsId?: number;
    url?: string;
    title?: string;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_STATUS, data) as Promise<{ success: true }>,
  activateBrowserWorkbenchTab: (data: { taskId: string; sessionId?: string; tabId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_TAB_ACTIVATE, data) as Promise<{
      success: boolean;
    }>,
  checkBrowserWorkbenchTabClose: (data: { taskId: string; sessionId?: string; tabId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_TAB_CLOSE_CHECK, data) as Promise<{
      close: boolean;
    }>,
  browserWorkbenchUserNavigate: (data: {
    taskId: string;
    sessionId?: string;
    tabId?: string;
    url: string;
  }) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.BROWSER_WORKBENCH_USER_NAVIGATE,
      data,
    ) as Promise<BrowserWorkbenchUserNavigateResult>,
  respondBrowserWorkbenchPermission: (data: {
    requestId: string;
    response: BrowserWorkbenchPermissionResponse;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_PERMISSION_RESPOND, data) as Promise<{
      success: boolean;
    }>,
  listBrowserWorkbenchPermissionRequests: (data: { taskId: string; sessionId?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_PERMISSION_LIST, data) as Promise<
      BrowserWorkbenchPermissionPrompt[]
    >,
  inspectBrowserWorkbenchArea: (data: {
    taskId: string;
    sessionId?: string;
    rect: { x: number; y: number; width: number; height: number };
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_INSPECT_AREA, data) as Promise<{
      success: boolean;
      area?: BrowserWorkbenchInspectArea;
      error?: string;
    }>,
  previewBrowserWorkbenchStyle: (data: {
    taskId: string;
    sessionId?: string;
    selector: string;
    action: "apply" | "revert";
    styles?: Record<string, string>;
    text?: string;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_STYLE_PREVIEW, data) as Promise<{
      success: boolean;
      error?: string;
    }>,
  setBrowserWorkbenchFocus: (focused: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_FOCUS, { focused }) as Promise<{
      success: boolean;
    }>,
  getBrowserWorkbenchDiagnostics: (data: BrowserWorkbenchDiagnosticsRequest) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.BROWSER_WORKBENCH_DIAGNOSTICS_GET,
      data,
    ) as Promise<BrowserWorkbenchDiagnosticsResult>,
  browserWorkbenchTrace: (data: {
    taskId: string;
    sessionId?: string;
    tabId?: string;
    action: "start" | "stop";
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_TRACE, data) as Promise<{
      success: boolean;
      message?: string;
      error?: string;
    }>,
  getBrowserWorkbenchSnapshot: (data: { taskId: string; sessionId?: string; tabId?: string }) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.BROWSER_WORKBENCH_SNAPSHOT_GET,
      data,
    ) as Promise<BrowserWorkbenchSnapshotOverlay | null>,
  browserImportDetect: () =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_IMPORT_DETECT) as Promise<BrowserImportDetectResult>,
  browserImportPrepare: (data: BrowserImportPrepareRequest) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.BROWSER_IMPORT_PREPARE,
      data,
    ) as Promise<BrowserImportPrepareResult>,
  browserImportCommit: (data: {
    workspaceId: string;
    token: string;
    cookies?: boolean;
    passwords?: boolean;
    saveToVault?: boolean;
    applyToBrowser?: boolean;
  }) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.BROWSER_IMPORT_COMMIT,
      data,
    ) as Promise<BrowserImportCommitResult>,
  browserImportCancel: (data: { token: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_IMPORT_CANCEL, data) as Promise<{ success: boolean }>,
  browserImportDeleteFile: (data: { token: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_IMPORT_DELETE_FILE, data) as Promise<{
      success: boolean;
      deleted?: boolean;
      error?: string;
    }>,
  listBrowserVaultPrompts: () =>
    ipcRenderer.invoke(BROWSER_VAULT_IPC.prompts) as Promise<BrowserVaultPrompt[]>,
  respondBrowserVaultPrompt: (id: string, answer: BrowserVaultAnswer | null) =>
    ipcRenderer.invoke(BROWSER_VAULT_IPC.respond, { id, answer }) as Promise<{ success: boolean }>,
  dismissBrowserVaultPrompt: (id: string) =>
    ipcRenderer.invoke(BROWSER_VAULT_IPC.dismiss, id) as Promise<{ success: boolean }>,
  browserVaultCommand: (taskId: string, command: BrowserVaultCommand) =>
    ipcRenderer.invoke(BROWSER_VAULT_IPC.command, { taskId, command }) as Promise<{
      success: boolean;
      error?: string;
      [key: string]: unknown;
    }>,
  // Settings > System & Security > Password Managers. No token or vault value comes back.
  getSecretSourcesStatus: () =>
    ipcRenderer.invoke(SECRET_SOURCES_IPC.status) as Promise<{
      success: boolean;
      status?: SecretSourcesStatus;
      error?: string;
    }>,
  saveSecretSources: (update: SecretSourcesSettingsUpdate) =>
    ipcRenderer.invoke(SECRET_SOURCES_IPC.save, update) as Promise<{
      success: boolean;
      status?: SecretSourcesStatus;
      error?: string;
    }>,
  unlockBitwardenForKeys: (password: string) =>
    ipcRenderer.invoke(SECRET_SOURCES_IPC.unlockBitwarden, { password }) as Promise<{
      success: boolean;
      error?: string;
    }>,
  lockBitwardenForKeys: () =>
    ipcRenderer.invoke(SECRET_SOURCES_IPC.lockBitwarden) as Promise<{
      success: boolean;
      error?: string;
    }>,
  testSecretReference: (reference: string) =>
    ipcRenderer.invoke(SECRET_SOURCES_IPC.test, { reference }) as Promise<{
      success: boolean;
      result?: SecretReferenceTestResult;
      error?: string;
    }>,
  onBrowserVaultPromptChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(BROWSER_VAULT_IPC.changed, listener);
    return () => ipcRenderer.removeListener(BROWSER_VAULT_IPC.changed, listener);
  },
  listBrowserLogins: (data: { workspaceId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_VAULT_LIST, data) as Promise<BrowserLoginsResult>,
  listBrowserLoginsForPage: (data: { workspaceId: string; url: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_VAULT_FOR_PAGE, data) as Promise<BrowserLoginsResult>,
  removeBrowserLogin: (data: { workspaceId: string; id: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_VAULT_REMOVE, data) as Promise<{ success: boolean }>,
  removeBrowserCookieJar: (data: { workspaceId: string; id: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_VAULT_REMOVE, {
      workspaceId: data.workspaceId,
      id: data.id,
      kind: "cookie_jar",
    }) as Promise<{ success: boolean }>,
  clearBrowserLogins: (data: { workspaceId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_VAULT_CLEAR, data) as Promise<{
      success: boolean;
      removed: number;
    }>,
  fillBrowserLogin: (data: {
    workspaceId: string;
    taskId: string;
    sessionId?: string;
    id: string;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_VAULT_FILL, data) as Promise<{
      success: boolean;
      filledUsername?: boolean;
      code?: string;
      error?: string;
    }>,
  getBrowserSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SETTINGS_GET) as Promise<BrowserSettingsState>,
  saveBrowserSettings: (settings: Partial<BrowserSettings>) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SETTINGS_SAVE, settings) as Promise<{
      success: boolean;
      settings?: BrowserSettingsState;
    }>,
  getCamofoxSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CAMOFOX_SETTINGS_GET) as Promise<CamofoxDisplaySettings>,
  saveCamofoxSettings: (update: CamofoxSettingsUpdate) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.CAMOFOX_SETTINGS_SAVE,
      update,
    ) as Promise<CamofoxDisplaySettings>,
  testCamofoxConnection: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CAMOFOX_TEST_CONNECTION) as Promise<CamofoxConnectionResult>,
  copyCamofoxStartCommand: () =>
    ipcRenderer.invoke(IPC_CHANNELS.CAMOFOX_COPY_START_COMMAND) as Promise<void>,
  resolveWorktreeBaseCommit: (data: { workspaceId: string; branch?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_RESOLVE_BASE_COMMIT, data) as Promise<{
      commit: string;
    }>,
  getMergeReview: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_MERGE_REVIEW, workspaceId) as Promise<MergeReview>,
  getHygieneReport: (data?: { includeAll?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIFECYCLE_HYGIENE_REPORT, data) as Promise<HygieneReport>,
  retireLifecycleItem: (data: { kind: LifecycleKind; id: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIFECYCLE_RETIRE, data) as Promise<{
      success: boolean;
      error?: string;
    }>,
  keepLifecycleItem: (data: { kind: LifecycleKind; id: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIFECYCLE_KEEP, data) as Promise<{ success: boolean }>,
  setLifecycleMeta: (data: LifecycleMetaInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.LIFECYCLE_SET_META, data) as Promise<{
      success: boolean;
      error?: string;
    }>,
  getAgentIdentityDirectory: () =>
    ipcRenderer.invoke(
      IPC_CHANNELS.AGENT_IDENTITY_DIRECTORY_GET,
    ) as Promise<AgentIdentityDirectoryResult>,
  rotateAgentIdentityKey: () =>
    ipcRenderer.invoke(
      IPC_CHANNELS.AGENT_IDENTITY_KEY_ROTATE,
    ) as Promise<AgentIdentityDirectoryResult>,
  listBrowserSitePermissions: (data: { workspaceId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SITE_PERMISSIONS_LIST, data) as Promise<
      BrowserSitePermissionEntry[]
    >,
  resetBrowserSitePermission: (data: {
    workspaceId: string;
    origin?: string;
    permission?: string;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SITE_PERMISSIONS_RESET, data) as Promise<{
      success: boolean;
    }>,
  setBrowserSitePermission: (data: {
    workspaceId: string;
    origin: string;
    permission: string;
    decision: "allow" | "block";
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_SITE_PERMISSIONS_SET, data) as Promise<{
      success: boolean;
    }>,
  searchBrowserHistory: (data: { workspaceId: string; query: string; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_HISTORY_SEARCH, data) as Promise<
      BrowserHistoryEntryView[]
    >,
  listBrowserHistory: (data: {
    workspaceId: string;
    limit?: number;
    offset?: number;
    query?: string;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_HISTORY_LIST, data) as Promise<
      BrowserHistoryEntryView[]
    >,
  removeBrowserHistory: (data: { workspaceId: string; ids: string[] }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_HISTORY_REMOVE, data) as Promise<{
      success: boolean;
      removed: number;
    }>,
  clearBrowserHistory: (data: { workspaceId: string; since?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_HISTORY_CLEAR, data) as Promise<{
      success: boolean;
      removed: number;
    }>,
  clearBrowserData: (data: { workspaceId: string; types: BrowserDataType[]; since?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_CLEAR_DATA, data) as Promise<{
      success: boolean;
    }>,
  listBrowserDownloads: (data: { taskId: string; sessionId?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_DOWNLOAD_LIST, data) as Promise<
      BrowserWorkbenchDownloadEvent[]
    >,
  browserDownloadAction: (data: {
    id: string;
    action: "pause" | "resume" | "cancel" | "open" | "reveal" | "clear";
    confirmedDangerous?: boolean;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_DOWNLOAD_ACTION, data) as Promise<{
      success: boolean;
      error?: string;
    }>,
  setBrowserWorkbenchPaused: (data: { taskId: string; sessionId?: string; paused: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_SET_PAUSED, data) as Promise<{
      success: boolean;
    }>,
  captureBrowserWorkbenchScreenshot: (data: {
    taskId: string;
    sessionId?: string;
    workspacePath: string;
    filename?: string;
    includeDataUrl?: boolean;
    fullPage?: boolean;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_SCREENSHOT, data) as Promise<{
      success: boolean;
      path?: string;
      fullPath?: string;
      width?: number;
      height?: number;
      dataUrl?: string;
      error?: string;
    }>,
  inspectBrowserWorkbenchPoint: (data: {
    taskId: string;
    sessionId?: string;
    x: number;
    y: number;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_INSPECT_POINT, data) as Promise<{
      success: boolean;
      target?: BrowserWorkbenchInspectTarget;
      error?: string;
    }>,
  resolveBrowserWorkbenchAnnotationTargets: (data: {
    taskId: string;
    sessionId?: string;
    targets: BrowserAnnotationTargetRef[];
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_RESOLVE_ANNOTATION_TARGETS, data) as Promise<{
      success: boolean;
      targets?: BrowserAnnotationTargetResolveResult[];
      error?: string;
    }>,
  createAnnotation: (data: AnnotationCreateInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.ANNOTATION_CREATE, data) as Promise<Annotation>,
  listAnnotations: (query: AnnotationListQuery) =>
    ipcRenderer.invoke(IPC_CHANNELS.ANNOTATION_LIST, query) as Promise<Annotation[]>,
  updateAnnotation: (id: string, patch: AnnotationUpdateInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.ANNOTATION_UPDATE, { id, patch }) as Promise<Annotation | null>,
  resolveAnnotation: (id: string, resolvedByEventId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ANNOTATION_RESOLVE, {
      id,
      resolvedByEventId,
    }) as Promise<Annotation | null>,
  dismissAnnotation: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ANNOTATION_DISMISS, { id }) as Promise<Annotation | null>,
  undoAnnotationChange: (id: string, undoToken: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ANNOTATION_UNDO, {
      id,
      undoToken,
    }) as Promise<AnnotationUndoResult>,
  onBrowserWorkbenchOpenRequest: (callback: (request: BrowserWorkbenchOpenRequest) => void) => {
    const handler = (_: Any, request: BrowserWorkbenchOpenRequest) => callback(request);
    ipcRenderer.on(IPC_CHANNELS.BROWSER_WORKBENCH_OPEN_REQUEST, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_WORKBENCH_OPEN_REQUEST, handler);
  },
  onBrowserWorkbenchCursor: (callback: (event: BrowserWorkbenchCursorEvent) => void) => {
    const handler = (_: Any, event: BrowserWorkbenchCursorEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.BROWSER_WORKBENCH_CURSOR, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_WORKBENCH_CURSOR, handler);
  },
  onBrowserWorkbenchViewport: (callback: (event: BrowserWorkbenchViewportEvent) => void) => {
    const handler = (_: Any, event: BrowserWorkbenchViewportEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.BROWSER_WORKBENCH_VIEWPORT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_WORKBENCH_VIEWPORT, handler);
  },
  onBrowserWorkbenchTabCommand: (callback: (command: BrowserWorkbenchTabCommand) => void) => {
    const handler = (_: Any, command: BrowserWorkbenchTabCommand) => callback(command);
    ipcRenderer.on(IPC_CHANNELS.BROWSER_WORKBENCH_TAB_COMMAND, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_WORKBENCH_TAB_COMMAND, handler);
  },
  popupBrowserToolbarMenu: (data: BrowserToolbarMenuRequest) =>
    ipcRenderer.invoke(
      BROWSER_TOOLBAR_MENU_POPUP,
      data,
    ) as Promise<BrowserToolbarMenuAction | null>,
  // Native tab views (browser engine "native"): the main process owns each tab's page.
  openBrowserTabView: (data: {
    taskId: string;
    sessionId: string;
    tabId: string;
    partition: string;
    activate: boolean;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_TAB_VIEW_OPEN, data) as Promise<BrowserTabViewState>,
  loadBrowserTabView: (data: { taskId: string; sessionId: string; tabId: string; url: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_TAB_VIEW_LOAD, data) as Promise<{ success: boolean }>,
  commandBrowserTabView: (data: {
    taskId: string;
    sessionId: string;
    tabId: string;
    command: BrowserTabViewCommand;
    args?: Record<string, unknown>;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_TAB_VIEW_COMMAND, data) as Promise<{
      success: boolean;
    }>,
  layoutBrowserTabView: (data: {
    taskId: string;
    sessionId: string;
    tabId: string | null;
    bounds: { x: number; y: number; width: number; height: number } | null;
  }) => ipcRenderer.invoke(IPC_CHANNELS.BROWSER_TAB_VIEW_LAYOUT, data) as Promise<void>,
  captureBrowserTabView: (data: { taskId: string; sessionId: string; tabId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_TAB_VIEW_CAPTURE, data) as Promise<string | null>,
  closeBrowserTabView: (data: { taskId: string; sessionId: string; tabId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_TAB_VIEW_CLOSE, data) as Promise<void>,
  onBrowserTabViewEvent: (callback: (event: BrowserTabViewEvent) => void) => {
    const handler = (_: Any, event: BrowserTabViewEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.BROWSER_TAB_VIEW_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_TAB_VIEW_EVENT, handler);
  },
  onBrowserWorkbenchScreenShareRequest: (
    callback: (prompt: BrowserWorkbenchScreenSharePrompt) => void,
  ) => {
    const handler = (_: Any, prompt: BrowserWorkbenchScreenSharePrompt) => callback(prompt);
    ipcRenderer.on(IPC_CHANNELS.BROWSER_WORKBENCH_SCREEN_SHARE_REQUEST, handler);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_WORKBENCH_SCREEN_SHARE_REQUEST, handler);
  },
  listBrowserWorkbenchScreenShareRequests: (data: { taskId: string; sessionId?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_SCREEN_SHARE_LIST, data) as Promise<
      BrowserWorkbenchScreenSharePrompt[]
    >,
  respondBrowserWorkbenchScreenShare: (data: { requestId: string; sourceId: string | null }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_SCREEN_SHARE_RESPOND, data) as Promise<{
      success: boolean;
    }>,
  onBrowserWorkbenchPageDialog: (callback: (event: BrowserWorkbenchPageDialogEvent) => void) => {
    const handler = (_: Any, event: BrowserWorkbenchPageDialogEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.BROWSER_WORKBENCH_PAGE_DIALOG, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_WORKBENCH_PAGE_DIALOG, handler);
  },
  respondBrowserWorkbenchPageDialog: (data: {
    taskId: string;
    sessionId?: string;
    tabId: string;
    dialogId: string;
    accept: boolean;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BROWSER_WORKBENCH_PAGE_DIALOG_RESPOND, data) as Promise<{
      success: boolean;
    }>,
  onBrowserWorkbenchNavigationBlocked: (
    callback: (event: BrowserWorkbenchNavigationBlockedEvent) => void,
  ) => {
    const handler = (_: Any, event: BrowserWorkbenchNavigationBlockedEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.BROWSER_WORKBENCH_NAVIGATION_BLOCKED, handler);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_WORKBENCH_NAVIGATION_BLOCKED, handler);
  },
  onBrowserWorkbenchDriving: (callback: (event: BrowserWorkbenchDrivingEvent) => void) => {
    const handler = (_: Any, event: BrowserWorkbenchDrivingEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.BROWSER_WORKBENCH_DRIVING, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_WORKBENCH_DRIVING, handler);
  },
  onBrowserWorkbenchDownload: (callback: (event: BrowserWorkbenchDownloadEvent) => void) => {
    const handler = (_: Any, event: BrowserWorkbenchDownloadEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.BROWSER_WORKBENCH_DOWNLOAD_EVENT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_WORKBENCH_DOWNLOAD_EVENT, handler);
  },
  onBrowserWorkbenchSignInRequired: (callback: (event: BrowserWorkbenchSignInEvent) => void) => {
    const handler = (_: Any, event: BrowserWorkbenchSignInEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.BROWSER_WORKBENCH_SIGN_IN_REQUIRED, handler);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_WORKBENCH_SIGN_IN_REQUIRED, handler);
  },
  onBrowserWorkbenchShortcut: (callback: (event: BrowserWorkbenchShortcutEvent) => void) => {
    const handler = (_: Any, event: BrowserWorkbenchShortcutEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.BROWSER_WORKBENCH_SHORTCUT, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_WORKBENCH_SHORTCUT, handler);
  },
  onBrowserWorkbenchContextAction: (
    callback: (event: BrowserWorkbenchContextActionEvent) => void,
  ) => {
    const handler = (_: Any, event: BrowserWorkbenchContextActionEvent) => callback(event);
    ipcRenderer.on(IPC_CHANNELS.BROWSER_WORKBENCH_CONTEXT_ACTION, handler);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_WORKBENCH_CONTEXT_ACTION, handler);
  },
  onBrowserWorkbenchPermissionRequest: (
    callback: (prompt: BrowserWorkbenchPermissionPrompt) => void,
  ) => {
    const handler = (_: Any, prompt: BrowserWorkbenchPermissionPrompt) => callback(prompt);
    ipcRenderer.on(IPC_CHANNELS.BROWSER_WORKBENCH_PERMISSION_REQUEST, handler);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.BROWSER_WORKBENCH_PERMISSION_REQUEST, handler);
  },
  askYouTubeVideo: (data: {
    workspaceId: string;
    question: string;
    url?: string;
    videoIds?: string[];
    language?: string;
    limit?: number;
    force?: boolean;
  }) => ipcRenderer.invoke(IPC_CHANNELS.YOUTUBE_ASK_VIDEO, data),
  getLlmWikiVaultSummary: (data: { workspacePath: string; vaultPath?: string }) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.LLM_WIKI_GET_VAULT_SUMMARY,
      data,
    ) as Promise<LlmWikiVaultSummary>,
  importFilesToWorkspace: (data: { workspaceId: string; files: string[] }) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILE_IMPORT_TO_WORKSPACE, data),
  importDataToWorkspace: (data: {
    workspaceId: string;
    files: Array<{ name: string; data: string; mimeType?: string }>;
  }) => ipcRenderer.invoke(IPC_CHANNELS.FILE_IMPORT_DATA_TO_WORKSPACE, data),
  openDocumentEditorSession: (data: { filePath: string; workspacePath?: string }) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.DOCUMENT_OPEN_EDITOR_SESSION,
      data,
    ) as Promise<DocumentEditorSession>,
  startDocumentEditTask: (data: DocumentEditRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.DOCUMENT_START_EDIT_TASK, data),
  getMailboxSyncStatus: () => ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_GET_SYNC_STATUS),
  getMailboxClientState: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_CLIENT_STATE) as Promise<MailboxClientState>,
  syncMailbox: (limit?: number, source: "auto" | "manual" = "manual") =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SYNC, { limit, source }),
  listMailboxThreads: (query?: MailboxListThreadsInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_LIST_THREADS, query),
  getMailboxThread: (threadId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_GET_THREAD, threadId),
  listMailboxEvents: (limit?: number, threadId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_LIST_EVENTS, { limit, threadId }) as Promise<
      MailboxEvent[]
    >,
  listMailboxAutomations: (query?: { workspaceId?: string; threadId?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_LIST, query) as Promise<
      MailboxAutomationRecord[]
    >,
  createMailboxRule: (recipe: MailboxRuleRecipe) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_CREATE_RULE, {
      recipe,
    }) as Promise<MailboxAutomationRecord>,
  updateMailboxRule: (
    id: string,
    patch: Partial<MailboxRuleRecipe> & { status?: MailboxAutomationStatus },
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_UPDATE_RULE, {
      id,
      patch,
    }) as Promise<MailboxAutomationRecord | null>,
  deleteMailboxRule: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_DELETE_RULE, id) as Promise<boolean>,
  createMailboxSchedule: (recipe: MailboxScheduleRecipe) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_CREATE_SCHEDULE, {
      recipe,
    }) as Promise<MailboxAutomationRecord>,
  updateMailboxSchedule: (
    id: string,
    patch: Partial<MailboxScheduleRecipe> & { status?: MailboxAutomationStatus },
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_UPDATE_SCHEDULE, {
      id,
      patch,
    }) as Promise<MailboxAutomationRecord | null>,
  deleteMailboxSchedule: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_DELETE_SCHEDULE, id) as Promise<boolean>,
  createMailboxForward: (recipe: MailboxForwardRecipe) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_CREATE_FORWARD, {
      recipe,
    }) as Promise<MailboxAutomationRecord>,
  updateMailboxForward: (
    id: string,
    patch: Partial<MailboxForwardRecipe> & { status?: MailboxAutomationStatus },
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_UPDATE_FORWARD, {
      id,
      patch,
    }) as Promise<MailboxAutomationRecord | null>,
  deleteMailboxForward: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_DELETE_FORWARD, id) as Promise<boolean>,
  runMailboxForward: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_AUTOMATION_RUN_FORWARD, id) as Promise<string>,
  getMailboxDigest: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_GET_DIGEST, {
      workspaceId,
    }) as Promise<MailboxDigestSnapshot>,
  getMailboxSenderCleanupDigest: (input?: { limit?: number }) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MAILBOX_SENDER_CLEANUP_DIGEST,
      input || {},
    ) as Promise<MailboxSenderCleanupDigest>,
  askMailbox: (input: MailboxAskInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_ASK, input) as Promise<MailboxAskResult>,
  onMailboxAskEvent: (callback: (event: MailboxAskRunEvent) => void) => {
    const subscription = (_: Any, data: MailboxAskRunEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.MAILBOX_ASK_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MAILBOX_ASK_EVENT, subscription);
  },
  extractMailboxAttachmentText: (attachmentId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_ATTACHMENT_EXTRACT_TEXT, {
      attachmentId,
    }) as Promise<MailboxAttachmentRecord>,
  getMailboxDraft: (draftId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_GET_DRAFT, {
      draftId,
    }) as Promise<MailboxComposeDraft | null>,
  createMailboxDraft: (input: MailboxComposeDraftInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_CREATE_DRAFT, input) as Promise<MailboxComposeDraft>,
  updateMailboxDraft: (draftId: string, patch: MailboxComposeDraftPatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_UPDATE_DRAFT, {
      draftId,
      patch,
    }) as Promise<MailboxComposeDraft>,
  sendMailboxDraft: (draftId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SEND_DRAFT, {
      draftId,
    }) as Promise<MailboxOutgoingMessage>,
  retryMailboxAction: (actionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_RETRY_ACTION, {
      actionId,
    }) as Promise<MailboxQueuedAction>,
  resolveMailboxSendOutcome: (actionId: string, resolution: MailboxSendOutcomeResolution) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_RESOLVE_SEND_OUTCOME, {
      actionId,
      resolution,
    }) as Promise<MailboxQueuedAction>,
  discardMailboxDraft: (draftId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_DISCARD_COMPOSE_DRAFT, { draftId }) as Promise<boolean>,
  cancelMailboxDraftSend: (draftId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_CANCEL_SEND, { draftId }) as Promise<boolean>,
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
  listContactIdentities: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_LIST, { workspaceId }) as Promise<
      ContactIdentity[]
    >,
  searchIdentityLinkTargets: (workspaceId: string, query: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_SEARCH, {
      workspaceId,
      query,
      limit,
    }) as Promise<ContactIdentitySearchResult[]>,
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
    ipcRenderer.invoke(
      IPC_CHANNELS.MAILBOX_IDENTITY_LINK,
      input,
    ) as Promise<ContactIdentity | null>,
  listIdentityCandidates: (workspaceId?: string, status?: ContactIdentityCandidate["status"]) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_CANDIDATES, {
      workspaceId,
      status,
    }) as Promise<ContactIdentityCandidate[]>,
  confirmIdentityLink: (candidateId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_CONFIRM, {
      candidateId,
    }) as Promise<ContactIdentityCandidate | null>,
  rejectIdentityLink: (candidateId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_REJECT, {
      candidateId,
    }) as Promise<ContactIdentityCandidate | null>,
  unlinkIdentityHandle: (handleId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_UNLINK, { handleId }) as Promise<boolean>,
  getContactIdentityCoverageStats: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_IDENTITY_COVERAGE, {
      workspaceId,
    }) as Promise<ContactIdentityCoverageStats>,
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
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_MC_HANDOFF_PREVIEW, {
      threadId,
    }) as Promise<MailboxMissionControlHandoffPreview | null>,
  createMailboxMissionControlHandoff: (request: MailboxMissionControlHandoffRequest) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MAILBOX_MC_HANDOFF_CREATE,
      request,
    ) as Promise<MailboxMissionControlHandoffRecord>,
  listMailboxMissionControlHandoffs: (threadId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_MC_HANDOFF_LIST, { threadId }) as Promise<
      MailboxMissionControlHandoffRecord[]
    >,
  listMailboxSnippets: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SNIPPETS_LIST) as Promise<MailboxSnippetRecord[]>,
  upsertMailboxSnippet: (input: {
    id?: string;
    shortcut: string;
    body: string;
    subjectHint?: string;
  }) =>
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
  }) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MAILBOX_SAVED_VIEW_CREATE,
      input,
    ) as Promise<MailboxSavedViewRecord>,
  deleteMailboxSavedView: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_SAVED_VIEW_DELETE, { id }) as Promise<boolean>,
  previewMailboxSavedViewSimilar: (input: {
    seedThreadId: string;
    name: string;
    instructions: string;
  }) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MAILBOX_SAVED_VIEW_PREVIEW_SIMILAR,
      input,
    ) as Promise<MailboxSavedViewPreviewResult>,
  getMailboxQuickReplySuggestions: (threadId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_QUICK_REPLY_SUGGESTIONS, {
      threadId,
    }) as Promise<MailboxQuickReplySuggestionsResult>,
  applyMailboxAction: (input: MailboxApplyActionInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_APPLY_ACTION, input),
  updateMailboxCommitmentState: (commitmentId: string, state: MailboxCommitmentState) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_UPDATE_COMMITMENT_STATE, { commitmentId, state }),
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
    ipcRenderer.invoke(IPC_CHANNELS.MAILBOX_RECLASSIFY_THREAD, {
      threadId,
    }) as Promise<MailboxReclassifyResult>,
  reclassifyMailboxAccount: (input: MailboxReclassifyInput) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MAILBOX_RECLASSIFY_ACCOUNT,
      input,
    ) as Promise<MailboxReclassifyResult>,
  onMailboxEvent: (callback: (event: MailboxEvent) => void) => {
    const subscription = (_: Any, data: MailboxEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.MAILBOX_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MAILBOX_EVENT, subscription);
  },

  // Shell APIs
  openExternal: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, url),
  openSystemSettings: (target: "microphone" | "dictation") =>
    ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_OPEN_SETTINGS, target),

  getComposerPrediction: (
    request: import("../shared/composer-predictions").ComposerPredictionRequest,
  ) =>
    ipcRenderer.invoke(COMPOSER_PREDICTION_CHANNEL, request) as Promise<
      import("../shared/composer-predictions").ComposerPrediction | null
    >,
  cancelComposerPrediction: (requestId: string) =>
    ipcRenderer.invoke(COMPOSER_PREDICTION_CANCEL_CHANNEL, requestId) as Promise<void>,
  // Task APIs
  createTask: (data: Any) => ipcRenderer.invoke(IPC_CHANNELS.TASK_CREATE, data),
  getTask: (id: string) => invokeTaskIpcWithRendererTiming(IPC_CHANNELS.TASK_GET, id),
  getSessionProgress: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SESSION_PROGRESS_GET, taskId) as Promise<
      SessionProgressState | undefined
    >,
  getWorkSessionRollout: () => ipcRenderer.invoke(IPC_CHANNELS.WORK_SESSION_ROLLOUT_GET),
  updateWorkSessionRollout: (update: {
    enabled?: boolean;
    cohortPercent?: number;
    salt?: string;
    legacyReadRollback?: boolean;
  }) => ipcRenderer.invoke(IPC_CHANNELS.WORK_SESSION_ROLLOUT_UPDATE, update),
  listWorkSessionMetrics: (options?: {
    sessionId?: string;
    workspaceId?: string;
    name?: string;
    limit?: number;
    since?: number;
  }) => ipcRenderer.invoke(IPC_CHANNELS.WORK_SESSION_METRICS_LIST, options),
  listWorkSessionLeases: (sessionId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORK_SESSION_LEASES_LIST, sessionId),
  getWorkSessionProjection: (request: { sessionId: string; projection?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORK_SESSION_PROJECTION_GET, request),
  evaluateWorkSessionReplay: (request: {
    taskId: string;
    fixtureId?: string;
    assertions?: {
      expectedTerminalStatus?: string;
      mustContainAll?: string[];
      mustCreatePaths?: string[];
    };
  }) => ipcRenderer.invoke(IPC_CHANNELS.WORK_SESSION_REPLAY_EVALUATE, request),
  listTasks: (opts?: {
    limit?: number;
    offset?: number;
    prioritizeSidebar?: boolean;
    includeArchivedSessions?: boolean;
    botConversation?: { workspaceId: string; agentRoleId: string };
    excludeSources?: string[];
    cursor?: {
      id?: string;
      pinned?: boolean;
      status?: string;
      updatedAt?: number;
      createdAt?: number;
    };
  }) => invokeTaskIpcWithRendererTiming(IPC_CHANNELS.TASK_LIST, opts),
  listSidebarTasks: (opts?: {
    limit?: number;
    offset?: number;
    prioritizeSidebar?: boolean;
    includeArchivedSessions?: boolean;
    excludeBotConversations?: boolean;
    excludeSources?: string[];
    workspaceId?: string;
    /** Top-level tasks of archived sessions only, most recently archived first. */
    archivedSessionsOnly?: boolean;
    cursor?: {
      id?: string;
      pinned?: boolean;
      status?: string;
      updatedAt?: number;
      createdAt?: number;
    };
  }) => invokeTaskIpcWithRendererTiming(IPC_CHANNELS.TASK_LIST_SIDEBAR, opts),
  activateBotResponsibility: (
    request: import("../shared/bot-responsibility").BotResponsibilityControl,
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.BOT_RESPONSIBILITY_ACTIVATE,
      request,
    ) as Promise<BotResponsibility>,
  getBotFutureControl: (request: {
    scope: import("../shared/bot-responsibility").BotResponsibilityScope;
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOT_WORK_CONTROL_STATE, request) as Promise<
      import("../shared/bot-work-control").BotFutureControlState
    >,
  stopBotWork: (request: import("../shared/bot-work-control").BotWorkControlRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOT_WORK_STOP, request) as Promise<
      import("../shared/bot-work-control").BotWorkControlReceipt
    >,
  getBotWorkControl: (request: import("../shared/bot-work-control").BotWorkControlRead) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOT_WORK_CONTROL_GET, request) as Promise<
      import("../shared/bot-work-control").BotWorkControlReceipt | null
    >,
  setBotResponsibilityFutureRuns: (
    request: import("../shared/bot-responsibility").BotResponsibilityFutureControl,
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOT_RESPONSIBILITY_FUTURE_RUNS, request) as Promise<
      import("../shared/bot-responsibility").BotResponsibilityFutureReceipt
    >,
  pauseBotResponsibility: (
    request: import("../shared/bot-responsibility").BotResponsibilityControl,
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.BOT_RESPONSIBILITY_PAUSE,
      request,
    ) as Promise<BotResponsibility>,
  runBotResponsibility: (
    request: import("../shared/bot-responsibility").BotResponsibilityRunRequest,
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOT_RESPONSIBILITY_RUN, request) as Promise<
      import("./routines/types").RoutineRun | null
    >,
  listBotResponsibilities: (request: BotResponsibilityScope) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOT_RESPONSIBILITY_LIST, request) as Promise<
      BotResponsibility[]
    >,
  listBotResponsibilityEngines: (request: BotResponsibilityScope) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOT_RESPONSIBILITY_ENGINES, request) as Promise<
      BotResponsibilityEngine[]
    >,
  previewBotResponsibility: (request: BotResponsibilitySave) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.BOT_RESPONSIBILITY_PREVIEW,
      request,
    ) as Promise<BotResponsibilityPreview>,
  createBotResponsibility: (request: BotResponsibilitySave) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.BOT_RESPONSIBILITY_CREATE,
      request,
    ) as Promise<BotResponsibility>,
  reviseBotResponsibility: (request: BotResponsibilityRevise) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.BOT_RESPONSIBILITY_REVISE,
      request,
    ) as Promise<BotResponsibility>,
  retryBotNotification: (request: BotNotificationRetry) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.BOT_NOTIFICATION_RETRY,
      request,
    ) as Promise<BotNotificationReceipt>,
  getBotNotificationRoute: (scope: BotNotificationScope) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.BOT_NOTIFICATION_ROUTE_GET,
      scope,
    ) as Promise<BotNotificationRoute>,
  updateBotNotificationRoute: (request: BotNotificationUpdate) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.BOT_NOTIFICATION_ROUTE_UPDATE,
      request,
    ) as Promise<BotNotificationRoute>,
  listBotNotificationReceipts: (scope: BotNotificationScope) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOT_NOTIFICATION_RECEIPTS, scope) as Promise<
      BotNotificationReceipt[]
    >,
  getBotWorkResult: (request: import("../shared/bot-work-result").BotWorkResultRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOT_WORK_RESULT, request) as Promise<
      import("../shared/bot-work-result").BotWorkResult
    >,
  listBotWork: (query: BotWorkQuery) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOT_WORK_LIST, query) as Promise<BotWorkPage>,
  getBotMetricsSummary: (request: BotOutcomeMetricsRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOT_METRICS_SUMMARY, request) as Promise<BotOutcomeMetrics>,
  getBotCapabilities: (request: BotCapabilitiesRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOT_CAPABILITIES_GET, request) as Promise<BotCapabilitySummary>,
  listBotConversations: (query: BotConversationListQuery) =>
    invokeTaskIpcWithRendererTiming(IPC_CHANNELS.BOT_CONVERSATIONS_LIST, query),
  listBotMessages: (request: import("../shared/bot-messages").BotMessagePageRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOT_MESSAGES_PAGE, request) as Promise<
      import("../shared/bot-messages").BotMessagePage
    >,
  reopenBotConversation: (request: BotConversationReopenRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOT_CONVERSATION_REOPEN, request) as Promise<Task>,
  getComposerDraft: (request: ComposerDraftGetRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPOSER_DRAFT_GET, request) as Promise<ComposerDraft | null>,
  upsertComposerDraft: (draft: ComposerDraft) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPOSER_DRAFT_UPSERT, draft) as Promise<{
      accepted: boolean;
      draft: ComposerDraft | null;
    }>,
  clearComposerDraft: (request: ComposerDraftClearRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPOSER_DRAFT_CLEAR, request) as Promise<{
      cleared: boolean;
      releasedAttachments: number;
    }>,
  rekeyComposerDraft: (request: ComposerDraftRekeyRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPOSER_DRAFT_REKEY, request) as Promise<{
      rekeyed: boolean;
      rekeyedAttachmentCount?: number;
    }>,
  putComposerDraftAttachment: (request: ComposerDraftAttachmentPutRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPOSER_DRAFT_ATTACHMENT_PUT, request),
  resolveComposerDraftAttachment: (request: ComposerDraftAttachmentResolveRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPOSER_DRAFT_ATTACHMENT_RESOLVE, request),
  releaseComposerDraftAttachment: (request: ComposerDraftAttachmentReleaseRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPOSER_DRAFT_ATTACHMENT_RELEASE, request),
  toggleTaskPin: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_PIN, taskId),
  cancelTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_CANCEL, id),
  discardInterruptedTask: (taskId: string, expectedUpdatedAt: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_DISCARD_INTERRUPTED, { taskId, expectedUpdatedAt }),
  wrapUpTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_WRAP_UP, id),
  pauseTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_PAUSE, id),
  resumeTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_RESUME, id),
  forkTaskSession: (data: {
    taskId: string;
    prompt?: string;
    branchLabel?: string;
    fromEventId?: string;
    sideChat?: boolean;
    initialMessage?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.TASK_FORK_SESSION, data),
  listTaskProposals: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_PROPOSAL_LIST, { taskId }),
  startTaskProposal: (proposalId: string, options?: TaskProposalStartOptions) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_PROPOSAL_START, {
      proposalId,
      ...(options ? { options } : {}),
    }),
  startAllTaskProposals: (taskId: string, proposalIds: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_PROPOSAL_START_ALL, { taskId, proposalIds }),
  doTaskProposalHere: (proposalId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_PROPOSAL_DO_HERE, { proposalId }),
  dismissTaskProposal: (proposalId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_PROPOSAL_DISMISS, { proposalId }),
  sendStdin: (taskId: string, input: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_SEND_STDIN, { taskId, input }),
  killCommand: (taskId: string, force?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_KILL_COMMAND, { taskId, force }),
  renameTask: (id: string, title: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_RENAME, { id, title }),
  updateTaskWorkspace: (taskId: string, workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_UPDATE_WORKSPACE, { taskId, workspaceId }),
  setTaskModel: (selection: {
    taskId: string;
    providerType: LLMProviderType;
    modelKey: string;
    reasoningEffort?: LLMReasoningEffort;
  }) => ipcRenderer.invoke(IPC_CHANNELS.TASK_SET_MODEL, selection),
  archiveTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_ARCHIVE, id),
  unarchiveTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_UNARCHIVE, id),
  archiveWorkspaceSessions: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_ARCHIVE_WORKSPACE_SESSIONS, workspaceId),
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
  getTaskEvents: (taskId: string) =>
    invokeTaskIpcWithRendererTiming(IPC_CHANNELS.TASK_EVENTS, taskId),
  getTaskTimelinePage: (request: TaskTimelinePageRequest) =>
    invokeTaskIpcWithRendererTiming<TaskTimelinePageResult>(
      IPC_CHANNELS.TASK_TIMELINE_PAGE,
      request,
    ),
  getTaskEventDetail: (request: TaskEventDetailRequest) =>
    invokeTaskIpcWithRendererTiming<TaskEventDetailResult>(IPC_CHANNELS.TASK_EVENT_DETAIL, request),
  getTaskLearningProgress: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_LEARNING_PROGRESS, taskId) as Promise<
      TaskLearningProgress[]
    >,

  listTaskTraceRuns: (request?: import("../shared/types").ListTaskTraceRunsRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_TRACE_LIST, request) as Promise<TaskTraceRunSummary[]>,
  getTaskTraceRun: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_TRACE_GET, taskId) as Promise<
      TaskTraceRunDetail | undefined
    >,

  getQueuedTaskInputs: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_QUEUED_INPUTS, taskId) as Promise<
      import("../shared/queued-task-input").QueuedTaskInput[]
    >,
  editQueuedTaskInput: (input: import("../shared/queued-task-input").EditQueuedTaskInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_EDIT_QUEUED_INPUT, input) as Promise<
      import("../shared/queued-task-input").QueuedTaskInput
    >,

  // Send follow-up message to a task (optionally with image attachments)
  sendMessage: (
    taskId: string,
    message: string,
    images?: ImageAttachment[],
    quotedAssistantMessage?: QuotedAssistantMessage,
    options?: {
      expectedTurnId?: string;
      interactionMode?: import("../shared/interaction-mode").InteractionModeSelection;
      deliveryMode?: "message" | "follow_up";
      returnOnAccepted?: boolean;
      messageId?: string;
      permissionMode?: PermissionMode;
      shellAccess?: boolean;
      accessProfileId?: AccessProfileId;
      integrationMentions?: IntegrationMentionSelection[];
      surfaceOrigin?: MessageSurfaceOrigin;
    },
  ) => {
    const validatedImages = validateSendMessageAttachments(images);
    return ipcRenderer.invoke(IPC_CHANNELS.TASK_SEND_MESSAGE, {
      taskId,
      message,
      images: validatedImages,
      quotedAssistantMessage,
      ...(options?.expectedTurnId ? { expectedTurnId: options.expectedTurnId } : {}),
      ...(options?.interactionMode ? { interactionMode: options.interactionMode } : {}),
      ...(options?.deliveryMode ? { deliveryMode: options.deliveryMode } : {}),
      ...(options?.returnOnAccepted ? { returnOnAccepted: true } : {}),
      ...(options?.messageId ? { messageId: options.messageId } : {}),
      ...(options?.permissionMode ? { permissionMode: options.permissionMode } : {}),
      ...(options?.shellAccess !== undefined ? { shellAccess: options.shellAccess } : {}),
      ...(options?.accessProfileId ? { accessProfileId: options.accessProfileId } : {}),
      ...(options && Object.prototype.hasOwnProperty.call(options, "integrationMentions")
        ? { integrationMentions: options.integrationMentions ?? [] }
        : {}),
      ...(options?.surfaceOrigin ? { surfaceOrigin: options.surfaceOrigin } : {}),
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
  removeWorkspace: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_REMOVE, id),
  updateWorkspacePermissions: (
    id: string,
    permissions: {
      network?: boolean;
      read?: boolean;
      write?: boolean;
      delete?: boolean;
      sandboxType?: SandboxType;
      spaceConfig?: SpaceSandboxConfig;
    },
  ) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_UPDATE_PERMISSIONS, id, permissions),

  // Approval APIs
  getInputRequestDraftReview: (inputRequestId: string, taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.INPUT_REQUEST_DRAFT_REVIEW, {
      inputRequestId,
      taskId,
    }) as Promise<InlineApprovalDraftReview | undefined>,
  getApprovalDraftPreview: (approval: ApprovalRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.APPROVAL_DRAFT_PREVIEW, approval) as Promise<
      ApprovalDraftPreview[]
    >,
  respondToApproval: (data: ApprovalResponse) =>
    ipcRenderer.invoke(IPC_CHANNELS.APPROVAL_RESPOND, data) as Promise<ApprovalResponseStatus>,
  listRecurringApprovalRules: (workspaceId?: string, includeRevoked = false) =>
    ipcRenderer.invoke(IPC_CHANNELS.RECURRING_APPROVAL_LIST, {
      workspaceId,
      includeRevoked,
    }) as Promise<RecurringApprovalRuleSummary[]>,
  revokeRecurringApprovalRule: (ruleId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.RECURRING_APPROVAL_REVOKE, ruleId) as Promise<boolean>,
  createProtectedCredentialRequest: (request: {
    taskId?: string;
    name: string;
    destinationAllowlist: string[];
    expiresAt?: number;
  }) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PROTECTED_CREDENTIAL_REQUEST_CREATE,
      request,
    ) as Promise<ProtectedCredentialRequestSummary>,
  listProtectedCredentialRequests: (options?: { taskId?: string; includeResolved?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROTECTED_CREDENTIAL_REQUEST_LIST, options) as Promise<
      ProtectedCredentialRequestSummary[]
    >,
  fulfillProtectedCredentialRequest: (requestId: string, value: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROTECTED_CREDENTIAL_REQUEST_FULFILL, {
      requestId,
      value,
    }) as Promise<ProtectedCredentialSummary>,
  denyProtectedCredentialRequest: (requestId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.PROTECTED_CREDENTIAL_REQUEST_DENY,
      requestId,
    ) as Promise<boolean>,
  listProtectedCredentials: () =>
    ipcRenderer.invoke(IPC_CHANNELS.PROTECTED_CREDENTIAL_LIST) as Promise<
      ProtectedCredentialSummary[]
    >,
  revokeProtectedCredential: (credentialId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PROTECTED_CREDENTIAL_REVOKE, credentialId) as Promise<boolean>,
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

  // Agents Hub APIs
  listManagedAgents: (params?: {
    limit?: number;
    offset?: number;
    status?: ManagedAgent["status"];
  }) => ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_LIST_IPC, params) as Promise<ManagedAgent[]>,
  getManagedAgent: (agentId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_GET_IPC, agentId) as Promise<{
      agent: ManagedAgent;
      currentVersion?: ManagedAgentVersion;
    } | null>,
  getManagedAgentRuntimeToolCatalog: (agentId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MANAGED_AGENT_RUNTIME_TOOL_CATALOG_IPC,
      agentId,
    ) as Promise<ManagedAgentRuntimeToolCatalog>,
  generateManagedAgentPlan: (request: AgentBuilderPlanRequest) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MANAGED_AGENT_GENERATE_PLAN_IPC,
      request,
    ) as Promise<AgentBuilderPlan>,
  createManagedAgentFromPlan: (request: AgentBuilderCreateRequest) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MANAGED_AGENT_CREATE_FROM_PLAN_IPC,
      request,
    ) as Promise<AgentBuilderCreateResult>,
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
    ipcRenderer.invoke(
      IPC_CHANNELS.MANAGED_AGENT_ARCHIVE_IPC,
      agentId,
    ) as Promise<ManagedAgent | null>,
  publishManagedAgent: (agentId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MANAGED_AGENT_PUBLISH_IPC,
      agentId,
    ) as Promise<ManagedAgent | null>,
  suspendManagedAgent: (agentId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MANAGED_AGENT_SUSPEND_IPC,
      agentId,
    ) as Promise<ManagedAgent | null>,
  listManagedAgentRoutines: (agentId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_ROUTINE_LIST_IPC, agentId) as Promise<
      ManagedAgentRoutineRecord[]
    >,
  createManagedAgentRoutine: (request: CreateManagedAgentRoutineRequest) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MANAGED_AGENT_ROUTINE_CREATE_IPC,
      request,
    ) as Promise<ManagedAgentRoutineRecord>,
  updateManagedAgentRoutine: (request: UpdateManagedAgentRoutineRequest) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MANAGED_AGENT_ROUTINE_UPDATE_IPC,
      request,
    ) as Promise<ManagedAgentRoutineRecord>,
  deleteManagedAgentRoutine: (agentId: string, routineId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_ROUTINE_DELETE_IPC, {
      agentId,
      routineId,
    }) as Promise<boolean>,
  getManagedAgentInsights: (agentId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MANAGED_AGENT_INSIGHTS_GET_IPC,
      agentId,
    ) as Promise<ManagedAgentInsights>,
  listManagedAgentAuditEntries: (agentId: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_AGENT_AUDIT_LIST_IPC, {
      agentId,
      limit,
    }) as Promise<ManagedAgentAuditEntry[]>,
  getManagedAgentSlackDeploymentHealth: (agentId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MANAGED_AGENT_SLACK_HEALTH_GET_IPC,
      agentId,
    ) as Promise<ManagedAgentSlackDeploymentHealth>,
  convertAgentRoleToManagedAgent: (request: ConvertAgentRoleToManagedAgentRequest) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MANAGED_AGENT_CONVERT_ROLE_IPC,
      request,
    ) as Promise<ManagedAgentConversionResult>,
  convertAutomationProfileToManagedAgent: (
    request: ConvertAutomationProfileToManagedAgentRequest,
  ) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MANAGED_AGENT_CONVERT_AUTOMATION_IPC,
      request,
    ) as Promise<ManagedAgentConversionResult>,
  listManagedEnvironments: (params?: {
    limit?: number;
    offset?: number;
    status?: ManagedEnvironment["status"];
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_ENVIRONMENT_LIST_IPC, params) as Promise<
      ManagedEnvironment[]
    >,
  createManagedEnvironment: (request: {
    name: string;
    kind?: ManagedEnvironment["kind"];
    config: ManagedEnvironment["config"];
  }) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MANAGED_ENVIRONMENT_CREATE_IPC,
      request,
    ) as Promise<ManagedEnvironment>,
  updateManagedEnvironment: (request: {
    environmentId: string;
    name?: string;
    config?: Partial<ManagedEnvironment["config"]>;
  }) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MANAGED_ENVIRONMENT_UPDATE_IPC,
      request,
    ) as Promise<ManagedEnvironment | null>,
  archiveManagedEnvironment: (environmentId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MANAGED_ENVIRONMENT_ARCHIVE_IPC,
      environmentId,
    ) as Promise<ManagedEnvironment | null>,
  listManagedSessions: (params?: {
    limit?: number;
    offset?: number;
    agentId?: string;
    workspaceId?: string;
    status?: ManagedSession["status"];
    surface?: ManagedSession["surface"];
  }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_SESSION_LIST_IPC, params) as Promise<ManagedSession[]>,
  getManagedSession: (sessionId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MANAGED_SESSION_GET_IPC,
      sessionId,
    ) as Promise<ManagedSession | null>,
  createManagedSession: (request: ManagedSessionCreateInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_SESSION_CREATE_IPC, request) as Promise<ManagedSession>,
  sendManagedSessionUserMessage: (request: ManagedSessionUserMessageRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_SESSION_SEND_USER_MESSAGE_IPC, request) as Promise<
      ManagedSession | undefined
    >,
  correctManagedSessionRequirement: (request: ManagedSessionRequirementCorrectionRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_SESSION_CORRECT_REQUIREMENT_IPC, request) as Promise<
      ManagedSession | undefined
    >,
  resumeManagedSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_SESSION_RESUME_IPC, sessionId) as Promise<{
      resumed: boolean;
      session?: ManagedSession;
    }>,
  cancelManagedSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_SESSION_CANCEL_IPC, sessionId) as Promise<
      ManagedSession | undefined
    >,
  exportSessionHandoff: (request: { sessionId?: string; taskId?: string }) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.SESSION_HANDOFF_EXPORT_IPC,
      request,
    ) as Promise<SessionHandoffExportResult>,
  getSessionMembers: (request: SessionMembersRequest) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.SESSION_MEMBERS_GET_IPC,
      request,
    ) as Promise<SessionShareSnapshot>,
  createSessionInvite: (request: SessionInviteCreateInput) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.SESSION_INVITE_CREATE_IPC,
      request,
    ) as Promise<SessionInviteCreateResult>,
  acceptSessionInvite: (request: SessionInviteAcceptInput) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.SESSION_INVITE_ACCEPT_IPC,
      request,
    ) as Promise<SessionInviteAcceptResult>,
  updateSessionMember: (request: SessionMemberUpdateInput) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.SESSION_MEMBER_UPDATE_IPC,
      request,
    ) as Promise<SessionHumanMember>,
  listManagedSessionEvents: (sessionId: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MANAGED_SESSION_EVENTS_LIST_IPC, {
      sessionId,
      limit,
    }) as Promise<ManagedSessionEvent[]>,
  getManagedSessionWorkpaper: (sessionId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MANAGED_SESSION_WORKPAPER_GET_IPC,
      sessionId,
    ) as Promise<ManagedSessionWorkpaper>,
  listAgentTemplates: () =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_TEMPLATE_LIST) as Promise<AgentTemplate[]>,
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
    ipcRenderer.invoke(
      IPC_CHANNELS.IMAGE_GEN_PROFILE_UPDATE,
      request,
    ) as Promise<ImageGenProfile | null>,
  deleteImageGenProfile: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMAGE_GEN_PROFILE_DELETE, id) as Promise<boolean>,

  // Skill APIs
  listSkills: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_LIST),
  getSkill: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_GET, id),

  // LLM Settings APIs
  getLLMSettings: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_SETTINGS),
  saveLLMSettings: (settings: Any) => ipcRenderer.invoke(IPC_CHANNELS.LLM_SAVE_SETTINGS, settings),
  resetLLMProviderCredentials: (providerType: LLMProviderType) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_RESET_PROVIDER_CREDENTIALS, providerType),
  testLLMProvider: (config: Any) => ipcRenderer.invoke(IPC_CHANNELS.LLM_TEST_PROVIDER, config),
  testJevProvider: (config: JevTestProviderRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.JEV_TEST_PROVIDER, config),
  getLLMModels: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_MODELS),
  getLLMConfigStatus: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_CONFIG_STATUS),
  getTaskCostEstimate: (modelId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_TASK_COST_ESTIMATE, modelId) as Promise<{
      modelId: string;
      sampleSize: number;
      medianCost: number;
      p90Cost: number;
    } | null>,
  setLLMModel: (
    selection:
      | string
      | {
          providerType?: LLMProviderType;
          modelKey: string;
          reasoningEffort?: LLMReasoningEffort;
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
  discoverAtomicChatModels: (overrides?: { apiKey?: string; baseUrl?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_DISCOVER_ATOMIC_CHAT_MODELS, overrides),
  getOllamaModels: (baseUrl?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_OLLAMA_MODELS, baseUrl),
  getGeminiModels: (apiKey?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_GEMINI_MODELS, apiKey),
  getOpenRouterModels: (apiKey?: string, baseUrl?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_OPENROUTER_MODELS, apiKey, baseUrl),
  getOpenRouterImageModels: (apiKey?: string, baseUrl?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_OPENROUTER_IMAGE_MODELS, apiKey, baseUrl),
  getOpenAIModels: (apiKey?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_OPENAI_MODELS, apiKey),
  getGroqModels: (apiKey?: string, baseUrl?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_GROQ_MODELS, apiKey, baseUrl),
  getXAIModels: (apiKey?: string, baseUrl?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_XAI_MODELS, apiKey, baseUrl),
  xaiOAuthStart: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_XAI_OAUTH_START),
  xaiOAuthLogout: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_XAI_OAUTH_LOGOUT),
  openrouterOAuthStart: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_OPENROUTER_OAUTH_START),
  getDeepSeekModels: (apiKey?: string, baseUrl?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_DEEPSEEK_MODELS, apiKey, baseUrl),
  getKimiModels: (apiKey?: string, baseUrl?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_KIMI_MODELS, apiKey, baseUrl),
  getPiModels: (piProvider?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_PI_MODELS, piProvider),
  getPiProviders: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_PI_PROVIDERS),
  getOpenAICompatibleModels: (
    baseUrl: string,
    apiKey?: string,
    options?: { cacheModels?: boolean },
  ) => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_OPENAI_COMPATIBLE_MODELS, baseUrl, apiKey, options),
  // Local AI (MLX-LM + hf-agents + llama.cpp)
  checkHf: () => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_AI_CHECK_HF),
  detectHardware: () => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_AI_DETECT_HARDWARE),
  startLocalAIServer: (model?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LOCAL_AI_START_SERVER, model),
  stopLocalAIServer: () => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_AI_STOP_SERVER),
  getLocalAIServerStatus: () => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_AI_GET_SERVER_STATUS),
  getLocalAIServerLog: () => ipcRenderer.invoke(IPC_CHANNELS.LOCAL_AI_GET_SERVER_LOG),
  openaiOAuthStart: (options?: { persist?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_OPENAI_OAUTH_START, options),
  openaiOAuthLogout: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_OPENAI_OAUTH_LOGOUT),
  openaiSiwcStart: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_OPENAI_SIWC_START),
  getBedrockModels: (config?: {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    profile?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_BEDROCK_MODELS, config),

  // Gateway / Channel APIs
  getGatewayChannels: () => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_GET_CHANNELS),
  listIntegrationMentionOptions: () =>
    ipcRenderer.invoke(IPC_CHANNELS.INTEGRATION_MENTION_OPTIONS) as Promise<
      IntegrationMentionOption[]
    >,
  addGatewayChannel: (data: AddChannelRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_ADD_CHANNEL, data),
  updateGatewayChannel: (data: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_UPDATE_CHANNEL, data),
  removeGatewayChannel: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_REMOVE_CHANNEL, id),
  enableGatewayChannel: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_ENABLE_CHANNEL, id),
  disableGatewayChannel: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_DISABLE_CHANNEL, id),
  testGatewayChannel: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_TEST_CHANNEL, id),
  getGatewayChannelHealth: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_GET_CHANNEL_HEALTH, id),
  getTeamsMeetingSettings: () => ipcRenderer.invoke(IPC_CHANNELS.MEETINGS_TEAMS_GET_SETTINGS),
  getTeamsMeetingStatus: () => ipcRenderer.invoke(IPC_CHANNELS.MEETINGS_TEAMS_GET_STATUS),
  updateTeamsMeetingSettings: (update: TeamsMeetingSettingsUpdate) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEETINGS_TEAMS_UPDATE_SETTINGS, update),
  connectTeamsMeetings: (data: { clientId: string; tenant?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEETINGS_TEAMS_CONNECT, data),
  disconnectTeamsMeetings: () => ipcRenderer.invoke(IPC_CHANNELS.MEETINGS_TEAMS_DISCONNECT),
  syncTeamsMeetingsNow: () => ipcRenderer.invoke(IPC_CHANNELS.MEETINGS_TEAMS_SYNC_NOW),
  retryFailedTeamsMeetings: () => ipcRenderer.invoke(IPC_CHANNELS.MEETINGS_TEAMS_RETRY_FAILED),
  listMeetingArtifacts: (options?: { provider?: MeetingArtifactProvider; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEETINGS_LIST_ARTIFACTS, options),
  getMeetingArtifact: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MEETINGS_GET_ARTIFACT, id),
  downloadMeetingRecording: (artifactId: string, recordingId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEETINGS_DOWNLOAD_RECORDING, { artifactId, recordingId }),
  revealMeetingArtifact: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEETINGS_REVEAL_ARTIFACT, id),
  onMeetingArtifactsChanged: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on(IPC_CHANNELS.MEETINGS_CHANGED, listener);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MEETINGS_CHANGED, listener);
  },
  getGatewayUsers: (channelId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_GET_USERS, channelId),
  getGatewayChats: (channelId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_LIST_CHATS, channelId) as Promise<
      Array<{ chatId: string; lastTimestamp: number }>
    >,
  sendGatewayTestMessage: (data: { channelType: string; channelDbId?: string; chatId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_SEND_TEST_MESSAGE, data) as Promise<{ ok: boolean }>,
  grantGatewayAccess: (
    channelId: string,
    userId: string,
    displayName?: string,
    contextType?: ContextTypeValue | "both",
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_GRANT_ACCESS, {
      channelId,
      userId,
      displayName,
      contextType,
    }),
  revokeGatewayAccess: (
    channelId: string,
    userId: string,
    contextType?: ContextTypeValue | "both",
  ) => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_REVOKE_ACCESS, { channelId, userId, contextType }),
  generateGatewayPairing: (
    channelId: string,
    userId: string,
    displayName?: string,
    contextType?: ContextTypeValue,
  ) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_GENERATE_PAIRING, {
      channelId,
      userId,
      displayName,
      contextType,
    }),

  // Gateway event listener
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
    return () => ipcRenderer.removeListener("whatsapp:qr-code", callback);
  },
  onWhatsAppConnected: (callback: () => void) => {
    ipcRenderer.on("whatsapp:connected", callback);
    return () => ipcRenderer.removeListener("whatsapp:connected", callback);
  },
  onWhatsAppStatus: (callback: (event: Any, data: { status: string; error?: string }) => void) => {
    ipcRenderer.on("whatsapp:status", callback);
    return () => ipcRenderer.removeListener("whatsapp:status", callback);
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
  getBoxBrainStatus: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOX_BRAIN_GET_STATUS, workspaceId) as Promise<BoxBrainStatus>,
  syncBoxBrainNow: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.BOX_BRAIN_SYNC_NOW, workspaceId) as Promise<BoxBrainSyncResult>,

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
  updateAgentMailInbox: (payload: { workspaceId: string; inboxId: string; displayName: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENTMAIL_UPDATE_INBOX, payload),
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

  // App Update APIs
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION),
  checkForUpdates: (intent?: "manual" | "background") =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_CHECK_UPDATES, intent),
  downloadUpdate: (updateInfo: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_DOWNLOAD_UPDATE, updateInfo),
  installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.APP_INSTALL_UPDATE),
  cancelUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.APP_CANCEL_UPDATE),
  openUpdateWindow: () => ipcRenderer.invoke(IPC_CHANNELS.APP_OPEN_UPDATE_WINDOW),
  getUpdatePreferences: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_UPDATE_PREFERENCES),
  setUpdatePreferences: (patch: { autoDownload?: boolean; skippedVersion?: string | null }) =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_SET_UPDATE_PREFERENCES, patch),

  // CoWork Pulse APIs
  getPulseSettings: () => ipcRenderer.invoke(IPC_CHANNELS.PULSE_GET_SETTINGS),
  setPulseEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.PULSE_SET_ENABLED, enabled),
  resetPulseIdentity: () => ipcRenderer.invoke(IPC_CHANNELS.PULSE_RESET_IDENTITY),
  deletePulseRemoteData: () => ipcRenderer.invoke(IPC_CHANNELS.PULSE_DELETE_REMOTE_DATA),
  flushPulse: () => ipcRenderer.invoke(IPC_CHANNELS.PULSE_FLUSH),

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
  getPermissionRuntimeInfo: () => ipcRenderer.invoke(IPC_CHANNELS.PERMISSIONS_GET_RUNTIME_INFO),
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
  logRendererPerf: (payload: unknown) =>
    ipcRenderer.invoke(IPC_CHANNELS.RENDERER_PERF_LOG, payload),

  // Personality Settings APIs
  getPersonalitySettings: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_GET_SETTINGS),
  savePersonalitySettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_SAVE_SETTINGS, settings),
  getPersonaDefinitions: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_GET_PERSONAS),
  getRelationshipStats: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_GET_RELATIONSHIP_STATS),
  getPersonalityConfigV2: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_GET_CONFIG_V2),
  savePersonalityConfigV2: (config: Any, options?: { responseStyleBaseline?: object | null }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_SAVE_CONFIG_V2, config, options),
  exportPersonalityProfile: (format?: "json" | "md") =>
    ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_EXPORT, format),
  importPersonalityProfile: (data: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_IMPORT, data),
  getPersonalityPreview: (draft: Any, contextMode?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_PREVIEW, draft, contextMode),
  getPersonalityTraitPresets: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_GET_TRAIT_PRESETS),
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
  getWatchdogSettings: () => ipcRenderer.invoke(IPC_CHANNELS.WATCHDOG_GET_SETTINGS),
  saveWatchdogSettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.WATCHDOG_SAVE_SETTINGS, settings),
  onQueueUpdate: (callback: (status: Any) => void) => {
    const subscription = (_: Any, data: Any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.QUEUE_UPDATE, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.QUEUE_UPDATE, subscription);
  },

  // Custom Skills APIs
  listCustomSkills: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_LIST),
  listTaskSkills: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_LIST_TASKS),
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
  installSkillFromRegistry: (skillId: string, version?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_INSTALL, skillId, version),
  installSkillFromClawHub: (identifierOrUrl: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_INSTALL_CLAWHUB, identifierOrUrl),
  installSkillFromUrl: (url: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_INSTALL_URL, url),
  installSkillFromGit: (gitUrl: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_INSTALL_GIT, gitUrl),
  uninstallSkill: (skillId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_UNINSTALL, skillId),
  getSkillStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_GET_STATUS),

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
      | "box"
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
    prompt?: "select_account" | "consent";
  }) => ipcRenderer.invoke(IPC_CHANNELS.MCP_CONNECTOR_OAUTH_START, payload),
  addRemoteOAuthMCPServer: (payload: RemoteOAuthServerRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_ADD_REMOTE_OAUTH_SERVER, payload),
  updateRemoteOAuthMCPServer: (payload: RemoteOAuthServerUpdateRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_UPDATE_REMOTE_OAUTH_SERVER, payload) as Promise<{
      id: string;
      name: string;
      signedOut: boolean;
    }>,
  discoverMCPOAuth: (url: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_OAUTH_DISCOVER, url),
  authorizeMCPServer: (serverId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MCP_OAUTH_AUTHORIZE,
      serverId,
    ) as Promise<RemoteOAuthAuthorizeResult>,
  cancelMCPOAuth: (serverId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_OAUTH_CANCEL, serverId) as Promise<{ cancelled: boolean }>,

  // Workday agent setup (admin API client on a Workday preset server)
  saveWorkdayAdminConnection: (payload: WorkdayAdminConnectionRequest) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.WORKDAY_AGENT_ADMIN_SAVE_CONNECTION,
      payload,
    ) as Promise<WorkdayAdminConnectionSummary>,
  signInWorkdayAdmin: (serverId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.WORKDAY_AGENT_ADMIN_SIGN_IN,
      serverId,
    ) as Promise<WorkdayAdminSignInResult>,
  cancelWorkdayAdminSignIn: (serverId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKDAY_AGENT_ADMIN_CANCEL, serverId) as Promise<{
      cancelled: boolean;
    }>,
  listWorkdayAgents: (serverId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.WORKDAY_AGENT_LIST,
      serverId,
    ) as Promise<WorkdayAgentListResult>,
  searchWorkdayAgentResources: (payload: WorkdayAgentSearchRequest) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.WORKDAY_AGENT_SEARCH,
      payload,
    ) as Promise<WorkdayAgentSearchResult>,
  saveWorkdayAgent: (payload: WorkdayAgentSaveRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKDAY_AGENT_SAVE, payload) as Promise<WorkdayAgentSaveResult>,

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

  // Secure MCP Tunnel APIs
  getSecureMcpTunnelSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SECURE_MCP_TUNNELS_GET_SETTINGS),
  createSecureMcpTunnel: (input: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.SECURE_MCP_TUNNELS_CREATE, input),
  updateSecureMcpTunnel: (id: string, updates: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.SECURE_MCP_TUNNELS_UPDATE, id, updates),
  deleteSecureMcpTunnel: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SECURE_MCP_TUNNELS_DELETE, id),
  startSecureMcpTunnel: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SECURE_MCP_TUNNELS_START, id),
  stopSecureMcpTunnel: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.SECURE_MCP_TUNNELS_STOP, id),
  getSecureMcpTunnelStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SECURE_MCP_TUNNELS_GET_STATUS),
  getSecureMcpTunnelAudit: (id?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SECURE_MCP_TUNNELS_GET_AUDIT, id),
  onSecureMcpTunnelStatusChange: (callback: (status: Any[]) => void) => {
    const subscription = (_: Any, data: Any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SECURE_MCP_TUNNELS_STATUS_CHANGE, subscription);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.SECURE_MCP_TUNNELS_STATUS_CHANGE, subscription);
  },

  // Built-in Tools Settings APIs
  getBuiltinToolsSettings: () => ipcRenderer.invoke(IPC_CHANNELS.BUILTIN_TOOLS_GET_SETTINGS),
  saveBuiltinToolsSettings: (settings: BuiltinToolsSettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.BUILTIN_TOOLS_SAVE_SETTINGS, settings),
  getBuiltinToolsCategories: () => ipcRenderer.invoke(IPC_CHANNELS.BUILTIN_TOOLS_GET_CATEGORIES),
  getChronicleSettings: () => ipcRenderer.invoke(IPC_CHANNELS.CHRONICLE_GET_SETTINGS),
  saveChronicleSettings: (settings: Partial<ChronicleSettings>) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHRONICLE_SAVE_SETTINGS, settings),
  getChronicleStatus: () => ipcRenderer.invoke(IPC_CHANNELS.CHRONICLE_GET_STATUS),
  listChronicleObservations: (input: { workspaceId: string; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHRONICLE_LIST_OBSERVATIONS, input),
  deleteChronicleObservation: (input: { workspaceId: string; observationId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHRONICLE_DELETE_OBSERVATION, input),
  clearChronicleObservations: (input: { workspaceId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHRONICLE_CLEAR_OBSERVATIONS, input),

  computerEnvironmentAction: (taskId: string, action: "status" | "reconcile" | "finish") =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_ENVIRONMENT_ACTION, taskId, action),
  getComputerUseStatus: () => ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_USE_GET_STATUS),
  getCuaSpaceSettings: () => ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_USE_GET_CUA_SPACE_SETTINGS),
  saveCuaSpaceSettings: (update: CuaSpaceSettingsUpdate) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_USE_SAVE_CUA_SPACE_SETTINGS, update),
  testCuaSpaceConnection: () => ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_USE_TEST_CUA_SPACE),
  getAndroidPhoneStatus: () => ipcRenderer.invoke("androidPhone:status"),
  saveAndroidPhoneSettings: (settings: AndroidPhoneSettings) =>
    ipcRenderer.invoke("androidPhone:settings", settings),
  installAndroidPhoneRuntime: () => ipcRenderer.invoke("androidPhone:install"),
  stopAndroidPhone: () => ipcRenderer.invoke("androidPhone:stop"),
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
  watchComputerView: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_VIEW_WATCH, taskId),
  unwatchComputerView: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_VIEW_UNWATCH, taskId),
  takeOverComputer: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_VIEW_TAKE_OVER, taskId),
  handBackComputer: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_VIEW_HAND_BACK, taskId),
  openBotDesktop: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_VIEW_OPEN_DESKTOP, taskId),
  stopBotDesktop: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_VIEW_STOP_DESKTOP, taskId),
  listBotDesktopFiles: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_VIEW_DESKTOP_FILES, taskId),
  revealBotDesktopFile: (taskId: string, filePath: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_VIEW_REVEAL_DESKTOP_FILE, taskId, filePath),
  startTeachingTask: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_VIEW_START_RECORDING, taskId),
  finishTeachingTask: (taskId: string, name: string | null) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_VIEW_FINISH_RECORDING, taskId, name),
  listTaughtTasks: (taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_VIEW_TAUGHT_TASKS, taskId),
  deleteTaughtTask: (taskId: string, taughtTaskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPUTER_VIEW_DELETE_TAUGHT_TASK, taskId, taughtTaskId),
  onComputerViewEvent: (callback: (state: ComputerViewState) => void) => {
    const channel = IPC_CHANNELS.COMPUTER_VIEW_EVENT;
    const listener = (_e: Any, payload: ComputerViewState) => callback(payload);
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
  onNavigateToBotConversation: (
    callback: (payload: { botId: string; conversationId?: string }) => void,
  ) => {
    const subscription = (_: Any, payload: { botId: string; conversationId?: string }) =>
      callback(payload);
    ipcRenderer.on(IPC_CHANNELS.NAVIGATE_TO_BOT_CONVERSATION, subscription);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.NAVIGATE_TO_BOT_CONVERSATION, subscription);
  },

  // Hooks (Webhooks & Gmail Pub/Sub) APIs
  getHooksSettings: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_GET_SETTINGS),
  saveHooksSettings: (settings: Partial<HooksSettings>) =>
    ipcRenderer.invoke(IPC_CHANNELS.HOOKS_SAVE_SETTINGS, settings),
  enableHooks: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_ENABLE),
  disableHooks: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_DISABLE),
  regenerateHookToken: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_REGENERATE_TOKEN),
  getHooksStatus: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_GET_STATUS),
  configureGmailHooks: (config: GmailHooksConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.HOOKS_CONFIGURE_GMAIL, config),
  getGmailHooksStatus: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_GET_GMAIL_STATUS),
  startGmailWatcher: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_START_GMAIL_WATCHER),
  stopGmailWatcher: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_STOP_GMAIL_WATCHER),

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

  // Tailscale
  checkTailscaleAvailability: () => ipcRenderer.invoke(IPC_CHANNELS.TAILSCALE_CHECK_AVAILABILITY),
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
  testSSHTunnelConnection: (config: SSHTunnelConfig) =>
    ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_TEST_CONNECTION, config),

  // Device Fleet
  listManagedDevices: () => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_LIST_MANAGED),
  getDeviceSummary: (deviceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DEVICE_GET_SUMMARY, deviceId),
  connectDevice: (deviceId: string) => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_CONNECT, deviceId),
  disconnectDevice: (deviceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DEVICE_DISCONNECT, deviceId),
  deviceProxyRequest: (request: DeviceProxyRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.DEVICE_PROXY_REQUEST, request),

  // Live Canvas APIs
  canvasGetSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_GET_SESSION, sessionId),
  canvasListSessions: (taskId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_LIST_SESSIONS, taskId),
  canvasShow: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.CANVAS_SHOW, sessionId),
  canvasClose: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.CANVAS_CLOSE, sessionId),
  canvasSnapshot: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_SNAPSHOT, sessionId),
  canvasExportHTML: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_EXPORT_HTML, sessionId),
  canvasExportToFolder: (data: { sessionId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_EXPORT_TO_FOLDER, data),
  canvasOpenInBrowser: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_OPEN_IN_BROWSER, sessionId),
  canvasGetSessionDir: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_GET_SESSION_DIR, sessionId),
  onCanvasEvent: (callback: (event: CanvasEvent) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: CanvasEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.CANVAS_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CANVAS_EVENT, subscription);
  },

  // Device Management APIs
  deviceListTasks: (nodeId: string) => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_LIST_TASKS, nodeId),
  deviceListFiles: (params: { nodeId: string; workspaceId: string; path?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.DEVICE_LIST_FILES, params),
  deviceListRemoteWorkspaces: (nodeId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.DEVICE_LIST_REMOTE_WORKSPACES, nodeId),
  deviceAssignTask: (params: {
    nodeId: string;
    prompt: string;
    workspaceId?: string;
    agentConfig?: Any;
    accessProfileId?: string;
    shellAccess?: boolean;
  }) => ipcRenderer.invoke(IPC_CHANNELS.DEVICE_ASSIGN_TASK, params),

  // Memory System APIs
  getMemorySettings: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_SETTINGS, workspaceId),
  saveMemorySettings: (data: { workspaceId: string; settings: Partial<MemorySettings> }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_SAVE_SETTINGS, data),
  getMemoryTimeline: (data: { workspaceId: string; memoryId: string; windowSize?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_TIMELINE, data),
  getMemoryDetails: (data: { workspaceId: string; ids: string[] }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_DETAILS, data),
  searchMemoryObservations: (data: MemoryObservationSearchQuery) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_OBSERVATIONS_SEARCH, data),
  getMemoryObservationTimeline: (data: {
    workspaceId: string;
    memoryId?: string;
    query?: string;
    windowSize?: number;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_OBSERVATIONS_TIMELINE, data),
  getMemoryObservationDetails: (data: { workspaceId: string; ids: string[] }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_OBSERVATIONS_DETAILS, data),
  updateMemoryObservation: (data: {
    workspaceId: string;
    memoryId: string;
    patch: Partial<MemoryObservationMetadata>;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_OBSERVATIONS_UPDATE, data),
  deleteMemoryObservation: (data: { workspaceId: string; memoryId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_OBSERVATIONS_DELETE, data),
  redactMemoryObservation: (data: {
    workspaceId: string;
    memoryId: string;
    replacement?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_OBSERVATIONS_REDACT, data),
  promoteMemoryObservation: (data: {
    workspaceId: string;
    memoryId: string;
    target?: "user" | "workspace";
    kind?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_OBSERVATIONS_PROMOTE, data),
  rebuildMemoryObservationMetadata: (data?: { force?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_OBSERVATIONS_REBUILD_METADATA, data),
  getMemoryObservationBackfillStatus: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_OBSERVATIONS_BACKFILL_STATUS),
  getRecentMemories: (data: { workspaceId: string; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_RECENT, data),
  getMemoryStats: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_GET_STATS, workspaceId),
  clearMemory: (workspaceId: string, expectedTaskIds?: string[]) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MEMORY_CLEAR,
      expectedTaskIds ? { workspaceId, expectedTaskIds } : workspaceId,
    ),
  getMemoryClearScope: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CLEAR_SCOPE, workspaceId),
  clearSessionMemory: (workspaceId: string, taskId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_CLEAR_SESSION, { workspaceId, taskId }),

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
  listRelationshipMemory: (data?: {
    layer?: "identity" | "preferences" | "context" | "commitments";
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
  getOpenCommitments: (limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_COMMITMENTS_GET, { limit }),
  getDueSoonCommitments: (windowHours?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_COMMITMENTS_DUE_SOON, { windowHours }),
  // Memory Hub "What CoWork knows" (memory_items)
  listMemoryItems: (data: MemoryHubListRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_ITEMS_LIST, data),
  getMemoryItem: (data: { workspaceId: string; id: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_ITEMS_GET, data),
  getMemoryUsedForTask: (data: { workspaceId: string; taskId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_ITEMS_USED_FOR_TASK, data),
  addMemoryItem: (data: {
    workspaceId: string;
    content: string;
    kind: MemoryHubAddableKind;
    scope: "global" | "workspace";
    pinned?: boolean;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_ITEMS_ADD, data),
  updateMemoryItem: (data: { workspaceId: string; id: string; content: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_ITEMS_UPDATE, data),
  setMemoryItemPinned: (data: { workspaceId: string; id: string; pinned: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_ITEMS_SET_PINNED, data),
  deleteMemoryItem: (data: { workspaceId: string; id: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_ITEMS_DELETE, data),
  getMemoryItemWhy: (data: { workspaceId: string; id: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_ITEMS_WHY, data),
  clearGlobalMemoryItems: (data: { workspaceId: string; confirm: true }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_ITEMS_CLEAR_GLOBAL, data),
  // Memory Hub "Review" (automatic commitment expiries with undo)
  getMemoryReview: (data: { workspaceId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REVIEW_GET, data),
  undoMemoryChange: (data: { workspaceId: string; id: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REVIEW_UNDO, data),
  // Memory Hub "Sources" and "Health" (aggregate counts only)
  getMemorySources: (data: { workspaceId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_HUB_SOURCES, data),
  getMemoryHealth: (data: { workspaceId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_HUB_HEALTH, data),
  // Interactive answer surfaces: saved control values and host-fetched photos
  getAnswerSurfaceState: (data: { taskId: string; keys: string[] }) =>
    ipcRenderer.invoke(IPC_CHANNELS.ANSWER_SURFACE_GET_STATE, data),
  saveAnswerSurfaceState: (data: {
    taskId: string;
    key: string;
    state: Record<string, unknown>;
    summary: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.ANSWER_SURFACE_SAVE_STATE, data),
  resolveAnswerImages: (data: { taskId?: string; requests: AnswerImageRequest[] }) =>
    ipcRenderer.invoke(IPC_CHANNELS.ANSWER_SURFACE_RESOLVE_IMAGES, data),
  registerHtmlSurface: (data: {
    html: string;
    theme: "light" | "dark";
    hostBackground?: string;
    designLanguage: boolean;
  }) => ipcRenderer.invoke(IPC_CHANNELS.ANSWER_SURFACE_REGISTER_HTML, data),
  getAnswerSurfaceLogicRunner: () => ipcRenderer.invoke(IPC_CHANNELS.ANSWER_SURFACE_LOGIC_RUNNER),
  loadAnswerSurfaceData: (data: {
    taskId: string;
    sources: import("../shared/answer-surfaces/data").AnswerSurfaceData;
  }) => ipcRenderer.invoke(IPC_CHANNELS.ANSWER_SURFACE_LOAD_DATA, data),
  // 3D model cards (::model{}) and the Meshy connector's cards and gallery
  readModel3d: (data: { filePath: string; workspacePath?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MODEL3D_READ, data),
  getMeshyStatus: () => ipcRenderer.invoke(IPC_CHANNELS.MESHY_STATUS),
  getMeshyTask: (data: { taskId: string }) => ipcRenderer.invoke(IPC_CHANNELS.MESHY_TASK, data),
  getMeshyFormats: (data: { taskId: string; beside?: string; workspacePath?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MESHY_FORMATS, data),
  saveMeshyFormat: (data: {
    taskId: string;
    format: string;
    beside?: string;
    workspacePath?: string;
    chatTaskId?: string;
    reveal?: boolean;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MESHY_SAVE, data),
  getMeshyActions: (data: { taskId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MESHY_ACTIONS, data),
  getMeshyGallery: (data?: { limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MESHY_GALLERY, data),
  getMeshyImage: (data: { url: string }) => ipcRenderer.invoke(IPC_CHANNELS.MESHY_IMAGE, data),
  revealMeshyModel: (data: { filePath: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MESHY_REVEAL, data),
  // Memory folder: the folder is resolved in main, never sent from here
  getMemoryRepoStatus: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_STATUS),
  openMemoryRepoFolder: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_OPEN_FOLDER),
  compactMemoryRepoHistory: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_COMPACT_HISTORY),
  syncMemoryRepoNow: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_SYNC_NOW),
  getBotMemory: (data: { botId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_BOT_MEMORY, data),
  forgetBotMemoryEntry: (data: { botId: string; ref: string; hash: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_BOT_FORGET, data),
  undoBotMemoryChange: (data: { botId: string; commit: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_BOT_UNDO, data),
  deleteBotMemory: (data: { botId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_BOT_DELETE_MEMORY, data),

  // PACT business agents (docs/pact.md)
  getPactStatus: () => ipcRenderer.invoke(IPC_CHANNELS.PACT_STATUS),
  getPactSettings: () => ipcRenderer.invoke(IPC_CHANNELS.PACT_SETTINGS_GET),
  updatePactSettings: (data: PactSettingsUpdate) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACT_SETTINGS_UPDATE, data),
  setPactSignerCredential: (data: { credential: string | null }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACT_IDENTITY_SET_CREDENTIAL, data),
  createPactDeviceKey: () => ipcRenderer.invoke(IPC_CHANNELS.PACT_IDENTITY_DEVICE_KEY),
  discoverPactBusiness: (data: { domain?: string; cardUrl?: string; refresh?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACT_BUSINESS_DISCOVER, data),
  listPactBusinesses: () => ipcRenderer.invoke(IPC_CHANNELS.PACT_BUSINESS_LIST),
  getPactConversation: (data: { id: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACT_CONVERSATION_GET, data),
  listPactConversations: (data: { businessId?: string; taskId?: string; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACT_CONVERSATION_LIST, data),
  sendPactMessage: (data: PactSendRequestInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACT_CONVERSATION_SEND, data),
  acknowledgePactEvidence: (data: { id: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACT_CONVERSATION_ACKNOWLEDGE_EVIDENCE, data),
  startPactAuthorization: (data: { businessId: string; scopes: string[]; purpose?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACT_AUTHORIZATION_START, data),
  getPactAuthorization: (data: { id: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACT_AUTHORIZATION_GET, data),
  getPactAuthorizationForInput: (data: { inputRequestId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACT_AUTHORIZATION_FOR_INPUT, data),
  listPactAuthorizations: (data: { pendingOnly?: boolean; taskId?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACT_AUTHORIZATION_LIST, data),
  cancelPactAuthorization: (data: { id: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACT_AUTHORIZATION_CANCEL, data),
  openPactSignIn: (data: { id: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACT_AUTHORIZATION_OPEN_SIGN_IN, data),
  listPactGrants: () => ipcRenderer.invoke(IPC_CHANNELS.PACT_GRANT_LIST),
  disconnectPactGrant: (data: { id: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.PACT_GRANT_DISCONNECT, data),
  getPactReceipt: (data: { id: string }) => ipcRenderer.invoke(IPC_CHANNELS.PACT_RECEIPT_GET, data),
  readMemoryRepoLines: (refs: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_READ_LINES, { refs }),
  // Dreams over the memory folder: review, undo and "Dream now"
  getMemoryRepoDreams: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_DREAMS),
  getMemoryRepoDreamDiff: (id: string, part: MemoryRepoDreamPart) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_DREAM_DIFF, { id, part }),
  acceptMemoryRepoDream: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_ACCEPT_DREAM, { id }),
  rejectMemoryRepoDream: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_REJECT_DREAM, { id }),
  undoMemoryRepoDream: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_UNDO_DREAM, { id }),
  dreamMemoryRepoNow: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_DREAM_NOW),
  // Memory Hub "What CoWork knows" over the memory folder.
  getMemoryRepoEntries: (data: { workspaceId: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_ENTRIES, data),
  updateMemoryRepoEntry: (data: { workspaceId: string; ref: string; hash: string; text: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_UPDATE_ENTRY, data),
  removeMemoryRepoEntry: (data: { workspaceId: string; ref: string; hash: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_REMOVE_ENTRY, data),
  pinMemoryRepoEntry: (data: { workspaceId: string; ref: string; hash: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_PIN_ENTRY, data),
  openMemoryRepoFile: (data: { workspaceId: string; path: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_OPEN_FILE, data),
  keepMemoryRepoEntry: (data: {
    workspaceId: string;
    ref: string;
    hash: string;
    target: MemoryRepoKeepTarget;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_KEEP_ENTRY, data),
  // Main opens the folder picker; no path is sent from here.
  importMemoryRepoFolder: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_REPO_IMPORT_FOLDER),
  // Hermes / OpenClaw import: main resolves the home folder; only the source is sent.
  detectAgentImports: () => ipcRenderer.invoke(IPC_CHANNELS.AGENT_IMPORT_DETECT),
  previewAgentImport: (request: { source: AgentImportSource; withSecrets?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_IMPORT_PREVIEW, request),
  applyAgentImport: (request: AgentImportRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_IMPORT_APPLY, request),
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
  // Memory Features APIs
  getMemoryFeaturesSettings: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FEATURES_GET_SETTINGS),
  saveMemoryFeaturesSettings: (settings: MemoryFeaturesSettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FEATURES_SAVE_SETTINGS, settings),
  getMemoryLayerPreview: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FEATURES_GET_LAYER_PREVIEW, workspaceId),
  listMemoryWriteApprovals: (data?: { workspaceId?: string; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_WRITE_APPROVALS_LIST, data),
  getMemoryWriteApproval: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_WRITE_APPROVALS_GET, id),
  approveMemoryWriteApproval: (data: { id: string; workspaceId?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_WRITE_APPROVALS_APPROVE, data),
  rejectMemoryWriteApproval: (data: { id: string; workspaceId?: string; reason?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_WRITE_APPROVALS_REJECT, data),
  countMemoryWriteApprovals: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_WRITE_APPROVALS_COUNT, workspaceId),

  // Subconscious loop APIs
  getSubconsciousSettings: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBCONSCIOUS_GET_SETTINGS) as Promise<SubconsciousSettings>,
  saveSubconsciousSettings: (settings: SubconsciousSettings) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.SUBCONSCIOUS_SAVE_SETTINGS,
      settings,
    ) as Promise<SubconsciousSettings>,
  getSubconsciousBrain: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBCONSCIOUS_GET_BRAIN) as Promise<SubconsciousBrainSummary>,
  listSubconsciousTargets: (workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBCONSCIOUS_LIST_TARGETS, workspaceId) as Promise<
      SubconsciousTargetSummary[]
    >,
  getSubconsciousTargetDetail: (targetKey: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.SUBCONSCIOUS_GET_TARGET_DETAIL,
      targetKey,
    ) as Promise<SubconsciousTargetDetail | null>,
  refreshSubconsciousTargets: () =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBCONSCIOUS_REFRESH) as Promise<SubconsciousRefreshResult>,
  runSubconsciousNow: (targetKey?: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.SUBCONSCIOUS_RUN_NOW,
      targetKey,
    ) as Promise<SubconsciousRun | null>,
  dismissSubconsciousTarget: (targetKey: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUBCONSCIOUS_DISMISS_TARGET, targetKey) as Promise<
      SubconsciousTargetSummary | undefined
    >,
  resetSubconsciousHistory: () =>
    ipcRenderer.invoke(
      IPC_CHANNELS.SUBCONSCIOUS_RESET_HISTORY,
    ) as Promise<SubconsciousHistoryResetResult>,

  // Workspace Kit (.cowork) APIs
  getWorkspaceKitStatus: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.KIT_GET_STATUS, workspaceId) as Promise<WorkspaceKitStatus>,
  initWorkspaceKit: (request: WorkspaceKitInitRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.KIT_INIT, request) as Promise<WorkspaceKitStatus>,
  applyOnboardingProfile: (request: ApplyOnboardingProfileRequest) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.KIT_APPLY_ONBOARDING_PROFILE,
      request,
    ) as Promise<ApplyOnboardingProfileResult>,
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
    accessProfileId?: string | null;
  }) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ROLE_UPDATE, request),
  deleteAgentRole: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.AGENT_ROLE_DELETE, id),
  assignAgentRoleToTask: (taskId: string, agentRoleId: string | null) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_ROLE_ASSIGN_TO_TASK, taskId, agentRoleId),
  getBotNotificationPolicy: (agentRoleId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.BOT_NOTIFICATION_GET,
      agentRoleId,
    ) as Promise<BotNotificationPolicy>,
  updateBotNotificationPolicy: (request: UpdateBotNotificationPolicyRequest) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.BOT_NOTIFICATION_UPDATE,
      request,
    ) as Promise<BotNotificationPolicy>,

  // Mission Control - Company Ops / Planner
  listCompanies: () => ipcRenderer.invoke(IPC_CHANNELS.MC_COMPANY_LIST),
  getCommandCenterSummary: (companyId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_COMMAND_CENTER_SUMMARY, companyId) as Promise<
      import("../shared/types").CompanyCommandCenterSummary
    >,
  retryAutomationOutcomeNotification: (outcomeId: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.MC_AUTOMATION_OUTCOME_RETRY,
      outcomeId,
    ) as Promise<AutomationRunOutcome>,
  listMissionControlItems: (request?: import("../shared/types").MissionControlListRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.MISSION_CONTROL_LIST_ITEMS, request) as Promise<
      import("../shared/types").MissionControlItem[]
    >,
  getMissionControlItemEvidence: (itemId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MISSION_CONTROL_GET_ITEM_EVIDENCE, itemId) as Promise<
      import("../shared/types").MissionControlItemEvidence[]
    >,
  refreshMissionControl: (request?: import("../shared/types").MissionControlScopeRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.MISSION_CONTROL_REFRESH, request) as Promise<
      import("../shared/types").MissionControlBrief
    >,
  listCompanyGoals: (companyId: string) => ipcRenderer.invoke(IPC_CHANNELS.MC_GOAL_LIST, companyId),
  listCompanyProjects: (companyId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_PROJECT_LIST, companyId),
  createProject: (input: import("../shared/types").ProjectCreateInput) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_PROJECT_CREATE, input),
  listCompanyIssues: (companyId: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_ISSUE_LIST, { companyId, limit }),
  listIssueComments: (issueId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MC_ISSUE_COMMENT_LIST, issueId),
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
  getPackRegistryCategories: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_PACK_REGISTRY_CATEGORIES),
  checkPackUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.PLUGIN_PACK_CHECK_UPDATES),
  listQuarantinedImports: () => ipcRenderer.invoke(IPC_CHANNELS.IMPORT_SECURITY_LIST_QUARANTINED),
  retryQuarantinedImport: (recordId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPORT_SECURITY_RETRY_QUARANTINED, recordId),
  removeQuarantinedImport: (recordId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.IMPORT_SECURITY_REMOVE_QUARANTINED, recordId),

  // Admin Policies APIs
  getAdminPolicies: () => ipcRenderer.invoke(IPC_CHANNELS.ADMIN_POLICIES_GET),
  updateAdminPolicies: (updates: Record<string, unknown>) =>
    ipcRenderer.invoke(IPC_CHANNELS.ADMIN_POLICIES_UPDATE, updates),

  // Agent Security APIs
  agentSecurityGetStatus: (refresh?: boolean) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.AGENT_SECURITY_STATUS,
      refresh,
    ) as Promise<AgentSecurityRuntimeStatus>,
  agentSecurityListFindings: (query?: AgentSecurityFindingQuery) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SECURITY_FINDINGS_LIST, query) as Promise<
      AgentSecurityFinding[]
    >,
  agentSecurityUpdateFinding: (findingId: string, status: AgentSecurityFindingStatus) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.AGENT_SECURITY_FINDING_UPDATE,
      findingId,
      status,
    ) as Promise<AgentSecurityFinding | null>,
  agentSecurityListDiagnostics: (limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SECURITY_DIAGNOSTICS_LIST, limit) as Promise<
      AgentSecurityDiagnostic[]
    >,
  agentSecurityListInventory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SECURITY_INVENTORY_LIST) as Promise<
      AgentSecurityInventoryItem[]
    >,
  agentSecurityRefreshInventory: () =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SECURITY_INVENTORY_REFRESH) as Promise<
      AgentSecurityInventoryItem[]
    >,
  agentSecurityScan: () =>
    ipcRenderer.invoke(IPC_CHANNELS.AGENT_SECURITY_SCAN) as Promise<AgentSecurityScanResult>,
  agentSecurityCheckRules: () =>
    ipcRenderer.invoke(
      IPC_CHANNELS.AGENT_SECURITY_RULES_CHECK,
    ) as Promise<AgentSecurityRulesCheckResult>,
  agentSecurityInstallHook: (agent: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.AGENT_SECURITY_HOOK_INSTALL,
      agent,
    ) as Promise<AgentSecurityHookManagementResult>,
  agentSecurityUninstallHook: (agent: string) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.AGENT_SECURITY_HOOK_UNINSTALL,
      agent,
    ) as Promise<AgentSecurityHookManagementResult>,

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
  // ============ Mission Control APIs ============

  // Heartbeat System
  triggerHeartbeat: (agentRoleId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.HEARTBEAT_TRIGGER, agentRoleId),
  getAllHeartbeatStatus: () => ipcRenderer.invoke(IPC_CHANNELS.HEARTBEAT_GET_ALL_STATUS),
  onHeartbeatEvent: (callback: (event: HeartbeatEvent) => void) => {
    const subscription = (_: Any, data: HeartbeatEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.HEARTBEAT_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.HEARTBEAT_EVENT, subscription);
  },
  listAutomationProfiles: () => ipcRenderer.invoke(IPC_CHANNELS.AUTOMATION_PROFILE_LIST),
  listCoreFailureRecords: (request?: import("../shared/types").ListCoreFailureRecordsRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_FAILURE_LIST, request) as Promise<CoreFailureRecord[]>,
  listCoreFailureClusters: (request?: import("../shared/types").ListCoreFailureClustersRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_FAILURE_CLUSTER_LIST, request) as Promise<
      CoreFailureCluster[]
    >,
  listCoreEvalCases: (request?: import("../shared/types").ListCoreEvalCasesRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_EVAL_CASE_LIST, request) as Promise<CoreEvalCase[]>,
  listCoreExperiments: (request?: import("../shared/types").ListCoreExperimentsRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_EXPERIMENT_LIST, request) as Promise<
      CoreHarnessExperiment[]
    >,
  listCoreLearnings: (request?: import("../shared/types").ListCoreLearningsRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.CORE_LEARNINGS_LIST, request) as Promise<CoreLearningsEntry[]>,

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

  // LLM routing observability
  getLLMRoutingStatus: () =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_ROUTING_STATUS) as Promise<LLMRoutingRuntimeState>,
  onLLMRoutingEvent: (callback: (event: LLMRoutingRuntimeState) => void) => {
    const subscription = (_: Any, data: LLMRoutingRuntimeState) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.LLM_ROUTING_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.LLM_ROUTING_EVENT, subscription);
  },

  // Task Label APIs
  listTaskLabels: (query: TaskLabelListQuery) => {
    if (!isWorkspaceIdLike(query?.workspaceId)) {
      return Promise.resolve([]);
    }
    return ipcRenderer.invoke(IPC_CHANNELS.TASK_LABEL_LIST, query);
  },

  // Context Policy APIs (per-context security DM vs group)
  listContextPolicies: (channelId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONTEXT_POLICY_LIST, channelId),
  updateContextPolicy: (
    channelId: string,
    contextType: ContextTypeValue,
    options: UpdateContextPolicyOptions,
  ) => ipcRenderer.invoke(IPC_CHANNELS.CONTEXT_POLICY_UPDATE, channelId, contextType, options),
  listChannelSpecializations: (channelId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_SPECIALIZATION_LIST, channelId) as Promise<
      ChannelSpecializationData[]
    >,
  createChannelSpecialization: (data: CreateChannelSpecializationData) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.CHANNEL_SPECIALIZATION_CREATE,
      data,
    ) as Promise<ChannelSpecializationData>,
  updateChannelSpecialization: (data: UpdateChannelSpecializationData) =>
    ipcRenderer.invoke(
      IPC_CHANNELS.CHANNEL_SPECIALIZATION_UPDATE,
      data,
    ) as Promise<ChannelSpecializationData>,
  deleteChannelSpecialization: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CHANNEL_SPECIALIZATION_DELETE, id) as Promise<{
      success: boolean;
    }>,

  // Voice Mode
  getVoiceSettings: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_GET_SETTINGS),
  getVoiceCapabilities: () => ipcRenderer.invoke(IPC_CHANNELS.VOICE_GET_CAPABILITIES),
  saveVoiceSettings: (settings: Partial<VoiceSettingsData>) =>
    ipcRenderer.invoke(IPC_CHANNELS.VOICE_SAVE_SETTINGS, settings),
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
  getWorktreeWorkspaceInfo: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_WORKSPACE_INFO, workspaceId),
  mergeWorktree: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_MERGE, taskId),
  cleanupWorktree: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_CLEANUP, taskId),
  getWorktreeSettings: () => ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_GET_SETTINGS),
  saveWorktreeSettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_SAVE_SETTINGS, settings),

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
  addSuggestionAsCommitment: (workspaceId: string, suggestionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUGGESTIONS_ADD_COMMITMENT, workspaceId, suggestionId),
  // Today's calendar cards
  acceptCalendarProposal: (proposalId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_PROPOSAL_ACCEPT, proposalId),
  dismissCalendarProposal: (proposalId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_PROPOSAL_DISMISS, proposalId),
  holdCalendarTimeForSuggestion: (data: {
    workspaceId: string;
    suggestionId: string;
    start: number;
    end: number;
  }) => ipcRenderer.invoke(IPC_CHANNELS.CALENDAR_HOLD_FOR_SUGGESTION, data),
  // Reply drafts on Today
  sendMailReplyDraft: (draftId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAIL_REPLY_DRAFT_SEND, draftId),
  undoMailReplyDraftSend: (draftId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAIL_REPLY_DRAFT_UNDO_SEND, draftId),
  discardMailReplyDraft: (draftId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAIL_REPLY_DRAFT_DISCARD, draftId),
  setMailReplyDraftsEnabled: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.MAIL_REPLY_DRAFTS_SET_ENABLED, enabled),
  dismissMailReplyDraftsOffer: () =>
    ipcRenderer.invoke(IPC_CHANNELS.MAIL_REPLY_DRAFTS_DISMISS_OFFER),
  actOnSuggestion: (workspaceId: string, suggestionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SUGGESTIONS_ACT, workspaceId, suggestionId),

  // Shared "needs you" queue
  listAttention: () => ipcRenderer.invoke(IPC_CHANNELS.ATTENTION_LIST),
  onAttentionChanged: (callback: () => void) => {
    const subscription = () => callback();
    ipcRenderer.on(IPC_CHANNELS.ATTENTION_CHANGED, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.ATTENTION_CHANGED, subscription);
  },

  // Event Triggers
  listTriggers: (workspaceId: string) => ipcRenderer.invoke(IPC_CHANNELS.TRIGGER_LIST, workspaceId),
  listMcpEvents: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_EVENTS_LIST, serverId),
  getMcpEventsStatus: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_EVENTS_STATUS),
  getMcpEventsReceiverPort: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_EVENTS_RECEIVER_PORT),
  addTrigger: (data: Any) => ipcRenderer.invoke(IPC_CHANNELS.TRIGGER_ADD, data),
  updateTrigger: (id: string, updates: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.TRIGGER_UPDATE, { id, updates }),
  removeTrigger: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TRIGGER_REMOVE, id),
  getTriggerHistory: (triggerId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TRIGGER_HISTORY, triggerId),
  listSpeculativeRuns: (query?: { workspaceId?: string; limit?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SPECULATIVE_RUNS_LIST, query ?? {}),
  // Semantic event gate (policies and per-source/per-chat modes)
  getEventGateSettings: () => ipcRenderer.invoke(IPC_CHANNELS.EVENT_GATE_GET),
  addEventGatePolicy: (text: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.EVENT_GATE_ADD_POLICY, text),
  removeEventGatePolicy: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.EVENT_GATE_REMOVE_POLICY, id),
  toggleEventGatePolicy: (id: string, enabled?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.EVENT_GATE_TOGGLE_POLICY, { id, enabled }),
  setEventGateSourceMode: (source: string, mode: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.EVENT_GATE_SET_SOURCE_MODE, { source, mode }),
  setEventGateChatMode: (chatKey: string, mode: string | null) =>
    ipcRenderer.invoke(IPC_CHANNELS.EVENT_GATE_SET_CHAT_MODE, { chatKey, mode }),

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
  getRoutineWorkflowCapabilities: () =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_WORKFLOW_CAPABILITIES),
  validateRoutineWorkflow: (workflow: Any, allowIncomplete?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_WORKFLOW_VALIDATE, { workflow, allowIncomplete }),
  generateRoutineWorkflow: (prompt: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_WORKFLOW_GENERATE, prompt),
  saveRoutineWorkflowDraft: (routineId: string, workflow: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_WORKFLOW_SAVE_DRAFT, { routineId, workflow }),
  listRoutineWorkflowVersions: (routineId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_WORKFLOW_LIST_VERSIONS, routineId),
  activateRoutineWorkflowVersion: (routineId: string, versionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_WORKFLOW_ACTIVATE, { routineId, versionId }),
  testRoutineWorkflow: (request: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_WORKFLOW_TEST, request),
  listRoutineWorkflowRuns: (routineId?: string, limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_WORKFLOW_LIST_RUNS, { routineId, limit }),
  listRoutineWorkflowRunSteps: (runId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_WORKFLOW_LIST_STEPS, runId),
  respondToRoutineWorkflowApproval: (request: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_WORKFLOW_RESPOND_APPROVAL, request),
  cancelRoutineWorkflowRun: (runId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_WORKFLOW_CANCEL, runId),
  listRoutineWorkflowSecrets: () => ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_WORKFLOW_LIST_SECRETS),
  upsertRoutineWorkflowSecret: (input: { id?: string; name: string; value: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_WORKFLOW_UPSERT_SECRET, input),
  removeRoutineWorkflowSecret: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.ROUTINE_WORKFLOW_REMOVE_SECRET, id),

  // Daily Briefing (extended)
  getLatestBriefing: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.BRIEFING_GET_LATEST, workspaceId),

  // File Hub
  listHubFiles: (options: Any) => ipcRenderer.invoke(IPC_CHANNELS.FILEHUB_LIST, options),
  searchHubFiles: (query: string, sources?: string[], workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILEHUB_SEARCH, { query, sources, workspaceId }),
  getRecentHubFiles: (limit?: number) => ipcRenderer.invoke(IPC_CHANNELS.FILEHUB_RECENT, limit),
  trackHubFileAccess: (file: import("./file-hub/types").UnifiedFile) =>
    ipcRenderer.invoke(IPC_CHANNELS.FILEHUB_TRACK_ACCESS, file),
  getHubSources: () => ipcRenderer.invoke(IPC_CHANNELS.FILEHUB_SOURCES),

  // Web Access
  getWebAccessSettings: () => ipcRenderer.invoke(IPC_CHANNELS.WEBACCESS_GET_SETTINGS),
  saveWebAccessSettings: (settings: Any) =>
    ipcRenderer.invoke(IPC_CHANNELS.WEBACCESS_SAVE_SETTINGS, settings),
  getWebAccessStatus: () => ipcRenderer.invoke(IPC_CHANNELS.WEBACCESS_GET_STATUS),
  createWebAccessPairingCode: () => ipcRenderer.invoke(IPC_CHANNELS.WEBACCESS_CREATE_PAIRING_CODE),
  createWebAccessSignInLink: () => ipcRenderer.invoke(IPC_CHANNELS.WEBACCESS_CREATE_SIGN_IN_LINK),
  openWebAccessBrowserApp: () => ipcRenderer.invoke(IPC_CHANNELS.WEBACCESS_OPEN_BROWSER_APP),
  signOutWebAccessBrowsers: () => ipcRenderer.invoke(IPC_CHANNELS.WEBACCESS_SIGN_OUT_BROWSERS),

  // Window control APIs (for custom title bar on Windows)
  windowMinimize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MINIMIZE),
  windowMaximize: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_MAXIMIZE),
  windowClose: () => ipcRenderer.invoke(IPC_CHANNELS.WINDOW_CLOSE),
  getPlatform: () => process.platform,
  getNativeFrameMode: () =>
    shouldUseNativeWindowFrame({
      platform: process.platform,
      wslDistroName: process.env.WSL_DISTRO_NAME,
      osRelease: os.release(),
    }),
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
      | "document"
      | "pdf"
      | "latex"
      | "image"
      | "video"
      | "audio"
      | "pptx"
      | "xlsx"
      | "html"
      | "json"
      | "csv"
      | "unsupported";
    content: string | null;
    htmlContent?: string;
    ocrText?: string;
    pdfThumbnailDataUrl?: string;
    pdfDataBase64?: string;
    pdfReviewSummary?: PdfReviewSummary;
    spreadsheetPreview?: SpreadsheetPreview;
    documentPreview?: DocumentPreview;
    presentationPreview?: {
      slideCount: number;
      title?: string;
      slides: Array<{
        index: number;
        title?: string;
        text: string;
        notes?: string;
        imageUrl?: string;
        imageDataUrl?: string;
      }>;
      renderStatus: "cached" | "rendering" | "rendered" | "text_only" | "failed";
      renderMessage?: string;
    };
    webPreview?: {
      format: "html";
      previewMode: "sandboxed_iframe";
      title?: string;
      htmlContent?: string;
      sourcePath: string;
      baseDir: string;
      projectRoot?: string;
      framework?: "react" | "vite" | "next" | "html";
      canPreview: boolean;
      previewMessage?: string;
    };
    /** cowork-preview:// URL serving the preview with its scripts enabled. */
    webPreviewUrl?: string;
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
export type { ActivityActorType, ActivityType, ActivityData, ActivityListQuery, ActivityEvent };

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
export type { TaskBoardColumn, TaskLabelData, TaskLabelListQuery, TaskBoardEvent };

// Export Context Policy types
export type {
  SecurityModeType,
  ContextTypeValue,
  ContextPolicyData,
  UpdateContextPolicyOptions,
  ChannelSpecializationData,
  CreateChannelSpecializationData,
  UpdateChannelSpecializationData,
};

export interface BrowserWorkbenchOpenRequest {
  requestId: string;
  taskId: string;
  sessionId: string;
  url?: string;
}

export interface BrowserWorkbenchSessionRegistration {
  taskId: string;
  sessionId: string;
  /** Workbench tab this webContents renders. */
  tabId?: string;
  /** Make this the tab tools act on. */
  activate?: boolean;
  webContentsId: number;
  url?: string;
  title?: string;
}

/** Main -> renderer: open, show or close a workbench tab. */
export interface BrowserWorkbenchTabCommand {
  taskId: string;
  sessionId: string;
  command: "open" | "activate" | "close";
  tabId: string;
  url?: string;
  background?: boolean;
  openerTabId?: string;
  at: number;
}

export type BrowserWorkbenchBlockReason = "policy" | "local_preview" | "scheme";

export type BrowserTabViewState = import("./browser/browser-tab-views").BrowserTabViewState;
export type BrowserTabViewEvent = import("./browser/browser-tab-views").BrowserTabViewEvent;
export type BrowserTabViewCommand = import("./browser/browser-tab-views").BrowserTabViewCommand;

export interface BrowserWorkbenchScreenSharePrompt {
  requestId: string;
  taskId: string;
  sessionId: string;
  tabId: string;
  origin: string;
  sources: Array<{ id: string; name: string; kind: "screen" | "window"; thumbnail: string }>;
  at: number;
}

export interface BrowserWorkbenchPageDialogEvent {
  taskId: string;
  sessionId: string;
  tabId: string;
  dialogId: string;
  state: "open" | "closed";
  type?: "alert" | "confirm";
  message?: string;
  origin?: string;
}

export interface BrowserWorkbenchNavigationBlockedEvent {
  taskId: string;
  sessionId: string;
  tabId: string;
  url: string;
  reason: BrowserWorkbenchBlockReason;
  detail?: string;
  at: number;
}

export interface BrowserWorkbenchUserNavigateResult {
  allowed: boolean;
  url: string;
  block?: { reason: BrowserWorkbenchBlockReason | string; detail?: string };
}

export type LifecycleMetaInput = {
  kind: LifecycleKind;
  id: string;
  owner?: string | null;
  protects?: string | null;
  evidence?: string | null;
  dependsOn?: import("../shared/types").LifecycleRef[];
};

export interface BrowserWorkbenchInspectArea {
  rect: { x: number; y: number; width: number; height: number };
  scroll?: { x: number; y: number };
  elements: Array<{
    rect?: { x: number; y: number; width: number; height: number };
    selector?: string;
    tagName?: string;
    role?: string;
    accessibleName?: string;
    textQuote?: string;
  }>;
}

export interface BrowserImportableBrowser {
  id: string;
  name: string;
  kind: "chromium" | "firefox";
  profiles: Array<{ id: string; name: string }>;
}
export interface BrowserImportDetectResult {
  success: boolean;
  browsers: BrowserImportableBrowser[];
  canStorePasswords: boolean;
}
export type BrowserImportPrepareRequest =
  | { workspaceId: string; kind: "csv" }
  | { workspaceId: string; kind: "cookies_txt" }
  | {
      workspaceId: string;
      kind: "browser";
      browserId: string;
      profileId: string;
      cookies: boolean;
      passwords: boolean;
    };
export type BrowserImportPrepareResult =
  | {
      success: true;
      token: string;
      kind: "browser" | "csv" | "cookies_txt";
      source: string;
      cookies: number;
      logins: number;
      sampleSites: string[];
      skipped: Record<string, number>;
    }
  | { success: false; code: string; error: string };
export type BrowserImportCommitResult =
  | {
      success: true;
      cookies: number;
      cookiesRejected: number;
      /** Cookies saved as an encrypted jar for Camofox. */
      cookiesSaved: number;
      logins: number;
      loginsUpdated: number;
      canDeleteFile: boolean;
    }
  | { success: false; code: string; error: string };
export interface BrowserSavedLogin {
  id: string;
  origin: string;
  username: string;
  createdAt: number;
  lastUsedAt?: number;
}
export interface BrowserLoginsResult {
  items?: BrowserVaultItem[];
  success: boolean;
  logins: BrowserSavedLogin[];
  /** Saved cookies.txt jars; metadata only. */
  cookieJars?: BrowserCookieJarListing[];
  canStore?: boolean;
}

export interface BrowserHistoryEntryView {
  id: string;
  url: string;
  title: string;
  faviconUrl?: string;
  visitCount: number;
  firstVisitAt: number;
  lastVisitAt: number;
}

export interface BrowserWorkbenchDrivingEvent {
  taskId: string;
  sessionId: string;
  tabId?: string;
  driving: { toolName: string; label: string; startedAt: number } | null;
  pausedByUser: boolean;
  at: number;
}

export interface BrowserWorkbenchDownloadEvent {
  id: string;
  taskId: string;
  sessionId: string;
  tabId: string;
  url: string;
  filename: string;
  savePath?: string;
  state: "progressing" | "paused" | "completed" | "cancelled" | "interrupted" | "blocked";
  receivedBytes: number;
  totalBytes: number;
  dangerous: boolean;
  agentInitiated: boolean;
  startedAt: number;
  error?: string;
  at?: number;
}

export interface BrowserWorkbenchSignInEvent {
  taskId: string;
  sessionId: string;
  tabId?: string;
  url: string;
  at: number;
}

export type BrowserWorkbenchShortcutCommand =
  import("../shared/browser-shortcuts").BrowserShortcutCommand;

export interface BrowserWorkbenchShortcutEvent {
  taskId?: string;
  sessionId?: string;
  tabId?: string;
  command: BrowserWorkbenchShortcutCommand;
  gesture?: boolean;
  at: number;
}

export type BrowserWorkbenchContextAction =
  | { kind: "search"; text: string }
  | { kind: "ask"; text: string; url: string }
  | { kind: "annotate"; x: number; y: number }
  | { kind: "screenshot" };

export interface BrowserWorkbenchContextActionEvent {
  taskId: string;
  sessionId: string;
  tabId: string;
  action: BrowserWorkbenchContextAction;
  at: number;
}

export type BrowserWorkbenchDiagnosticsKind = "console" | "network" | "downloads" | "storage";

export interface BrowserWorkbenchDiagnosticsRequest {
  taskId: string;
  sessionId?: string;
  tabId?: string;
  kind: BrowserWorkbenchDiagnosticsKind;
  clear?: boolean;
}

export interface BrowserWorkbenchDiagnosticsResult {
  success: boolean;
  error?: string;
  tabId?: string;
  traceActive?: boolean;
  entries?: Array<{
    level?: string;
    text?: string;
    source?: string;
    method?: string;
    url?: string;
    status?: number;
    resourceType?: string;
    failed?: boolean;
    errorText?: string;
    timestamp: number;
  }>;
  storage?: unknown;
}

export interface BrowserWorkbenchSnapshotOverlay {
  tabId: string;
  snapshotId?: string;
  url?: string;
  stale: boolean;
  staleReason?: string;
  nodes: Array<{
    ref: string;
    role: string;
    name: string;
    bounds?: { x: number; y: number; width: number; height: number };
  }>;
}

export type BrowserWorkbenchPermissionResponse =
  | "allow-once"
  | "allow-always"
  | "block"
  | "dismiss";

export interface BrowserWorkbenchPermissionPrompt {
  requestId: string;
  taskId: string;
  sessionId: string;
  tabId: string;
  origin: string;
  permissions: string[];
  externalUrl?: string;
  at: number;
}

export interface BrowserWorkbenchCursorEvent {
  taskId: string;
  sessionId: string;
  x: number;
  y: number;
  kind:
    | "move"
    | "click"
    | "fill"
    | "type"
    | "press"
    | "scroll"
    | "wait"
    | "select"
    | "read"
    | "navigate";
  label?: string;
  pulse?: boolean;
  at: number;
}

export interface BrowserWorkbenchViewportEvent {
  taskId: string;
  sessionId: string;
  width: number;
  height: number;
  deviceScaleFactor: number;
  mobile: boolean;
  label: string;
  at: number;
}

export interface BrowserWorkbenchInspectTarget {
  rect?: { x: number; y: number; width: number; height: number };
  scroll?: { x: number; y: number };
  selector?: string;
  xpath?: string;
  tagName?: string;
  role?: string;
  accessibleName?: string;
  textQuote?: string;
  computedStyle?: Record<string, string>;
}

// Export Mission Control types
export type { HeartbeatStatus, HeartbeatResult, HeartbeatEvent, AgentAutonomyLevel };

export interface ElectronAPI {
  listHubFiles: (
    options: import("./file-hub/types").FileHubListOptions,
  ) => Promise<import("./file-hub/types").UnifiedFile[]>;
  searchHubFiles: (
    query: string,
    sources?: import("./file-hub/types").FileHubSource[],
    workspaceId?: string,
  ) => Promise<import("./file-hub/types").FileHubSearchResult[]>;
  getRecentHubFiles: (limit?: number) => Promise<import("./file-hub/types").UnifiedFile[]>;
  trackHubFileAccess: (file: import("./file-hub/types").UnifiedFile) => Promise<void>;
  getHubSources: () => Promise<import("./file-hub/types").FileHubSource[]>;
  getEventGateSettings: () => Promise<import("../shared/types").EventGateSettings>;
  addEventGatePolicy: (text: string) => Promise<import("../shared/types").EventGateSettings>;
  removeEventGatePolicy: (id: string) => Promise<import("../shared/types").EventGateSettings>;
  toggleEventGatePolicy: (
    id: string,
    enabled?: boolean,
  ) => Promise<import("../shared/types").EventGateSettings>;
  setEventGateSourceMode: (
    source: string,
    mode: import("../shared/types").EventGateMode,
  ) => Promise<import("../shared/types").EventGateSettings>;
  setEventGateChatMode: (
    chatKey: string,
    mode: import("../shared/types").EventGateMode | null,
  ) => Promise<import("../shared/types").EventGateSettings>;
  selectFolder: (defaultPath?: string) => Promise<string | null>;
  selectFiles: (defaultPath?: string) => Promise<
    Array<{
      path: string;
      name: string;
      size: number;
      mimeType?: string;
      /** OS-rendered preview image (data URL), when the platform can produce one. */
      thumbnailDataUrl?: string;
    }>
  >;
  openFile: (filePath: string, workspacePath?: string) => Promise<string>;
  openFileWithApp: (
    filePath: string,
    workspacePath: string | undefined,
    appName: string,
  ) => Promise<string>;
  showInFinder: (filePath: string, workspacePath?: string) => Promise<void>;
  readFileForViewer: (
    filePath: string,
    workspacePath?: string,
    options?: ReadFileForViewerOptions,
  ) => Promise<FileViewerResult>;
  updateSpreadsheetFile: (data: {
    filePath: string;
    workspacePath: string;
    preview: SpreadsheetPreview;
  }) => Promise<FileViewerResult>;
  openSpreadsheetWorkbook: (data: {
    filePath: string;
    workspacePath: string;
    workspaceId?: string;
  }) => Promise<SpreadsheetOpenWorkbookResult>;
  applySpreadsheetPatches: (data: {
    sessionId: string;
    patches: SpreadsheetPatch[];
  }) => Promise<SpreadsheetApplyPatchesResult>;
  saveSpreadsheetWorkbook: (data: { sessionId: string }) => Promise<SpreadsheetSaveWorkbookResult>;
  closeSpreadsheetWorkbook: (data: { sessionId: string }) => Promise<{ success: boolean }>;
  updateDocumentFile: (data: {
    filePath: string;
    workspacePath: string;
    blocks: EditableDocumentBlock[];
  }) => Promise<FileViewerResult>;
  registerBrowserWorkbenchSession: (
    data: BrowserWorkbenchSessionRegistration,
  ) => Promise<{ success: boolean }>;
  listLocalPreviewTemplates: () => Promise<LocalPreviewCommandTemplate[]>;
  startLocalPreview: (request: LocalPreviewStartRequest) => Promise<LocalPreviewProcessInfo>;
  stopLocalPreview: (previewId: string) => Promise<LocalPreviewProcessInfo>;
  restartLocalPreview: (previewId: string) => Promise<LocalPreviewProcessInfo>;
  getLocalPreview: (previewId: string) => Promise<LocalPreviewProcessInfo | null>;
  listLocalPreviews: (workspaceId?: string) => Promise<LocalPreviewProcessInfo[]>;
  checkLocalPreviewHealth: (previewId: string) => Promise<LocalPreviewHealthResult>;
  openLocalPreview: (previewId: string) => Promise<LocalPreviewProcessInfo>;
  unregisterBrowserWorkbenchSession: (data: {
    taskId: string;
    sessionId?: string;
    tabId?: string;
    webContentsId?: number;
  }) => Promise<{ success: boolean }>;
  updateBrowserWorkbenchStatus: (data: {
    taskId: string;
    sessionId?: string;
    tabId?: string;
    webContentsId?: number;
    url?: string;
    title?: string;
  }) => Promise<{ success: boolean }>;
  activateBrowserWorkbenchTab: (data: {
    taskId: string;
    sessionId?: string;
    tabId: string;
  }) => Promise<{ success: boolean }>;
  /** Runs the page's "Leave site?" check; close is false when the user chose to stay. */
  checkBrowserWorkbenchTabClose: (data: {
    taskId: string;
    sessionId?: string;
    tabId: string;
  }) => Promise<{ close: boolean }>;
  browserWorkbenchUserNavigate: (data: {
    taskId: string;
    sessionId?: string;
    tabId?: string;
    url: string;
  }) => Promise<BrowserWorkbenchUserNavigateResult>;
  respondBrowserWorkbenchPermission: (data: {
    requestId: string;
    response: BrowserWorkbenchPermissionResponse;
  }) => Promise<{ success: boolean }>;
  listBrowserWorkbenchPermissionRequests: (data: {
    taskId: string;
    sessionId?: string;
  }) => Promise<BrowserWorkbenchPermissionPrompt[]>;
  inspectBrowserWorkbenchArea: (data: {
    taskId: string;
    sessionId?: string;
    rect: { x: number; y: number; width: number; height: number };
  }) => Promise<{ success: boolean; area?: BrowserWorkbenchInspectArea; error?: string }>;
  previewBrowserWorkbenchStyle: (data: {
    taskId: string;
    sessionId?: string;
    selector: string;
    action: "apply" | "revert";
    styles?: Record<string, string>;
    text?: string;
  }) => Promise<{ success: boolean; error?: string }>;
  setBrowserWorkbenchFocus: (focused: boolean) => Promise<{ success: boolean }>;
  getBrowserWorkbenchDiagnostics: (
    data: BrowserWorkbenchDiagnosticsRequest,
  ) => Promise<BrowserWorkbenchDiagnosticsResult>;
  browserWorkbenchTrace: (data: {
    taskId: string;
    sessionId?: string;
    tabId?: string;
    action: "start" | "stop";
  }) => Promise<{ success: boolean; message?: string; error?: string }>;
  getBrowserWorkbenchSnapshot: (data: {
    taskId: string;
    sessionId?: string;
    tabId?: string;
  }) => Promise<BrowserWorkbenchSnapshotOverlay | null>;
  browserImportDetect: () => Promise<BrowserImportDetectResult>;
  browserImportPrepare: (data: BrowserImportPrepareRequest) => Promise<BrowserImportPrepareResult>;
  browserImportCommit: (data: {
    workspaceId: string;
    token: string;
    cookies?: boolean;
    passwords?: boolean;
    /** cookies.txt imports: save an encrypted cookie jar for Camofox (default true). */
    saveToVault?: boolean;
    /** cookies.txt imports: also add the cookies to the in-app browser (default false). */
    applyToBrowser?: boolean;
  }) => Promise<BrowserImportCommitResult>;
  browserImportCancel: (data: { token: string }) => Promise<{ success: boolean }>;
  browserImportDeleteFile: (data: {
    token: string;
  }) => Promise<{ success: boolean; deleted?: boolean; error?: string }>;
  listBrowserVaultPrompts: () => Promise<BrowserVaultPrompt[]>;
  dismissBrowserVaultPrompt: (id: string) => Promise<{ success: boolean }>;
  respondBrowserVaultPrompt: (
    id: string,
    answer: BrowserVaultAnswer | null,
  ) => Promise<{ success: boolean }>;
  browserVaultCommand: (
    taskId: string,
    command: BrowserVaultCommand,
  ) => Promise<{ success: boolean; error?: string; [key: string]: unknown }>;
  onBrowserVaultPromptChanged: (callback: () => void) => () => void;
  getSecretSourcesStatus: () => Promise<{
    success: boolean;
    status?: SecretSourcesStatus;
    error?: string;
  }>;
  saveSecretSources: (update: SecretSourcesSettingsUpdate) => Promise<{
    success: boolean;
    status?: SecretSourcesStatus;
    error?: string;
  }>;
  unlockBitwardenForKeys: (password: string) => Promise<{ success: boolean; error?: string }>;
  lockBitwardenForKeys: () => Promise<{ success: boolean; error?: string }>;
  testSecretReference: (reference: string) => Promise<{
    success: boolean;
    result?: SecretReferenceTestResult;
    error?: string;
  }>;
  listBrowserLogins: (data: { workspaceId: string }) => Promise<BrowserLoginsResult>;
  listBrowserLoginsForPage: (data: {
    workspaceId: string;
    url: string;
  }) => Promise<BrowserLoginsResult>;
  removeBrowserLogin: (data: { workspaceId: string; id: string }) => Promise<{ success: boolean }>;
  removeBrowserCookieJar: (data: {
    workspaceId: string;
    id: string;
  }) => Promise<{ success: boolean }>;
  clearBrowserLogins: (data: {
    workspaceId: string;
  }) => Promise<{ success: boolean; removed: number }>;
  fillBrowserLogin: (data: {
    workspaceId: string;
    taskId: string;
    sessionId?: string;
    id: string;
  }) => Promise<{ success: boolean; filledUsername?: boolean; code?: string; error?: string }>;
  getBrowserSettings: () => Promise<BrowserSettingsState>;
  saveBrowserSettings: (
    settings: Partial<BrowserSettings>,
  ) => Promise<{ success: boolean; settings?: BrowserSettingsState }>;
  getCamofoxSettings: () => Promise<CamofoxDisplaySettings>;
  saveCamofoxSettings: (update: CamofoxSettingsUpdate) => Promise<CamofoxDisplaySettings>;
  testCamofoxConnection: () => Promise<CamofoxConnectionResult>;
  /** Copies the start command, proxy password filled in, without it reaching the renderer. */
  copyCamofoxStartCommand: () => Promise<void>;
  /** Build Compare: the commit a branch points to now, so every variant starts from it. */
  resolveWorktreeBaseCommit: (data: {
    workspaceId: string;
    branch?: string;
  }) => Promise<{ commit: string }>;
  /** Worktree changes waiting to merge, grouped by intent, with combined-state checks. */
  getMergeReview: (workspaceId: string) => Promise<MergeReview>;
  /** Mission Control > Operations > Hygiene: unused, ownerless and broken generated software. */
  getHygieneReport: (data?: { includeAll?: boolean }) => Promise<HygieneReport>;
  /** Archive or disable the item where its store can, and mark it retired. Nothing is deleted. */
  retireLifecycleItem: (data: {
    kind: LifecycleKind;
    id: string;
  }) => Promise<{ success: boolean; error?: string }>;
  /** Keep the item: its idle timer restarts. */
  keepLifecycleItem: (data: { kind: LifecycleKind; id: string }) => Promise<{ success: boolean }>;
  setLifecycleMeta: (data: LifecycleMetaInput) => Promise<{ success: boolean; error?: string }>;
  /** The public key directory (JWK Set) to host for declared agent identity. */
  getAgentIdentityDirectory: () => Promise<AgentIdentityDirectoryResult>;
  /**
   * Replace the declared-identity key after a native confirmation; null when the user cancels.
   * The hosted directory must then be updated.
   */
  rotateAgentIdentityKey: () => Promise<AgentIdentityDirectoryResult>;
  listBrowserSitePermissions: (data: {
    workspaceId: string;
  }) => Promise<BrowserSitePermissionEntry[]>;
  resetBrowserSitePermission: (data: {
    workspaceId: string;
    origin?: string;
    permission?: string;
  }) => Promise<{ success: boolean }>;
  /** Remember Allow or Block for a site (the browser's site controls). */
  setBrowserSitePermission: (data: {
    workspaceId: string;
    origin: string;
    permission: string;
    decision: "allow" | "block";
  }) => Promise<{ success: boolean }>;
  searchBrowserHistory: (data: {
    workspaceId: string;
    query: string;
    limit?: number;
  }) => Promise<BrowserHistoryEntryView[]>;
  listBrowserHistory: (data: {
    workspaceId: string;
    limit?: number;
    offset?: number;
    query?: string;
  }) => Promise<BrowserHistoryEntryView[]>;
  removeBrowserHistory: (data: {
    workspaceId: string;
    ids: string[];
  }) => Promise<{ success: boolean; removed: number }>;
  clearBrowserHistory: (data: {
    workspaceId: string;
    since?: number;
  }) => Promise<{ success: boolean; removed: number }>;
  clearBrowserData: (data: {
    workspaceId: string;
    types: BrowserDataType[];
    since?: number;
  }) => Promise<{ success: boolean }>;
  listBrowserDownloads: (data: {
    taskId: string;
    sessionId?: string;
  }) => Promise<BrowserWorkbenchDownloadEvent[]>;
  browserDownloadAction: (data: {
    id: string;
    action: "pause" | "resume" | "cancel" | "open" | "reveal" | "clear";
    confirmedDangerous?: boolean;
  }) => Promise<{ success: boolean; error?: string }>;
  setBrowserWorkbenchPaused: (data: {
    taskId: string;
    sessionId?: string;
    paused: boolean;
  }) => Promise<{ success: boolean }>;
  onBrowserWorkbenchDriving: (
    callback: (event: BrowserWorkbenchDrivingEvent) => void,
  ) => () => void;
  onBrowserWorkbenchDownload: (
    callback: (event: BrowserWorkbenchDownloadEvent) => void,
  ) => () => void;
  onBrowserWorkbenchSignInRequired: (
    callback: (event: BrowserWorkbenchSignInEvent) => void,
  ) => () => void;
  captureBrowserWorkbenchScreenshot: (data: {
    taskId: string;
    sessionId?: string;
    workspacePath: string;
    filename?: string;
    includeDataUrl?: boolean;
    fullPage?: boolean;
  }) => Promise<{
    success: boolean;
    path?: string;
    fullPath?: string;
    width?: number;
    height?: number;
    dataUrl?: string;
    error?: string;
  }>;
  inspectBrowserWorkbenchPoint: (data: {
    taskId: string;
    sessionId?: string;
    x: number;
    y: number;
  }) => Promise<{
    success: boolean;
    target?: BrowserWorkbenchInspectTarget;
    error?: string;
  }>;
  resolveBrowserWorkbenchAnnotationTargets: (data: {
    taskId: string;
    sessionId?: string;
    targets: BrowserAnnotationTargetRef[];
  }) => Promise<{
    success: boolean;
    targets?: BrowserAnnotationTargetResolveResult[];
    error?: string;
  }>;
  createAnnotation: (data: AnnotationCreateInput) => Promise<Annotation>;
  listAnnotations: (query: AnnotationListQuery) => Promise<Annotation[]>;
  updateAnnotation: (id: string, patch: AnnotationUpdateInput) => Promise<Annotation | null>;
  resolveAnnotation: (id: string, resolvedByEventId?: string) => Promise<Annotation | null>;
  dismissAnnotation: (id: string) => Promise<Annotation | null>;
  undoAnnotationChange: (id: string, undoToken: string) => Promise<AnnotationUndoResult>;
  onBrowserWorkbenchOpenRequest: (
    callback: (request: BrowserWorkbenchOpenRequest) => void,
  ) => () => void;
  onBrowserWorkbenchCursor: (callback: (event: BrowserWorkbenchCursorEvent) => void) => () => void;
  onBrowserWorkbenchViewport: (
    callback: (event: BrowserWorkbenchViewportEvent) => void,
  ) => () => void;
  onBrowserWorkbenchTabCommand: (
    callback: (command: BrowserWorkbenchTabCommand) => void,
  ) => () => void;
  onBrowserWorkbenchNavigationBlocked: (
    callback: (event: BrowserWorkbenchNavigationBlockedEvent) => void,
  ) => () => void;
  /** A page asks to share a screen or window: the picker's choices. */
  popupBrowserToolbarMenu: (
    data: BrowserToolbarMenuRequest,
  ) => Promise<BrowserToolbarMenuAction | null>;
  /** Native tab views (browser engine "native"); see src/electron/browser/browser-tab-views.ts. */
  openBrowserTabView: (data: {
    taskId: string;
    sessionId: string;
    tabId: string;
    partition: string;
    activate: boolean;
  }) => Promise<BrowserTabViewState>;
  loadBrowserTabView: (data: {
    taskId: string;
    sessionId: string;
    tabId: string;
    url: string;
  }) => Promise<{ success: boolean }>;
  commandBrowserTabView: (data: {
    taskId: string;
    sessionId: string;
    tabId: string;
    command: BrowserTabViewCommand;
    args?: Record<string, unknown>;
  }) => Promise<{ success: boolean }>;
  layoutBrowserTabView: (data: {
    taskId: string;
    sessionId: string;
    tabId: string | null;
    bounds: { x: number; y: number; width: number; height: number } | null;
  }) => Promise<void>;
  captureBrowserTabView: (data: {
    taskId: string;
    sessionId: string;
    tabId: string;
  }) => Promise<string | null>;
  closeBrowserTabView: (data: {
    taskId: string;
    sessionId: string;
    tabId: string;
  }) => Promise<void>;
  onBrowserTabViewEvent: (callback: (event: BrowserTabViewEvent) => void) => () => void;
  onBrowserWorkbenchScreenShareRequest: (
    callback: (prompt: BrowserWorkbenchScreenSharePrompt) => void,
  ) => () => void;
  listBrowserWorkbenchScreenShareRequests: (data: {
    taskId: string;
    sessionId?: string;
  }) => Promise<BrowserWorkbenchScreenSharePrompt[]>;
  /** sourceId null cancels. */
  respondBrowserWorkbenchScreenShare: (data: {
    requestId: string;
    sourceId: string | null;
  }) => Promise<{ success: boolean }>;
  /** A page's alert/confirm the workbench shows while CoWork's debugger owns page dialogs. */
  onBrowserWorkbenchPageDialog: (
    callback: (event: BrowserWorkbenchPageDialogEvent) => void,
  ) => () => void;
  respondBrowserWorkbenchPageDialog: (data: {
    taskId: string;
    sessionId?: string;
    tabId: string;
    dialogId: string;
    accept: boolean;
  }) => Promise<{ success: boolean }>;
  onBrowserWorkbenchPermissionRequest: (
    callback: (prompt: BrowserWorkbenchPermissionPrompt) => void,
  ) => () => void;
  onBrowserWorkbenchShortcut: (
    callback: (event: BrowserWorkbenchShortcutEvent) => void,
  ) => () => void;
  onBrowserWorkbenchContextAction: (
    callback: (event: BrowserWorkbenchContextActionEvent) => void,
  ) => () => void;
  askYouTubeVideo: (data: {
    workspaceId: string;
    question: string;
    url?: string;
    videoIds?: string[];
    language?: string;
    limit?: number;
    force?: boolean;
  }) => Promise<Any>;
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
  startDocumentEditTask: (data: DocumentEditRequest) => Promise<Any>;
  getMailboxSyncStatus: () => Promise<MailboxSyncStatus>;
  getMailboxClientState: () => Promise<MailboxClientState>;
  syncMailbox: (limit?: number, source?: "auto" | "manual") => Promise<MailboxSyncResult>;
  listMailboxThreads: (query?: MailboxListThreadsInput) => Promise<MailboxThreadListItem[]>;
  getMailboxThread: (threadId: string) => Promise<MailboxThreadDetail | null>;
  listMailboxEvents: (limit?: number, threadId?: string) => Promise<MailboxEvent[]>;
  listMailboxAutomations: (query?: {
    workspaceId?: string;
    threadId?: string;
  }) => Promise<MailboxAutomationRecord[]>;
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
  getMailboxSenderCleanupDigest: (input?: {
    limit?: number;
  }) => Promise<MailboxSenderCleanupDigest>;
  askMailbox: (input: MailboxAskInput) => Promise<MailboxAskResult>;
  onMailboxAskEvent: (callback: (event: MailboxAskRunEvent) => void) => () => void;
  extractMailboxAttachmentText: (attachmentId: string) => Promise<MailboxAttachmentRecord>;
  getMailboxDraft: (draftId: string) => Promise<MailboxComposeDraft | null>;
  createMailboxDraft: (input: MailboxComposeDraftInput) => Promise<MailboxComposeDraft>;
  updateMailboxDraft: (
    draftId: string,
    patch: MailboxComposeDraftPatch,
  ) => Promise<MailboxComposeDraft>;
  sendMailboxDraft: (draftId: string) => Promise<MailboxOutgoingMessage>;
  retryMailboxAction: (actionId: string) => Promise<MailboxQueuedAction>;
  resolveMailboxSendOutcome: (
    actionId: string,
    resolution: MailboxSendOutcomeResolution,
  ) => Promise<MailboxQueuedAction>;
  discardMailboxDraft: (draftId: string) => Promise<boolean>;
  /** Takes back a queued send and returns the draft to editing; false when it's too late. */
  cancelMailboxDraftSend: (draftId: string) => Promise<boolean>;
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
  listContactIdentities: (workspaceId?: string) => Promise<ContactIdentity[]>;
  searchIdentityLinkTargets: (
    workspaceId: string,
    query: string,
    limit?: number,
  ) => Promise<ContactIdentitySearchResult[]>;
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
  listIdentityCandidates: (
    workspaceId?: string,
    status?: ContactIdentityCandidate["status"],
  ) => Promise<ContactIdentityCandidate[]>;
  confirmIdentityLink: (candidateId: string) => Promise<ContactIdentityCandidate | null>;
  rejectIdentityLink: (candidateId: string) => Promise<ContactIdentityCandidate | null>;
  unlinkIdentityHandle: (handleId: string) => Promise<boolean>;
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
  previewMailboxMissionControlHandoff: (
    threadId: string,
  ) => Promise<MailboxMissionControlHandoffPreview | null>;
  createMailboxMissionControlHandoff: (
    request: MailboxMissionControlHandoffRequest,
  ) => Promise<MailboxMissionControlHandoffRecord>;
  listMailboxMissionControlHandoffs: (
    threadId: string,
  ) => Promise<MailboxMissionControlHandoffRecord[]>;
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
  getMailboxQuickReplySuggestions: (
    threadId: string,
  ) => Promise<MailboxQuickReplySuggestionsResult>;
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
  getSessionProgress: (taskId: string) => Promise<SessionProgressState | undefined>;
  getWorkSessionRollout: () => Promise<Any>;
  updateWorkSessionRollout: (update: {
    enabled?: boolean;
    cohortPercent?: number;
    salt?: string;
    legacyReadRollback?: boolean;
  }) => Promise<Any>;
  listWorkSessionMetrics: (options?: {
    sessionId?: string;
    workspaceId?: string;
    name?: string;
    limit?: number;
    since?: number;
  }) => Promise<Any>;
  listWorkSessionLeases: (sessionId?: string) => Promise<Any>;
  getWorkSessionProjection: (request: { sessionId: string; projection?: string }) => Promise<Any>;
  evaluateWorkSessionReplay: (request: {
    taskId: string;
    fixtureId?: string;
    assertions?: {
      expectedTerminalStatus?: string;
      mustContainAll?: string[];
      mustCreatePaths?: string[];
    };
  }) => Promise<Any>;
  listTasks: (opts?: {
    limit?: number;
    offset?: number;
    prioritizeSidebar?: boolean;
    includeArchivedSessions?: boolean;
    botConversation?: { workspaceId: string; agentRoleId: string };
    excludeSources?: string[];
    cursor?: {
      id?: string;
      pinned?: boolean;
      status?: string;
      updatedAt?: number;
      createdAt?: number;
    };
  }) => Promise<Any[]>;
  retryBotNotification: (request: BotNotificationRetry) => Promise<BotNotificationReceipt>;
  getBotNotificationRoute: (scope: BotNotificationScope) => Promise<BotNotificationRoute>;
  updateBotNotificationRoute: (request: BotNotificationUpdate) => Promise<BotNotificationRoute>;
  listBotNotificationReceipts: (scope: BotNotificationScope) => Promise<BotNotificationReceipt[]>;
  getBotWorkResult: (
    request: import("../shared/bot-work-result").BotWorkResultRequest,
  ) => Promise<import("../shared/bot-work-result").BotWorkResult>;
  listBotWork: (query: BotWorkQuery) => Promise<BotWorkPage>;
  getBotMetricsSummary: (request: BotOutcomeMetricsRequest) => Promise<BotOutcomeMetrics>;
  /** "What it can do" in a bot's details panel; read-only. */
  getBotCapabilities: (request: BotCapabilitiesRequest) => Promise<BotCapabilitySummary>;
  activateBotResponsibility: (
    request: import("../shared/bot-responsibility").BotResponsibilityControl,
  ) => Promise<BotResponsibility>;
  getBotFutureControl: (request: {
    scope: import("../shared/bot-responsibility").BotResponsibilityScope;
  }) => Promise<import("../shared/bot-work-control").BotFutureControlState>;
  stopBotWork: (
    request: import("../shared/bot-work-control").BotWorkControlRequest,
  ) => Promise<import("../shared/bot-work-control").BotWorkControlReceipt>;
  getBotWorkControl: (
    request: import("../shared/bot-work-control").BotWorkControlRead,
  ) => Promise<import("../shared/bot-work-control").BotWorkControlReceipt | null>;
  setBotResponsibilityFutureRuns: (
    request: import("../shared/bot-responsibility").BotResponsibilityFutureControl,
  ) => Promise<import("../shared/bot-responsibility").BotResponsibilityFutureReceipt>;
  pauseBotResponsibility: (
    request: import("../shared/bot-responsibility").BotResponsibilityControl,
  ) => Promise<BotResponsibility>;
  runBotResponsibility: (
    request: import("../shared/bot-responsibility").BotResponsibilityRunRequest,
  ) => Promise<import("./routines/types").RoutineRun | null>;
  listBotResponsibilities: (request: BotResponsibilityScope) => Promise<BotResponsibility[]>;
  listBotResponsibilityEngines: (
    request: BotResponsibilityScope,
  ) => Promise<BotResponsibilityEngine[]>;
  previewBotResponsibility: (request: BotResponsibilitySave) => Promise<BotResponsibilityPreview>;
  createBotResponsibility: (request: BotResponsibilitySave) => Promise<BotResponsibility>;
  reviseBotResponsibility: (request: BotResponsibilityRevise) => Promise<BotResponsibility>;

  listBotConversations: (query: BotConversationListQuery) => Promise<Any[]>;
  listBotMessages: (
    request: import("../shared/bot-messages").BotMessagePageRequest,
  ) => Promise<import("../shared/bot-messages").BotMessagePage>;
  reopenBotConversation: (request: BotConversationReopenRequest) => Promise<Task>;
  getComposerPrediction?: (
    request: import("../shared/composer-predictions").ComposerPredictionRequest,
  ) => Promise<import("../shared/composer-predictions").ComposerPrediction | null>;
  cancelComposerPrediction?: (requestId: string) => Promise<void>;
  getComposerDraft?: (request: ComposerDraftGetRequest) => Promise<ComposerDraft | null>;
  upsertComposerDraft?: (draft: ComposerDraft) => Promise<{
    accepted: boolean;
    draft: ComposerDraft | null;
  }>;
  clearComposerDraft?: (request: ComposerDraftClearRequest) => Promise<{
    cleared: boolean;
    releasedAttachments: number;
  }>;
  rekeyComposerDraft?: (request: ComposerDraftRekeyRequest) => Promise<{
    rekeyed: boolean;
    rekeyedAttachmentCount?: number;
  }>;
  putComposerDraftAttachment?: (request: ComposerDraftAttachmentPutRequest) => Promise<Any>;
  resolveComposerDraftAttachment?: (request: ComposerDraftAttachmentResolveRequest) => Promise<Any>;
  releaseComposerDraftAttachment?: (request: ComposerDraftAttachmentReleaseRequest) => Promise<Any>;
  listSidebarTasks: (opts?: {
    limit?: number;
    offset?: number;
    prioritizeSidebar?: boolean;
    includeArchivedSessions?: boolean;
    excludeBotConversations?: boolean;
    excludeSources?: string[];
    workspaceId?: string;
    /** Top-level tasks of archived sessions only, most recently archived first. */
    archivedSessionsOnly?: boolean;
    cursor?: {
      id?: string;
      pinned?: boolean;
      status?: string;
      updatedAt?: number;
      createdAt?: number;
    };
  }) => Promise<Any[]>;
  toggleTaskPin: (taskId: string) => Promise<Any>;
  cancelTask: (id: string) => Promise<void>;
  discardInterruptedTask: (taskId: string, expectedUpdatedAt: number) => Promise<void>;
  wrapUpTask: (id: string) => Promise<void>;
  pauseTask: (id: string) => Promise<void>;
  resumeTask: (id: string) => Promise<void>;
  forkTaskSession: (data: {
    taskId: string;
    prompt?: string;
    branchLabel?: string;
    fromEventId?: string;
    sideChat?: boolean;
    initialMessage?: string;
  }) => Promise<Any>;
  listTaskProposals: (taskId: string) => Promise<TaskProposal[]>;
  startTaskProposal: (proposalId: string, options?: TaskProposalStartOptions) => Promise<Task>;
  startAllTaskProposals: (
    taskId: string,
    proposalIds: string[],
  ) => Promise<Array<{ proposalId: string; taskId?: string; error?: string }>>;
  doTaskProposalHere: (proposalId: string) => Promise<void>;
  dismissTaskProposal: (proposalId: string) => Promise<void>;
  sendStdin: (taskId: string, input: string) => Promise<boolean>;
  killCommand: (taskId: string, force?: boolean) => Promise<boolean>;
  renameTask: (id: string, title: string) => Promise<void>;
  updateTaskWorkspace: (taskId: string, workspaceId: string) => Promise<Any>;
  setTaskModel: (selection: {
    taskId: string;
    providerType: LLMProviderType;
    modelKey: string;
    reasoningEffort?: LLMReasoningEffort;
  }) => Promise<Task>;
  archiveTask: (id: string) => Promise<Any>;
  /** Brings an archived session back to the sidebar. */
  unarchiveTask?: (id: string) => Promise<{ metadata: unknown; taskCount: number }>;
  archiveWorkspaceSessions?: (
    workspaceId: string,
  ) => Promise<{ sessionCount: number; skippedRunning?: number }>;
  deleteTask: (id: string) => Promise<void>;
  onTaskEvent: (callback: (event: Any) => void) => () => void;
  onTaskLearningEvent: (callback: (event: TaskLearningProgress) => void) => () => void;
  getTaskEvents: (taskId: string) => Promise<Any[]>;
  getTaskTimelinePage: (request: TaskTimelinePageRequest) => Promise<TaskTimelinePageResult>;
  getTaskEventDetail: (request: TaskEventDetailRequest) => Promise<TaskEventDetailResult>;
  getTaskLearningProgress: (taskId: string) => Promise<TaskLearningProgress[]>;
  getQueuedTaskInputs: (
    taskId: string,
  ) => Promise<import("../shared/queued-task-input").QueuedTaskInput[]>;
  editQueuedTaskInput: (
    input: import("../shared/queued-task-input").EditQueuedTaskInput,
  ) => Promise<import("../shared/queued-task-input").QueuedTaskInput>;
  sendMessage: (
    taskId: string,
    message: string,
    images?: ImageAttachment[],
    quotedAssistantMessage?: QuotedAssistantMessage,
    options?: {
      expectedTurnId?: string;
      interactionMode?: import("../shared/interaction-mode").InteractionModeSelection;
      deliveryMode?: "message" | "follow_up";
      returnOnAccepted?: boolean;
      messageId?: string;
      permissionMode?: PermissionMode;
      shellAccess?: boolean;
      accessProfileId?: AccessProfileId;
      integrationMentions?: IntegrationMentionSelection[];
      surfaceOrigin?: MessageSurfaceOrigin;
    },
  ) => Promise<{
    queued: boolean;
    duplicate?: boolean;
    messageId?: string;
    deliveryMode?: "message" | "follow_up";
    deliveryStatus?: "accepted" | "queued" | "delivered" | "failed";
    acceptedAt?: number;
  }>;
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
  listTerminalTabs: (workspaceId: string, taskId?: string) => Promise<ShellSessionInfo[]>;
  createTerminalTab: (data: {
    workspaceId: string;
    taskId?: string;
    title?: string;
    cwd?: string;
  }) => Promise<ShellSessionInfo>;
  runTerminalTabCommand: (data: {
    tabId: string;
    workspaceId: string;
    taskId: string;
    command: string;
    cwd?: string;
  }) => Promise<TerminalTabRunResult>;
  writeTerminalTabInput: (data: {
    tabId: string;
    workspaceId: string;
    taskId?: string;
    input: string;
  }) => Promise<ShellSessionInfo>;
  resizeTerminalTab: (data: {
    tabId: string;
    workspaceId: string;
    taskId?: string;
    cols: number;
    rows: number;
  }) => Promise<ShellSessionInfo>;
  stopTerminalTab: (data: {
    tabId: string;
    workspaceId: string;
    taskId?: string;
  }) => Promise<ShellSessionInfo | null>;
  closeTerminalTab: (data: {
    tabId: string;
    workspaceId: string;
    taskId?: string;
  }) => Promise<{ success: boolean }>;
  onTerminalTabOutput: (callback: (event: TerminalTabOutputEvent) => void) => () => void;
  /** Run a shell code block from an answer in the task's terminal tab and wait for it to finish. */
  runTerminalBlock: (data: TerminalBlockRunRequest) => Promise<TerminalBlockRunResult>;
  stopTerminalBlock: (data: { runId: string }) => Promise<{ stopped: boolean }>;
  onTerminalBlockOutput: (callback: (event: TerminalBlockOutputEvent) => void) => () => void;
  /** The agent's background processes of a task, as read-only terminal panel tabs. */
  listAgentTerminalTabs: (taskId: string) => Promise<AgentTerminalTab[]>;
  readAgentTerminalTab: (
    data: AgentTerminalTabRequest,
  ) => Promise<{ output: string; truncated: boolean }>;
  stopAgentTerminalTab: (data: AgentTerminalTabRequest) => Promise<AgentTerminalTab>;
  closeAgentTerminalTab: (data: AgentTerminalTabRequest) => Promise<{ success: boolean }>;
  onAgentTerminalEvent: (callback: (event: AgentTerminalEvent) => void) => () => void;
  createWorkspace: (data: Any) => Promise<Workspace>;
  listWorkspaces: () => Promise<Workspace[]>;
  selectWorkspace: (id: string) => Promise<Workspace>;
  getTempWorkspace: (options?: { createNew?: boolean }) => Promise<Workspace | null>;
  touchWorkspace: (id: string) => Promise<Any>;
  /** Removes the workspace from CoWork with its sessions and memory; files stay. */
  removeWorkspace: (
    id: string,
  ) => Promise<{ removed: boolean; tasks: number; memoryErrors: string[] }>;
  updateWorkspacePermissions: (
    id: string,
    permissions: {
      network?: boolean;
      read?: boolean;
      write?: boolean;
      delete?: boolean;
      sandboxType?: SandboxType;
      spaceConfig?: SpaceSandboxConfig;
    },
  ) => Promise<Any>;
  getInputRequestDraftReview: (
    inputRequestId: string,
    taskId: string,
  ) => Promise<InlineApprovalDraftReview | undefined>;
  getApprovalDraftPreview: (approval: ApprovalRequest) => Promise<ApprovalDraftPreview[]>;
  respondToApproval: (data: ApprovalResponse) => Promise<ApprovalResponseStatus>;
  listRecurringApprovalRules: (
    workspaceId?: string,
    includeRevoked?: boolean,
  ) => Promise<RecurringApprovalRuleSummary[]>;
  revokeRecurringApprovalRule: (ruleId: string) => Promise<boolean>;
  createProtectedCredentialRequest: (request: {
    taskId?: string;
    name: string;
    destinationAllowlist: string[];
    expiresAt?: number;
  }) => Promise<ProtectedCredentialRequestSummary>;
  listProtectedCredentialRequests: (options?: {
    taskId?: string;
    includeResolved?: boolean;
  }) => Promise<ProtectedCredentialRequestSummary[]>;
  fulfillProtectedCredentialRequest: (
    requestId: string,
    value: string,
  ) => Promise<ProtectedCredentialSummary>;
  denyProtectedCredentialRequest: (requestId: string) => Promise<boolean>;
  listProtectedCredentials: () => Promise<ProtectedCredentialSummary[]>;
  revokeProtectedCredential: (credentialId: string) => Promise<boolean>;
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
  listManagedAgents: (params?: {
    limit?: number;
    offset?: number;
    status?: ManagedAgent["status"];
  }) => Promise<ManagedAgent[]>;
  getManagedAgent: (
    agentId: string,
  ) => Promise<{ agent: ManagedAgent; currentVersion?: ManagedAgentVersion } | null>;
  getManagedAgentRuntimeToolCatalog: (agentId: string) => Promise<ManagedAgentRuntimeToolCatalog>;
  generateManagedAgentPlan: (request: AgentBuilderPlanRequest) => Promise<AgentBuilderPlan>;
  createManagedAgentFromPlan: (
    request: AgentBuilderCreateRequest,
  ) => Promise<AgentBuilderCreateResult>;
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
  listManagedAgentAuditEntries: (
    agentId: string,
    limit?: number,
  ) => Promise<ManagedAgentAuditEntry[]>;
  getManagedAgentSlackDeploymentHealth: (
    agentId: string,
  ) => Promise<ManagedAgentSlackDeploymentHealth>;
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
    agentId?: string;
    workspaceId?: string;
    status?: ManagedSession["status"];
    surface?: ManagedSession["surface"];
  }) => Promise<ManagedSession[]>;
  getManagedSession: (sessionId: string) => Promise<ManagedSession | null>;
  createManagedSession: (request: ManagedSessionCreateInput) => Promise<ManagedSession>;
  sendManagedSessionUserMessage: (
    request: ManagedSessionUserMessageRequest,
  ) => Promise<ManagedSession | undefined>;
  correctManagedSessionRequirement: (
    request: ManagedSessionRequirementCorrectionRequest,
  ) => Promise<ManagedSession | undefined>;
  resumeManagedSession: (
    sessionId: string,
  ) => Promise<{ resumed: boolean; session?: ManagedSession }>;
  cancelManagedSession: (sessionId: string) => Promise<ManagedSession | undefined>;
  /** Write a handoff package for a managed session or a task under its workspace. */
  exportSessionHandoff: (request: {
    sessionId?: string;
    taskId?: string;
  }) => Promise<SessionHandoffExportResult>;
  getSessionMembers: (request: SessionMembersRequest) => Promise<SessionShareSnapshot>;
  createSessionInvite: (request: SessionInviteCreateInput) => Promise<SessionInviteCreateResult>;
  acceptSessionInvite: (request: SessionInviteAcceptInput) => Promise<SessionInviteAcceptResult>;
  updateSessionMember: (request: SessionMemberUpdateInput) => Promise<SessionHumanMember>;
  listManagedSessionEvents: (sessionId: string, limit?: number) => Promise<ManagedSessionEvent[]>;
  getManagedSessionWorkpaper: (sessionId: string) => Promise<ManagedSessionWorkpaper>;
  listAgentTemplates: () => Promise<AgentTemplate[]>;
  getMyAgentWorkspacePermissions: (
    workspaceId: string,
  ) => Promise<AgentWorkspacePermissionSnapshot>;
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
  listSkills: () => Promise<Any[]>;
  getSkill: (id: string) => Promise<Any>;
  // LLM Settings
  getLLMSettings: () => Promise<Any>;
  saveLLMSettings: (settings: Any) => Promise<{ success: boolean }>;
  resetLLMProviderCredentials: (providerType: LLMProviderType) => Promise<{ success: boolean }>;
  testLLMProvider: (config: Any) => Promise<{ success: boolean; error?: string }>;
  testJevProvider: (
    config: JevTestProviderRequest,
  ) => Promise<{ success: boolean; error?: string }>;
  getLLMModels: () => Promise<Array<{ key: string; displayName: string; description: string }>>;
  getTaskCostEstimate: (modelId: string) => Promise<{
    modelId: string;
    sampleSize: number;
    medianCost: number;
    p90Cost: number;
  } | null>;
  getLLMConfigStatus: () => Promise<{
    currentProvider: LLMProviderType;
    currentModel: string;
    currentReasoningEffort?: LLMReasoningEffort;
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
      reasoningEfforts?: LLMReasoningEffort[];
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
          reasoningEffort?: LLMReasoningEffort;
        },
  ) => Promise<{ success: boolean }>;
  getProviderModels: (providerType: string) => Promise<
    Array<{
      key: string;
      displayName: string;
      description: string;
      reasoningEfforts?: LLMReasoningEffort[];
    }>
  >;
  getAnthropicModels: (credentials?: {
    apiKey?: string;
    subscriptionToken?: string;
    authMethod?: "api_key" | "subscription";
  }) => Promise<Array<{ id: string; displayName: string; description: string }>>;
  refreshCustomProviderModels: (
    providerType: string,
    overrides?: { apiKey?: string; baseUrl?: string },
  ) => Promise<Array<{ key: string; displayName: string; description: string }>>;
  discoverAtomicChatModels: (overrides?: { apiKey?: string; baseUrl?: string }) => Promise<{
    status:
      | "success"
      | "valid_empty"
      | "unreachable"
      | "authentication_rejected"
      | "invalid_response"
      | "cancelled"
      | "timeout";
    models: Array<{ id: string; name: string }>;
    durationMs: number;
    error?: string;
  }>;
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
  getOpenRouterImageModels: (
    apiKey?: string,
    baseUrl?: string,
  ) => Promise<
    Array<{
      id: string;
      name: string;
      description: string;
      supported_parameters: Record<string, Any>;
    }>
  >;
  getOpenAIModels: (
    apiKey?: string,
  ) => Promise<Array<{ id: string; name: string; description: string }>>;
  getGroqModels: (
    apiKey?: string,
    baseUrl?: string,
  ) => Promise<Array<{ id: string; name: string }>>;
  getXAIModels: (apiKey?: string, baseUrl?: string) => Promise<Array<{ id: string; name: string }>>;
  xaiOAuthStart: () => Promise<{ success: boolean; error?: string }>;
  xaiOAuthLogout: () => Promise<{ success: boolean; error?: string }>;
  /** Signs in to OpenRouter in the browser; the key is stored in main and never returned. */
  openrouterOAuthStart: () => Promise<{ success: boolean; model?: string; error?: string }>;
  getDeepSeekModels: (
    apiKey?: string,
    baseUrl?: string,
  ) => Promise<Array<{ id: string; name: string }>>;
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
    options?: { cacheModels?: boolean },
  ) => Promise<Array<{ key: string; displayName: string; description: string }>>;
  // Local AI (MLX-LM + hf-agents + llama.cpp)
  checkHf?: () => Promise<{
    installed: boolean;
    hfInstalled?: boolean;
    version?: string;
    message?: string;
    mlxInstalled?: "ok" | "broken" | false;
    mlxMessage?: string;
    isMac?: boolean;
    isAppleSilicon?: boolean;
  }>;
  detectHardware?: () => Promise<{ ok: boolean; models: string[]; output: string; error?: string }>;
  startLocalAIServer?: (
    model?: string,
  ) => Promise<{ ok: boolean; pid?: number; alreadyRunning?: boolean; error?: string }>;
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
  openaiOAuthStart: (options?: { persist?: boolean }) => Promise<{
    success: boolean;
    error?: string;
    email?: string;
    recommendedModel?: string;
    tokens?: {
      accessToken: string;
      refreshToken: string;
      tokenExpiresAt: number;
      accountId?: string;
      email?: string;
      planType?: string;
    };
  }>;
  openaiOAuthLogout: () => Promise<{ success: boolean }>;
  /** Official Sign in with ChatGPT; persists the session on success. */
  openaiSiwcStart: () => Promise<{
    success: boolean;
    error?: string;
    email?: string;
    recommendedModel?: string;
  }>;
  getBedrockModels: (config?: {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    profile?: string;
  }) => Promise<Array<{ id: string; name: string; provider: string; description: string }>>;
  // Gateway / Channel APIs
  getGatewayChannels: () => Promise<Any[]>;
  listIntegrationMentionOptions: () => Promise<IntegrationMentionOption[]>;
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
  getGatewayChannelHealth: (id: string) => Promise<ChannelHealthResponse | null>;
  getTeamsMeetingSettings: () => Promise<TeamsMeetingSettingsView>;
  getTeamsMeetingStatus: () => Promise<TeamsMeetingStatus>;
  updateTeamsMeetingSettings: (
    update: TeamsMeetingSettingsUpdate,
  ) => Promise<TeamsMeetingSettingsView>;
  connectTeamsMeetings: (data: {
    clientId: string;
    tenant?: string;
  }) => Promise<TeamsMeetingStatus>;
  disconnectTeamsMeetings: () => Promise<void>;
  syncTeamsMeetingsNow: () => Promise<TeamsMeetingStatus>;
  retryFailedTeamsMeetings: () => Promise<TeamsMeetingStatus>;
  listMeetingArtifacts: (options?: {
    provider?: MeetingArtifactProvider;
    limit?: number;
  }) => Promise<MeetingArtifactSummary[]>;
  getMeetingArtifact: (
    id: string,
  ) => Promise<{ summary: MeetingArtifactSummary; markdown: string } | null>;
  downloadMeetingRecording: (artifactId: string, recordingId: string) => Promise<string>;
  revealMeetingArtifact: (id: string) => Promise<void>;
  onMeetingArtifactsChanged: (callback: () => void) => () => void;
  getGatewayUsers: (channelId: string) => Promise<Any[]>;
  getGatewayChats: (channelId: string) => Promise<Array<{ chatId: string; lastTimestamp: number }>>;
  sendGatewayTestMessage: (data: {
    channelType: string;
    channelDbId?: string;
    chatId: string;
  }) => Promise<{ ok: boolean }>;
  grantGatewayAccess: (
    channelId: string,
    userId: string,
    displayName?: string,
    contextType?: ContextTypeValue | "both",
  ) => Promise<void>;
  revokeGatewayAccess: (
    channelId: string,
    userId: string,
    contextType?: ContextTypeValue | "both",
  ) => Promise<void>;
  generateGatewayPairing: (
    channelId: string,
    userId: string,
    displayName?: string,
    contextType?: ContextTypeValue,
  ) => Promise<string>;
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
    primaryProvider:
      | "tavily"
      | "exa"
      | "brave"
      | "serpapi"
      | "google"
      | "searxng"
      | "duckduckgo"
      | null;
    fallbackProvider:
      | "tavily"
      | "exa"
      | "brave"
      | "serpapi"
      | "google"
      | "searxng"
      | "duckduckgo"
      | null;
  }>;
  saveSearchSettings: (settings: Any) => Promise<{ success: boolean }>;
  getSearchConfigStatus: () => Promise<{
    primaryProvider:
      | "tavily"
      | "exa"
      | "brave"
      | "serpapi"
      | "google"
      | "searxng"
      | "duckduckgo"
      | null;
    fallbackProvider:
      | "tavily"
      | "exa"
      | "brave"
      | "serpapi"
      | "google"
      | "searxng"
      | "duckduckgo"
      | null;
    providers: Array<{
      type: "tavily" | "exa" | "brave" | "serpapi" | "google" | "searxng" | "duckduckgo";
      name: string;
      description: string;
      configured: boolean;
      supportedTypes: Array<"web" | "news" | "images">;
    }>;
    isConfigured: boolean;
    searxng: {
      baseUrl?: string;
      allowPrivate: boolean;
    };
  }>;
  testSearchProvider: (providerType: string) => Promise<{ success: boolean; error?: string }>;
  listProfiles: () => Promise<AppProfileSummary[]>;
  createProfile: (name: string) => Promise<AppProfileSummary>;
  switchProfile: (profileId: string) => Promise<{ success: true; relaunching: true }>;
  exportProfile: (profileId: string, destinationRoot: string) => Promise<ProfileExportResult>;
  importProfile: (sourcePath: string, profileName?: string) => Promise<AppProfileSummary>;
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
    clientId?: string;
    clientSecret?: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    scopes?: string[];
    mcpEnabled?: boolean;
    timeoutMs?: number;
    brain?: BoxBrainSettings;
  }>;
  saveBoxSettings: (settings: Any) => Promise<{
    success: boolean;
    mcp?: { serverId?: string; connected?: boolean; error?: string };
  }>;
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
    mcpConfigured?: boolean;
    mcpConnected?: boolean;
    mcpError?: string;
  }>;
  getBoxBrainStatus: (workspaceId?: string) => Promise<BoxBrainStatus>;
  syncBoxBrainNow: (workspaceId?: string) => Promise<BoxBrainSyncResult>;
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
    /** Browser hosts return only this presence flag and never expose OAuth tokens. */
    credentialsConfigured?: boolean;
    clientId?: string;
    clientSecret?: string;
    builtinOAuthClientAvailable?: boolean;
    accounts?: Array<{
      email: string;
      name?: string;
      accessToken?: string;
      refreshToken?: string;
      tokenExpiresAt?: number;
      scopes?: string[];
      connectionMode?: "gmail" | "workspace";
      connectedAt?: number;
    }>;
    activeAccountEmail?: string;
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    scopes?: string[];
    timeoutMs?: number;
    connectionMode?: "gmail" | "workspace";
    loginHint?: string;
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
    missingScopes?: string[];
    connectionMode?: "gmail" | "workspace";
  }>;
  startGoogleWorkspaceOAuth: (payload: {
    clientId?: string;
    clientSecret?: string;
    scopes?: string[];
    connectionMode?: "gmail" | "workspace";
    loginHint?: string;
  }) => Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    tokenType?: string;
    scopes?: string[];
    email?: string;
  }>;
  getGoogleWorkspaceOAuthLink: (payload: {
    clientId?: string;
    clientSecret?: string;
    scopes?: string[];
    connectionMode?: "gmail" | "workspace";
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
  // App Updates
  getAppVersion: () => Promise<{
    version: string;
    isDev: boolean;
    isGitRepo: boolean;
    isNpmGlobal: boolean;
    gitBranch?: string;
    gitCommit?: string;
  }>;
  checkForUpdates: (
    intent?: import("../shared/types").UpdateCheckIntent,
  ) => Promise<import("../shared/types").UpdateInfo>;
  downloadUpdate: (updateInfo: Any) => Promise<{ success: boolean }>;
  installUpdate: () => Promise<{ success: boolean }>;
  /** Stop a packaged download in flight; false when nothing could be cancelled. */
  cancelUpdate: () => Promise<{ cancelled: boolean }>;
  /** "Check for Updates…": opens the update window with the answer. */
  openUpdateWindow: () => Promise<{ success: boolean }>;
  getUpdatePreferences: () => Promise<import("../shared/types").UpdatePreferences>;
  /** `skippedVersion: null` clears a skipped version. */
  setUpdatePreferences: (patch: {
    autoDownload?: boolean;
    skippedVersion?: string | null;
  }) => Promise<import("../shared/types").UpdatePreferences>;
  onUpdateProgress: (
    callback: (progress: import("../shared/types").UpdateProgress) => void,
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
  getPermissionRuntimeInfo: () => Promise<PermissionRuntimeInfo>;
  savePermissionSettings: (settings: PermissionSettingsData) => Promise<{ success: boolean }>;
  getWorkspacePermissionRules: (workspaceId: string) => Promise<PersistedPermissionRule[]>;
  deleteWorkspacePermissionRule: (payload: { workspaceId: string; ruleId: string }) => Promise<{
    success: boolean;
    removed: boolean;
    dbRemoved?: boolean;
    manifestRemoved?: boolean;
    manifestPath?: string;
    manifestError?: string;
  }>;
  // Appearance Settings
  getAppearanceSettings: () => Promise<{
    themeMode: "light" | "dark" | "system";
    visualTheme: "terminal" | "warm" | "oblivion" | "calm";
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
    commandOutputStyle?: "terminal" | "minimal";
    language?: string;
    devRunLoggingEnabled?: boolean;
    homeResearchVaultEnabled?: boolean;
    homeNextActionsEnabled?: boolean;
    costReceiptEnabled?: boolean;
    autoOpenTurnOutput?: boolean;
    subAgentStatsEnabled?: boolean;
    disclaimerAccepted?: boolean;
    onboardingCompleted?: boolean;
    onboardingCompletedAt?: string;
    assistantName?: string;
  }>;
  getAppearanceRuntimeInfo: () => Promise<{
    prefersReducedTransparency: boolean;
    devLogCaptureEnabled: boolean;
  }>;
  logRendererPerf: (payload: unknown) => Promise<{ success: boolean }>;
  saveAppearanceSettings: (settings: {
    themeMode?: "light" | "dark" | "system";
    visualTheme?: "terminal" | "warm" | "oblivion" | "calm";
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
    commandOutputStyle?: "terminal" | "minimal";
    language?: string;
    devRunLoggingEnabled?: boolean;
    homeResearchVaultEnabled?: boolean;
    homeNextActionsEnabled?: boolean;
    costReceiptEnabled?: boolean;
    autoOpenTurnOutput?: boolean;
    subAgentStatsEnabled?: boolean;
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
  getPersonalityConfigV2: () => Promise<Any>;
  /** `responseStyleBaseline`: the style the form loaded (tells a user change from a stale copy). */
  savePersonalityConfigV2: (
    config: Any,
    options?: { responseStyleBaseline?: object | null },
  ) => Promise<{ success: boolean }>;
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
  getWatchdogSettings: () => Promise<WatchdogSettings>;
  saveWatchdogSettings: (
    settings: Partial<WatchdogSettings>,
  ) => Promise<{ success: boolean; settings: WatchdogSettings }>;
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
  installSkillFromRegistry: (
    skillId: string,
    version?: string,
  ) => Promise<{
    success: boolean;
    skill?: CustomSkill;
    error?: string;
    security?: import("../shared/types").InstallSecurityOutcome;
  }>;
  installSkillFromClawHub: (identifierOrUrl: string) => Promise<{
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
  installSkillFromGit: (gitUrl: string) => Promise<{
    success: boolean;
    skill?: CustomSkill;
    error?: string;
    security?: import("../shared/types").InstallSecurityOutcome;
    /** Per-bundle outcomes when the repository held several skills. */
    results?: Array<{
      bundle: string;
      success: boolean;
      skill?: CustomSkill;
      error?: string;
      security?: Partial<import("../shared/types").InstallSecurityOutcome>;
    }>;
  }>;
  uninstallSkill: (skillId: string) => Promise<{ success: boolean; error?: string }>;
  getSkillStatus: () => Promise<SkillStatusReport>;
  listQuarantinedImports: () => Promise<import("../shared/types").QuarantinedImportRecord[]>;
  retryQuarantinedImport: (
    recordId: string,
  ) => Promise<import("../shared/types").RetryQuarantinedImportResult>;
  removeQuarantinedImport: (recordId: string) => Promise<{ success: boolean; error?: string }>;
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
  deviceListFiles: (params: { nodeId: string; workspaceId: string; path?: string }) => Promise<{
    ok: boolean;
    files?: Array<{ name: string; type: "file" | "directory"; size: number }>;
    error?: string;
  }>;
  deviceListRemoteWorkspaces: (nodeId: string) => Promise<{
    ok: boolean;
    workspaces?: Array<{ id: string; name: string }>;
    error?: string;
  }>;
  addRemoteOAuthMCPServer: (
    payload: RemoteOAuthServerRequest,
  ) => Promise<{ id: string; name: string }>;
  updateRemoteOAuthMCPServer: (
    payload: RemoteOAuthServerUpdateRequest,
  ) => Promise<{ id: string; name: string; signedOut: boolean }>;
  cancelMCPOAuth: (serverId: string) => Promise<{ cancelled: boolean }>;
  discoverMCPOAuth: (url: string) => Promise<{
    authorizationUrl?: string;
    tokenUrl?: string;
    scopes?: string[];
    resource?: string;
    issuer?: string;
  }>;
  authorizeMCPServer: (serverId: string) => Promise<RemoteOAuthAuthorizeResult>;
  saveWorkdayAdminConnection: (
    payload: WorkdayAdminConnectionRequest,
  ) => Promise<WorkdayAdminConnectionSummary>;
  signInWorkdayAdmin: (serverId: string) => Promise<WorkdayAdminSignInResult>;
  cancelWorkdayAdminSignIn: (serverId: string) => Promise<{ cancelled: boolean }>;
  listWorkdayAgents: (serverId: string) => Promise<WorkdayAgentListResult>;
  searchWorkdayAgentResources: (
    payload: WorkdayAgentSearchRequest,
  ) => Promise<WorkdayAgentSearchResult>;
  saveWorkdayAgent: (payload: WorkdayAgentSaveRequest) => Promise<WorkdayAgentSaveResult>;
  startConnectorOAuth: (payload: {
    provider:
      | "box"
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
    prompt?: "select_account" | "consent";
  }) => Promise<{
    provider:
      | "box"
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
  // Secure MCP Tunnels
  getSecureMcpTunnelSettings: () => Promise<
    import("../shared/types").SecureMcpTunnelDisplaySettings
  >;
  createSecureMcpTunnel: (input: {
    name: string;
    relayUrl: string;
    targetType: import("../shared/types").SecureMcpTunnelTargetType;
    targetUrl?: string;
    coworkHostPort?: number;
    clientToken?: string;
    callerToken?: string;
    policy?: Partial<import("../shared/types").SecureMcpTunnelPolicy>;
    enabled?: boolean;
  }) => Promise<import("../shared/types").SecureMcpTunnelDisplayConfig>;
  updateSecureMcpTunnel: (
    id: string,
    updates: Partial<{
      name: string;
      relayUrl: string;
      targetType: import("../shared/types").SecureMcpTunnelTargetType;
      targetUrl?: string;
      coworkHostPort?: number;
      clientToken?: string;
      callerToken?: string;
      policy?: Partial<import("../shared/types").SecureMcpTunnelPolicy>;
      enabled?: boolean;
    }>,
  ) => Promise<import("../shared/types").SecureMcpTunnelDisplayConfig>;
  deleteSecureMcpTunnel: (id: string) => Promise<{ success: boolean }>;
  startSecureMcpTunnel: (id: string) => Promise<import("../shared/types").SecureMcpTunnelStatus>;
  stopSecureMcpTunnel: (
    id: string,
  ) => Promise<import("../shared/types").SecureMcpTunnelStatus | null>;
  getSecureMcpTunnelStatus: () => Promise<import("../shared/types").SecureMcpTunnelStatus[]>;
  getSecureMcpTunnelAudit: (
    id?: string,
  ) => Promise<import("../shared/types").SecureMcpTunnelAuditEvent[]>;
  onSecureMcpTunnelStatusChange: (
    callback: (status: import("../shared/types").SecureMcpTunnelStatus[]) => void,
  ) => () => void;
  // Built-in Tools Settings
  getBuiltinToolsSettings: () => Promise<BuiltinToolsSettings>;
  saveBuiltinToolsSettings: (settings: BuiltinToolsSettings) => Promise<{ success: boolean }>;
  getBuiltinToolsCategories: () => Promise<Record<string, string[]>>;
  getChronicleSettings: () => Promise<ChronicleSettings>;
  saveChronicleSettings: (
    settings: Partial<ChronicleSettings>,
  ) => Promise<{ success: boolean; settings: ChronicleSettings }>;
  getChronicleStatus: () => Promise<ChronicleCaptureStatus>;
  listChronicleObservations: (input: { workspaceId: string; limit?: number }) => Promise<Any[]>;
  deleteChronicleObservation: (input: {
    workspaceId: string;
    observationId: string;
  }) => Promise<{ success: boolean }>;
  clearChronicleObservations: (input: {
    workspaceId: string;
  }) => Promise<{ success: boolean; deleted?: number }>;
  getComputerUseStatus: () => Promise<{
    activeTaskId: string | null;
    platform: string;
    helperPath: string;
    sourcePath: string | null;
    installed: boolean;
    accessibilityTrusted: boolean;
    screenCaptureStatus: string;
    error: string | null;
  }>;
  computerEnvironmentAction: (
    taskId: string,
    action: "status" | "reconcile" | "finish",
  ) => Promise<unknown>;
  getCuaSpaceSettings: () => Promise<CuaSpaceDisplaySettings>;
  /** Rejects with the validation reason when an enabled Space URL or token is unusable. */
  saveCuaSpaceSettings: (update: CuaSpaceSettingsUpdate) => Promise<CuaSpaceDisplaySettings>;
  /** Checks the saved Space: reachable, and the token is accepted by cua-spacesd. */
  testCuaSpaceConnection: () => Promise<CuaSpaceConnectionResult>;
  getAndroidPhoneStatus: () => Promise<AndroidPhoneStatus>;
  saveAndroidPhoneSettings: (settings: AndroidPhoneSettings) => Promise<AndroidPhoneSettings>;
  installAndroidPhoneRuntime: () => Promise<void>;
  stopAndroidPhone: () => Promise<void>;
  endComputerUseSession: () => Promise<{ success: boolean }>;
  openComputerUseAccessibilitySettings: () => Promise<{ success: boolean }>;
  openComputerUseScreenRecordingSettings: () => Promise<{ success: boolean }>;
  onComputerUseEvent: (callback: (event: Any) => void) => () => void;
  /** Starts showing a task's computer in the bot's panel; returns its current state. */
  watchComputerView: (taskId: string) => Promise<ComputerViewState>;
  unwatchComputerView: (taskId: string) => Promise<void>;
  /** The person takes over: the bot's computer and browser actions are refused until hand-back. */
  takeOverComputer: (taskId: string) => Promise<ComputerViewState>;
  handBackComputer: (taskId: string) => Promise<ComputerViewState>;
  /** Opens the bot's own desktop in a window (full view; you can use it after taking over). */
  openBotDesktop: (taskId: string) => Promise<{ opened: boolean }>;
  stopBotDesktop: (taskId: string) => Promise<{ stopped: boolean }>;
  /** The newest files in the bot's work folder on its own desktop. */
  listBotDesktopFiles: (
    taskId: string,
  ) => Promise<Array<{ path: string; size: number; modifiedAt: number }>>;
  revealBotDesktopFile: (taskId: string, filePath: string) => Promise<{ revealed: boolean }>;
  /** Teach a task: starts recording what you do on the bot's desktop (after taking over). */
  startTeachingTask: (taskId: string) => Promise<{ recording: boolean }>;
  /** Stops recording; saves it under the name, or discards it when the name is null. */
  finishTeachingTask: (
    taskId: string,
    name: string | null,
  ) => Promise<import("../shared/bot-computer").TaughtTask | null>;
  listTaughtTasks: (taskId: string) => Promise<import("../shared/bot-computer").TaughtTask[]>;
  deleteTaughtTask: (taskId: string, taughtTaskId: string) => Promise<{ deleted: boolean }>;
  onComputerViewEvent: (callback: (state: ComputerViewState) => void) => () => void;
  // Tray (Menu Bar)
  getTraySettings: () => Promise<TraySettings>;
  saveTraySettings: (
    settings: Partial<TraySettings>,
  ) => Promise<{ success: boolean; settings: TraySettings }>;
  onTrayNewTask: (callback: () => void) => () => void;
  onTraySelectWorkspace: (callback: (event: Any, workspaceId: string) => void) => () => void;
  onTrayOpenSettings: (callback: () => void) => () => void;
  onTrayOpenAbout: (callback: () => void) => () => void;
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
  onNavigateToBotConversation: (
    callback: (payload: { botId: string; conversationId?: string }) => void,
  ) => () => void;
  // Hooks (Webhooks & Gmail Pub/Sub)
  getHooksSettings: () => Promise<HooksSettings>;
  saveHooksSettings: (settings: Partial<HooksSettings>) => Promise<HooksSettings>;
  enableHooks: () => Promise<{ enabled: boolean; gmailWatcherError?: string }>;
  disableHooks: () => Promise<{ enabled: boolean }>;
  regenerateHookToken: () => Promise<{ token: string }>;
  getHooksStatus: () => Promise<HooksStatus>;
  configureGmailHooks: (
    config: GmailHooksConfig,
  ) => Promise<{ ok: boolean; gmail?: GmailHooksConfig }>;
  getGmailHooksStatus: () => Promise<GmailHooksStatus>;
  startGmailWatcher: () => Promise<{ ok: boolean; error?: string }>;
  stopGmailWatcher: () => Promise<{ ok: boolean }>;
  listRoutines: () => Promise<Any[]>;
  getRoutine: (id: string) => Promise<Any | null>;
  listRoutineRuns: (routineId?: string, limit?: number) => Promise<Any[]>;
  createRoutine: (data: Any) => Promise<Any>;
  updateRoutine: (id: string, updates: Any) => Promise<Any | null>;
  removeRoutine: (id: string) => Promise<boolean>;
  runRoutineNow: (id: string) => Promise<Any | null>;
  regenerateRoutineApiToken: (routineId: string, triggerId: string) => Promise<Any | null>;
  getRoutineWorkflowCapabilities: () => Promise<Any>;
  validateRoutineWorkflow: (workflow: Any, allowIncomplete?: boolean) => Promise<Any>;
  generateRoutineWorkflow: (prompt: string) => Promise<Any>;
  saveRoutineWorkflowDraft: (routineId: string, workflow: Any) => Promise<Any>;
  listRoutineWorkflowVersions: (routineId: string) => Promise<Any[]>;
  activateRoutineWorkflowVersion: (routineId: string, versionId: string) => Promise<Any | null>;
  testRoutineWorkflow: (request: Any) => Promise<Any>;
  listRoutineWorkflowRuns: (routineId?: string, limit?: number) => Promise<Any[]>;
  listRoutineWorkflowRunSteps: (runId: string) => Promise<Any[]>;
  respondToRoutineWorkflowApproval: (request: Any) => Promise<Any>;
  cancelRoutineWorkflowRun: (runId: string) => Promise<Any | null>;
  listRoutineWorkflowSecrets: () => Promise<Any[]>;
  upsertRoutineWorkflowSecret: (input: {
    id?: string;
    name: string;
    value: string;
  }) => Promise<Any>;
  removeRoutineWorkflowSecret: (id: string) => Promise<boolean>;

  // Control Plane (WebSocket Gateway)
  getControlPlaneSettings: () => Promise<ControlPlaneSettingsData>;
  saveControlPlaneSettings: (
    settings: Partial<ControlPlaneSettingsData>,
  ) => Promise<{ ok: boolean; error?: string }>;
  enableControlPlane: () => Promise<{
    ok: boolean;
    token?: string;
    error?: string;
  }>;
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
  regenerateControlPlaneToken: () => Promise<{
    ok: boolean;
    token?: string;
    error?: string;
  }>;

  // Tailscale
  checkTailscaleAvailability: () => Promise<TailscaleAvailability>;
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
  testSSHTunnelConnection: (
    config: SSHTunnelConfig,
  ) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;

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
  canvasGetSession: (sessionId: string) => Promise<CanvasSession | null>;
  canvasListSessions: (taskId?: string) => Promise<CanvasSession[]>;
  canvasShow: (sessionId: string) => Promise<{ success: boolean }>;
  canvasClose: (sessionId: string) => Promise<{ success: boolean }>;
  canvasSnapshot: (
    sessionId: string,
  ) => Promise<{ imageBase64: string; width: number; height: number }>;
  canvasExportHTML: (sessionId: string) => Promise<{ content: string; filename: string }>;
  canvasExportToFolder: (data: {
    sessionId: string;
  }) => Promise<{ files: string[]; targetDir: string } | null>;
  canvasOpenInBrowser: (sessionId: string) => Promise<{ success: boolean; path: string }>;
  canvasGetSessionDir: (sessionId: string) => Promise<string | null>;
  onCanvasEvent: (callback: (event: CanvasEvent) => void) => () => void;

  // Device Management
  deviceListTasks: (nodeId: string) => Promise<{ ok: boolean; tasks?: Any[]; error?: string }>;
  deviceAssignTask: (params: {
    nodeId: string;
    prompt: string;
    workspaceId?: string;
    agentConfig?: Any;
    accessProfileId?: string;
    shellAccess?: boolean;
  }) => Promise<{ ok: boolean; taskId?: string; error?: string }>;

  // Memory System
  getMemorySettings: (workspaceId: string) => Promise<MemorySettings>;
  saveMemorySettings: (data: {
    workspaceId: string;
    settings: Partial<MemorySettings>;
  }) => Promise<{ success: boolean }>;
  getMemoryTimeline: (data: {
    workspaceId: string;
    memoryId: string;
    windowSize?: number;
  }) => Promise<MemoryTimelineEntry[]>;
  getMemoryDetails: (data: { workspaceId: string; ids: string[] }) => Promise<Memory[]>;
  searchMemoryObservations: (
    data: MemoryObservationSearchQuery,
  ) => Promise<MemoryObservationSearchResult[]>;
  getMemoryObservationTimeline: (data: {
    workspaceId: string;
    memoryId?: string;
    query?: string;
    windowSize?: number;
  }) => Promise<MemoryObservationTimelineEntry[]>;
  getMemoryObservationDetails: (data: {
    workspaceId: string;
    ids: string[];
  }) => Promise<MemoryObservationMetadata[]>;
  updateMemoryObservation: (data: {
    workspaceId: string;
    memoryId: string;
    patch: Partial<MemoryObservationMetadata>;
  }) => Promise<MemoryObservationMetadata | null>;
  deleteMemoryObservation: (data: {
    workspaceId: string;
    memoryId: string;
  }) => Promise<{ success: boolean }>;
  redactMemoryObservation: (data: {
    workspaceId: string;
    memoryId: string;
    replacement?: string;
  }) => Promise<MemoryObservationMetadata | null>;
  promoteMemoryObservation: (data: {
    workspaceId: string;
    memoryId: string;
    target?: "user" | "workspace";
    kind?: string;
  }) => Promise<{ success: boolean; error?: string; staged?: boolean; pendingId?: string }>;
  rebuildMemoryObservationMetadata: (data?: {
    force?: boolean;
  }) => Promise<MemoryObservationBackfillStatus>;
  getMemoryObservationBackfillStatus: () => Promise<MemoryObservationBackfillStatus>;
  getRecentMemories: (data: { workspaceId: string; limit?: number }) => Promise<Memory[]>;
  getMemoryStats: (workspaceId: string) => Promise<MemoryStats>;
  clearMemory: (
    workspaceId: string,
    expectedTaskIds?: string[],
  ) => Promise<{
    success: boolean;
    /** Rows/files removed per memory store (see MemoryWorkspacePurgeService). */
    counts?: Record<string, number>;
    errors?: Record<string, string>;
    notes?: string[];
  }>;
  getMemoryClearScope: (
    workspaceId: string,
  ) => Promise<{ tasks: Array<{ id: string; title: string; parentTaskId: string | null }> }>;
  clearSessionMemory: (
    workspaceId: string,
    taskId: string,
  ) => Promise<{
    success: boolean;
    counts?: Record<string, number>;
    errors?: Record<string, string>;
    notes?: string[];
  }>;

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
  listRelationshipMemory: (data?: {
    layer?: "identity" | "preferences" | "context" | "commitments";
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
  getOpenCommitments: (limit?: number) => Promise<Any[]>;
  getDueSoonCommitments: (windowHours?: number) => Promise<{ items: Any[]; reminderText: string }>;
  listMemoryItems: (data: MemoryHubListRequest) => Promise<MemoryHubListResult>;
  getMemoryItem: (data: { workspaceId: string; id: string }) => Promise<MemoryHubItemDetail>;
  /** Per-reply "Memory used" of a task (hidden memory_used events attributed to replies). */
  getMemoryUsedForTask: (data: {
    workspaceId: string;
    taskId: string;
  }) => Promise<MemoryUsedForTask>;
  addMemoryItem: (data: {
    workspaceId: string;
    content: string;
    kind: MemoryHubAddableKind;
    scope: "global" | "workspace";
    pinned?: boolean;
  }) => Promise<MemoryHubMutationResult>;
  updateMemoryItem: (data: {
    workspaceId: string;
    id: string;
    content: string;
  }) => Promise<MemoryHubMutationResult>;
  setMemoryItemPinned: (data: {
    workspaceId: string;
    id: string;
    pinned: boolean;
  }) => Promise<MemoryHubMutationResult>;
  deleteMemoryItem: (data: { workspaceId: string; id: string }) => Promise<MemoryHubMutationResult>;
  getMemoryItemWhy: (data: { workspaceId: string; id: string }) => Promise<MemoryHubWhy>;
  clearGlobalMemoryItems: (data: {
    workspaceId: string;
    confirm: true;
  }) => Promise<{ success: boolean; deleted: number }>;
  getMemoryReview: (data: { workspaceId: string }) => Promise<MemoryReviewState>;
  undoMemoryChange: (data: {
    workspaceId: string;
    id: string;
  }) => Promise<MemoryReviewMutationResult>;
  getMemorySources: (data: { workspaceId: string }) => Promise<MemorySourcesReport>;
  getMemoryHealth: (data: { workspaceId: string }) => Promise<MemoryHealthReport>;
  getAnswerSurfaceState: (data: {
    taskId: string;
    keys: string[];
  }) => Promise<Record<string, Record<string, unknown>>>;
  saveAnswerSurfaceState: (data: {
    taskId: string;
    key: string;
    state: Record<string, unknown>;
    summary: string;
  }) => Promise<{ ok: true }>;
  resolveAnswerImages: (data: {
    taskId?: string;
    requests: AnswerImageRequest[];
  }) => Promise<Array<AnswerImageResult | null>>;
  /** Desktop only; absent in the browser host, where frames stay static. */
  registerHtmlSurface?: (data: {
    html: string;
    theme: "light" | "dark";
    hostBackground?: string;
    designLanguage: boolean;
  }) => Promise<{ url: string }>;
  /** Desktop only: the sandboxed page that runs answer-surface logic in workers. */
  getAnswerSurfaceLogicRunner?: () => Promise<{ url: string }>;
  /** Desktop only: workspace data files a surface's logic computes from. */
  loadAnswerSurfaceData?: (data: {
    taskId: string;
    sources: import("../shared/answer-surfaces/data").AnswerSurfaceData;
  }) => Promise<Record<string, import("../shared/answer-surfaces/data").AnswerDataResult>>;
  /** Desktop only: a .glb/.gltf from the workspace or one Meshy saved, for the 3D viewer. */
  readModel3d?: (data: {
    filePath: string;
    workspacePath?: string;
  }) => Promise<import("../shared/meshy").Model3dFile>;
  getMeshyStatus?: () => Promise<import("../shared/meshy").MeshyStatus>;
  getMeshyTask?: (data: { taskId: string }) => Promise<import("../shared/meshy").MeshyTaskInfo>;
  getMeshyFormats?: (data: {
    taskId: string;
    beside?: string;
    workspacePath?: string;
  }) => Promise<import("../shared/meshy").MeshyFormatOption[]>;
  saveMeshyFormat?: (data: {
    taskId: string;
    format: string;
    beside?: string;
    workspacePath?: string;
    chatTaskId?: string;
    reveal?: boolean;
  }) => Promise<{ path: string }>;
  getMeshyActions?: (data: { taskId: string }) => Promise<{
    balance: number | null;
    actions: import("../shared/meshy").MeshyNextAction[];
  }>;
  getMeshyGallery?: (data?: { limit?: number }) => Promise<import("../shared/meshy").MeshyGallery>;
  getMeshyImage?: (data: { url: string }) => Promise<{ dataUrl: string }>;
  revealMeshyModel?: (data: { filePath: string }) => Promise<{ success: boolean; error?: string }>;
  getMemoryRepoStatus: () => Promise<MemoryRepoStatusReport>;
  openMemoryRepoFolder: () => Promise<{ success: true }>;
  compactMemoryRepoHistory: () => Promise<MemoryRepoCompactResult>;
  syncMemoryRepoNow: () => Promise<MemoryRepoSyncNowResult>;
  getBotMemory: (data: { botId: string }) => Promise<MemoryRepoBotMemoryReport>;
  forgetBotMemoryEntry: (data: {
    botId: string;
    ref: string;
    hash: string;
  }) => Promise<MemoryRepoEntryActionResult>;
  undoBotMemoryChange: (data: {
    botId: string;
    commit: string;
  }) => Promise<MemoryRepoEntryActionResult>;
  deleteBotMemory: (data: {
    botId: string;
  }) => Promise<MemoryRepoEntryActionResult & { entries?: number }>;

  // PACT business agents. Sign-in links never reach the desktop renderer; openPactSignIn
  // opens the business's own login in the system browser from main.
  getPactStatus: () => Promise<PactStatusView>;
  getPactSettings: () => Promise<PactSettings>;
  updatePactSettings: (data: PactSettingsUpdate) => Promise<PactSettings>;
  setPactSignerCredential: (data: {
    credential: string | null;
  }) => Promise<{ configured: boolean }>;
  createPactDeviceKey: () => Promise<{ publicJwk: Record<string, unknown> }>;
  discoverPactBusiness: (data: {
    domain?: string;
    cardUrl?: string;
    refresh?: boolean;
  }) => Promise<{
    business: PactBusinessView;
    route: { route: string; reason: string; message?: string };
  }>;
  listPactBusinesses: () => Promise<PactBusinessView[]>;
  getPactConversation: (data: { id: string }) => Promise<PactConversationView>;
  listPactConversations: (data: {
    businessId?: string;
    taskId?: string;
    limit?: number;
  }) => Promise<PactConversationView[]>;
  sendPactMessage: (data: PactSendRequestInput) => Promise<PactSendOutcome>;
  acknowledgePactEvidence: (data: { id: string }) => Promise<PactConversationView>;
  startPactAuthorization: (data: {
    businessId: string;
    scopes: string[];
    purpose?: string;
  }) => Promise<PactAuthorizationView>;
  getPactAuthorization: (data: { id: string }) => Promise<PactAuthorizationView>;
  getPactAuthorizationForInput: (data: {
    inputRequestId: string;
  }) => Promise<PactAuthorizationView>;
  listPactAuthorizations: (data: {
    pendingOnly?: boolean;
    taskId?: string;
  }) => Promise<PactAuthorizationView[]>;
  cancelPactAuthorization: (data: { id: string }) => Promise<PactAuthorizationView>;
  openPactSignIn: (data: {
    id: string;
  }) => Promise<{ opened: true; verificationOrigin: string; userCode: string }>;
  /** Browser build only: the link, for the owner's own browser tab. */
  getPactSignIn?: (data: { id: string }) => Promise<PactAuthorizationSignIn>;
  listPactGrants: () => Promise<PactGrantView[]>;
  disconnectPactGrant: (data: {
    id: string;
  }) => Promise<{ grant: PactGrantView; revokedAtBusiness: false }>;
  getPactReceipt: (data: { id: string }) => Promise<PactReceiptView>;
  readMemoryRepoLines: (refs: string[]) => Promise<MemoryRepoLine[]>;
  getMemoryRepoDreams: () => Promise<MemoryRepoDreamsReport>;
  getMemoryRepoDreamDiff: (id: string, part: MemoryRepoDreamPart) => Promise<string>;
  acceptMemoryRepoDream: (id: string) => Promise<MemoryRepoDreamActionResult>;
  rejectMemoryRepoDream: (id: string) => Promise<MemoryRepoDreamActionResult>;
  undoMemoryRepoDream: (id: string) => Promise<MemoryRepoDreamActionResult>;
  dreamMemoryRepoNow: () => Promise<MemoryRepoDreamNowResult>;
  getMemoryRepoEntries: (data: { workspaceId: string }) => Promise<MemoryRepoEntriesReport>;
  updateMemoryRepoEntry: (data: {
    workspaceId: string;
    ref: string;
    hash: string;
    text: string;
  }) => Promise<MemoryRepoEntryActionResult>;
  removeMemoryRepoEntry: (data: {
    workspaceId: string;
    ref: string;
    hash: string;
  }) => Promise<MemoryRepoEntryActionResult>;
  pinMemoryRepoEntry: (data: {
    workspaceId: string;
    ref: string;
    hash: string;
  }) => Promise<MemoryRepoEntryActionResult>;
  openMemoryRepoFile: (data: { workspaceId: string; path: string }) => Promise<{ success: true }>;
  keepMemoryRepoEntry: (data: {
    workspaceId: string;
    ref: string;
    hash: string;
    target: MemoryRepoKeepTarget;
  }) => Promise<MemoryRepoEntryActionResult>;
  importMemoryRepoFolder: () => Promise<MemoryRepoImportResult>;
  detectAgentImports: () => Promise<AgentImportDetection[]>;
  previewAgentImport: (request: {
    source: AgentImportSource;
    withSecrets?: boolean;
  }) => Promise<AgentImportPreview>;
  applyAgentImport: (request: AgentImportRequest) => Promise<AgentImportResult>;
  getAwarenessConfig: () => Promise<Any>;
  saveAwarenessConfig: (config: Any) => Promise<Any>;
  listAwarenessBeliefs: (workspaceId?: string) => Promise<Any[]>;
  updateAwarenessBelief: (id: string, patch: Any) => Promise<Any | null>;
  deleteAwarenessBelief: (id: string) => Promise<{ success: boolean }>;
  getAwarenessSummary: (workspaceId?: string) => Promise<Any>;
  // Memory Features (global toggles)
  getMemoryFeaturesSettings: () => Promise<MemoryFeaturesSettings>;
  saveMemoryFeaturesSettings: (settings: MemoryFeaturesSettings) => Promise<{ success: boolean }>;
  getMemoryLayerPreview: (workspaceId: string) => Promise<MemoryLayerPreviewPayload | null>;
  listMemoryWriteApprovals: (data?: {
    workspaceId?: string;
    limit?: number;
  }) => Promise<MemoryWriteApprovalItem[]>;
  getMemoryWriteApproval: (id: string) => Promise<MemoryWriteApprovalItem | null>;
  approveMemoryWriteApproval: (data: {
    id: string;
    workspaceId?: string;
  }) => Promise<MemoryWriteApprovalItem>;
  rejectMemoryWriteApproval: (data: {
    id: string;
    workspaceId?: string;
    reason?: string;
  }) => Promise<MemoryWriteApprovalItem>;
  countMemoryWriteApprovals: (workspaceId?: string) => Promise<{ pending: number }>;

  // Subconscious loop
  getSubconsciousSettings: () => Promise<SubconsciousSettings>;
  saveSubconsciousSettings: (settings: SubconsciousSettings) => Promise<SubconsciousSettings>;
  getSubconsciousBrain: () => Promise<SubconsciousBrainSummary>;
  listSubconsciousTargets: (workspaceId?: string) => Promise<SubconsciousTargetSummary[]>;
  getSubconsciousTargetDetail: (targetKey: string) => Promise<SubconsciousTargetDetail | null>;
  refreshSubconsciousTargets: () => Promise<SubconsciousRefreshResult>;
  runSubconsciousNow: (targetKey?: string) => Promise<SubconsciousRun | null>;
  dismissSubconsciousTarget: (targetKey: string) => Promise<SubconsciousTargetSummary | undefined>;
  resetSubconsciousHistory: () => Promise<SubconsciousHistoryResetResult>;

  // Workspace Kit (.cowork)
  getWorkspaceKitStatus: (workspaceId: string) => Promise<WorkspaceKitStatus>;
  initWorkspaceKit: (request: WorkspaceKitInitRequest) => Promise<WorkspaceKitStatus>;
  applyOnboardingProfile: (
    request: ApplyOnboardingProfileRequest,
  ) => Promise<ApplyOnboardingProfileResult>;
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
  getBotNotificationPolicy: (agentRoleId: string) => Promise<BotNotificationPolicy>;
  updateBotNotificationPolicy: (
    request: UpdateBotNotificationPolicyRequest,
  ) => Promise<BotNotificationPolicy>;

  // Mission Control - Company Ops / Planner
  listCompanies: () => Promise<import("../shared/types").Company[]>;
  getCommandCenterSummary: (
    companyId: string,
  ) => Promise<import("../shared/types").CompanyCommandCenterSummary>;
  retryAutomationOutcomeNotification: (outcomeId: string) => Promise<AutomationRunOutcome>;
  listMissionControlItems: (
    request?: import("../shared/types").MissionControlListRequest,
  ) => Promise<import("../shared/types").MissionControlItem[]>;
  getMissionControlItemEvidence: (
    itemId: string,
  ) => Promise<import("../shared/types").MissionControlItemEvidence[]>;
  refreshMissionControl: (
    request?: import("../shared/types").MissionControlScopeRequest,
  ) => Promise<import("../shared/types").MissionControlBrief>;
  listCompanyGoals: (companyId: string) => Promise<import("../shared/types").Goal[]>;
  listCompanyProjects: (companyId: string) => Promise<import("../shared/types").Project[]>;
  createProject: (
    input: import("../shared/types").ProjectCreateInput,
  ) => Promise<import("../shared/types").Project>;
  listCompanyIssues: (
    companyId: string,
    limit?: number,
  ) => Promise<import("../shared/types").Issue[]>;
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
      policyBlocked?: boolean;
      policyRequired?: boolean;
      securityReport?: import("../shared/types").CapabilitySecurityReport;
      removable?: boolean;
    }>
  >;
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
    pact?: { enabled: boolean; autoRoute: boolean; blockedProviders: string[] };
    agents: { maxHeartbeatFrequencySec: number; maxConcurrentAgents: number };
    runtime: {
      allowedPermissionModes: PermissionMode[];
      allowedSandboxTypes: Array<"macos" | "docker" | "space" | "none">;
      requireSandboxForShell: boolean;
      allowUnsandboxedShell: boolean;
      network: {
        defaultAction: "allow" | "deny";
        allowedDomains: string[];
        blockedDomains: string[];
        allowShellNetwork: boolean;
      };
      agentSecurity: import("../shared/agent-security").AgentSecurityPolicy;
    };
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
    pact?: { enabled: boolean; autoRoute: boolean; blockedProviders: string[] };
    agents: { maxHeartbeatFrequencySec: number; maxConcurrentAgents: number };
    runtime: {
      allowedPermissionModes: PermissionMode[];
      allowedSandboxTypes: Array<"macos" | "docker" | "space" | "none">;
      requireSandboxForShell: boolean;
      allowUnsandboxedShell: boolean;
      network: {
        defaultAction: "allow" | "deny";
        allowedDomains: string[];
        blockedDomains: string[];
        allowShellNetwork: boolean;
      };
      agentSecurity: import("../shared/agent-security").AgentSecurityPolicy;
    };
    general: {
      allowCustomPacks: boolean;
      allowGitInstall: boolean;
      allowUrlInstall: boolean;
      orgName?: string;
      orgPluginDir?: string;
    };
  }>;

  // Agent Security
  agentSecurityGetStatus: (refresh?: boolean) => Promise<AgentSecurityRuntimeStatus>;
  agentSecurityListFindings: (query?: AgentSecurityFindingQuery) => Promise<AgentSecurityFinding[]>;
  agentSecurityUpdateFinding: (
    findingId: string,
    status: AgentSecurityFindingStatus,
  ) => Promise<AgentSecurityFinding | null>;
  agentSecurityListDiagnostics: (limit?: number) => Promise<AgentSecurityDiagnostic[]>;
  agentSecurityListInventory: () => Promise<AgentSecurityInventoryItem[]>;
  agentSecurityRefreshInventory: () => Promise<AgentSecurityInventoryItem[]>;
  agentSecurityScan: () => Promise<AgentSecurityScanResult>;
  agentSecurityCheckRules: () => Promise<AgentSecurityRulesCheckResult>;
  agentSecurityInstallHook: (agent: string) => Promise<AgentSecurityHookManagementResult>;
  agentSecurityUninstallHook: (agent: string) => Promise<AgentSecurityHookManagementResult>;

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
  // Mission Control - Heartbeat APIs
  listAutomationProfiles: () => Promise<AutomationProfileData[]>;
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
  listCoreEvalCases: (
    request?: import("../shared/types").ListCoreEvalCasesRequest,
  ) => Promise<CoreEvalCase[]>;
  listCoreExperiments: (
    request?: import("../shared/types").ListCoreExperimentsRequest,
  ) => Promise<CoreHarnessExperiment[]>;
  listCoreLearnings: (
    request?: import("../shared/types").ListCoreLearningsRequest,
  ) => Promise<CoreLearningsEntry[]>;
  triggerHeartbeat: (agentRoleId: string) => Promise<HeartbeatResult>;
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
  // Context Policy APIs
  listContextPolicies: (channelId: string) => Promise<ContextPolicyData[]>;
  updateContextPolicy: (
    channelId: string,
    contextType: ContextTypeValue,
    options: UpdateContextPolicyOptions,
  ) => Promise<ContextPolicyData>;
  listChannelSpecializations: (channelId: string) => Promise<ChannelSpecializationData[]>;
  createChannelSpecialization: (
    data: CreateChannelSpecializationData,
  ) => Promise<ChannelSpecializationData>;
  updateChannelSpecialization: (
    data: UpdateChannelSpecializationData,
  ) => Promise<ChannelSpecializationData>;
  deleteChannelSpecialization: (id: string) => Promise<{ success: boolean }>;
  // Voice Mode APIs
  getVoiceSettings: () => Promise<VoiceSettingsData>;
  getVoiceCapabilities: () => Promise<VoiceCapabilitiesData>;
  saveVoiceSettings: (settings: Partial<VoiceSettingsData>) => Promise<VoiceSettingsData>;
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
  getWorktreeWorkspaceInfo: (
    workspaceId: string,
  ) => Promise<import("../shared/types").WorktreeWorkspaceInfo>;
  mergeWorktree: (taskId: string) => Promise<Any>;
  cleanupWorktree: (taskId: string) => Promise<{ success: boolean }>;
  getWorktreeSettings: () => Promise<Any>;
  saveWorktreeSettings: (settings: Any) => Promise<{ success: boolean; error?: string }>;

  // Usage Insights
  getUsageInsights: (workspaceId: string, periodDays?: number) => Promise<Any>;
  getUsageInsightsEarliest: (workspaceId: string) => Promise<number | null>;

  // CoWork Pulse
  getPulseSettings: () => Promise<import("../shared/pulse").PulsePublicSettings>;
  setPulseEnabled: (enabled: boolean) => Promise<import("../shared/pulse").PulseMutationResult>;
  resetPulseIdentity: () => Promise<import("../shared/pulse").PulseMutationResult>;
  deletePulseRemoteData: () => Promise<import("../shared/pulse").PulseMutationResult>;
  flushPulse: () => Promise<import("../shared/pulse").PulseSendResult>;

  // Daily Briefing
  generateDailyBriefing: (workspaceId: string) => Promise<Any>;
  getLatestBriefing: (workspaceId: string) => Promise<unknown>;
  generateBriefing: (workspaceId: string) => Promise<Any>;

  // Proactive Suggestions
  listSuggestions: (workspaceId: string) => Promise<Any[]>;
  listSuggestionsForWorkspaces: (
    workspaceIds: string[],
  ) => Promise<Array<{ workspaceId: string; suggestions: Any[] }>>;
  refreshSuggestions: (workspaceId: string) => Promise<{ success: boolean }>;
  refreshSuggestionsForWorkspaces: (workspaceIds: string[]) => Promise<{ success: boolean }>;
  dismissSuggestion: (workspaceId: string, suggestionId: string) => Promise<{ success: boolean }>;
  addSuggestionAsCommitment: (
    workspaceId: string,
    suggestionId: string,
  ) => Promise<{ ok: true } | { ok: false; reason: "not_found" | "not_eligible" | "unavailable" }>;
  acceptCalendarProposal: (proposalId: string) => Promise<CalendarCardOutcome>;
  sendMailReplyDraft: (draftId: string) => Promise<MailReplyDraftCardOutcome>;
  undoMailReplyDraftSend: (draftId: string) => Promise<MailReplyDraftCardOutcome>;
  discardMailReplyDraft: (draftId: string) => Promise<MailReplyDraftCardOutcome>;
  setMailReplyDraftsEnabled: (enabled: boolean) => Promise<{ ok: boolean }>;
  dismissMailReplyDraftsOffer: () => Promise<{ ok: boolean }>;
  dismissCalendarProposal: (proposalId: string) => Promise<{ ok: boolean }>;
  holdCalendarTimeForSuggestion: (data: {
    workspaceId: string;
    suggestionId: string;
    start: number;
    end: number;
  }) => Promise<CalendarCardOutcome>;
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

  // Shared "needs you" queue
  listAttention: () => Promise<import("../shared/attention").AttentionSnapshot>;
  /** Fires, without data, when the queue may have changed; reload it with listAttention. */
  onAttentionChanged: (callback: () => void) => () => void;

  // MCP Events
  getMcpEventsReceiverPort: () => Promise<number | null>;

  // Speculative reproduce-and-fix runs (read-only)
  listSpeculativeRuns: (
    query?: import("../shared/types").SpeculativeRunListQuery,
  ) => Promise<import("../shared/types").SpeculativeRun[]>;

  // Window control APIs (for custom title bar on Windows)
  windowMinimize: () => Promise<void>;
  windowMaximize: () => Promise<void>;
  windowClose: () => Promise<void>;
  getPlatform: () => string;
  getNativeFrameMode: () => boolean;
}

export interface VoiceCapabilitiesData {
  systemTts: {
    available: boolean;
    adapter: "macos-say" | "windows-sapi" | "espeak" | null;
    reason?: string;
  };
  systemStt: {
    available: boolean;
    adapter: "macos-say" | "windows-sapi" | "espeak" | null;
    reason?: string;
  };
}

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

export interface VoiceEventData {
  type: VoiceEventType;
  data: VoiceStateData | string | number | { message: string };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}

export type {
  MigrationStatus,
  ExtensionType,
  ExtensionState,
  TunnelProvider,
  TunnelStatus,
  TunnelStatusData,
  VoiceProvider,
  VoiceInputMode,
  VoiceResponseMode,
  VoiceEventType,
  BrowserSettings,
  BrowserSettingsState,
  BrowserDataType,
  HygieneReport,
  MergeReview,
  LifecycleKind,
  AgentIdentityDirectoryResult,
  BrowserSitePermissionEntry,
  ExtensionData,
};
