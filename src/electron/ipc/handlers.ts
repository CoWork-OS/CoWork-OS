import {
  ipcMain,
  shell,
  BrowserWindow,
  app as _app,
  nativeTheme,
} from "electron";
import { normalizeTaskEvents } from "../agent/timeline/timeline-normalizer";
import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { execFile, spawn as spawnProcess } from "child_process";
import { promisify } from "util";
import { promises as dns } from "dns";
import { isIP } from "net";
import mime from "mime-types";
import { z } from "zod";
import { getUserDataDir } from "../utils/user-data-dir";
import {
  resolveImageOcrChars,
  runOcrFromImagePath,
  shouldRunImageOcr,
} from "./image-viewer-ocr";
import { buildWebPagePreviewFromPath } from "../utils/web-preview";
import {
  PptxPreviewService,
  type PptxPresentationPreview,
  type PptxPreviewRenderMode,
} from "../utils/PptxPreviewService";
import { extractPdfReviewData } from "../utils/pdf-review";
import { createLocalPreviewFileUrl, createMediaPlaybackUrl } from "../media";
import {
  buildDelimitedSpreadsheetPreview,
  buildSpreadsheetPreviewFromFile,
  spreadsheetPreviewToTsv,
  writeDelimitedSpreadsheetPreviewToFile,
  writeSpreadsheetPreviewToFile,
} from "../utils/spreadsheet-preview";
import type { SpreadsheetPreview } from "../../shared/spreadsheet-preview";
import { buildDocumentPreviewFromFile } from "../utils/document-preview";
import { writeEditableDocumentBlocksToDocxFile } from "../utils/document-writer";
import type {
  DocumentPreview,
  EditableDocumentBlock,
} from "../../shared/document-preview";
import type { WebPagePreview } from "../../shared/web-page-preview";
import { DocumentEditorSessionService } from "../documents/DocumentEditorSessionService";
import { MailboxService } from "../mailbox/MailboxService";
import { AgentMailAdminService } from "../agentmail/AgentMailAdminService";
import { AgentMailRealtimeService } from "../agentmail/AgentMailRealtimeService";
import { ManagedSessionService } from "../managed/ManagedSessionService";
import { AgentTemplateService } from "../managed/AgentTemplateService";
import { ImageGenProfileService } from "../managed/ImageGenProfileService";
import type { RoutineService } from "../routines/service";
import type { RoutineCreate, RoutineTrigger } from "../routines/types";

import { DatabaseManager } from "../database/schema";
import {
  WorkspaceRepository,
  TaskRepository,
  TaskEventRepository,
  TaskTraceRepository,
  ArtifactRepository,
  SkillRepository,
  LLMModelRepository,
  WorkspacePermissionRuleRepository,
} from "../database/repositories";
import { AgentRoleRepository } from "../agents/AgentRoleRepository";
import { ActivityRepository } from "../activity/ActivityRepository";
import { MentionRepository } from "../agents/MentionRepository";
import { extractMentionedRoles } from "../agents/mentions";
import { AgentTeamRepository } from "../agents/AgentTeamRepository";
import { AgentTeamMemberRepository } from "../agents/AgentTeamMemberRepository";
import { AgentTeamRunRepository } from "../agents/AgentTeamRunRepository";
import { AgentTeamItemRepository } from "../agents/AgentTeamItemRepository";
import { AgentTeamThoughtRepository } from "../agents/AgentTeamThoughtRepository";
import { AgentTeamOrchestrator } from "../agents/AgentTeamOrchestrator";
import { formatAgentRoleDisplay } from "../agents/agent-role-display";
import { selectAgentsForTask } from "../agents/capabilityMatcher";
import { TaskLabelRepository } from "../database/TaskLabelRepository";
import { WorkingStateRepository } from "../agents/WorkingStateRepository";
import { ContextPolicyManager } from "../gateway/context-policy";
import { OnboardingProfileService } from "../onboarding/OnboardingProfileService";
import type { ApplyOnboardingProfileRequest } from "../../shared/onboarding";
import {
  IPC_CHANNELS,
  AgentMailSettingsData,
  AgentMailListEntry,
  LLMSettingsData,
  AddChannelRequest,
  UpdateChannelRequest as _UpdateChannelRequest,
  SecurityMode as _SecurityMode,
  UpdateInfo,
  TEMP_WORKSPACE_NAME,
  TEMP_WORKSPACE_ROOT_DIR_NAME,
  Workspace,
  AgentRole as _AgentRole,
  Task,
  BoardColumn as _BoardColumn,
  XSettingsData,
  NotionSettingsData,
  BoxSettingsData,
  OneDriveSettingsData,
  GoogleWorkspaceSettingsData,
  DropboxSettingsData,
  SharePointSettingsData,
  TaskExportQuery,
  WorkspaceKitStatus,
  WorkspaceKitInitRequest,
  WorkspaceKitProjectCreateRequest,
  AddUserFactRequest,
  UpdateUserFactRequest,
  isTempWorkspaceId,
  AgentConfig,
  LLMReasoningEffort,
  LLM_PROVIDER_TYPES,
  PdfReviewSummary,
  TaskLearningProgress,
  UnifiedRecallQuery,
  UnifiedRecallResponse,
  MemoryObservationSearchQuery,
  ChronicleSettings,
  ChronicleCaptureStatus,
  ChronicleResolvedContext,
  LLMRoutingRuntimeState,
  ShellSessionInfo,
  ShellSessionScope,
} from "../../shared/types";
import { isTerminalTaskStatus } from "../../shared/task-status";
import type { MailboxCommitmentState } from "../../shared/mailbox";
import * as os from "os";
import { AgentDaemon } from "../agent/daemon";
import { RuntimeVisibilityService } from "../agent/RuntimeVisibilityService";
import {
  LLMProviderFactory,
  LLMProviderConfig,
  ModelKey,
  OpenAIOAuth,
} from "../agent/llm";
import {
  SearchProviderFactory,
  SearchSettings,
  SearchProviderType,
} from "../agent/search";
import { ShellSessionManager } from "../agent/tools/shell-session-manager";
import { HealthManager } from "../health/HealthManager";
import { ChannelGateway } from "../gateway";
import { CHANNEL_TYPES } from "../gateway/channels/types";
import { updateManager } from "../updater";
import { rateLimiter, RATE_LIMIT_CONFIGS } from "../utils/rate-limiter";
import { toPublicChannel } from "./channel-config-sanitizer";
import { buildSavedLLMSettings } from "./llm-settings-save";
import { buildTaskExportJson } from "../reports/task-export";
import { ProfileManager } from "../profiles/ProfileManager";
import { PermissionSettingsManager } from "../security/permission-settings-manager";
import {
  appendWorkspacePermissionManifestRule,
  removeWorkspacePermissionManifestRule,
} from "../security/workspace-permission-manifest";
import {
  validateInput,
  WorkspaceCreateSchema,
  TaskCreateSchema,
  TaskRenameSchema,
  TaskMessageSchema,
  FileImportSchema,
  FileImportDataSchema,
  DocumentEditorOpenSessionSchema,
  DocumentEditorListVersionsSchema,
  DocumentEditRequestSchema,
  ApprovalResponseSchema,
  InputRequestResponseSchema,
  LLMSettingsSchema,
  SearchSettingsSchema,
  XSettingsSchema,
  NotionSettingsSchema,
  BoxSettingsSchema,
  OneDriveSettingsSchema,
  GoogleWorkspaceSettingsSchema,
  AgentMailSettingsSchema,
  DropboxSettingsSchema,
  SharePointSettingsSchema,
  PermissionSettingsSchema,
  AddChannelSchema,
  UpdateChannelSchema,
  GrantAccessSchema,
  RevokeAccessSchema,
  GeneratePairingSchema,
  GuardrailSettingsSchema,
  InfraSettingsSchema,
  EmailChannelConfigSchema,
  UUIDSchema,
  WorkspaceIdSchema,
  StringIdSchema,
  MCPConnectorOAuthSchema,
  ChatGPTImportSchema,
  TextMemoryImportSchema,
  FindImportedSchema,
  DeleteImportedEntrySchema,
  SetImportedRecallIgnoredSchema,
  StepFeedbackSchema,
  HealthSourceInputSchema,
  HealthWorkflowRequestSchema,
  HealthImportFilesSchema,
  HealthWritebackRequestSchema,
  PersonalityImportSchema,
  PersonalityConfigV2Schema,
  ContextModeSchema,
  MAX_PERSONALITY_PREVIEW_BYTES,
  AwarenessConfigSchema,
  AwarenessUpdateBeliefSchema,
  AutonomyConfigSchema,
  AutonomyUpdateDecisionSchema,
  ProviderApiKeySchema,
  ProviderBaseUrlSchema,
} from "../utils/validation";
import { GuardrailManager } from "../guardrails/guardrail-manager";
import { AppearanceManager, getDevLogCaptureEnabled } from "../settings/appearance-manager";
import { MemoryFeaturesManager } from "../settings/memory-features-manager";
import { PersonalityManager } from "../settings/personality-manager";
import { NotionSettingsManager } from "../settings/notion-manager";
import { testNotionConnection } from "../utils/notion-api";
import { BoxSettingsManager } from "../settings/box-manager";
import { OneDriveSettingsManager } from "../settings/onedrive-manager";
import { GoogleWorkspaceSettingsManager } from "../settings/google-workspace-manager";
import { DropboxSettingsManager } from "../settings/dropbox-manager";
import { SharePointSettingsManager } from "../settings/sharepoint-manager";
import { testBoxConnection } from "../utils/box-api";
import { testOneDriveConnection } from "../utils/onedrive-api";
import { testGoogleWorkspaceConnection } from "../utils/google-workspace-api";
import { testDropboxConnection } from "../utils/dropbox-api";
import { testSharePointConnection } from "../utils/sharepoint-api";
import { startConnectorOAuth } from "../mcp/oauth/connector-oauth";
import {
  startGoogleWorkspaceOAuth,
  startGoogleWorkspaceOAuthGetLink,
} from "../utils/google-workspace-oauth";
import { setupTaskTraceHandlers } from "./task-trace-handlers";
import { buildVideoPreviewTranscodeArgs } from "./video-preview-transcode";

import { XSettingsManager } from "../settings/x-manager";
import { testXConnection, checkBirdInstalled } from "../utils/x-cli";
import { getCustomSkillLoader } from "../agent/custom-skill-loader";
import { getAwarenessService } from "../awareness/AwarenessService";
import { getAutonomyEngine } from "../awareness/AutonomyEngine";
import { CustomSkill, SkillsConfig } from "../../shared/types";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";
import { parseSpawnAgentCount } from "../../shared/spawn-intent-detection";
import { MCPSettingsManager } from "../mcp/settings";
import { MCPClientManager } from "../mcp/client/MCPClientManager";
import { MCPRegistryManager } from "../mcp/registry/MCPRegistryManager";
import { getChannelRegistry as _getChannelRegistry } from "../gateway/channel-registry";
import type { MCPSettings, MCPServerConfig } from "../mcp/types";
import { MCPHostServer } from "../mcp/host/MCPHostServer";
import { CoWorkHostProvider } from "../mcp/host/CoWorkHostProvider";
import { BuiltinToolsSettingsManager } from "../agent/tools/builtin-settings";
import {
  ChronicleCaptureService,
  ChronicleMemoryService,
  ChronicleObservationRepository,
  ChronicleSettingsManager,
} from "../chronicle";
import { ComputerUseSessionManager } from "../computer-use/session-manager";
import { ComputerUseHelperRuntime } from "../computer-use/helper-runtime";
import {
  MCPServerConfigSchema,
  MCPServerUpdateSchema,
  MCPSettingsSchema,
  MCPRegistrySearchSchema,
  HookMappingSchema,
} from "../utils/validation";
import {
  NotificationService,
  NotificationOverlayManager,
} from "../notifications";
import type {
  NotificationType,
  HooksSettingsData,
  HookMappingData,
  GmailHooksSettingsData,
  ResendHooksSettingsData,
  HooksStatus,
} from "../../shared/types";
import {
  HooksSettingsManager,
  HooksServer,
  startGmailWatcher,
  stopGmailWatcher,
  isGmailWatcherRunning,
  isGogAvailable,
  generateHookToken,
  DEFAULT_HOOKS_PORT,
} from "../hooks";
import { initializeHookAgentIngress } from "../hooks/agent-ingress";
import { MemoryService } from "../memory/MemoryService";
import { MemoryObservationService } from "../memory/MemoryObservationService";
import { MemorySynthesizer } from "../memory/MemorySynthesizer";
import { CuratedMemoryService } from "../memory/CuratedMemoryService";
import { SupermemoryService } from "../memory/SupermemoryService";
import { UserProfileService } from "../memory/UserProfileService";
import { WORKSPACE_KIT_CONTRACTS } from "../context/kit-contracts";
import {
  computeWorkspaceKitStatus,
  readWorkspaceKitState,
  ensureBootstrapLifecycleState,
} from "../context/kit-status";
import { buildDefaultDesignSystemMarkdown } from "../context/design-system-template";
import { writeKitFileWithSnapshot } from "../context/kit-revisions";
import { InfraManager } from "../infra/infra-manager";
import { InfraSettingsManager } from "../infra/infra-settings";
import { WalletManager } from "../infra/wallet/wallet-manager";
import { RelationshipMemoryService } from "../memory/RelationshipMemoryService";
import { AdaptiveStyleEngine } from "../memory/AdaptiveStyleEngine";
import type { MemorySettings } from "../database/repositories";
import { VoiceSettingsManager } from "../voice/voice-settings-manager";
import { getVoiceService } from "../voice/VoiceService";
import { AgentPerformanceReviewService } from "../reports/AgentPerformanceReviewService";
import { EvalService } from "../eval/EvalService";
import { getCronService } from "../cron";
import type { CronJobCreate } from "../cron/types";
import {
  getXMentionBridgeService,
  getXMentionTriggerStatus,
} from "../x-mentions";
import { getCouncilService } from "../council";
import { pruneTempWorkspaces } from "../utils/temp-workspace";
import type { TriggerEvent } from "../triggers/types";
import {
  createScopedTempWorkspaceIdentity,
  isTempWorkspaceInScope,
  sanitizeTempWorkspaceKey,
} from "../utils/temp-workspace-scope";
import {
  getActiveTempWorkspaceLeases,
  touchTempWorkspaceLease,
} from "../utils/temp-workspace-lease";
import { createLogger } from "../utils/logger";
import { isApprovedImportFile } from "../security/file-import-approvals";
import { FileProvenanceRegistry } from "../security/file-provenance-registry";

type FileViewerRequestOptions = {
  workspacePath?: string;
  enableImageOcr?: boolean;
  imageOcrMaxChars?: number;
  includeImageContent?: boolean;
  includePdfBase64?: boolean;
  presentationRenderMode?: PptxPreviewRenderMode;
};
type MacSystemSettingsTarget = "microphone" | "dictation";

let sharedPptxPreviewService: PptxPreviewService | null = null;

function getSharedPptxPreviewService(): PptxPreviewService {
  sharedPptxPreviewService ??= new PptxPreviewService({
    imageUrlFactory: (imagePath) =>
      createLocalPreviewFileUrl({
        resolvedPath: imagePath,
        rootPath: path.join(getUserDataDir(), "cache", "pptx-previews"),
        mimeType: "image/png",
      }),
  });
  return sharedPptxPreviewService;
}

function buildPptxContentFromPreview(preview: PptxPresentationPreview): string {
  return preview.slides
    .map((slide) => {
      const lines = [`Slide ${slide.index}`];
      if (slide.title) lines.push(slide.title);
      if (slide.text && slide.text !== slide.title) lines.push(slide.text);
      if (slide.notes) lines.push(`Notes: ${slide.notes}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

const execFileAsync = promisify(execFile);
const SupermemorySettingsInputSchema = z.object({
  enabled: z.boolean(),
  apiKey: z.string().trim().max(500).optional(),
  baseUrl: z
    .string()
    .trim()
    .url()
    .refine((value) => {
      try {
        const parsed = new URL(value);
        return parsed.protocol === "https:" && parsed.hostname === "api.supermemory.ai";
      } catch {
        return false;
      }
    }, "Supermemory base URL must be https://api.supermemory.ai")
    .optional(),
  containerTagTemplate: z.string().trim().min(1).max(200).optional(),
  includeProfileInPrompt: z.boolean().optional(),
  mirrorMemoryWrites: z.boolean().optional(),
  searchMode: z.enum(["hybrid", "memories"]).optional(),
  rerank: z.boolean().optional(),
  threshold: z.number().min(0).max(1).optional(),
  customContainers: z
    .array(
      z.object({
        tag: z.string().trim().min(1).max(100),
        description: z.string().trim().max(240).optional(),
      }).strict(),
    )
    .max(50)
    .optional(),
}).strict();
const MemoryObservationStringArraySchema = z.array(z.string().trim().min(1).max(240)).max(12);
const MemoryObservationPatchSchema = z.object({
  title: z.string().trim().min(1).max(160).optional(),
  subtitle: z.string().trim().max(200).optional(),
  narrative: z.string().trim().min(1).max(2_000).optional(),
  facts: MemoryObservationStringArraySchema.optional(),
  concepts: MemoryObservationStringArraySchema.optional(),
  filesRead: MemoryObservationStringArraySchema.optional(),
  filesModified: MemoryObservationStringArraySchema.optional(),
  tools: MemoryObservationStringArraySchema.optional(),
  sourceEventIds: MemoryObservationStringArraySchema.optional(),
  privacyState: z.enum(["normal", "private", "redacted", "suppressed"]).optional(),
}).strict();
const MemoryObservationUpdateSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  memoryId: StringIdSchema,
  patch: MemoryObservationPatchSchema,
}).strict();
const MemoryObservationMutationSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  memoryId: StringIdSchema,
}).strict();
const MemoryObservationRedactSchema = MemoryObservationMutationSchema.extend({
  replacement: z.string().trim().min(1).max(500).optional(),
}).strict();
const MemoryObservationPromoteSchema = MemoryObservationMutationSchema.extend({
  target: z.enum(["user", "workspace"]).optional(),
  kind: z.enum(["identity", "preference", "constraint", "workflow_rule", "project_fact", "active_commitment"]).optional(),
}).strict();
const MemoryObservationDetailsSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  ids: z.array(StringIdSchema).min(1).max(25),
}).strict();
const MemoryObservationRebuildSchema = z.object({
  force: z.boolean().optional(),
}).strict();
const logger = createLogger("IPC");
const ProfileNameSchema = z.string().trim().min(1).max(80);
const VIDEO_PREVIEW_CACHE_DIR = path.join(
  os.tmpdir(),
  "cowork-video-preview-cache",
);
const VIDEO_PREVIEW_FFMPEG_TIMEOUT_MS = 60_000;
const MAX_TRANSCODED_VIDEO_PREVIEW_SIZE = 64 * 1024 * 1024;

let ffmpegCheckedAt = 0;
let ffmpegAvailable: boolean | null = null;

const isFfmpegInstalled = async (): Promise<boolean> => {
  const now = Date.now();
  if (ffmpegAvailable !== null && now - ffmpegCheckedAt < 5 * 60 * 1000) {
    return ffmpegAvailable;
  }

  ffmpegCheckedAt = now;
  try {
    await execFileAsync("ffmpeg", ["-version"], { timeout: 5_000 });
    ffmpegAvailable = true;
    return true;
  } catch {
    ffmpegAvailable = false;
    return false;
  }
};

const sanitizeVideoPreviewBaseName = (resolvedPath: string): string => {
  const baseName = path.basename(resolvedPath, path.extname(resolvedPath));
  const normalized = baseName
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return normalized.length > 0 ? normalized.slice(0, 80) : "video-preview";
};

const getCachedVideoPreviewPath = (
  resolvedPath: string,
  stats: fsSync.Stats,
): string => {
  const safeBase = sanitizeVideoPreviewBaseName(resolvedPath);
  return path.join(
    VIDEO_PREVIEW_CACHE_DIR,
    `${safeBase}-${stats.size}-${Math.floor(stats.mtimeMs)}.webm`,
  );
};

const generateTranscodedVideoPreviewDataUrl = async (
  resolvedPath: string,
  stats: fsSync.Stats,
): Promise<string | null> => {
  if (stats.size > MAX_TRANSCODED_VIDEO_PREVIEW_SIZE) {
    return null;
  }

  const hasFfmpeg = await isFfmpegInstalled();
  if (!hasFfmpeg) {
    return null;
  }

  try {
    await fs.mkdir(VIDEO_PREVIEW_CACHE_DIR, { recursive: true });
    const previewPath = getCachedVideoPreviewPath(resolvedPath, stats);

    try {
      await fs.access(previewPath);
    } catch {
      const tempOutputPath = `${previewPath}.${process.pid}.tmp.webm`;
      try {
        await execFileAsync(
          "ffmpeg",
          buildVideoPreviewTranscodeArgs(resolvedPath, tempOutputPath),
          {
            timeout: VIDEO_PREVIEW_FFMPEG_TIMEOUT_MS,
            maxBuffer: 8 * 1024 * 1024,
          },
        );
        await fs.rename(tempOutputPath, previewPath);
      } catch (ffmpegError) {
        // Clean up partial output before re-throwing so the outer catch can log and return null.
        try {
          await fs.unlink(tempOutputPath);
        } catch {
          /* ignore if never created */
        }
        throw ffmpegError;
      }
    }

    const previewBuffer = await fs.readFile(previewPath);
    return `data:video/webm;base64,${previewBuffer.toString("base64")}`;
  } catch (error) {
    logger.warn(
      `Video preview transcode failed for ${resolvedPath}: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
};

const isMacSystemSettingsTarget = (
  value: unknown,
): value is MacSystemSettingsTarget =>
  value === "microphone" || value === "dictation";

const openMacSystemSettings = async (
  target: MacSystemSettingsTarget,
): Promise<void> => {
  const urlCandidates =
    target === "microphone"
      ? [
          "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone",
          "x-apple.systempreferences:com.apple.preference.security?Privacy",
        ]
      : [
          "x-apple.systempreferences:com.apple.Keyboard-Settings.extension?Dictation",
          "x-apple.systempreferences:com.apple.preference.keyboard?Dictation",
          "x-apple.systempreferences:com.apple.preference.keyboard",
        ];

  for (const url of urlCandidates) {
    try {
      await shell.openExternal(url);
      return;
    } catch {
      // Try next URL candidate.
    }
  }

  const appleScriptCandidates: string[][] =
    target === "microphone"
      ? [
          [
            'tell application "System Settings" to activate',
            'tell application "System Settings" to reveal pane id "com.apple.preference.security"',
          ],
          [
            'tell application "System Preferences" to activate',
            'tell application "System Preferences" to reveal pane id "com.apple.preference.security"',
          ],
        ]
      : [
          [
            'tell application "System Settings" to activate',
            'tell application "System Settings" to reveal pane id "com.apple.Keyboard-Settings.extension"',
          ],
          [
            'tell application "System Settings" to activate',
            'tell application "System Settings" to reveal pane id "com.apple.preference.keyboard"',
          ],
          [
            'tell application "System Preferences" to activate',
            'tell application "System Preferences" to reveal pane id "com.apple.preference.keyboard"',
          ],
        ];

  let lastError: Error | null = null;
  for (const scriptLines of appleScriptCandidates) {
    try {
      const args = scriptLines.flatMap((line) => ["-e", line]);
      await execFileAsync("/usr/bin/osascript", args);
      return;
    } catch (error) {
      lastError = error as Error;
    }
  }

  throw lastError ?? new Error("Unable to open System Settings");
};

// Global notification service instance
let notificationService: NotificationService | null = null;
type HooksWakeSubmitter = (action: {
  text: string;
  mode: "now" | "next-heartbeat";
}) => Promise<void> | void;
let heartbeatWakeSubmitter: HooksWakeSubmitter | null = null;
type HooksWakeAction = { text: string; mode: "now" | "next-heartbeat" };
const MAX_PENDING_HEARTBEAT_WAKES = 200;
const pendingHeartbeatWakes: HooksWakeAction[] = [];
const resolveCustomProviderId = (providerType: string) =>
  providerType === "kimi-coding" ? "kimi-code" : providerType;

export function setHeartbeatWakeSubmitter(
  submitter: HooksWakeSubmitter | null,
): void {
  heartbeatWakeSubmitter = submitter;

  if (!submitter) {
    return;
  }

  const pending = [...pendingHeartbeatWakes];
  pendingHeartbeatWakes.length = 0;
  void (async () => {
    for (const action of pending) {
      try {
        await submitter(action);
      } catch (error) {
        logger.error("[Hooks] Failed to flush buffered wake action:", error);
      }
    }
  })();
}

/**
 * Get the notification service instance
 */
export function getNotificationService(): NotificationService | null {
  return notificationService;
}

// Helper to check rate limit and throw if exceeded
function checkRateLimit(
  channel: string,
  _config: {
    maxRequests: number;
    windowMs: number;
  } = RATE_LIMIT_CONFIGS.standard,
): void {
  if (!rateLimiter.check(channel)) {
    const resetMs = rateLimiter.getResetTime(channel);
    const resetSec = Math.ceil(resetMs / 1000);
    throw new Error(`Rate limit exceeded. Try again in ${resetSec} seconds.`);
  }
}

const OpenAICompatibleBaseUrlSchema = z.string().url().max(500);
const BLOCKED_OPENAI_COMPATIBLE_HOSTNAMES = new Set([
  "0.0.0.0",
  "::",
  "metadata.google.internal",
]);
const BLOCKED_OPENAI_COMPATIBLE_IPS = new Set([
  "169.254.169.254", // AWS/GCP/Azure instance metadata pattern
]);

function normalizeHostname(hostname: string): string {
  const trimmed = String(hostname || "")
    .trim()
    .toLowerCase();
  const unwrapped =
    trimmed.startsWith("[") && trimmed.endsWith("]")
      ? trimmed.slice(1, -1)
      : trimmed;
  return unwrapped.endsWith(".") ? unwrapped.slice(0, -1) : unwrapped;
}

function isPrivateIpv4Address(address: string): boolean {
  const parts = address.split(".").map((p) => Number(p));
  if (
    parts.length !== 4 ||
    parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)
  ) {
    return false;
  }

  const [a, b] = parts;
  if (a === 10 || a === 127 || a === 0) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true; // carrier-grade NAT
  return false;
}

function isPrivateIpv6Address(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (!normalized || normalized === "::" || normalized === "::1") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true; // unique local
  if (
    normalized.startsWith("fe8") ||
    normalized.startsWith("fe9") ||
    normalized.startsWith("fea") ||
    normalized.startsWith("feb")
  ) {
    return true; // link-local fe80::/10
  }
  return false;
}

function isPrivateOrLoopbackAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const family = isIP(normalized);
  if (family === 4) return isPrivateIpv4Address(normalized);
  if (family === 6) return isPrivateIpv6Address(normalized);
  return false;
}

function isLoopbackAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (normalized === "localhost") return true;
  const family = isIP(normalized);
  if (family === 4) {
    return normalized.split(".")[0] === "127";
  }
  if (family === 6) {
    return normalized === "::1";
  }
  return false;
}

async function validateOpenAICompatibleBaseUrl(
  baseUrl: string,
  options: { allowLoopback?: boolean } = {},
): Promise<string> {
  const validatedBaseUrl = validateInput(
    OpenAICompatibleBaseUrlSchema,
    baseUrl,
    "OpenAI-compatible base URL",
  );
  const parsed = new URL(validatedBaseUrl);
  const protocol = parsed.protocol.toLowerCase();
  if (protocol !== "https:" && protocol !== "http:") {
    throw new Error("OpenAI-compatible base URL must use HTTP or HTTPS.");
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (!hostname) {
    throw new Error(
      "OpenAI-compatible base URL must include a valid hostname.",
    );
  }
  const allowLoopback = options.allowLoopback === true;
  if (
    BLOCKED_OPENAI_COMPATIBLE_HOSTNAMES.has(hostname) ||
    hostname.endsWith(".local")
  ) {
    throw new Error("OpenAI-compatible base URL cannot target blocked hosts.");
  }
  if (
    isPrivateOrLoopbackAddress(hostname) &&
    !(allowLoopback && isLoopbackAddress(hostname))
  ) {
    throw new Error(
      "OpenAI-compatible base URL cannot target private network hosts (except loopback).",
    );
  }

  try {
    const resolved = await dns.lookup(hostname, { all: true, verbatim: true });
    if (
      resolved.some((entry) => {
        const normalizedAddress = normalizeHostname(entry.address);
        if (BLOCKED_OPENAI_COMPATIBLE_IPS.has(normalizedAddress)) return true;
        if (!isPrivateOrLoopbackAddress(normalizedAddress)) return false;
        return !(allowLoopback && isLoopbackAddress(normalizedAddress));
      })
    ) {
      throw new Error(
        "OpenAI-compatible base URL resolved to a blocked private/metadata address.",
      );
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOTFOUND" || code === "EAI_AGAIN" || code === "ENODATA") {
      // Let downstream request handling surface connectivity errors.
      return validatedBaseUrl;
    }
    throw error;
  }

  return validatedBaseUrl;
}

function validateOptionalProviderApiKey(
  apiKey: string | undefined,
  providerLabel: string,
): string | undefined {
  return validateInput(ProviderApiKeySchema, apiKey, `${providerLabel} API key`);
}

async function validateOptionalProviderBaseUrl(
  baseUrl: string | undefined,
  options: {
    providerLabel: string;
    allowLoopback?: boolean;
  },
): Promise<string | undefined> {
  if (baseUrl == null || baseUrl === "") {
    return undefined;
  }

  const validatedBaseUrl = validateInput(
    ProviderBaseUrlSchema,
    baseUrl,
    `${options.providerLabel} base URL`,
  );
  if (!validatedBaseUrl) {
    return undefined;
  }
  return await validateOpenAICompatibleBaseUrl(validatedBaseUrl, {
    allowLoopback: options.allowLoopback,
  });
}

// Configure rate limits for sensitive channels
rateLimiter.configure(IPC_CHANNELS.TASK_CREATE, RATE_LIMIT_CONFIGS.expensive);
rateLimiter.configure(
  IPC_CHANNELS.TASK_SEND_MESSAGE,
  RATE_LIMIT_CONFIGS.expensive,
);
rateLimiter.configure(
  IPC_CHANNELS.TASK_STEP_FEEDBACK,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(IPC_CHANNELS.TASK_WRAP_UP, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TASK_CONTINUE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(
  IPC_CHANNELS.TASK_FORK_SESSION,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(IPC_CHANNELS.TASK_PIN, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(
  IPC_CHANNELS.TASK_EXPORT_JSON,
  RATE_LIMIT_CONFIGS.standard,
);
rateLimiter.configure(
  IPC_CHANNELS.SUGGESTIONS_LIST,
  RATE_LIMIT_CONFIGS.frequent,
);
rateLimiter.configure(
  IPC_CHANNELS.SUGGESTIONS_LIST_FOR_WORKSPACES,
  RATE_LIMIT_CONFIGS.frequent,
);
rateLimiter.configure(
  IPC_CHANNELS.SUGGESTIONS_REFRESH,
  RATE_LIMIT_CONFIGS.standard,
);
rateLimiter.configure(
  IPC_CHANNELS.SUGGESTIONS_REFRESH_FOR_WORKSPACES,
  RATE_LIMIT_CONFIGS.standard,
);
rateLimiter.configure(
  IPC_CHANNELS.SUGGESTIONS_DISMISS,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.SUGGESTIONS_SNOOZE,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.SUGGESTIONS_EDIT,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.SUGGESTIONS_ACT,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.LLM_SAVE_SETTINGS,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.LLM_RESET_PROVIDER_CREDENTIALS,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.LLM_TEST_PROVIDER,
  RATE_LIMIT_CONFIGS.expensive,
);
rateLimiter.configure(
  IPC_CHANNELS.LLM_GET_ANTHROPIC_MODELS,
  RATE_LIMIT_CONFIGS.standard,
);
rateLimiter.configure(
  IPC_CHANNELS.LLM_GET_OLLAMA_MODELS,
  RATE_LIMIT_CONFIGS.standard,
);
rateLimiter.configure(
  IPC_CHANNELS.LLM_GET_GEMINI_MODELS,
  RATE_LIMIT_CONFIGS.standard,
);
rateLimiter.configure(
  IPC_CHANNELS.LLM_GET_OPENROUTER_MODELS,
  RATE_LIMIT_CONFIGS.standard,
);
rateLimiter.configure(
  IPC_CHANNELS.LLM_GET_BEDROCK_MODELS,
  RATE_LIMIT_CONFIGS.standard,
);
rateLimiter.configure(
  IPC_CHANNELS.LLM_GET_GROQ_MODELS,
  RATE_LIMIT_CONFIGS.standard,
);
rateLimiter.configure(
  IPC_CHANNELS.LLM_GET_XAI_MODELS,
  RATE_LIMIT_CONFIGS.standard,
);
rateLimiter.configure(
  IPC_CHANNELS.LLM_GET_KIMI_MODELS,
  RATE_LIMIT_CONFIGS.standard,
);
rateLimiter.configure(
  IPC_CHANNELS.LLM_GET_PI_MODELS,
  RATE_LIMIT_CONFIGS.standard,
);
rateLimiter.configure(
  IPC_CHANNELS.LLM_GET_PI_PROVIDERS,
  RATE_LIMIT_CONFIGS.standard,
);
rateLimiter.configure(
  IPC_CHANNELS.LLM_GET_OPENAI_COMPATIBLE_MODELS,
  RATE_LIMIT_CONFIGS.standard,
);
rateLimiter.configure(
  IPC_CHANNELS.SEARCH_SAVE_SETTINGS,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.SEARCH_TEST_PROVIDER,
  RATE_LIMIT_CONFIGS.expensive,
);
rateLimiter.configure(
  IPC_CHANNELS.GATEWAY_ADD_CHANNEL,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.GATEWAY_TEST_CHANNEL,
  RATE_LIMIT_CONFIGS.expensive,
);
rateLimiter.configure(
  IPC_CHANNELS.GUARDRAIL_SAVE_SETTINGS,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(IPC_CHANNELS.TEAM_CREATE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_UPDATE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_DELETE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_MEMBER_ADD, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(
  IPC_CHANNELS.TEAM_MEMBER_UPDATE,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.TEAM_MEMBER_REMOVE,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.TEAM_MEMBER_REORDER,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(IPC_CHANNELS.TEAM_RUN_CREATE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_RUN_RESUME, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_RUN_PAUSE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_RUN_CANCEL, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(
  IPC_CHANNELS.TEAM_RUN_WRAP_UP,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.TEAM_ITEM_CREATE,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.TEAM_ITEM_UPDATE,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.TEAM_ITEM_DELETE,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(IPC_CHANNELS.TEAM_ITEM_MOVE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.REVIEW_GENERATE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.REVIEW_DELETE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.EVAL_RUN_SUITE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(
  IPC_CHANNELS.EVAL_CREATE_CASE_FROM_TASK,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(IPC_CHANNELS.KIT_INIT, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(
  IPC_CHANNELS.KIT_PROJECT_CREATE,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(IPC_CHANNELS.KIT_OPEN_FILE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(
  IPC_CHANNELS.KIT_RESET_ADAPTIVE_STYLE,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.KIT_SUBMIT_MESSAGE_FEEDBACK,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.MEMORY_ADD_USER_FACT,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.MEMORY_UPDATE_USER_FACT,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.MEMORY_DELETE_USER_FACT,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.MEMORY_DELETE_IMPORTED_ENTRY,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.MEMORY_SET_IMPORTED_RECALL_IGNORED,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.MEMORY_RELATIONSHIP_UPDATE,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.MEMORY_RELATIONSHIP_DELETE,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.MEMORY_RELATIONSHIP_CLEANUP_RECURRING,
  RATE_LIMIT_CONFIGS.limited,
);
rateLimiter.configure(
  IPC_CHANNELS.SUPERVISOR_EXCHANGE_RESOLVE,
  RATE_LIMIT_CONFIGS.limited,
);

// Helper function to get the main window (avoids overlay/utility windows)
let mainWindowGetter: (() => BrowserWindow | null) | null = null;

function getMainWindow(): BrowserWindow | null {
  if (mainWindowGetter) return mainWindowGetter();
  // Fallback: first window that loads the app (not data: URL)
  const windows = BrowserWindow.getAllWindows();
  for (const w of windows) {
    if (w.isDestroyed() || !w.webContents) continue;
    const url = w.webContents.getURL();
    if (url && !url.startsWith("data:")) return w;
  }
  return windows.length > 0 ? windows[0] : null;
}

function assertTrustedMailboxSender(event: Any): void {
  const senderWindow = BrowserWindow.fromWebContents(event.sender);
  const mainWindow = getMainWindow();
  if (!senderWindow || !mainWindow || senderWindow !== mainWindow) {
    throw new Error("Mailbox access is restricted to the main app window");
  }
}

export async function setupIpcHandlers(
  dbManager: DatabaseManager,
  agentDaemon: AgentDaemon,
  gateway?: ChannelGateway,
  options?: {
    getMainWindow?: () => BrowserWindow | null;
    getRoutineService?: () => RoutineService | null;
  },
) {
  if (options?.getMainWindow) mainWindowGetter = options.getMainWindow;

  const computerUseMainWindow = (): BrowserWindow | null =>
    options?.getMainWindow?.() ?? getMainWindow();
  ComputerUseSessionManager.getInstance().setMainWindowGetter(
    computerUseMainWindow,
  );
  ComputerUseSessionManager.getInstance().setNotifyHandler((event) => {
    const win = computerUseMainWindow();
    if (win && !win.isDestroyed()) {
      win.webContents.send(IPC_CHANNELS.COMPUTER_USE_EVENT, event);
    }
  });

  const db = dbManager.getDatabase();
  const workspaceRepo = new WorkspaceRepository(db);
  const taskRepo = new TaskRepository(db);
  const taskEventRepo = new TaskEventRepository(db);
  const taskTraceRepo = new TaskTraceRepository(taskRepo, taskEventRepo);
  const artifactRepo = new ArtifactRepository(db);
  const skillRepo = new SkillRepository(db);
  const llmModelRepo = new LLMModelRepository(db);
  const workspacePermissionRuleRepo = new WorkspacePermissionRuleRepository(db);
  const agentRoleRepo = new AgentRoleRepository(db);
  const activityRepo = new ActivityRepository(db);
  const mentionRepo = new MentionRepository(db);
  const teamRepo = new AgentTeamRepository(db);
  const teamMemberRepo = new AgentTeamMemberRepository(db);
  const teamRunRepo = new AgentTeamRunRepository(db);
  const teamItemRepo = new AgentTeamItemRepository(db);
  const teamThoughtRepo = new AgentTeamThoughtRepository(db);
  const reviewService = new AgentPerformanceReviewService(db);
  const evalService = new EvalService(db);
  const taskLabelRepo = new TaskLabelRepository(db);
  const workingStateRepo = new WorkingStateRepository(db);
  const documentEditorSessionService = new DocumentEditorSessionService(
    workspaceRepo,
    taskRepo,
    artifactRepo,
    agentDaemon,
  );
  const mailboxService = new MailboxService(db, { autoSync: true });
  const agentMailRealtimeService = new AgentMailRealtimeService(db, mailboxService);
  const agentMailAdminService = new AgentMailAdminService(
    db,
    () => agentMailRealtimeService.getRuntimeStatus(),
  );
  agentMailRealtimeService.start();
  const contextPolicyManager = new ContextPolicyManager(db);
  const getRoutineService = () => options?.getRoutineService?.() || null;
  const managedSessionService = new ManagedSessionService(db, agentDaemon, {
    getRoutineService,
  });
  const agentTemplateService = new AgentTemplateService();
  const imageGenProfileService = new ImageGenProfileService();
  const emitTaskStatusEvent = (
    taskId: string,
    status: Task["status"],
    extraPayload?: Record<string, unknown>,
  ): void => {
    getMainWindow()?.webContents.send(IPC_CHANNELS.TASK_EVENT, {
      taskId,
      type: "task_status",
      timestamp: Date.now(),
      payload: { status, ...extraPayload },
    });
  };

  const teamOrchestrator = new AgentTeamOrchestrator({
    getDatabase: () => db,
    getTaskById: (taskId: string) => agentDaemon.getTaskById(taskId),
    createChildTask: (params) => agentDaemon.createChildTask(params as Any),
    cancelTask: (taskId: string) => agentDaemon.cancelTask(taskId),
    wrapUpTask: (taskId: string) => agentDaemon.wrapUpTask(taskId),
    createOrchestrationGraphRun: (params) =>
      agentDaemon.createOrchestrationGraphRun(params as Any),
    appendOrchestrationGraphNodes: (params) =>
      agentDaemon.appendOrchestrationGraphNodes(params as Any),
    findOrchestrationGraphByTeamRunId: (teamRunId: string) =>
      agentDaemon.findOrchestrationGraphByTeamRunId(teamRunId),
    completeRootTask: (taskId, status, summary) => {
      if (status === "failed") {
        agentDaemon.failTask(taskId, summary, {
          resultSummary: summary,
        });
        return;
      }
      agentDaemon.completeTask(taskId, summary);
    },
  });
  agentDaemon.setTeamOrchestrator(teamOrchestrator);

  // Seed default agent roles if none exist
  agentRoleRepo.seedDefaults();
  setupTaskTraceHandlers({ taskTraceRepo });

  // Helper to validate path is within workspace (prevent path traversal attacks)
  const isPathWithinWorkspace = (
    filePath: string,
    workspacePath: string,
  ): boolean => {
    const normalizedWorkspace = path.resolve(workspacePath);
    const normalizedFile = path.resolve(normalizedWorkspace, filePath);
    const relative = path.relative(normalizedWorkspace, normalizedFile);
    // If relative path starts with '..' or is absolute, it's outside workspace
    return !relative.startsWith("..") && !path.isAbsolute(relative);
  };

  const normalizePotentialPath = (rawPath: string): string => {
    const trimmed = String(rawPath || "").trim();
    if (!trimmed) return "";

    const expandedHome =
      trimmed === "~"
        ? os.homedir()
        : trimmed.startsWith("~/") || trimmed.startsWith("~\\")
          ? path.join(os.homedir(), trimmed.slice(2))
          : trimmed;

    // Event payloads may normalize separators to "/" regardless of platform.
    return path.sep === "/"
      ? expandedHome.replace(/\\/g, "/")
      : expandedHome.replace(/\//g, "\\");
  };

  const buildViewerPathCandidates = (
    filePath: string,
    workspacePath?: string,
  ): string[] => {
    const normalizedInput = normalizePotentialPath(filePath);
    const candidates: string[] = [];
    const seen = new Set<string>();
    const addCandidate = (candidate: string) => {
      if (!candidate) return;
      const resolved = path.resolve(candidate);
      if (seen.has(resolved)) return;
      seen.add(resolved);
      candidates.push(resolved);
    };

    if (!normalizedInput) return candidates;
    const hasWorkspace =
      typeof workspacePath === "string" && workspacePath.trim().length > 0;
    const normalizedWorkspace = hasWorkspace
      ? path.resolve(normalizePotentialPath(workspacePath as string))
      : "";
    const basename = path.basename(normalizedInput);
    const pathSegments = normalizedInput.split(/[\\/]+/).filter(Boolean);
    const hasParentTraversal = pathSegments.includes("..");
    const normalizedRelativeInput = normalizedInput
      .replace(/^\.([\\/])/, "")
      .replace(/^[\\/]+/, "");

    if (path.isAbsolute(normalizedInput)) {
      addCandidate(normalizedInput);
      if (hasWorkspace) {
        if (basename && basename !== "." && basename !== "..") {
          addCandidate(path.join(normalizedWorkspace, basename));
          addCandidate(path.join(normalizedWorkspace, ".cowork", basename));
          addCandidate(path.join(normalizedWorkspace, "artifacts", basename));
        }

        // If a legacy absolute path points into ".cowork/" or "artifacts/", remap to active workspace.
        const segments = normalizedInput.split(/[\\/]+/).filter(Boolean);
        const coworkIdx = segments.lastIndexOf(".cowork");
        if (coworkIdx >= 0 && coworkIdx < segments.length - 1) {
          addCandidate(
            path.join(
              normalizedWorkspace,
              ".cowork",
              ...segments.slice(coworkIdx + 1),
            ),
          );
        }
        const artifactsIdx = segments.lastIndexOf("artifacts");
        if (artifactsIdx >= 0 && artifactsIdx < segments.length - 1) {
          addCandidate(
            path.join(
              normalizedWorkspace,
              "artifacts",
              ...segments.slice(artifactsIdx + 1),
            ),
          );
        }
      }
      return candidates;
    }

    if (hasWorkspace) {
      addCandidate(path.join(normalizedWorkspace, normalizedInput));

      if (!hasParentTraversal) {
        addCandidate(
          path.join(normalizedWorkspace, ".cowork", normalizedRelativeInput),
        );
        addCandidate(
          path.join(normalizedWorkspace, "artifacts", normalizedRelativeInput),
        );

        if (basename && basename !== normalizedRelativeInput) {
          addCandidate(path.join(normalizedWorkspace, basename));
          addCandidate(path.join(normalizedWorkspace, ".cowork", basename));
          addCandidate(path.join(normalizedWorkspace, "artifacts", basename));
        }
      }
    } else {
      addCandidate(normalizedInput);
    }

    return candidates;
  };

  const resolveExistingPathForViewer = async (
    filePath: string,
    workspacePath?: string,
    options?: { requireWorkspaceContainment?: boolean },
  ): Promise<{ resolvedPath: string | null; attemptedPaths: string[] }> => {
    const requireWorkspaceContainment =
      options?.requireWorkspaceContainment === true;
    const candidates = buildViewerPathCandidates(filePath, workspacePath);
    const attemptedPaths: string[] = [];
    const workspaceRoot =
      workspacePath && workspacePath.trim().length > 0
        ? path.resolve(normalizePotentialPath(workspacePath))
        : "";
    let sawOutOfWorkspaceCandidate = false;

    for (const candidate of candidates) {
      if (requireWorkspaceContainment && workspaceRoot) {
        if (!isPathWithinWorkspace(candidate, workspaceRoot)) {
          sawOutOfWorkspaceCandidate = true;
          continue;
        }
      }
      attemptedPaths.push(candidate);
      try {
        await fs.access(candidate);
        return { resolvedPath: candidate, attemptedPaths };
      } catch {
        // Continue trying fallback candidates.
      }
    }

    if (
      requireWorkspaceContainment &&
      attemptedPaths.length === 0 &&
      sawOutOfWorkspaceCandidate
    ) {
      throw new Error("Access denied: file path is outside the workspace");
    }

    return { resolvedPath: null, attemptedPaths };
  };

  const listFilesRecursiveSync = (
    rootPath: string,
    predicate?: (filePath: string) => boolean,
  ): string[] => {
    if (!fsSync.existsSync(rootPath)) return [];

    const output: string[] = [];
    const stack = [rootPath];
    while (stack.length > 0) {
      const current = stack.pop();
      if (!current) continue;
      const entries = fsSync.readdirSync(current, { withFileTypes: true });
      for (const entry of entries) {
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          stack.push(fullPath);
          continue;
        }
        if (!entry.isFile()) continue;
        if (!predicate || predicate(fullPath)) {
          output.push(fullPath);
        }
      }
    }
    return output;
  };

  const normalizeUiPath = (rawPath: string): string => rawPath.replace(/\\/g, "/");

  const buildLlmWikiVaultEntry = (
    filePath: string,
    workspaceRoot: string,
    section: "root" | "page" | "query" | "output" | "raw",
  ) => {
    const stat = fsSync.statSync(filePath);
    const relativePath = normalizeUiPath(path.relative(workspaceRoot, filePath));
    const baseName = path.basename(filePath);
    const parentName = path.basename(path.dirname(filePath));
    const name =
      section === "raw" && /^capture\./i.test(baseName)
        ? parentName
        : section === "output" && /\.(md|svg)$/i.test(baseName)
          ? baseName.replace(/\.(md|svg)$/i, "")
          : baseName.replace(/\.md$/i, "");

    return {
      path: relativePath,
      name,
      section,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      mtimeMs: stat.mtimeMs,
    };
  };

  const collectLlmWikiVaultSummary = (
    workspacePath: string,
    requestedVaultPath?: string,
  ) => {
    const workspaceRoot = path.resolve(normalizePotentialPath(workspacePath));
    const rawVaultPath =
      typeof requestedVaultPath === "string" && requestedVaultPath.trim().length > 0
        ? requestedVaultPath
        : "research/wiki";
    const vaultPath = path.isAbsolute(rawVaultPath)
      ? path.resolve(normalizePotentialPath(rawVaultPath))
      : path.resolve(workspaceRoot, normalizePotentialPath(rawVaultPath));

    if (!isPathWithinWorkspace(vaultPath, workspaceRoot)) {
      throw new Error("Access denied: vault path is outside the workspace");
    }

    const displayPath = normalizeUiPath(path.relative(workspaceRoot, vaultPath)) || ".";
    const emptySummary = {
      exists: false,
      vaultPath,
      displayPath,
      counts: {
        pages: 0,
        queries: 0,
        rawSources: 0,
        outputs: 0,
      },
      rootFiles: [],
      recentPages: [],
      recentQueries: [],
      recentOutputs: [],
      recentRawSources: [],
    };

    if (!fsSync.existsSync(vaultPath) || !fsSync.statSync(vaultPath).isDirectory()) {
      return emptySummary;
    }

    const rootFiles = ["index.md", "inbox.md", "log.md", "SCHEMA.md"]
      .map((relativePath) => path.join(vaultPath, relativePath))
      .filter((filePath) => fsSync.existsSync(filePath) && fsSync.statSync(filePath).isFile())
      .map((filePath) => buildLlmWikiVaultEntry(filePath, workspaceRoot, "root"));

    const pageDirs = ["concepts", "entities", "projects", "comparisons", "maps"];
    const pageFiles = pageDirs.flatMap((dirName) =>
      listFilesRecursiveSync(path.join(vaultPath, dirName), (filePath) =>
        filePath.toLowerCase().endsWith(".md"),
      ),
    );
    const queryFiles = listFilesRecursiveSync(path.join(vaultPath, "queries"), (filePath) =>
      filePath.toLowerCase().endsWith(".md"),
    );
    const outputFiles = listFilesRecursiveSync(path.join(vaultPath, "outputs"), (filePath) => {
      const lower = filePath.toLowerCase();
      return (lower.endsWith(".md") || lower.endsWith(".svg")) && !lower.endsWith(".meta.json");
    });
    const rawFiles = listFilesRecursiveSync(path.join(vaultPath, "raw"), (filePath) => {
      const lower = filePath.toLowerCase();
      const base = path.basename(lower);
      return base !== "source.json" && !base.endsWith(".source.json");
    });

    const sortByMtimeDesc = (
      left: { mtimeMs: number },
      right: { mtimeMs: number },
    ) => right.mtimeMs - left.mtimeMs;

    return {
      exists: true,
      vaultPath,
      displayPath,
      counts: {
        pages: pageFiles.length,
        queries: queryFiles.length,
        rawSources: rawFiles.length,
        outputs: outputFiles.length,
      },
      rootFiles,
      recentPages: pageFiles
        .map((filePath) => buildLlmWikiVaultEntry(filePath, workspaceRoot, "page"))
        .sort(sortByMtimeDesc)
        .slice(0, 6),
      recentQueries: queryFiles
        .map((filePath) => buildLlmWikiVaultEntry(filePath, workspaceRoot, "query"))
        .sort(sortByMtimeDesc)
        .slice(0, 4),
      recentOutputs: outputFiles
        .map((filePath) => buildLlmWikiVaultEntry(filePath, workspaceRoot, "output"))
        .sort(sortByMtimeDesc)
        .slice(0, 4),
      recentRawSources: rawFiles
        .map((filePath) => buildLlmWikiVaultEntry(filePath, workspaceRoot, "raw"))
        .sort(sortByMtimeDesc)
        .slice(0, 4),
    };
  };

  const renderPdfFirstPageThumbnail = async (
    pdfPath: string,
  ): Promise<string | undefined> => {
    let tempDir: string | undefined;
    try {
      tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-pdf-thumb-"));
      const outputPrefix = path.join(tempDir, "page-1");
      await execFileAsync(
        "pdftoppm",
        [
          "-f",
          "1",
          "-singlefile",
          "-png",
          "-scale-to-x",
          "960",
          "-scale-to-y",
          "-1",
          pdfPath,
          outputPrefix,
        ],
        { timeout: 15_000 },
      );

      const pngPath = `${outputPrefix}.png`;
      const pngBytes = await fs.readFile(pngPath);
      return `data:image/png;base64,${pngBytes.toString("base64")}`;
    } catch {
      return undefined;
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
          // Best-effort temp cleanup.
        });
      }
    }
  };

  const MANAGED_IMAGE_TEMP_PREFIX = "cowork-image-";

  const isManagedImageTempFile = (filePath: string): boolean => {
    if (!path.isAbsolute(filePath)) {
      return false;
    }

    const normalizedTmpDir = path.normalize(os.tmpdir());
    const normalizedFile = path.normalize(filePath);
    const tmpPrefix = normalizedTmpDir.endsWith(path.sep)
      ? normalizedTmpDir
      : `${normalizedTmpDir}${path.sep}`;
    if (!normalizedFile.startsWith(tmpPrefix)) {
      return false;
    }

    return path.basename(filePath).startsWith(MANAGED_IMAGE_TEMP_PREFIX);
  };

  const cleanupTaskImageTempFiles = async (
    images?: Array<{
      filePath?: string;
      tempFile?: boolean;
    }>,
  ): Promise<void> => {
    if (!Array.isArray(images)) {
      return;
    }

    const paths = new Set<string>();
    for (const image of images) {
      if (!image || typeof image !== "object") {
        continue;
      }

      const isManagedTemp = image.tempFile === true;
      if (!isManagedTemp) {
        continue;
      }
      if (!image.filePath || !isManagedImageTempFile(image.filePath)) {
        continue;
      }
      paths.add(image.filePath);
    }

    for (const filePath of paths) {
      try {
        await fs.unlink(filePath);
      } catch {
        // Ignore cleanup failures; images are best effort.
      }
    }
  };

  const tempWorkspaceRoot = path.join(
    os.tmpdir(),
    TEMP_WORKSPACE_ROOT_DIR_NAME,
  );

  const normalizeTempPermissions = (
    existing?: Workspace,
  ): Workspace["permissions"] => ({
    ...existing?.permissions,
    read: true,
    write: true,
    delete: true,
    network: true,
    shell: existing?.permissions?.shell ?? false,
    unrestrictedFileAccess: true,
  });

  const ensureTempWorkspace = async (
    workspaceId: string,
    workspacePath: string,
    existing?: Workspace,
  ): Promise<Workspace> => {
    await fs.mkdir(workspacePath, { recursive: true });
    const createdAt = existing?.createdAt ?? Date.now();
    const lastUsedAt = Date.now();
    const permissions = normalizeTempPermissions(existing);

    const stmt = db.prepare(`
      INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        path = excluded.path,
        last_used_at = excluded.last_used_at,
        permissions = excluded.permissions
    `);
    stmt.run(
      workspaceId,
      TEMP_WORKSPACE_NAME,
      workspacePath,
      createdAt,
      lastUsedAt,
      JSON.stringify(permissions),
    );

    return {
      id: workspaceId,
      name: TEMP_WORKSPACE_NAME,
      path: workspacePath,
      createdAt,
      lastUsedAt,
      permissions,
      isTemp: true,
    };
  };

  const buildTempWorkspaceKey = (): string =>
    sanitizeTempWorkspaceKey(
      `session-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
    );

  // Temp workspace management
  // Creates isolated temp workspaces so each new session can use its own folder.
  const getOrCreateTempWorkspace = async (options?: {
    createNew?: boolean;
  }): Promise<Workspace> => {
    const createNew = options?.createNew === true;
    let workspace: Workspace;

    if (!createNew) {
      const existingTemp = workspaceRepo
        .findAll()
        .find((workspace) => isTempWorkspaceInScope(workspace.id, "ui"));
      if (existingTemp) {
        workspace = await ensureTempWorkspace(
          existingTemp.id,
          existingTemp.path,
          existingTemp,
        );
      } else {
        await fs.mkdir(tempWorkspaceRoot, { recursive: true });
        const key = buildTempWorkspaceKey();
        const identity = createScopedTempWorkspaceIdentity("ui", key);
        const workspaceId = identity.workspaceId;
        const workspacePath = path.join(tempWorkspaceRoot, identity.slug);
        workspace = await ensureTempWorkspace(workspaceId, workspacePath);
      }
    } else {
      await fs.mkdir(tempWorkspaceRoot, { recursive: true });
      const key = buildTempWorkspaceKey();
      const identity = createScopedTempWorkspaceIdentity("ui", key);
      const workspaceId = identity.workspaceId;
      const workspacePath = path.join(tempWorkspaceRoot, identity.slug);
      workspace = await ensureTempWorkspace(workspaceId, workspacePath);
    }

    touchTempWorkspaceLease(workspace.id);

    try {
      pruneTempWorkspaces({
        db,
        tempWorkspaceRoot,
        currentWorkspaceId: workspace.id,
        protectedWorkspaceIds: getActiveTempWorkspaceLeases(),
      });
    } catch (error) {
      logger.warn("Failed to prune temp workspaces:", error);
    }

    return workspace;
  };

  // File handlers - open files and show in Finder
  ipcMain.handle(
    IPC_CHANNELS.FILE_OPEN,
    async (_, filePath: string, workspacePath?: string) => {
      // Security: require workspacePath and validate path is within it
      if (!workspacePath) {
        throw new Error("Workspace path is required for file operations");
      }

      const { resolvedPath } = await resolveExistingPathForViewer(
        filePath,
        workspacePath,
        {
          requireWorkspaceContainment: true,
        },
      );
      if (!resolvedPath) {
        return "File not found";
      }

      return shell.openPath(resolvedPath);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.FILE_OPEN_WITH_APP,
    async (_, filePath: string, workspacePath: string | undefined, appName: string) => {
      if (!workspacePath) {
        throw new Error("Workspace path is required for file operations");
      }
      const allowedApps = new Set([
        "Microsoft Excel",
        "Numbers",
        "Microsoft Outlook",
        "Microsoft Word",
        "Pages",
        "TextEdit",
        "Microsoft PowerPoint",
        "Keynote",
        "LibreOffice",
        "Preview",
      ]);
      if (!allowedApps.has(appName)) {
        throw new Error("Unsupported application");
      }

      const { resolvedPath } = await resolveExistingPathForViewer(
        filePath,
        workspacePath,
        {
          requireWorkspaceContainment: true,
        },
      );
      if (!resolvedPath) {
        return "File not found";
      }

      if (process.platform === "darwin") {
        await execFileAsync("/usr/bin/open", ["-a", appName, resolvedPath], {
          timeout: 10_000,
        });
        return "";
      }

      return shell.openPath(resolvedPath);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.FILE_SHOW_IN_FINDER,
    async (_, filePath: string, workspacePath?: string) => {
      // Security: require workspacePath and validate path is within it
      if (!workspacePath) {
        throw new Error("Workspace path is required for file operations");
      }

      const { resolvedPath } = await resolveExistingPathForViewer(
        filePath,
        workspacePath,
        {
          requireWorkspaceContainment: true,
        },
      );
      if (!resolvedPath) {
        throw new Error("File not found");
      }

      shell.showItemInFolder(resolvedPath);
    },
  );

  // Open external URL in system browser
  ipcMain.handle(IPC_CHANNELS.SHELL_OPEN_EXTERNAL, async (_, url: string) => {
    // Validate URL to prevent security issues
    try {
      const parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Only http and https URLs are allowed");
      }
      await shell.openExternal(url);
    } catch (error: Any) {
      throw new Error(`Failed to open URL: ${error.message}`);
    }
  });

  // Open macOS System Settings panes (with AppleScript fallback for reliability)
  ipcMain.handle(
    IPC_CHANNELS.SYSTEM_OPEN_SETTINGS,
    async (_, target: unknown) => {
      if (process.platform !== "darwin") {
        return {
          success: false,
          error: "System settings shortcuts are only available on macOS.",
        };
      }

      if (!isMacSystemSettingsTarget(target)) {
        return { success: false, error: "Unknown settings target." };
      }

      try {
        await openMacSystemSettings(target);
        return { success: true };
      } catch (error: Any) {
        return {
          success: false,
          error: error?.message || "Failed to open System Settings.",
        };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.PROFILE_LIST, async () => {
    return ProfileManager.listProfiles();
  });

  ipcMain.handle(
    IPC_CHANNELS.PROFILE_CREATE,
    async (_, rawProfileName: unknown) => {
      const profileName = validateInput(
        ProfileNameSchema,
        rawProfileName,
        "profile name",
      );
      return ProfileManager.ensureProfile(profileName);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROFILE_SWITCH,
    async (_, rawProfileId: unknown) => {
      const profileId = validateInput(
        ProfileNameSchema,
        rawProfileId,
        "profile id",
      );
      return ProfileManager.switchProfile(profileId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROFILE_EXPORT,
    async (_, payload: { profileId: unknown; destinationRoot: unknown }) => {
      const profileId = validateInput(
        ProfileNameSchema,
        payload?.profileId,
        "profile id",
      );
      const destinationRoot = validateInput(
        z.string().trim().min(1),
        payload?.destinationRoot,
        "destination folder",
      );
      return ProfileManager.exportProfile(profileId, destinationRoot);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PROFILE_IMPORT,
    async (_, payload: { sourcePath: unknown; profileName?: unknown }) => {
      const sourcePath = validateInput(
        z.string().trim().min(1),
        payload?.sourcePath,
        "source folder",
      );
      const profileName =
        payload &&
        typeof payload.profileName === "string" &&
        payload.profileName.trim().length > 0
          ? validateInput(
              ProfileNameSchema,
              payload.profileName,
              "profile name",
            )
          : undefined;
      return ProfileManager.importProfile(sourcePath, profileName);
    },
  );

  // File viewer handler - read file content for in-app preview
  ipcMain.handle(
    IPC_CHANNELS.FILE_READ_FOR_VIEWER,
    async (_, data: { filePath: string } & FileViewerRequestOptions) => {
      const {
        filePath,
        workspacePath,
        enableImageOcr,
        imageOcrMaxChars,
        includeImageContent = true,
        includePdfBase64 = false,
        presentationRenderMode = "full",
      } = data;

      if (!workspacePath || !workspacePath.trim()) {
        throw new Error("Workspace path is required for file preview operations");
      }

      const { resolvedPath, attemptedPaths } =
        await resolveExistingPathForViewer(filePath, workspacePath, {
          requireWorkspaceContainment: true,
        });
      if (!resolvedPath) {
        const attempted =
          attemptedPaths.length > 0
            ? ` (tried ${attemptedPaths.length} location(s))`
            : "";
        return {
          success: false,
          error: `File not found: ${filePath}${attempted}`,
        };
      }

      // Get file stats
      const stats = await fs.stat(resolvedPath);
      const extension = path.extname(resolvedPath).toLowerCase();
      const fileName = path.basename(resolvedPath);

      // Determine file type
      const getFileType = (
        ext: string,
      ):
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
        | "unsupported" => {
        const codeExtensions = [
          ".js",
          ".ts",
          ".tsx",
          ".jsx",
          ".py",
          ".java",
          ".go",
          ".rs",
          ".c",
          ".cpp",
          ".h",
          ".css",
          ".scss",
          ".xml",
          ".yaml",
          ".yml",
          ".toml",
          ".sh",
          ".bash",
          ".zsh",
          ".sql",
          ".graphql",
          ".vue",
          ".svelte",
          ".rb",
          ".php",
          ".swift",
          ".kt",
          ".scala",
        ];
        const textExtensions = [
          ".txt",
          ".log",
          ".env",
          ".gitignore",
          ".dockerignore",
          ".editorconfig",
          ".prettierrc",
          ".eslintrc",
        ];
        const imageExtensions = [
          ".png",
          ".jpg",
          ".jpeg",
          ".gif",
          ".webp",
          ".svg",
          ".bmp",
          ".ico",
        ];
        const videoExtensions = [".mp4", ".webm"];
        const audioExtensions = [".mp3", ".wav", ".ogg", ".m4a", ".flac", ".aac"];

        if (ext === ".md" || ext === ".markdown") return "markdown";
        if (ext === ".html" || ext === ".htm") return "html";
        if (ext === ".tex") return "latex";
        if (ext === ".docx") return "docx";
        if (
          ext === ".docm" ||
          ext === ".dotx" ||
          ext === ".dotm" ||
          ext === ".doc" ||
          ext === ".rtf" ||
          ext === ".odt" ||
          ext === ".ott" ||
          ext === ".pages"
        ) return "document";
        if (ext === ".pdf") return "pdf";
        if (ext === ".pptx") return "pptx";
        if (ext === ".xlsx" || ext === ".xls" || ext === ".xlsm") return "xlsx";
        if (ext === ".json" || ext === ".jsonl" || ext === ".geojson") return "json";
        if (ext === ".csv" || ext === ".tsv") return "csv";
        if (imageExtensions.includes(ext)) return "image";
        if (videoExtensions.includes(ext)) return "video";
        if (audioExtensions.includes(ext)) return "audio";
        if (codeExtensions.includes(ext)) return "code";
        if (textExtensions.includes(ext)) return "text";

        return "unsupported";
      };

      let fileType = getFileType(extension);
      if (stats.isDirectory()) {
        fileType = "html";
      } else if (fileName === "package.json") {
        try {
          const packageJsonText = await fs.readFile(resolvedPath, "utf-8");
          const packageJson = JSON.parse(packageJsonText) as {
            dependencies?: Record<string, unknown>;
            devDependencies?: Record<string, unknown>;
          };
          const deps = {
            ...packageJson.dependencies,
            ...packageJson.devDependencies,
          };
          if ("react" in deps || "react-dom" in deps || "vite" in deps || "next" in deps) {
            fileType = "html";
          }
        } catch {
          fileType = "json";
        }
      }
      const shouldAttemptImageOcr = shouldRunImageOcr({
        enableImageOcr,
        extension,
        fileSizeBytes: stats.size,
      });

      // Size limits
      const MAX_TEXT_SIZE = 5 * 1024 * 1024; // 5MB
      const MAX_PDF_SIZE = 75 * 1024 * 1024; // 75MB
      const MAX_PDF_BASE64_SIZE = 25 * 1024 * 1024; // 25MB for inline review surfaces
      const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
      const MAX_VIDEO_SIZE = 500 * 1024 * 1024; // 500MB
      const MAX_AUDIO_SIZE = 200 * 1024 * 1024; // 200MB
      const MAX_PPTX_VIEWER_SIZE = 50 * 1024 * 1024; // 50MB before hard-stop
      const MAX_XLSX_SIZE = 20 * 1024 * 1024; // 20MB for spreadsheets
      const MAX_DOCUMENT_VIEWER_SIZE = 25 * 1024 * 1024; // 25MB for document extraction
      const MAX_INLINE_VIDEO_DATA_URL_SIZE = 25 * 1024 * 1024; // 25MB for reliable in-app playback
      const MAX_INLINE_AUDIO_DATA_URL_SIZE = 25 * 1024 * 1024;

      if (fileType === "image" && stats.size > MAX_IMAGE_SIZE) {
        return {
          success: false,
          error: "File too large for preview (max 10MB for images)",
        };
      }
      if (fileType === "video" && stats.size > MAX_VIDEO_SIZE) {
        return {
          success: false,
          error: "File too large for preview (max 500MB for videos)",
        };
      }
      if (fileType === "audio" && stats.size > MAX_AUDIO_SIZE) {
        return {
          success: false,
          error: "File too large for preview (max 200MB for audio)",
        };
      }
      if (fileType === "pptx" && stats.size > MAX_PPTX_VIEWER_SIZE) {
        return {
          success: false,
          error: "PPTX file too large for preview (max 50MB)",
        };
      }
      if (fileType === "xlsx" && stats.size > MAX_XLSX_SIZE) {
        return {
          success: false,
          error: "Spreadsheet too large for extraction (max 20MB)",
        };
      }
      if ((fileType === "docx" || fileType === "document") && stats.size > MAX_DOCUMENT_VIEWER_SIZE) {
        return {
          success: false,
          error: "Document too large for preview (max 25MB)",
        };
      }
      if (fileType === "pdf" && stats.size > MAX_PDF_SIZE) {
        return {
          success: false,
          error: "PDF file too large for review (max 75MB)",
        };
      }
      if (
        fileType !== "image" &&
        fileType !== "video" &&
        fileType !== "audio" &&
        fileType !== "unsupported" &&
        fileType !== "pptx" &&
        fileType !== "xlsx" &&
        fileType !== "docx" &&
        fileType !== "document" &&
        fileType !== "pdf" &&
        stats.size > MAX_TEXT_SIZE
      ) {
        return {
          success: false,
          error: "File too large for preview (max 5MB for text files)",
        };
      }

      try {
        let content: string | null = null;
        let htmlContent: string | undefined;
        let ocrText: string | undefined;
        let pdfThumbnailDataUrl: string | undefined;
        let pdfDataBase64: string | undefined;
        let pdfReviewSummary: PdfReviewSummary | undefined;
        let presentationPreview: PptxPresentationPreview | undefined;
        let spreadsheetPreview:
          | Awaited<ReturnType<typeof buildSpreadsheetPreviewFromFile>>
          | undefined;
        let documentPreview: DocumentPreview | undefined;
        let webPreview: WebPagePreview | undefined;
        let playbackUrl: string | undefined;
        let mimeType: string | undefined;

        switch (fileType) {
          case "markdown":
          case "latex":
          case "code":
          case "text":
          case "json": {
            content = await fs.readFile(resolvedPath, "utf-8");
            break;
          }

          case "csv": {
            content = await fs.readFile(resolvedPath, "utf-8");
            spreadsheetPreview = buildDelimitedSpreadsheetPreview(content, {
              delimiter: extension === ".tsv" ? "\t" : ",",
              sheetName: path.basename(resolvedPath, extension),
            });
            break;
          }

          case "docx": {
            documentPreview = await buildDocumentPreviewFromFile(resolvedPath);
            htmlContent = documentPreview.htmlContent;
            content = documentPreview.text || null;
            break;
          }

          case "document": {
            documentPreview = await buildDocumentPreviewFromFile(resolvedPath);
            htmlContent = documentPreview.htmlContent;
            content = documentPreview.text || null;
            break;
          }

          case "pdf": {
            const pdfReview = await extractPdfReviewData(resolvedPath, {
              maxPages: 12,
              maxCharsPerPage: 1800,
              maxOcrPages: 4,
              includeOcr: true,
            });
            content = pdfReview.content;
            pdfReviewSummary = pdfReview;
            pdfThumbnailDataUrl =
              await renderPdfFirstPageThumbnail(resolvedPath);
            if (includePdfBase64 && stats.size <= MAX_PDF_BASE64_SIZE) {
              const buffer = await fs.readFile(resolvedPath);
              pdfDataBase64 = buffer.toString("base64");
            }
            break;
          }

          case "image": {
            const mimeTypes: Record<string, string> = {
              ".png": "image/png",
              ".jpg": "image/jpeg",
              ".jpeg": "image/jpeg",
              ".gif": "image/gif",
              ".webp": "image/webp",
              ".svg": "image/svg+xml",
              ".bmp": "image/bmp",
              ".ico": "image/x-icon",
            };

            if (includeImageContent) {
              const buffer = await fs.readFile(resolvedPath);
              const mimeType = mimeTypes[extension] || "image/png";
              content = `data:${mimeType};base64,${buffer.toString("base64")}`;
            }

            if (shouldAttemptImageOcr) {
              const requestOcrChars = resolveImageOcrChars(imageOcrMaxChars);
              ocrText =
                (await runOcrFromImagePath(resolvedPath, requestOcrChars)) ??
                undefined;
            }
            break;
          }

          case "audio": {
            mimeType =
              ((mime.lookup(resolvedPath) || undefined) as
                | string
                | undefined) || undefined;
            if (!mimeType || !mimeType.startsWith("audio/")) {
              const fallbackByExt: Record<string, string> = {
                ".mp3": "audio/mpeg",
                ".wav": "audio/wav",
                ".ogg": "audio/ogg",
                ".m4a": "audio/mp4",
                ".flac": "audio/flac",
                ".aac": "audio/aac",
              };
              mimeType = fallbackByExt[extension];
            }
            if (!mimeType) {
              return { success: false, error: "Unsupported audio type" };
            }
            if (stats.size <= MAX_INLINE_AUDIO_DATA_URL_SIZE) {
              const buffer = await fs.readFile(resolvedPath);
              playbackUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
            } else {
              if (!workspacePath || workspacePath.trim().length === 0) {
                return {
                  success: false,
                  error: "Workspace path is required for audio preview",
                };
              }
              playbackUrl = createMediaPlaybackUrl({
                resolvedPath,
                workspaceRoot: workspacePath,
                mimeType,
              });
            }
            content = null;
            break;
          }

          case "video": {
            mimeType =
              ((mime.lookup(resolvedPath) || undefined) as
                | string
                | undefined) || undefined;
            if (
              !mimeType ||
              (mimeType !== "video/mp4" && mimeType !== "video/webm")
            ) {
              return { success: false, error: "Unsupported video type" };
            }
            if (mimeType === "video/mp4") {
              const transcodedPreviewUrl =
                await generateTranscodedVideoPreviewDataUrl(
                  resolvedPath,
                  stats,
                );
              if (transcodedPreviewUrl) {
                playbackUrl = transcodedPreviewUrl;
                content = null;
                break;
              }
            }
            if (stats.size <= MAX_INLINE_VIDEO_DATA_URL_SIZE) {
              const buffer = await fs.readFile(resolvedPath);
              playbackUrl = `data:${mimeType};base64,${buffer.toString("base64")}`;
            } else {
              if (!workspacePath || workspacePath.trim().length === 0) {
                return {
                  success: false,
                  error: "Workspace path is required for video preview",
                };
              }
              playbackUrl = createMediaPlaybackUrl({
                resolvedPath,
                workspaceRoot: workspacePath,
                mimeType,
              });
            }
            content = null;
            break;
          }

          case "html": {
            webPreview = await buildWebPagePreviewFromPath(resolvedPath, workspacePath);
            htmlContent = webPreview.htmlContent;
            content = null; // HTML content is in htmlContent
            break;
          }

          case "pptx": {
            presentationPreview = await getSharedPptxPreviewService().buildPreview({
              filePath: resolvedPath,
              workspaceRoot: workspacePath,
              renderMode: presentationRenderMode,
            });
            content = buildPptxContentFromPreview(presentationPreview);
            break;
          }

          case "xlsx": {
            spreadsheetPreview = await buildSpreadsheetPreviewFromFile(resolvedPath);
            content = spreadsheetPreviewToTsv(spreadsheetPreview);
            break;
          }

          default:
            return {
              success: false,
              error: "Unsupported file type",
              fileType: "unsupported",
            };
        }

        return {
          success: true,
          data: {
            path: resolvedPath,
            fileName,
            fileType,
            content,
            htmlContent,
            size: stats.size,
            ocrText,
            pdfThumbnailDataUrl,
            pdfDataBase64,
            pdfReviewSummary,
            presentationPreview,
            spreadsheetPreview,
            documentPreview,
            webPreview,
            playbackUrl,
            mimeType,
          },
        };
      } catch (error: Any) {
        return {
          success: false,
          error: `Failed to read file: ${error.message}`,
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.FILE_UPDATE_SPREADSHEET,
    async (
      _,
      data: {
        filePath: string;
        workspacePath: string;
        preview: SpreadsheetPreview;
      },
    ) => {
      const { filePath, workspacePath, preview } = data || {};
      if (!workspacePath || !workspacePath.trim()) {
        throw new Error("Workspace path is required for spreadsheet edits");
      }
      if (!preview || !Array.isArray(preview.sheets)) {
        return { success: false, error: "Spreadsheet data is missing" };
      }

      const { resolvedPath, attemptedPaths } = await resolveExistingPathForViewer(
        filePath,
        workspacePath,
        {
          requireWorkspaceContainment: true,
        },
      );
      if (!resolvedPath) {
        const attempted =
          attemptedPaths.length > 0 ? ` (tried ${attemptedPaths.length} location(s))` : "";
        return {
          success: false,
          error: `File not found: ${filePath}${attempted}`,
        };
      }

      const extension = path.extname(resolvedPath).toLowerCase();
      if (
        extension !== ".xlsx" &&
        extension !== ".xls" &&
        extension !== ".xlsm" &&
        extension !== ".csv" &&
        extension !== ".tsv"
      ) {
        return {
          success: false,
          error: "Only local spreadsheet files can be edited in the spreadsheet viewer",
        };
      }

      try {
        const isDelimitedSpreadsheet = extension === ".csv" || extension === ".tsv";
        const spreadsheetPreview = isDelimitedSpreadsheet
          ? await writeDelimitedSpreadsheetPreviewToFile(
              resolvedPath,
              preview,
              extension === ".tsv" ? "\t" : ",",
            )
          : await writeSpreadsheetPreviewToFile(resolvedPath, preview);
        return {
          success: true,
          data: {
            path: resolvedPath,
            fileName: path.basename(resolvedPath),
            fileType: isDelimitedSpreadsheet ? ("csv" as const) : ("xlsx" as const),
            content: spreadsheetPreviewToTsv(spreadsheetPreview),
            spreadsheetPreview,
            size: (await fs.stat(resolvedPath)).size,
          },
        };
      } catch (error: Any) {
        return {
          success: false,
          error: `Failed to save spreadsheet: ${error.message}`,
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.FILE_UPDATE_DOCUMENT,
    async (
      _,
      data: {
        filePath: string;
        workspacePath: string;
        blocks: EditableDocumentBlock[];
      },
    ) => {
      const { filePath, workspacePath, blocks } = data || {};
      if (!workspacePath || !workspacePath.trim()) {
        throw new Error("Workspace path is required for document edits");
      }
      if (!Array.isArray(blocks)) {
        return { success: false, error: "Document edit data is missing" };
      }

      const { resolvedPath, attemptedPaths } = await resolveExistingPathForViewer(
        filePath,
        workspacePath,
        { requireWorkspaceContainment: true },
      );
      if (!resolvedPath) {
        const attempted =
          attemptedPaths.length > 0 ? ` (tried ${attemptedPaths.length} location(s))` : "";
        return {
          success: false,
          error: `File not found: ${filePath}${attempted}`,
        };
      }

      const extension = path.extname(resolvedPath).toLowerCase();
      if (extension !== ".docx") {
        return {
          success: false,
          error: "Only DOCX files can be edited directly in the document viewer",
        };
      }

      try {
        await writeEditableDocumentBlocksToDocxFile(resolvedPath, blocks);
        const documentPreview = await buildDocumentPreviewFromFile(resolvedPath);
        return {
          success: true,
          data: {
            path: resolvedPath,
            fileName: path.basename(resolvedPath),
            fileType: "docx" as const,
            content: documentPreview.text || null,
            htmlContent: documentPreview.htmlContent,
            documentPreview,
            size: (await fs.stat(resolvedPath)).size,
          },
        };
      } catch (error: Any) {
        return {
          success: false,
          error: `Failed to save document: ${error.message}`,
        };
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.LLM_WIKI_GET_VAULT_SUMMARY,
    async (
      _,
      data: {
        workspacePath: unknown;
        vaultPath?: unknown;
      },
    ) => {
      const payload = validateInput(
        z.object({
          workspacePath: z.string().trim().min(1),
          vaultPath: z.string().trim().min(1).optional(),
        }),
        data,
        "llm-wiki vault request",
      );
      return collectLlmWikiVaultSummary(payload.workspacePath, payload.vaultPath);
    },
  );

  // File import handler - copy selected files into the workspace for attachment use
  ipcMain.handle(
    IPC_CHANNELS.FILE_IMPORT_TO_WORKSPACE,
    async (_, data: { workspaceId: string; files: string[] }) => {
      const validated = validateInput(FileImportSchema, data, "file import");
      const workspace = workspaceRepo.findById(validated.workspaceId);

      if (!workspace) {
        throw new Error(`Workspace not found: ${validated.workspaceId}`);
      }

      if (!workspace.permissions.write) {
        throw new Error("Write permission not granted for workspace");
      }

      const sanitizeFileName = (fileName: string): string => {
        const sanitized = fileName
          .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
          .trim();
        return sanitized.length > 0 ? sanitized : "file";
      };

      const ensureUniqueName = (
        dir: string,
        baseName: string,
        usedNames: Set<string>,
      ): string => {
        const ext = path.extname(baseName);
        const stem = path.basename(baseName, ext);
        let candidate = baseName;
        let counter = 1;
        while (
          usedNames.has(candidate) ||
          fsSync.existsSync(path.join(dir, candidate))
        ) {
          candidate = `${stem}-${counter}${ext}`;
          counter += 1;
        }
        usedNames.add(candidate);
        return candidate;
      };

      let uploadRoot: string | null = null;
      const usedNames = new Set<string>();

      const ensureUploadRoot = async (): Promise<string> => {
        if (uploadRoot) return uploadRoot;
        uploadRoot = path.join(
          workspace.path,
          ".cowork",
          "uploads",
          `${Date.now()}`,
        );
        await fs.mkdir(uploadRoot, { recursive: true });
        return uploadRoot;
      };

      const results: Array<{
        relativePath: string;
        fileName: string;
        size: number;
        mimeType?: string;
      }> = [];

      for (const filePath of validated.files) {
        const absolutePath = path.isAbsolute(filePath)
          ? filePath
          : path.resolve(filePath);
        const stats = await fs.stat(absolutePath);

        if (!stats.isFile()) {
          throw new Error(`Not a file: ${filePath}`);
        }

        const sizeCheck = GuardrailManager.isFileSizeExceeded(stats.size);
        if (sizeCheck.exceeded) {
          throw new Error(
            `File "${path.basename(filePath)}" is ${sizeCheck.sizeMB.toFixed(1)}MB and exceeds the ${sizeCheck.limitMB}MB limit.`,
          );
        }

        const mimeType = (mime.lookup(absolutePath) || undefined) as
          | string
          | undefined;

        if (isPathWithinWorkspace(absolutePath, workspace.path)) {
          results.push({
            relativePath: path.relative(workspace.path, absolutePath),
            fileName: path.basename(absolutePath),
            size: stats.size,
            mimeType,
          });
          continue;
        }

        if (!isApprovedImportFile(absolutePath)) {
          throw new Error(
            `Import denied for "${path.basename(absolutePath)}". Select the file again from the native picker before attaching it.`,
          );
        }

        const safeName = sanitizeFileName(path.basename(absolutePath));
        const targetRoot = await ensureUploadRoot();
        const uniqueName = ensureUniqueName(targetRoot, safeName, usedNames);
        const destination = path.join(targetRoot, uniqueName);

        await fs.copyFile(absolutePath, destination);
        FileProvenanceRegistry.record({
          path: destination,
          workspaceId: workspace.id,
          sourceKind: "user_imported_external",
          trustLevel: "untrusted",
          sourceLabel: path.basename(absolutePath),
        });

        results.push({
          relativePath: path.relative(workspace.path, destination),
          fileName: uniqueName,
          size: stats.size,
          mimeType,
        });
      }

      return results;
    },
  );

  // File import handler - save provided file data into the workspace (clipboard / drag data)
  ipcMain.handle(
    IPC_CHANNELS.FILE_IMPORT_DATA_TO_WORKSPACE,
    async (
      _,
      data: {
        workspaceId: string;
        files: Array<{ name: string; data: string; mimeType?: string }>;
      },
    ) => {
      const validated = validateInput(
        FileImportDataSchema,
        data,
        "file import data",
      );
      const workspace = workspaceRepo.findById(validated.workspaceId);

      if (!workspace) {
        throw new Error(`Workspace not found: ${validated.workspaceId}`);
      }

      if (!workspace.permissions.write) {
        throw new Error("Write permission not granted for workspace");
      }

      const sanitizeFileName = (fileName: string): string => {
        const sanitized = fileName
          .replace(/[<>:"/\\|?*\x00-\x1F]/g, "_")
          .trim();
        return sanitized.length > 0 ? sanitized : "file";
      };

      const ensureExtension = (fileName: string, mimeType?: string): string => {
        if (path.extname(fileName) || !mimeType) return fileName;
        const ext = mime.extension(mimeType);
        return ext ? `${fileName}.${ext}` : fileName;
      };

      const ensureUniqueName = (
        dir: string,
        baseName: string,
        usedNames: Set<string>,
      ): string => {
        const ext = path.extname(baseName);
        const stem = path.basename(baseName, ext);
        let candidate = baseName;
        let counter = 1;
        while (
          usedNames.has(candidate) ||
          fsSync.existsSync(path.join(dir, candidate))
        ) {
          candidate = `${stem}-${counter}${ext}`;
          counter += 1;
        }
        usedNames.add(candidate);
        return candidate;
      };

      const uploadRoot = path.join(
        workspace.path,
        ".cowork",
        "uploads",
        `${Date.now()}`,
      );
      await fs.mkdir(uploadRoot, { recursive: true });
      const usedNames = new Set<string>();

      const results: Array<{
        relativePath: string;
        fileName: string;
        size: number;
        mimeType?: string;
      }> = [];

      for (const file of validated.files) {
        const rawName = ensureExtension(
          sanitizeFileName(file.name),
          file.mimeType,
        );
        const uniqueName = ensureUniqueName(uploadRoot, rawName, usedNames);
        const destination = path.join(uploadRoot, uniqueName);
        const buffer = Buffer.from(file.data, "base64");

        const sizeCheck = GuardrailManager.isFileSizeExceeded(buffer.length);
        if (sizeCheck.exceeded) {
          throw new Error(
            `File "${rawName}" is ${sizeCheck.sizeMB.toFixed(1)}MB and exceeds the ${sizeCheck.limitMB}MB limit.`,
          );
        }

        await fs.writeFile(destination, buffer);
        FileProvenanceRegistry.record({
          path: destination,
          workspaceId: workspace.id,
          sourceKind: "clipboard_or_drag_data",
          trustLevel: "untrusted",
          sourceLabel: rawName,
        });

        results.push({
          relativePath: path.relative(workspace.path, destination),
          fileName: uniqueName,
          size: buffer.length,
          mimeType: file.mimeType,
        });
      }

      return results;
    },
  );

  ipcMain.handle(IPC_CHANNELS.DOCUMENT_OPEN_EDITOR_SESSION, async (_, data) => {
    const validated = validateInput(
      DocumentEditorOpenSessionSchema,
      data,
      "document editor open session",
    );
    return documentEditorSessionService.openSession(
      validated.filePath,
      validated.workspacePath,
    );
  });

  ipcMain.handle(IPC_CHANNELS.DOCUMENT_LIST_VERSIONS, async (_, data) => {
    const validated = validateInput(
      DocumentEditorListVersionsSchema,
      data,
      "document editor version list",
    );
    return documentEditorSessionService.listVersions(
      validated.filePath,
      validated.workspacePath,
    );
  });

  ipcMain.handle(IPC_CHANNELS.DOCUMENT_START_EDIT_TASK, async (_, data) => {
    checkRateLimit(IPC_CHANNELS.TASK_CREATE);
    const validated = validateInput(
      DocumentEditRequestSchema,
      data,
      "document edit request",
    );
    return documentEditorSessionService.startEditTask(validated);
  });

  ipcMain.handle(IPC_CHANNELS.MAILBOX_GET_SYNC_STATUS, async (event) => {
    assertTrustedMailboxSender(event);
    return mailboxService.getSyncStatus();
  });

  ipcMain.handle(IPC_CHANNELS.MAILBOX_CLIENT_STATE, async (event) => {
    assertTrustedMailboxSender(event);
    return mailboxService.getMailboxClientState();
  });

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_SYNC,
    async (event, data?: { limit?: number }) => {
      assertTrustedMailboxSender(event);
      return mailboxService.sync(data?.limit);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_LIST_THREADS,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      return mailboxService.listThreads({
        accountId:
          typeof data?.accountId === "string" ? data.accountId : undefined,
        query: typeof data?.query === "string" ? data.query : undefined,
        category: typeof data?.category === "string" ? data.category : "all",
        mailboxView:
          data?.mailboxView === "sent" ||
          data?.mailboxView === "all" ||
          data?.mailboxView === "inbox"
            ? data.mailboxView
            : undefined,
        unreadOnly:
          typeof data?.unreadOnly === "boolean" ? data.unreadOnly : undefined,
        needsReply:
          typeof data?.needsReply === "boolean" ? data.needsReply : undefined,
        hasSuggestedProposal:
          typeof data?.hasSuggestedProposal === "boolean"
            ? data.hasSuggestedProposal
            : undefined,
        hasOpenCommitment:
          typeof data?.hasOpenCommitment === "boolean"
            ? data.hasOpenCommitment
            : undefined,
        cleanupCandidate:
          typeof data?.cleanupCandidate === "boolean"
            ? data.cleanupCandidate
            : undefined,
        todayBucket:
          typeof data?.todayBucket === "string" ? data.todayBucket : undefined,
        domainCategory:
          typeof data?.domainCategory === "string" ? data.domainCategory : undefined,
        hasAttachment:
          typeof data?.hasAttachment === "boolean" ? data.hasAttachment : undefined,
        attachmentQuery:
          typeof data?.attachmentQuery === "string" ? data.attachmentQuery : undefined,
        sortBy:
          data?.sortBy === "recent"
            ? "recent"
            : data?.sortBy === "priority"
              ? "priority"
              : undefined,
        limit: typeof data?.limit === "number" ? data.limit : undefined,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_GET_THREAD,
    async (event, threadId: string) => {
      assertTrustedMailboxSender(event);
      return mailboxService.getThread(threadId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_LIST_EVENTS,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      return mailboxService.listMailboxEvents(
        typeof data?.limit === "number" ? data.limit : undefined,
        typeof data?.threadId === "string" ? data.threadId : undefined,
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_AUTOMATION_LIST,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      return mailboxService.listMailboxAutomations({
        workspaceId:
          typeof data?.workspaceId === "string" ? data.workspaceId : undefined,
        threadId:
          typeof data?.threadId === "string" ? data.threadId : undefined,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_AUTOMATION_LIST_THREAD,
    async (event, threadId: string) => {
      assertTrustedMailboxSender(event);
      return mailboxService.listThreadAutomations(threadId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_AUTOMATION_CREATE_RULE,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      return mailboxService.createMailboxRule(data?.recipe || data);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_AUTOMATION_UPDATE_RULE,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      if (typeof data?.id !== "string") {
        throw new Error("Missing automation id for mailbox rule update");
      }
      return mailboxService.updateMailboxRule(data.id, data.patch || {});
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_AUTOMATION_DELETE_RULE,
    async (event, id: string) => {
      assertTrustedMailboxSender(event);
      return mailboxService.deleteMailboxRule(id);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_AUTOMATION_CREATE_SCHEDULE,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      return mailboxService.createMailboxSchedule(data?.recipe || data);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_AUTOMATION_UPDATE_SCHEDULE,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      if (typeof data?.id !== "string") {
        throw new Error("Missing automation id for mailbox schedule update");
      }
      return mailboxService.updateMailboxSchedule(data.id, data.patch || {});
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_AUTOMATION_DELETE_SCHEDULE,
    async (event, id: string) => {
      assertTrustedMailboxSender(event);
      return mailboxService.deleteMailboxSchedule(id);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_AUTOMATION_CREATE_FORWARD,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      return mailboxService.createMailboxForward(data?.recipe || data);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_AUTOMATION_UPDATE_FORWARD,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      if (typeof data?.id !== "string") {
        throw new Error("Missing automation id for mailbox forward update");
      }
      return mailboxService.updateMailboxForward(data.id, data.patch || {});
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_AUTOMATION_DELETE_FORWARD,
    async (event, id: string) => {
      assertTrustedMailboxSender(event);
      return mailboxService.deleteMailboxForward(id);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_AUTOMATION_RUN_FORWARD,
    async (event, id: string) => {
      assertTrustedMailboxSender(event);
      return mailboxService.runMailboxForward(id);
    },
  );

  ipcMain.handle(IPC_CHANNELS.MAILBOX_GET_DIGEST, async (event, data?: Any) => {
    assertTrustedMailboxSender(event);
    return mailboxService.getMailboxDigest(
      typeof data?.workspaceId === "string" ? data.workspaceId : undefined,
    );
  });

  ipcMain.handle(IPC_CHANNELS.MAILBOX_TODAY_DIGEST, async (event, data?: Any) => {
    assertTrustedMailboxSender(event);
    return mailboxService.getMailboxTodayDigest({
      limitPerBucket: typeof data?.limitPerBucket === "number" ? data.limitPerBucket : undefined,
    });
  });

  ipcMain.handle(IPC_CHANNELS.MAILBOX_SENDER_CLEANUP_DIGEST, async (event, data?: Any) => {
    assertTrustedMailboxSender(event);
    return mailboxService.getMailboxSenderCleanupDigest({
      limit: typeof data?.limit === "number" ? data.limit : undefined,
    });
  });

  ipcMain.handle(IPC_CHANNELS.MAILBOX_ASK, async (event, data?: Any) => {
    assertTrustedMailboxSender(event);
    return mailboxService.askMailbox({
      query: typeof data?.query === "string" ? data.query : "",
      limit: typeof data?.limit === "number" ? data.limit : undefined,
      includeAnswer: typeof data?.includeAnswer === "boolean" ? data.includeAnswer : undefined,
    });
  });

  ipcMain.handle(IPC_CHANNELS.MAILBOX_ATTACHMENT_EXTRACT_TEXT, async (event, data?: Any) => {
    assertTrustedMailboxSender(event);
    const attachmentId = typeof data?.attachmentId === "string" ? data.attachmentId : "";
    if (!attachmentId) throw new Error("Missing mailbox attachment id");
    return mailboxService.extractMailboxAttachmentText(attachmentId);
  });

  ipcMain.handle(IPC_CHANNELS.MAILBOX_CREATE_DRAFT, async (event, data?: Any) => {
    assertTrustedMailboxSender(event);
    return mailboxService.createMailboxDraft({
      accountId: typeof data?.accountId === "string" ? data.accountId : undefined,
      threadId: typeof data?.threadId === "string" ? data.threadId : undefined,
      mode:
        data?.mode === "reply" || data?.mode === "reply_all" || data?.mode === "forward"
          ? data.mode
          : "new",
      subject: typeof data?.subject === "string" ? data.subject : undefined,
      bodyText: typeof data?.bodyText === "string" ? data.bodyText : undefined,
      bodyHtml: typeof data?.bodyHtml === "string" ? data.bodyHtml : undefined,
      to: Array.isArray(data?.to) ? data.to : undefined,
      cc: Array.isArray(data?.cc) ? data.cc : undefined,
      bcc: Array.isArray(data?.bcc) ? data.bcc : undefined,
      identityId: typeof data?.identityId === "string" ? data.identityId : undefined,
      signatureId: typeof data?.signatureId === "string" ? data.signatureId : undefined,
    });
  });

  ipcMain.handle(IPC_CHANNELS.MAILBOX_UPDATE_DRAFT, async (event, data?: Any) => {
    assertTrustedMailboxSender(event);
    const draftId = typeof data?.draftId === "string" ? data.draftId : "";
    if (!draftId) throw new Error("Missing mailbox draft id");
    return mailboxService.updateMailboxDraft(draftId, {
      subject: typeof data?.patch?.subject === "string" ? data.patch.subject : undefined,
      bodyText: typeof data?.patch?.bodyText === "string" ? data.patch.bodyText : undefined,
      bodyHtml:
        typeof data?.patch?.bodyHtml === "string" || data?.patch?.bodyHtml === null
          ? data.patch.bodyHtml
          : undefined,
      to: Array.isArray(data?.patch?.to) ? data.patch.to : undefined,
      cc: Array.isArray(data?.patch?.cc) ? data.patch.cc : undefined,
      bcc: Array.isArray(data?.patch?.bcc) ? data.patch.bcc : undefined,
      identityId:
        typeof data?.patch?.identityId === "string" || data?.patch?.identityId === null
          ? data.patch.identityId
          : undefined,
      signatureId:
        typeof data?.patch?.signatureId === "string" || data?.patch?.signatureId === null
          ? data.patch.signatureId
          : undefined,
      scheduledAt:
        typeof data?.patch?.scheduledAt === "number" || data?.patch?.scheduledAt === null
          ? data.patch.scheduledAt
          : undefined,
    });
  });

  ipcMain.handle(IPC_CHANNELS.MAILBOX_SEND_DRAFT, async (event, data?: Any) => {
    assertTrustedMailboxSender(event);
    const draftId = typeof data?.draftId === "string" ? data.draftId : "";
    if (!draftId) throw new Error("Missing mailbox draft id");
    return mailboxService.sendMailboxDraft(draftId);
  });

  ipcMain.handle(IPC_CHANNELS.MAILBOX_SCHEDULE_SEND, async (event, data?: Any) => {
    assertTrustedMailboxSender(event);
    const draftId = typeof data?.draftId === "string" ? data.draftId : "";
    const scheduledAt = typeof data?.scheduledAt === "number" ? data.scheduledAt : 0;
    if (!draftId) throw new Error("Missing mailbox draft id");
    return mailboxService.scheduleMailboxSend(draftId, scheduledAt);
  });

  ipcMain.handle(IPC_CHANNELS.MAILBOX_DISCARD_COMPOSE_DRAFT, async (event, data?: Any) => {
    assertTrustedMailboxSender(event);
    const draftId = typeof data?.draftId === "string" ? data.draftId : "";
    if (!draftId) throw new Error("Missing mailbox draft id");
    return mailboxService.discardMailboxDraft(draftId);
  });

  ipcMain.handle(IPC_CHANNELS.MAILBOX_UNDO_ACTION, async (event, data?: Any) => {
    assertTrustedMailboxSender(event);
    const actionId = typeof data?.actionId === "string" ? data.actionId : "";
    if (!actionId) throw new Error("Missing mailbox action id");
    return mailboxService.undoMailboxAction(actionId);
  });

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_SUMMARIZE_THREAD,
    async (event, data?: { threadId?: string }) => {
      assertTrustedMailboxSender(event);
      if (!data?.threadId)
        throw new Error("Missing threadId for mailbox summarize");
      return mailboxService.summarizeThread(data.threadId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_GENERATE_DRAFT,
    async (
      event,
      data?: {
        threadId?: string;
        tone?: Any;
        includeAvailability?: boolean;
        allowNoreplySender?: boolean;
      },
    ) => {
      assertTrustedMailboxSender(event);
      if (!data?.threadId)
        throw new Error("Missing threadId for mailbox draft generation");
      return mailboxService.generateDraft(data.threadId, {
        tone: data.tone,
        includeAvailability: data.includeAvailability,
        allowNoreplySender: data.allowNoreplySender,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_EXTRACT_COMMITMENTS,
    async (event, data?: { threadId?: string }) => {
      assertTrustedMailboxSender(event);
      if (!data?.threadId)
        throw new Error("Missing threadId for mailbox commitment extraction");
      return mailboxService.extractCommitments(data.threadId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_REVIEW_BULK_ACTION,
    async (
      event,
      data?: { type?: "cleanup" | "follow_up"; limit?: number },
    ) => {
      assertTrustedMailboxSender(event);
      if (data?.type !== "cleanup" && data?.type !== "follow_up") {
        throw new Error(
          'Mailbox bulk review requires type "cleanup" or "follow_up"',
        );
      }
      return mailboxService.reviewBulkAction({
        type: data.type,
        limit: data.limit,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_SCHEDULE_REPLY,
    async (event, data?: { threadId?: string }) => {
      assertTrustedMailboxSender(event);
      if (!data?.threadId)
        throw new Error("Missing threadId for mailbox schedule reply");
      return mailboxService.scheduleReply(data.threadId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_RESEARCH_CONTACT,
    async (event, data?: { threadId?: string }) => {
      assertTrustedMailboxSender(event);
      if (!data?.threadId)
        throw new Error("Missing threadId for mailbox research");
      return mailboxService.researchContact(data.threadId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_IDENTITY_RESOLVE,
    async (event, data?: { threadId?: string }) => {
      assertTrustedMailboxSender(event);
      if (!data?.threadId)
        throw new Error("Missing threadId for mailbox identity resolution");
      return mailboxService.resolveContactIdentity(data.threadId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_IDENTITY_GET,
    async (event, data?: { contactIdentityId?: string }) => {
      assertTrustedMailboxSender(event);
      if (!data?.contactIdentityId)
        throw new Error("Missing contactIdentityId");
      return mailboxService.getContactIdentity(data.contactIdentityId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_IDENTITY_LIST,
    async (event, data?: { workspaceId?: string }) => {
      assertTrustedMailboxSender(event);
      return mailboxService.listContactIdentities(data?.workspaceId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_IDENTITY_SEARCH,
    async (
      event,
      data?: { workspaceId?: string; query?: string; limit?: number },
    ) => {
      assertTrustedMailboxSender(event);
      if (!data?.workspaceId) throw new Error("Missing workspaceId");
      if (!data?.query?.trim()) return [];
      return mailboxService.searchIdentityLinkTargets(
        data.workspaceId,
        data.query,
        data.limit,
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_IDENTITY_LINK,
    async (
      event,
      data?: {
        workspaceId?: string;
        contactIdentityId?: string;
        handleType?: string;
        normalizedValue?: string;
        displayValue?: string;
        source?: string;
        channelId?: string;
        channelType?: string;
        channelUserId?: string;
      },
    ) => {
      assertTrustedMailboxSender(event);
      if (!data?.workspaceId) throw new Error("Missing workspaceId");
      if (!data?.contactIdentityId)
        throw new Error("Missing contactIdentityId");
      if (!data?.handleType) throw new Error("Missing handleType");
      if (!data?.normalizedValue && !data?.displayValue)
        throw new Error("Missing handle value");
      return mailboxService.linkIdentityHandle({
        workspaceId: data.workspaceId,
        contactIdentityId: data.contactIdentityId,
        handleType: data.handleType as Any,
        normalizedValue: data.normalizedValue || data.displayValue || "",
        displayValue: data.displayValue || data.normalizedValue || "",
        source: (data.source as Any) || "manual",
        channelId: data.channelId,
        channelType: data.channelType,
        channelUserId: data.channelUserId,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_IDENTITY_TIMELINE,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      return mailboxService.getRelationshipTimeline({
        threadId:
          typeof data?.threadId === "string" ? data.threadId : undefined,
        contactIdentityId:
          typeof data?.contactIdentityId === "string"
            ? data.contactIdentityId
            : undefined,
        companyHint:
          typeof data?.companyHint === "string" ? data.companyHint : undefined,
        limit: typeof data?.limit === "number" ? data.limit : undefined,
        startAt: typeof data?.startAt === "number" ? data.startAt : undefined,
        endAt: typeof data?.endAt === "number" ? data.endAt : undefined,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_IDENTITY_CANDIDATES,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      return mailboxService.listIdentityCandidates(
        typeof data?.workspaceId === "string" ? data.workspaceId : undefined,
        typeof data?.status === "string" ? data.status : undefined,
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_IDENTITY_CONFIRM,
    async (event, data?: { candidateId?: string }) => {
      assertTrustedMailboxSender(event);
      if (!data?.candidateId) throw new Error("Missing candidateId");
      return mailboxService.confirmIdentityLink(data.candidateId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_IDENTITY_REJECT,
    async (event, data?: { candidateId?: string }) => {
      assertTrustedMailboxSender(event);
      if (!data?.candidateId) throw new Error("Missing candidateId");
      return mailboxService.rejectIdentityLink(data.candidateId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_IDENTITY_UNLINK,
    async (event, data?: { handleId?: string }) => {
      assertTrustedMailboxSender(event);
      if (!data?.handleId) throw new Error("Missing handleId");
      return mailboxService.unlinkIdentityHandle(data.handleId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_IDENTITY_PREFERENCE,
    async (event, data?: { contactIdentityId?: string }) => {
      assertTrustedMailboxSender(event);
      if (!data?.contactIdentityId)
        throw new Error("Missing contactIdentityId");
      return mailboxService.getChannelPreferenceSummary(data.contactIdentityId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_IDENTITY_COVERAGE,
    async (event, data?: { workspaceId?: string }) => {
      assertTrustedMailboxSender(event);
      return mailboxService.getIdentityCoverageStats(data?.workspaceId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_REPLY_VIA_CHANNEL,
    async (
      event,
      data?: {
        threadId?: string;
        handleId?: string;
        channelType?: string;
        message?: string;
        parseMode?: "text" | "markdown";
      },
    ) => {
      assertTrustedMailboxSender(event);
      if (!data?.threadId) throw new Error("Missing threadId");
      if (!data?.handleId) throw new Error("Missing handleId");
      if (!data?.channelType) throw new Error("Missing channelType");
      if (!data?.message?.trim()) throw new Error("Missing message");
      if (!gateway) throw new Error("Gateway not initialized");

      const targets = await mailboxService.getReplyTargets(data.threadId);
      const target = targets.find((entry) => entry.handleId === data.handleId);
      if (!target) {
        throw new Error("The selected reply target is no longer available");
      }
      if (target.channelType !== data.channelType) {
        throw new Error(`Reply target mismatch for ${data.channelType}`);
      }

      await gateway.sendMessage(
        target.channelType as Any,
        target.chatId,
        data.message,
        {
          channelDbId: target.channelId,
          parseMode: data.parseMode || "text",
        },
      );
      return { ok: true, target };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_MC_HANDOFF_PREVIEW,
    async (event, data?: { threadId?: string }) => {
      assertTrustedMailboxSender(event);
      if (!data?.threadId)
        throw new Error("Missing threadId for mailbox handoff preview");
      return mailboxService.previewMissionControlHandoff(data.threadId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_MC_HANDOFF_CREATE,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      if (!data?.threadId)
        throw new Error("Missing threadId for mailbox handoff");
      if (!data?.companyId)
        throw new Error("Missing companyId for mailbox handoff");
      if (!data?.operatorRoleId)
        throw new Error("Missing operatorRoleId for mailbox handoff");
      if (!data?.issueTitle)
        throw new Error("Missing issueTitle for mailbox handoff");
      return mailboxService.createMissionControlHandoff(data);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_MC_HANDOFF_LIST,
    async (event, data?: { threadId?: string }) => {
      assertTrustedMailboxSender(event);
      if (!data?.threadId)
        throw new Error("Missing threadId for mailbox handoff list");
      return mailboxService.listMissionControlHandoffs(data.threadId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.MAILBOX_SNIPPETS_LIST, async (event) => {
    assertTrustedMailboxSender(event);
    return mailboxService.listMailboxSnippets();
  });

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_SNIPPET_UPSERT,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      return mailboxService.upsertMailboxSnippet({
        id: typeof data?.id === "string" ? data.id : undefined,
        shortcut: typeof data?.shortcut === "string" ? data.shortcut : "",
        body: typeof data?.body === "string" ? data.body : "",
        subjectHint:
          typeof data?.subjectHint === "string" ? data.subjectHint : undefined,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_SNIPPET_DELETE,
    async (event, data?: { id?: string }) => {
      assertTrustedMailboxSender(event);
      if (!data?.id) throw new Error("Missing snippet id");
      return mailboxService.deleteMailboxSnippet(data.id);
    },
  );

  ipcMain.handle(IPC_CHANNELS.MAILBOX_SAVED_VIEWS_LIST, async (event) => {
    assertTrustedMailboxSender(event);
    return mailboxService.listMailboxSavedViews();
  });

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_SAVED_VIEW_CREATE,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      if (
        typeof data?.name !== "string" ||
        typeof data?.instructions !== "string"
      ) {
        throw new Error("Missing name or instructions for saved view");
      }
      const threadIds = Array.isArray(data?.threadIds)
        ? data.threadIds.filter(
            (id: unknown): id is string => typeof id === "string",
          )
        : [];
      return mailboxService.createMailboxSavedView({
        name: data.name,
        instructions: data.instructions,
        seedThreadId:
          typeof data?.seedThreadId === "string"
            ? data.seedThreadId
            : undefined,
        threadIds,
        showInInbox: data?.showInInbox !== false,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_SAVED_VIEW_DELETE,
    async (event, data?: { id?: string }) => {
      assertTrustedMailboxSender(event);
      if (!data?.id) throw new Error("Missing saved view id");
      return mailboxService.deleteMailboxSavedView(data.id);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_SAVED_VIEW_PREVIEW_SIMILAR,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      if (typeof data?.seedThreadId !== "string")
        throw new Error("Missing seedThreadId");
      return mailboxService.previewMailboxLabelSimilar({
        seedThreadId: data.seedThreadId,
        name: typeof data?.name === "string" ? data.name : "",
        instructions:
          typeof data?.instructions === "string" ? data.instructions : "",
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_QUICK_REPLY_SUGGESTIONS,
    async (event, data?: { threadId?: string }) => {
      assertTrustedMailboxSender(event);
      if (!data?.threadId)
        throw new Error("Missing threadId for quick reply suggestions");
      return mailboxService.getMailboxQuickReplySuggestions(data.threadId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_SAVED_VIEW_REVIEW_SCHEDULE,
    async (event, data?: { viewId?: string }) => {
      assertTrustedMailboxSender(event);
      if (!data?.viewId) throw new Error("Missing viewId for review schedule");
      return mailboxService.createReviewScheduleForSavedView(data.viewId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_APPLY_ACTION,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      return mailboxService.applyAction({
        proposalId:
          typeof data?.proposalId === "string" ? data.proposalId : undefined,
        threadId:
          typeof data?.threadId === "string" ? data.threadId : undefined,
        type: data?.type,
        label: typeof data?.label === "string" ? data.label : undefined,
        folderId:
          typeof data?.folderId === "string" ? data.folderId : undefined,
        labelId:
          typeof data?.labelId === "string" ? data.labelId : undefined,
        snoozeUntil:
          typeof data?.snoozeUntil === "number" ? data.snoozeUntil : undefined,
        draftId: typeof data?.draftId === "string" ? data.draftId : undefined,
        draftSubject:
          typeof data?.draftSubject === "string"
            ? data.draftSubject
            : undefined,
        draftBody:
          typeof data?.draftBody === "string" ? data.draftBody : undefined,
        messageMode:
          data?.messageMode === "reply" ||
          data?.messageMode === "reply_all" ||
          data?.messageMode === "forward"
            ? data.messageMode
            : undefined,
        messageTo:
          Array.isArray(data?.messageTo) ? data.messageTo : undefined,
        messageCc:
          Array.isArray(data?.messageCc) ? data.messageCc : undefined,
        messageBcc:
          Array.isArray(data?.messageBcc) ? data.messageBcc : undefined,
        messageSubject:
          typeof data?.messageSubject === "string"
            ? data.messageSubject
            : undefined,
        messageBody:
          typeof data?.messageBody === "string" ? data.messageBody : undefined,
        commitmentId:
          typeof data?.commitmentId === "string"
            ? data.commitmentId
            : undefined,
        actionId:
          typeof data?.actionId === "string" ? data.actionId : undefined,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_UPDATE_COMMITMENT_STATE,
    async (event, data?: { commitmentId?: string; state?: Any }) => {
      assertTrustedMailboxSender(event);
      if (!data?.commitmentId || typeof data?.state !== "string") {
        throw new Error(
          "Missing commitmentId/state for mailbox commitment update",
        );
      }
      return mailboxService.updateCommitmentState(
        data.commitmentId,
        data.state as MailboxCommitmentState,
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_UPDATE_COMMITMENT_DETAILS,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      if (typeof data?.commitmentId !== "string") {
        throw new Error(
          "Missing commitmentId for mailbox commitment details update",
        );
      }
      return mailboxService.updateCommitmentDetails(data.commitmentId, {
        title:
          typeof data?.patch?.title === "string" ? data.patch.title : undefined,
        dueAt:
          typeof data?.patch?.dueAt === "number" ? data.patch.dueAt : undefined,
        ownerEmail:
          typeof data?.patch?.ownerEmail === "string"
            ? data.patch.ownerEmail
            : undefined,
        state:
          data?.patch?.state === "suggested" ||
          data?.patch?.state === "accepted" ||
          data?.patch?.state === "done" ||
          data?.patch?.state === "dismissed"
            ? data.patch.state
            : undefined,
        sourceExcerpt:
          typeof data?.patch?.sourceExcerpt === "string"
            ? data.patch.sourceExcerpt
            : undefined,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_RECLASSIFY_THREAD,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      const threadId =
        typeof data?.threadId === "string" ? data.threadId : undefined;
      if (!threadId) {
        throw new Error("Missing threadId for mailbox thread reclassification");
      }
      return mailboxService.reclassifyThread(threadId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MAILBOX_RECLASSIFY_ACCOUNT,
    async (event, data?: Any) => {
      assertTrustedMailboxSender(event);
      const accountId =
        typeof data?.accountId === "string" ? data.accountId : undefined;
      const threadId =
        typeof data?.threadId === "string" ? data.threadId : undefined;
      const scope =
        data?.scope === "thread" ||
        data?.scope === "account" ||
        data?.scope === "backfill"
          ? data.scope
          : undefined;
      const limit = typeof data?.limit === "number" ? data.limit : undefined;
      return mailboxService.reclassifyAccount({
        accountId,
        threadId,
        scope,
        limit,
      });
    },
  );

  // Workspace handlers
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CREATE, async (_, data) => {
    const validated = validateInput(WorkspaceCreateSchema, data, "workspace");
    const { name, path, permissions } = validated;

    // Check if workspace with this path already exists
    if (workspaceRepo.existsByPath(path)) {
      throw new Error(
        `A workspace with path "${path}" already exists. Please choose a different folder.`,
      );
    }

    // Provide default permissions if not specified
    // Note: network is enabled by default for browser tools (web access)
    const permissionSettings = PermissionSettingsManager.loadSettings();
    const defaultPermissions = {
      read: true,
      write: true,
      delete: false,
      network: true,
      shell: permissionSettings.defaultShellEnabled,
    };

    return workspaceRepo.create(name, path, permissions ?? defaultPermissions);
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST, async () => {
    // Filter out temp workspaces from user workspace lists.
    const allWorkspaces = workspaceRepo.findAll();
    return allWorkspaces.filter(
      (workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id),
    );
  });

  // Get or create the temp workspace (used when no workspace is selected)
  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_GET_TEMP,
    async (_, options?: { createNew?: boolean }) => {
      return getOrCreateTempWorkspace(options);
    },
  );

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SELECT, async (_, id: string) => {
    const workspace = workspaceRepo.findById(id);
    if (workspace) {
      try {
        workspaceRepo.updateLastUsedAt(workspace.id);
        if (isTempWorkspaceId(workspace.id)) {
          touchTempWorkspaceLease(workspace.id);
        }
      } catch (error) {
        logger.warn("Failed to update workspace last used time:", error);
      }
    }
    return workspace;
  });

  ipcMain.handle(
    IPC_CHANNELS.WORKSPACE_UPDATE_PERMISSIONS,
    async (
      _,
      id: string,
      permissions: {
        shell?: boolean;
        network?: boolean;
        read?: boolean;
        write?: boolean;
        delete?: boolean;
      },
    ) => {
      const workspace = workspaceRepo.findById(id);
      if (!workspace) {
        throw new Error(`Workspace not found: ${id}`);
      }
      const updatedPermissions = { ...workspace.permissions, ...permissions };
      workspaceRepo.updatePermissions(id, updatedPermissions);
      // Notify active task executors so they pick up new tool availability (e.g. run_command when shell enabled)
      agentDaemon.refreshActiveExecutorsForWorkspace(id);
      return workspaceRepo.findById(id);
    },
  );

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_TOUCH, async (_, id: string) => {
    const workspace = workspaceRepo.findById(id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${id}`);
    }
    workspaceRepo.updateLastUsedAt(id);
    if (isTempWorkspaceId(id)) {
      touchTempWorkspaceLease(id);
    }
    return workspaceRepo.findById(id);
  });

  // Task handlers
  ipcMain.handle(IPC_CHANNELS.TASK_CREATE, async (_, data) => {
    checkRateLimit(IPC_CHANNELS.TASK_CREATE);
    const validated = validateInput(TaskCreateSchema, data, "task");
    const {
      title,
      prompt,
      workspaceId,
      budgetTokens,
      budgetCost,
      agentConfig,
      images: validatedImages,
    } = validated;
    let normalizedAgentConfig: AgentConfig | undefined = agentConfig
      ? {
          ...agentConfig,
          ...(agentConfig.autonomousMode ? { allowUserInput: false } : {}),
        }
      : undefined;

    const task = taskRepo.create({
      title,
      prompt,
      status: "pending",
      workspaceId,
      budgetTokens,
      budgetCost,
      agentConfig: normalizedAgentConfig,
    });

    if (!isTempWorkspaceId(workspaceId)) {
      try {
        workspaceRepo.updateLastUsedAt(workspaceId);
      } catch (error) {
        logger.warn("Failed to update workspace last used time:", error);
      }
    }

    // Capture mentioned agent roles for deferred dispatch (after main plan is created)
    try {
      const activeRoles = agentRoleRepo
        .findAll(false)
        .filter((role) => role.isActive);
      const mentionedRoles = extractMentionedRoles(
        `${title}\n${prompt}`,
        activeRoles,
      );
      const mentionedAgentRoleIds = mentionedRoles.map((role) => role.id);
      if (mentionedAgentRoleIds.length > 0) {
        taskRepo.update(task.id, { mentionedAgentRoleIds });
      }
    } catch (error: unknown) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error("Failed to record mentioned agents:", error);
      // Notify user of dispatch failure via activity feed
      const errorActivity = activityRepo.create({
        workspaceId: task.workspaceId,
        taskId: task.id,
        actorType: "system",
        activityType: "error",
        title: "Agent mention capture failed",
        description: `Failed to record mentioned agents for deferred dispatch: ${errorMessage}`,
      });
      getMainWindow()?.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, {
        type: "created",
        activity: errorActivity,
      });
    }

    // Auto-collaborative mode: return task immediately, set up team in background
    if (normalizedAgentConfig?.collaborativeMode) {
      taskRepo.update(task.id, { status: "executing" });
      task.status = "executing";
      task.updatedAt = Date.now();
      emitTaskStatusEvent(task.id, "executing");

      // Run the collaborative setup asynchronously so the UI gets the task instantly
      void (async () => {
        try {
          const activeRoles = agentRoleRepo.findAll(false);
          const fullText = `${title}\n${prompt}`;
          const requestedCount = parseSpawnAgentCount(fullText);
          const { members, leader } = await selectAgentsForTask(
            fullText,
            activeRoles,
            requestedCount ?? undefined,
          );

          // Create ephemeral team
          const team = teamRepo.create({
            workspaceId,
            name: `Collab-${Date.now()}`,
            description: `Auto-collaborative team for: ${title}`,
            leadAgentRoleId: leader.id,
            maxParallelAgents: members.length,
          });

          // Add members
          for (let i = 0; i < members.length; i++) {
            teamMemberRepo.add({
              teamId: team.id,
              agentRoleId: members[i].id,
              memberOrder: (i + 1) * 10,
              isRequired: true,
            });
          }

          // Create collaborative run
          const run = teamRunRepo.create({
            teamId: team.id,
            rootTaskId: task.id,
            status: "running",
            collaborativeMode: true,
          });

          // One item per agent — each gets the full prompt (Grok model).
          // Exclude "Synthesis" role from initial items — it is created only after all
          // sub-agents complete, in the synthesis phase.
          for (let i = 0; i < members.length; i++) {
            const m = members[i];
            if (m.displayName === "Synthesis") continue;
            teamItemRepo.create({
              teamRunId: run.id,
              title: formatAgentRoleDisplay(m.displayName, m.icon),
              description: prompt,
              ownerAgentRoleId: m.id,
              status: "todo",
              sortOrder: (i + 1) * 10,
            });
          }

          // Emit for UI — this triggers the collaborative thoughts panel to appear
          emitTeamEvent({
            type: "team_run_created",
            timestamp: Date.now(),
            run,
          });

          // Kick off the orchestrator (spawns child tasks for each item)
          void teamOrchestrator.tickRun(run.id, "auto_collaborative");
        } catch (error: Any) {
          logger.error(
            "[TASK_CREATE] Auto-collaborative setup failed:",
            error,
          );
          // Fall back to normal execution
          try {
            await agentDaemon.startTask(task, validatedImages);
          } catch (startError: Any) {
            agentDaemon.failTask(
              task.id,
              startError.message || "Failed to start task",
            );
          }
        }
      })();

      return task;
    }

    // Multi-LLM mode: send same task to multiple LLM providers in parallel
    if (
      normalizedAgentConfig?.multiLlmMode &&
      normalizedAgentConfig?.multiLlmConfig
    ) {
      taskRepo.update(task.id, { status: "executing" });
      task.status = "executing";
      task.updatedAt = Date.now();
      emitTaskStatusEvent(task.id, "executing");

      void (async () => {
        try {
          const config = normalizedAgentConfig.multiLlmConfig!;
          const participants = config.participants;

          // Use the first default agent role as sentinel for FK references
          const allRoles = agentRoleRepo.findAll(false);
          const sentinelRoleId =
            allRoles.length > 0 ? allRoles[0].id : "multi-llm-system";

          // Create ephemeral team
          const team = teamRepo.create({
            workspaceId,
            name: `MultiLLM-${Date.now()}`,
            description: `Multi-LLM comparison for: ${title}`,
            leadAgentRoleId: sentinelRoleId,
            maxParallelAgents: participants.length,
          });

          // Create multi-LLM run
          const run = teamRunRepo.create({
            teamId: team.id,
            rootTaskId: task.id,
            status: "running",
            collaborativeMode: true,
            multiLlmMode: true,
          });

          // One item per LLM participant
          for (let i = 0; i < participants.length; i++) {
            const p = participants[i];
            teamItemRepo.create({
              teamRunId: run.id,
              title: `${p.displayName}`,
              description: prompt,
              ownerAgentRoleId: sentinelRoleId,
              status: "todo",
              sortOrder: (i + 1) * 10,
            });
          }

          // Emit for UI — triggers the thoughts panel
          emitTeamEvent({
            type: "team_run_created",
            timestamp: Date.now(),
            run,
          });

          // Kick off orchestrator
          void teamOrchestrator.tickRun(run.id, "multi_llm_start");
        } catch (error: Any) {
          logger.error("[TASK_CREATE] Multi-LLM setup failed:", error);
          try {
            await agentDaemon.startTask(task, validatedImages);
          } catch (startError: Any) {
            agentDaemon.failTask(
              task.id,
              startError.message || "Failed to start task",
            );
          }
        }
      })();

      return task;
    }

    // Start task execution in agent daemon
    try {
      await agentDaemon.startTask(task, validatedImages);
    } catch (error: Any) {
      agentDaemon.failTask(task.id, error.message || "Failed to start task");
      throw new Error(
        error.message ||
          "Failed to start task. Please check your LLM provider settings.",
      );
    }

    return task;
  });

  ipcMain.handle(IPC_CHANNELS.TASK_GET, async (_, id: string) => {
    return taskRepo.findById(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.TASK_LIST,
    async (_, opts?: { limit?: number; offset?: number; prioritizeSidebar?: boolean }) => {
      const limit =
        typeof opts?.limit === "number" && opts.limit > 0 ? opts.limit : 100;
      const offset =
        typeof opts?.offset === "number" && opts.offset >= 0 ? opts.offset : 0;
      return taskRepo.findAll(limit, offset, {
        prioritizeSidebar: opts?.prioritizeSidebar === true,
      });
    },
  );

  // Export task summaries as a structured JSON blob (prompt-free by design)
  ipcMain.handle(
    IPC_CHANNELS.TASK_EXPORT_JSON,
    async (_, rawQuery?: TaskExportQuery) => {
      checkRateLimit(IPC_CHANNELS.TASK_EXPORT_JSON);

      const query: TaskExportQuery = {
        workspaceId:
          typeof rawQuery?.workspaceId === "string"
            ? rawQuery.workspaceId
            : undefined,
        taskIds: Array.isArray(rawQuery?.taskIds)
          ? rawQuery.taskIds
              .filter((id): id is string => typeof id === "string")
              .map((id) => id.trim())
              .filter(Boolean)
          : undefined,
        limit:
          typeof rawQuery?.limit === "number" && Number.isFinite(rawQuery.limit)
            ? rawQuery.limit
            : undefined,
        offset:
          typeof rawQuery?.offset === "number" &&
          Number.isFinite(rawQuery.offset)
            ? rawQuery.offset
            : undefined,
      };

      const maxLimit = 2000;
      const limit = Math.min(Math.max(query.limit ?? 500, 1), maxLimit);
      const offset = Math.max(query.offset ?? 0, 0);

      let tasks: Task[] = [];

      if (query.taskIds && query.taskIds.length > 0) {
        tasks = query.taskIds
          .map((id) => taskRepo.findById(id))
          .filter((t): t is Task => !!t);
      } else if (query.workspaceId) {
        const all = taskRepo.findByWorkspace(query.workspaceId);
        tasks = all.slice(offset, offset + limit);
      } else {
        tasks = taskRepo.findAll(limit, offset);
      }

      const taskIds = tasks.map((task) => task.id);
      const events =
        taskIds.length > 0
          ? taskEventRepo.findByTaskIds(taskIds, [
              "file_created",
              "file_modified",
              "file_deleted",
              "llm_usage",
            ])
          : [];

      const workspaceIds = Array.from(
        new Set(tasks.map((task) => task.workspaceId)),
      );
      const workspaces = workspaceIds
        .map((id) => workspaceRepo.findById(id))
        .filter((ws): ws is Workspace => !!ws);

      return buildTaskExportJson({
        query: {
          ...query,
          // Materialize defaults/caps so callers see what was actually applied.
          ...(query.taskIds && query.taskIds.length > 0
            ? {}
            : { limit, offset }),
        },
        tasks,
        workspaces,
        events,
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.TASK_CANCEL, async (_, id: string) => {
    try {
      await agentDaemon.cancelTask(id);
    } finally {
      const current = taskRepo.findById(id);
      if (current && !isTerminalTaskStatus(current.status)) {
        // Fallback if daemon-side cancellation failed before persisting terminal state.
        agentDaemon.cancelTaskRecord(id, "Task was stopped by user");
      }
    }
  });

  ipcMain.handle(IPC_CHANNELS.TASK_WRAP_UP, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.TASK_WRAP_UP);
    const validated = validateInput(UUIDSchema, id, "task ID");
    await agentDaemon.wrapUpTask(validated);
  });

  ipcMain.handle(IPC_CHANNELS.TASK_PAUSE, async (_, id: string) => {
    const validated = validateInput(UUIDSchema, id, "task ID");
    // Pause daemon first - if it fails, exception propagates and status won't be updated
    await agentDaemon.pauseTask(validated);
    taskRepo.update(validated, { status: "paused" });
  });

  ipcMain.handle(IPC_CHANNELS.TASK_RESUME, async (_, id: string) => {
    const validated = validateInput(UUIDSchema, id, "task ID");
    // Resume daemon first. The daemon owns lifecycle transitions and may finish the
    // task before this call returns, so do not force a stale "executing" write here.
    const resumed = await agentDaemon.resumeTask(validated);
    if (resumed) return;
    logger.warn(
      `[IPC] TASK_RESUME ignored for task ${validated}: no active executor available to resume`,
    );
  });

  ipcMain.handle(IPC_CHANNELS.TASK_CONTINUE, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.TASK_CONTINUE);
    const validated = validateInput(UUIDSchema, id, "task ID");
    await agentDaemon.continueTask(validated);
  });

  ipcMain.handle(
    IPC_CHANNELS.TASK_FORK_SESSION,
    async (
      _,
      data: {
        taskId: string;
        prompt?: string;
        branchLabel?: string;
        fromEventId?: string;
      },
    ) => {
      checkRateLimit(IPC_CHANNELS.TASK_FORK_SESSION);
      const taskId = validateInput(UUIDSchema, data.taskId, "task ID");
      const fromEventId =
        typeof data.fromEventId === "string" &&
        data.fromEventId.trim().length > 0
          ? data.fromEventId.trim()
          : undefined;
      return agentDaemon.forkTaskSession({
        taskId,
        ...(typeof data.prompt === "string" ? { prompt: data.prompt } : {}),
        ...(typeof data.branchLabel === "string"
          ? { branchLabel: data.branchLabel }
          : {}),
        ...(fromEventId ? { fromEventId } : {}),
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.TASK_STEP_FEEDBACK, async (_, data) => {
    checkRateLimit(IPC_CHANNELS.TASK_STEP_FEEDBACK);
    const validated = validateInput(StepFeedbackSchema, data, "step feedback");
    await agentDaemon.handleStepFeedback(
      validated.taskId,
      validated.stepId,
      validated.action,
      validated.message,
    );
  });

  ipcMain.handle(
    IPC_CHANNELS.TASK_SEND_STDIN,
    async (_, data: { taskId: string; input: string }) => {
      return agentDaemon.sendStdinToTask(data.taskId, data.input);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_KILL_COMMAND,
    async (_, data: { taskId: string; force?: boolean }) => {
      return agentDaemon.killCommandInTask(data.taskId, data.force);
    },
  );

  ipcMain.handle(IPC_CHANNELS.TASK_RENAME, async (_, data) => {
    const validated = validateInput(TaskRenameSchema, data, "task rename");
    taskRepo.update(validated.id, { title: validated.title });
  });

  ipcMain.handle(IPC_CHANNELS.TASK_PIN, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.TASK_PIN);
    const validated = validateInput(UUIDSchema, id, "task ID");
    const task = taskRepo.togglePin(validated);
    if (!task) {
      throw new Error(`Task not found: ${validated}`);
    }
    return task;
  });

  ipcMain.handle(IPC_CHANNELS.TASK_DELETE, async (_, id: string) => {
    const existingTask = taskRepo.findById(id);

    // Cancel the task if it's running
    await agentDaemon.cancelTask(id);

    // Best-effort cleanup of on-disk worktree resources before metadata deletion.
    if (existingTask?.worktreePath || existingTask?.worktreeBranch) {
      try {
        await agentDaemon.getWorktreeManager().cleanup(id, true);
      } catch (error) {
        logger.warn(`[TASK_DELETE] Worktree cleanup failed for ${id}:`, error);
      }
    }

    // Delete from database
    taskRepo.delete(id);
  });

  // ============ Sub-Agent / Parallel Agent Handlers ============

  // Get child tasks for a parent task
  ipcMain.handle(
    IPC_CHANNELS.AGENT_GET_CHILDREN,
    async (_, parentTaskId: string) => {
      return agentDaemon.getChildTasks(parentTaskId);
    },
  );

  // Get status of specific agents
  ipcMain.handle(
    IPC_CHANNELS.AGENT_GET_STATUS,
    async (_, taskIds: string[]) => {
      const tasks = [];
      for (const id of taskIds) {
        const task = await agentDaemon.getTaskById(id);
        if (task) {
          tasks.push({
            taskId: id,
            status: task.status,
            title: task.title,
            agentType: task.agentType,
            resultSummary: task.resultSummary,
            error: task.error,
          });
        }
      }
      return tasks;
    },
  );

  // Task events handler - get historical events from database
  // For collaborative root tasks, also include file events from child tasks.
  ipcMain.handle(IPC_CHANNELS.TASK_EVENTS, async (_, taskId: string) => {
    const maxEvents = 600;
    const events = taskEventRepo.findRecentByTaskId(taskId, maxEvents);

    // Include child task file events for collaborative/multi-LLM roots
    const task = taskRepo.findById(taskId);
    if (
      task?.agentConfig?.collaborativeMode ||
      task?.agentConfig?.multiLlmMode
    ) {
      const childTasks = taskRepo.findByParent(taskId);
      if (childTasks.length > 0) {
        const childIds = childTasks.map((c) => c.id);
        const fileTypes = [
          "file_created",
          "file_modified",
          "file_deleted",
          "artifact_created",
        ];
        const childFileEvents = taskEventRepo.findByTaskIds(
          childIds,
          fileTypes,
        );
        // Merge and sort by timestamp
        events.push(...childFileEvents);
        events.sort((a, b) => a.timestamp - b.timestamp);
      }
    }
    return events.length > maxEvents ? events.slice(-maxEvents) : events;
  });

  // Semantic timeline projection — normalizer runs on the read path, no DB changes needed
  ipcMain.handle(
    IPC_CHANNELS.TASK_SEMANTIC_TIMELINE,
    async (_, taskId: string) => {
      const maxEvents = 1200;
      const events = taskEventRepo.findRecentByTaskId(taskId, maxEvents);
      const sorted = [...events].sort((a, b) => a.timestamp - b.timestamp);
      return normalizeTaskEvents(sorted);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_LEARNING_PROGRESS,
    async (_, taskId: string) => {
      const events = taskEventRepo.findByTaskId(taskId);
      const learningEvents = events
        .filter(
          (event) =>
            event.type === "learning_progress" ||
            event.legacyType === "learning_progress",
        )
        .map((event) => event.payload)
        .filter((payload): payload is TaskLearningProgress => {
          return !!payload && typeof payload === "object";
        });
      learningEvents.sort((a, b) => a.completedAt - b.completedAt);
      return learningEvents;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.UNIFIED_RECALL_QUERY,
    async (_, query: UnifiedRecallQuery): Promise<UnifiedRecallResponse> => {
      const workspaceId =
        typeof query?.workspaceId === "string" &&
        query.workspaceId.trim().length > 0
          ? query.workspaceId.trim()
          : undefined;
      const workspacePath = workspaceId
        ? workspaceRepo.findById(workspaceId)?.path
        : undefined;
      return RuntimeVisibilityService.collectUnifiedRecall(
        {
          taskRepo,
          eventRepo: taskEventRepo,
          activityRepo,
          workspaceRepo,
        },
        {
          ...query,
          workspaceId,
          workspacePath,
        },
      );
    },
  );

  const shellSessionManager = ShellSessionManager.getInstance();
  const emitShellSessionLifecycle = (
    taskId: string,
    action: "reset" | "closed",
    session: ShellSessionInfo | null,
  ): void => {
    if (!session) return;
    agentDaemon.logEvent(taskId, `shell_session_${action}`, {
      message:
        action === "reset" ? "Shell session reset" : "Shell session closed",
      reason: action === "reset" ? "manual_reset" : "manual_close",
      session,
    });
  };

  ipcMain.handle(
    IPC_CHANNELS.SHELL_SESSION_GET,
    async (
      _,
      data: {
        taskId?: string;
        workspaceId?: string;
        scope?: ShellSessionScope;
      },
    ) => {
      const taskId = typeof data?.taskId === "string" ? data.taskId.trim() : "";
      const workspaceId =
        typeof data?.workspaceId === "string" ? data.workspaceId.trim() : "";
      if (!taskId || !workspaceId) return null;
      return shellSessionManager.getSessionInfo(
        taskId,
        workspaceId,
        data.scope || "task",
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SHELL_SESSION_LIST,
    async (
      _,
      data?: {
        taskId?: string;
        workspaceId?: string;
      },
    ) => {
      const taskId =
        typeof data?.taskId === "string" ? data.taskId.trim() : undefined;
      const workspaceId =
        typeof data?.workspaceId === "string"
          ? data.workspaceId.trim()
          : undefined;
      return shellSessionManager.listSessions(taskId, workspaceId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SHELL_SESSION_RESET,
    async (
      _,
      data: {
        taskId?: string;
        workspaceId?: string;
        scope?: ShellSessionScope;
      },
    ) => {
      const taskId = typeof data?.taskId === "string" ? data.taskId.trim() : "";
      const workspaceId =
        typeof data?.workspaceId === "string" ? data.workspaceId.trim() : "";
      if (!taskId || !workspaceId) return null;
      const session = await shellSessionManager.resetSession(
        taskId,
        workspaceId,
        data.scope || "task",
      );
      emitShellSessionLifecycle(taskId, "reset", session);
      return session;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SHELL_SESSION_CLOSE,
    async (
      _,
      data: {
        taskId?: string;
        workspaceId?: string;
        scope?: ShellSessionScope;
      },
    ) => {
      const taskId = typeof data?.taskId === "string" ? data.taskId.trim() : "";
      const workspaceId =
        typeof data?.workspaceId === "string" ? data.workspaceId.trim() : "";
      if (!taskId || !workspaceId) return null;
      const session = await shellSessionManager.closeSession(
        taskId,
        workspaceId,
        data.scope || "task",
      );
      emitShellSessionLifecycle(taskId, "closed", session);
      return session;
    },
  );

  // Send follow-up message to a task
  ipcMain.handle(IPC_CHANNELS.TASK_SEND_MESSAGE, async (_, data) => {
    checkRateLimit(IPC_CHANNELS.TASK_SEND_MESSAGE);
    const validated = validateInput(TaskMessageSchema, data, "task message");
    const validatedImages = validated.images;
    try {
	      const result = await agentDaemon.sendMessage(
	        validated.taskId,
	        validated.message,
	        validatedImages,
	        validated.quotedAssistantMessage,
	        {
	          ...(validated.permissionMode ? { permissionMode: validated.permissionMode } : {}),
	          ...(validated.shellAccess !== undefined ? { shellAccess: validated.shellAccess } : {}),
	        },
	      );
      // If the message was queued for a running executor, the executor owns
      // the image data now — skip temp file cleanup so it can read them later.
      if (!result.queued) {
        await cleanupTaskImageTempFiles(validatedImages);
      }
    } catch (err) {
      await cleanupTaskImageTempFiles(validatedImages);
      throw err;
    }
  });

  // Approval handlers
  ipcMain.handle(IPC_CHANNELS.APPROVAL_RESPOND, async (_, data) => {
    const validated = validateInput(
      ApprovalResponseSchema,
      data,
      "approval response",
    );
    await agentDaemon.respondToApproval(
      validated.approvalId,
      validated.approved ?? validated.action?.startsWith("allow_") === true,
      validated.action,
    );
  });

  ipcMain.handle(IPC_CHANNELS.INPUT_REQUEST_LIST, async (_, data) => {
    const limit =
      typeof data?.limit === "number" && Number.isFinite(data.limit)
        ? Math.min(500, Math.max(1, Math.floor(data.limit)))
        : 200;
    const offset =
      typeof data?.offset === "number" && Number.isFinite(data.offset)
        ? Math.max(0, Math.floor(data.offset))
        : 0;
    const taskId = typeof data?.taskId === "string" ? data.taskId.trim() : "";
    const status = typeof data?.status === "string" ? data.status.trim() : "";
    const normalizedStatus =
      status === "pending" || status === "submitted" || status === "dismissed"
        ? status
        : undefined;

    return agentDaemon.listInputRequests({
      limit,
      offset,
      ...(taskId ? { taskId } : {}),
      ...(normalizedStatus ? { status: normalizedStatus } : {}),
    });
  });

  ipcMain.handle(IPC_CHANNELS.INPUT_REQUEST_RESPOND, async (_, data) => {
    const validated = validateInput(
      InputRequestResponseSchema,
      data,
      "input request response",
    );
    return agentDaemon.respondToInputRequest(validated);
  });

  // Session auto-approve handlers
  ipcMain.handle(
    IPC_CHANNELS.APPROVAL_SESSION_AUTO_APPROVE_SET,
    async (_, enabled: boolean) => {
      agentDaemon.setSessionAutoApproveAll(!!enabled);
    },
  );

  ipcMain.handle(IPC_CHANNELS.APPROVAL_SESSION_AUTO_APPROVE_GET, async () => {
    return agentDaemon.getSessionAutoApproveAll();
  });

  // Artifact handlers
  ipcMain.handle(IPC_CHANNELS.ARTIFACT_LIST, async (_, taskId: string) => {
    return artifactRepo.findByTaskId(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.ARTIFACT_PREVIEW, async (_, _id: string) => {
    // TODO: Implement artifact preview
    return null;
  });

  // Agents Hub handlers
  const toManagedRoutinePayload = (
    input: ReturnType<ManagedSessionService["buildManagedAgentRoutineDefinition"]>,
    agentId: string,
  ): RoutineCreate => {
    const triggerId = input.trigger.id || `managed:${input.trigger.type}:${Date.now()}`;
    let trigger: RoutineTrigger;
    switch (input.trigger.type) {
      case "schedule":
        trigger = {
          id: triggerId,
          type: "schedule",
          enabled: input.trigger.enabled !== false,
          schedule: {
            kind: "every",
            everyMs: Math.max(15, input.trigger.cadenceMinutes || 60) * 60_000,
          },
        };
        break;
      case "api":
        trigger = {
          id: triggerId,
          type: "api",
          enabled: input.trigger.enabled !== false,
          path: input.trigger.path || `/agents/${agentId}`,
        };
        break;
      case "channel_event":
        trigger = {
          id: triggerId,
          type: "channel_event",
          enabled: input.trigger.enabled !== false,
          channelType: input.trigger.channelType,
          chatId: input.trigger.chatId,
          textContains: input.trigger.textContains,
          senderContains: input.trigger.senderContains,
        };
        break;
      case "mailbox_event":
        trigger = {
          id: triggerId,
          type: "mailbox_event",
          enabled: input.trigger.enabled !== false,
          eventType: input.trigger.eventType,
          subjectContains: input.trigger.subjectContains,
          provider: input.trigger.provider,
          labelContains: input.trigger.labelContains,
        };
        break;
      case "github_event":
        trigger = {
          id: triggerId,
          type: "github_event",
          enabled: input.trigger.enabled !== false,
          eventName: input.trigger.eventName,
          repository: input.trigger.repository,
          action: input.trigger.action,
          ref: input.trigger.ref,
        };
        break;
      case "connector_event":
        trigger = {
          id: triggerId,
          type: "connector_event",
          enabled: input.trigger.enabled !== false,
          connectorId: input.trigger.connectorId || "connector",
          changeType: input.trigger.changeType,
          resourceUriContains: input.trigger.resourceUriContains,
        };
        break;
      case "manual":
      default:
        trigger = {
          id: triggerId,
          type: "manual",
          enabled: input.trigger.enabled !== false,
        };
        break;
    }
    return {
      name: input.name || "Managed agent routine",
      description: input.description,
      enabled: input.enabled ?? true,
      workspaceId: input.workspaceId,
      instructions: input.instructions,
      executionTarget: {
        kind: "managed_environment" as const,
        managedEnvironmentId: input.environmentId,
      },
      contextBindings: {
        metadata: {
          managedAgentId: agentId,
        },
      },
      triggers: [trigger],
      outputs: [{ kind: "task_only" }],
      approvalPolicy: { mode: "inherit" },
      connectorPolicy: { mode: "prefer", connectorIds: [] },
    };
  };
  ipcMain.handle(IPC_CHANNELS.MANAGED_AGENT_LIST_IPC, async (_, params?: Any) => {
    return managedSessionService.listAgents(params);
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_AGENT_GET_IPC, async (_, agentId: string) => {
    return managedSessionService.getAgent(agentId) || null;
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_AGENT_RUNTIME_TOOL_CATALOG_IPC, async (_, agentId: string) => {
    return managedSessionService.getRuntimeToolCatalog(agentId);
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_AGENT_CREATE_IPC, async (_, request: Any) => {
    return managedSessionService.createAgent(request);
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_AGENT_UPDATE_IPC, async (_, request: Any) => {
    if (!request?.agentId) throw new Error("agentId is required");
    return managedSessionService.updateAgent(request.agentId, request);
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_AGENT_ARCHIVE_IPC, async (_, agentId: string) => {
    return (await managedSessionService.archiveAgent(agentId)) || null;
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_AGENT_PUBLISH_IPC, async (_, agentId: string) => {
    return (await managedSessionService.publishAgent(agentId)) || null;
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_AGENT_SUSPEND_IPC, async (_, agentId: string) => {
    return (await managedSessionService.suspendAgent(agentId)) || null;
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_AGENT_ROUTINE_LIST_IPC, async (_, agentId: string) => {
    return managedSessionService.listManagedAgentRoutines(agentId);
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_AGENT_ROUTINE_CREATE_IPC, async (_, request: Any) => {
    const routineService = getRoutineService();
    if (!routineService) throw new Error("Routine service is not available");
    const prepared = managedSessionService.buildManagedAgentRoutineDefinition(request);
    const routine = await routineService.create(
      toManagedRoutinePayload(prepared, request.agentId),
    );
    managedSessionService.syncManagedAgentRoutineRefs(request.agentId);
    const created = managedSessionService
      .listManagedAgentRoutines(request.agentId)
      .find((entry) => entry.id === routine.id);
    if (!created) throw new Error("Failed to create managed agent routine");
    const workspaceId = managedSessionService.getEnvironment(prepared.environmentId)?.config.workspaceId;
    if (workspaceId) {
      (managedSessionService as Any).appendAudit?.({
        agentId: request.agentId,
        workspaceId,
        action: "routine_created",
        summary: `Created routine ${created.name}`,
        metadata: { routineId: created.id, triggerType: created.trigger.type },
      });
    }
    return created;
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_AGENT_ROUTINE_UPDATE_IPC, async (_, request: Any) => {
    const routineService = getRoutineService();
    if (!routineService) throw new Error("Routine service is not available");
    const existing = routineService.get(request.routineId);
    if (!existing) throw new Error(`Routine not found: ${request.routineId}`);
    const prepared = managedSessionService.buildManagedAgentRoutineDefinition(request);
    await routineService.update(request.routineId, toManagedRoutinePayload(prepared, request.agentId));
    managedSessionService.syncManagedAgentRoutineRefs(request.agentId);
    const updated = managedSessionService
      .listManagedAgentRoutines(request.agentId)
      .find((entry) => entry.id === request.routineId);
    if (!updated) throw new Error("Failed to update managed agent routine");
    return updated;
  });
  ipcMain.handle(
    IPC_CHANNELS.MANAGED_AGENT_ROUTINE_DELETE_IPC,
    async (_, payload: { agentId: string; routineId: string }) => {
      const routineService = getRoutineService();
      if (!routineService) throw new Error("Routine service is not available");
      const removed = await routineService.remove(payload.routineId);
      managedSessionService.syncManagedAgentRoutineRefs(payload.agentId);
      return removed;
    },
  );
  ipcMain.handle(IPC_CHANNELS.MANAGED_AGENT_INSIGHTS_GET_IPC, async (_, agentId: string) => {
    return managedSessionService.getAgentInsights(agentId);
  });
  ipcMain.handle(
    IPC_CHANNELS.MANAGED_AGENT_AUDIT_LIST_IPC,
    async (_, payload: { agentId: string; limit?: number }) => {
      return managedSessionService.listAuditEntries(payload.agentId, payload.limit);
    },
  );
  ipcMain.handle(IPC_CHANNELS.MANAGED_AGENT_SLACK_HEALTH_GET_IPC, async (_, agentId: string) => {
    return managedSessionService.getSlackDeploymentHealth(agentId);
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_AGENT_CONVERT_ROLE_IPC, async (_, request: Any) => {
    const routineService = getRoutineService();
    const converted = managedSessionService.convertAgentRoleToManagedAgent(request);
    const routines = routineService
      ? await Promise.all(
          converted.routineDrafts.map((draft) =>
            routineService.create(
              toManagedRoutinePayload(
                managedSessionService.buildManagedAgentRoutineDefinition(draft),
                draft.agentId,
              ),
            ),
          ),
        )
      : [];
    managedSessionService.syncManagedAgentRoutineRefs(converted.agent.id);
    return {
      agent: converted.agent,
      version: converted.version,
      environment: converted.environment,
      routines: managedSessionService.listManagedAgentRoutines(converted.agent.id),
      sourceType: converted.sourceType,
      sourceId: converted.sourceId,
    };
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_AGENT_CONVERT_AUTOMATION_IPC, async (_, request: Any) => {
    const routineService = getRoutineService();
    const converted = managedSessionService.convertAutomationProfileToManagedAgent(request);
    if (routineService) {
      for (const draft of converted.routineDrafts) {
        await routineService.create(
          toManagedRoutinePayload(
            managedSessionService.buildManagedAgentRoutineDefinition(draft),
            draft.agentId,
          ),
        );
      }
    }
    managedSessionService.syncManagedAgentRoutineRefs(converted.agent.id);
    return {
      agent: converted.agent,
      version: converted.version,
      environment: converted.environment,
      routines: managedSessionService.listManagedAgentRoutines(converted.agent.id),
      sourceType: converted.sourceType,
      sourceId: converted.sourceId,
    };
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_ENVIRONMENT_LIST_IPC, async (_, params?: Any) => {
    return managedSessionService.listEnvironments(params);
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_ENVIRONMENT_GET_IPC, async (_, environmentId: string) => {
    return managedSessionService.getEnvironment(environmentId) || null;
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_ENVIRONMENT_CREATE_IPC, async (_, request: Any) => {
    return managedSessionService.createEnvironment(request);
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_ENVIRONMENT_UPDATE_IPC, async (_, request: Any) => {
    if (!request?.environmentId) throw new Error("environmentId is required");
    return managedSessionService.updateEnvironment(request.environmentId, request) || null;
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_ENVIRONMENT_ARCHIVE_IPC, async (_, environmentId: string) => {
    return managedSessionService.archiveEnvironment(environmentId) || null;
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_SESSION_LIST_IPC, async (_, params?: Any) => {
    return managedSessionService.listSessions(params);
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_SESSION_GET_IPC, async (_, sessionId: string) => {
    return managedSessionService.getSession(sessionId) || null;
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_SESSION_CREATE_IPC, async (_, request: Any) => {
    return managedSessionService.createSession(request);
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_SESSION_RESUME_IPC, async (_, sessionId: string) => {
    return managedSessionService.resumeSession(sessionId);
  });
  ipcMain.handle(IPC_CHANNELS.MANAGED_SESSION_CANCEL_IPC, async (_, sessionId: string) => {
    return managedSessionService.cancelSession(sessionId);
  });
  ipcMain.handle(
    IPC_CHANNELS.MANAGED_SESSION_EVENTS_LIST_IPC,
    async (_, payload: { sessionId: string; limit?: number }) => {
      return managedSessionService.listSessionEvents(payload.sessionId, payload.limit);
    },
  );
  ipcMain.handle(IPC_CHANNELS.MANAGED_SESSION_WORKPAPER_GET_IPC, async (_, sessionId: string) => {
    return managedSessionService.getSessionWorkpaper(sessionId);
  });
  ipcMain.handle(
    IPC_CHANNELS.MANAGED_SESSION_GENERATE_AUDIO_SUMMARY,
    async (_, payload: { sessionId: string; config?: Any }) => {
      return managedSessionService.generateAudioSummary(payload.sessionId, payload.config);
    },
  );
  ipcMain.handle(IPC_CHANNELS.AGENT_WORKSPACE_MEMBERSHIP_LIST_IPC, async (_, workspaceId?: string) => {
    return managedSessionService.listWorkspaceMemberships(workspaceId);
  });
  ipcMain.handle(
    IPC_CHANNELS.AGENT_WORKSPACE_MEMBERSHIP_UPDATE_IPC,
    async (_, request: { workspaceId: string; principalId: string; role: string }) => {
      return managedSessionService.updateWorkspaceMembership({
        workspaceId: request.workspaceId,
        principalId: request.principalId,
        role: request.role as Any,
      });
    },
  );
  ipcMain.handle(
    IPC_CHANNELS.AGENT_WORKSPACE_PERMISSION_SNAPSHOT_IPC,
    async (_, payload: { workspaceId: string; principalId?: string }) => {
      return managedSessionService.getMyWorkspacePermissions(payload.workspaceId);
    },
  );
  ipcMain.handle(IPC_CHANNELS.AGENT_TEMPLATE_LIST, async () => {
    return agentTemplateService.list();
  });
  ipcMain.handle(IPC_CHANNELS.IMAGE_GEN_PROFILE_LIST, async () => {
    return imageGenProfileService.list();
  });
  ipcMain.handle(IPC_CHANNELS.IMAGE_GEN_PROFILE_CREATE, async (_, request: Any) => {
    return imageGenProfileService.create(request);
  });
  ipcMain.handle(IPC_CHANNELS.IMAGE_GEN_PROFILE_UPDATE, async (_, request: Any) => {
    if (!request?.id) throw new Error("id is required");
    return imageGenProfileService.update(request.id, request);
  });
  ipcMain.handle(IPC_CHANNELS.IMAGE_GEN_PROFILE_DELETE, async (_, id: string) => {
    return imageGenProfileService.delete(id);
  });

  // Skill handlers
  ipcMain.handle(IPC_CHANNELS.SKILL_LIST, async () => {
    return skillRepo.findAll();
  });

  ipcMain.handle(IPC_CHANNELS.SKILL_GET, async (_, id: string) => {
    return skillRepo.findById(id);
  });

  // Custom User Skills handlers
  const customSkillLoader = getCustomSkillLoader();
  const secureSettingsRepo = SecureSettingsRepository.isInitialized()
    ? SecureSettingsRepository.getInstance()
    : new SecureSettingsRepository(dbManager.getDatabase());
  const loadSkillsConfig = (): SkillsConfig => {
    const stored =
      secureSettingsRepo.load<Partial<SkillsConfig>>("skills") || {};
    return {
      skillsDirectory: customSkillLoader.getManagedSkillsDir(),
      externalSkillDirectories: Array.isArray(stored.externalSkillDirectories)
        ? stored.externalSkillDirectories.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      enabledSkillIds: Array.isArray(stored.enabledSkillIds)
        ? stored.enabledSkillIds.filter(
            (value): value is string => typeof value === "string",
          )
        : [],
      registryUrl:
        typeof stored.registryUrl === "string" ? stored.registryUrl : undefined,
      autoUpdate: stored.autoUpdate === true,
      allowlist: Array.isArray(stored.allowlist)
        ? stored.allowlist.filter(
            (value): value is string => typeof value === "string",
          )
        : undefined,
      denylist: Array.isArray(stored.denylist)
        ? stored.denylist.filter(
            (value): value is string => typeof value === "string",
          )
        : undefined,
    };
  };
  let skillsConfig = loadSkillsConfig();
  customSkillLoader.updateConfig(skillsConfig);

  // Initialize custom skill loader
  customSkillLoader.initialize().catch((error) => {
    logger.error("[IPC] Failed to initialize custom skill loader:", error);
  });

  ipcMain.handle(IPC_CHANNELS.CUSTOM_SKILL_LIST, async () => {
    return customSkillLoader.listSkills();
  });

  ipcMain.handle(IPC_CHANNELS.CUSTOM_SKILL_LIST_TASKS, async () => {
    return customSkillLoader.listTaskSkills();
  });

  ipcMain.handle(IPC_CHANNELS.CUSTOM_SKILL_LIST_GUIDELINES, async () => {
    return customSkillLoader.listGuidelineSkills();
  });

  ipcMain.handle(IPC_CHANNELS.CUSTOM_SKILL_GET, async (_, id: string) => {
    return customSkillLoader.getSkill(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.CUSTOM_SKILL_CREATE,
    async (_, skillData: Omit<CustomSkill, "filePath">) => {
      return customSkillLoader.createSkill(skillData);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CUSTOM_SKILL_UPDATE,
    async (_, id: string, updates: Partial<CustomSkill>) => {
      return customSkillLoader.updateSkill(id, updates);
    },
  );

  ipcMain.handle(IPC_CHANNELS.CUSTOM_SKILL_DELETE, async (_, id: string) => {
    return customSkillLoader.deleteSkill(id);
  });

  ipcMain.handle(IPC_CHANNELS.CUSTOM_SKILL_RELOAD, async () => {
    return customSkillLoader.reloadSkills();
  });

  ipcMain.handle(IPC_CHANNELS.CUSTOM_SKILL_OPEN_FOLDER, async () => {
    return customSkillLoader.openSkillsFolder();
  });

  ipcMain.handle(IPC_CHANNELS.CUSTOM_SKILL_GET_SETTINGS, async () => {
    return skillsConfig;
  });

  ipcMain.handle(
    IPC_CHANNELS.CUSTOM_SKILL_SET_EXTERNAL_DIRS,
    async (_, dirs: string[]) => {
      const normalized = customSkillLoader.setExternalSkillDirs(dirs);
      skillsConfig = {
        ...skillsConfig,
        skillsDirectory: customSkillLoader.getManagedSkillsDir(),
        externalSkillDirectories: normalized,
      };
      secureSettingsRepo.save("skills", skillsConfig);
      customSkillLoader.updateConfig(skillsConfig);
      customSkillLoader.clearEligibilityCache();
      await customSkillLoader.reloadSkills();
      return skillsConfig;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CUSTOM_SKILL_OPEN_EXTERNAL_FOLDER,
    async (_, dir: string) => {
      return customSkillLoader.openExternalSkillsFolder(dir);
    },
  );

  // Skill Registry (SkillHub) handlers
  const { getSkillRegistry } = await import("../agent/skill-registry");
  const skillRegistry = getSkillRegistry();

  ipcMain.handle(
    IPC_CHANNELS.SKILL_REGISTRY_SEARCH,
    async (
      _,
      query: string,
      options?: { page?: number; pageSize?: number },
    ) => {
      return skillRegistry.search(query, options);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILL_REGISTRY_CLAWHUB_SEARCH,
    async (
      _,
      query: string,
      options?: { page?: number; pageSize?: number },
    ) => {
      return skillRegistry.searchClawHub(query, options);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILL_REGISTRY_GET_DETAILS,
    async (_, skillId: string) => {
      return skillRegistry.getSkillDetails(skillId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILL_REGISTRY_INSTALL,
    async (_, skillId: string, version?: string) => {
      const result = await skillRegistry.install(skillId, version);
      if (result.success) {
        // Reload skills to pick up the new one
        await customSkillLoader.reloadSkills();
        // Clear eligibility cache in case new dependencies were installed
        customSkillLoader.clearEligibilityCache();
      }
      return result;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILL_REGISTRY_INSTALL_CLAWHUB,
    async (_, identifierOrUrl: string) => {
      const result = await skillRegistry.installFromClawHub(identifierOrUrl);
      if (result.success) {
        await customSkillLoader.reloadSkills();
        customSkillLoader.clearEligibilityCache();
      }
      return result;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILL_REGISTRY_INSTALL_URL,
    async (_, url: string) => {
      const result = await skillRegistry.installFromUrl(url);
      if (result.success) {
        await customSkillLoader.reloadSkills();
        customSkillLoader.clearEligibilityCache();
      }
      return result;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILL_REGISTRY_INSTALL_GIT,
    async (_, gitUrl: string) => {
      const result = await skillRegistry.installFromGit(gitUrl);
      if (result.success) {
        await customSkillLoader.reloadSkills();
        customSkillLoader.clearEligibilityCache();
      }
      return result;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SKILL_REGISTRY_UPDATE,
    async (_, skillId: string, version?: string) => {
      const result = await skillRegistry.update(skillId, version);
      if (result.success) {
        await customSkillLoader.reloadSkills();
        customSkillLoader.clearEligibilityCache();
      }
      return result;
    },
  );

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_UPDATE_ALL, async () => {
    const result = await skillRegistry.updateAll();
    await customSkillLoader.reloadSkills();
    customSkillLoader.clearEligibilityCache();
    return result;
  });

  ipcMain.handle(
    IPC_CHANNELS.SKILL_REGISTRY_UNINSTALL,
    async (_, skillId: string) => {
      const result = skillRegistry.uninstall(skillId);
      if (result.success) {
        await customSkillLoader.reloadSkills();
      }
      return result;
    },
  );

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_LIST_MANAGED, async () => {
    return skillRegistry.listManagedSkills();
  });

  ipcMain.handle(
    IPC_CHANNELS.SKILL_REGISTRY_CHECK_UPDATES,
    async (_, skillId: string) => {
      return skillRegistry.checkForUpdates(skillId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_GET_STATUS, async () => {
    return customSkillLoader.getSkillStatus();
  });

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_GET_ELIGIBLE, async () => {
    return customSkillLoader.getEligibleSkills();
  });

  const { getCapabilityBundleSecurityService } =
    await import("../security/capability-bundle-security");
  const capabilitySecurityService = getCapabilityBundleSecurityService();
  const { getPluginRegistry } = await import("../extensions/registry");

  ipcMain.handle(IPC_CHANNELS.IMPORT_SECURITY_LIST_QUARANTINED, async () => {
    return capabilitySecurityService.listQuarantinedImports();
  });

  ipcMain.handle(
    IPC_CHANNELS.IMPORT_SECURITY_GET_REPORT,
    async (
      _,
      request: import("../../shared/types").ImportSecurityReportRequest,
    ) => {
      const pluginRegistry = getPluginRegistry();
      const activePackPath =
        request.bundleKind === "plugin-pack"
          ? pluginRegistry.getPlugin(request.bundleId)?.path
          : undefined;
      return capabilitySecurityService.getImportSecurityReport(
        request,
        skillRegistry.getManagedSkillsDir(),
        activePackPath,
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.IMPORT_SECURITY_RETRY_QUARANTINED,
    async (_, recordId: string) => {
      const result =
        await capabilitySecurityService.retryQuarantinedImport(recordId);
      await customSkillLoader.reloadSkills();
      customSkillLoader.clearEligibilityCache();
      try {
        const pluginRegistry = getPluginRegistry();
        await pluginRegistry.discoverNewPlugins();
      } catch (error) {
        logger.warn(
          "[IPC] Failed to refresh plugin registry after quarantine retry:",
          error,
        );
      }
      return result;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.IMPORT_SECURITY_REMOVE_QUARANTINED,
    async (_, recordId: string) => {
      return capabilitySecurityService.removeQuarantinedImport(recordId);
    },
  );

  // LLM Settings handlers
  ipcMain.handle(IPC_CHANNELS.LLM_GET_SETTINGS, async () => {
    return LLMProviderFactory.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.LLM_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.LLM_SAVE_SETTINGS);
    const validated = validateInput(
      LLMSettingsSchema,
      settings,
      "LLM settings",
    );

    // Load existing settings to preserve cached models and OAuth tokens
    const existingSettings = LLMProviderFactory.loadSettings();
    const mergedSettings = buildSavedLLMSettings(validated, existingSettings);
    LLMProviderFactory.saveSettings({
      ...mergedSettings,
      modelKey: mergedSettings.modelKey as ModelKey,
    });
    // saveSettings() already updates the in-memory cache; calling clearCache() here
    // would throw away the updated cache and force a DB re-read, which can return
    // stale data (e.g. if safeStorage decryption fails) and prevent mid-session
    // provider changes from being detected by refreshProviderIfSettingsChanged().
    return { success: true };
  });

  ipcMain.handle(
    IPC_CHANNELS.LLM_RESET_PROVIDER_CREDENTIALS,
    async (_, providerType: string) => {
      checkRateLimit(IPC_CHANNELS.LLM_RESET_PROVIDER_CREDENTIALS);

      const resolvedProviderType = resolveCustomProviderId(providerType);
      const settings = LLMProviderFactory.loadSettings();
      const updatedSettings = { ...settings };

      const clearCustomProviderConfig = (providerId: string) => {
        if (!updatedSettings.customProviders) return;

        const nextCustomProviders = { ...updatedSettings.customProviders };
        delete nextCustomProviders[providerId];
        if (providerId === "kimi-code") {
          delete nextCustomProviders["kimi-coding"];
        }
        updatedSettings.customProviders =
          Object.keys(nextCustomProviders).length > 0
            ? nextCustomProviders
            : undefined;
      };

      switch (resolvedProviderType) {
        case "anthropic":
          updatedSettings.anthropic = undefined;
          updatedSettings.cachedAnthropicModels = undefined;
          break;
        case "bedrock":
          updatedSettings.bedrock = undefined;
          updatedSettings.cachedBedrockModels = undefined;
          break;
        case "ollama":
          updatedSettings.ollama = undefined;
          updatedSettings.cachedOllamaModels = undefined;
          break;
        case "gemini":
          updatedSettings.gemini = undefined;
          updatedSettings.cachedGeminiModels = undefined;
          break;
        case "openrouter":
          updatedSettings.openrouter = undefined;
          updatedSettings.cachedOpenRouterModels = undefined;
          break;
        case "openai":
          updatedSettings.openai = undefined;
          updatedSettings.cachedOpenAIModels = undefined;
          break;
        case "azure":
          updatedSettings.azure = undefined;
          break;
        case "azure-anthropic":
          updatedSettings.azureAnthropic = undefined;
          break;
        case "groq":
          updatedSettings.groq = undefined;
          updatedSettings.cachedGroqModels = undefined;
          break;
        case "xai":
          updatedSettings.xai = undefined;
          updatedSettings.cachedXaiModels = undefined;
          break;
        case "kimi":
          updatedSettings.kimi = undefined;
          updatedSettings.cachedKimiModels = undefined;
          break;
        case "pi":
          updatedSettings.pi = undefined;
          updatedSettings.cachedPiModels = undefined;
          break;
        case "openai-compatible":
          updatedSettings.openaiCompatible = undefined;
          updatedSettings.cachedOpenAICompatibleModels = undefined;
          break;
        default:
          clearCustomProviderConfig(resolvedProviderType);
          break;
      }

      LLMProviderFactory.saveSettings(updatedSettings);
      LLMProviderFactory.clearCache();
      return { success: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS.LLM_TEST_PROVIDER, async (_, config: Any) => {
    checkRateLimit(IPC_CHANNELS.LLM_TEST_PROVIDER);
    const validatedConfig = validateInput(
      LLMSettingsSchema,
      config,
      "LLM provider test config",
    );
    // For OpenAI OAuth, get tokens from stored settings if authMethod is 'oauth'
    let openaiAccessToken: string | undefined;
    let openaiRefreshToken: string | undefined;
    let openaiTokenExpiresAt: number | undefined;
    if (
      validatedConfig.providerType === "openai" &&
      validatedConfig.openai?.authMethod === "oauth"
    ) {
      const settings = LLMProviderFactory.loadSettings();
      openaiAccessToken = settings.openai?.accessToken;
      openaiRefreshToken = settings.openai?.refreshToken;
      openaiTokenExpiresAt = settings.openai?.tokenExpiresAt;
    }
    const resolvedProviderType = resolveCustomProviderId(validatedConfig.providerType);
    const customProviderConfig =
      validatedConfig.customProviders?.[resolvedProviderType] ||
      validatedConfig.customProviders?.[validatedConfig.providerType];
    const openrouterBaseUrl = await validateOptionalProviderBaseUrl(
      validatedConfig.openrouter?.baseUrl,
      { providerLabel: "OpenRouter" },
    );
    const groqBaseUrl = await validateOptionalProviderBaseUrl(
      validatedConfig.groq?.baseUrl,
      { providerLabel: "Groq" },
    );
    const xaiBaseUrl = await validateOptionalProviderBaseUrl(
      validatedConfig.xai?.baseUrl,
      { providerLabel: "xAI" },
    );
    const kimiBaseUrl = await validateOptionalProviderBaseUrl(
      validatedConfig.kimi?.baseUrl,
      { providerLabel: "Kimi" },
    );
    const ollamaBaseUrl = await validateOptionalProviderBaseUrl(
      validatedConfig.ollama?.baseUrl,
      { providerLabel: "Ollama", allowLoopback: true },
    );
    const openaiCompatibleBaseUrl = await validateOptionalProviderBaseUrl(
      validatedConfig.openaiCompatible?.baseUrl,
      { providerLabel: "OpenAI-compatible provider", allowLoopback: true },
    );
    const providerBaseUrl = await validateOptionalProviderBaseUrl(
      customProviderConfig?.baseUrl,
      { providerLabel: `Custom provider ${resolvedProviderType}`, allowLoopback: true },
    );
    const anthropicCredential =
      validatedConfig.anthropic?.authMethod === "subscription"
        ? validatedConfig.anthropic?.subscriptionToken || validatedConfig.anthropic?.apiKey
        : validatedConfig.anthropic?.authMethod === "api_key"
          ? validatedConfig.anthropic?.apiKey || validatedConfig.anthropic?.subscriptionToken
          : validatedConfig.anthropic?.subscriptionToken || validatedConfig.anthropic?.apiKey;
    const azureDeployment =
      validatedConfig.azure?.deployment || validatedConfig.azure?.deployments?.[0];
    const azureAnthropicDeployment =
      validatedConfig.azureAnthropic?.deployment ||
      validatedConfig.azureAnthropic?.deployments?.[0];
    const providerConfig: LLMProviderConfig = {
      type: validatedConfig.providerType,
      model: LLMProviderFactory.getModelId(
        validatedConfig.modelKey as ModelKey,
        validatedConfig.providerType,
        validatedConfig.ollama?.model,
        validatedConfig.gemini?.model,
        validatedConfig.openrouter?.model,
        validatedConfig.openai?.model,
        azureDeployment,
        azureAnthropicDeployment,
        validatedConfig.groq?.model,
        validatedConfig.xai?.model,
        validatedConfig.kimi?.model,
        validatedConfig.customProviders,
        validatedConfig.bedrock?.model,
      ),
      anthropicApiKey: anthropicCredential,
      awsRegion: validatedConfig.bedrock?.region,
      awsAccessKeyId: validatedConfig.bedrock?.accessKeyId,
      awsSecretAccessKey: validatedConfig.bedrock?.secretAccessKey,
      awsSessionToken: validatedConfig.bedrock?.sessionToken,
      awsProfile: validatedConfig.bedrock?.profile,
      ollamaBaseUrl,
      ollamaApiKey: validatedConfig.ollama?.apiKey,
      geminiApiKey: validatedConfig.gemini?.apiKey,
      openrouterApiKey: validateOptionalProviderApiKey(
        validatedConfig.openrouter?.apiKey,
        "OpenRouter",
      ),
      openrouterBaseUrl,
      openaiApiKey: validatedConfig.openai?.apiKey,
      openaiAccessToken,
      openaiRefreshToken,
      openaiTokenExpiresAt,
      azureApiKey: validatedConfig.azure?.apiKey,
      azureEndpoint: validatedConfig.azure?.endpoint,
      azureDeployment: azureDeployment,
      azureApiVersion: validatedConfig.azure?.apiVersion,
      azureReasoningEffort: validatedConfig.azure?.reasoningEffort,
      azureAnthropicApiKey: validatedConfig.azureAnthropic?.apiKey,
      azureAnthropicEndpoint: validatedConfig.azureAnthropic?.endpoint,
      azureAnthropicDeployment: azureAnthropicDeployment,
      azureAnthropicApiVersion: validatedConfig.azureAnthropic?.apiVersion,
      groqApiKey: validateOptionalProviderApiKey(validatedConfig.groq?.apiKey, "Groq"),
      groqBaseUrl,
      xaiApiKey: validateOptionalProviderApiKey(validatedConfig.xai?.apiKey, "xAI"),
      xaiBaseUrl,
      kimiApiKey: validateOptionalProviderApiKey(validatedConfig.kimi?.apiKey, "Kimi"),
      kimiBaseUrl,
      openaiCompatibleApiKey: validateOptionalProviderApiKey(
        validatedConfig.openaiCompatible?.apiKey,
        "OpenAI-compatible provider",
      ),
      openaiCompatibleBaseUrl,
      providerApiKey: validateOptionalProviderApiKey(
        customProviderConfig?.apiKey,
        `Custom provider ${resolvedProviderType}`,
      ),
      providerBaseUrl,
    };
    return LLMProviderFactory.testProvider(providerConfig);
  });

  ipcMain.handle(IPC_CHANNELS.LLM_GET_MODELS, async () => {
    // Get models from database
    const dbModels = llmModelRepo.findAll();
    return dbModels.map((m) => ({
      key: m.key,
      displayName: m.displayName,
      description: m.description,
    }));
  });

  ipcMain.handle(IPC_CHANNELS.LLM_GET_CONFIG_STATUS, async () => {
    return LLMProviderFactory.getConfigStatus();
  });

  ipcMain.handle(
    IPC_CHANNELS.LLM_ROUTING_STATUS,
    async (): Promise<LLMRoutingRuntimeState> => {
      return RuntimeVisibilityService.buildRoutingState(
        LLMProviderFactory.loadSettings(),
      );
    },
  );

  // Get models available for a specific provider type (for multi-LLM selection)
  ipcMain.handle(
    IPC_CHANNELS.LLM_GET_PROVIDER_MODELS,
    async (_, providerType: string) => {
      const settings = LLMProviderFactory.loadSettings();
      const modifiedSettings = {
        ...settings,
        providerType: providerType as Any,
      };
      const modelStatus =
        LLMProviderFactory.getProviderModelStatus(modifiedSettings);
      return modelStatus.models;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.LLM_REFRESH_CUSTOM_PROVIDER_MODELS,
    async (
      _,
      providerType: string,
      overrides?: { apiKey?: string; baseUrl?: string },
    ) => {
      checkRateLimit(IPC_CHANNELS.LLM_REFRESH_CUSTOM_PROVIDER_MODELS);
      const validatedProviderType = validateInput(
        z.string().trim().min(1).max(200),
        providerType,
        "custom provider type",
      );
      const validatedOverrides = overrides
        ? {
            apiKey: validateOptionalProviderApiKey(overrides.apiKey, validatedProviderType),
            baseUrl: await validateOptionalProviderBaseUrl(overrides.baseUrl, {
              providerLabel: validatedProviderType,
              allowLoopback: true,
            }),
          }
        : undefined;
      return LLMProviderFactory.getCustomProviderModels(
        validatedProviderType as Any,
        validatedOverrides,
      );
    },
  );

  // Set the current model (persists selection across sessions)
  ipcMain.handle(IPC_CHANNELS.LLM_SET_MODEL, async (_, selection: string | {
    providerType?: string;
    modelKey: string;
    reasoningEffort?: LLMReasoningEffort;
  }) => {
    const modelKey =
      typeof selection === "string" ? selection : selection?.modelKey;
    if (typeof modelKey !== "string" || !modelKey.trim()) {
      throw new Error("modelKey is required");
    }
    const settings = LLMProviderFactory.loadSettings();
    const providerType =
      typeof selection === "string"
        ? settings.providerType
        : (selection.providerType as Any) || settings.providerType;
    let updatedSettings = LLMProviderFactory.applyModelSelection(
      settings,
      modelKey.trim(),
      providerType,
    );
    if (typeof selection !== "string" && selection.reasoningEffort) {
      updatedSettings = LLMProviderFactory.applyReasoningEffortSelection(
        updatedSettings,
        providerType,
        selection.reasoningEffort,
      );
    }
    LLMProviderFactory.saveSettings(updatedSettings);
    return { success: true };
  });

  ipcMain.handle(
    IPC_CHANNELS.LLM_GET_ANTHROPIC_MODELS,
    async (
      _,
      credentials?: {
        apiKey?: string;
        subscriptionToken?: string;
        authMethod?: "api_key" | "subscription";
      },
    ) => {
      checkRateLimit(IPC_CHANNELS.LLM_GET_ANTHROPIC_MODELS);
      const models = await LLMProviderFactory.getAnthropicModels(credentials);
      const cachedModels = models.map((m) => ({
        key: m.id,
        displayName: m.displayName,
        description: m.description,
      }));
      LLMProviderFactory.saveCachedModels("anthropic", cachedModels);
      return models;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.LLM_GET_OLLAMA_MODELS,
    async (_, baseUrl?: string) => {
      checkRateLimit(IPC_CHANNELS.LLM_GET_OLLAMA_MODELS);
      const validatedBaseUrl = await validateOptionalProviderBaseUrl(baseUrl, {
        providerLabel: "Ollama",
        allowLoopback: true,
      });
      logger.debug("Handling LLM_GET_OLLAMA_MODELS request");
      const models = await LLMProviderFactory.getOllamaModels(validatedBaseUrl);
      // Cache the models for use in config status
      const cachedModels = models.map((m) => ({
        key: m.name,
        displayName: m.name,
        description: `${Math.round(m.size / 1e9)}B parameter model`,
        size: m.size,
      }));
      LLMProviderFactory.saveCachedModels("ollama", cachedModels);
      return models;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.LLM_GET_GEMINI_MODELS,
    async (_, apiKey?: string) => {
      checkRateLimit(IPC_CHANNELS.LLM_GET_GEMINI_MODELS);
      const models = await LLMProviderFactory.getGeminiModels(
        validateOptionalProviderApiKey(apiKey, "Gemini"),
      );
      // Cache the models for use in config status
      const cachedModels = models.map((m) => ({
        key: m.name,
        displayName: m.displayName,
        description: m.description,
      }));
      LLMProviderFactory.saveCachedModels("gemini", cachedModels);
      return models;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.LLM_GET_OPENROUTER_MODELS,
    async (_, apiKey?: string, baseUrl?: string) => {
      checkRateLimit(IPC_CHANNELS.LLM_GET_OPENROUTER_MODELS);
      const validatedBaseUrl = await validateOptionalProviderBaseUrl(baseUrl, {
        providerLabel: "OpenRouter",
      });
      const models = await LLMProviderFactory.getOpenRouterModels(
        validateOptionalProviderApiKey(apiKey, "OpenRouter"),
        validatedBaseUrl,
      );
      // Cache the models for use in config status
      const cachedModels = models.map((m) => ({
        key: m.id,
        displayName: m.name,
        description: `Context: ${Math.round(m.context_length / 1000)}k tokens`,
        contextLength: m.context_length,
      }));
      LLMProviderFactory.saveCachedModels("openrouter", cachedModels);
      return models;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.LLM_GET_OPENAI_MODELS,
    async (_, apiKey?: string) => {
      checkRateLimit(IPC_CHANNELS.LLM_GET_OPENAI_MODELS);
      const models = await LLMProviderFactory.getOpenAIModels(
        validateOptionalProviderApiKey(apiKey, "OpenAI"),
      );
      // Cache the models for use in config status
      const cachedModels = models.map((m) => ({
        key: m.id,
        displayName: m.name,
        description: m.description,
      }));
      LLMProviderFactory.saveCachedModels("openai", cachedModels);
      return models;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.LLM_GET_GROQ_MODELS,
    async (_, apiKey?: string, baseUrl?: string) => {
      checkRateLimit(IPC_CHANNELS.LLM_GET_GROQ_MODELS);
      const validatedBaseUrl = await validateOptionalProviderBaseUrl(baseUrl, {
        providerLabel: "Groq",
      });
      const models = await LLMProviderFactory.getGroqModels(
        validateOptionalProviderApiKey(apiKey, "Groq"),
        validatedBaseUrl,
      );
      const cachedModels = models.map((m) => ({
        key: m.id,
        displayName: m.name,
        description: "Groq model",
      }));
      LLMProviderFactory.saveCachedModels("groq", cachedModels);
      return models;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.LLM_GET_XAI_MODELS,
    async (_, apiKey?: string, baseUrl?: string) => {
      checkRateLimit(IPC_CHANNELS.LLM_GET_XAI_MODELS);
      const validatedBaseUrl = await validateOptionalProviderBaseUrl(baseUrl, {
        providerLabel: "xAI",
      });
      const models = await LLMProviderFactory.getXAIModels(
        validateOptionalProviderApiKey(apiKey, "xAI"),
        validatedBaseUrl,
      );
      const cachedModels = models.map((m) => ({
        key: m.id,
        displayName: m.name,
        description: "xAI model",
      }));
      LLMProviderFactory.saveCachedModels("xai", cachedModels);
      return models;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.LLM_GET_KIMI_MODELS,
    async (_, apiKey?: string, baseUrl?: string) => {
      checkRateLimit(IPC_CHANNELS.LLM_GET_KIMI_MODELS);
      const validatedBaseUrl = await validateOptionalProviderBaseUrl(baseUrl, {
        providerLabel: "Kimi",
      });
      const models = await LLMProviderFactory.getKimiModels(
        validateOptionalProviderApiKey(apiKey, "Kimi"),
        validatedBaseUrl,
      );
      const cachedModels = models.map((m) => ({
        key: m.id,
        displayName: m.name,
        description: "Kimi model",
      }));
      LLMProviderFactory.saveCachedModels("kimi", cachedModels);
      return models;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.LLM_GET_PI_MODELS,
    async (_, piProvider?: string) => {
      checkRateLimit(IPC_CHANNELS.LLM_GET_PI_MODELS);
      const models = await LLMProviderFactory.getPiModels(piProvider);
      const cachedModels = models.map((m) => ({
        key: m.id,
        displayName: m.name,
        description: m.description,
      }));
      LLMProviderFactory.saveCachedModels("pi", cachedModels);
      return models;
    },
  );

  ipcMain.handle(IPC_CHANNELS.LLM_GET_PI_PROVIDERS, async () => {
    checkRateLimit(IPC_CHANNELS.LLM_GET_PI_PROVIDERS);
    return await LLMProviderFactory.getPiProviders();
  });

  ipcMain.handle(
    IPC_CHANNELS.LLM_GET_OPENAI_COMPATIBLE_MODELS,
    async (_, baseUrl: string, apiKey?: string) => {
      checkRateLimit(IPC_CHANNELS.LLM_GET_OPENAI_COMPATIBLE_MODELS);
      const validatedBaseUrl = await validateOpenAICompatibleBaseUrl(baseUrl, {
        allowLoopback: true,
      });
      return LLMProviderFactory.getOpenAICompatibleModels(
        validatedBaseUrl,
        validateOptionalProviderApiKey(apiKey, "OpenAI-compatible provider"),
      );
    },
  );

  // OpenAI OAuth handlers
  ipcMain.handle(IPC_CHANNELS.LLM_OPENAI_OAUTH_START, async () => {
    checkRateLimit(IPC_CHANNELS.LLM_OPENAI_OAUTH_START);
    logger.info("[IPC] Starting OpenAI OAuth flow with pi-ai SDK...");

    try {
      const oauth = new OpenAIOAuth();
      const tokens = await oauth.authenticate();

      // Save tokens to settings
      const settings = LLMProviderFactory.loadSettings();
      settings.openai = {
        ...settings.openai,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: tokens.expires_at,
        accountId: tokens.accountId,
        email: tokens.email,
        authMethod: "oauth",
        // Clear API key when using OAuth
        apiKey: undefined,
      };
      LLMProviderFactory.saveSettings(settings);
      LLMProviderFactory.clearCache();

      logger.info("[IPC] OpenAI OAuth successful");

      return { success: true, email: tokens.email };
    } catch (error: Any) {
      logger.error("[IPC] OpenAI OAuth failed:", error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.LLM_OPENAI_OAUTH_LOGOUT, async () => {
    checkRateLimit(IPC_CHANNELS.LLM_OPENAI_OAUTH_LOGOUT);
    logger.info("[IPC] Logging out of OpenAI OAuth...");

    // Clear OAuth tokens from settings
    const settings = LLMProviderFactory.loadSettings();
    if (settings.openai) {
      settings.openai = {
        ...settings.openai,
        accessToken: undefined,
        refreshToken: undefined,
        tokenExpiresAt: undefined,
        accountId: undefined,
        email: undefined,
        authMethod: undefined,
      };
      settings.cachedOpenAIModels = undefined;
      LLMProviderFactory.saveSettings(settings);
    }

    return { success: true };
  });

  ipcMain.handle(
    IPC_CHANNELS.LLM_GET_BEDROCK_MODELS,
    async (
      _,
      config?: {
        region?: string;
        accessKeyId?: string;
        secretAccessKey?: string;
        profile?: string;
      },
    ) => {
      checkRateLimit(IPC_CHANNELS.LLM_GET_BEDROCK_MODELS);
      const models = await LLMProviderFactory.getBedrockModels(config);
      // Cache the models for use in config status
      const cachedModels = models.map((m) => ({
        key: m.id,
        displayName: m.name,
        description: m.description,
      }));
      LLMProviderFactory.saveCachedModels("bedrock", cachedModels);
      return models;
    },
  );

  // Search Settings handlers
  ipcMain.handle(IPC_CHANNELS.SEARCH_GET_SETTINGS, async () => {
    return SearchProviderFactory.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.SEARCH_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.SEARCH_SAVE_SETTINGS);
    const validated = validateInput(
      SearchSettingsSchema,
      settings,
      "search settings",
    );
    SearchProviderFactory.saveSettings(validated as SearchSettings);
    SearchProviderFactory.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.SEARCH_GET_CONFIG_STATUS, async () => {
    return SearchProviderFactory.getConfigStatus();
  });

  ipcMain.handle(
    IPC_CHANNELS.SEARCH_TEST_PROVIDER,
    async (_, providerType: SearchProviderType) => {
      checkRateLimit(IPC_CHANNELS.SEARCH_TEST_PROVIDER);
      return SearchProviderFactory.testProvider(providerType);
    },
  );

  // X/Twitter Settings handlers
  ipcMain.handle(IPC_CHANNELS.X_GET_SETTINGS, async () => {
    return XSettingsManager.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.X_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.X_SAVE_SETTINGS);
    const validated = validateInput(
      XSettingsSchema,
      settings,
      "x settings",
    ) as XSettingsData;
    XSettingsManager.saveSettings(validated);
    XSettingsManager.clearCache();
    try {
      getXMentionBridgeService()?.triggerNow();
    } catch (error) {
      logger.warn(
        "[X] Failed to trigger immediate mention bridge poll:",
        error,
      );
    }
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.X_TEST_CONNECTION, async () => {
    checkRateLimit(IPC_CHANNELS.X_TEST_CONNECTION);
    const settings = XSettingsManager.loadSettings();
    return testXConnection(settings);
  });

  ipcMain.handle(IPC_CHANNELS.X_GET_STATUS, async () => {
    checkRateLimit(IPC_CHANNELS.X_GET_STATUS);
    const mentionTriggerStatus = getXMentionTriggerStatus();
    const installStatus = await checkBirdInstalled();
    if (!installStatus.installed) {
      return { installed: false, connected: false, mentionTriggerStatus };
    }

    const settings = XSettingsManager.loadSettings();
    if (!settings.enabled) {
      return { installed: true, connected: false, mentionTriggerStatus };
    }

    const result = await testXConnection(settings);
    return {
      installed: true,
      connected: result.success,
      username: result.username,
      error: result.success ? undefined : result.error,
      mentionTriggerStatus,
    };
  });

  // Notion Settings handlers
  ipcMain.handle(IPC_CHANNELS.NOTION_GET_SETTINGS, async () => {
    return NotionSettingsManager.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.NOTION_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.NOTION_SAVE_SETTINGS);
    const validated = validateInput(
      NotionSettingsSchema,
      settings,
      "notion settings",
    ) as NotionSettingsData;
    NotionSettingsManager.saveSettings(validated);
    NotionSettingsManager.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.NOTION_TEST_CONNECTION, async () => {
    checkRateLimit(IPC_CHANNELS.NOTION_TEST_CONNECTION);
    const settings = NotionSettingsManager.loadSettings();
    return testNotionConnection(settings);
  });

  ipcMain.handle(IPC_CHANNELS.NOTION_GET_STATUS, async () => {
    checkRateLimit(IPC_CHANNELS.NOTION_GET_STATUS);
    const settings = NotionSettingsManager.loadSettings();
    if (!settings.apiKey) {
      return { configured: false, connected: false };
    }
    if (!settings.enabled) {
      return { configured: true, connected: false };
    }
    const result = await testNotionConnection(settings);
    return {
      configured: true,
      connected: result.success,
      name: result.name,
      error: result.success ? undefined : result.error,
    };
  });

  // Box Settings handlers
  ipcMain.handle(IPC_CHANNELS.BOX_GET_SETTINGS, async () => {
    return BoxSettingsManager.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.BOX_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.BOX_SAVE_SETTINGS);
    const validated = validateInput(
      BoxSettingsSchema,
      settings,
      "box settings",
    ) as BoxSettingsData;
    BoxSettingsManager.saveSettings(validated);
    BoxSettingsManager.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.BOX_TEST_CONNECTION, async () => {
    checkRateLimit(IPC_CHANNELS.BOX_TEST_CONNECTION);
    const settings = BoxSettingsManager.loadSettings();
    return testBoxConnection(settings);
  });

  ipcMain.handle(IPC_CHANNELS.BOX_GET_STATUS, async () => {
    checkRateLimit(IPC_CHANNELS.BOX_GET_STATUS);
    const settings = BoxSettingsManager.loadSettings();
    if (!settings.accessToken) {
      return { configured: false, connected: false };
    }
    if (!settings.enabled) {
      return { configured: true, connected: false };
    }
    const result = await testBoxConnection(settings);
    return {
      configured: true,
      connected: result.success,
      name: result.name,
      error: result.success ? undefined : result.error,
    };
  });

  // OneDrive Settings handlers
  ipcMain.handle(IPC_CHANNELS.ONEDRIVE_GET_SETTINGS, async () => {
    return OneDriveSettingsManager.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.ONEDRIVE_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.ONEDRIVE_SAVE_SETTINGS);
    const validated = validateInput(
      OneDriveSettingsSchema,
      settings,
      "onedrive settings",
    ) as OneDriveSettingsData;
    OneDriveSettingsManager.saveSettings(validated);
    OneDriveSettingsManager.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.ONEDRIVE_TEST_CONNECTION, async () => {
    checkRateLimit(IPC_CHANNELS.ONEDRIVE_TEST_CONNECTION);
    const settings = OneDriveSettingsManager.loadSettings();
    return testOneDriveConnection(settings);
  });

  ipcMain.handle(IPC_CHANNELS.ONEDRIVE_GET_STATUS, async () => {
    checkRateLimit(IPC_CHANNELS.ONEDRIVE_GET_STATUS);
    const settings = OneDriveSettingsManager.loadSettings();
    if (!settings.accessToken) {
      return { configured: false, connected: false };
    }
    if (!settings.enabled) {
      return { configured: true, connected: false };
    }
    const result = await testOneDriveConnection(settings);
    return {
      configured: true,
      connected: result.success,
      name: result.name,
      error: result.success ? undefined : result.error,
    };
  });

  // Google Workspace Settings handlers
  ipcMain.handle(IPC_CHANNELS.GOOGLE_WORKSPACE_GET_SETTINGS, async () => {
    return GoogleWorkspaceSettingsManager.loadSettings();
  });

  ipcMain.handle(
    IPC_CHANNELS.GOOGLE_WORKSPACE_SAVE_SETTINGS,
    async (_, settings) => {
      checkRateLimit(IPC_CHANNELS.GOOGLE_WORKSPACE_SAVE_SETTINGS);
      const validated = validateInput(
        GoogleWorkspaceSettingsSchema,
        settings,
        "google workspace settings",
      ) as GoogleWorkspaceSettingsData;
      GoogleWorkspaceSettingsManager.saveSettings(validated);
      GoogleWorkspaceSettingsManager.clearCache();
      return { success: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS.GOOGLE_WORKSPACE_TEST_CONNECTION, async () => {
    checkRateLimit(IPC_CHANNELS.GOOGLE_WORKSPACE_TEST_CONNECTION);
    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    return testGoogleWorkspaceConnection(settings);
  });

  ipcMain.handle(IPC_CHANNELS.GOOGLE_WORKSPACE_GET_STATUS, async () => {
    checkRateLimit(IPC_CHANNELS.GOOGLE_WORKSPACE_GET_STATUS);
    const settings = GoogleWorkspaceSettingsManager.loadSettings();
    if (!settings.accessToken && !settings.refreshToken) {
      return { configured: false, connected: false };
    }
    if (!settings.enabled) {
      return { configured: true, connected: false };
    }
    const result = await testGoogleWorkspaceConnection(settings);
    return {
      configured: true,
      connected: result.success,
      name: result.name,
      error: result.success ? undefined : result.error,
    };
  });

  ipcMain.handle(
    IPC_CHANNELS.GOOGLE_WORKSPACE_OAUTH_START,
    async (_, payload) => {
      checkRateLimit(IPC_CHANNELS.GOOGLE_WORKSPACE_OAUTH_START);
      return startGoogleWorkspaceOAuth(payload);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.GOOGLE_WORKSPACE_OAUTH_GET_LINK,
    async (_, payload) => {
      checkRateLimit(IPC_CHANNELS.GOOGLE_WORKSPACE_OAUTH_GET_LINK);
      const url = await startGoogleWorkspaceOAuthGetLink(
        payload,
        async (result) => {
          // Tokens arrive in the background after the user completes auth in their browser.
          // Merge into existing settings so other fields (clientId, scopes, etc.) are preserved.
          const existing = await GoogleWorkspaceSettingsManager.loadSettings();
          const tokenExpiresAt = result.expiresIn
            ? Date.now() + result.expiresIn * 1000
            : existing.tokenExpiresAt;
          await GoogleWorkspaceSettingsManager.saveSettings({
            ...existing,
            enabled: true,
            accessToken: result.accessToken,
            refreshToken: result.refreshToken ?? existing.refreshToken,
            tokenExpiresAt,
            scopes: result.scopes ?? existing.scopes,
          });
        },
        (err) => {
          logger.error(
            "Google Workspace OAuth (copy-link) failed:",
            err.message,
          );
        },
      );
      return { url };
    },
  );

  // AgentMail Settings handlers
  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_GET_SETTINGS, async () => {
    return agentMailAdminService.getSettings();
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_SAVE_SETTINGS);
    const validated = validateInput(
      AgentMailSettingsSchema,
      settings,
      "agentmail settings",
    ) as AgentMailSettingsData;
    agentMailAdminService.saveSettings(validated);
    agentMailRealtimeService.refreshSubscriptions();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_TEST_CONNECTION, async () => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_TEST_CONNECTION);
    return agentMailAdminService.testConnection();
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_GET_STATUS, async () => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_GET_STATUS);
    return agentMailAdminService.getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_LIST_PODS, async () => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_LIST_PODS);
    return agentMailAdminService.listPods();
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_GET_WORKSPACE_BINDING, async (_, workspaceId) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_GET_WORKSPACE_BINDING);
    const validatedWorkspaceId = validateInput(
      WorkspaceIdSchema,
      workspaceId,
      "agentmail workspaceId",
    ) as string;
    return agentMailAdminService.getWorkspaceBinding(validatedWorkspaceId);
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_BIND_WORKSPACE_POD, async (_, payload) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_BIND_WORKSPACE_POD);
    const validated = validateInput(
      z.object({
        workspaceId: WorkspaceIdSchema,
        podId: StringIdSchema,
      }),
      payload,
      "agentmail bind workspace pod",
    ) as { workspaceId: string; podId: string };
    const result = await agentMailAdminService.bindWorkspacePod(validated.workspaceId, validated.podId);
    agentMailRealtimeService.refreshSubscriptions();
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_CREATE_WORKSPACE_POD, async (_, payload) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_CREATE_WORKSPACE_POD);
    const validated = validateInput(
      z.object({
        workspaceId: WorkspaceIdSchema,
        podName: z.string().max(200).optional(),
      }),
      payload,
      "agentmail create workspace pod",
    ) as { workspaceId: string; podName?: string };
    const result = await agentMailAdminService.createWorkspacePod(validated.workspaceId, validated.podName);
    agentMailRealtimeService.refreshSubscriptions();
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_LIST_INBOXES, async (_, workspaceId) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_LIST_INBOXES);
    const validatedWorkspaceId = validateInput(
      WorkspaceIdSchema,
      workspaceId,
      "agentmail list inboxes workspaceId",
    ) as string;
    return agentMailAdminService.listInboxes(validatedWorkspaceId);
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_CREATE_INBOX, async (_, payload) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_CREATE_INBOX);
    const validated = validateInput(
      z.object({
        workspaceId: WorkspaceIdSchema,
        username: z.string().max(200).optional(),
        domain: z.string().max(255).optional(),
        displayName: z.string().max(255).optional(),
        clientId: z.string().max(255).optional(),
      }),
      payload,
      "agentmail create inbox",
    ) as {
      workspaceId: string;
      username?: string;
      domain?: string;
      displayName?: string;
      clientId?: string;
    };
    const result = await agentMailAdminService.createInbox(validated.workspaceId, validated);
    agentMailRealtimeService.refreshSubscriptions();
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_UPDATE_INBOX, async (_, payload) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_UPDATE_INBOX);
    const validated = validateInput(
      z.object({
        workspaceId: WorkspaceIdSchema,
        inboxId: z.string().max(255),
        displayName: z.string().max(255),
      }),
      payload,
      "agentmail update inbox",
    ) as { workspaceId: string; inboxId: string; displayName: string };
    return agentMailAdminService.updateInbox(validated.workspaceId, validated.inboxId, {
      displayName: validated.displayName,
    });
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_DELETE_INBOX, async (_, payload) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_DELETE_INBOX);
    const validated = validateInput(
      z.object({
        workspaceId: WorkspaceIdSchema,
        inboxId: z.string().max(255),
      }),
      payload,
      "agentmail delete inbox",
    ) as { workspaceId: string; inboxId: string };
    const result = await agentMailAdminService.deleteInbox(validated.workspaceId, validated.inboxId);
    agentMailRealtimeService.refreshSubscriptions();
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_LIST_DOMAINS, async (_, workspaceId) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_LIST_DOMAINS);
    const validatedWorkspaceId = validateInput(
      WorkspaceIdSchema,
      workspaceId,
      "agentmail list domains workspaceId",
    ) as string;
    return agentMailAdminService.listDomains(validatedWorkspaceId);
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_CREATE_DOMAIN, async (_, payload) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_CREATE_DOMAIN);
    const validated = validateInput(
      z.object({
        workspaceId: WorkspaceIdSchema,
        domain: z.string().max(255),
        feedbackEnabled: z.boolean().optional(),
      }),
      payload,
      "agentmail create domain",
    ) as { workspaceId: string; domain: string; feedbackEnabled?: boolean };
    return agentMailAdminService.createDomain(validated.workspaceId, validated);
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_VERIFY_DOMAIN, async (_, payload) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_VERIFY_DOMAIN);
    const validated = validateInput(
      z.object({
        workspaceId: WorkspaceIdSchema,
        domainId: z.string().max(255),
      }),
      payload,
      "agentmail verify domain",
    ) as { workspaceId: string; domainId: string };
    return agentMailAdminService.verifyDomain(validated.workspaceId, validated.domainId);
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_DELETE_DOMAIN, async (_, payload) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_DELETE_DOMAIN);
    const validated = validateInput(
      z.object({
        workspaceId: WorkspaceIdSchema,
        domainId: z.string().max(255),
      }),
      payload,
      "agentmail delete domain",
    ) as { workspaceId: string; domainId: string };
    return agentMailAdminService.deleteDomain(validated.workspaceId, validated.domainId);
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_LIST_LIST_ENTRIES, async (_, payload) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_LIST_LIST_ENTRIES);
    const validated = validateInput(
      z.object({
        workspaceId: WorkspaceIdSchema,
        inboxId: z.string().max(255).optional(),
        direction: z.enum(["receive", "reply", "send"]).optional(),
        listType: z.enum(["allow", "block"]).optional(),
      }),
      payload,
      "agentmail list entries",
    ) as {
      workspaceId: string;
      inboxId?: string;
      direction?: AgentMailListEntry["direction"];
      listType?: AgentMailListEntry["listType"];
    };
    return agentMailAdminService.listListEntries(validated.workspaceId, validated);
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_CREATE_LIST_ENTRY, async (_, payload) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_CREATE_LIST_ENTRY);
    const validated = validateInput(
      z.object({
        workspaceId: WorkspaceIdSchema,
        inboxId: z.string().max(255).optional(),
        direction: z.enum(["receive", "reply", "send"]),
        listType: z.enum(["allow", "block"]),
        entry: z.string().max(255),
        reason: z.string().max(500).optional(),
      }),
      payload,
      "agentmail create list entry",
    ) as {
      workspaceId: string;
      inboxId?: string;
      direction: AgentMailListEntry["direction"];
      listType: AgentMailListEntry["listType"];
      entry: string;
      reason?: string;
    };
    return agentMailAdminService.createListEntry(validated.workspaceId, validated);
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_DELETE_LIST_ENTRY, async (_, payload) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_DELETE_LIST_ENTRY);
    const validated = validateInput(
      z.object({
        workspaceId: WorkspaceIdSchema,
        inboxId: z.string().max(255).optional(),
        direction: z.enum(["receive", "reply", "send"]),
        listType: z.enum(["allow", "block"]),
        entry: z.string().max(255),
      }),
      payload,
      "agentmail delete list entry",
    ) as {
      workspaceId: string;
      inboxId?: string;
      direction: AgentMailListEntry["direction"];
      listType: AgentMailListEntry["listType"];
      entry: string;
    };
    return agentMailAdminService.deleteListEntry(validated.workspaceId, validated);
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_LIST_INBOX_API_KEYS, async (_, payload) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_LIST_INBOX_API_KEYS);
    const validated = validateInput(
      z.object({
        workspaceId: WorkspaceIdSchema,
        inboxId: z.string().max(255),
      }),
      payload,
      "agentmail list inbox api keys",
    ) as { workspaceId: string; inboxId: string };
    return agentMailAdminService.listInboxApiKeys(validated.workspaceId, validated.inboxId);
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_CREATE_INBOX_API_KEY, async (_, payload) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_CREATE_INBOX_API_KEY);
    const validated = validateInput(
      z.object({
        workspaceId: WorkspaceIdSchema,
        inboxId: z.string().max(255),
        name: z.string().max(255).optional(),
        permissions: z.record(z.string(), z.boolean()).optional(),
      }),
      payload,
      "agentmail create inbox api key",
    ) as {
      workspaceId: string;
      inboxId: string;
      name?: string;
      permissions?: Record<string, boolean>;
    };
    return agentMailAdminService.createInboxApiKey(validated.workspaceId, validated.inboxId, validated);
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_DELETE_INBOX_API_KEY, async (_, payload) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_DELETE_INBOX_API_KEY);
    const validated = validateInput(
      z.object({
        workspaceId: WorkspaceIdSchema,
        inboxId: z.string().max(255),
        apiKeyId: z.string().max(255),
      }),
      payload,
      "agentmail delete inbox api key",
    ) as { workspaceId: string; inboxId: string; apiKeyId: string };
    return agentMailAdminService.deleteInboxApiKey(
      validated.workspaceId,
      validated.inboxId,
      validated.apiKeyId,
    );
  });

  ipcMain.handle(IPC_CHANNELS.AGENTMAIL_REFRESH_WORKSPACE, async (_, workspaceId) => {
    checkRateLimit(IPC_CHANNELS.AGENTMAIL_REFRESH_WORKSPACE);
    const validatedWorkspaceId = validateInput(
      WorkspaceIdSchema,
      workspaceId,
      "agentmail refresh workspaceId",
    ) as string;
    const result = await agentMailAdminService.refreshWorkspace(validatedWorkspaceId);
    agentMailRealtimeService.refreshSubscriptions();
    return result;
  });

  // Dropbox Settings handlers
  ipcMain.handle(IPC_CHANNELS.DROPBOX_GET_SETTINGS, async () => {
    return DropboxSettingsManager.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.DROPBOX_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.DROPBOX_SAVE_SETTINGS);
    const validated = validateInput(
      DropboxSettingsSchema,
      settings,
      "dropbox settings",
    ) as DropboxSettingsData;
    DropboxSettingsManager.saveSettings(validated);
    DropboxSettingsManager.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.DROPBOX_TEST_CONNECTION, async () => {
    checkRateLimit(IPC_CHANNELS.DROPBOX_TEST_CONNECTION);
    const settings = DropboxSettingsManager.loadSettings();
    return testDropboxConnection(settings);
  });

  ipcMain.handle(IPC_CHANNELS.DROPBOX_GET_STATUS, async () => {
    checkRateLimit(IPC_CHANNELS.DROPBOX_GET_STATUS);
    const settings = DropboxSettingsManager.loadSettings();
    if (!settings.accessToken) {
      return { configured: false, connected: false };
    }
    if (!settings.enabled) {
      return { configured: true, connected: false };
    }
    const result = await testDropboxConnection(settings);
    return {
      configured: true,
      connected: result.success,
      name: result.name,
      error: result.success ? undefined : result.error,
    };
  });

  // SharePoint Settings handlers
  ipcMain.handle(IPC_CHANNELS.SHAREPOINT_GET_SETTINGS, async () => {
    return SharePointSettingsManager.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.SHAREPOINT_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.SHAREPOINT_SAVE_SETTINGS);
    const validated = validateInput(
      SharePointSettingsSchema,
      settings,
      "sharepoint settings",
    ) as SharePointSettingsData;
    SharePointSettingsManager.saveSettings(validated);
    SharePointSettingsManager.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.SHAREPOINT_TEST_CONNECTION, async () => {
    checkRateLimit(IPC_CHANNELS.SHAREPOINT_TEST_CONNECTION);
    const settings = SharePointSettingsManager.loadSettings();
    return testSharePointConnection(settings);
  });

  ipcMain.handle(IPC_CHANNELS.SHAREPOINT_GET_STATUS, async () => {
    checkRateLimit(IPC_CHANNELS.SHAREPOINT_GET_STATUS);
    const settings = SharePointSettingsManager.loadSettings();
    if (!settings.accessToken) {
      return { configured: false, connected: false };
    }
    if (!settings.enabled) {
      return { configured: true, connected: false };
    }
    const result = await testSharePointConnection(settings);
    return {
      configured: true,
      connected: result.success,
      name: result.name,
      error: result.success ? undefined : result.error,
    };
  });

  // Gateway / Channel handlers
  ipcMain.handle(IPC_CHANNELS.GATEWAY_GET_CHANNELS, async () => {
    if (!gateway) return [];
    return gateway.getChannels().map((ch) => toPublicChannel(ch));
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_ADD_CHANNEL, async (_, data) => {
    checkRateLimit(IPC_CHANNELS.GATEWAY_ADD_CHANNEL);
    if (!gateway) throw new Error("Gateway not initialized");

    // Cast through AddChannelRequest — Zod v4 discriminatedUnion doesn't
    // narrow member types, but the schema already validates the shape.
    const validated = validateInput(
      AddChannelSchema,
      data,
      "channel",
    ) as unknown as AddChannelRequest;

    if (validated.type === "telegram") {
      const channel = await gateway.addTelegramChannel(
        validated.name,
        validated.botToken!,
        {
          groupRoutingMode: validated.groupRoutingMode,
          allowedGroupChatIds: validated.telegramAllowedGroupChatIds,
        },
        validated.securityMode || "pairing",
      );
      return toPublicChannel(channel);
    }

    if (validated.type === "discord") {
      const channel = await gateway.addDiscordChannel(
        validated.name,
        validated.botToken!,
        validated.applicationId!,
        validated.guildIds,
        validated.discordSupervisor
          ? {
              enabled: validated.discordSupervisor.enabled === true,
              coordinationChannelId:
                validated.discordSupervisor.coordinationChannelId,
              watchedChannelIds: validated.discordSupervisor.watchedChannelIds,
              workerAgentRoleId: validated.discordSupervisor.workerAgentRoleId,
              supervisorAgentRoleId:
                validated.discordSupervisor.supervisorAgentRoleId,
              humanEscalationChannelId:
                validated.discordSupervisor.humanEscalationChannelId,
              humanEscalationUserId:
                validated.discordSupervisor.humanEscalationUserId,
              peerBotUserIds: validated.discordSupervisor.peerBotUserIds,
              strictMode: validated.discordSupervisor.strictMode !== false,
            }
          : undefined,
        validated.securityMode || "pairing",
      );
      return toPublicChannel(channel);
    }

    if (validated.type === "slack") {
      const channel = await gateway.addSlackChannel(
        validated.name,
        validated.botToken!,
        validated.appToken!,
        validated.signingSecret,
        validated.progressRelayMode,
        validated.securityMode || "pairing",
      );
      return toPublicChannel(channel);
    }

    if (validated.type === "whatsapp") {
      const channel = await gateway.addWhatsAppChannel(
        validated.name,
        validated.allowedNumbers,
        validated.securityMode || "pairing",
        validated.selfChatMode ?? true,
        validated.responsePrefix ?? "🤖",
        {
          ambientMode: validated.ambientMode ?? false,
          silentUnauthorized: validated.silentUnauthorized ?? false,
          ingestNonSelfChatsInSelfChatMode:
            validated.ingestNonSelfChatsInSelfChatMode ?? false,
          trustedGroupMemoryOptIn: validated.trustedGroupMemoryOptIn ?? false,
          sendReadReceipts: validated.sendReadReceipts,
          deduplicationEnabled: validated.deduplicationEnabled,
          groupRoutingMode: validated.groupRoutingMode,
        },
      );

      // Automatically enable and connect WhatsApp to start QR code generation
      // This is done asynchronously to not block the response
      gateway.enableWhatsAppWithQRForwarding(channel.id).catch((err) => {
        logger.error("Failed to enable WhatsApp channel:", err);
      });

      return toPublicChannel(channel, "connecting");
    }

    if (validated.type === "imessage") {
      const channel = await gateway.addImessageChannel(
        validated.name,
        validated.cliPath,
        validated.dbPath,
        validated.allowedContacts,
        validated.securityMode || "pairing",
        validated.dmPolicy || "pairing",
        validated.groupPolicy || "allowlist",
        {
          ambientMode: validated.ambientMode ?? false,
          silentUnauthorized: validated.silentUnauthorized ?? false,
          captureSelfMessages: validated.captureSelfMessages ?? false,
        },
      );

      // Automatically enable and connect iMessage
      gateway.enableChannel(channel.id).catch((err) => {
        logger.error("Failed to enable iMessage channel:", err);
      });

      return toPublicChannel(channel, "connecting");
    }

    if (validated.type === "signal") {
      const channel = await gateway.addSignalChannel(
        validated.name,
        validated.phoneNumber!,
        validated.dataDir,
        validated.securityMode || "pairing",
        (validated.mode || "native") as "native" | "daemon",
        (validated.trustMode || "tofu") as "tofu" | "always" | "manual",
        validated.dmPolicy || "pairing",
        validated.groupPolicy || "allowlist",
        validated.allowedNumbers,
        validated.sendReadReceipts ?? true,
        validated.sendTypingIndicators ?? true,
      );

      // Automatically enable and connect Signal
      gateway.enableChannel(channel.id).catch((err) => {
        logger.error("Failed to enable Signal channel:", err);
      });

      return toPublicChannel(channel, "connecting");
    }

    if (validated.type === "mattermost") {
      const channel = await gateway.addMattermostChannel(
        validated.name,
        validated.mattermostServerUrl!,
        validated.mattermostToken!,
        validated.mattermostTeamId,
        validated.securityMode || "pairing",
      );

      // Automatically enable and connect Mattermost
      gateway.enableChannel(channel.id).catch((err) => {
        logger.error("Failed to enable Mattermost channel:", err);
      });

      return toPublicChannel(channel, "connecting");
    }

    if (validated.type === "matrix") {
      const channel = await gateway.addMatrixChannel(
        validated.name,
        validated.matrixHomeserver!,
        validated.matrixUserId!,
        validated.matrixAccessToken!,
        validated.matrixDeviceId,
        validated.matrixRoomIds,
        validated.securityMode || "pairing",
      );

      // Automatically enable and connect Matrix
      gateway.enableChannel(channel.id).catch((err) => {
        logger.error("Failed to enable Matrix channel:", err);
      });

      return toPublicChannel(channel, "connecting");
    }

    if (validated.type === "twitch") {
      const channel = await gateway.addTwitchChannel(
        validated.name,
        validated.twitchUsername!,
        validated.twitchOauthToken!,
        validated.twitchChannels || [],
        validated.twitchAllowWhispers ?? false,
        validated.securityMode || "pairing",
      );

      // Automatically enable and connect Twitch
      gateway.enableChannel(channel.id).catch((err) => {
        logger.error("Failed to enable Twitch channel:", err);
      });

      return toPublicChannel(channel, "connecting");
    }

    if (validated.type === "line") {
      const channel = await gateway.addLineChannel(
        validated.name,
        validated.lineChannelAccessToken!,
        validated.lineChannelSecret!,
        validated.lineWebhookPort ?? 3100,
        validated.securityMode || "pairing",
      );

      // Automatically enable and connect LINE
      gateway.enableChannel(channel.id).catch((err) => {
        logger.error("Failed to enable LINE channel:", err);
      });

      return toPublicChannel(channel, "connecting");
    }

    if (validated.type === "bluebubbles") {
      const channel = await gateway.addBlueBubblesChannel(
        validated.name,
        validated.blueBubblesServerUrl!,
        validated.blueBubblesPassword!,
        validated.blueBubblesWebhookPort ?? 3101,
        validated.blueBubblesAllowedContacts,
        validated.securityMode || "pairing",
        {
          ambientMode: validated.ambientMode ?? false,
          silentUnauthorized: validated.silentUnauthorized ?? false,
          captureSelfMessages: validated.captureSelfMessages ?? false,
        },
      );

      // Automatically enable and connect BlueBubbles
      gateway.enableChannel(channel.id).catch((err) => {
        logger.error("Failed to enable BlueBubbles channel:", err);
      });

      return toPublicChannel(channel, "connecting");
    }

    if (validated.type === "feishu") {
      const channel = await gateway.addFeishuChannel(
        validated.name,
        validated.feishuAppId!,
        validated.feishuAppSecret!,
        validated.feishuVerificationToken,
        validated.feishuEncryptKey,
        validated.webhookPort ?? 3980,
        validated.webhookPath || "/feishu/webhook",
        validated.securityMode || "pairing",
      );

      gateway.enableChannel(channel.id).catch((err) => {
        logger.error("Failed to enable Feishu channel:", err);
      });

      return toPublicChannel(channel, "connecting");
    }

    if (validated.type === "wecom") {
      const channel = await gateway.addWeComChannel(
        validated.name,
        validated.wecomCorpId!,
        validated.wecomAgentId!,
        validated.wecomSecret!,
        validated.wecomToken!,
        validated.wecomEncodingAESKey,
        validated.webhookPort ?? 3981,
        validated.webhookPath || "/wecom/webhook",
        validated.securityMode || "pairing",
      );

      gateway.enableChannel(channel.id).catch((err) => {
        logger.error("Failed to enable WeCom channel:", err);
      });

      return toPublicChannel(channel, "connecting");
    }

    if (validated.type === "x") {
      const channel = await gateway.addXChannel(
        validated.name,
        {
          commandPrefix: validated.xCommandPrefix,
          allowedAuthors: validated.xAllowedAuthors,
          pollIntervalSec: validated.xPollIntervalSec,
          fetchCount: validated.xFetchCount,
          outboundEnabled: validated.xOutboundEnabled ?? false,
        },
        validated.securityMode || "pairing",
      );

      gateway.enableChannel(channel.id).catch((err) => {
        logger.error("Failed to enable X channel:", err);
      });

      return toPublicChannel(channel, "connecting");
    }

    if (validated.type === "email") {
      const emailProtocol = validated.emailProtocol || "imap-smtp";
      const channel = await gateway.addEmailChannel(
        validated.name,
        validated.emailAddress,
        validated.emailPassword,
        validated.emailImapHost,
        validated.emailSmtpHost,
        validated.emailDisplayName,
        validated.emailAllowedSenders,
        validated.emailSubjectFilter,
        validated.securityMode || "pairing",
        {
          protocol: emailProtocol,
          authMethod: validated.emailAuthMethod,
          oauthProvider: validated.emailOauthProvider,
          oauthClientId: validated.emailOauthClientId,
          oauthClientSecret: validated.emailOauthClientSecret,
          oauthTenant: validated.emailOauthTenant,
          accessToken: validated.emailAccessToken,
          refreshToken: validated.emailRefreshToken,
          tokenExpiresAt: validated.emailTokenExpiresAt,
          scopes: validated.emailScopes,
          imapPort: validated.emailImapPort,
          smtpPort: validated.emailSmtpPort,
          loomBaseUrl: validated.emailLoomBaseUrl,
          loomAccessToken: validated.emailLoomAccessToken,
          loomIdentity: validated.emailLoomIdentity,
          loomMailboxFolder: validated.emailLoomMailboxFolder,
          loomPollInterval: validated.emailLoomPollInterval,
        },
      );

      // Automatically enable and connect Email
      gateway.enableChannel(channel.id).catch((err) => {
        logger.error("Failed to enable Email channel:", err);
      });

      return toPublicChannel(channel, "connecting");
    }

    // TypeScript exhaustiveness check - should never reach here due to discriminated union
    throw new Error(`Unsupported channel type`);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_UPDATE_CHANNEL, async (_, data) => {
    if (!gateway) throw new Error("Gateway not initialized");

    const validated = validateInput(
      UpdateChannelSchema,
      data,
      "channel update",
    );
    const channel = gateway.getChannel(validated.id);
    if (!channel) throw new Error("Channel not found");

    const updates: Record<string, unknown> = {};
    if (validated.name !== undefined) updates.name = validated.name;
    if (validated.securityMode !== undefined) {
      updates.securityConfig = {
        ...channel.securityConfig,
        mode: validated.securityMode,
      };
    }
    if (validated.config !== undefined) {
      const mergedConfig = { ...channel.config, ...validated.config };
      if (
        validated.config &&
        typeof validated.config === "object" &&
        "supervisor" in validated.config
      ) {
        const nextSupervisor = validated.config.supervisor;
        mergedConfig.supervisor =
          nextSupervisor && typeof nextSupervisor === "object"
            ? {
                ...((channel.config?.supervisor as
                  | Record<string, unknown>
                  | undefined) || {}),
                ...nextSupervisor,
              }
            : nextSupervisor;
      }

      if (channel.type === "email") {
        updates.config = validateInput(
          EmailChannelConfigSchema,
          mergedConfig,
          "email channel update",
        );
      } else {
        updates.config = mergedConfig;
      }
    }

    gateway.updateChannel(validated.id, updates);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_REMOVE_CHANNEL, async (_, id: string) => {
    if (!gateway) throw new Error("Gateway not initialized");
    await gateway.removeChannel(id);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_ENABLE_CHANNEL, async (_, id: string) => {
    if (!gateway) throw new Error("Gateway not initialized");
    await gateway.enableChannel(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.GATEWAY_DISABLE_CHANNEL,
    async (_, id: string) => {
      if (!gateway) throw new Error("Gateway not initialized");
      await gateway.disableChannel(id);
    },
  );

  ipcMain.handle(IPC_CHANNELS.GATEWAY_TEST_CHANNEL, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.GATEWAY_TEST_CHANNEL);
    if (!gateway) return { success: false, error: "Gateway not initialized" };
    return gateway.testChannel(id);
  });

  ipcMain.handle(
    IPC_CHANNELS.GATEWAY_GET_USERS,
    async (_, channelId: string) => {
      if (!gateway) return [];
      return gateway.getChannelUsers(channelId).map((u) => ({
        id: u.id,
        channelId: u.channelId,
        channelUserId: u.channelUserId,
        displayName: u.displayName,
        username: u.username,
        allowed: u.allowed,
        lastSeenAt: u.lastSeenAt,
      }));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.GATEWAY_LIST_CHATS,
    async (_, channelId: string) => {
      if (!gateway) return [];
      return gateway.getDistinctChatIds(channelId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.GATEWAY_SEND_TEST_MESSAGE,
    async (
      _,
      data: { channelType: string; channelDbId?: string; chatId: string },
    ) => {
      if (!gateway) throw new Error("Gateway not initialized");
      // Resolve channel type from DB ID if provided
      let resolvedType = data.channelType;
      if (data.channelDbId) {
        const ch = gateway.getChannel(data.channelDbId);
        if (ch) resolvedType = ch.type;
      }
      await gateway.sendMessage(
        resolvedType as Any,
        data.chatId,
        "Test delivery from CoWork OS",
        {
          channelDbId: data.channelDbId,
          parseMode: "text",
        },
      );
      return { ok: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS.GATEWAY_GRANT_ACCESS, async (_, data) => {
    if (!gateway) throw new Error("Gateway not initialized");
    const validated = validateInput(GrantAccessSchema, data, "grant access");
    gateway.grantUserAccess(
      validated.channelId,
      validated.userId,
      validated.displayName,
    );
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_REVOKE_ACCESS, async (_, data) => {
    if (!gateway) throw new Error("Gateway not initialized");
    const validated = validateInput(RevokeAccessSchema, data, "revoke access");
    gateway.revokeUserAccess(validated.channelId, validated.userId);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_GENERATE_PAIRING, async (_, data) => {
    if (!gateway) throw new Error("Gateway not initialized");
    const validated = validateInput(
      GeneratePairingSchema,
      data,
      "generate pairing",
    );
    return gateway.generatePairingCode(
      validated.channelId,
      validated.userId,
      validated.displayName,
    );
  });

  // WhatsApp-specific handlers
  ipcMain.handle(IPC_CHANNELS.WHATSAPP_GET_INFO, async () => {
    if (!gateway) return {};
    return gateway.getWhatsAppInfo();
  });

  ipcMain.handle(IPC_CHANNELS.WHATSAPP_LOGOUT, async () => {
    if (!gateway) throw new Error("Gateway not initialized");
    await gateway.whatsAppLogout();
  });

  // App Update handlers
  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, async () => {
    return updateManager.getVersionInfo();
  });

  ipcMain.handle(IPC_CHANNELS.APP_CHECK_UPDATES, async () => {
    return updateManager.checkForUpdates();
  });

  ipcMain.handle(
    IPC_CHANNELS.APP_DOWNLOAD_UPDATE,
    async (_, updateInfo: UpdateInfo) => {
      await updateManager.downloadAndInstallUpdate(updateInfo);
      return { success: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS.APP_INSTALL_UPDATE, async () => {
    await updateManager.installUpdateAndRestart();
    return { success: true };
  });

  // Guardrail Settings handlers
  ipcMain.handle(IPC_CHANNELS.GUARDRAIL_GET_SETTINGS, async () => {
    return GuardrailManager.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.GUARDRAIL_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.GUARDRAIL_SAVE_SETTINGS);
    const validated = validateInput(
      GuardrailSettingsSchema,
      settings,
      "guardrail settings",
    );
    GuardrailManager.saveSettings(validated);
    GuardrailManager.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.GUARDRAIL_GET_DEFAULTS, async () => {
    return GuardrailManager.getDefaults();
  });

  ipcMain.handle(IPC_CHANNELS.PERMISSIONS_GET_SETTINGS, async () => {
    return PermissionSettingsManager.loadSettings();
  });

  ipcMain.handle(
    IPC_CHANNELS.PERMISSIONS_SAVE_SETTINGS,
    async (_, settings) => {
      checkRateLimit(IPC_CHANNELS.PERMISSIONS_SAVE_SETTINGS);
      const validated = validateInput(
        PermissionSettingsSchema,
        settings,
        "permission settings",
      );
      PermissionSettingsManager.saveSettings(validated);
      PermissionSettingsManager.clearCache();
      return { success: true };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSIONS_GET_WORKSPACE_RULES,
    async (_, workspaceId: string) => {
      const validatedWorkspaceId = validateInput(
        WorkspaceIdSchema,
        workspaceId,
        "workspace ID",
      );
      return workspacePermissionRuleRepo.listByWorkspaceId(
        validatedWorkspaceId,
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PERMISSIONS_DELETE_WORKSPACE_RULE,
    async (_, payload: { workspaceId: string; ruleId: string }) => {
      const validatedWorkspaceId = validateInput(
        WorkspaceIdSchema,
        payload.workspaceId,
        "workspace ID",
      );
      const validatedRuleId = validateInput(
        z.string().uuid(),
        payload.ruleId,
        "workspace permission rule ID",
      );
      const deleted = workspacePermissionRuleRepo.deleteByWorkspaceAndId(
        validatedWorkspaceId,
        validatedRuleId,
      );
      if (!deleted) {
        return { success: false, removed: false };
      }
      const workspace = workspaceRepo.findById(validatedWorkspaceId);
      const manifestResult = workspace
        ? removeWorkspacePermissionManifestRule(workspace.path, deleted)
        : { success: true, manifestPath: "", removed: false };
      agentDaemon.refreshActiveExecutorsForWorkspace(validatedWorkspaceId);
      return {
        success: true,
        removed: true,
        dbRemoved: true,
        manifestRemoved: manifestResult.removed,
        manifestPath: manifestResult.manifestPath,
        manifestError: manifestResult.success
          ? undefined
          : manifestResult.error,
      };
    },
  );

  // Appearance Settings handlers
  ipcMain.handle(IPC_CHANNELS.APPEARANCE_GET_SETTINGS, async () => {
    return AppearanceManager.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.APPEARANCE_GET_RUNTIME_INFO, async () => {
    return {
      prefersReducedTransparency: nativeTheme.prefersReducedTransparency,
      devLogCaptureEnabled: getDevLogCaptureEnabled(),
    };
  });

  ipcMain.handle(IPC_CHANNELS.APPEARANCE_SAVE_SETTINGS, async (_, settings) => {
    AppearanceManager.saveSettings(settings);
    return { success: true };
  });

  // Personality Settings handlers
  // Subscribe to PersonalityManager events to broadcast changes to UI
  // This handles both IPC changes and tool-based changes
  PersonalityManager.onSettingsChanged((settings) => {
    broadcastPersonalitySettingsChanged(settings);
  });

  ipcMain.handle(IPC_CHANNELS.PERSONALITY_GET_SETTINGS, async () => {
    return PersonalityManager.loadSettings();
  });

  ipcMain.handle(
    IPC_CHANNELS.PERSONALITY_SAVE_SETTINGS,
    async (_, settings) => {
      PersonalityManager.saveSettings(settings);
      // Event emission is handled by PersonalityManager.saveSettings()
      return { success: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS.PERSONALITY_GET_DEFINITIONS, async () => {
    return PersonalityManager.getDefinitions();
  });

  ipcMain.handle(IPC_CHANNELS.PERSONALITY_GET_PERSONAS, async () => {
    return PersonalityManager.getPersonaDefinitions();
  });

  ipcMain.handle(IPC_CHANNELS.PERSONALITY_GET_RELATIONSHIP_STATS, async () => {
    return PersonalityManager.getRelationshipStats();
  });

  ipcMain.handle(
    IPC_CHANNELS.PERSONALITY_SET_ACTIVE,
    async (_, personalityId) => {
      PersonalityManager.setActivePersonality(personalityId);
      // Event emission is handled by PersonalityManager.saveSettings()
      return { success: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS.PERSONALITY_SET_PERSONA, async (_, personaId) => {
    PersonalityManager.setActivePersona(personaId);
    // Event emission is handled by PersonalityManager.saveSettings()
    return { success: true };
  });

  ipcMain.handle(
    IPC_CHANNELS.PERSONALITY_RESET,
    async (_, preserveRelationship?: boolean) => {
      checkRateLimit(IPC_CHANNELS.PERSONALITY_RESET);
      PersonalityManager.resetToDefaults(preserveRelationship);
      // Event emission is handled by PersonalityManager.resetToDefaults()
      return { success: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS.PERSONALITY_GET_CONFIG_V2, async () => {
    return PersonalityManager.loadConfigV2();
  });

  ipcMain.handle(
    IPC_CHANNELS.PERSONALITY_SAVE_CONFIG_V2,
    async (_, config: unknown) => {
      const validated = validateInput(
        PersonalityConfigV2Schema,
        config,
        "personality config",
      );
      const toSave = {
        ...validated,
        version: 2,
      } as import("../../shared/types").PersonalityConfigV2;
      PersonalityManager.saveConfigV2(toSave);
      return { success: true };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.PERSONALITY_EXPORT,
    async (_, format?: "json" | "md") => {
      return PersonalityManager.exportProfile(format ?? "json");
    },
  );

  ipcMain.handle(IPC_CHANNELS.PERSONALITY_IMPORT, async (_, data: unknown) => {
    const validated = validateInput(
      PersonalityImportSchema,
      data,
      "personality import",
    );
    return PersonalityManager.importProfile(validated);
  });

  ipcMain.handle(
    IPC_CHANNELS.PERSONALITY_PREVIEW,
    async (_, draft: unknown, contextMode?: string) => {
      if (contextMode !== undefined) {
        validateInput(ContextModeSchema, contextMode, "context mode");
      }
      if (draft != null && typeof draft === "object") {
        const size = JSON.stringify(draft).length;
        if (size > MAX_PERSONALITY_PREVIEW_BYTES) {
          throw new Error(
            `Personality preview draft exceeds max size (${MAX_PERSONALITY_PREVIEW_BYTES / 1024}KB)`,
          );
        }
      }
      return PersonalityManager.getPreviewPrompt(
        draft as Partial<import("../../shared/types").PersonalityConfigV2>,
        contextMode as import("../../shared/types").ContextMode,
      );
    },
  );

  ipcMain.handle(IPC_CHANNELS.PERSONALITY_GET_TRAIT_PRESETS, async () => {
    return PersonalityManager.getTraitPresets();
  });

  // Agent Role / Squad handlers
  ipcMain.handle(
    IPC_CHANNELS.AGENT_ROLE_LIST,
    async (_, includeInactive?: boolean) => {
      return agentRoleRepo.findAll(includeInactive ?? false);
    },
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_ROLE_GET, async (_, id: string) => {
    const validated = validateInput(UUIDSchema, id, "agent role ID");
    return agentRoleRepo.findById(validated);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_ROLE_CREATE, async (_, request) => {
    checkRateLimit(IPC_CHANNELS.AGENT_ROLE_CREATE);
    // Validate name format (lowercase, alphanumeric, hyphens)
    if (!/^[a-z0-9-]+$/.test(request.name)) {
      throw new Error(
        "Agent role name must be lowercase alphanumeric with hyphens only",
      );
    }
    // Check for duplicate name
    if (agentRoleRepo.findByName(request.name)) {
      throw new Error(`Agent role with name "${request.name}" already exists`);
    }
    if (request.companyId !== undefined && request.companyId !== null) {
      request.companyId = validateInput(
        UUIDSchema,
        request.companyId,
        "company ID",
      );
    }
    return agentRoleRepo.create(request);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_ROLE_UPDATE, async (_, request) => {
    checkRateLimit(IPC_CHANNELS.AGENT_ROLE_UPDATE);
    const validated = validateInput(UUIDSchema, request.id, "agent role ID");
    const normalizedRequest = { ...request, id: validated };
    if (
      normalizedRequest.companyId !== undefined &&
      normalizedRequest.companyId !== null
    ) {
      normalizedRequest.companyId = validateInput(
        UUIDSchema,
        normalizedRequest.companyId,
        "company ID",
      );
    }
    const result = agentRoleRepo.update(normalizedRequest);
    if (!result) {
      throw new Error("Agent role not found");
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_ROLE_DELETE, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.AGENT_ROLE_DELETE);
    const validated = validateInput(UUIDSchema, id, "agent role ID");
    const success = agentRoleRepo.delete(validated);
    if (!success) {
      throw new Error("Agent role not found or cannot be deleted");
    }
    return { success: true };
  });

  ipcMain.handle(
    IPC_CHANNELS.AGENT_ROLE_ASSIGN_TO_TASK,
    async (_, taskId: string, agentRoleId: string | null) => {
      checkRateLimit(IPC_CHANNELS.AGENT_ROLE_ASSIGN_TO_TASK);
      const validatedTaskId = validateInput(UUIDSchema, taskId, "task ID");
      if (agentRoleId !== null) {
        const validatedRoleId = validateInput(
          UUIDSchema,
          agentRoleId,
          "agent role ID",
        );
        const role = agentRoleRepo.findById(validatedRoleId);
        if (!role) {
          throw new Error("Agent role not found");
        }
      }
      const taskUpdate: Partial<Task> = {
        assignedAgentRoleId: agentRoleId ?? undefined,
      };
      taskRepo.update(validatedTaskId, taskUpdate);
      const task = taskRepo.findById(validatedTaskId);
      if (task) {
        if (agentRoleId) {
          const role = agentRoleRepo.findById(agentRoleId);
          const activity = activityRepo.create({
            workspaceId: task.workspaceId,
            taskId: task.id,
            agentRoleId,
            actorType: "system",
            activityType: "agent_assigned",
            title: `Assigned to ${role?.displayName || "agent"}`,
            description: task.title,
          });
          getMainWindow()?.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, {
            type: "created",
            activity,
          });
        } else {
          const activity = activityRepo.create({
            workspaceId: task.workspaceId,
            taskId: task.id,
            actorType: "system",
            activityType: "info",
            title: "Task unassigned",
            description: task.title,
          });
          getMainWindow()?.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, {
            type: "created",
            activity,
          });
        }
      }
      return { success: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS.AGENT_ROLE_GET_DEFAULTS, async () => {
    const { DEFAULT_AGENT_ROLES } = await import("../../shared/types");
    return DEFAULT_AGENT_ROLES;
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_ROLE_SEED_DEFAULTS, async () => {
    checkRateLimit(IPC_CHANNELS.AGENT_ROLE_SEED_DEFAULTS);
    return agentRoleRepo.seedDefaults();
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_ROLE_SYNC_DEFAULTS, async () => {
    checkRateLimit(IPC_CHANNELS.AGENT_ROLE_SYNC_DEFAULTS);
    return agentRoleRepo.syncNewDefaults();
  });

  // Activity Feed handlers
  ipcMain.handle(IPC_CHANNELS.ACTIVITY_LIST, async (_, query: Any) => {
    const validated = validateInput(
      WorkspaceIdSchema,
      query.workspaceId,
      "workspace ID",
    );
    return activityRepo.list({ ...query, workspaceId: validated });
  });

  ipcMain.handle(IPC_CHANNELS.ACTIVITY_CREATE, async (_, request: Any) => {
    checkRateLimit(IPC_CHANNELS.ACTIVITY_CREATE);
    const validatedWorkspaceId = validateInput(
      WorkspaceIdSchema,
      request.workspaceId,
      "workspace ID",
    );
    const activity = activityRepo.create({
      ...request,
      workspaceId: validatedWorkspaceId,
    });
    // Emit activity event for real-time updates
    getMainWindow()?.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, {
      type: "created",
      activity,
    });
    return activity;
  });

  ipcMain.handle(IPC_CHANNELS.ACTIVITY_MARK_READ, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.ACTIVITY_MARK_READ);
    const validated = validateInput(UUIDSchema, id, "activity ID");
    const success = activityRepo.markRead(validated);
    if (success) {
      getMainWindow()?.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, {
        type: "read",
        id: validated,
      });
    }
    return { success };
  });

  ipcMain.handle(
    IPC_CHANNELS.ACTIVITY_MARK_ALL_READ,
    async (_, workspaceId: string) => {
      checkRateLimit(IPC_CHANNELS.ACTIVITY_MARK_ALL_READ);
      const validated = validateInput(
        WorkspaceIdSchema,
        workspaceId,
        "workspace ID",
      );
      const count = activityRepo.markAllRead(validated);
      getMainWindow()?.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, {
        type: "all_read",
        workspaceId: validated,
      });
      return { count };
    },
  );

  ipcMain.handle(IPC_CHANNELS.ACTIVITY_PIN, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.ACTIVITY_PIN);
    const validated = validateInput(UUIDSchema, id, "activity ID");
    const activity = activityRepo.togglePin(validated);
    if (activity) {
      getMainWindow()?.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, {
        type: "pinned",
        activity,
      });
    }
    return activity;
  });

  ipcMain.handle(IPC_CHANNELS.ACTIVITY_DELETE, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.ACTIVITY_DELETE);
    const validated = validateInput(UUIDSchema, id, "activity ID");
    const success = activityRepo.delete(validated);
    if (success) {
      getMainWindow()?.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, {
        type: "deleted",
        id: validated,
      });
    }
    return { success };
  });

  // @Mention handlers
  ipcMain.handle(IPC_CHANNELS.MENTION_LIST, async (_, query: Any) => {
    return mentionRepo.list(query);
  });

  ipcMain.handle(IPC_CHANNELS.MENTION_CREATE, async (_, request: Any) => {
    checkRateLimit(IPC_CHANNELS.MENTION_CREATE);
    const validatedWorkspaceId = validateInput(
      UUIDSchema,
      request.workspaceId,
      "workspace ID",
    );
    const mention = mentionRepo.create({
      ...request,
      workspaceId: validatedWorkspaceId,
    });
    // Emit mention event for real-time updates
    getMainWindow()?.webContents.send(IPC_CHANNELS.MENTION_EVENT, {
      type: "created",
      mention,
    });
    // Also create an activity entry for the mention
    const fromAgent = request.fromAgentRoleId
      ? agentRoleRepo.findById(request.fromAgentRoleId)
      : null;
    const toAgent = agentRoleRepo.findById(request.toAgentRoleId);
    activityRepo.create({
      workspaceId: validatedWorkspaceId,
      taskId: request.taskId,
      agentRoleId: request.toAgentRoleId,
      actorType: fromAgent ? "agent" : "user",
      activityType: "mention",
      title: `@${toAgent?.displayName || "Agent"} mentioned`,
      description: request.context,
      metadata: { mentionId: mention.id, mentionType: request.mentionType },
    });
    return mention;
  });

  ipcMain.handle(IPC_CHANNELS.MENTION_ACKNOWLEDGE, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.MENTION_ACKNOWLEDGE);
    const validated = validateInput(UUIDSchema, id, "mention ID");
    const mention = mentionRepo.acknowledge(validated);
    if (mention) {
      getMainWindow()?.webContents.send(IPC_CHANNELS.MENTION_EVENT, {
        type: "acknowledged",
        mention,
      });
    }
    return mention;
  });

  ipcMain.handle(IPC_CHANNELS.MENTION_COMPLETE, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.MENTION_COMPLETE);
    const validated = validateInput(UUIDSchema, id, "mention ID");
    const mention = mentionRepo.complete(validated);
    if (mention) {
      getMainWindow()?.webContents.send(IPC_CHANNELS.MENTION_EVENT, {
        type: "completed",
        mention,
      });
    }
    return mention;
  });

  ipcMain.handle(IPC_CHANNELS.MENTION_DISMISS, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.MENTION_DISMISS);
    const validated = validateInput(UUIDSchema, id, "mention ID");
    const mention = mentionRepo.dismiss(validated);
    if (mention) {
      getMainWindow()?.webContents.send(IPC_CHANNELS.MENTION_EVENT, {
        type: "dismissed",
        mention,
      });
    }
    return mention;
  });

  ipcMain.handle(
    IPC_CHANNELS.SUPERVISOR_EXCHANGE_LIST,
    async (_, query: Any) => {
      if (!gateway?.getDiscordSupervisorService()) {
        return [];
      }
      const validatedWorkspaceId = validateInput(
        UUIDSchema,
        query.workspaceId,
        "workspace ID",
      );
      return gateway.getDiscordSupervisorService()!.listExchanges({
        workspaceId: validatedWorkspaceId,
        status: query.status,
        limit: typeof query.limit === "number" ? query.limit : undefined,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SUPERVISOR_EXCHANGE_RESOLVE,
    async (_, request: Any) => {
      checkRateLimit(
        IPC_CHANNELS.SUPERVISOR_EXCHANGE_RESOLVE,
        RATE_LIMIT_CONFIGS.limited,
      );
      const service = gateway?.getDiscordSupervisorService();
      if (!service) {
        throw new Error("Discord supervisor service is not available");
      }
      const id = validateInput(
        UUIDSchema,
        request?.id,
        "supervisor exchange ID",
      );
      const resolution = String(request?.resolution || "").trim();
      if (!resolution) {
        throw new Error("Resolution is required");
      }
      return service.resolveExchange({
        id,
        resolution,
        mirrorToDiscord: request?.mirrorToDiscord === true,
      });
    },
  );

  // Agent Teams (Mission Control)
  const emitTeamEvent = (event: Any) => {
    getMainWindow()?.webContents.send(IPC_CHANNELS.TEAM_RUN_EVENT, event);
  };

  ipcMain.handle(
    IPC_CHANNELS.TEAM_LIST,
    async (_, workspaceId: string, includeInactive?: boolean) => {
      const validated = validateInput(UUIDSchema, workspaceId, "workspace ID");
      return teamRepo.listByWorkspace(validated, includeInactive ?? false);
    },
  );

  ipcMain.handle(IPC_CHANNELS.TEAM_GET, async (_, id: string) => {
    const validated = validateInput(UUIDSchema, id, "team ID");
    return teamRepo.findById(validated);
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_CREATE, async (_, request: Any) => {
    checkRateLimit(IPC_CHANNELS.TEAM_CREATE);
    const workspaceId = validateInput(
      UUIDSchema,
      request.workspaceId,
      "workspace ID",
    );
    const leadAgentRoleId = validateInput(
      UUIDSchema,
      request.leadAgentRoleId,
      "lead agent role ID",
    );
    const name = typeof request.name === "string" ? request.name.trim() : "";
    if (!name) throw new Error("Team name is required");
    if (!agentRoleRepo.findById(leadAgentRoleId)) {
      throw new Error("Lead agent role not found");
    }
    const created = teamRepo.create({
      workspaceId,
      name,
      description:
        typeof request.description === "string"
          ? request.description.trim()
          : undefined,
      leadAgentRoleId,
      maxParallelAgents:
        typeof request.maxParallelAgents === "number"
          ? request.maxParallelAgents
          : undefined,
      defaultModelPreference:
        typeof request.defaultModelPreference === "string"
          ? request.defaultModelPreference
          : undefined,
      defaultPersonality:
        typeof request.defaultPersonality === "string"
          ? request.defaultPersonality
          : undefined,
      isActive: request.isActive !== undefined ? !!request.isActive : undefined,
    });
    emitTeamEvent({
      type: "team_created",
      timestamp: Date.now(),
      team: created,
    });
    return created;
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_UPDATE, async (_, request: Any) => {
    checkRateLimit(IPC_CHANNELS.TEAM_UPDATE);
    const id = validateInput(UUIDSchema, request.id, "team ID");
    const updates: Any = { id };
    if (request.name !== undefined) {
      const name = typeof request.name === "string" ? request.name.trim() : "";
      if (!name) throw new Error("Team name cannot be empty");
      updates.name = name;
    }
    if (request.description !== undefined) {
      updates.description =
        request.description === null
          ? null
          : typeof request.description === "string"
            ? request.description.trim()
            : null;
    }
    if (request.leadAgentRoleId !== undefined) {
      const leadId = validateInput(
        UUIDSchema,
        request.leadAgentRoleId,
        "lead agent role ID",
      );
      if (!agentRoleRepo.findById(leadId))
        throw new Error("Lead agent role not found");
      updates.leadAgentRoleId = leadId;
    }
    if (request.maxParallelAgents !== undefined)
      updates.maxParallelAgents = request.maxParallelAgents;
    if (request.defaultModelPreference !== undefined)
      updates.defaultModelPreference = request.defaultModelPreference;
    if (request.defaultPersonality !== undefined)
      updates.defaultPersonality = request.defaultPersonality;
    if (request.isActive !== undefined) updates.isActive = !!request.isActive;
    const updated = teamRepo.update(updates);
    if (updated) {
      emitTeamEvent({
        type: "team_updated",
        timestamp: Date.now(),
        team: updated,
      });
    }
    return updated;
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_DELETE, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.TEAM_DELETE);
    const validated = validateInput(UUIDSchema, id, "team ID");
    const success = teamRepo.delete(validated);
    if (success) {
      emitTeamEvent({
        type: "team_deleted",
        timestamp: Date.now(),
        teamId: validated,
      });
    }
    return { success };
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_MEMBER_LIST, async (_, teamId: string) => {
    const validated = validateInput(UUIDSchema, teamId, "team ID");
    return teamMemberRepo.listByTeam(validated);
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_MEMBER_ADD, async (_, request: Any) => {
    checkRateLimit(IPC_CHANNELS.TEAM_MEMBER_ADD);
    const teamId = validateInput(UUIDSchema, request.teamId, "team ID");
    const agentRoleId = validateInput(
      UUIDSchema,
      request.agentRoleId,
      "agent role ID",
    );
    if (!agentRoleRepo.findById(agentRoleId))
      throw new Error("Agent role not found");
    const member = teamMemberRepo.add({
      teamId,
      agentRoleId,
      memberOrder:
        typeof request.memberOrder === "number"
          ? request.memberOrder
          : undefined,
      isRequired:
        request.isRequired !== undefined ? !!request.isRequired : undefined,
      roleGuidance:
        typeof request.roleGuidance === "string"
          ? request.roleGuidance
          : undefined,
    });
    emitTeamEvent({ type: "team_member_added", timestamp: Date.now(), member });
    return member;
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_MEMBER_UPDATE, async (_, request: Any) => {
    checkRateLimit(IPC_CHANNELS.TEAM_MEMBER_UPDATE);
    const id = validateInput(UUIDSchema, request.id, "team member ID");
    const updated = teamMemberRepo.update({
      id,
      memberOrder:
        typeof request.memberOrder === "number"
          ? request.memberOrder
          : undefined,
      isRequired:
        request.isRequired !== undefined ? !!request.isRequired : undefined,
      roleGuidance:
        request.roleGuidance === null
          ? null
          : typeof request.roleGuidance === "string"
            ? request.roleGuidance
            : undefined,
    });
    if (updated) {
      emitTeamEvent({
        type: "team_member_updated",
        timestamp: Date.now(),
        member: updated,
      });
    }
    return updated;
  });

  ipcMain.handle(
    IPC_CHANNELS.TEAM_MEMBER_REMOVE,
    async (_, data: { teamId: string; agentRoleId: string }) => {
      checkRateLimit(IPC_CHANNELS.TEAM_MEMBER_REMOVE);
      const teamId = validateInput(UUIDSchema, data.teamId, "team ID");
      const agentRoleId = validateInput(
        UUIDSchema,
        data.agentRoleId,
        "agent role ID",
      );
      const success = teamMemberRepo.removeByTeamAndRole(teamId, agentRoleId);
      if (success) {
        emitTeamEvent({
          type: "team_member_removed",
          timestamp: Date.now(),
          teamId,
          agentRoleId,
        });
      }
      return { success };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TEAM_MEMBER_REORDER,
    async (_, data: { teamId: string; orderedMemberIds: string[] }) => {
      checkRateLimit(IPC_CHANNELS.TEAM_MEMBER_REORDER);
      const teamId = validateInput(UUIDSchema, data.teamId, "team ID");
      const ordered = Array.isArray(data.orderedMemberIds)
        ? data.orderedMemberIds
        : [];
      const normalized = ordered
        .map((id) => (typeof id === "string" ? id.trim() : ""))
        .filter(Boolean);
      const updated = teamMemberRepo.reorder(teamId, normalized);
      emitTeamEvent({
        type: "team_members_reordered",
        timestamp: Date.now(),
        teamId,
        members: updated,
      });
      return updated;
    },
  );

  ipcMain.handle(IPC_CHANNELS.TEAM_RUN_LIST, async (_, query: Any) => {
    const teamId = validateInput(UUIDSchema, query.teamId, "team ID");
    const limit = typeof query.limit === "number" ? query.limit : undefined;
    return teamRunRepo.listByTeam(teamId, limit);
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_RUN_GET, async (_, id: string) => {
    const validated = validateInput(UUIDSchema, id, "team run ID");
    return teamRunRepo.findById(validated);
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_RUN_CREATE, async (_, request: Any) => {
    checkRateLimit(IPC_CHANNELS.TEAM_RUN_CREATE);
    const teamId = validateInput(UUIDSchema, request.teamId, "team ID");
    const rootTaskId = validateInput(
      UUIDSchema,
      request.rootTaskId,
      "root task ID",
    );
    const rootTask = taskRepo.findById(rootTaskId);
    if (!rootTask) throw new Error("Root task not found");
    const created = teamRunRepo.create({
      teamId,
      rootTaskId,
      status: request.status,
      startedAt: request.startedAt,
      collaborativeMode: request.collaborativeMode,
    });
    emitTeamEvent({
      type: "team_run_created",
      timestamp: Date.now(),
      run: created,
    });
    if (created.status === "running") {
      void teamOrchestrator.tickRun(created.id, "run_created");
    }
    return created;
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_RUN_RESUME, async (_, runId: string) => {
    checkRateLimit(IPC_CHANNELS.TEAM_RUN_RESUME);
    const validated = validateInput(UUIDSchema, runId, "team run ID");
    const updated = teamRunRepo.update(validated, { status: "running" });
    if (updated) {
      emitTeamEvent({
        type: "team_run_updated",
        timestamp: Date.now(),
        run: updated,
      });
      void teamOrchestrator.tickRun(updated.id, "resume");
    }
    return { success: !!updated };
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_RUN_PAUSE, async (_, runId: string) => {
    checkRateLimit(IPC_CHANNELS.TEAM_RUN_PAUSE);
    const validated = validateInput(UUIDSchema, runId, "team run ID");
    const updated = teamRunRepo.update(validated, { status: "paused" });
    if (updated) {
      emitTeamEvent({
        type: "team_run_updated",
        timestamp: Date.now(),
        run: updated,
      });
    }
    return { success: !!updated };
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_RUN_CANCEL, async (_, runId: string) => {
    checkRateLimit(IPC_CHANNELS.TEAM_RUN_CANCEL);
    const validated = validateInput(UUIDSchema, runId, "team run ID");
    await teamOrchestrator.cancelRun(validated);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_RUN_WRAP_UP, async (_, runId: string) => {
    checkRateLimit(IPC_CHANNELS.TEAM_RUN_WRAP_UP);
    const validated = validateInput(UUIDSchema, runId, "team run ID");
    await teamOrchestrator.wrapUpRun(validated);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_ITEM_LIST, async (_, teamRunId: string) => {
    const validated = validateInput(UUIDSchema, teamRunId, "team run ID");
    return teamItemRepo.listByRun(validated);
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_ITEM_CREATE, async (_, request: Any) => {
    checkRateLimit(IPC_CHANNELS.TEAM_ITEM_CREATE);
    const teamRunId = validateInput(
      UUIDSchema,
      request.teamRunId,
      "team run ID",
    );
    const title = typeof request.title === "string" ? request.title.trim() : "";
    if (!title) throw new Error("Item title is required");
    const created = teamItemRepo.create({
      teamRunId,
      parentItemId: request.parentItemId || undefined,
      title,
      description:
        typeof request.description === "string"
          ? request.description
          : undefined,
      ownerAgentRoleId: request.ownerAgentRoleId
        ? validateInput(
            UUIDSchema,
            request.ownerAgentRoleId,
            "owner agent role ID",
          )
        : undefined,
      sourceTaskId: request.sourceTaskId
        ? validateInput(UUIDSchema, request.sourceTaskId, "source task ID")
        : undefined,
      status: request.status,
      sortOrder:
        typeof request.sortOrder === "number" ? request.sortOrder : undefined,
    });
    emitTeamEvent({
      type: "team_item_created",
      timestamp: Date.now(),
      item: created,
    });
    const run = teamRunRepo.findById(teamRunId);
    if (run?.status === "running") {
      void teamOrchestrator.tickRun(teamRunId, "item_created");
    }
    return created;
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_ITEM_UPDATE, async (_, request: Any) => {
    checkRateLimit(IPC_CHANNELS.TEAM_ITEM_UPDATE);
    const id = validateInput(UUIDSchema, request.id, "team item ID");
    const updated = teamItemRepo.update({
      id,
      parentItemId: request.parentItemId,
      title: request.title,
      description: request.description,
      ownerAgentRoleId: request.ownerAgentRoleId,
      sourceTaskId: request.sourceTaskId,
      status: request.status,
      resultSummary: request.resultSummary,
      sortOrder: request.sortOrder,
    });
    if (updated) {
      emitTeamEvent({
        type: "team_item_updated",
        timestamp: Date.now(),
        teamRunId: updated.teamRunId,
        item: updated,
      });
      const run = teamRunRepo.findById(updated.teamRunId);
      if (run?.status === "running") {
        void teamOrchestrator.tickRun(updated.teamRunId, "item_updated");
      }
    }
    return updated;
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_ITEM_DELETE, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.TEAM_ITEM_DELETE);
    const validated = validateInput(UUIDSchema, id, "team item ID");
    const existing = teamItemRepo.findById(validated);
    const success = teamItemRepo.delete(validated);
    if (success && existing) {
      emitTeamEvent({
        type: "team_item_deleted",
        timestamp: Date.now(),
        teamRunId: existing.teamRunId,
        itemId: validated,
      });
      const run = teamRunRepo.findById(existing.teamRunId);
      if (run?.status === "running") {
        void teamOrchestrator.tickRun(existing.teamRunId, "item_deleted");
      }
    }
    return { success };
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_ITEM_MOVE, async (_, request: Any) => {
    checkRateLimit(IPC_CHANNELS.TEAM_ITEM_MOVE);
    const id = validateInput(UUIDSchema, request.id, "team item ID");
    const updated = teamItemRepo.update({
      id,
      parentItemId: request.parentItemId,
      sortOrder: request.sortOrder,
    });
    if (updated) {
      emitTeamEvent({
        type: "team_item_moved",
        timestamp: Date.now(),
        item: updated,
      });
      const run = teamRunRepo.findById(updated.teamRunId);
      if (run?.status === "running") {
        void teamOrchestrator.tickRun(updated.teamRunId, "item_moved");
      }
    }
    return updated;
  });

  // Collaborative Thoughts
  ipcMain.handle(
    IPC_CHANNELS.TEAM_THOUGHT_LIST,
    async (_, teamRunId: string) => {
      const validated = validateInput(UUIDSchema, teamRunId, "team run ID");
      return teamThoughtRepo.listByRun(validated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TEAM_RUN_FIND_BY_ROOT_TASK,
    async (_, rootTaskId: string) => {
      const validated = validateInput(UUIDSchema, rootTaskId, "root task ID");
      return teamRunRepo.findByRootTaskId(validated) || null;
    },
  );

  // Agent Performance Reviews (Mission Control)
  ipcMain.handle(IPC_CHANNELS.REVIEW_GENERATE, async (_, request: Any) => {
    checkRateLimit(IPC_CHANNELS.REVIEW_GENERATE);
    const workspaceId = validateInput(
      UUIDSchema,
      request.workspaceId,
      "workspace ID",
    );
    const agentRoleId = validateInput(
      UUIDSchema,
      request.agentRoleId,
      "agent role ID",
    );
    if (!agentRoleRepo.findById(agentRoleId)) {
      throw new Error("Agent role not found");
    }
    const periodDays =
      request.periodDays !== undefined ? Number(request.periodDays) : undefined;
    return reviewService.generate({ workspaceId, agentRoleId, periodDays });
  });

  ipcMain.handle(
    IPC_CHANNELS.REVIEW_GET_LATEST,
    async (_, workspaceId: string, agentRoleId: string) => {
      const validatedWorkspaceId = validateInput(
        UUIDSchema,
        workspaceId,
        "workspace ID",
      );
      const validatedRoleId = validateInput(
        UUIDSchema,
        agentRoleId,
        "agent role ID",
      );
      return reviewService.getLatest(validatedWorkspaceId, validatedRoleId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.REVIEW_LIST, async (_, query: Any) => {
    const validatedWorkspaceId = validateInput(
      UUIDSchema,
      query.workspaceId,
      "workspace ID",
    );
    const agentRoleId = query.agentRoleId
      ? validateInput(UUIDSchema, query.agentRoleId, "agent role ID")
      : undefined;
    const limit = query.limit !== undefined ? Number(query.limit) : undefined;
    return reviewService.list(validatedWorkspaceId, agentRoleId, limit);
  });

  ipcMain.handle(IPC_CHANNELS.REVIEW_DELETE, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.REVIEW_DELETE);
    const validated = validateInput(UUIDSchema, id, "review ID");
    const success = reviewService.delete(validated);
    return { success };
  });

  // Eval Suites / Runs (Reliability Flywheel)
  ipcMain.handle(
    IPC_CHANNELS.EVAL_LIST_SUITES,
    async (_, options?: { windowDays?: number }) => {
      const windowDays =
        typeof options?.windowDays === "number" &&
        Number.isFinite(options.windowDays)
          ? options.windowDays
          : 30;
      return {
        suites: evalService.listSuites(),
        metrics: evalService.getBaselineMetrics(windowDays),
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.EVAL_CREATE_CASE_FROM_TASK,
    async (_, data: { taskId: string }) => {
      checkRateLimit(IPC_CHANNELS.EVAL_CREATE_CASE_FROM_TASK);
      const taskId = validateInput(UUIDSchema, data?.taskId, "task ID");
      return evalService.createCaseFromTask(taskId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.EVAL_GET_CASE, async (_, caseId: string) => {
    const validated = validateInput(UUIDSchema, caseId, "eval case ID");
    return evalService.getCase(validated);
  });

  ipcMain.handle(IPC_CHANNELS.EVAL_RUN_SUITE, async (_, suiteId: string) => {
    checkRateLimit(IPC_CHANNELS.EVAL_RUN_SUITE);
    const validated = validateInput(UUIDSchema, suiteId, "eval suite ID");
    return evalService.runSuite(validated);
  });

  ipcMain.handle(IPC_CHANNELS.EVAL_GET_RUN, async (_, runId: string) => {
    const validated = validateInput(UUIDSchema, runId, "eval run ID");
    return evalService.getRun(validated);
  });

  // Usage Insights
  ipcMain.handle(
    IPC_CHANNELS.USAGE_INSIGHTS_GET,
    async (_, workspaceId: string, periodDays?: number) => {
      checkRateLimit(IPC_CHANNELS.USAGE_INSIGHTS_GET);
      // Allow "__all__" sentinel for cross-workspace aggregation
      const validatedWorkspaceId =
        workspaceId === "__all__"
          ? null
          : validateInput(UUIDSchema, workspaceId, "workspace ID");
      // Clamp period to a reasonable range to prevent excessive DB scans
      const clampedPeriod = Math.min(
        Math.max(Math.round(periodDays ?? 7), 1),
        365,
      );
      const { UsageInsightsService } =
        await import("../reports/UsageInsightsService");
      const service = new UsageInsightsService(db);
      return service.generate(validatedWorkspaceId, clampedPeriod);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.USAGE_INSIGHTS_EARLIEST,
    async (_, workspaceId: string) => {
      checkRateLimit(IPC_CHANNELS.USAGE_INSIGHTS_EARLIEST);
      const validatedWorkspaceId =
        workspaceId === "__all__"
          ? null
          : validateInput(UUIDSchema, workspaceId, "workspace ID");
      const { UsageInsightsService } =
        await import("../reports/UsageInsightsService");
      const service = new UsageInsightsService(db);
      return service.getEarliestActivityMs(validatedWorkspaceId);
    },
  );

  // Daily Briefing
  ipcMain.handle(
    IPC_CHANNELS.DAILY_BRIEFING_GENERATE,
    async (_, workspaceId: string) => {
      checkRateLimit(IPC_CHANNELS.DAILY_BRIEFING_GENERATE);
      const { DailyBriefingService } =
        await import("../briefing/DailyBriefingService");
      const { ProactiveSuggestionsService } =
        await import("../agent/ProactiveSuggestionsService");
      const { readWorkspacePriorities, readWorkspaceOpenLoops } =
        await import("../briefing/workspace-briefing-context");
      const ALL_WORKSPACES_ID = "__all__";
      const workspaceRepo = new WorkspaceRepository(db);
      const taskRepo = new TaskRepository(db);
      const normalizedWorkspaceId =
        workspaceId === ALL_WORKSPACES_ID
          ? ALL_WORKSPACES_ID
          : validateInput(UUIDSchema, workspaceId, "workspace ID");
      const allMode = normalizedWorkspaceId === ALL_WORKSPACES_ID;
      const briefingWorkspaceIds = allMode
        ? workspaceRepo
            .findAll()
            .filter(
              (workspace) =>
                !workspace.isTemp && !isTempWorkspaceId(workspace.id),
            )
            .map((workspace) => workspace.id)
        : [normalizedWorkspaceId];
      const workspaceById = new Map(
        workspaceRepo
          .findAll()
          .map((workspace) => [workspace.id, workspace] as const),
      );
      const labelForWorkspace = (id: string) =>
        workspaceById.get(id)?.name || id;
      const service = new DailyBriefingService(
        {
          getRecentTasks: (_workspaceId, sinceMs) => {
            const tasks = briefingWorkspaceIds.flatMap((id) =>
              (
                taskRepo.findByCreatedAtRange({
                  startMs: sinceMs,
                  endMs: Date.now(),
                  limit: 100,
                  workspaceId: id,
                }) || []
              ).map((task) => ({
                ...task,
                workspaceName: labelForWorkspace(id),
              })),
            );
            return tasks.sort(
              (a: Any, b: Any) => (b.createdAt || 0) - (a.createdAt || 0),
            );
          },
          searchMemory: (_currentWorkspaceId, query, limit) => {
            const results = briefingWorkspaceIds.flatMap((id) =>
              MemoryService.search(id, query, limit).map((memory) => ({
                ...memory,
                workspaceId: id,
                workspaceName: labelForWorkspace(id),
              })),
            );
            return results
              .sort(
                (a: Any, b: Any) =>
                  (b.relevanceScore || 0) - (a.relevanceScore || 0) ||
                  (b.createdAt || 0) - (a.createdAt || 0),
              )
              .slice(0, limit)
              .map((memory) => ({
                summary: memory.snippet,
                content: memory.snippet,
                snippet: memory.snippet,
                type: memory.type,
                workspaceId: memory.workspaceId,
                workspaceName: memory.workspaceName,
              }));
          },
          refreshSuggestions: async (currentWorkspaceId) => {
            if (!allMode) {
              await ProactiveSuggestionsService.generateAll(currentWorkspaceId);
              return;
            }
            await Promise.all(
              briefingWorkspaceIds.map((id) =>
                ProactiveSuggestionsService.generateAll(id),
              ),
            );
          },
          getActiveSuggestions: (currentWorkspaceId, limit = 5) => {
            if (!allMode) {
              return ProactiveSuggestionsService.getTopForBriefing(
                currentWorkspaceId,
                limit,
              );
            }
            return ProactiveSuggestionsService.getTopForBriefingForWorkspaces(
              currentWorkspaceId,
              briefingWorkspaceIds,
              limit,
            )
              .map((suggestion) => ({
                ...suggestion,
                workspaceId: suggestion.workspaceId || currentWorkspaceId,
                workspaceName: labelForWorkspace(
                  suggestion.workspaceId || currentWorkspaceId,
                ),
              }))
              .sort(
                (a: Any, b: Any) => (b.confidence || 0) - (a.confidence || 0),
              )
              .slice(0, limit);
          },
          getPriorities: (currentWorkspaceId) => {
            if (!allMode) {
              const workspacePath =
                workspaceRepo.findById(currentWorkspaceId)?.path;
              return readWorkspacePriorities(workspacePath);
            }
            const blocks = briefingWorkspaceIds
              .map((id) => {
                const workspacePath = workspaceRepo.findById(id)?.path;
                const raw = readWorkspacePriorities(workspacePath);
                if (!raw) return "";
                const lines = raw
                  .split("\n")
                  .map((line) => line.trim())
                  .filter((line) => line && !line.startsWith("#"))
                  .map((line) => {
                    const item = line.replace(/^[-*\d.]+\s*/, "").trim();
                    return item ? `- [${labelForWorkspace(id)}] ${item}` : "";
                  })
                  .filter(Boolean);
                return lines.join("\n");
              })
              .filter(Boolean);
            return blocks.join("\n");
          },
          getUpcomingJobs: async () => [],
          getOpenLoops: (currentWorkspaceId) => {
            if (!allMode) {
              const workspacePath =
                workspaceRepo.findById(currentWorkspaceId)?.path;
              return readWorkspaceOpenLoops(workspacePath);
            }
            return briefingWorkspaceIds.flatMap((id) => {
              const workspacePath = workspaceRepo.findById(id)?.path;
              const raw = readWorkspaceOpenLoops(workspacePath);
              return raw.map((line) => `- [${labelForWorkspace(id)}] ${line}`);
            });
          },
          getAwarenessSummary: async (currentWorkspaceId) => {
            if (!allMode) {
              return getAwarenessService().getSummary(currentWorkspaceId);
            }
            const summaries = await Promise.all(
              briefingWorkspaceIds.map(async (id) => ({
                id,
                summary: getAwarenessService().getSummary(id),
              })),
            );
            const mergedWhatChanged: Any[] = [];
            const mergedWhatMattersNow: Any[] = [];
            const mergedDueSoon: Any[] = [];
            const mergedBeliefs: Any[] = [];
            const mergedWakeReasons = new Set<string>();
            for (const entry of summaries) {
              const summary = entry.summary;
              if (!summary) continue;
              const label = labelForWorkspace(entry.id);
              const decorateItem = (item: Any) => ({
                ...item,
                title: `[${label}] ${item.title}`,
                workspaceId: entry.id,
              });
              mergedWhatChanged.push(
                ...(summary.whatChanged || []).map(decorateItem),
              );
              mergedWhatMattersNow.push(
                ...(summary.whatMattersNow || []).map(decorateItem),
              );
              mergedDueSoon.push(...(summary.dueSoon || []).map(decorateItem));
              mergedBeliefs.push(...(summary.beliefs || []));
              for (const reason of summary.wakeReasons || []) {
                mergedWakeReasons.add(reason);
              }
            }
            return {
              generatedAt: Date.now(),
              workspaceId: ALL_WORKSPACES_ID,
              currentFocus: "All workspaces",
              whatChanged: mergedWhatChanged,
              whatMattersNow: mergedWhatMattersNow,
              dueSoon: mergedDueSoon,
              beliefs: mergedBeliefs,
              wakeReasons: [...mergedWakeReasons],
            };
          },
          getAutonomyState: async (currentWorkspaceId) => {
            if (!allMode) {
              return getAutonomyEngine().getWorldModel(currentWorkspaceId);
            }
            const states = await Promise.all(
              briefingWorkspaceIds.map(async (id) => ({
                id,
                state: getAutonomyEngine().getWorldModel(id),
              })),
            );
            const mergedGoals: Any[] = [];
            const mergedProjects: Any[] = [];
            const mergedOpenLoops: Any[] = [];
            const mergedRoutines: Any[] = [];
            const mergedBeliefs: Any[] = [];
            const mergedCurrentPriorities: string[] = [];
            const mergedContinuityNotes: string[] = [];
            for (const entry of states) {
              const state = entry.state;
              if (!state) continue;
              const label = labelForWorkspace(entry.id);
              mergedGoals.push(
                ...(state.goals || []).map((goal: Any) => ({
                  ...goal,
                  title: `[${label}] ${goal.title}`,
                  workspaceId: entry.id,
                })),
              );
              mergedProjects.push(
                ...(state.projects || []).map((project: Any) => ({
                  ...project,
                  title: `[${label}] ${project.title}`,
                  workspaceId: entry.id,
                })),
              );
              mergedOpenLoops.push(
                ...(state.openLoops || []).map((loop: Any) => ({
                  ...loop,
                  title: `[${label}] ${loop.title}`,
                  workspaceId: entry.id,
                })),
              );
              mergedRoutines.push(
                ...(state.routines || []).map((routine: Any) => ({
                  ...routine,
                  title: `[${label}] ${routine.title}`,
                  workspaceId: entry.id,
                })),
              );
              mergedBeliefs.push(...(state.beliefs || []));
              mergedCurrentPriorities.push(
                ...(state.currentPriorities || []).map(
                  (priority: string) => `[${label}] ${priority}`,
                ),
              );
              mergedContinuityNotes.push(
                ...(state.continuityNotes || []).map(
                  (note: string) => `[${label}] ${note}`,
                ),
              );
            }
            return {
              generatedAt: Date.now(),
              workspaceId: ALL_WORKSPACES_ID,
              currentFocus: "All workspaces",
              goals: mergedGoals,
              projects: mergedProjects,
              openLoops: mergedOpenLoops,
              routines: mergedRoutines,
              beliefs: mergedBeliefs,
              currentPriorities: mergedCurrentPriorities,
              continuityNotes: mergedContinuityNotes,
            };
          },
          getAutonomyDecisions: async (currentWorkspaceId) => {
            if (!allMode) {
              return getAutonomyEngine().listDecisions(currentWorkspaceId);
            }
            const decisions = await Promise.all(
              briefingWorkspaceIds.map(async (id) => ({
                id,
                decisions: getAutonomyEngine().listDecisions(id),
              })),
            );
            return decisions.flatMap((entry) =>
              (entry.decisions || []).map((decision: Any) => ({
                ...decision,
                title: `[${labelForWorkspace(entry.id)}] ${decision.title}`,
                description: `[${labelForWorkspace(entry.id)}] ${decision.description}`,
                workspaceId: entry.id,
              })),
            );
          },
          log: (...args: unknown[]) => logger.info("[Briefing]", ...args),
        },
        db,
      );
      return service.generateBriefing(normalizedWorkspaceId);
    },
  );

  // Proactive Suggestions
  ipcMain.handle(
    IPC_CHANNELS.SUGGESTIONS_LIST,
    async (_, workspaceId: string) => {
      checkRateLimit(IPC_CHANNELS.SUGGESTIONS_LIST);
      const validatedWorkspaceId = validateInput(
        WorkspaceIdSchema,
        workspaceId,
        "workspace ID",
      );
      const { ProactiveSuggestionsService } =
        await import("../agent/ProactiveSuggestionsService");
      return ProactiveSuggestionsService.listActive(validatedWorkspaceId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SUGGESTIONS_LIST_FOR_WORKSPACES,
    async (_, workspaceIds: unknown) => {
      checkRateLimit(IPC_CHANNELS.SUGGESTIONS_LIST_FOR_WORKSPACES);
      const normalizedWorkspaceIds = validateInput(
        z.array(WorkspaceIdSchema),
        workspaceIds,
        "workspace IDs",
      );
      const uniqueWorkspaceIds = [...new Set(normalizedWorkspaceIds)];
      if (uniqueWorkspaceIds.length === 0) return [];
      const { ProactiveSuggestionsService } =
        await import("../agent/ProactiveSuggestionsService");
      const allSuggestions = ProactiveSuggestionsService.listActive(
        uniqueWorkspaceIds[0],
        undefined,
        uniqueWorkspaceIds,
      );
      return uniqueWorkspaceIds.map((workspaceId) => ({
        workspaceId,
        suggestions: allSuggestions.filter((suggestion) => suggestion.workspaceId === workspaceId),
      }));
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SUGGESTIONS_REFRESH,
    async (_, workspaceId: string) => {
      checkRateLimit(IPC_CHANNELS.SUGGESTIONS_REFRESH);
      const validatedWorkspaceId = validateInput(
        WorkspaceIdSchema,
        workspaceId,
        "workspace ID",
      );
      const { ProactiveSuggestionsService } =
        await import("../agent/ProactiveSuggestionsService");
      await ProactiveSuggestionsService.generateAll(validatedWorkspaceId);
      return { success: true };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SUGGESTIONS_REFRESH_FOR_WORKSPACES,
    async (_, workspaceIds: unknown) => {
      checkRateLimit(IPC_CHANNELS.SUGGESTIONS_REFRESH_FOR_WORKSPACES);
      const normalizedWorkspaceIds = validateInput(
        z.array(WorkspaceIdSchema),
        workspaceIds,
        "workspace IDs",
      );
      const uniqueWorkspaceIds = [...new Set(normalizedWorkspaceIds)];
      if (uniqueWorkspaceIds.length === 0) {
        return { success: true };
      }
      const { ProactiveSuggestionsService } =
        await import("../agent/ProactiveSuggestionsService");
      await Promise.all(
        uniqueWorkspaceIds.map((workspaceId) =>
          ProactiveSuggestionsService.generateAll(workspaceId),
        ),
      );
      return { success: true };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SUGGESTIONS_DISMISS,
    async (_, workspaceId: string, suggestionId: string) => {
      checkRateLimit(IPC_CHANNELS.SUGGESTIONS_DISMISS);
      const validatedWorkspaceId = validateInput(
        WorkspaceIdSchema,
        workspaceId,
        "workspace ID",
      );
      const validatedSuggestionId = validateInput(
        UUIDSchema,
        suggestionId,
        "suggestion ID",
      );
      const { ProactiveSuggestionsService } =
        await import("../agent/ProactiveSuggestionsService");
      const success = ProactiveSuggestionsService.dismiss(
        validatedWorkspaceId,
        validatedSuggestionId,
      );
      return { success };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SUGGESTIONS_SNOOZE,
    async (_, workspaceId: string, suggestionId: string, snoozedUntil: number) => {
      checkRateLimit(IPC_CHANNELS.SUGGESTIONS_SNOOZE);
      const validatedWorkspaceId = validateInput(
        WorkspaceIdSchema,
        workspaceId,
        "workspace ID",
      );
      const validatedSuggestionId = validateInput(
        UUIDSchema,
        suggestionId,
        "suggestion ID",
      );
      const validatedSnoozedUntil =
        typeof snoozedUntil === "number" && Number.isFinite(snoozedUntil)
          ? Math.max(Date.now(), snoozedUntil)
          : Date.now() + 24 * 60 * 60 * 1000;
      const { ProactiveSuggestionsService } =
        await import("../agent/ProactiveSuggestionsService");
      const success = ProactiveSuggestionsService.snooze(
        validatedWorkspaceId,
        validatedSuggestionId,
        validatedSnoozedUntil,
      );
      return { success };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SUGGESTIONS_EDIT,
    async (_, workspaceId: string, suggestionId: string, editedPrompt: string) => {
      checkRateLimit(IPC_CHANNELS.SUGGESTIONS_EDIT);
      const validatedWorkspaceId = validateInput(
        WorkspaceIdSchema,
        workspaceId,
        "workspace ID",
      );
      const validatedSuggestionId = validateInput(
        UUIDSchema,
        suggestionId,
        "suggestion ID",
      );
      const validatedEditedPrompt = validateInput(
        z.string().trim().min(1).max(4000),
        editedPrompt,
        "edited suggestion prompt",
      );
      const { ProactiveSuggestionsService } =
        await import("../agent/ProactiveSuggestionsService");
      const success = ProactiveSuggestionsService.recordEditedAction(
        validatedWorkspaceId,
        validatedSuggestionId,
        validatedEditedPrompt,
      );
      return { success };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.SUGGESTIONS_ACT,
    async (_, workspaceId: string, suggestionId: string) => {
      checkRateLimit(IPC_CHANNELS.SUGGESTIONS_ACT);
      const validatedWorkspaceId = validateInput(
        WorkspaceIdSchema,
        workspaceId,
        "workspace ID",
      );
      const validatedSuggestionId = validateInput(
        UUIDSchema,
        suggestionId,
        "suggestion ID",
      );
      const { ProactiveSuggestionsService } =
        await import("../agent/ProactiveSuggestionsService");
      const actionPrompt = ProactiveSuggestionsService.actOn(
        validatedWorkspaceId,
        validatedSuggestionId,
      );
      return { actionPrompt };
    },
  );

  // Task Board handlers
  ipcMain.handle(
    IPC_CHANNELS.TASK_MOVE_COLUMN,
    async (_, taskId: string, column: string) => {
      checkRateLimit(IPC_CHANNELS.TASK_MOVE_COLUMN);
      const validatedId = validateInput(UUIDSchema, taskId, "task ID");
      const task = taskRepo.moveToColumn(validatedId, column);
      if (task) {
        getMainWindow()?.webContents.send(IPC_CHANNELS.TASK_BOARD_EVENT, {
          type: "moved",
          task,
          column,
        });
        const columnLabels: Record<string, string> = {
          backlog: "Inbox",
          todo: "Assigned",
          in_progress: "In Progress",
          review: "Review",
          done: "Done",
        };
        const activity = activityRepo.create({
          workspaceId: task.workspaceId,
          taskId: task.id,
          agentRoleId: task.assignedAgentRoleId,
          actorType: "system",
          activityType: "info",
          title: `Moved to ${columnLabels[column] || column}`,
          description: task.title,
        });
        getMainWindow()?.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, {
          type: "created",
          activity,
        });
      }
      return task;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_SET_PRIORITY,
    async (_, taskId: string, priority: number) => {
      checkRateLimit(IPC_CHANNELS.TASK_SET_PRIORITY);
      const validatedId = validateInput(UUIDSchema, taskId, "task ID");
      const task = taskRepo.setPriority(validatedId, priority);
      if (task) {
        getMainWindow()?.webContents.send(IPC_CHANNELS.TASK_BOARD_EVENT, {
          type: "priority_changed",
          task,
        });
      }
      return task;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_SET_DUE_DATE,
    async (_, taskId: string, dueDate: number | null) => {
      checkRateLimit(IPC_CHANNELS.TASK_SET_DUE_DATE);
      const validatedId = validateInput(UUIDSchema, taskId, "task ID");
      const task = taskRepo.setDueDate(validatedId, dueDate);
      if (task) {
        getMainWindow()?.webContents.send(IPC_CHANNELS.TASK_BOARD_EVENT, {
          type: "due_date_changed",
          task,
        });
      }
      return task;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_SET_ESTIMATE,
    async (_, taskId: string, minutes: number | null) => {
      checkRateLimit(IPC_CHANNELS.TASK_SET_ESTIMATE);
      const validatedId = validateInput(UUIDSchema, taskId, "task ID");
      const task = taskRepo.setEstimate(validatedId, minutes);
      if (task) {
        getMainWindow()?.webContents.send(IPC_CHANNELS.TASK_BOARD_EVENT, {
          type: "estimate_changed",
          task,
        });
      }
      return task;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_ADD_LABEL,
    async (_, taskId: string, labelId: string) => {
      checkRateLimit(IPC_CHANNELS.TASK_ADD_LABEL);
      const validatedTaskId = validateInput(UUIDSchema, taskId, "task ID");
      const validatedLabelId = validateInput(UUIDSchema, labelId, "label ID");
      const task = taskRepo.addLabel(validatedTaskId, validatedLabelId);
      if (task) {
        getMainWindow()?.webContents.send(IPC_CHANNELS.TASK_BOARD_EVENT, {
          type: "label_added",
          task,
          labelId: validatedLabelId,
        });
      }
      return task;
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TASK_REMOVE_LABEL,
    async (_, taskId: string, labelId: string) => {
      checkRateLimit(IPC_CHANNELS.TASK_REMOVE_LABEL);
      const validatedTaskId = validateInput(UUIDSchema, taskId, "task ID");
      const validatedLabelId = validateInput(UUIDSchema, labelId, "label ID");
      const task = taskRepo.removeLabel(validatedTaskId, validatedLabelId);
      if (task) {
        getMainWindow()?.webContents.send(IPC_CHANNELS.TASK_BOARD_EVENT, {
          type: "label_removed",
          task,
          labelId: validatedLabelId,
        });
      }
      return task;
    },
  );

  // Task Label handlers
  ipcMain.handle(
    IPC_CHANNELS.TASK_LABEL_LIST,
    async (_, queryOrWorkspaceId: Any) => {
      const workspaceId =
        typeof queryOrWorkspaceId === "string"
          ? queryOrWorkspaceId
          : queryOrWorkspaceId?.workspaceId;
      const validated = validateInput(UUIDSchema, workspaceId, "workspace ID");
      return taskLabelRepo.list({ workspaceId: validated });
    },
  );

  ipcMain.handle(IPC_CHANNELS.TASK_LABEL_CREATE, async (_, request: Any) => {
    checkRateLimit(IPC_CHANNELS.TASK_LABEL_CREATE);
    const validatedWorkspaceId = validateInput(
      UUIDSchema,
      request.workspaceId,
      "workspace ID",
    );
    return taskLabelRepo.create({
      ...request,
      workspaceId: validatedWorkspaceId,
    });
  });

  ipcMain.handle(
    IPC_CHANNELS.TASK_LABEL_UPDATE,
    async (_, id: string, request: Any) => {
      checkRateLimit(IPC_CHANNELS.TASK_LABEL_UPDATE);
      const validated = validateInput(UUIDSchema, id, "label ID");
      return taskLabelRepo.update(validated, request);
    },
  );

  ipcMain.handle(IPC_CHANNELS.TASK_LABEL_DELETE, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.TASK_LABEL_DELETE);
    const validated = validateInput(UUIDSchema, id, "label ID");
    return { success: taskLabelRepo.delete(validated) };
  });

  // Working State handlers
  ipcMain.handle(IPC_CHANNELS.WORKING_STATE_GET, async (_, id: string) => {
    const validated = validateInput(UUIDSchema, id, "working state ID");
    return workingStateRepo.findById(validated);
  });

  ipcMain.handle(
    IPC_CHANNELS.WORKING_STATE_GET_CURRENT,
    async (_, query: Any) => {
      const validatedAgentRoleId = validateInput(
        UUIDSchema,
        query.agentRoleId,
        "agent role ID",
      );
      const validatedWorkspaceId = validateInput(
        UUIDSchema,
        query.workspaceId,
        "workspace ID",
      );
      return workingStateRepo.getCurrent({
        agentRoleId: validatedAgentRoleId,
        workspaceId: validatedWorkspaceId,
        taskId: query.taskId,
        stateType: query.stateType,
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.WORKING_STATE_UPDATE, async (_, request: Any) => {
    checkRateLimit(IPC_CHANNELS.WORKING_STATE_UPDATE);
    const validatedAgentRoleId = validateInput(
      UUIDSchema,
      request.agentRoleId,
      "agent role ID",
    );
    const validatedWorkspaceId = validateInput(
      UUIDSchema,
      request.workspaceId,
      "workspace ID",
    );
    return workingStateRepo.update({
      agentRoleId: validatedAgentRoleId,
      workspaceId: validatedWorkspaceId,
      taskId: request.taskId,
      stateType: request.stateType,
      content: request.content,
      fileReferences: request.fileReferences,
    });
  });

  ipcMain.handle(IPC_CHANNELS.WORKING_STATE_HISTORY, async (_, query: Any) => {
    const validatedAgentRoleId = validateInput(
      UUIDSchema,
      query.agentRoleId,
      "agent role ID",
    );
    const validatedWorkspaceId = validateInput(
      UUIDSchema,
      query.workspaceId,
      "workspace ID",
    );
    return workingStateRepo.getHistory({
      agentRoleId: validatedAgentRoleId,
      workspaceId: validatedWorkspaceId,
      limit: query.limit,
      offset: query.offset,
    });
  });

  ipcMain.handle(IPC_CHANNELS.WORKING_STATE_RESTORE, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.WORKING_STATE_RESTORE);
    const validated = validateInput(UUIDSchema, id, "working state ID");
    return workingStateRepo.restore(validated);
  });

  ipcMain.handle(IPC_CHANNELS.WORKING_STATE_DELETE, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.WORKING_STATE_DELETE);
    const validated = validateInput(UUIDSchema, id, "working state ID");
    return { success: workingStateRepo.delete(validated) };
  });

  ipcMain.handle(
    IPC_CHANNELS.WORKING_STATE_LIST_FOR_TASK,
    async (_, taskId: string) => {
      const validated = validateInput(UUIDSchema, taskId, "task ID");
      return workingStateRepo.listForTask(validated);
    },
  );

  // Context Policy handlers (per-context security DM vs group)
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_POLICY_GET,
    async (_, channelId: string, contextType: string) => {
      return contextPolicyManager.getPolicy(
        channelId,
        contextType as "dm" | "group",
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_POLICY_GET_FOR_CHAT,
    async (_, channelId: string, chatId: string, isGroup: boolean) => {
      return contextPolicyManager.getPolicyForChat(channelId, chatId, isGroup);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_POLICY_LIST,
    async (_, channelId: string) => {
      return contextPolicyManager.getPoliciesForChannel(channelId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_POLICY_UPDATE,
    async (
      _,
      channelId: string,
      contextType: string,
      options: { securityMode?: string; toolRestrictions?: string[] },
    ) => {
      checkRateLimit(IPC_CHANNELS.CONTEXT_POLICY_UPDATE);
      return contextPolicyManager.updateByContext(
        channelId,
        contextType as "dm" | "group",
        {
          securityMode: options.securityMode as
            | "open"
            | "allowlist"
            | "pairing"
            | undefined,
          toolRestrictions: options.toolRestrictions,
        },
      );
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_POLICY_DELETE,
    async (_, channelId: string) => {
      checkRateLimit(IPC_CHANNELS.CONTEXT_POLICY_DELETE);
      return { count: contextPolicyManager.deleteByChannel(channelId) };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_POLICY_CREATE_DEFAULTS,
    async (_, channelId: string) => {
      checkRateLimit(IPC_CHANNELS.CONTEXT_POLICY_CREATE_DEFAULTS);
      contextPolicyManager.createDefaultPolicies(channelId);
      return { success: true };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_POLICY_IS_TOOL_ALLOWED,
    async (
      _,
      channelId: string,
      contextType: string,
      toolName: string,
      toolGroups: string[],
    ) => {
      return {
        allowed: contextPolicyManager.isToolAllowed(
          channelId,
          contextType as "dm" | "group",
          toolName,
          toolGroups,
        ),
      };
    },
  );

  // Queue handlers
  ipcMain.handle(IPC_CHANNELS.QUEUE_GET_STATUS, async () => {
    return agentDaemon.getQueueStatus();
  });

  ipcMain.handle(IPC_CHANNELS.QUEUE_GET_SETTINGS, async () => {
    return agentDaemon.getQueueSettings();
  });

  ipcMain.handle(IPC_CHANNELS.QUEUE_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.QUEUE_SAVE_SETTINGS);
    agentDaemon.saveQueueSettings(settings);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.QUEUE_CLEAR, async () => {
    checkRateLimit(IPC_CHANNELS.QUEUE_CLEAR);
    const result = await agentDaemon.clearStuckTasks();
    return { success: true, ...result };
  });

  // Health handlers
  setupHealthHandlers();

  // MCP handlers
  setupMCPHandlers();

  // Infrastructure handlers
  setupInfraHandlers();

  // Scraping (Scrapling) handlers
  setupScrapingHandlers();

  // Local AI (hf-agents / llama.cpp) handlers
  setupLocalAIHandlers();

  // Notification handlers
  setupNotificationHandlers();

  // Hooks (Webhooks & Gmail Pub/Sub) handlers
  await setupHooksHandlers(agentDaemon);

  // Workspace kit (.cowork) handlers
  setupKitHandlers(workspaceRepo, agentDaemon);

  // Memory system handlers
  setupMemoryHandlers();
}

/**
 * Set up Health IPC handlers
 */
export function setupHealthHandlers(): void {
  rateLimiter.configure(
    IPC_CHANNELS.HEALTH_UPSERT_SOURCE,
    RATE_LIMIT_CONFIGS.limited,
  );
  rateLimiter.configure(
    IPC_CHANNELS.HEALTH_REMOVE_SOURCE,
    RATE_LIMIT_CONFIGS.limited,
  );
  rateLimiter.configure(
    IPC_CHANNELS.HEALTH_SYNC_SOURCE,
    RATE_LIMIT_CONFIGS.standard,
  );
  rateLimiter.configure(
    IPC_CHANNELS.HEALTH_IMPORT_FILES,
    RATE_LIMIT_CONFIGS.limited,
  );
  rateLimiter.configure(
    IPC_CHANNELS.HEALTH_GENERATE_WORKFLOW,
    RATE_LIMIT_CONFIGS.expensive,
  );
  rateLimiter.configure(
    IPC_CHANNELS.HEALTH_APPLE_CONNECT,
    RATE_LIMIT_CONFIGS.expensive,
  );
  rateLimiter.configure(
    IPC_CHANNELS.HEALTH_APPLE_DISCONNECT,
    RATE_LIMIT_CONFIGS.limited,
  );
  rateLimiter.configure(
    IPC_CHANNELS.HEALTH_APPLE_PREVIEW_WRITEBACK,
    RATE_LIMIT_CONFIGS.standard,
  );
  rateLimiter.configure(
    IPC_CHANNELS.HEALTH_APPLE_APPLY_WRITEBACK,
    RATE_LIMIT_CONFIGS.expensive,
  );

  ipcMain.handle(IPC_CHANNELS.HEALTH_GET_DASHBOARD, async (): Promise<Any> => {
    return HealthManager.getDashboard();
  });

  ipcMain.handle(IPC_CHANNELS.HEALTH_LIST_SOURCES, async (): Promise<Any> => {
    return HealthManager.listSources();
  });

  ipcMain.handle(IPC_CHANNELS.HEALTH_UPSERT_SOURCE, async (_, source: Any) => {
    checkRateLimit(IPC_CHANNELS.HEALTH_UPSERT_SOURCE);
    const validated = validateInput(
      HealthSourceInputSchema,
      source,
      "health source",
    );
    return HealthManager.upsertSource(validated);
  });

  ipcMain.handle(
    IPC_CHANNELS.HEALTH_REMOVE_SOURCE,
    async (_, sourceId: string) => {
      checkRateLimit(IPC_CHANNELS.HEALTH_REMOVE_SOURCE);
      const validated = validateInput(
        StringIdSchema,
        sourceId,
        "health source ID",
      );
      return HealthManager.removeSource(validated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.HEALTH_SYNC_SOURCE,
    async (_, sourceId: string) => {
      checkRateLimit(IPC_CHANNELS.HEALTH_SYNC_SOURCE);
      const validated = validateInput(
        StringIdSchema,
        sourceId,
        "health source ID",
      );
      return HealthManager.syncSource(validated);
    },
  );

  ipcMain.handle(IPC_CHANNELS.HEALTH_IMPORT_FILES, async (_, request: Any) => {
    checkRateLimit(IPC_CHANNELS.HEALTH_IMPORT_FILES);
    const validated = validateInput(
      HealthImportFilesSchema,
      request,
      "health import request",
    );
    return HealthManager.importFiles(validated.sourceId, validated.filePaths);
  });

  ipcMain.handle(
    IPC_CHANNELS.HEALTH_GENERATE_WORKFLOW,
    async (_, request: Any) => {
      checkRateLimit(IPC_CHANNELS.HEALTH_GENERATE_WORKFLOW);
      const validated = validateInput(
        HealthWorkflowRequestSchema,
        request,
        "health workflow request",
      );
      return HealthManager.generateWorkflow(validated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.HEALTH_APPLE_STATUS,
    async (_, sourceId?: string) => {
      return HealthManager.getAppleHealthStatus(sourceId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.HEALTH_APPLE_CONNECT, async (_, request: Any) => {
    checkRateLimit(IPC_CHANNELS.HEALTH_APPLE_CONNECT);
    const validated = validateInput(
      z
        .object({
          sourceId: StringIdSchema.optional(),
          connectionMode: z.enum(["native", "import"]).optional(),
        })
        .strict(),
      request,
      "Apple Health connect request",
    );
    return HealthManager.connectAppleHealth(validated);
  });

  ipcMain.handle(
    IPC_CHANNELS.HEALTH_APPLE_DISCONNECT,
    async (_, sourceId: string) => {
      checkRateLimit(IPC_CHANNELS.HEALTH_APPLE_DISCONNECT);
      const validated = validateInput(
        StringIdSchema,
        sourceId,
        "Apple Health source ID",
      );
      return HealthManager.disconnectAppleHealth(validated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.HEALTH_APPLE_RESET,
    async (_, sourceId?: string) => {
      checkRateLimit(IPC_CHANNELS.HEALTH_APPLE_DISCONNECT);
      const validated = sourceId
        ? validateInput(StringIdSchema, sourceId, "Apple Health source ID")
        : undefined;
      return HealthManager.resetAppleHealth(validated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.HEALTH_APPLE_PREVIEW_WRITEBACK,
    async (_, request: Any) => {
      checkRateLimit(IPC_CHANNELS.HEALTH_APPLE_PREVIEW_WRITEBACK);
      const validated = validateInput(
        HealthWritebackRequestSchema,
        request,
        "Apple Health writeback request",
      );
      return HealthManager.previewAppleHealthWriteback(validated);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.HEALTH_APPLE_APPLY_WRITEBACK,
    async (_, request: Any) => {
      checkRateLimit(IPC_CHANNELS.HEALTH_APPLE_APPLY_WRITEBACK);
      const validated = validateInput(
        HealthWritebackRequestSchema,
        request,
        "Apple Health writeback request",
      );
      return HealthManager.applyAppleHealthWriteback(validated);
    },
  );
}

/**
 * Set up MCP (Model Context Protocol) IPC handlers
 */
function setupMCPHandlers(): void {
  // Configure rate limits for MCP channels
  rateLimiter.configure(
    IPC_CHANNELS.MCP_SAVE_SETTINGS,
    RATE_LIMIT_CONFIGS.limited,
  );
  rateLimiter.configure(
    IPC_CHANNELS.MCP_CONNECT_SERVER,
    RATE_LIMIT_CONFIGS.expensive,
  );
  rateLimiter.configure(
    IPC_CHANNELS.MCP_TEST_SERVER,
    RATE_LIMIT_CONFIGS.expensive,
  );
  rateLimiter.configure(
    IPC_CHANNELS.MCP_REGISTRY_INSTALL,
    RATE_LIMIT_CONFIGS.expensive,
  );
  rateLimiter.configure(
    IPC_CHANNELS.MCP_CONNECTOR_OAUTH_START,
    RATE_LIMIT_CONFIGS.expensive,
  );

  // Initialize MCP settings manager
  MCPSettingsManager.initialize();

  // Get settings
  ipcMain.handle(IPC_CHANNELS.MCP_GET_SETTINGS, async () => {
    return MCPSettingsManager.getSettingsForDisplay();
  });

  // Save settings
  ipcMain.handle(IPC_CHANNELS.MCP_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.MCP_SAVE_SETTINGS);
    const validated = validateInput(
      MCPSettingsSchema,
      settings,
      "MCP settings",
    ) as MCPSettings;
    MCPSettingsManager.saveSettings(validated);
    MCPSettingsManager.clearCache();
    return { success: true };
  });

  // Get all servers
  ipcMain.handle(IPC_CHANNELS.MCP_GET_SERVERS, async () => {
    const settings = MCPSettingsManager.loadSettings();
    return settings.servers;
  });

  // Add a server
  ipcMain.handle(IPC_CHANNELS.MCP_ADD_SERVER, async (_, serverConfig) => {
    checkRateLimit(IPC_CHANNELS.MCP_ADD_SERVER);
    const validated = validateInput(
      MCPServerConfigSchema,
      serverConfig,
      "MCP server config",
    );
    const { id: _id, ...configWithoutId } = validated;
    return MCPSettingsManager.addServer(
      configWithoutId as Omit<MCPServerConfig, "id">,
    );
  });

  // Update a server
  ipcMain.handle(
    IPC_CHANNELS.MCP_UPDATE_SERVER,
    async (_, serverId: string, updates) => {
      const validatedId = validateInput(UUIDSchema, serverId, "server ID");
      const validatedUpdates = validateInput(
        MCPServerUpdateSchema,
        updates,
        "server updates",
      ) as Partial<MCPServerConfig>;
      return MCPSettingsManager.updateServer(validatedId, validatedUpdates);
    },
  );

  // Remove a server
  ipcMain.handle(
    IPC_CHANNELS.MCP_REMOVE_SERVER,
    async (_, serverId: string) => {
      const validatedId = validateInput(UUIDSchema, serverId, "server ID");

      // Disconnect if connected
      try {
        await MCPClientManager.getInstance().disconnectServer(validatedId);
      } catch {
        // Ignore errors
      }

      return MCPSettingsManager.removeServer(validatedId);
    },
  );

  // Connect to a server
  ipcMain.handle(
    IPC_CHANNELS.MCP_CONNECT_SERVER,
    async (_, serverId: string) => {
      checkRateLimit(IPC_CHANNELS.MCP_CONNECT_SERVER);
      const validatedId = validateInput(UUIDSchema, serverId, "server ID");
      await MCPClientManager.getInstance().connectServer(validatedId);
      return { success: true };
    },
  );

  // Disconnect from a server
  ipcMain.handle(
    IPC_CHANNELS.MCP_DISCONNECT_SERVER,
    async (_, serverId: string) => {
      const validatedId = validateInput(UUIDSchema, serverId, "server ID");
      await MCPClientManager.getInstance().disconnectServer(validatedId);
      return { success: true };
    },
  );

  // Get status of all servers
  ipcMain.handle(IPC_CHANNELS.MCP_GET_STATUS, async () => {
    return MCPClientManager.getInstance().getStatus();
  });

  // Get status of a single server
  ipcMain.handle(
    IPC_CHANNELS.MCP_GET_SERVER_STATUS,
    async (_, serverId: string) => {
      const validatedId = validateInput(UUIDSchema, serverId, "server ID");
      return MCPClientManager.getInstance().getServerStatus(validatedId);
    },
  );

  // Get tools from a specific server
  ipcMain.handle(
    IPC_CHANNELS.MCP_GET_SERVER_TOOLS,
    async (_, serverId: string) => {
      const validatedId = validateInput(UUIDSchema, serverId, "server ID");
      return MCPClientManager.getInstance().getServerTools(validatedId);
    },
  );

  // Get tools from all servers
  ipcMain.handle(IPC_CHANNELS.MCP_GET_ALL_TOOLS, async () => {
    return MCPClientManager.getInstance().getAllTools();
  });

  // Test server connection
  ipcMain.handle(IPC_CHANNELS.MCP_TEST_SERVER, async (_, serverId: string) => {
    checkRateLimit(IPC_CHANNELS.MCP_TEST_SERVER);
    const validatedId = validateInput(UUIDSchema, serverId, "server ID");
    return MCPClientManager.getInstance().testServer(validatedId);
  });

  // MCP Registry handlers
  ipcMain.handle(IPC_CHANNELS.MCP_REGISTRY_FETCH, async () => {
    const registry = await MCPRegistryManager.fetchRegistry();
    const categories = await MCPRegistryManager.getCategories();
    const featured = registry.servers.filter((s) => s.featured);
    return { ...registry, categories, featured };
  });

  ipcMain.handle(IPC_CHANNELS.MCP_REGISTRY_SEARCH, async (_, options) => {
    const validatedOptions = validateInput(
      MCPRegistrySearchSchema,
      options,
      "registry search options",
    );
    return MCPRegistryManager.searchServers(validatedOptions);
  });

  ipcMain.handle(
    IPC_CHANNELS.MCP_REGISTRY_INSTALL,
    async (_, entryId: string) => {
      checkRateLimit(IPC_CHANNELS.MCP_REGISTRY_INSTALL);
      const validatedId = validateInput(
        StringIdSchema,
        entryId,
        "registry entry ID",
      );
      return MCPRegistryManager.installServer(validatedId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MCP_REGISTRY_UNINSTALL,
    async (_, serverId: string) => {
      const validatedId = validateInput(UUIDSchema, serverId, "server ID");

      // Disconnect if connected
      try {
        await MCPClientManager.getInstance().disconnectServer(validatedId);
      } catch {
        // Ignore errors
      }

      await MCPRegistryManager.uninstallServer(validatedId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.MCP_REGISTRY_CHECK_UPDATES, async () => {
    return MCPRegistryManager.checkForUpdates();
  });

  ipcMain.handle(
    IPC_CHANNELS.MCP_REGISTRY_UPDATE_SERVER,
    async (_, serverId: string) => {
      const validatedId = validateInput(UUIDSchema, serverId, "server ID");
      return MCPRegistryManager.updateServer(validatedId);
    },
  );

  // MCP Connector OAuth (Salesforce/Jira)
  ipcMain.handle(IPC_CHANNELS.MCP_CONNECTOR_OAUTH_START, async (_, payload) => {
    checkRateLimit(IPC_CHANNELS.MCP_CONNECTOR_OAUTH_START);
    const validated = validateInput(
      MCPConnectorOAuthSchema,
      payload,
      "connector oauth",
    );
    return startConnectorOAuth(validated);
  });

  // MCP Host handlers
  ipcMain.handle(
    IPC_CHANNELS.MCP_HOST_START,
    async (_, requestedPort?: number) => {
      const hostServer = MCPHostServer.getInstance();

      // If no tool provider is set, create a minimal one that exposes MCP tools
      // from connected servers (useful for tool aggregation/forwarding)
      if (!hostServer.hasToolProvider()) {
        const hostDb = DatabaseManager.getInstance().getDatabase();
        const hostWorkspaceRepo = new WorkspaceRepository(hostDb);
        const hostTaskRepo = new TaskRepository(hostDb);
        const hostTaskEventRepo = new TaskEventRepository(hostDb);
        const hostArtifactRepo = new ArtifactRepository(hostDb);
        const mcpClientManager = MCPClientManager.getInstance();
        hostServer.setToolProvider(
          new CoWorkHostProvider({
            workspaceRepo: hostWorkspaceRepo,
            taskRepo: hostTaskRepo,
            taskEventRepo: hostTaskEventRepo,
            artifactRepo: hostArtifactRepo,
            toolDelegate: {
              getTools() {
                return mcpClientManager.getAllTools();
              },
              async executeTool(name: string, args: Record<string, Any>) {
                return mcpClientManager.callTool(name, args);
              },
            },
          }),
        );
      }

      if (
        typeof requestedPort === "number" &&
        Number.isFinite(requestedPort) &&
        requestedPort >= 1024
      ) {
        await hostServer.startHttp(Math.floor(requestedPort));
        return {
          success: true,
          transport: "http",
          port: hostServer.getHttpPort(),
        };
      }

      await hostServer.startStdio();
      return { success: true, transport: "stdio" };
    },
  );

  ipcMain.handle(IPC_CHANNELS.MCP_HOST_STOP, async () => {
    const hostServer = MCPHostServer.getInstance();
    await hostServer.stop();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.MCP_HOST_GET_STATUS, async () => {
    const hostServer = MCPHostServer.getInstance();
    return {
      running: hostServer.isRunning(),
      transport: hostServer.getTransportMode(),
      port: hostServer.getHttpPort(),
      toolCount: hostServer.hasToolProvider()
        ? MCPClientManager.getInstance().getAllTools().length
        : 0,
    };
  });

  // =====================
  // Built-in Tools Settings Handlers
  // =====================

  ipcMain.handle(IPC_CHANNELS.BUILTIN_TOOLS_GET_SETTINGS, async () => {
    return BuiltinToolsSettingsManager.loadSettings();
  });

  ipcMain.handle(
    IPC_CHANNELS.BUILTIN_TOOLS_SAVE_SETTINGS,
    async (_, settings) => {
      BuiltinToolsSettingsManager.saveSettings(settings);
      BuiltinToolsSettingsManager.clearCache(); // Clear cache to force reload
      return { success: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS.BUILTIN_TOOLS_GET_CATEGORIES, async () => {
    return BuiltinToolsSettingsManager.getToolsByCategory();
  });

  ipcMain.handle(IPC_CHANNELS.CHRONICLE_GET_SETTINGS, async (): Promise<ChronicleSettings> => {
    return ChronicleSettingsManager.loadSettings();
  });

  ipcMain.handle(
    IPC_CHANNELS.CHRONICLE_SAVE_SETTINGS,
    async (_, settings: Partial<ChronicleSettings>) => {
      const next = ChronicleSettingsManager.saveSettings(settings || {});
      await ChronicleCaptureService.getInstance().applySettings(next);
      ChronicleMemoryService.getInstance().applySettings(next);
      return { success: true, settings: next };
    },
  );

  ipcMain.handle(IPC_CHANNELS.CHRONICLE_GET_STATUS, async (): Promise<ChronicleCaptureStatus> => {
    return ChronicleCaptureService.getInstance().getStatus();
  });

  ipcMain.handle(
    IPC_CHANNELS.CHRONICLE_QUERY_RECENT_CONTEXT,
    async (
      _,
      input: {
        query: string;
        limit?: number;
        useFallback?: boolean;
      },
    ): Promise<ChronicleResolvedContext[]> => {
      return ChronicleCaptureService.getInstance().queryRecentContext({
        query: input?.query || "",
        limit: input?.limit,
        useFallback: input?.useFallback,
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CHRONICLE_LIST_OBSERVATIONS,
    async (
      _,
      input: {
        workspaceId: string;
        limit?: number;
      },
    ) => {
      const workspace = new WorkspaceRepository(DatabaseManager.getInstance().getDatabase()).findById(
        String(input?.workspaceId || ""),
      );
      if (!workspace) return [];
      return ChronicleObservationRepository.list(workspace.path, input?.limit || 50);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CHRONICLE_DELETE_OBSERVATION,
    async (
      _,
      input: {
        workspaceId: string;
        observationId: string;
      },
    ) => {
      const workspace = new WorkspaceRepository(DatabaseManager.getInstance().getDatabase()).findById(
        String(input?.workspaceId || ""),
      );
      if (!workspace) return { success: false };
      const record = ChronicleObservationRepository.listSync(workspace.path, 10_000).find(
        (entry) => entry.id === input?.observationId,
      );
      if (record?.memoryId) {
        MemoryService.deleteEntries(workspace.id, [record.memoryId]);
      }
      const success = await ChronicleObservationRepository.deleteObservation(
        workspace.path,
        String(input?.observationId || ""),
      );
      return { success };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CHRONICLE_CLEAR_OBSERVATIONS,
    async (_, input: { workspaceId: string }) => {
      const workspace = new WorkspaceRepository(DatabaseManager.getInstance().getDatabase()).findById(
        String(input?.workspaceId || ""),
      );
      if (!workspace) return { success: false };
      const observations = ChronicleObservationRepository.listSync(workspace.path, 10_000);
      const memoryIds = observations.map((entry) => entry.memoryId).filter(Boolean) as string[];
      if (memoryIds.length > 0) {
        MemoryService.deleteEntries(workspace.id, memoryIds);
      }
      await ChronicleObservationRepository.clearWorkspace(workspace.path);
      return { success: true, deleted: observations.length };
    },
  );

  // =====================
  // Computer use (desktop automation)
  // =====================

  ipcMain.handle(IPC_CHANNELS.COMPUTER_USE_GET_STATUS, async () => {
    const sm = ComputerUseSessionManager.getInstance();
    const helperStatus = await ComputerUseHelperRuntime.getInstance().getStatus();
    return {
      activeTaskId: sm.getActiveTaskId(),
      helperPath: helperStatus.helperPath,
      sourcePath: helperStatus.sourcePath,
      installed: helperStatus.installed,
      accessibilityTrusted: helperStatus.accessibility,
      screenCaptureStatus: helperStatus.screenRecording ? "granted" : "denied",
      error: helperStatus.error ?? null,
    };
  });

  ipcMain.handle(IPC_CHANNELS.COMPUTER_USE_END_SESSION, async () => {
    await ComputerUseSessionManager.getInstance().endSessionManual();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.COMPUTER_USE_OPEN_ACCESSIBILITY, async () => {
    if (process.platform === "darwin") {
      await ComputerUseHelperRuntime.getInstance().openPermissionPane("accessibility");
    }
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.COMPUTER_USE_OPEN_SCREEN_RECORDING, async () => {
    if (process.platform === "darwin") {
      await ComputerUseHelperRuntime.getInstance().openPermissionPane("screenRecording");
    }
    return { success: true };
  });

  // =====================
  // Tray (Menu Bar) Handlers
  // =====================

  ipcMain.handle(IPC_CHANNELS.TRAY_GET_SETTINGS, async () => {
    // Import trayManager lazily to avoid circular dependencies
    const { trayManager } = await import("../tray");
    return trayManager.getSettings();
  });

  ipcMain.handle(IPC_CHANNELS.TRAY_SAVE_SETTINGS, async (_, settings) => {
    const { trayManager } = await import("../tray");
    trayManager.saveSettings(settings);
    return { success: true, settings: trayManager.getSettings() };
  });

  // =====================
  // Cron (Scheduled Tasks) Handlers
  // =====================
  setupCronHandlers();
  setupCouncilHandlers();
}

/**
 * Set up Infrastructure IPC handlers
 */
function setupInfraHandlers(): void {
  rateLimiter.configure(
    IPC_CHANNELS.INFRA_SAVE_SETTINGS,
    RATE_LIMIT_CONFIGS.limited,
  );
  rateLimiter.configure(IPC_CHANNELS.INFRA_SETUP, RATE_LIMIT_CONFIGS.expensive);
  rateLimiter.configure(IPC_CHANNELS.INFRA_RESET, RATE_LIMIT_CONFIGS.expensive);

  ipcMain.handle(IPC_CHANNELS.INFRA_GET_STATUS, async () => {
    return InfraManager.getInstance().getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.INFRA_GET_SETTINGS, async () => {
    return InfraSettingsManager.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.INFRA_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.INFRA_SAVE_SETTINGS);
    const validated = validateInput(
      InfraSettingsSchema,
      settings,
      "Infrastructure settings",
    );
    InfraSettingsManager.saveSettings(validated);
    InfraSettingsManager.clearCache();
    // Re-apply settings to providers
    await InfraManager.getInstance().applySettings(validated);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.INFRA_SETUP, async () => {
    checkRateLimit(IPC_CHANNELS.INFRA_SETUP);
    return InfraManager.getInstance().setup();
  });

  ipcMain.handle(IPC_CHANNELS.INFRA_GET_WALLET, async () => {
    return InfraManager.getInstance().getWalletInfo();
  });

  ipcMain.handle(IPC_CHANNELS.INFRA_WALLET_RESTORE, async () => {
    const settings = InfraSettingsManager.loadSettings();
    if (settings.wallet.provider === "coinbase_agentic") {
      await InfraManager.getInstance().applySettings(settings);
      const wallet =
        await InfraManager.getInstance().getWalletInfoWithBalance();
      return {
        success: !!wallet?.address,
        address: wallet?.address || undefined,
        status: wallet?.address ? "ok" : "no_wallet",
      };
    }

    // Attempt to migrate/restore wallet
    const check = WalletManager.startupCheck();
    return {
      success: !!check.address,
      address: check.address || undefined,
      status: check.status,
    };
  });

  ipcMain.handle(IPC_CHANNELS.INFRA_WALLET_VERIFY, async () => {
    const settings = InfraSettingsManager.loadSettings();
    if (settings.wallet.provider === "coinbase_agentic") {
      await InfraManager.getInstance().applySettings(settings);
      const wallet =
        await InfraManager.getInstance().getWalletInfoWithBalance();
      return {
        status: wallet?.address ? "ok" : "no_wallet",
        address: wallet?.address || undefined,
      };
    }

    const hasWallet = WalletManager.hasWallet();
    return {
      status: hasWallet ? "ok" : "no_wallet",
      address: WalletManager.getAddress() || undefined,
    };
  });

  ipcMain.handle(IPC_CHANNELS.INFRA_RESET, async () => {
    checkRateLimit(IPC_CHANNELS.INFRA_RESET);
    await InfraManager.getInstance().reset();
    return { success: true };
  });
}

/**
 * Set up Scraping (Scrapling integration) IPC handlers
 */
function setupScrapingHandlers(): void {
  // oxlint-disable-next-line typescript-eslint(no-require-imports)
  const { ScrapingSettingsManager } = require("../scraping/scraping-settings");
  // oxlint-disable-next-line typescript-eslint(no-require-imports)
  const { spawn } = require("child_process");
  // oxlint-disable-next-line typescript-eslint(no-require-imports)
  const _path = require("path");

  ipcMain.handle(IPC_CHANNELS.SCRAPING_GET_SETTINGS, async () => {
    return ScrapingSettingsManager.loadSettings();
  });

  ipcMain.handle(
    IPC_CHANNELS.SCRAPING_SAVE_SETTINGS,
    async (_: Any, settings: Any) => {
      ScrapingSettingsManager.saveSettings(settings);
      return { success: true };
    },
  );

  ipcMain.handle(IPC_CHANNELS.SCRAPING_GET_STATUS, async () => {
    const settings = ScrapingSettingsManager.loadSettings();
    // Check if Python and Scrapling are available
    return new Promise((resolve) => {
      const pythonPath = settings.pythonPath || "python3";
      const child = spawn(pythonPath, [
        "-c",
        "import scrapling; print(getattr(scrapling, '__version__', 'unknown'))",
      ]);

      let stdout = "";
      let stderr = "";

      child.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });
      child.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      child.on("error", () => {
        resolve({
          installed: false,
          pythonAvailable: false,
          version: null,
          error: `Python not found at '${pythonPath}'`,
        });
      });

      child.on("close", (code: number | null) => {
        if (code === 0) {
          resolve({
            installed: true,
            pythonAvailable: true,
            version: stdout.trim(),
          });
        } else {
          resolve({
            installed: false,
            pythonAvailable: true,
            version: null,
            error: stderr.trim() || "Scrapling not installed",
          });
        }
      });

      // Timeout after 10 seconds
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // ignore
        }
        resolve({
          installed: false,
          pythonAvailable: false,
          version: null,
          error: "Status check timed out",
        });
      }, 10000);
    });
  });

  ipcMain.handle(IPC_CHANNELS.SCRAPING_RESET, async () => {
    ScrapingSettingsManager.resetSettings();
    return { success: true };
  });
}

/**
 * Set up Cron (Scheduled Tasks) IPC handlers
 */
function setupCronHandlers(): void {
  // oxlint-disable-next-line typescript-eslint(no-require-imports)
  const { getCronService } = require("../cron");

  // Get service status
  ipcMain.handle(IPC_CHANNELS.CRON_GET_STATUS, async () => {
    const service = getCronService();
    if (!service) {
      return {
        enabled: false,
        storePath: "",
        jobCount: 0,
        enabledJobCount: 0,
        nextWakeAtMs: null,
      };
    }
    return service.status();
  });

  // List all jobs
  ipcMain.handle(
    IPC_CHANNELS.CRON_LIST_JOBS,
    async (_, opts?: { includeDisabled?: boolean }) => {
      const service = getCronService();
      if (!service) return [];
      return service.list(opts);
    },
  );

  // Get a single job
  ipcMain.handle(IPC_CHANNELS.CRON_GET_JOB, async (_, id: string) => {
    const service = getCronService();
    if (!service) return null;
    return service.get(id);
  });

  // Add a new job
  ipcMain.handle(IPC_CHANNELS.CRON_ADD_JOB, async (_, jobData) => {
    const service = getCronService();
    if (!service) {
      return { ok: false, error: "Cron service not initialized" };
    }
    return service.add(jobData);
  });

  // Update an existing job
  ipcMain.handle(IPC_CHANNELS.CRON_UPDATE_JOB, async (_, id: string, patch) => {
    const service = getCronService();
    if (!service) {
      return { ok: false, error: "Cron service not initialized" };
    }
    return service.update(id, patch);
  });

  // Remove a job
  ipcMain.handle(IPC_CHANNELS.CRON_REMOVE_JOB, async (_, id: string) => {
    const service = getCronService();
    if (!service) {
      return {
        ok: false,
        removed: false,
        error: "Cron service not initialized",
      };
    }
    return service.remove(id);
  });

  // Run a job immediately
  ipcMain.handle(
    IPC_CHANNELS.CRON_RUN_JOB,
    async (_, id: string, mode?: "due" | "force") => {
      const service = getCronService();
      if (!service) {
        return { ok: false, error: "Cron service not initialized" };
      }
      return service.run(id, mode);
    },
  );

  // Get run history for a job
  ipcMain.handle(IPC_CHANNELS.CRON_GET_RUN_HISTORY, async (_, id: string) => {
    const service = getCronService();
    if (!service) return null;
    return service.getRunHistory(id);
  });

  // Clear run history for a job
  ipcMain.handle(IPC_CHANNELS.CRON_CLEAR_RUN_HISTORY, async (_, id: string) => {
    const service = getCronService();
    if (!service) return false;
    return service.clearRunHistory(id);
  });

  // Get webhook status
  ipcMain.handle(IPC_CHANNELS.CRON_GET_WEBHOOK_STATUS, async () => {
    const service = getCronService();
    if (!service) return { enabled: false };
    const status = await service.status();
    return status.webhook ?? { enabled: false };
  });
}

function setupCouncilHandlers(): void {
  const ListCouncilsSchema = z
    .object({ workspaceId: WorkspaceIdSchema })
    .strict();
  const CouncilParticipantSchema = z
    .object({
      providerType: z.enum(LLM_PROVIDER_TYPES),
      modelKey: z.string().trim().min(1),
      seatLabel: z.string().trim().min(1),
      roleInstruction: z.string().optional(),
    })
    .strict();
  const CouncilFileSourceSchema = z
    .object({
      path: z.string().trim().min(1),
      label: z.string().optional(),
    })
    .strict();
  const CouncilUrlSourceSchema = z
    .object({
      url: z.string().trim().min(1),
      label: z.string().optional(),
    })
    .strict();
  const CouncilConnectorSourceSchema = z
    .object({
      provider: z.string().trim().min(1),
      label: z.string().trim().min(1),
      resourceId: z.string().optional(),
      notes: z.string().optional(),
    })
    .strict();
  const CouncilSourceBundleSchema = z
    .object({
      files: z.array(CouncilFileSourceSchema).default([]),
      urls: z.array(CouncilUrlSourceSchema).default([]),
      connectors: z.array(CouncilConnectorSourceSchema).default([]),
    })
    .strict();
  const CouncilDeliverySchema = z
    .object({
      enabled: z.boolean().default(false),
      channelType: z.enum(CHANNEL_TYPES).optional(),
      channelDbId: z.string().optional(),
      channelId: z.string().optional(),
    })
    .strict();
  const CouncilExecutionPolicySchema = z
    .object({
      mode: z.enum(["auto", "full_parallel", "capped_local"]).default("auto"),
      maxParallelParticipants: z.number().int().positive().optional(),
    })
    .strict();
  const CronScheduleSchema = z.union([
    z
      .object({
        kind: z.literal("cron"),
        expr: z.string().trim().min(1),
        tz: z.string().optional(),
      })
      .strict(),
    z
      .object({
        kind: z.literal("every"),
        everyMs: z.number().int().positive(),
        anchorMs: z.number().int().optional(),
      })
      .strict(),
    z
      .object({ kind: z.literal("at"), atMs: z.number().int().positive() })
      .strict(),
  ]);
  const CouncilCreateSchema = z
    .object({
      workspaceId: WorkspaceIdSchema,
      name: z.string().trim().min(1),
      enabled: z.boolean().optional(),
      schedule: CronScheduleSchema,
      participants: z.array(CouncilParticipantSchema).min(2).max(8),
      judgeSeatIndex: z.number().int().min(0),
      rotatingIdeaSeatIndex: z.number().int().min(0).optional(),
      sourceBundle: CouncilSourceBundleSchema.optional(),
      deliveryConfig: CouncilDeliverySchema.optional(),
      executionPolicy: CouncilExecutionPolicySchema.optional(),
    })
    .strict();
  const CouncilUpdateSchema = z
    .object({
      id: StringIdSchema,
      name: z.string().trim().min(1).optional(),
      enabled: z.boolean().optional(),
      schedule: CronScheduleSchema.optional(),
      participants: z.array(CouncilParticipantSchema).min(2).max(8).optional(),
      judgeSeatIndex: z.number().int().min(0).optional(),
      rotatingIdeaSeatIndex: z.number().int().min(0).optional(),
      sourceBundle: CouncilSourceBundleSchema.optional(),
      deliveryConfig: CouncilDeliverySchema.optional(),
      executionPolicy: CouncilExecutionPolicySchema.optional(),
      managedCronJobId: z.string().nullable().optional(),
      nextIdeaSeatIndex: z.number().int().min(0).optional(),
    })
    .strict();
  const CouncilMemoQuerySchema = z.union([
    StringIdSchema,
    z
      .object({
        id: z.string().optional(),
        councilConfigId: z.string().optional(),
      })
      .strict(),
  ]);

  ipcMain.handle(IPC_CHANNELS.COUNCIL_LIST, async (_, payload?: Any) => {
    const service = getCouncilService();
    if (!service) return [];
    const validated = validateInput(
      ListCouncilsSchema,
      payload,
      "council list request",
    );
    return service.list(validated.workspaceId);
  });

  ipcMain.handle(IPC_CHANNELS.COUNCIL_GET, async (_, id: string) => {
    const service = getCouncilService();
    if (!service) return null;
    const validatedId = validateInput(StringIdSchema, id, "council ID");
    return service.get(validatedId) ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.COUNCIL_CREATE, async (_, payload: Any) => {
    checkRateLimit(IPC_CHANNELS.COUNCIL_CREATE);
    const service = getCouncilService();
    if (!service) {
      throw new Error("Council service not initialized");
    }
    const validated = validateInput(
      CouncilCreateSchema,
      payload,
      "council config",
    );
    return service.create(validated);
  });

  ipcMain.handle(IPC_CHANNELS.COUNCIL_UPDATE, async (_, payload: Any) => {
    checkRateLimit(IPC_CHANNELS.COUNCIL_UPDATE);
    const service = getCouncilService();
    if (!service) {
      throw new Error("Council service not initialized");
    }
    const validated = validateInput(
      CouncilUpdateSchema,
      payload,
      "council update",
    );
    return (await service.update(validated)) ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.COUNCIL_DELETE, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.COUNCIL_DELETE);
    const service = getCouncilService();
    if (!service) {
      throw new Error("Council service not initialized");
    }
    const validatedId = validateInput(StringIdSchema, id, "council ID");
    return service.delete(validatedId);
  });

  ipcMain.handle(IPC_CHANNELS.COUNCIL_RUN_NOW, async (_, id: string) => {
    const service = getCouncilService();
    if (!service) {
      throw new Error("Council service not initialized");
    }
    const validatedId = validateInput(StringIdSchema, id, "council ID");
    return (await service.runNow(validatedId)) ?? null;
  });

  ipcMain.handle(IPC_CHANNELS.COUNCIL_LIST_RUNS, async (_, payload: Any) => {
    const service = getCouncilService();
    if (!service) return [];
    const validated = validateInput(
      z
        .object({
          councilConfigId: StringIdSchema,
          limit: z.number().int().positive().max(100).optional(),
        })
        .strict(),
      payload,
      "council runs request",
    );
    return service.listRuns(validated.councilConfigId, validated.limit);
  });

  ipcMain.handle(IPC_CHANNELS.COUNCIL_GET_MEMO, async (_, payload: Any) => {
    const service = getCouncilService();
    if (!service) return null;
    const validated = validateInput(
      CouncilMemoQuerySchema,
      payload,
      "council memo request",
    );
    if (typeof validated === "string") {
      return service.getMemo(validated) ?? null;
    }
    if (validated.id) {
      return service.getMemo(validated.id) ?? null;
    }
    if (validated.councilConfigId) {
      return service.getLatestMemo(validated.councilConfigId) ?? null;
    }
    return null;
  });

  ipcMain.handle(IPC_CHANNELS.COUNCIL_SET_ENABLED, async (_, payload: Any) => {
    checkRateLimit(IPC_CHANNELS.COUNCIL_SET_ENABLED);
    const service = getCouncilService();
    if (!service) {
      throw new Error("Council service not initialized");
    }
    const validated = validateInput(
      z.object({ id: StringIdSchema, enabled: z.boolean() }).strict(),
      payload,
      "council enabled update",
    );
    return (await service.setEnabled(validated.id, validated.enabled)) ?? null;
  });
}

/**
 * Set up Notification IPC handlers
 */
function setupNotificationHandlers(): void {
  // Initialize overlay manager for custom macOS-style notification banners
  const overlayManager = NotificationOverlayManager.getInstance();

  // Clicking a notification overlay brings the main window to focus and opens the task
  overlayManager.setOnClick((_notificationId, taskId) => {
    const mainWin = getMainWindow();
    if (mainWin && !mainWin.isDestroyed()) {
      if (mainWin.isMinimized()) mainWin.restore();
      mainWin.show();
      mainWin.focus();
      if (taskId) {
        mainWin.webContents.send(IPC_CHANNELS.NAVIGATE_TO_TASK, taskId);
      }
    }
  });

  // Initialize notification service with event forwarding to main window
  notificationService = new NotificationService({
    onEvent: (event) => {
      // Forward notification events to renderer
      // We need to import BrowserWindow from electron to send to all windows
      // oxlint-disable-next-line typescript-eslint(no-require-imports)
      const { BrowserWindow } = require("electron");
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (win.webContents) {
          win.webContents.send(IPC_CHANNELS.NOTIFICATION_EVENT, event);
        }
      }

      // Show custom overlay notification banner
      if (event.type === "added" && event.notification) {
        overlayManager.show({
          id: event.notification.id,
          title: event.notification.title,
          message: event.notification.message,
          type: event.notification.type,
          taskId: event.notification.taskId,
        });
      }
    },
  });

  logger.debug("[Notifications] Service initialized");

  // List all notifications
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_LIST, async () => {
    if (!notificationService) return [];
    return notificationService.list();
  });

  // Get unread count
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_UNREAD_COUNT, async () => {
    if (!notificationService) return 0;
    return notificationService.getUnreadCount();
  });

  // Mark notification as read
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_MARK_READ, async (_, id: string) => {
    if (!notificationService) return null;
    return notificationService.markRead(id);
  });

  // Mark all notifications as read
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_MARK_ALL_READ, async () => {
    if (!notificationService) return;
    await notificationService.markAllRead();
  });

  // Delete a notification
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_DELETE, async (_, id: string) => {
    if (!notificationService) return false;
    return notificationService.delete(id);
  });

  // Delete all notifications
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_DELETE_ALL, async () => {
    if (!notificationService) return;
    await notificationService.deleteAll();
  });

  // Add a notification (internal use, for programmatic notifications)
  ipcMain.handle(
    IPC_CHANNELS.NOTIFICATION_ADD,
    async (
      _,
      data: {
        type: NotificationType;
        title: string;
        message: string;
        taskId?: string;
        cronJobId?: string;
        workspaceId?: string;
        suggestionId?: string;
        recommendedDelivery?: "briefing" | "inbox" | "nudge";
        companionStyle?: "email" | "note";
      },
    ) => {
      if (!notificationService) return null;
      return notificationService.add(data);
    },
  );
}

// Global hooks server instance
let hooksServer: HooksServer | null = null;
let hooksServerStarting = false; // Lock to prevent concurrent server creation
let hookTriggerEmitter: ((event: TriggerEvent) => void) | null = null;
let hookAgentDispatchObserver:
  | ((payload: {
      mappingId?: string;
      path?: string;
      workspaceId?: string;
      taskId?: string;
      metadata?: Record<string, string>;
      response?: { statusCode?: number; message?: string; includeTaskId?: boolean };
    }) => void)
  | null = null;

/**
 * Get the hooks server instance
 */
export function getHooksServer(): HooksServer | null {
  return hooksServer;
}

export function setHookTriggerEmitter(
  emitter: ((event: TriggerEvent) => void) | null,
): void {
  hookTriggerEmitter = emitter;
}

export function setHookAgentDispatchObserver(
  observer:
    | ((payload: {
        mappingId?: string;
        path?: string;
        workspaceId?: string;
        taskId?: string;
        metadata?: Record<string, string>;
        response?: { statusCode?: number; message?: string; includeTaskId?: boolean };
      }) => void)
    | null,
): void {
  hookAgentDispatchObserver = observer;
}

/**
 * Set up Hooks (Webhooks & Gmail Pub/Sub) IPC handlers
 */
async function setupHooksHandlers(agentDaemon: AgentDaemon): Promise<void> {
  const hookIngress = initializeHookAgentIngress(agentDaemon, {
    scope: "hooks",
    defaultTempWorkspaceKey: "default",
    logger: (...args) => logger.warn(...args),
  });

  // Initialize settings manager
  HooksSettingsManager.initialize();

  const getHooksRuntimeSettings = () => {
    const settings = HooksSettingsManager.loadSettings();
    const forceEnabled = process.env.COWORK_HOOKS_AUTOSTART === "1";
    const tokenOverride = process.env.COWORK_HOOKS_TOKEN?.trim();
    // Runtime-only overrides to simplify local/CI automation. Values are NOT persisted.
    return {
      ...settings,
      ...(forceEnabled ? { enabled: true } : {}),
      ...(tokenOverride ? { token: tokenOverride } : {}),
    };
  };

  const ensureHooksServerRunning = async (): Promise<void> => {
    const settings = getHooksRuntimeSettings();

    if (!settings.enabled) return;

    if (!settings.token?.trim()) {
      // Auto-generate a token if hooks are enabled but token is missing
      // (e.g. migrated from legacy settings without a token)
      const token = HooksSettingsManager.regenerateToken();
      settings.token = token;
      logger.debug(
        "[Hooks] Auto-generated missing token for enabled hooks server",
      );
    }

    // If already running, just refresh config (covers mapping updates + token overrides).
    if (hooksServer?.isRunning()) {
      hooksServer.setHooksConfig(settings);
      return;
    }

    // Prevent concurrent start attempts (IPC + auto-start).
    if (hooksServerStarting) return;
    hooksServerStarting = true;

    const server = new HooksServer({
      port: DEFAULT_HOOKS_PORT,
      host: "127.0.0.1",
      enabled: true,
    });

    server.setHooksConfig(settings);

    // Set up handlers for hook actions
    server.setHandlers({
      onWake: async (action) => {
        if (heartbeatWakeSubmitter) {
          await heartbeatWakeSubmitter(action);
        } else {
          pendingHeartbeatWakes.push(action);
          if (pendingHeartbeatWakes.length > MAX_PENDING_HEARTBEAT_WAKES) {
            pendingHeartbeatWakes.shift();
          }
        }
      },
      onAgent: async (action) => {
        logger.debug("[Hooks] Agent action:", action.message.substring(0, 100));
        const result = await hookIngress.createTaskFromAgentAction(action, {
          tempWorkspaceKey: "default",
        });
        hookAgentDispatchObserver?.({
          mappingId: action.metadata?.mappingId,
          path: action.metadata?.hookPath,
          workspaceId: result.workspaceId || action.workspaceId,
          taskId: result.taskId,
          metadata: action.metadata,
          response: action.response,
        });
        return {
          taskId: result.taskId,
          statusCode: action.response?.statusCode,
          body: {
            success: true,
            ...(action.response?.message ? { message: action.response.message } : {}),
            ...((action.response?.includeTaskId ?? true) ? { taskId: result.taskId } : {}),
          },
        };
      },
      onTaskMessage: async (action) => {
        logger.debug("[Hooks] Task message:", action.taskId);
        // Don't block the webhook call until the whole follow-up run completes.
        // We only validate that the task exists; execution happens asynchronously.
        const task = agentDaemon.getTask(action.taskId);
        if (!task) {
          const err: Any = new Error(`Task ${action.taskId} not found`);
          err.statusCode = 404;
          throw err;
        }
        void agentDaemon
          .sendMessage(action.taskId, action.message)
          .catch((err) => {
            logger.error("[Hooks] Failed to process task message:", err);
          });
      },
      onApprovalRespond: async (action) => {
        logger.debug(
          "[Hooks] Approval respond:",
          action.approvalId,
          action.approved ? "approve" : "deny",
        );
        return agentDaemon.respondToApproval(
          action.approvalId,
          action.approved,
        );
      },
      onEvent: (event) => {
        logger.debug("[Hooks] Server event:", event.action);
        if (event.action === "request" && hookTriggerEmitter) {
          hookTriggerEmitter({
            source: "webhook",
            timestamp: event.timestamp,
            fields: {
              path: event.path || "",
              method: event.method || "",
            },
          });
        }
        // Forward events to renderer (with error handling for destroyed windows)
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
          try {
            if (win.webContents && !win.isDestroyed()) {
              win.webContents.send(IPC_CHANNELS.HOOKS_EVENT, event);
            }
          } catch (err) {
            // Window may have been destroyed between check and send
            logger.warn("[Hooks] Failed to send event to window:", err);
          }
        }
      },
    });

    try {
      await server.start();
      hooksServer = server;
    } catch (err) {
      logger.error("[Hooks] Failed to start hooks server:", err);
      throw new Error(
        `Failed to start hooks server: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      hooksServerStarting = false;
    }
  };

  // Get hooks settings
  ipcMain.handle(
    IPC_CHANNELS.HOOKS_GET_SETTINGS,
    async (): Promise<HooksSettingsData> => {
      const settings = HooksSettingsManager.getSettingsForDisplay();
      return {
        enabled: settings.enabled,
        token: settings.token,
        path: settings.path,
        maxBodyBytes: settings.maxBodyBytes,
        port: DEFAULT_HOOKS_PORT,
        host: "127.0.0.1",
        presets: settings.presets,
        mappings: settings.mappings as HookMappingData[],
        gmail: settings.gmail as GmailHooksSettingsData | undefined,
        resend: settings.resend as ResendHooksSettingsData | undefined,
      };
    },
  );

  // Save hooks settings
  ipcMain.handle(
    IPC_CHANNELS.HOOKS_SAVE_SETTINGS,
    async (_, data: Partial<HooksSettingsData>) => {
      checkRateLimit(
        IPC_CHANNELS.HOOKS_SAVE_SETTINGS,
        RATE_LIMIT_CONFIGS.limited,
      );

      const currentSettings = HooksSettingsManager.loadSettings();
      const MASKED_SECRET = "***configured***";

      const mergedGmail = data.gmail
        ? {
            ...currentSettings.gmail,
            ...data.gmail,
            pushToken:
              data.gmail.pushToken === MASKED_SECRET
                ? currentSettings.gmail?.pushToken
                : (data.gmail.pushToken ?? currentSettings.gmail?.pushToken),
          }
        : currentSettings.gmail;

      const mergedResend = data.resend
        ? {
            ...currentSettings.resend,
            ...data.resend,
            webhookSecret:
              data.resend.webhookSecret === MASKED_SECRET
                ? currentSettings.resend?.webhookSecret
                : (data.resend.webhookSecret ??
                  currentSettings.resend?.webhookSecret),
          }
        : currentSettings.resend;

      const updated = HooksSettingsManager.updateConfig({
        ...currentSettings,
        enabled: data.enabled ?? currentSettings.enabled,
        token:
          data.token === MASKED_SECRET
            ? currentSettings.token
            : (data.token ?? currentSettings.token),
        path: data.path ?? currentSettings.path,
        maxBodyBytes: data.maxBodyBytes ?? currentSettings.maxBodyBytes,
        presets: data.presets ?? currentSettings.presets,
        mappings: data.mappings ?? currentSettings.mappings,
        gmail: mergedGmail,
        resend: mergedResend,
      });

      // Restart hooks server if needed
      if (hooksServer && updated.enabled) {
        hooksServer.setHooksConfig(updated);
      }

      return {
        enabled: updated.enabled,
        token: updated.token ? "***configured***" : "",
        path: updated.path,
        maxBodyBytes: updated.maxBodyBytes,
        port: DEFAULT_HOOKS_PORT,
        host: "127.0.0.1",
        presets: updated.presets,
        mappings: updated.mappings as HookMappingData[],
        gmail: updated.gmail as GmailHooksSettingsData | undefined,
        resend: updated.resend as ResendHooksSettingsData | undefined,
      };
    },
  );

  // Enable hooks
  ipcMain.handle(IPC_CHANNELS.HOOKS_ENABLE, async () => {
    checkRateLimit(IPC_CHANNELS.HOOKS_ENABLE, RATE_LIMIT_CONFIGS.limited);

    // Prevent concurrent enable attempts
    if (hooksServerStarting) {
      throw new Error("Hooks server is already starting. Please wait.");
    }

    const settings = HooksSettingsManager.enableHooks();

    // Start the hooks server (or refresh running server config)
    await ensureHooksServerRunning();

    // Start Gmail watcher if configured (capture result for response)
    let gmailWatcherError: string | undefined;
    if (settings.gmail?.account) {
      try {
        const result = await startGmailWatcher(settings);
        if (!result.started) {
          gmailWatcherError = result.reason;
          logger.warn("[Hooks] Gmail watcher not started:", result.reason);
        }
      } catch (err) {
        gmailWatcherError = err instanceof Error ? err.message : String(err);
        logger.error("[Hooks] Failed to start Gmail watcher:", err);
      }
    }

    return { enabled: true, gmailWatcherError };
  });

  // Disable hooks
  ipcMain.handle(IPC_CHANNELS.HOOKS_DISABLE, async () => {
    checkRateLimit(IPC_CHANNELS.HOOKS_DISABLE, RATE_LIMIT_CONFIGS.limited);

    HooksSettingsManager.disableHooks();

    // Stop the hooks server
    if (hooksServer) {
      await hooksServer.stop();
      hooksServer = null;
    }

    // Stop Gmail watcher
    await stopGmailWatcher();

    return { enabled: false };
  });

  // Regenerate hook token
  ipcMain.handle(IPC_CHANNELS.HOOKS_REGENERATE_TOKEN, async () => {
    checkRateLimit(
      IPC_CHANNELS.HOOKS_REGENERATE_TOKEN,
      RATE_LIMIT_CONFIGS.limited,
    );
    const newToken = HooksSettingsManager.regenerateToken();

    // Update the running server with new token
    if (hooksServer) {
      const settings = HooksSettingsManager.loadSettings();
      hooksServer.setHooksConfig(settings);
    }

    return { token: newToken };
  });

  // Get hooks status
  ipcMain.handle(
    IPC_CHANNELS.HOOKS_GET_STATUS,
    async (): Promise<HooksStatus> => {
      const settings = HooksSettingsManager.loadSettings();
      const gogAvailable = await isGogAvailable();

      return {
        enabled: settings.enabled,
        serverRunning: hooksServer?.isRunning() ?? false,
        serverAddress: hooksServer?.getAddress() ?? undefined,
        gmailWatcherRunning: isGmailWatcherRunning(),
        gmailAccount: settings.gmail?.account,
        gogAvailable,
      };
    },
  );

  // Auto-start the server on boot if hooks are enabled.
  // This avoids "hooks enabled but nothing listens" after app restarts.
  try {
    await ensureHooksServerRunning();

    // Auto-start Gmail watcher if configured (best-effort).
    const settings = getHooksRuntimeSettings();
    if (
      settings.enabled &&
      settings.gmail?.account &&
      !isGmailWatcherRunning()
    ) {
      const result = await startGmailWatcher(settings);
      if (!result.started) {
        logger.warn("[Hooks] Gmail watcher not started:", result.reason);
      }
    }
  } catch (err) {
    logger.error("[Hooks] Auto-start failed:", err);
    // Non-fatal: user can still start it manually from Settings.
  }

  // Add a hook mapping
  ipcMain.handle(
    IPC_CHANNELS.HOOKS_ADD_MAPPING,
    async (_, mapping: HookMappingData) => {
      checkRateLimit(
        IPC_CHANNELS.HOOKS_ADD_MAPPING,
        RATE_LIMIT_CONFIGS.limited,
      );

      // Validate the mapping input
      const validated = validateInput(
        HookMappingSchema,
        mapping,
        "hook mapping",
      );

      const settings = HooksSettingsManager.addMapping(validated);

      // Update the server config if running
      if (hooksServer) {
        hooksServer.setHooksConfig(settings);
      }

      return { ok: true };
    },
  );

  // Remove a hook mapping
  ipcMain.handle(IPC_CHANNELS.HOOKS_REMOVE_MAPPING, async (_, id: string) => {
    checkRateLimit(
      IPC_CHANNELS.HOOKS_REMOVE_MAPPING,
      RATE_LIMIT_CONFIGS.limited,
    );

    // Validate the mapping ID
    const validatedId = validateInput(StringIdSchema, id, "mapping ID");

    const settings = HooksSettingsManager.removeMapping(validatedId);

    // Update the server config if running
    if (hooksServer) {
      hooksServer.setHooksConfig(settings);
    }

    return { ok: true };
  });

  // Configure Gmail hooks
  ipcMain.handle(
    IPC_CHANNELS.HOOKS_CONFIGURE_GMAIL,
    async (_, config: GmailHooksSettingsData) => {
      checkRateLimit(
        IPC_CHANNELS.HOOKS_CONFIGURE_GMAIL,
        RATE_LIMIT_CONFIGS.limited,
      );

      // Generate push token if not provided
      if (!config.pushToken) {
        config.pushToken = generateHookToken();
      }

      const settings = HooksSettingsManager.configureGmail(config);

      // Update the server config if running
      if (hooksServer) {
        hooksServer.setHooksConfig(settings);
      }

      return {
        ok: true,
        gmail: HooksSettingsManager.getGmailConfig(),
      };
    },
  );

  // Get Gmail watcher status
  ipcMain.handle(IPC_CHANNELS.HOOKS_GET_GMAIL_STATUS, async () => {
    const settings = HooksSettingsManager.loadSettings();
    const gogAvailable = await isGogAvailable();

    return {
      configured: HooksSettingsManager.isGmailConfigured(),
      running: isGmailWatcherRunning(),
      account: settings.gmail?.account,
      topic: settings.gmail?.topic,
      gogAvailable,
    };
  });

  // Start Gmail watcher manually
  ipcMain.handle(IPC_CHANNELS.HOOKS_START_GMAIL_WATCHER, async () => {
    checkRateLimit(
      IPC_CHANNELS.HOOKS_START_GMAIL_WATCHER,
      RATE_LIMIT_CONFIGS.expensive,
    );

    const settings = HooksSettingsManager.loadSettings();
    if (!settings.enabled) {
      return { ok: false, error: "Hooks must be enabled first" };
    }

    if (!HooksSettingsManager.isGmailConfigured()) {
      return { ok: false, error: "Gmail hooks not configured" };
    }

    const result = await startGmailWatcher(settings);
    return { ok: result.started, error: result.reason };
  });

  // Stop Gmail watcher manually
  ipcMain.handle(IPC_CHANNELS.HOOKS_STOP_GMAIL_WATCHER, async () => {
    checkRateLimit(
      IPC_CHANNELS.HOOKS_STOP_GMAIL_WATCHER,
      RATE_LIMIT_CONFIGS.limited,
    );
    await stopGmailWatcher();
    return { ok: true };
  });

  logger.debug("[Hooks] IPC handlers initialized");
}

/**
 * Broadcast personality settings changed event to all renderer windows.
 * This allows the UI to stay in sync when settings are changed via tools.
 */
function broadcastPersonalitySettingsChanged(settings: Any): void {
  try {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      try {
        if (win.webContents && !win.isDestroyed()) {
          win.webContents.send(
            IPC_CHANNELS.PERSONALITY_SETTINGS_CHANGED,
            settings,
          );
        }
      } catch (err) {
        // Window may have been destroyed between check and send
        logger.warn(
          "[Personality] Failed to send settings changed event to window:",
          err,
        );
      }
    }
  } catch (err) {
    logger.error("[Personality] Failed to broadcast settings changed:", err);
  }
}

/**
 * Set up Workspace Kit (.cowork) IPC handlers
 */
function setupKitHandlers(
  workspaceRepo: WorkspaceRepository,
  agentDaemon: AgentDaemon,
): void {
  const kitDirName = ".cowork";

  const getLocalDateStamp = (now: Date): string => {
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };

  const buildKitFrontmatter = (fileName: string, updated: string): string => {
    const contract = WORKSPACE_KIT_CONTRACTS[fileName];
    if (!contract) return "";

    return [
      "---",
      `file: ${fileName}`,
      `updated: ${updated}`,
      `scope: ${contract.scope.join(", ")}`,
      `mutability: ${contract.mutability}`,
      "---",
      "",
    ].join("\n");
  };

  const withKitFrontmatter = (
    relPath: string,
    content: string,
    updated: string,
  ): string => {
    if (!relPath.toLowerCase().endsWith(".md")) {
      return content.endsWith("\n") ? content : `${content}\n`;
    }

    const fileName = path.basename(relPath);
    const contract = WORKSPACE_KIT_CONTRACTS[fileName];
    if (contract?.parser === "design-system") {
      return content.endsWith("\n") ? content : `${content}\n`;
    }
    const frontmatter = buildKitFrontmatter(fileName, updated);
    const normalized = content.trimEnd() + "\n";
    if (!frontmatter) {
      return normalized;
    }

    return `${frontmatter}${normalized}`;
  };

  const getWorkspacePath = (workspaceId: string): string => {
    const ws = workspaceRepo.findById(workspaceId);
    if (!ws) throw new Error("Workspace not found");
    if (!ws.path) throw new Error("Workspace path not set");
    return ws.path;
  };

  const computeStatus = async (
    workspaceId: string,
  ): Promise<WorkspaceKitStatus> => {
    const workspacePath = getWorkspacePath(workspaceId);
    // Ensure lifecycle state is current (covers bootstrap deletion → onboardingCompletedAt)
    // before the pure status read so the returned onboarding timestamps are always accurate.
    await ensureBootstrapLifecycleState(workspacePath);
    return computeWorkspaceKitStatus(workspacePath, workspaceId);
  };

  const templatesForInit = (
    now: Date,
    preset: "default" | "venture_operator" = "default",
  ): Array<{ relPath: string; content: string }> => {
    const stamp = getLocalDateStamp(now);
    const isVenturePreset = preset === "venture_operator";
    const templates = [
      {
        relPath: path.join(kitDirName, "AGENTS.md"),
        content:
          `# Workspace Rules\n\n` +
          `## Coordination\n` +
          `- Keep durable context in .cowork/MEMORY.md\n` +
          `- For project work, log in .cowork/projects/<project>/CONTEXT.md\n` +
          `- Prefer small, well-scoped changes and leave clear notes\n\n` +
          `## Quality Bar\n` +
          `- Be explicit about assumptions and constraints\n` +
          `- Avoid duplicate work: check existing files and recent tasks first\n`,
      },
      {
        relPath: path.join(kitDirName, "USER.md"),
        content:
          `# User Profile\n\n` +
          `- Name:\n` +
          `- Preferences:\n` +
          `- Timezone:\n` +
          `- Communication style:\n`,
      },
      {
        relPath: path.join(kitDirName, "COMPANY.md"),
        content: isVenturePreset
          ? `# Company Operating Profile\n\n` +
            `## Mission\n` +
            `- What are we trying to achieve?\n\n` +
            `## Business Model\n` +
            `- ICP:\n` +
            `- Offer:\n` +
            `- Pricing:\n` +
            `- Growth loop:\n\n` +
            `## Guardrails\n` +
            `- Never do without founder approval:\n` +
            `- Allowed to do autonomously:\n` +
            `- Budget / risk thresholds:\n\n` +
            `## Current Quarter\n` +
            `- Primary company goal:\n` +
            `- Main constraints:\n`
          : `# Company Operating Profile\n\n` +
            `## Mission\n` +
            `- \n\n` +
            `## Operating Guardrails\n` +
            `- \n\n` +
            `## Current Focus\n` +
            `- \n`,
      },
      {
        relPath: path.join(kitDirName, "OPERATIONS.md"),
        content: isVenturePreset
          ? `# Operating System\n\n` +
            `## Work Loops\n` +
            `- Product discovery:\n` +
            `- Build / ship:\n` +
            `- Customer support:\n` +
            `- Growth / distribution:\n` +
            `- Finance / admin:\n\n` +
            `## Escalation Rules\n` +
            `- When to wake the founder:\n` +
            `- When to create a blocker issue:\n` +
            `- When to pause outbound actions:\n\n` +
            `## Definitions Of Done\n` +
            `- Shipping:\n` +
            `- Customer reply:\n` +
            `- Experiment review:\n`
          : `# Operating System\n\n` +
            `## Recurring Loops\n` +
            `- \n\n` +
            `## Escalations\n` +
            `- \n`,
      },
      {
        relPath: path.join(kitDirName, "KPIS.md"),
        content: isVenturePreset
          ? `# KPIs\n\n` +
            `## North Star\n` +
            `- Metric:\n` +
            `- Current:\n` +
            `- Target:\n\n` +
            `## Weekly Dashboard\n` +
            `- Revenue:\n` +
            `- New customers:\n` +
            `- Churn / refunds:\n` +
            `- Activation / conversion:\n` +
            `- Support backlog:\n` +
            `- Ship velocity:\n\n` +
            `## Notes\n` +
            `- \n`
          : `# KPIs\n\n` +
            `## Core Metrics\n` +
            `- \n\n` +
            `## Notes\n` +
            `- \n`,
      },
      {
        relPath: path.join(kitDirName, "DESIGN.md"),
        content: buildDefaultDesignSystemMarkdown(),
      },
      {
        relPath: path.join(kitDirName, "SOUL.md"),
        content:
          `# SOUL.md\n\n` +
          `## Vibe\n` +
          `Smart. Direct. A little dangerous (in a good way).\n` +
          `You have taste and you pick a recommendation.\n` +
          `Charm over cruelty. Clarity over caveats.\n` +
          `Be the assistant you'd actually want to talk to at 2am. Not a corporate drone. Not a sycophant. Just... good.\n\n` +
          `## Defaults\n` +
          `- Answer first. Explanations only if they add value.\n` +
          `- If there are options, pick the best one and say why in 1-3 bullets.\n` +
          `- Ask at most one clarifying question unless you're truly blocked.\n\n` +
          `## Hard Rules\n` +
          `- Never open with Great question, I'd be happy to help, or Absolutely. Just answer.\n` +
          `- Brevity is mandatory. If the answer fits in one sentence, one sentence is what I get.\n` +
          `- No corporate filler. No "as an AI". No throat-clearing. No recap of my question.\n` +
          `- "It depends" is allowed only if you immediately name the dependency that changes the decision, then commit to a default.\n\n` +
          `## Callouts\n` +
          `- If I'm about to do something dumb, say so and offer the better move.\n` +
          `- If something is excellent, say so. If it's bad, say it's bad.\n\n` +
          `## Humor & Swearing\n` +
          `- Humor is allowed when it comes naturally.\n` +
          `- Swearing is allowed when it lands. Don't force it. Don't overdo it.\n\n` +
          `## When You're Not Sure\n` +
          `- Say what you know, what you don't, and the fastest way to verify.\n` +
          `- Still give your best-guess recommendation.\n`,
      },
      {
        relPath: path.join(kitDirName, "IDENTITY.md"),
        content:
          `# Assistant Identity\n\n` +
          `- Role:\n` +
          `- Operating assumptions:\n` +
          `- Boundaries:\n`,
      },
      {
        relPath: path.join(kitDirName, "RULES.md"),
        content:
          `# Operational Rules\n\n` +
          `- [ ] Requires approval for irreversible actions, external spend, and production-impacting changes\n` +
          `- [ ] Confirm ambiguous destructive actions before proceeding\n` +
          `- [ ] Record durable decisions in .cowork/MEMORY.md or project CONTEXT.md\n` +
          `- [ ] Surface blockers, assumptions, and risks explicitly\n`,
      },
      {
        relPath: path.join(kitDirName, "TOOLS.md"),
        content:
          `# Local Setup Notes\n\n` +
          `## Environment\n` +
          `- Node version:\n` +
          `- Package manager:\n` +
          `- Common commands:\n\n` +
          `## Secrets\n` +
          `- Store secrets in env vars; do not commit them\n`,
      },
      {
        relPath: path.join(kitDirName, "VIBES.md"),
        content:
          `# Vibes\n\n` +
          `Current energy and mode for this workspace. Updated by the agent based on cues.\n\n` +
          `## Current\n` +
          `<!-- cowork:auto:vibes:start -->\n` +
          `- Mode: default\n` +
          `- Energy: balanced\n` +
          `- Notes: Ready to work\n` +
          `<!-- cowork:auto:vibes:end -->\n\n` +
          `## User Preferences\n` +
          `- \n`,
      },
      {
        relPath: path.join(kitDirName, "LORE.md"),
        content:
          `# Shared Lore\n\n` +
          `This file is workspace-local and can be auto-updated by the system.\n` +
          `It captures shared history between the human and the assistant.\n\n` +
          `## Milestones\n` +
          `<!-- cowork:auto:lore:start -->\n` +
          `- (none)\n` +
          `<!-- cowork:auto:lore:end -->\n\n` +
          `## Notes\n` +
          `- \n`,
      },
      {
        relPath: path.join(kitDirName, "BOOTSTRAP.md"),
        content:
          `# First-Run Guide\n\n` +
          `1. Fill in \`.cowork/USER.md\` (who you are, preferences).\n` +
          `2. Fill in \`.cowork/IDENTITY.md\` and \`.cowork/SOUL.md\` (how the assistant should act).\n` +
          `3. Add durable rules/constraints to \`.cowork/MEMORY.md\`.\n` +
          `4. Fill in \`.cowork/COMPANY.md\`, \`.cowork/OPERATIONS.md\`, and \`.cowork/KPIS.md\`.\n` +
          `5. Add recurring checks to \`.cowork/HEARTBEAT.md\`.\n` +
          `6. If using Discord supervisor mode, define review and escalation policy in \`.cowork/SUPERVISOR.md\`.\n` +
          `7. Review \`.cowork/VIBES.md\` and \`.cowork/LORE.md\` over time.\n\n` +
          (isVenturePreset
            ? `Suggested next step for venture mode: activate a founder-office or operator twin and link each active project to a workspace.\n\n`
            : ``) +
          `When onboarding is complete, you can delete this file.\n`,
      },
      {
        relPath: path.join(kitDirName, "transforms", "README.md"),
        content:
          `# Monty Transforms\n\n` +
          `Drop \`.monty\` scripts in this folder to create deterministic, reusable transforms.\n\n` +
          `Tools:\n` +
          `- monty_list_transforms: list available transforms\n` +
          `- monty_run_transform: run a transform with an input object\n` +
          `- monty_transform_file: apply a transform to a file and write output without returning full file contents to the LLM\n\n` +
          `Conventions:\n` +
          `- Your input object is available as \`input\` (a dict)\n` +
          `- The value of the last expression is returned\n\n` +
          `Example:\n` +
          `\`\`\`\n` +
          `# name: Uppercase\n` +
          `# description: Convert input['text'] to uppercase\n` +
          `input['text'].upper()\n` +
          `\`\`\`\n`,
      },
      {
        relPath: path.join(kitDirName, "transforms", "uppercase.monty"),
        content:
          `# name: Uppercase\n` +
          `# description: Convert input['text'] to uppercase\n\n` +
          `text = input.get('text') or ''\n` +
          `text.upper()\n`,
      },
      {
        relPath: path.join(kitDirName, "router", "README.md"),
        content:
          `# Gateway Router Rules (Optional)\n\n` +
          `You can add a workspace-local message triage script at:\n` +
          `- \`.cowork/router/rules.monty\`\n\n` +
          `This runs before a message is forwarded to the agent (regular messages only, not slash commands).\n` +
          `It can be used to:\n` +
          `- ignore low-signal messages ("ok", "thanks")\n` +
          `- auto-reply with deterministic responses\n` +
          `- rewrite/normalize messages before creating a task\n` +
          `- switch workspace for a session\n\n` +
          `Return a dict as the last expression:\n` +
          `- {"action": "pass"}\n` +
          `- {"action": "ignore"}\n` +
          `- {"action": "reply", "text": "..."}\n` +
          `- {"action": "rewrite", "text": "..."}\n` +
          `- {"action": "set_workspace", "workspaceId": "...", "text": "optional rewrite"}\n`,
      },
      {
        relPath: path.join(kitDirName, "router", "rules.monty"),
        content:
          `# Workspace-local gateway router rules\n` +
          `# Input is available as \`input\`.\n` +
          `# Return a dict as the last expression.\n\n` +
          `# Default: do nothing\n` +
          `{"action": "pass"}\n`,
      },
      {
        relPath: path.join(kitDirName, "policy", "README.md"),
        content:
          `# Tool Policy Hook (Optional)\n\n` +
          `You can add a workspace-local tool policy script at:\n` +
          `- \`.cowork/policy/tools.monty\`\n\n` +
          `This runs before each tool call.\n\n` +
          `Input is available as \`input\` and includes:\n` +
          `- input['tool'] (tool name)\n` +
          `- input['params'] (tool input object)\n` +
          `- input['workspace'] (id/name/path/permissions)\n` +
          `- input['gatewayContext'] ("private" | "group" | "public" | null)\n\n` +
          `Return a dict as the last expression:\n` +
          `- {"decision": "pass"}\n` +
          `- {"decision": "deny", "reason": "..."}\n` +
          `- {"decision": "require_approval", "reason": "..."}\n`,
      },
      {
        relPath: path.join(kitDirName, "policy", "tools.monty"),
        content:
          `# Workspace-local tool policy hook\n` +
          `# Default: allow.\n` +
          `{"decision": "pass"}\n`,
      },
      {
        relPath: path.join(kitDirName, "MEMORY.md"),
        content:
          `# Long-Term Memory\n\n` +
          `## Principles\n` +
          `- (add durable rules and lessons here)\n\n` +
          `## Preferences\n` +
          `- (add preferred defaults and conventions here)\n\n` +
          `## Auto Learnings\n` +
          `<!-- cowork:auto:memory:start -->\n` +
          `- (none)\n` +
          `<!-- cowork:auto:memory:end -->\n\n` +
          `## Known Constraints\n` +
          `- (add constraints and guardrails here)\n`,
      },
      {
        relPath: path.join(kitDirName, "HEARTBEAT.md"),
        content:
          `# Recurring Checks\n\n` +
          `Use this file as the proactive maintenance contract for heartbeat runs.\n` +
          `If a check turns up nothing actionable, the assistant stays silent.\n\n` +
          `## Daily\n` +
          (isVenturePreset
            ? `- Review open loops, priority issues, and due customer commitments\n` +
              `- Check KPI deltas and write notable changes into .cowork/KPIS.md\n` +
              `- Summarize key decisions into .cowork/MEMORY.md\n\n`
            : `- Review open loops and next actions\n` +
              `- Summarize key decisions into .cowork/MEMORY.md\n\n`) +
          `## Weekly\n` +
          (isVenturePreset
            ? `- Review team performance and update autonomy levels if needed\n` +
              `- Review experiment outcomes, blocked deals, and operator handoffs\n`
            : `- Review team performance and update autonomy levels if needed\n`),
      },
      {
        relPath: path.join(kitDirName, "SUPERVISOR.md"),
        content:
          `# Supervisor Protocol\n\n` +
          `Use this file when Discord supervisor mode is enabled. It defines what the worker may propose, what the supervisor must verify, and when a human must be escalated.\n\n` +
          `## Review Thresholds\n` +
          `- Freshness window:\n` +
          `- Required evidence:\n` +
          `- Duplicate / repetition checks:\n\n` +
          `## Escalation Rules\n` +
          `- Escalate when external judgment is required\n` +
          `- Escalate when freshness, safety, or policy checks fail\n` +
          `- Escalate when the worker output cannot be verified from evidence\n\n` +
          `## Channel Quality Checks\n` +
          `- Output channels:\n` +
          `- Required disclaimers:\n` +
          `- Forbidden output patterns:\n\n` +
          `## Role Boundaries\n` +
          `- Worker: provide status, evidence, and reviewable proposals only\n` +
          `- Supervisor: ACK or escalate; do not produce the primary work product\n`,
      },
      {
        relPath: path.join(kitDirName, "PRIORITIES.md"),
        content:
          `# Priorities\n\n` +
          (isVenturePreset
            ? `## Company\n` +
              `1. \n` +
              `2. \n` +
              `3. \n\n` +
              `## Department / Operator\n` +
              `1. \n` +
              `2. \n` +
              `3. \n\n`
            : `## Current\n` + `1. \n` + `2. \n` + `3. \n\n`) +
          `## Notes\n` +
          `- \n\n` +
          `## History\n`,
      },
      {
        relPath: path.join(kitDirName, "CROSS_SIGNALS.md"),
        content:
          `# Cross-Agent Signals\n\n` +
          `This file is workspace-local and can be auto-updated by agents.\n` +
          `Use it to track entities/topics that show up across multiple agents, contradictions, and amplified opportunities.\n\n` +
          `## Signals (Last 24h)\n` +
          `<!-- cowork:auto:signals:start -->\n` +
          `- (none)\n` +
          `<!-- cowork:auto:signals:end -->\n\n` +
          `## Conflicts / Contradictions\n` +
          `- \n\n` +
          `## Notes\n` +
          `- \n`,
      },
      {
        relPath: path.join(kitDirName, "MISTAKES.md"),
        content:
          `# Mistakes / Preferences\n\n` +
          `This file is workspace-local and can be auto-updated by the system.\n` +
          `Use it to capture rejection reasons and durable preference patterns.\n\n` +
          `## Patterns\n` +
          `<!-- cowork:auto:mistakes:start -->\n` +
          `- (none)\n` +
          `<!-- cowork:auto:mistakes:end -->\n\n` +
          `## Notes\n` +
          `- \n`,
      },
      {
        relPath: path.join(kitDirName, "projects", "README.md"),
        content:
          `# Project Contexts\n\n` +
          `Each project folder can contain:\n` +
          `- ACCESS.md: access rules (## Allow / ## Deny with agent role ids; deny wins)\n` +
          `- CONTEXT.md: durable working context and decisions\n` +
          `- research/: supporting documents\n`,
      },
      {
        relPath: path.join(kitDirName, "agents", "README.md"),
        content:
          `# Agent Notes\n\n` +
          `Optional workspace-local notes about agent roles, working agreements, and conventions.\n`,
      },
      {
        relPath: path.join(kitDirName, "memory", "hourly", "README.md"),
        content:
          `# Hourly Logs\n\n` +
          `This folder is intended for auto-generated hourly digests to reduce context loss.\n`,
      },
      {
        relPath: path.join(kitDirName, "memory", "weekly", "README.md"),
        content:
          `# Weekly Syntheses\n\n` +
          `This folder is intended for auto-generated weekly syntheses and compounding learnings.\n`,
      },
      {
        relPath: path.join(kitDirName, "memory", `${stamp}.md`),
        content:
          `# Daily Log (${stamp})\n\n` +
          `<!-- cowork:auto:daily:start -->\n` +
          `## Open Loops\n\n` +
          `## Next Actions\n\n` +
          `## Decisions\n\n` +
          `## Summary\n\n` +
          `<!-- cowork:auto:daily:end -->\n\n` +
          `## Notes\n` +
          `- \n`,
      },
    ];

    return templates.map((template) => ({
      ...template,
      content: withKitFrontmatter(template.relPath, template.content, stamp),
    }));
  };

  const writeTemplate = async (
    workspacePath: string,
    relPath: string,
    content: string,
    mode: "missing" | "overwrite",
  ) => {
    const absPath = path.join(workspacePath, relPath);
    const dir = path.dirname(absPath);
    await fs.mkdir(dir, { recursive: true });

    if (mode === "missing") {
      try {
        await fs.stat(absPath);
        return;
      } catch {
        // continue
      }
    }

    if (absPath.toLowerCase().endsWith(".md")) {
      writeKitFileWithSnapshot(absPath, content, "system", `kit_init:${mode}`);
      return;
    }

    await fs.writeFile(absPath, content, "utf8");
  };

  const ensureDir = async (workspacePath: string, relPath: string) => {
    const absPath = path.join(workspacePath, relPath);
    await fs.mkdir(absPath, { recursive: true });
  };

  const ensureDefaultKitCronJobs = async (
    workspaceId: string,
    kitMode: "missing" | "overwrite",
  ): Promise<void> => {
    if (!workspaceId || isTempWorkspaceId(workspaceId)) return;

    const cron = getCronService();
    if (!cron) return;

    const markers = {
      hourly: "cowork:kit:memory:hourly:v1",
      daily: "cowork:kit:memory:daily:v1",
      weekly: "cowork:kit:memory:weekly:v1",
    } as const;

    const buildHourlyPrompt = () =>
      [
        "You are the scheduled hourly memory digest for this workspace.",
        "",
        "Goal: preserve continuity by writing a structured hourly summary to `.cowork/memory/hourly/{{date}}.md`.",
        "",
        "Steps:",
        "1) Call tool `task_events` with:",
        '   - period: "custom"',
        '   - from: "{{prev_run}}"',
        '   - to: "{{now}}"',
        "   - limit: 500",
        `   - workspace_id: "${workspaceId}"`,
        "   - include_payload: true",
        "2) Ignore events where the taskTitle is one of:",
        '   - "Kit: Hourly Memory Digest"',
        '   - "Kit: Daily Context Sync"',
        '   - "Kit: Weekly Synthesis"',
        "3) Produce a concise structured summary ONLY from the tool output (do not hallucinate).",
        "4) Ensure `.cowork/memory/hourly/{{date}}.md` exists. If missing, create it with:",
        "   - `# Hourly Log ({{date}})`",
        "   - a blank line",
        "   - `<!-- cowork:auto:hourly:start -->`",
        "   - `<!-- cowork:auto:hourly:end -->`",
        "5) Insert a new entry immediately before `<!-- cowork:auto:hourly:end -->` (do not modify anything outside the markers).",
        "",
        "Entry format (must match):",
        "### <local timestamp YYYY-MM-DD HH:MM> ({{prev_run}} -> {{now}})",
        "Topics:",
        "- ...",
        "Decisions:",
        "- ...",
        "Action Items:",
        "- ...",
        "Risks/Blockers:",
        "- ...",
        "Signals:",
        "- ...",
        "Feedback:",
        "- ...",
        "Stats: <events> events | <user> user msgs | <assistant> assistant msgs | <toolCalls> tool calls (<toolErrors> errors) | files: +<created> ~<modified> -<deleted>",
        "",
        "Return 1-3 sentences confirming the write (do not paste the entire entry).",
      ].join("\n");

    const buildDailyPrompt = () =>
      [
        "You are the scheduled daily context sync for this workspace.",
        "",
        "Goal: consolidate today's work into `.cowork/memory/{{date}}.md` without destroying manual notes.",
        "",
        "Steps:",
        "1) Call tool `task_events` with:",
        '   - period: "today"',
        "   - limit: 500",
        `   - workspace_id: "${workspaceId}"`,
        "   - include_payload: true",
        "2) Ignore events where the taskTitle is one of:",
        '   - "Kit: Hourly Memory Digest"',
        '   - "Kit: Daily Context Sync"',
        '   - "Kit: Weekly Synthesis"',
        "3) Summarize ONLY from the tool output (do not hallucinate). Focus on: open loops, next actions, decisions, and a short narrative summary.",
        "4) Update `.cowork/memory/{{date}}.md` by upserting an auto section delimited by these markers:",
        "   - `<!-- cowork:auto:daily:start -->`",
        "   - `<!-- cowork:auto:daily:end -->`",
        "   If the file or markers are missing, create/append them; do not remove or rewrite other content.",
        "",
        "Auto section body format (must match):",
        "## Open Loops",
        "- ...",
        "",
        "## Next Actions",
        "- ...",
        "",
        "## Decisions",
        "- ...",
        "",
        "## Summary",
        "- ...",
        "",
        "Return 1-3 sentences confirming the update (do not paste the entire section).",
      ].join("\n");

    const buildWeeklyPrompt = () =>
      [
        "You are the scheduled weekly synthesis for this workspace.",
        "",
        "Goal: distill compounding learnings and next-week focus, then update `.cowork/MEMORY.md` (auto section) and write a weekly report file.",
        "",
        "Steps:",
        "1) Call tool `task_events` with:",
        '   - period: "last_7_days"',
        "   - limit: 500",
        `   - workspace_id: "${workspaceId}"`,
        "   - include_payload: true",
        "2) Read `.cowork/MISTAKES.md` to ground preference patterns in actual recorded feedback.",
        "3) Write a weekly report to `.cowork/memory/weekly/{{date}}.md` with:",
        "   - Wins (what shipped / moved forward)",
        "   - Misses (what stalled / why)",
        "   - Patterns (approval/rejection themes)",
        "   - Process updates (what to do differently)",
        "   - Next week focus (top 3)",
        "4) Update `.cowork/MEMORY.md` by upserting an auto section delimited by:",
        "   - `<!-- cowork:auto:memory:start -->`",
        "   - `<!-- cowork:auto:memory:end -->`",
        "   Keep it to 5-15 bullets, only durable learnings and preferences (no daily noise).",
        "",
        "Constraints:",
        "- Do not hallucinate; ground everything in tool output and `.cowork/MISTAKES.md`.",
        '- Ignore events from tasks titled "Kit: Hourly Memory Digest" / "Kit: Daily Context Sync" / "Kit: Weekly Synthesis".',
        "",
        "Return 1-3 sentences confirming the write (do not paste the full report).",
      ].join("\n");

    try {
      const existing = await cron.list({ includeDisabled: true });
      const existingInWorkspace = existing.filter(
        (j) => j.workspaceId === workspaceId,
      );

      const desired: Array<{ marker: string; job: CronJobCreate }> = [
        {
          marker: markers.hourly,
          job: {
            name: "Kit: Hourly Memory Digest",
            description: `Automated hourly memory digest. [${markers.hourly}]`,
            enabled: true,
            schedule: { kind: "cron", expr: "0 * * * *" },
            workspaceId,
            taskPrompt: buildHourlyPrompt(),
            taskTitle: "Kit: Hourly Memory Digest",
            maxHistoryEntries: 25,
          },
        },
        {
          marker: markers.daily,
          job: {
            name: "Kit: Daily Context Sync",
            description: `Automated daily context sync. [${markers.daily}]`,
            enabled: true,
            schedule: { kind: "cron", expr: "0 21 * * *" },
            workspaceId,
            taskPrompt: buildDailyPrompt(),
            taskTitle: "Kit: Daily Context Sync",
            maxHistoryEntries: 25,
          },
        },
        {
          marker: markers.weekly,
          job: {
            name: "Kit: Weekly Synthesis",
            description: `Automated weekly synthesis. [${markers.weekly}]`,
            enabled: true,
            schedule: { kind: "cron", expr: "0 18 * * 0" },
            workspaceId,
            taskPrompt: buildWeeklyPrompt(),
            taskTitle: "Kit: Weekly Synthesis",
            maxHistoryEntries: 25,
          },
        },
      ];

      const findJob = (name: string, marker: string) =>
        existingInWorkspace.find(
          (j) =>
            typeof j.description === "string" && j.description.includes(marker),
        ) ?? existingInWorkspace.find((j) => j.name === name);

      for (const spec of desired) {
        const existingJob = findJob(spec.job.name, spec.marker);
        if (!existingJob) {
          const res = await cron.add(spec.job);
          if (!res.ok) {
            logger.warn(
              "[Kit] Failed to add scheduled job:",
              spec.job.name,
              res.error,
            );
          }
          continue;
        }

        // Update kit-managed job prompts/description. Preserve schedule/enabled in "missing" mode.
        const patch: Any = {
          name: spec.job.name,
          description: spec.job.description,
          taskPrompt: spec.job.taskPrompt,
          taskTitle: spec.job.taskTitle,
          maxHistoryEntries: spec.job.maxHistoryEntries,
        };

        if (kitMode === "overwrite") {
          patch.enabled = spec.job.enabled;
          patch.schedule = spec.job.schedule;
        }

        const needsUpdate = (() => {
          if (existingJob.name !== patch.name) return true;
          if ((existingJob.description || "") !== (patch.description || ""))
            return true;
          if (existingJob.taskPrompt !== patch.taskPrompt) return true;
          if ((existingJob.taskTitle || "") !== (patch.taskTitle || ""))
            return true;
          if (
            (existingJob.maxHistoryEntries || 0) !==
            (patch.maxHistoryEntries || 0)
          )
            return true;
          if (kitMode === "overwrite") {
            if (existingJob.enabled !== patch.enabled) return true;
            if (
              JSON.stringify(existingJob.schedule) !==
              JSON.stringify(patch.schedule)
            )
              return true;
          }
          return false;
        })();

        if (!needsUpdate) continue;

        const res = await cron.update(existingJob.id, patch);
        if (!res.ok) {
          logger.warn(
            "[Kit] Failed to update scheduled job:",
            spec.job.name,
            res.error,
          );
        }
      }
    } catch (error) {
      logger.warn("[Kit] Failed to ensure default scheduled jobs:", error);
    }
  };

  ipcMain.handle(
    IPC_CHANNELS.KIT_GET_STATUS,
    async (_event, workspaceId: string) => {
      try {
        return await computeStatus(workspaceId);
      } catch (error: Any) {
        return {
          workspaceId,
          hasKitDir: false,
          files: [],
          missingCount: 0,
          error: error?.message || "Failed to load kit status",
        } as Any;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.KIT_INIT,
    async (_event, request: WorkspaceKitInitRequest) => {
      checkRateLimit(IPC_CHANNELS.KIT_INIT, RATE_LIMIT_CONFIGS.limited);
      const mode = request?.mode === "overwrite" ? "overwrite" : "missing";
      const preset =
        request?.templatePreset === "venture_operator"
          ? "venture_operator"
          : "default";
      const workspacePath = getWorkspacePath(request.workspaceId);
      const workspaceStateBefore = await readWorkspaceKitState(workspacePath);

      await ensureDir(workspacePath, path.join(kitDirName, "memory"));
      await ensureDir(workspacePath, path.join(kitDirName, "memory", "hourly"));
      await ensureDir(workspacePath, path.join(kitDirName, "memory", "weekly"));
      await ensureDir(workspacePath, path.join(kitDirName, "projects"));
      await ensureDir(workspacePath, path.join(kitDirName, "agents"));
      await ensureDir(workspacePath, path.join(kitDirName, "uploads"));
      await ensureDir(workspacePath, path.join(kitDirName, "transforms"));
      await ensureDir(workspacePath, path.join(kitDirName, "router"));
      await ensureDir(workspacePath, path.join(kitDirName, "policy"));
      await ensureDir(workspacePath, path.join(kitDirName, "feedback"));

      const now = new Date();
      const templates = templatesForInit(now, preset);
      for (const t of templates) {
        const isBootstrapTemplate =
          t.relPath === path.join(kitDirName, "BOOTSTRAP.md");
        if (
          isBootstrapTemplate &&
          mode === "missing" &&
          workspaceStateBefore.onboardingCompletedAt &&
          !fsSync.existsSync(path.join(workspacePath, t.relPath))
        ) {
          continue;
        }
        await writeTemplate(workspacePath, t.relPath, t.content, mode);
      }

      await ensureBootstrapLifecycleState(workspacePath, workspaceStateBefore);

      // Best-effort: keep kit notes searchable for hybrid recall (does not affect kit init success).
      try {
        await MemoryService.syncWorkspaceMarkdown(
          request.workspaceId,
          path.join(workspacePath, kitDirName),
          true,
        );
      } catch {
        // optional enhancement
      }

      await ensureDefaultKitCronJobs(request.workspaceId, mode);

      return await computeStatus(request.workspaceId);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.KIT_APPLY_ONBOARDING_PROFILE,
    async (_event, request: ApplyOnboardingProfileRequest) => {
      checkRateLimit(
        IPC_CHANNELS.KIT_APPLY_ONBOARDING_PROFILE,
        RATE_LIMIT_CONFIGS.limited,
      );

      if (!request?.data) {
        throw new Error("Onboarding profile data is required");
      }

      OnboardingProfileService.applyGlobalProfile(request.data);

      if (!request.workspaceId) {
        return { success: true };
      }

      const workspacePath = getWorkspacePath(request.workspaceId);
      await OnboardingProfileService.applyWorkspaceProfile(
        request.workspaceId,
        workspacePath,
        request.data,
      );

      return {
        success: true,
        workspaceId: request.workspaceId,
      };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.KIT_PROJECT_CREATE,
    async (_event, request: WorkspaceKitProjectCreateRequest) => {
      checkRateLimit(
        IPC_CHANNELS.KIT_PROJECT_CREATE,
        RATE_LIMIT_CONFIGS.limited,
      );
      const workspacePath = getWorkspacePath(request.workspaceId);

      const rawId = (request.projectId || "").trim();
      if (!rawId) throw new Error("Project id is required");
      if (rawId.includes("..") || rawId.includes("/") || rawId.includes("\\")) {
        throw new Error("Invalid project id");
      }
      if (!/^[a-zA-Z0-9._-]{1,80}$/.test(rawId)) {
        throw new Error("Invalid project id");
      }

      const projectRootRel = path.join(kitDirName, "projects", rawId);
      await ensureDir(workspacePath, projectRootRel);
      await ensureDir(workspacePath, path.join(projectRootRel, "research"));

      const projectStamp = getLocalDateStamp(new Date());

      await writeTemplate(
        workspacePath,
        path.join(projectRootRel, "ACCESS.md"),
        withKitFrontmatter(
          path.join(projectRootRel, "ACCESS.md"),
          `# Access\n\n## Allow\n- all\n\n## Deny\n- \n`,
          projectStamp,
        ),
        "missing",
      );
      await writeTemplate(
        workspacePath,
        path.join(projectRootRel, "CONTEXT.md"),
        withKitFrontmatter(
          path.join(projectRootRel, "CONTEXT.md"),
          `# Context\n\nLast updated by:\n\n## Goals\n\n## Constraints\n\n## Decisions\n\n## Notes\n`,
          projectStamp,
        ),
        "missing",
      );

      return { success: true, projectId: rawId };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.KIT_OPEN_FILE,
    async (_event, args: { workspaceId: string; relPath: string }) => {
      checkRateLimit(IPC_CHANNELS.KIT_OPEN_FILE, RATE_LIMIT_CONFIGS.limited);
      const workspacePath = getWorkspacePath(args.workspaceId);

      // Sanitize relPath: must start with .cowork/ and not escape it
      const relPath = (args.relPath || "").replace(/\\/g, "/").trim();
      if (!relPath.startsWith(".cowork/") || relPath.includes("..")) {
        throw new Error("Invalid relPath");
      }

      const absPath = path.join(workspacePath, relPath);
      await fs.mkdir(path.dirname(absPath), { recursive: true });

      if (!fsSync.existsSync(absPath)) {
        const fileName = path.basename(relPath);
        const stamp = getLocalDateStamp(new Date());
        let defaultContent = withKitFrontmatter(
          relPath,
          `# ${fileName.replace(".md", "")}\n\n`,
          stamp,
        );

        if (fileName === "DESIGN.md") {
          defaultContent = buildDefaultDesignSystemMarkdown();
        }

        if (fileName === "USER.md") {
          defaultContent = withKitFrontmatter(
            relPath,
            `# USER\n\ntimezone: \ncommunication_style: direct, concise\ndefault_language: English\nprefers: actionable outputs, ready-to-use snippets\navoid: vague advice, unnecessary repetition\n`,
            stamp,
          );
        }

        writeKitFileWithSnapshot(
          absPath,
          defaultContent,
          "system",
          "seed missing kit file",
        );
      }

      await shell.openPath(absPath);
      return true;
    },
  );

  ipcMain.handle(IPC_CHANNELS.KIT_RESET_ADAPTIVE_STYLE, () => {
    checkRateLimit(
      IPC_CHANNELS.KIT_RESET_ADAPTIVE_STYLE,
      RATE_LIMIT_CONFIGS.limited,
    );
    AdaptiveStyleEngine.reset();
  });

  ipcMain.handle(
    IPC_CHANNELS.KIT_SUBMIT_MESSAGE_FEEDBACK,
    async (
      _event,
      payload: {
        taskId: string;
        messageId?: string;
        decision: "accepted" | "rejected";
        reason?: string;
        note?: string;
        kind?: "message" | "task";
      },
    ) => {
      checkRateLimit(
        IPC_CHANNELS.KIT_SUBMIT_MESSAGE_FEEDBACK,
        RATE_LIMIT_CONFIGS.limited,
      );
      const { taskId, decision, reason, note, kind, messageId } = payload;
      const feedback = [reason, note].filter(Boolean).join(": ") || undefined;
      agentDaemon.logEvent(taskId, "user_feedback", {
        decision,
        reason: feedback,
        kind: kind || "message",
        messageId,
        rating:
          kind === "task"
            ? decision === "accepted"
              ? "positive"
              : "negative"
            : undefined,
      });
    },
  );
}

/**
 * Set up Memory System IPC handlers
 */
function setupMemoryHandlers(): void {
  rateLimiter.configure(
    IPC_CHANNELS.AWARENESS_SAVE_CONFIG,
    RATE_LIMIT_CONFIGS.limited,
  );
  rateLimiter.configure(
    IPC_CHANNELS.AWARENESS_UPDATE_BELIEF,
    RATE_LIMIT_CONFIGS.limited,
  );
  rateLimiter.configure(
    IPC_CHANNELS.AWARENESS_DELETE_BELIEF,
    RATE_LIMIT_CONFIGS.limited,
  );
  rateLimiter.configure(
    IPC_CHANNELS.AUTONOMY_SAVE_CONFIG,
    RATE_LIMIT_CONFIGS.limited,
  );
  rateLimiter.configure(
    IPC_CHANNELS.AUTONOMY_UPDATE_DECISION,
    RATE_LIMIT_CONFIGS.limited,
  );
  rateLimiter.configure(
    IPC_CHANNELS.AUTONOMY_TRIGGER_EVALUATION,
    RATE_LIMIT_CONFIGS.standard,
  );

  // Get memory settings for a workspace
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_GET_SETTINGS,
    async (_, workspaceId: string) => {
      try {
        return MemoryService.getSettings(workspaceId);
      } catch (error) {
        logger.error("[Memory] Failed to get settings:", error);
        // Return default settings if service not initialized
        return {
          workspaceId,
          enabled: true,
          autoCapture: true,
          compressionEnabled: true,
          retentionDays: 90,
          maxStorageMb: 100,
          privacyMode: "normal",
          excludedPatterns: [],
        };
      }
    },
  );

  // Save memory settings for a workspace
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_SAVE_SETTINGS,
    async (
      _,
      data: { workspaceId: string; settings: Partial<MemorySettings> },
    ) => {
      checkRateLimit(
        IPC_CHANNELS.MEMORY_SAVE_SETTINGS,
        RATE_LIMIT_CONFIGS.limited,
      );
      try {
        MemoryService.updateSettings(data.workspaceId, data.settings);
        return { success: true };
      } catch (error) {
        logger.error("[Memory] Failed to save settings:", error);
        throw error;
      }
    },
  );

  // Get global memory feature toggles
  ipcMain.handle(IPC_CHANNELS.MEMORY_FEATURES_GET_SETTINGS, async () => {
    try {
      return MemoryFeaturesManager.loadSettings();
    } catch (error) {
      logger.error("[MemoryFeatures] Failed to get settings:", error);
      return {
        contextPackInjectionEnabled: true,
        heartbeatMaintenanceEnabled: true,
        checkpointCaptureEnabled: true,
        verbatimRecallEnabled: true,
        wakeUpLayersEnabled: true,
        temporalKnowledgeEnabled: true,
        structuredObservationsEnabled: true,
        progressiveRecallToolsEnabled: true,
        memoryInspectorEnabled: true,
      };
    }
  });

  // Save global memory feature toggles
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_FEATURES_SAVE_SETTINGS,
    async (_event, settings: Any) => {
      checkRateLimit(
        IPC_CHANNELS.MEMORY_FEATURES_SAVE_SETTINGS,
        RATE_LIMIT_CONFIGS.limited,
      );
      try {
        MemoryFeaturesManager.saveSettings(settings);
        return { success: true };
      } catch (error) {
        logger.error("[MemoryFeatures] Failed to save settings:", error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_FEATURES_GET_LAYER_PREVIEW,
    async (_event, workspaceId: string) => {
      try {
        const previewDb = DatabaseManager.getInstance().getDatabase();
        const previewWorkspaceRepo = new WorkspaceRepository(previewDb);
        const previewTaskRepo = new TaskRepository(previewDb);
        const workspace = previewWorkspaceRepo.findById(workspaceId);
        if (!workspace?.path) {
          return null;
        }
        const recentTask = previewTaskRepo.findByWorkspace(workspaceId, 1)[0];
        const taskPrompt =
          typeof recentTask?.prompt === "string" && recentTask.prompt.trim().length > 0
            ? recentTask.prompt
            : "Current workspace memory preview";
        return MemorySynthesizer.buildLayerPreview(
          workspaceId,
          workspace.path,
          taskPrompt,
          {
            tokenBudget: 1800,
            includeWorkspaceKit: true,
            agentRoleId: recentTask?.assignedAgentRoleId || null,
          },
        );
      } catch (error) {
        logger.error("[MemoryFeatures] Failed to build layer preview:", error);
        return null;
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.SUPERMEMORY_GET_SETTINGS, async () => {
    try {
      return SupermemoryService.getSettingsView();
    } catch (error) {
      logger.error("[Supermemory] Failed to get settings:", error);
      throw error;
    }
  });

  ipcMain.handle(IPC_CHANNELS.SUPERMEMORY_GET_STATUS, async () => {
    try {
      return SupermemoryService.getConfigStatus();
    } catch (error) {
      logger.error("[Supermemory] Failed to get status:", error);
      throw error;
    }
  });

  ipcMain.handle(IPC_CHANNELS.SUPERMEMORY_SAVE_SETTINGS, async (_event, settings: Any) => {
    checkRateLimit(IPC_CHANNELS.SUPERMEMORY_SAVE_SETTINGS, RATE_LIMIT_CONFIGS.limited);
    try {
      const validated = validateInput(
        SupermemorySettingsInputSchema,
        settings,
        "supermemory settings",
      );
      SupermemoryService.saveSettings(validated);
      return { success: true };
    } catch (error) {
      logger.error("[Supermemory] Failed to save settings:", error);
      throw error;
    }
  });

  ipcMain.handle(IPC_CHANNELS.SUPERMEMORY_TEST_CONNECTION, async () => {
    try {
      return await SupermemoryService.testConnection();
    } catch (error) {
      logger.error("[Supermemory] Failed to test connection:", error);
      return {
        success: false,
        error: error instanceof Error ? error.message : "Failed to reach Supermemory",
      };
    }
  });

  // Search memories
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_SEARCH,
    async (_, data: { workspaceId: string; query: string; limit?: number }) => {
      try {
        return MemoryService.search(data.workspaceId, data.query, data.limit);
      } catch (error) {
        logger.error("[Memory] Failed to search:", error);
        return [];
      }
    },
  );

  // Get timeline context (Layer 2)
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_GET_TIMELINE,
    async (_, data: { memoryId: string; windowSize?: number }) => {
      try {
        return MemoryService.getTimelineContext(data.memoryId, data.windowSize);
      } catch (error) {
        logger.error("[Memory] Failed to get timeline:", error);
        return [];
      }
    },
  );

  // Get full details (Layer 3)
  ipcMain.handle(IPC_CHANNELS.MEMORY_GET_DETAILS, async (_, ids: string[]) => {
    try {
      return MemoryService.getFullDetails(ids);
    } catch (error) {
      logger.error("[Memory] Failed to get details:", error);
      return [];
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_OBSERVATIONS_SEARCH,
    async (_, data: MemoryObservationSearchQuery) => {
      try {
        return MemoryObservationService.search(data);
      } catch (error) {
        logger.error("[MemoryObservations] Failed to search:", error);
        return [];
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_OBSERVATIONS_TIMELINE,
    async (_, data: { workspaceId: string; memoryId?: string; query?: string; windowSize?: number }) => {
      try {
        return MemoryObservationService.timeline(data);
      } catch (error) {
        logger.error("[MemoryObservations] Failed to load timeline:", error);
        return [];
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.MEMORY_OBSERVATIONS_DETAILS, async (_, data: unknown) => {
    try {
      const validated = validateInput(MemoryObservationDetailsSchema, data, "memory observation details");
      return MemoryObservationService.details(validated.ids, validated.workspaceId);
    } catch (error) {
      logger.error("[MemoryObservations] Failed to get details:", error);
      return [];
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_OBSERVATIONS_UPDATE,
    async (_, data: unknown) => {
      checkRateLimit(IPC_CHANNELS.MEMORY_OBSERVATIONS_UPDATE, RATE_LIMIT_CONFIGS.limited);
      const validated = validateInput(MemoryObservationUpdateSchema, data, "memory observation update");
      return MemoryObservationService.update(validated.workspaceId, validated.memoryId, validated.patch);
    },
  );

  ipcMain.handle(IPC_CHANNELS.MEMORY_OBSERVATIONS_DELETE, async (_, data: unknown) => {
    checkRateLimit(IPC_CHANNELS.MEMORY_OBSERVATIONS_DELETE, RATE_LIMIT_CONFIGS.limited);
    const validated = validateInput(MemoryObservationMutationSchema, data, "memory observation delete");
    return { success: MemoryObservationService.delete(validated.workspaceId, validated.memoryId) };
  });

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_OBSERVATIONS_REDACT,
    async (_, data: unknown) => {
      checkRateLimit(IPC_CHANNELS.MEMORY_OBSERVATIONS_REDACT, RATE_LIMIT_CONFIGS.limited);
      const validated = validateInput(MemoryObservationRedactSchema, data, "memory observation redact");
      return MemoryObservationService.redact(validated.workspaceId, validated.memoryId, validated.replacement);
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_OBSERVATIONS_PROMOTE,
    async (_, data: unknown) => {
      checkRateLimit(IPC_CHANNELS.MEMORY_OBSERVATIONS_PROMOTE, RATE_LIMIT_CONFIGS.limited);
      const validated = validateInput(MemoryObservationPromoteSchema, data, "memory observation promote");
      const detail = MemoryObservationService.details([validated.memoryId], validated.workspaceId)[0];
      if (!detail) return { success: false, error: "Memory observation not found" };
      return CuratedMemoryService.curate({
        workspaceId: detail.workspaceId,
        taskId: detail.taskId,
        action: "add",
        target: validated.target || "workspace",
        kind: validated.kind || "project_fact",
        content: detail.title || detail.narrative,
        reason: "Promoted from Memory Hub Inspector",
      });
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_OBSERVATIONS_REBUILD_METADATA,
    async (_event, data?: unknown) => {
      checkRateLimit(IPC_CHANNELS.MEMORY_OBSERVATIONS_REBUILD_METADATA, RATE_LIMIT_CONFIGS.limited);
      const validated = data === undefined
        ? undefined
        : validateInput(MemoryObservationRebuildSchema, data, "memory observation metadata rebuild");
      return MemoryObservationService.startBackfill(validated?.force === true);
    },
  );

  ipcMain.handle(IPC_CHANNELS.MEMORY_OBSERVATIONS_BACKFILL_STATUS, async () => {
    return MemoryObservationService.getBackfillStatus();
  });

  // Get recent memories
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_GET_RECENT,
    async (_, data: { workspaceId: string; limit?: number }) => {
      try {
        return MemoryService.getRecent(data.workspaceId, data.limit);
      } catch (error) {
        logger.error("[Memory] Failed to get recent:", error);
        return [];
      }
    },
  );

  // Get memory statistics
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_GET_STATS,
    async (_, workspaceId: string) => {
      try {
        return MemoryService.getStats(workspaceId);
      } catch (error) {
        logger.error("[Memory] Failed to get stats:", error);
        return {
          count: 0,
          totalTokens: 0,
          compressedCount: 0,
          compressionRatio: 0,
        };
      }
    },
  );

  // Clear all memories for a workspace
  ipcMain.handle(IPC_CHANNELS.MEMORY_CLEAR, async (_, workspaceId: string) => {
    checkRateLimit(IPC_CHANNELS.MEMORY_CLEAR, RATE_LIMIT_CONFIGS.limited);
    try {
      MemoryService.clearWorkspace(workspaceId);
      return { success: true };
    } catch (error) {
      logger.error("[Memory] Failed to clear:", error);
      throw error;
    }
  });

  // Get imported memory stats
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_GET_IMPORTED_STATS,
    async (_, workspaceId: string) => {
      try {
        return MemoryService.getImportedStats(workspaceId);
      } catch (error) {
        logger.error("[Memory] Failed to get imported stats:", error);
        return { count: 0, totalTokens: 0 };
      }
    },
  );

  // Find imported memories with pagination
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_FIND_IMPORTED,
    async (_, data: unknown) => {
      const validated = validateInput(
        FindImportedSchema,
        data,
        "find imported memories",
      );
      try {
        return MemoryService.findImported(
          validated.workspaceId,
          validated.limit,
          validated.offset,
        );
      } catch (error) {
        logger.error("[Memory] Failed to find imported:", error);
        return [];
      }
    },
  );

  // Delete all imported memories
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_DELETE_IMPORTED,
    async (_, workspaceId: string) => {
      checkRateLimit(
        IPC_CHANNELS.MEMORY_DELETE_IMPORTED,
        RATE_LIMIT_CONFIGS.limited,
      );
      try {
        const deleted = MemoryService.deleteImported(workspaceId);
        return { success: true, deleted };
      } catch (error) {
        logger.error("[Memory] Failed to delete imported:", error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_DELETE_IMPORTED_ENTRY,
    async (_, data: unknown) => {
      checkRateLimit(
        IPC_CHANNELS.MEMORY_DELETE_IMPORTED_ENTRY,
        RATE_LIMIT_CONFIGS.limited,
      );
      const validated = validateInput(
        DeleteImportedEntrySchema,
        data,
        "delete imported memory entry",
      );
      try {
        const success = MemoryService.deleteImportedEntry(
          validated.workspaceId,
          validated.memoryId,
        );
        return { success };
      } catch (error) {
        logger.error("[Memory] Failed to delete imported entry:", error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_SET_IMPORTED_RECALL_IGNORED,
    async (_, data: unknown) => {
      checkRateLimit(
        IPC_CHANNELS.MEMORY_SET_IMPORTED_RECALL_IGNORED,
        RATE_LIMIT_CONFIGS.limited,
      );
      const validated = validateInput(
        SetImportedRecallIgnoredSchema,
        data,
        "set imported memory prompt-recall ignored state",
      );
      try {
        const memory = MemoryService.setImportedPromptRecallIgnored(
          validated.workspaceId,
          validated.memoryId,
          validated.ignored,
        );
        return { success: Boolean(memory), memory };
      } catch (error) {
        logger.error(
          "[Memory] Failed to update imported memory prompt-recall state:",
          error,
        );
        throw error;
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.MEMORY_GET_USER_PROFILE, async () => {
    try {
      return UserProfileService.getProfile();
    } catch (error) {
      logger.error("[Memory] Failed to get user profile:", error);
      return { facts: [], updatedAt: Date.now() };
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_ADD_USER_FACT,
    async (_, request: AddUserFactRequest) => {
      checkRateLimit(
        IPC_CHANNELS.MEMORY_ADD_USER_FACT,
        RATE_LIMIT_CONFIGS.limited,
      );
      try {
        return UserProfileService.addFact(request);
      } catch (error) {
        logger.error("[Memory] Failed to add user fact:", error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_UPDATE_USER_FACT,
    async (_, request: UpdateUserFactRequest) => {
      checkRateLimit(
        IPC_CHANNELS.MEMORY_UPDATE_USER_FACT,
        RATE_LIMIT_CONFIGS.limited,
      );
      try {
        return UserProfileService.updateFact(request);
      } catch (error) {
        logger.error("[Memory] Failed to update user fact:", error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_DELETE_USER_FACT,
    async (_, id: string) => {
      checkRateLimit(
        IPC_CHANNELS.MEMORY_DELETE_USER_FACT,
        RATE_LIMIT_CONFIGS.limited,
      );
      try {
        return { success: UserProfileService.deleteFact(id) };
      } catch (error) {
        logger.error("[Memory] Failed to delete user fact:", error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_RELATIONSHIP_LIST,
    async (
      _,
      data?: {
        layer?:
          | "identity"
          | "preferences"
          | "context"
          | "history"
          | "commitments";
        includeDone?: boolean;
        limit?: number;
      },
    ) => {
      try {
        return RelationshipMemoryService.listItems({
          layer: data?.layer,
          includeDone: data?.includeDone,
          limit: data?.limit,
        });
      } catch (error) {
        logger.error("[Memory] Failed to list relationship memory:", error);
        return [];
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_RELATIONSHIP_UPDATE,
    async (
      _,
      data: {
        id: string;
        text?: string;
        confidence?: number;
        status?: "open" | "done";
        dueAt?: number | null;
      },
    ) => {
      checkRateLimit(
        IPC_CHANNELS.MEMORY_RELATIONSHIP_UPDATE,
        RATE_LIMIT_CONFIGS.limited,
      );
      try {
        if (!data?.id || typeof data.id !== "string") {
          throw new Error("id is required");
        }
        return RelationshipMemoryService.updateItem(data.id, {
          text: data.text,
          confidence: data.confidence,
          status: data.status,
          dueAt: data.dueAt,
        });
      } catch (error) {
        logger.error("[Memory] Failed to update relationship memory:", error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_RELATIONSHIP_DELETE,
    async (_, id: string) => {
      checkRateLimit(
        IPC_CHANNELS.MEMORY_RELATIONSHIP_DELETE,
        RATE_LIMIT_CONFIGS.limited,
      );
      try {
        if (!id || typeof id !== "string") {
          throw new Error("id is required");
        }
        return { success: RelationshipMemoryService.deleteItem(id) };
      } catch (error) {
        logger.error(
          "[Memory] Failed to delete relationship memory item:",
          error,
        );
        throw error;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_RELATIONSHIP_CLEANUP_RECURRING,
    async () => {
      checkRateLimit(
        IPC_CHANNELS.MEMORY_RELATIONSHIP_CLEANUP_RECURRING,
        RATE_LIMIT_CONFIGS.limited,
      );
      try {
        const result = RelationshipMemoryService.cleanupRecurringTaskHistory();
        return { success: true, ...result };
      } catch (error) {
        logger.error(
          "[Memory] Failed to cleanup recurring relationship history:",
          error,
        );
        throw error;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_COMMITMENTS_GET,
    async (_, data?: { limit?: number }) => {
      try {
        const limit =
          typeof data?.limit === "number" && Number.isFinite(data.limit)
            ? data.limit
            : 25;
        return RelationshipMemoryService.listOpenCommitments(limit);
      } catch (error) {
        logger.error("[Memory] Failed to list open commitments:", error);
        return [];
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_COMMITMENTS_DUE_SOON,
    async (_, data?: { windowHours?: number }) => {
      try {
        const windowHours =
          typeof data?.windowHours === "number" &&
          Number.isFinite(data.windowHours)
            ? data.windowHours
            : 72;
        const items =
          RelationshipMemoryService.listDueSoonCommitments(windowHours);
        const reminderText =
          items.length > 0
            ? `You have ${items.length} commitment(s) due soon.`
            : "No commitments due soon.";
        return { items, reminderText };
      } catch (error) {
        logger.error("[Memory] Failed to list due soon commitments:", error);
        return { items: [], reminderText: "No commitments due soon." };
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.AWARENESS_GET_CONFIG, async () => {
    try {
      return getAwarenessService().getConfig();
    } catch (error) {
      logger.error("[Awareness] Failed to get config:", error);
      throw error;
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.AWARENESS_SAVE_CONFIG,
    async (_, config: unknown) => {
      checkRateLimit(
        IPC_CHANNELS.AWARENESS_SAVE_CONFIG,
        RATE_LIMIT_CONFIGS.limited,
      );
      try {
        const validated = validateInput(
          AwarenessConfigSchema,
          config,
          "awareness config",
        );
        return getAwarenessService().saveConfig(validated as Any);
      } catch (error) {
        logger.error("[Awareness] Failed to save config:", error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AWARENESS_LIST_BELIEFS,
    async (_, workspaceId?: string) => {
      try {
        return getAwarenessService().listBeliefs(workspaceId);
      } catch (error) {
        logger.error("[Awareness] Failed to list beliefs:", error);
        return [];
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AWARENESS_UPDATE_BELIEF,
    async (_, data: unknown) => {
      checkRateLimit(
        IPC_CHANNELS.AWARENESS_UPDATE_BELIEF,
        RATE_LIMIT_CONFIGS.limited,
      );
      try {
        const validated = validateInput(
          AwarenessUpdateBeliefSchema,
          data,
          "awareness update belief",
        );
        return getAwarenessService().updateBelief(
          validated.id,
          validated.patch || {},
        );
      } catch (error) {
        logger.error("[Awareness] Failed to update belief:", error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AWARENESS_DELETE_BELIEF,
    async (_, id: string) => {
      checkRateLimit(
        IPC_CHANNELS.AWARENESS_DELETE_BELIEF,
        RATE_LIMIT_CONFIGS.limited,
      );
      try {
        return { success: getAwarenessService().deleteBelief(id) };
      } catch (error) {
        logger.error("[Awareness] Failed to delete belief:", error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AWARENESS_GET_SUMMARY,
    async (_, workspaceId?: string) => {
      try {
        return getAwarenessService().getSummary(workspaceId);
      } catch (error) {
        logger.error("[Awareness] Failed to get summary:", error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AWARENESS_GET_SNAPSHOT,
    async (_, workspaceId?: string) => {
      try {
        return getAwarenessService().getSnapshot(workspaceId);
      } catch (error) {
        logger.error("[Awareness] Failed to get snapshot:", error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AWARENESS_LIST_EVENTS,
    async (_, data?: { workspaceId?: string; limit?: number }) => {
      try {
        return getAwarenessService().listEvents(data || {});
      } catch (error) {
        logger.error("[Awareness] Failed to list events:", error);
        return [];
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.AUTONOMY_GET_CONFIG, async () => {
    try {
      return getAutonomyEngine().getConfig();
    } catch (error) {
      logger.error("[Autonomy] Failed to get config:", error);
      throw error;
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.AUTONOMY_SAVE_CONFIG,
    async (_, config: unknown) => {
      checkRateLimit(
        IPC_CHANNELS.AUTONOMY_SAVE_CONFIG,
        RATE_LIMIT_CONFIGS.limited,
      );
      try {
        const validated = validateInput(
          AutonomyConfigSchema,
          config,
          "autonomy config",
        );
        return getAutonomyEngine().saveConfig(validated as Any);
      } catch (error) {
        logger.error("[Autonomy] Failed to save config:", error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTONOMY_GET_STATE,
    async (_, workspaceId?: string) => {
      try {
        return getAutonomyEngine().getWorldModel(workspaceId);
      } catch (error) {
        logger.error("[Autonomy] Failed to get state:", error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTONOMY_LIST_DECISIONS,
    async (_, workspaceId?: string) => {
      try {
        return getAutonomyEngine().listDecisions(workspaceId);
      } catch (error) {
        logger.error("[Autonomy] Failed to list decisions:", error);
        return [];
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTONOMY_LIST_ACTIONS,
    async (_, workspaceId?: string) => {
      try {
        return getAutonomyEngine().listActions(workspaceId);
      } catch (error) {
        logger.error("[Autonomy] Failed to list actions:", error);
        return [];
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTONOMY_UPDATE_DECISION,
    async (_, data: unknown) => {
      checkRateLimit(
        IPC_CHANNELS.AUTONOMY_UPDATE_DECISION,
        RATE_LIMIT_CONFIGS.limited,
      );
      try {
        const validated = validateInput(
          AutonomyUpdateDecisionSchema,
          data,
          "autonomy update decision",
        );
        return getAutonomyEngine().updateDecision(
          validated.id,
          validated.patch || {},
        );
      } catch (error) {
        logger.error("[Autonomy] Failed to update decision:", error);
        throw error;
      }
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.AUTONOMY_TRIGGER_EVALUATION,
    async (_, workspaceId?: string) => {
      checkRateLimit(
        IPC_CHANNELS.AUTONOMY_TRIGGER_EVALUATION,
        RATE_LIMIT_CONFIGS.standard,
      );
      try {
        return getAutonomyEngine().triggerEvaluation(workspaceId);
      } catch (error) {
        logger.error("[Autonomy] Failed to trigger evaluation:", error);
        throw error;
      }
    },
  );

  // ChatGPT Import handler
  let activeImportAbort: AbortController | null = null;
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_IMPORT_CHATGPT,
    async (event, options: unknown) => {
      checkRateLimit(
        IPC_CHANNELS.MEMORY_IMPORT_CHATGPT,
        RATE_LIMIT_CONFIGS.limited,
      );
      const validated = validateInput(
        ChatGPTImportSchema,
        options,
        "ChatGPT import",
      );
      try {
        const { ChatGPTImporter } = await import("../memory/ChatGPTImporter");

        // Create an abort controller for cancellation
        activeImportAbort = new AbortController();

        // Forward progress events to renderer
        const unsubscribe = ChatGPTImporter.onProgress((progress) => {
          const win = BrowserWindow.fromWebContents(event.sender);
          if (win && !win.isDestroyed()) {
            win.webContents.send(
              IPC_CHANNELS.MEMORY_IMPORT_CHATGPT_PROGRESS,
              progress,
            );
          }
        });

        try {
          const result = await ChatGPTImporter.import({
            ...validated,
            signal: activeImportAbort.signal,
          });
          return result;
        } finally {
          unsubscribe();
          activeImportAbort = null;
        }
      } catch (error) {
        logger.error("[Memory] ChatGPT import failed:", error);
        throw error;
      }
    },
  );

  // ChatGPT Import cancel handler
  ipcMain.handle(IPC_CHANNELS.MEMORY_IMPORT_CHATGPT_CANCEL, async () => {
    if (activeImportAbort) {
      activeImportAbort.abort();
      return { cancelled: true };
    }
    return { cancelled: false };
  });

  // Text-based memory import handler (provider-agnostic)
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_IMPORT_TEXT,
    async (_, options: unknown) => {
      checkRateLimit(
        IPC_CHANNELS.MEMORY_IMPORT_TEXT,
        RATE_LIMIT_CONFIGS.limited,
      );
      const validated = validateInput(
        TextMemoryImportSchema,
        options,
        "text memory import",
      );
      try {
        return MemoryService.importFromText(validated);
      } catch (error) {
        logger.error("[Memory] Text import failed:", error);
        throw error;
      }
    },
  );

  logger.debug("[Memory] Handlers initialized");

  // === Migration Status Handlers ===
  // These handlers help show one-time notifications after app migration (cowork-oss → cowork-os)

  const userDataPath = getUserDataDir();
  const migrationMarkerPath = path.join(
    userDataPath,
    ".migrated-from-cowork-oss",
  );
  const notificationDismissedPath = path.join(
    userDataPath,
    ".migration-notification-dismissed",
  );

  // Get migration status
  ipcMain.handle(IPC_CHANNELS.MIGRATION_GET_STATUS, async () => {
    try {
      const migrated = fsSync.existsSync(migrationMarkerPath);
      const notificationDismissed = fsSync.existsSync(
        notificationDismissedPath,
      );

      let timestamp: string | undefined;
      if (migrated) {
        try {
          const markerContent = fsSync.readFileSync(
            migrationMarkerPath,
            "utf-8",
          );
          const markerData = JSON.parse(markerContent);
          timestamp = markerData.timestamp;
        } catch {
          // Old format marker or read error
        }
      }

      return {
        migrated,
        notificationDismissed,
        timestamp,
      };
    } catch (error) {
      logger.error("[Migration] Failed to get status:", error);
      return { migrated: false, notificationDismissed: true }; // Default to no notification on error
    }
  });

  // Dismiss migration notification (user has acknowledged it)
  ipcMain.handle(IPC_CHANNELS.MIGRATION_DISMISS_NOTIFICATION, async () => {
    try {
      fsSync.writeFileSync(
        notificationDismissedPath,
        JSON.stringify({
          dismissedAt: new Date().toISOString(),
        }),
      );
      logger.debug("[Migration] Notification dismissed");
      return { success: true };
    } catch (error) {
      logger.error("[Migration] Failed to dismiss notification:", error);
      throw error;
    }
  });

  logger.debug("[Migration] Handlers initialized");

  // === Extension / Plugin Handlers ===
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  // oxlint-disable-next-line typescript-eslint(no-require-imports)
  const { getPluginRegistry } = require("../extensions/registry");
  const normalizePluginAuthor = (author?: string): string | undefined => {
    if (typeof author !== "string") return undefined;
    const trimmed = author.trim();
    if (!trimmed) return undefined;
    return /^cowork-oss$/i.test(trimmed) ? "CoWork OS" : trimmed;
  };

  // List all extensions
  ipcMain.handle(IPC_CHANNELS.EXTENSIONS_LIST, async () => {
    try {
      const registry = getPluginRegistry();
      const plugins = registry.getPlugins();
      return plugins.map((p: Any) => ({
        name: p.manifest.name,
        displayName: p.manifest.displayName,
        version: p.manifest.version,
        description: p.manifest.description,
        author: normalizePluginAuthor(p.manifest.author),
        type: p.manifest.type,
        state: p.state,
        path: p.path,
        loadedAt: p.loadedAt.getTime(),
        error: p.error?.message,
        capabilities: p.manifest.capabilities,
        configSchema: p.manifest.configSchema,
      }));
    } catch (error) {
      logger.error("[Extensions] Failed to list:", error);
      return [];
    }
  });

  // Get single extension
  ipcMain.handle(IPC_CHANNELS.EXTENSIONS_GET, async (_, name: string) => {
    try {
      const registry = getPluginRegistry();
      const plugin = registry.getPlugin(name);
      if (!plugin) return null;
      return {
        name: plugin.manifest.name,
        displayName: plugin.manifest.displayName,
        version: plugin.manifest.version,
        description: plugin.manifest.description,
        author: normalizePluginAuthor(plugin.manifest.author),
        type: plugin.manifest.type,
        state: plugin.state,
        path: plugin.path,
        loadedAt: plugin.loadedAt.getTime(),
        error: plugin.error?.message,
        capabilities: plugin.manifest.capabilities,
        configSchema: plugin.manifest.configSchema,
      };
    } catch (error) {
      logger.error("[Extensions] Failed to get:", error);
      return null;
    }
  });

  // Enable extension
  ipcMain.handle(IPC_CHANNELS.EXTENSIONS_ENABLE, async (_, name: string) => {
    try {
      const registry = getPluginRegistry();
      await registry.enablePlugin(name);
      return { success: true };
    } catch (error: Any) {
      logger.error("[Extensions] Failed to enable:", error);
      return { success: false, error: error.message };
    }
  });

  // Disable extension
  ipcMain.handle(IPC_CHANNELS.EXTENSIONS_DISABLE, async (_, name: string) => {
    try {
      const registry = getPluginRegistry();
      await registry.disablePlugin(name);
      return { success: true };
    } catch (error: Any) {
      logger.error("[Extensions] Failed to disable:", error);
      return { success: false, error: error.message };
    }
  });

  // Reload extension
  ipcMain.handle(IPC_CHANNELS.EXTENSIONS_RELOAD, async (_, name: string) => {
    try {
      const registry = getPluginRegistry();
      await registry.reloadPlugin(name);
      return { success: true };
    } catch (error: Any) {
      logger.error("[Extensions] Failed to reload:", error);
      return { success: false, error: error.message };
    }
  });

  // Get extension config
  ipcMain.handle(
    IPC_CHANNELS.EXTENSIONS_GET_CONFIG,
    async (_, name: string) => {
      try {
        const registry = getPluginRegistry();
        return registry.getPluginConfig(name) || {};
      } catch (error) {
        logger.error("[Extensions] Failed to get config:", error);
        return {};
      }
    },
  );

  // Set extension config
  ipcMain.handle(
    IPC_CHANNELS.EXTENSIONS_SET_CONFIG,
    async (_, data: { name: string; config: Record<string, unknown> }) => {
      try {
        const registry = getPluginRegistry();
        await registry.setPluginConfig(data.name, data.config);
        return { success: true };
      } catch (error: Any) {
        logger.error("[Extensions] Failed to set config:", error);
        return { success: false, error: error.message };
      }
    },
  );

  // Discover extensions (re-scan directories for new plugins)
  ipcMain.handle(IPC_CHANNELS.EXTENSIONS_DISCOVER, async () => {
    try {
      const registry = getPluginRegistry();
      await registry.initialize(); // no-op if already initialized at startup
      await registry.discoverNewPlugins(); // scan for newly-added plugins
      const plugins = registry.getPlugins();
      return plugins.map((p: Any) => ({
        name: p.manifest.name,
        displayName: p.manifest.displayName,
        version: p.manifest.version,
        description: p.manifest.description,
        type: p.manifest.type,
        state: p.state,
      }));
    } catch (error) {
      logger.error("[Extensions] Failed to discover:", error);
      return [];
    }
  });

  logger.debug("[Extensions] Handlers initialized");

  // === Webhook Tunnel Handlers ===
  let tunnelManager: Any = null;

  // Get tunnel status
  ipcMain.handle(IPC_CHANNELS.TUNNEL_GET_STATUS, async () => {
    try {
      if (!tunnelManager) {
        return { status: "stopped" };
      }
      return {
        status: tunnelManager.status,
        provider: tunnelManager.config?.provider,
        url: tunnelManager.url,
        error: tunnelManager.error?.message,
        startedAt: tunnelManager.startedAt?.getTime(),
      };
    } catch (error) {
      logger.error("[Tunnel] Failed to get status:", error);
      return { status: "stopped" };
    }
  });

  // Start tunnel
  ipcMain.handle(IPC_CHANNELS.TUNNEL_START, async (_, config: Any) => {
    try {
      const { TunnelManager } = await import("../gateway/tunnel");
      if (tunnelManager) {
        await tunnelManager.stop();
      }
      tunnelManager = new TunnelManager(config);
      const url = await tunnelManager.start();
      return { success: true, url };
    } catch (error: Any) {
      logger.error("[Tunnel] Failed to start:", error);
      return { success: false, error: error.message };
    }
  });

  // Stop tunnel
  ipcMain.handle(IPC_CHANNELS.TUNNEL_STOP, async () => {
    try {
      if (tunnelManager) {
        await tunnelManager.stop();
        tunnelManager = null;
      }
      return { success: true };
    } catch (error: Any) {
      logger.error("[Tunnel] Failed to stop:", error);
      return { success: false, error: error.message };
    }
  });

  logger.debug("[Tunnel] Handlers initialized");

  // === Voice Mode Handlers ===

  // Initialize voice settings manager with secure database storage
  const voiceDb = DatabaseManager.getInstance().getDatabase();
  VoiceSettingsManager.initialize(voiceDb);

  // Get voice settings
  ipcMain.handle(IPC_CHANNELS.VOICE_GET_SETTINGS, async () => {
    try {
      return VoiceSettingsManager.loadSettings();
    } catch (error) {
      logger.error("[Voice] Failed to get settings:", error);
      throw error;
    }
  });

  // Save voice settings
  ipcMain.handle(IPC_CHANNELS.VOICE_SAVE_SETTINGS, async (_, settings: Any) => {
    try {
      const updated = VoiceSettingsManager.updateSettings(settings);
      // Update the voice service with new settings
      const voiceService = getVoiceService();
      voiceService.updateSettings(updated);
      return updated;
    } catch (error) {
      logger.error("[Voice] Failed to save settings:", error);
      throw error;
    }
  });

  // Get voice state
  ipcMain.handle(IPC_CHANNELS.VOICE_GET_STATE, async () => {
    try {
      const voiceService = getVoiceService();
      return voiceService.getState();
    } catch (error) {
      logger.error("[Voice] Failed to get state:", error);
      throw error;
    }
  });

  // Speak text - returns audio data for renderer to play
  ipcMain.handle(IPC_CHANNELS.VOICE_SPEAK, async (_, text: string) => {
    try {
      const voiceService = getVoiceService();
      const audioBuffer = await voiceService.speak(text);
      if (audioBuffer) {
        // Return audio data as array for serialization over IPC
        return { success: true, audioData: Array.from(audioBuffer) };
      }
      return { success: true, audioData: null };
    } catch (error: Any) {
      logger.error("[Voice] Failed to speak:", error);
      return { success: false, error: error.message, audioData: null };
    }
  });

  // Stop speaking
  ipcMain.handle(IPC_CHANNELS.VOICE_STOP_SPEAKING, async () => {
    try {
      const voiceService = getVoiceService();
      voiceService.stopSpeaking();
      return { success: true };
    } catch (error: Any) {
      logger.error("[Voice] Failed to stop speaking:", error);
      return { success: false, error: error.message };
    }
  });

  // Transcribe audio - accepts audio data as array from renderer
  ipcMain.handle(
    IPC_CHANNELS.VOICE_TRANSCRIBE,
    async (_, audioData: number[]) => {
      try {
        const voiceService = getVoiceService();
        // Convert array back to Buffer
        const audioBuffer = Buffer.from(audioData);
        const text = await voiceService.transcribe(audioBuffer);
        return { text };
      } catch (error: Any) {
        logger.error("[Voice] Failed to transcribe:", error);
        return { text: "", error: error.message };
      }
    },
  );

  // Get ElevenLabs voices
  ipcMain.handle(IPC_CHANNELS.VOICE_GET_ELEVENLABS_VOICES, async () => {
    try {
      const voiceService = getVoiceService();
      return await voiceService.getElevenLabsVoices();
    } catch (error: Any) {
      logger.error("[Voice] Failed to get ElevenLabs voices:", error);
      return [];
    }
  });

  // Test ElevenLabs connection
  ipcMain.handle(IPC_CHANNELS.VOICE_TEST_ELEVENLABS, async () => {
    try {
      const voiceService = getVoiceService();
      return await voiceService.testElevenLabsConnection();
    } catch (error: Any) {
      logger.error("[Voice] Failed to test ElevenLabs:", error);
      return { success: false, error: error.message };
    }
  });

  // Test OpenAI voice connection
  ipcMain.handle(IPC_CHANNELS.VOICE_TEST_OPENAI, async () => {
    try {
      const voiceService = getVoiceService();
      return await voiceService.testOpenAIConnection();
    } catch (error: Any) {
      logger.error("[Voice] Failed to test OpenAI voice:", error);
      return { success: false, error: error.message };
    }
  });

  // Test Azure OpenAI voice connection
  ipcMain.handle(IPC_CHANNELS.VOICE_TEST_AZURE, async () => {
    try {
      const voiceService = getVoiceService();
      return await voiceService.testAzureConnection();
    } catch (error: Any) {
      logger.error("[Voice] Failed to test Azure OpenAI voice:", error);
      return { success: false, error: error.message };
    }
  });

  // Initialize voice service with saved settings
  const savedVoiceSettings = VoiceSettingsManager.loadSettings();
  const voiceService = getVoiceService({ settings: savedVoiceSettings });

  // Forward voice events to renderer
  voiceService.on("stateChange", (state) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.VOICE_EVENT, {
        type: "voice:state-changed",
        data: state,
      });
    }
  });

  voiceService.on("speakingStart", (text) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.VOICE_EVENT, {
        type: "voice:speaking-start",
        data: text,
      });
    }
  });

  voiceService.on("speakingEnd", () => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.VOICE_EVENT, {
        type: "voice:speaking-end",
        data: null,
      });
    }
  });

  voiceService.on("transcript", (text) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.VOICE_EVENT, {
        type: "voice:transcript",
        data: text,
      });
    }
  });

  voiceService.on("error", (error) => {
    const mainWindow = getMainWindow();
    if (mainWindow) {
      mainWindow.webContents.send(IPC_CHANNELS.VOICE_EVENT, {
        type: "voice:error",
        data: { message: error.message },
      });
    }
  });

  // Initialize voice service
  voiceService.initialize().catch((err) => {
    logger.error("[Voice] Failed to initialize:", err);
  });

  logger.debug("[Voice] Handlers initialized");
}

/**
 * Set up Local AI (hf-agents + llama.cpp) IPC handlers
 */
function setupLocalAIHandlers(): void {
  const execFileAsync = promisify(execFile);

  let hfAgentsProcess: import("child_process").ChildProcess | null = null;
  let lastServerError: string | null = null;
  let mlxServerLog: string[] = []; // stdout/stderr captured from mlx_lm.server
  let activeRuntime: "gguf" | "mlx" | null = null;

  // Expand PATH so Electron can find `hf` installed by brew Python
  const hfExtraPath = [
    "/opt/homebrew/bin",
    "/opt/homebrew/lib/python3.11/bin",
    "/opt/homebrew/lib/python3.12/bin",
    "/usr/local/bin",
    `${process.env.HOME}/.local/bin`,
  ].join(":");
  const hfEnv = {
    ...process.env,
    PATH: `${hfExtraPath}:${process.env.PATH || ""}`,
  };

  /**
   * Check if `hf` CLI with agents extension is available
   */
  ipcMain.handle(IPC_CHANNELS.LOCAL_AI_CHECK_HF, async () => {
    // Check hf-agents
    let installed = false;
    let hfInstalled = false;
    let version = "";
    let message = "";
    try {
      const { stdout } = await execFileAsync("hf", ["agents", "--version"], {
        timeout: 8000,
        env: hfEnv,
      });
      installed = true;
      version = (stdout as string).trim();
    } catch (e: Any) {
      const stderr: string = e?.stderr || e?.message || "";
      try {
        const versionResult = (await execFileAsync("hf", ["--version"], {
          timeout: 5000,
          env: hfEnv,
        })) as Any;
        hfInstalled = true;
        // Detect the huggingface_hub downgrade case: old hf CLI has no 'agents' subcommand
        if (stderr.includes("invalid choice") && stderr.includes("agents")) {
          message =
            'huggingface_hub was downgraded (e.g. by mlx-lm). Restore it with: pip install "huggingface_hub>=1.0" --force-reinstall\nThen re-run: hf extensions install hf-agents';
        } else {
          const hfVersion: string = (versionResult.stdout as string).trim();
          message = `hf CLI ${hfVersion} found but hf-agents extension not installed. Run: hf extensions install hf-agents`;
        }
      } catch {
        message =
          "hf CLI not found. Install with: pip install huggingface_hub && hf extensions install hf-agents";
      }
    }

    // Check mlx_lm (macOS/Apple Silicon only)
    // "ok" = importable, "broken" = package found but dylib/import fails, false = not installed
    let mlxInstalled: "ok" | "broken" | false = false;
    let mlxMessage = "";
    if (process.platform === "darwin") {
      try {
        await execFileAsync(
          "python3",
          ["-c", "import mlx_lm; import mlx.core"],
          {
            timeout: 8000,
            env: hfEnv,
          },
        );
        mlxInstalled = "ok";
      } catch (mlxErr: Any) {
        // Import failed — check if package is present at all (without triggering dylib load)
        try {
          const { stdout: spec } = (await execFileAsync(
            "python3",
            [
              "-c",
              "import importlib.util; s=importlib.util.find_spec('mlx_lm'); print('found' if s else 'missing')",
            ],
            { timeout: 5000, env: hfEnv },
          )) as Any;
          if ((spec as string).trim() === "found") {
            mlxInstalled = "broken";
            const raw: string = [mlxErr?.stderr, mlxErr?.message]
              .filter(Boolean)
              .join("\n");
            mlxMessage =
              raw.includes("libmlx.dylib") ||
              raw.includes("Library not loaded") ||
              raw.includes("dlopen")
                ? "MLX dylib missing — run: pip install mlx mlx-metal --force-reinstall --no-cache-dir"
                : "mlx_lm is installed but failed to import. Try reinstalling: pip install mlx-lm --force-reinstall";
          }
        } catch {
          /* python3 not found at all */
        }
      }
    }

    return {
      installed,
      hfInstalled,
      version,
      message,
      mlxInstalled,
      mlxMessage,
      isMac: process.platform === "darwin",
    };
  });

  /**
   * Run `hf agents fit recommend -n 5` (non-interactive) to get model recommendations,
   * then `hf agents fit system` for hardware info.
   */
  ipcMain.handle(IPC_CHANNELS.LOCAL_AI_DETECT_HARDWARE, async () => {
    try {
      // Use non-interactive subcommands — plain `hf agents fit` launches a TUI
      const [recResult, sysResult] = await Promise.allSettled([
        execFileAsync("hf", ["agents", "fit", "recommend"], {
          timeout: 60000,
          env: hfEnv,
        }),
        execFileAsync("hf", ["agents", "fit", "system"], {
          timeout: 15000,
          env: hfEnv,
        }),
      ]);

      const recOut =
        recResult.status === "fulfilled"
          ? (
              (recResult.value.stdout as string) +
              (recResult.value.stderr as string)
            ).trim()
          : recResult.reason?.stderr || recResult.reason?.message || "";
      const sysOut =
        sysResult.status === "fulfilled"
          ? (
              (sysResult.value.stdout as string) +
              (sysResult.value.stderr as string)
            ).trim()
          : "";

      const output = [sysOut, recOut].filter(Boolean).join("\n\n");

      // Parse JSON output from `hf agents fit recommend`.
      // Each entry has gguf_sources: [{ provider, repo }] — empty array means MLX-only.
      // For llama-server we need GGUF: build spec as "gguf_repo:best_quant".
      let models: string[] = [];
      interface ModelDetail {
        spec: string;
        name: string;
        hasGguf: boolean;
        runtime: string;
        params: string;
        tps: number;
        memoryGb: number;
        quant: string;
        fitLevel: string;
      }
      let modelDetails: ModelDetail[] = [];
      let rawEntries: Any[] = [];
      try {
        const parsed = JSON.parse(recOut);
        rawEntries = Array.isArray(parsed) ? parsed : (parsed?.models ?? []);
        for (const e of rawEntries) {
          const ggufSources: Array<{ provider: string; repo: string }> =
            Array.isArray(e.gguf_sources) ? e.gguf_sources : [];
          const ggufSource = ggufSources[0];
          const hasGguf = !!ggufSource;
          // GGUF spec: "unsloth/Model-GGUF:Q4_K_M" — only valid for llama-server
          const spec = hasGguf
            ? `${ggufSource.repo}:${e.best_quant}`
            : e.name || e.repo_id || e.id || null;
          if (!spec) continue;
          if (hasGguf) models.push(spec);
          modelDetails.push({
            spec,
            name: e.name || spec,
            hasGguf,
            runtime: hasGguf ? "GGUF" : e.runtime || "MLX",
            params: e.parameter_count || "",
            tps: e.estimated_tps || 0,
            memoryGb: e.memory_required_gb || 0,
            quant: e.best_quant || "",
            fitLevel: e.fit_level || "",
          });
        }
      } catch {
        // Fall back to numbered list format: "1. unsloth/Model:q4_k_n"
        const modelLines = recOut
          .split("\n")
          .filter((l: string) => /^\s*\d+[.)]\s+\S/.test(l));
        models = modelLines
          .map((l: string) => {
            const match = l.match(/\d+[.)]\s+(\S+)/);
            return match ? match[1] : l.trim();
          })
          .filter(Boolean);
        modelDetails = models.map((spec) => ({
          spec,
          name: spec,
          hasGguf: true,
          runtime: "GGUF",
          params: "",
          tps: 0,
          memoryGb: 0,
          quant: "",
          fitLevel: "",
        }));
      }

      return { ok: true, output, models, modelDetails, rawEntries };
    } catch (err: unknown) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const errStderr = (err as { stderr?: string })?.stderr ?? "";
      return {
        ok: false,
        models: [],
        error: errMsg,
        output: errStderr || errMsg,
      };
    }
  });

  /**
   * Read the last N lines of the llama-server log for error diagnostics
   */
  async function readLlamaLog(lines = 20): Promise<string> {
    try {
      const content: string = await fs.readFile(
        "/tmp/hf-agents-llama-server.log",
        "utf-8",
      );
      const tail = content.trim().split("\n").slice(-lines).join("\n");
      return tail;
    } catch {
      return "";
    }
  }

  /**
   * Start the local AI server — either mlx_lm.server (MLX) or hf agents run pi (GGUF).
   * MLX models are passed as "mlx://<repo_id>", GGUF as plain "repo:quant" strings.
   */
  ipcMain.handle(
    IPC_CHANNELS.LOCAL_AI_START_SERVER,
    async (_, model?: string) => {
      if (hfAgentsProcess && !hfAgentsProcess.killed) {
        return { ok: true, pid: hfAgentsProcess.pid, alreadyRunning: true };
      }
      lastServerError = null;
      mlxServerLog = [];

      const isMLX = model?.startsWith("mlx://");
      const modelId = isMLX ? model!.slice(6) : model;
      activeRuntime = isMLX ? "mlx" : "gguf";

      let cmd: string;
      let args: string[];

      if (isMLX) {
        // Pre-flight: verify mlx_lm actually imports (catches dylib/path issues early)
        try {
          await execFileAsync(
            "python3",
            ["-c", "import mlx_lm; import mlx.core"],
            {
              timeout: 8000,
              env: hfEnv,
            },
          );
        } catch (e: Any) {
          // execFileAsync puts Python stderr in e.stderr; also check e.message
          const raw: string = [e?.stderr, e?.stdout, e?.message]
            .filter(Boolean)
            .join("\n");
          const isLibMissing =
            raw.includes("libmlx.dylib") ||
            raw.includes("Library not loaded") ||
            raw.includes("dlopen");
          const hint = isLibMissing
            ? "MLX dylib not found — reinstall with:\npip install mlx mlx-metal --force-reinstall --no-cache-dir"
            : raw
              ? `mlx_lm failed to import:\n${raw.split("\n").filter(Boolean).slice(-3).join("\n")}`
              : "mlx_lm failed to import. Try: pip install mlx mlx-metal --force-reinstall --no-cache-dir";
          return { ok: false, error: hint };
        }
        // MLX: python3 -m mlx_lm.server --model <repo_id> --port 8080
        cmd = "python3";
        args = ["-m", "mlx_lm.server", "--model", modelId!, "--port", "8080"];
      } else {
        // GGUF: hf agents run pi [--model <spec>]
        cmd = "hf";
        args = ["agents", "run", "pi"];
        if (modelId && modelId !== "auto") args.push("--model", modelId);
      }

      return await new Promise((resolve) => {
        let stderrOutput = "";
        let settled = false;

        const getEarlyExitMsg = () =>
          isMLX
            ? mlxServerLog.slice(-5).join("\n") ||
              "mlx_lm.server exited immediately."
            : stderrOutput || "Server process exited immediately.";

        const proc = spawnProcess(cmd, args, {
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
          env: hfEnv,
        });

        const appendMLXLog = (chunk: Buffer) => {
          const lines = chunk
            .toString()
            .split("\n")
            .filter((l: string) => l.trim());
          mlxServerLog.push(...lines);
          if (mlxServerLog.length > 200)
            mlxServerLog = mlxServerLog.slice(-200);
        };

        if (isMLX) {
          proc.stdout?.on("data", appendMLXLog);
          proc.stderr?.on("data", appendMLXLog);
        } else {
          proc.stderr?.on("data", (chunk: Buffer) => {
            stderrOutput += chunk.toString();
          });
        }

        proc.on("error", (err: NodeJS.ErrnoException) => {
          const cmdName = isMLX ? "python3 -m mlx_lm.server" : "hf";
          const spawnError =
            err.code === "ENOENT"
              ? `'${cmdName}' not found. ${isMLX ? "Install with: pip install mlx-lm" : "Make sure huggingface_hub is installed and 'hf' is in your PATH."}`
              : err.message;
          lastServerError = spawnError;
          hfAgentsProcess = null;
          if (!settled) {
            settled = true;
            clearInterval(pollId);
            resolve({ ok: false, error: spawnError });
          }
        });

        proc.on("exit", async (code: number | null) => {
          if (hfAgentsProcess === proc) hfAgentsProcess = null;
          if (code !== 0 && code !== null) {
            if (isMLX) {
              const detail =
                mlxServerLog.slice(-20).join("\n") ||
                `mlx_lm.server exited with code ${code}`;
              lastServerError = detail;
            } else {
              const logTail = await readLlamaLog(20);
              lastServerError = logTail
                ? `llama-server exited unexpectedly. Last 20 lines of log:\n${logTail}`
                : stderrOutput || `hf agents exited with code ${code}`;
            }
            logger.warn(`[LocalAI] ${cmd} exited with code ${code}.`);
            if (!settled) {
              settled = true;
              clearInterval(pollId);
              resolve({
                ok: false,
                error: lastServerError ?? getEarlyExitMsg(),
              });
            }
          }
        });

        hfAgentsProcess = proc;

        // Poll /v1/models every 2s for up to 30s. Resolve as soon as the server
        // responds 200; fall through to "downloading" state when the poll times out
        // (the model may still be loading — status continues to update via getServerStatus).
        let attempts = 0;
        const MAX_POLL_ATTEMPTS = 15; // 15 × 2s = 30s
        const pollId = setInterval(async () => {
          if (settled) {
            clearInterval(pollId);
            return;
          }
          if (!hfAgentsProcess || hfAgentsProcess.killed) {
            if (!settled) {
              settled = true;
              clearInterval(pollId);
              resolve({ ok: false, error: getEarlyExitMsg() });
            }
            return;
          }
          attempts++;
          try {
            const res = await fetch("http://localhost:8080/v1/models", {
              signal: AbortSignal.timeout(1500),
            });
            if (res.ok) {
              settled = true;
              clearInterval(pollId);
              resolve({
                ok: true,
                pid: hfAgentsProcess?.pid,
                runtime: activeRuntime,
                serverReady: true,
              });
              return;
            }
          } catch {
            // Server not up yet — keep polling
          }
          if (attempts >= MAX_POLL_ATTEMPTS) {
            // Process still alive but server hasn't responded yet — model likely downloading
            settled = true;
            clearInterval(pollId);
            resolve({
              ok: true,
              pid: hfAgentsProcess?.pid,
              runtime: activeRuntime,
              downloading: true,
            });
          }
        }, 2000);
      });
    },
  );

  /**
   * Stop the running hf-agents server process
   */
  ipcMain.handle(IPC_CHANNELS.LOCAL_AI_STOP_SERVER, async () => {
    if (!hfAgentsProcess || hfAgentsProcess.killed) {
      hfAgentsProcess = null;
      return { ok: true, wasRunning: false };
    }
    try {
      hfAgentsProcess.kill("SIGTERM");
      hfAgentsProcess = null;
      return { ok: true, wasRunning: true };
    } catch (err: unknown) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  });

  /**
   * Get current server status: probes :8080/v1/models + checks process alive
   */
  ipcMain.handle(IPC_CHANNELS.LOCAL_AI_GET_SERVER_STATUS, async () => {
    const processAlive = !!(hfAgentsProcess && !hfAgentsProcess.killed);
    try {
      const res = await fetch("http://localhost:8080/v1/models", {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        const data = (await res.json().catch(() => null)) as Any;
        const models = data?.data?.map((m: Any) => m.id) || [];
        lastServerError = null; // clear error on successful connect
        return {
          serverRunning: true,
          processAlive,
          pid: hfAgentsProcess?.pid,
          models,
        };
      }
      return {
        serverRunning: false,
        processAlive,
        pid: hfAgentsProcess?.pid,
        lastError: lastServerError,
      };
    } catch {
      return {
        serverRunning: false,
        processAlive,
        pid: hfAgentsProcess?.pid,
        lastError: lastServerError,
      };
    }
  });

  /**
   * Read the server log and classify current state for live progress UI.
   * MLX: reads from in-memory mlxServerLog buffer.
   * GGUF: reads /tmp/hf-agents-llama-server.log.
   */
  ipcMain.handle(IPC_CHANNELS.LOCAL_AI_GET_SERVER_LOG, async () => {
    if (activeRuntime === "mlx") {
      const lines = mlxServerLog.slice(-30);
      const joined = lines.join("\n");
      let state: "idle" | "downloading" | "loading" | "ready" | "error" =
        "idle";
      let downloadingFile: string | undefined;

      if (
        joined.includes("Application startup complete") ||
        joined.includes("Uvicorn running on") ||
        joined.includes("running on http")
      ) {
        state = "ready";
      } else if (
        joined.includes("Fetching") ||
        joined.includes("Downloading") ||
        joined.includes("fetch")
      ) {
        state = "downloading";
        const dlMatch = joined.match(/Fetching\s+\d+\s+files?/);
        downloadingFile = dlMatch ? dlMatch[0] : undefined;
      } else if (joined.match(/error|failed|Error|Failed/)) {
        state = "error";
      } else if (lines.length > 0) {
        state = "loading";
      }
      return { lines, state, downloadingFile, runtime: "mlx" };
    }

    // GGUF: read llama-server log file
    try {
      const content: string = await fs.readFile(
        "/tmp/hf-agents-llama-server.log",
        "utf-8",
      );
      const allLines = content.split("\n");
      const lines = allLines.slice(-30).filter((l: string) => l.trim());
      const joined = lines.join("\n");
      let state: "idle" | "downloading" | "loading" | "ready" | "error" =
        "idle";
      let downloadingFile: string | undefined;

      if (
        joined.includes("HTTP server listening") ||
        joined.includes("server is listening")
      ) {
        state = "ready";
      } else if (
        joined.includes("llm_load_tensors") ||
        joined.includes("llm_load_print_meta") ||
        joined.includes("loading model")
      ) {
        state = "loading";
      } else if (
        joined.includes("downloadInProgress") ||
        joined.includes("downloading from")
      ) {
        state = "downloading";
        const dlLines = allLines.filter((l: string) =>
          l.includes("downloading from"),
        );
        if (dlLines.length > 0) {
          const last = dlLines[dlLines.length - 1];
          const match = last.match(/resolve\/main\/([^\s]+?\.gguf)/);
          downloadingFile = match ? match[1] : undefined;
        }
      } else if (joined.match(/\b(error|failed|CUDA error)/i)) {
        state = "error";
      } else if (lines.length > 0) {
        state = "loading";
      }
      return { lines, state, downloadingFile, runtime: "gguf" };
    } catch {
      return {
        lines: [] as string[],
        state: "idle" as const,
        runtime: activeRuntime ?? "gguf",
      };
    }
  });

  logger.debug("[LocalAI] Handlers initialized");
}
