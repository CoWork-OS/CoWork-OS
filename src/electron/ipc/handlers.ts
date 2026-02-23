import { ipcMain, shell, BrowserWindow, app } from "electron";
import * as path from "path";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { execFile } from "child_process";
import { promisify } from "util";
import mammoth from "mammoth";
import mime from "mime-types";
import { getUserDataDir } from "../utils/user-data-dir";
import { resolveImageOcrChars, runOcrFromImagePath, shouldRunImageOcr } from "./image-viewer-ocr";
import { extractPptxContentFromFile } from "../utils/pptx-extractor";
import { parsePdfBuffer } from "../utils/pdf-parser";
import ExcelJS from "exceljs";

import { DatabaseManager } from "../database/schema";
import {
  WorkspaceRepository,
  TaskRepository,
  TaskEventRepository,
  ArtifactRepository,
  SkillRepository,
  LLMModelRepository,
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
import { selectAgentsForTask } from "../agents/capabilityMatcher";
import { TaskLabelRepository } from "../database/TaskLabelRepository";
import { WorkingStateRepository } from "../agents/WorkingStateRepository";
import { ContextPolicyManager } from "../gateway/context-policy";
import {
  IPC_CHANNELS,
  LLMSettingsData,
  AddChannelRequest,
  UpdateChannelRequest,
  SecurityMode,
  UpdateInfo,
  TEMP_WORKSPACE_ID_PREFIX,
  TEMP_WORKSPACE_NAME,
  TEMP_WORKSPACE_ROOT_DIR_NAME,
  Workspace,
  AgentRole,
  Task,
  BoardColumn,
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
} from "../../shared/types";
import * as os from "os";
import { AgentDaemon } from "../agent/daemon";
import { LLMProviderFactory, LLMProviderConfig, ModelKey, OpenAIOAuth } from "../agent/llm";
import { SearchProviderFactory, SearchSettings, SearchProviderType } from "../agent/search";
import { ChannelGateway } from "../gateway";
import { updateManager } from "../updater";
import { rateLimiter, RATE_LIMIT_CONFIGS } from "../utils/rate-limiter";
import { toPublicChannel } from "./channel-config-sanitizer";
import { buildTaskExportJson } from "../reports/task-export";
import {
  validateInput,
  WorkspaceCreateSchema,
  TaskCreateSchema,
  TaskRenameSchema,
  TaskMessageSchema,
  FileImportSchema,
  FileImportDataSchema,
  ApprovalResponseSchema,
  LLMSettingsSchema,
  SearchSettingsSchema,
  XSettingsSchema,
  NotionSettingsSchema,
  BoxSettingsSchema,
  OneDriveSettingsSchema,
  GoogleWorkspaceSettingsSchema,
  DropboxSettingsSchema,
  SharePointSettingsSchema,
  AddChannelSchema,
  UpdateChannelSchema,
  GrantAccessSchema,
  RevokeAccessSchema,
  GeneratePairingSchema,
  GuardrailSettingsSchema,
  ConwaySettingsSchema,
  EmailChannelConfigSchema,
  UUIDSchema,
  StringIdSchema,
  MCPConnectorOAuthSchema,
  ChatGPTImportSchema,
  FindImportedSchema,
} from "../utils/validation";
import { GuardrailManager } from "../guardrails/guardrail-manager";
import { AppearanceManager } from "../settings/appearance-manager";
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
import { startGoogleWorkspaceOAuth } from "../utils/google-workspace-oauth";

import { XSettingsManager } from "../settings/x-manager";
import { testXConnection, checkBirdInstalled } from "../utils/x-cli";
import { getCustomSkillLoader } from "../agent/custom-skill-loader";
import { CustomSkill } from "../../shared/types";
import { MCPSettingsManager } from "../mcp/settings";
import { MCPClientManager } from "../mcp/client/MCPClientManager";
import { MCPRegistryManager } from "../mcp/registry/MCPRegistryManager";
import { getChannelRegistry } from "../gateway/channel-registry";
import type { MCPSettings, MCPServerConfig } from "../mcp/types";
import { MCPHostServer } from "../mcp/host/MCPHostServer";
import { BuiltinToolsSettingsManager } from "../agent/tools/builtin-settings";
import {
  MCPServerConfigSchema,
  MCPServerUpdateSchema,
  MCPSettingsSchema,
  MCPRegistrySearchSchema,
  HookMappingSchema,
} from "../utils/validation";
import { NotificationService } from "../notifications";
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
import { MemoryService } from "../memory/MemoryService";
import { UserProfileService } from "../memory/UserProfileService";
import { ConwayManager } from "../conway/conway-manager";
import { ConwaySettingsManager } from "../conway/conway-settings";
import { ConwayWalletManager } from "../conway/conway-wallet";
import { RelationshipMemoryService } from "../memory/RelationshipMemoryService";
import type { MemorySettings } from "../database/repositories";
import { VoiceSettingsManager } from "../voice/voice-settings-manager";
import { getVoiceService } from "../voice/VoiceService";
import { AgentPerformanceReviewService } from "../reports/AgentPerformanceReviewService";
import { getCronService } from "../cron";
import type { CronJobCreate } from "../cron/types";
import { pruneTempWorkspaces } from "../utils/temp-workspace";

type FileViewerRequestOptions = {
  workspacePath?: string;
  enableImageOcr?: boolean;
  imageOcrMaxChars?: number;
  includeImageContent?: boolean;
};
type MacSystemSettingsTarget = "microphone" | "dictation";

const execFileAsync = promisify(execFile);

const isMacSystemSettingsTarget = (value: unknown): value is MacSystemSettingsTarget =>
  value === "microphone" || value === "dictation";

const openMacSystemSettings = async (target: MacSystemSettingsTarget): Promise<void> => {
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

export function setHeartbeatWakeSubmitter(submitter: HooksWakeSubmitter | null): void {
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
        console.error("[Hooks] Failed to flush buffered wake action:", error);
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
  config: { maxRequests: number; windowMs: number } = RATE_LIMIT_CONFIGS.standard,
): void {
  if (!rateLimiter.check(channel)) {
    const resetMs = rateLimiter.getResetTime(channel);
    const resetSec = Math.ceil(resetMs / 1000);
    throw new Error(`Rate limit exceeded. Try again in ${resetSec} seconds.`);
  }
}

// Configure rate limits for sensitive channels
rateLimiter.configure(IPC_CHANNELS.TASK_CREATE, RATE_LIMIT_CONFIGS.expensive);
rateLimiter.configure(IPC_CHANNELS.TASK_SEND_MESSAGE, RATE_LIMIT_CONFIGS.expensive);
rateLimiter.configure(IPC_CHANNELS.TASK_WRAP_UP, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TASK_PIN, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TASK_EXPORT_JSON, RATE_LIMIT_CONFIGS.standard);
rateLimiter.configure(IPC_CHANNELS.LLM_SAVE_SETTINGS, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.LLM_TEST_PROVIDER, RATE_LIMIT_CONFIGS.expensive);
rateLimiter.configure(IPC_CHANNELS.LLM_GET_OLLAMA_MODELS, RATE_LIMIT_CONFIGS.standard);
rateLimiter.configure(IPC_CHANNELS.LLM_GET_GEMINI_MODELS, RATE_LIMIT_CONFIGS.standard);
rateLimiter.configure(IPC_CHANNELS.LLM_GET_OPENROUTER_MODELS, RATE_LIMIT_CONFIGS.standard);
rateLimiter.configure(IPC_CHANNELS.LLM_GET_BEDROCK_MODELS, RATE_LIMIT_CONFIGS.standard);
rateLimiter.configure(IPC_CHANNELS.LLM_GET_GROQ_MODELS, RATE_LIMIT_CONFIGS.standard);
rateLimiter.configure(IPC_CHANNELS.LLM_GET_XAI_MODELS, RATE_LIMIT_CONFIGS.standard);
rateLimiter.configure(IPC_CHANNELS.LLM_GET_KIMI_MODELS, RATE_LIMIT_CONFIGS.standard);
rateLimiter.configure(IPC_CHANNELS.LLM_GET_PI_MODELS, RATE_LIMIT_CONFIGS.standard);
rateLimiter.configure(IPC_CHANNELS.LLM_GET_PI_PROVIDERS, RATE_LIMIT_CONFIGS.standard);
rateLimiter.configure(IPC_CHANNELS.SEARCH_SAVE_SETTINGS, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.SEARCH_TEST_PROVIDER, RATE_LIMIT_CONFIGS.expensive);
rateLimiter.configure(IPC_CHANNELS.GATEWAY_ADD_CHANNEL, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.GATEWAY_TEST_CHANNEL, RATE_LIMIT_CONFIGS.expensive);
rateLimiter.configure(IPC_CHANNELS.GUARDRAIL_SAVE_SETTINGS, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_CREATE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_UPDATE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_DELETE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_MEMBER_ADD, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_MEMBER_UPDATE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_MEMBER_REMOVE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_MEMBER_REORDER, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_RUN_CREATE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_RUN_RESUME, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_RUN_PAUSE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_RUN_CANCEL, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_RUN_WRAP_UP, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_ITEM_CREATE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_ITEM_UPDATE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_ITEM_DELETE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.TEAM_ITEM_MOVE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.REVIEW_GENERATE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.REVIEW_DELETE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.KIT_INIT, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.KIT_PROJECT_CREATE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.MEMORY_ADD_USER_FACT, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.MEMORY_UPDATE_USER_FACT, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.MEMORY_DELETE_USER_FACT, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.MEMORY_RELATIONSHIP_UPDATE, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.MEMORY_RELATIONSHIP_DELETE, RATE_LIMIT_CONFIGS.limited);

// Helper function to get the main window
function getMainWindow(): BrowserWindow | null {
  const windows = BrowserWindow.getAllWindows();
  return windows.length > 0 ? windows[0] : null;
}

export async function setupIpcHandlers(
  dbManager: DatabaseManager,
  agentDaemon: AgentDaemon,
  gateway?: ChannelGateway,
) {
  const db = dbManager.getDatabase();
  const workspaceRepo = new WorkspaceRepository(db);
  const taskRepo = new TaskRepository(db);
  const taskEventRepo = new TaskEventRepository(db);
  const artifactRepo = new ArtifactRepository(db);
  const skillRepo = new SkillRepository(db);
  const llmModelRepo = new LLMModelRepository(db);
  const agentRoleRepo = new AgentRoleRepository(db);
  const activityRepo = new ActivityRepository(db);
  const mentionRepo = new MentionRepository(db);
  const teamRepo = new AgentTeamRepository(db);
  const teamMemberRepo = new AgentTeamMemberRepository(db);
  const teamRunRepo = new AgentTeamRunRepository(db);
  const teamItemRepo = new AgentTeamItemRepository(db);
  const teamThoughtRepo = new AgentTeamThoughtRepository(db);
  const reviewService = new AgentPerformanceReviewService(db);
  const taskLabelRepo = new TaskLabelRepository(db);
  const workingStateRepo = new WorkingStateRepository(db);
  const contextPolicyManager = new ContextPolicyManager(db);
  const emitTaskStatusEvent = (
    taskId: string,
    status: Task["status"],
    extraPayload?: Record<string, unknown>,
  ): void => {
    getMainWindow()?.webContents.send(IPC_CHANNELS.TASK_EVENT, {
      taskId,
      type: "task_status",
      timestamp: Date.now(),
      payload: { status, ...(extraPayload || {}) },
    });
  };

  const teamOrchestrator = new AgentTeamOrchestrator({
    getDatabase: () => db,
    getTaskById: (taskId: string) => agentDaemon.getTaskById(taskId),
    createChildTask: (params) => agentDaemon.createChildTask(params as any),
    cancelTask: (taskId: string) => agentDaemon.cancelTask(taskId),
    wrapUpTask: (taskId: string) => agentDaemon.wrapUpTask(taskId),
    completeRootTask: (taskId, status, summary) => {
      taskRepo.update(taskId, { status, resultSummary: summary, completedAt: Date.now() });
      emitTaskStatusEvent(taskId, status, { resultSummary: summary });
    },
  });
  agentDaemon.setTeamOrchestrator(teamOrchestrator);

  // Seed default agent roles if none exist
  agentRoleRepo.seedDefaults();

  // Helper to validate path is within workspace (prevent path traversal attacks)
  const isPathWithinWorkspace = (filePath: string, workspacePath: string): boolean => {
    const normalizedWorkspace = path.resolve(workspacePath);
    const normalizedFile = path.resolve(normalizedWorkspace, filePath);
    const relative = path.relative(normalizedWorkspace, normalizedFile);
    // If relative path starts with '..' or is absolute, it's outside workspace
    return !relative.startsWith("..") && !path.isAbsolute(relative);
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

  const tempWorkspaceRoot = path.join(os.tmpdir(), TEMP_WORKSPACE_ROOT_DIR_NAME);

  const normalizeTempPermissions = (existing?: Workspace): Workspace["permissions"] => ({
    ...(existing?.permissions ?? {}),
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
    `session-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

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
        .find((workspace) => isTempWorkspaceId(workspace.id));
      if (existingTemp) {
        workspace = await ensureTempWorkspace(existingTemp.id, existingTemp.path, existingTemp);
      } else {
        await fs.mkdir(tempWorkspaceRoot, { recursive: true });
        const key = buildTempWorkspaceKey();
        const workspaceId = `${TEMP_WORKSPACE_ID_PREFIX}${key}`;
        const workspacePath = path.join(tempWorkspaceRoot, key);
        workspace = await ensureTempWorkspace(workspaceId, workspacePath);
      }
    } else {
      await fs.mkdir(tempWorkspaceRoot, { recursive: true });
      const key = buildTempWorkspaceKey();
      const workspaceId = `${TEMP_WORKSPACE_ID_PREFIX}${key}`;
      const workspacePath = path.join(tempWorkspaceRoot, key);
      workspace = await ensureTempWorkspace(workspaceId, workspacePath);
    }

    try {
      pruneTempWorkspaces({
        db,
        tempWorkspaceRoot,
        currentWorkspaceId: workspace.id,
      });
    } catch (error) {
      console.warn("Failed to prune temp workspaces:", error);
    }

    return workspace;
  };

  // File handlers - open files and show in Finder
  ipcMain.handle("file:open", async (_, filePath: string, workspacePath?: string) => {
    // Security: require workspacePath and validate path is within it
    if (!workspacePath) {
      throw new Error("Workspace path is required for file operations");
    }

    // Resolve the path relative to workspace
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workspacePath, filePath);

    // Validate path is within workspace (prevent path traversal)
    if (!isPathWithinWorkspace(resolvedPath, workspacePath)) {
      throw new Error("Access denied: file path is outside the workspace");
    }

    return shell.openPath(resolvedPath);
  });

  ipcMain.handle("file:showInFinder", async (_, filePath: string, workspacePath?: string) => {
    // Security: require workspacePath and validate path is within it
    if (!workspacePath) {
      throw new Error("Workspace path is required for file operations");
    }

    // Resolve the path relative to workspace
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workspacePath, filePath);

    // Validate path is within workspace (prevent path traversal)
    if (!isPathWithinWorkspace(resolvedPath, workspacePath)) {
      throw new Error("Access denied: file path is outside the workspace");
    }

    shell.showItemInFolder(resolvedPath);
  });

  // Open external URL in system browser
  ipcMain.handle("shell:openExternal", async (_, url: string) => {
    // Validate URL to prevent security issues
    try {
      const parsedUrl = new URL(url);
      if (!["http:", "https:"].includes(parsedUrl.protocol)) {
        throw new Error("Only http and https URLs are allowed");
      }
      await shell.openExternal(url);
    } catch (error: any) {
      throw new Error(`Failed to open URL: ${error.message}`);
    }
  });

  // Open macOS System Settings panes (with AppleScript fallback for reliability)
  ipcMain.handle(IPC_CHANNELS.SYSTEM_OPEN_SETTINGS, async (_, target: unknown) => {
    if (process.platform !== "darwin") {
      return { success: false, error: "System settings shortcuts are only available on macOS." };
    }

    if (!isMacSystemSettingsTarget(target)) {
      return { success: false, error: "Unknown settings target." };
    }

    try {
      await openMacSystemSettings(target);
      return { success: true };
    } catch (error: any) {
      return { success: false, error: error?.message || "Failed to open System Settings." };
    }
  });

  // File viewer handler - read file content for in-app preview
  // Note: This handler allows viewing any file on the system for convenience.
  // File operations like open/showInFinder remain workspace-restricted.
  ipcMain.handle(
    "file:readForViewer",
    async (_, data: { filePath: string } & FileViewerRequestOptions) => {
      const {
        filePath,
        workspacePath,
        enableImageOcr,
        imageOcrMaxChars,
        includeImageContent = true,
      } = data;

      // Resolve the path - if absolute use directly, otherwise resolve relative to workspace or cwd
      const resolvedPath = path.isAbsolute(filePath)
        ? filePath
        : workspacePath
          ? path.resolve(workspacePath, filePath)
          : path.resolve(filePath);

      // Check if file exists
      try {
        await fs.access(resolvedPath);
      } catch {
        return { success: false, error: "File not found" };
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
        | "pdf"
        | "image"
        | "pptx"
        | "xlsx"
        | "html"
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
          ".json",
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
          ".csv",
          ".env",
          ".gitignore",
          ".dockerignore",
          ".editorconfig",
          ".prettierrc",
          ".eslintrc",
        ];
        const imageExtensions = [".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".bmp", ".ico"];

        if (ext === ".md" || ext === ".markdown") return "markdown";
        if (ext === ".html" || ext === ".htm") return "html";
        if (ext === ".docx") return "docx";
        if (ext === ".pdf") return "pdf";
        if (ext === ".pptx") return "pptx";
        if (ext === ".xlsx" || ext === ".xls") return "xlsx";
        if (imageExtensions.includes(ext)) return "image";
        if (codeExtensions.includes(ext)) return "code";
        if (textExtensions.includes(ext)) return "text";

        return "unsupported";
      };

      const fileType = getFileType(extension);
      const shouldAttemptImageOcr = shouldRunImageOcr({
        enableImageOcr,
        extension,
        fileSizeBytes: stats.size,
      });

      // Size limits
      const MAX_TEXT_SIZE = 5 * 1024 * 1024; // 5MB
      const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB
      const MAX_PPTX_VIEWER_SIZE = 50 * 1024 * 1024; // 50MB before hard-stop
      const MAX_XLSX_SIZE = 20 * 1024 * 1024; // 20MB for spreadsheets

      if (fileType === "image" && stats.size > MAX_IMAGE_SIZE) {
        return { success: false, error: "File too large for preview (max 10MB for images)" };
      }
      if (fileType === "pptx" && stats.size > MAX_PPTX_VIEWER_SIZE) {
        return { success: false, error: "PPTX file too large for preview (max 50MB)" };
      }
      if (fileType === "xlsx" && stats.size > MAX_XLSX_SIZE) {
        return { success: false, error: "Spreadsheet too large for extraction (max 20MB)" };
      }
      if (
        fileType !== "image" &&
        fileType !== "unsupported" &&
        fileType !== "pptx" &&
        fileType !== "xlsx" &&
        stats.size > MAX_TEXT_SIZE
      ) {
        return { success: false, error: "File too large for preview (max 5MB for text files)" };
      }

      try {
        let content: string | null = null;
        let htmlContent: string | undefined;
        let ocrText: string | undefined;

        switch (fileType) {
          case "markdown":
          case "code":
          case "text": {
            content = await fs.readFile(resolvedPath, "utf-8");
            break;
          }

          case "docx": {
            const buffer = await fs.readFile(resolvedPath);
            const result = await mammoth.convertToHtml({ buffer });
            htmlContent = result.value;
            content = null; // HTML content is in htmlContent
            break;
          }

          case "pdf": {
            const buffer = await fs.readFile(resolvedPath);
            const pdfData = await parsePdfBuffer(buffer);
            content = pdfData.text;
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
              ocrText = (await runOcrFromImagePath(resolvedPath, requestOcrChars)) ?? undefined;
            }
            break;
          }

          case "html": {
            htmlContent = await fs.readFile(resolvedPath, "utf-8");
            content = null; // HTML content is in htmlContent
            break;
          }

          case "pptx":
            content = await extractPptxContentFromFile(resolvedPath);
            break;

          case "xlsx": {
            const workbook = new ExcelJS.Workbook();
            await workbook.xlsx.readFile(resolvedPath);
            const sheetTexts: string[] = [];
            workbook.eachSheet((worksheet) => {
              const rows: string[] = [];
              rows.push(`## Sheet: ${worksheet.name}`);
              worksheet.eachRow((row, _rowNumber) => {
                const cells: string[] = [];
                row.eachCell({ includeEmpty: true }, (cell) => {
                  const val = cell.value;
                  if (val === null || val === undefined) {
                    cells.push("");
                  } else if (typeof val === "object" && "result" in val) {
                    // Formula cell — use computed result
                    cells.push(String((val as any).result ?? ""));
                  } else if (typeof val === "object" && "richText" in val) {
                    // Rich text — concatenate text fragments
                    cells.push((val as any).richText?.map((rt: any) => rt.text).join("") ?? "");
                  } else if (val instanceof Date) {
                    cells.push(val.toISOString());
                  } else {
                    cells.push(String(val));
                  }
                });
                rows.push(cells.join("\t"));
              });
              sheetTexts.push(rows.join("\n"));
            });
            content = sheetTexts.join("\n\n");
            break;
          }

          default:
            return { success: false, error: "Unsupported file type", fileType: "unsupported" };
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
          },
        };
      } catch (error: any) {
        return { success: false, error: `Failed to read file: ${error.message}` };
      }
    },
  );

  // File import handler - copy selected files into the workspace for attachment use
  ipcMain.handle(
    "file:importToWorkspace",
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
        const sanitized = fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
        return sanitized.length > 0 ? sanitized : "file";
      };

      const ensureUniqueName = (dir: string, baseName: string, usedNames: Set<string>): string => {
        const ext = path.extname(baseName);
        const stem = path.basename(baseName, ext);
        let candidate = baseName;
        let counter = 1;
        while (usedNames.has(candidate) || fsSync.existsSync(path.join(dir, candidate))) {
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
        uploadRoot = path.join(workspace.path, ".cowork", "uploads", `${Date.now()}`);
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
        const absolutePath = path.isAbsolute(filePath) ? filePath : path.resolve(filePath);
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

        const mimeType = (mime.lookup(absolutePath) || undefined) as string | undefined;

        if (isPathWithinWorkspace(absolutePath, workspace.path)) {
          results.push({
            relativePath: path.relative(workspace.path, absolutePath),
            fileName: path.basename(absolutePath),
            size: stats.size,
            mimeType,
          });
          continue;
        }

        const safeName = sanitizeFileName(path.basename(absolutePath));
        const targetRoot = await ensureUploadRoot();
        const uniqueName = ensureUniqueName(targetRoot, safeName, usedNames);
        const destination = path.join(targetRoot, uniqueName);

        await fs.copyFile(absolutePath, destination);

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
    "file:importDataToWorkspace",
    async (
      _,
      data: {
        workspaceId: string;
        files: Array<{ name: string; data: string; mimeType?: string }>;
      },
    ) => {
      const validated = validateInput(FileImportDataSchema, data, "file import data");
      const workspace = workspaceRepo.findById(validated.workspaceId);

      if (!workspace) {
        throw new Error(`Workspace not found: ${validated.workspaceId}`);
      }

      if (!workspace.permissions.write) {
        throw new Error("Write permission not granted for workspace");
      }

      const sanitizeFileName = (fileName: string): string => {
        const sanitized = fileName.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_").trim();
        return sanitized.length > 0 ? sanitized : "file";
      };

      const ensureExtension = (fileName: string, mimeType?: string): string => {
        if (path.extname(fileName) || !mimeType) return fileName;
        const ext = mime.extension(mimeType);
        return ext ? `${fileName}.${ext}` : fileName;
      };

      const ensureUniqueName = (dir: string, baseName: string, usedNames: Set<string>): string => {
        const ext = path.extname(baseName);
        const stem = path.basename(baseName, ext);
        let candidate = baseName;
        let counter = 1;
        while (usedNames.has(candidate) || fsSync.existsSync(path.join(dir, candidate))) {
          candidate = `${stem}-${counter}${ext}`;
          counter += 1;
        }
        usedNames.add(candidate);
        return candidate;
      };

      const uploadRoot = path.join(workspace.path, ".cowork", "uploads", `${Date.now()}`);
      await fs.mkdir(uploadRoot, { recursive: true });
      const usedNames = new Set<string>();

      const results: Array<{
        relativePath: string;
        fileName: string;
        size: number;
        mimeType?: string;
      }> = [];

      for (const file of validated.files) {
        const rawName = ensureExtension(sanitizeFileName(file.name), file.mimeType);
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
    const defaultPermissions = {
      read: true,
      write: true,
      delete: false,
      network: true,
      shell: false,
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
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_GET_TEMP, async (_, options?: { createNew?: boolean }) => {
    return getOrCreateTempWorkspace(options);
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SELECT, async (_, id: string) => {
    const workspace = workspaceRepo.findById(id);
    if (workspace && !workspace.isTemp && !isTempWorkspaceId(workspace.id)) {
      try {
        workspaceRepo.updateLastUsedAt(workspace.id);
      } catch (error) {
        console.warn("Failed to update workspace last used time:", error);
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
      return workspaceRepo.findById(id);
    },
  );

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_TOUCH, async (_, id: string) => {
    const workspace = workspaceRepo.findById(id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${id}`);
    }
    workspaceRepo.updateLastUsedAt(id);
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
    const normalizedAgentConfig: AgentConfig | undefined = agentConfig
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
        console.warn("Failed to update workspace last used time:", error);
      }
    }

    // Capture mentioned agent roles for deferred dispatch (after main plan is created)
    try {
      const activeRoles = agentRoleRepo.findAll(false).filter((role) => role.isActive);
      const mentionedRoles = extractMentionedRoles(`${title}\n${prompt}`, activeRoles);
      const mentionedAgentRoleIds = mentionedRoles.map((role) => role.id);
      if (mentionedAgentRoleIds.length > 0) {
        taskRepo.update(task.id, { mentionedAgentRoleIds });
      }
    } catch (error: unknown) {
      const errorMessage = error instanceof Error ? error.message : "Unknown error";
      console.error("Failed to record mentioned agents:", error);
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
          const { members, leader } = await selectAgentsForTask(`${title}\n${prompt}`, activeRoles);

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

          // One item per agent — each gets the full prompt (Grok model)
          for (let i = 0; i < members.length; i++) {
            const m = members[i];
            teamItemRepo.create({
              teamRunId: run.id,
              title: `${m.icon} ${m.displayName}`,
              description: prompt,
              ownerAgentRoleId: m.id,
              status: "todo",
              sortOrder: (i + 1) * 10,
            });
          }

          // Emit for UI — this triggers the collaborative thoughts panel to appear
          emitTeamEvent({ type: "team_run_created", timestamp: Date.now(), run });

          // Kick off the orchestrator (spawns child tasks for each item)
          void teamOrchestrator.tickRun(run.id, "auto_collaborative");
        } catch (error: any) {
          console.error("[TASK_CREATE] Auto-collaborative setup failed:", error);
          // Fall back to normal execution
          try {
            await agentDaemon.startTask(task, validatedImages);
          } catch (startError: any) {
            taskRepo.update(task.id, {
              status: "failed",
              error: startError.message || "Failed to start task",
            });
            emitTaskStatusEvent(task.id, "failed");
          }
        }
      })();

      return task;
    }

    // Multi-LLM mode: send same task to multiple LLM providers in parallel
    if (normalizedAgentConfig?.multiLlmMode && normalizedAgentConfig?.multiLlmConfig) {
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
          const sentinelRoleId = allRoles.length > 0 ? allRoles[0].id : "multi-llm-system";

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
          emitTeamEvent({ type: "team_run_created", timestamp: Date.now(), run });

          // Kick off orchestrator
          void teamOrchestrator.tickRun(run.id, "multi_llm_start");
        } catch (error: any) {
          console.error("[TASK_CREATE] Multi-LLM setup failed:", error);
          try {
            await agentDaemon.startTask(task, validatedImages);
          } catch (startError: any) {
            taskRepo.update(task.id, {
              status: "failed",
              error: startError.message || "Failed to start task",
            });
            emitTaskStatusEvent(task.id, "failed");
          }
        }
      })();

      return task;
    }

    // Start task execution in agent daemon
    try {
      await agentDaemon.startTask(task, validatedImages);
    } catch (error: any) {
      // Update task status to failed if we can't start it
      taskRepo.update(task.id, {
        status: "failed",
        error: error.message || "Failed to start task",
      });
      throw new Error(
        error.message || "Failed to start task. Please check your LLM provider settings.",
      );
    }

    return task;
  });

  ipcMain.handle(IPC_CHANNELS.TASK_GET, async (_, id: string) => {
    return taskRepo.findById(id);
  });

  ipcMain.handle(IPC_CHANNELS.TASK_LIST, async () => {
    return taskRepo.findAll();
  });

  // Export task summaries as a structured JSON blob (prompt-free by design)
  ipcMain.handle(IPC_CHANNELS.TASK_EXPORT_JSON, async (_, rawQuery?: TaskExportQuery) => {
    checkRateLimit(IPC_CHANNELS.TASK_EXPORT_JSON);

    const query: TaskExportQuery = {
      workspaceId: typeof rawQuery?.workspaceId === "string" ? rawQuery.workspaceId : undefined,
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
        typeof rawQuery?.offset === "number" && Number.isFinite(rawQuery.offset)
          ? rawQuery.offset
          : undefined,
    };

    const maxLimit = 2000;
    const limit = Math.min(Math.max(query.limit ?? 500, 1), maxLimit);
    const offset = Math.max(query.offset ?? 0, 0);

    let tasks: Task[] = [];

    if (query.taskIds && query.taskIds.length > 0) {
      tasks = query.taskIds.map((id) => taskRepo.findById(id)).filter((t): t is Task => !!t);
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

    const workspaceIds = Array.from(new Set(tasks.map((task) => task.workspaceId)));
    const workspaces = workspaceIds
      .map((id) => workspaceRepo.findById(id))
      .filter((ws): ws is Workspace => !!ws);

    return buildTaskExportJson({
      query: {
        ...query,
        // Materialize defaults/caps so callers see what was actually applied.
        ...(query.taskIds && query.taskIds.length > 0 ? {} : { limit, offset }),
      },
      tasks,
      workspaces,
      events,
    });
  });

  ipcMain.handle(IPC_CHANNELS.TASK_CANCEL, async (_, id: string) => {
    try {
      await agentDaemon.cancelTask(id);
    } finally {
      // Always update status even if daemon cancel fails
      taskRepo.update(id, { status: "cancelled" });
    }
  });

  ipcMain.handle(IPC_CHANNELS.TASK_WRAP_UP, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.TASK_WRAP_UP);
    const validated = validateInput(UUIDSchema, id, "task ID");
    await agentDaemon.wrapUpTask(validated);
  });

  ipcMain.handle(IPC_CHANNELS.TASK_PAUSE, async (_, id: string) => {
    // Pause daemon first - if it fails, exception propagates and status won't be updated
    await agentDaemon.pauseTask(id);
    taskRepo.update(id, { status: "paused" });
  });

  ipcMain.handle(IPC_CHANNELS.TASK_RESUME, async (_, id: string) => {
    // Resume daemon first - if it fails, exception propagates and status won't be updated
    await agentDaemon.resumeTask(id);
    taskRepo.update(id, { status: "executing" });
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
        console.warn(`[TASK_DELETE] Worktree cleanup failed for ${id}:`, error);
      }
    }

    // Delete from database
    taskRepo.delete(id);
  });

  // ============ Sub-Agent / Parallel Agent Handlers ============

  // Get child tasks for a parent task
  ipcMain.handle(IPC_CHANNELS.AGENT_GET_CHILDREN, async (_, parentTaskId: string) => {
    return agentDaemon.getChildTasks(parentTaskId);
  });

  // Get status of specific agents
  ipcMain.handle(IPC_CHANNELS.AGENT_GET_STATUS, async (_, taskIds: string[]) => {
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
  });

  // Task events handler - get historical events from database
  // For collaborative root tasks, also include file events from child tasks.
  ipcMain.handle(IPC_CHANNELS.TASK_EVENTS, async (_, taskId: string) => {
    const events = taskEventRepo.findByTaskId(taskId);

    // Include child task file events for collaborative/multi-LLM roots
    const task = taskRepo.findById(taskId);
    if (task?.agentConfig?.collaborativeMode || task?.agentConfig?.multiLlmMode) {
      const childTasks = taskRepo.findByParent(taskId);
      if (childTasks.length > 0) {
        const childIds = childTasks.map((c) => c.id);
        const fileTypes = ["file_created", "file_modified", "file_deleted"];
        const childFileEvents = taskEventRepo.findByTaskIds(childIds, fileTypes);
        // Merge and sort by timestamp
        events.push(...childFileEvents);
        events.sort((a, b) => a.timestamp - b.timestamp);
      }
    }

    const maxEvents = 600;
    return events.length > maxEvents ? events.slice(-maxEvents) : events;
  });

  // Send follow-up message to a task
  ipcMain.handle(IPC_CHANNELS.TASK_SEND_MESSAGE, async (_, data) => {
    checkRateLimit(IPC_CHANNELS.TASK_SEND_MESSAGE);
    const validated = validateInput(TaskMessageSchema, data, "task message");
    const validatedImages = validated.images;
    try {
      await agentDaemon.sendMessage(validated.taskId, validated.message, validatedImages);
    } finally {
      await cleanupTaskImageTempFiles(validatedImages);
    }
  });

  // Approval handlers
  ipcMain.handle(IPC_CHANNELS.APPROVAL_RESPOND, async (_, data) => {
    const validated = validateInput(ApprovalResponseSchema, data, "approval response");
    await agentDaemon.respondToApproval(validated.approvalId, validated.approved);
  });

  // Session auto-approve handlers
  ipcMain.handle(IPC_CHANNELS.APPROVAL_SESSION_AUTO_APPROVE_SET, async (_, enabled: boolean) => {
    agentDaemon.setSessionAutoApproveAll(!!enabled);
  });

  ipcMain.handle(IPC_CHANNELS.APPROVAL_SESSION_AUTO_APPROVE_GET, async () => {
    return agentDaemon.getSessionAutoApproveAll();
  });

  // Artifact handlers
  ipcMain.handle(IPC_CHANNELS.ARTIFACT_LIST, async (_, taskId: string) => {
    return artifactRepo.findByTaskId(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.ARTIFACT_PREVIEW, async (_, id: string) => {
    // TODO: Implement artifact preview
    return null;
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

  // Initialize custom skill loader
  customSkillLoader.initialize().catch((error) => {
    console.error("[IPC] Failed to initialize custom skill loader:", error);
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

  // Skill Registry (SkillHub) handlers
  const { getSkillRegistry } = await import("../agent/skill-registry");
  const skillRegistry = getSkillRegistry();

  ipcMain.handle(
    IPC_CHANNELS.SKILL_REGISTRY_SEARCH,
    async (_, query: string, options?: { page?: number; pageSize?: number }) => {
      return skillRegistry.search(query, options);
    },
  );

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_GET_DETAILS, async (_, skillId: string) => {
    return skillRegistry.getSkillDetails(skillId);
  });

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

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_UNINSTALL, async (_, skillId: string) => {
    const result = skillRegistry.uninstall(skillId);
    if (result.success) {
      await customSkillLoader.reloadSkills();
    }
    return result;
  });

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_LIST_MANAGED, async () => {
    return skillRegistry.listManagedSkills();
  });

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_CHECK_UPDATES, async (_, skillId: string) => {
    return skillRegistry.checkForUpdates(skillId);
  });

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_GET_STATUS, async () => {
    return customSkillLoader.getSkillStatus();
  });

  ipcMain.handle(IPC_CHANNELS.SKILL_REGISTRY_GET_ELIGIBLE, async () => {
    return customSkillLoader.getEligibleSkills();
  });

  // LLM Settings handlers
  ipcMain.handle(IPC_CHANNELS.LLM_GET_SETTINGS, async () => {
    return LLMProviderFactory.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.LLM_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.LLM_SAVE_SETTINGS);
    const validated = validateInput(LLMSettingsSchema, settings, "LLM settings");

    // Load existing settings to preserve cached models and OAuth tokens
    const existingSettings = LLMProviderFactory.loadSettings();

    // Build OpenAI settings, preserving OAuth tokens from existing settings
    let openaiSettings = validated.openai;
    if (existingSettings.openai?.authMethod === "oauth") {
      // Preserve OAuth tokens when saving settings
      openaiSettings = {
        ...validated.openai,
        accessToken: existingSettings.openai.accessToken,
        refreshToken: existingSettings.openai.refreshToken,
        tokenExpiresAt: existingSettings.openai.tokenExpiresAt,
        authMethod: existingSettings.openai.authMethod,
      };
    }

    const normalizeAzureSettings = (
      incoming?: LLMSettingsData["azure"],
      existing?: LLMSettingsData["azure"],
    ): LLMSettingsData["azure"] | undefined => {
      if (!incoming && !existing) return undefined;
      const mergedDeployments = [...(incoming?.deployments || []), ...(existing?.deployments || [])]
        .map((entry) => entry.trim())
        .filter(Boolean);
      const deployment = (
        incoming?.deployment ||
        existing?.deployment ||
        mergedDeployments[0] ||
        ""
      ).trim();
      if (deployment && !mergedDeployments.includes(deployment)) {
        mergedDeployments.unshift(deployment);
      }
      return {
        ...(existing || {}),
        ...(incoming || {}),
        deployment: deployment || undefined,
        deployments:
          mergedDeployments.length > 0 ? Array.from(new Set(mergedDeployments)) : undefined,
      };
    };

    LLMProviderFactory.saveSettings({
      providerType: validated.providerType,
      modelKey: validated.modelKey as ModelKey,
      anthropic: validated.anthropic,
      bedrock: validated.bedrock,
      ollama: validated.ollama,
      gemini: validated.gemini,
      openrouter: validated.openrouter,
      openai: openaiSettings,
      azure: normalizeAzureSettings(validated.azure, existingSettings.azure),
      groq: validated.groq,
      xai: validated.xai,
      kimi: validated.kimi,
      customProviders: validated.customProviders ?? existingSettings.customProviders,
      // Preserve cached models from existing settings
      cachedGeminiModels: existingSettings.cachedGeminiModels,
      cachedOpenRouterModels: existingSettings.cachedOpenRouterModels,
      cachedOllamaModels: existingSettings.cachedOllamaModels,
      cachedBedrockModels: existingSettings.cachedBedrockModels,
      cachedOpenAIModels: existingSettings.cachedOpenAIModels,
      cachedGroqModels: existingSettings.cachedGroqModels,
      cachedXaiModels: existingSettings.cachedXaiModels,
      cachedKimiModels: existingSettings.cachedKimiModels,
    });
    // Clear cache so next task uses new settings
    LLMProviderFactory.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.LLM_TEST_PROVIDER, async (_, config: any) => {
    checkRateLimit(IPC_CHANNELS.LLM_TEST_PROVIDER);
    // For OpenAI OAuth, get tokens from stored settings if authMethod is 'oauth'
    let openaiAccessToken: string | undefined;
    let openaiRefreshToken: string | undefined;
    if (config.providerType === "openai" && config.openai?.authMethod === "oauth") {
      const settings = LLMProviderFactory.loadSettings();
      openaiAccessToken = settings.openai?.accessToken;
      openaiRefreshToken = settings.openai?.refreshToken;
    }
    const resolvedProviderType = resolveCustomProviderId(config.providerType);
    const customProviderConfig =
      config.customProviders?.[resolvedProviderType] ||
      config.customProviders?.[config.providerType];
    const azureDeployment = config.azure?.deployment || config.azure?.deployments?.[0];
    const providerConfig: LLMProviderConfig = {
      type: config.providerType,
      model: LLMProviderFactory.getModelId(
        config.modelKey as ModelKey,
        config.providerType,
        config.ollama?.model,
        config.gemini?.model,
        config.openrouter?.model,
        config.openai?.model,
        azureDeployment,
        config.groq?.model,
        config.xai?.model,
        config.kimi?.model,
        config.customProviders,
        config.bedrock?.model,
      ),
      anthropicApiKey: config.anthropic?.apiKey,
      awsRegion: config.bedrock?.region,
      awsAccessKeyId: config.bedrock?.accessKeyId,
      awsSecretAccessKey: config.bedrock?.secretAccessKey,
      awsSessionToken: config.bedrock?.sessionToken,
      awsProfile: config.bedrock?.profile,
      ollamaBaseUrl: config.ollama?.baseUrl,
      ollamaApiKey: config.ollama?.apiKey,
      geminiApiKey: config.gemini?.apiKey,
      openrouterApiKey: config.openrouter?.apiKey,
      openrouterBaseUrl: config.openrouter?.baseUrl,
      openaiApiKey: config.openai?.apiKey,
      openaiAccessToken: openaiAccessToken,
      openaiRefreshToken: openaiRefreshToken,
      azureApiKey: config.azure?.apiKey,
      azureEndpoint: config.azure?.endpoint,
      azureDeployment: azureDeployment,
      azureApiVersion: config.azure?.apiVersion,
      groqApiKey: config.groq?.apiKey,
      groqBaseUrl: config.groq?.baseUrl,
      xaiApiKey: config.xai?.apiKey,
      xaiBaseUrl: config.xai?.baseUrl,
      kimiApiKey: config.kimi?.apiKey,
      kimiBaseUrl: config.kimi?.baseUrl,
      providerApiKey: customProviderConfig?.apiKey,
      providerBaseUrl: customProviderConfig?.baseUrl,
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

  // Get models available for a specific provider type (for multi-LLM selection)
  ipcMain.handle(IPC_CHANNELS.LLM_GET_PROVIDER_MODELS, async (_, providerType: string) => {
    const settings = LLMProviderFactory.loadSettings();
    const modifiedSettings = { ...settings, providerType: providerType as any };
    const modelStatus = LLMProviderFactory.getProviderModelStatus(modifiedSettings);
    return modelStatus.models;
  });

  // Set the current model (persists selection across sessions)
  ipcMain.handle(IPC_CHANNELS.LLM_SET_MODEL, async (_, modelKey: string) => {
    const settings = LLMProviderFactory.loadSettings();
    const updatedSettings = LLMProviderFactory.applyModelSelection(settings, modelKey);
    LLMProviderFactory.saveSettings(updatedSettings);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.LLM_GET_OLLAMA_MODELS, async (_, baseUrl?: string) => {
    checkRateLimit(IPC_CHANNELS.LLM_GET_OLLAMA_MODELS);
    console.log("[IPC] Handling LLM_GET_OLLAMA_MODELS request");
    const models = await LLMProviderFactory.getOllamaModels(baseUrl);
    // Cache the models for use in config status
    const cachedModels = models.map((m) => ({
      key: m.name,
      displayName: m.name,
      description: `${Math.round(m.size / 1e9)}B parameter model`,
      size: m.size,
    }));
    LLMProviderFactory.saveCachedModels("ollama", cachedModels);
    return models;
  });

  ipcMain.handle(IPC_CHANNELS.LLM_GET_GEMINI_MODELS, async (_, apiKey?: string) => {
    checkRateLimit(IPC_CHANNELS.LLM_GET_GEMINI_MODELS);
    const models = await LLMProviderFactory.getGeminiModels(apiKey);
    // Cache the models for use in config status
    const cachedModels = models.map((m) => ({
      key: m.name,
      displayName: m.displayName,
      description: m.description,
    }));
    LLMProviderFactory.saveCachedModels("gemini", cachedModels);
    return models;
  });

  ipcMain.handle(
    IPC_CHANNELS.LLM_GET_OPENROUTER_MODELS,
    async (_, apiKey?: string, baseUrl?: string) => {
      checkRateLimit(IPC_CHANNELS.LLM_GET_OPENROUTER_MODELS);
      const models = await LLMProviderFactory.getOpenRouterModels(apiKey, baseUrl);
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

  ipcMain.handle(IPC_CHANNELS.LLM_GET_OPENAI_MODELS, async (_, apiKey?: string) => {
    checkRateLimit(IPC_CHANNELS.LLM_GET_OPENAI_MODELS);
    const models = await LLMProviderFactory.getOpenAIModels(apiKey);
    // Cache the models for use in config status
    const cachedModels = models.map((m) => ({
      key: m.id,
      displayName: m.name,
      description: m.description,
    }));
    LLMProviderFactory.saveCachedModels("openai", cachedModels);
    return models;
  });

  ipcMain.handle(IPC_CHANNELS.LLM_GET_GROQ_MODELS, async (_, apiKey?: string, baseUrl?: string) => {
    checkRateLimit(IPC_CHANNELS.LLM_GET_GROQ_MODELS);
    const models = await LLMProviderFactory.getGroqModels(apiKey, baseUrl);
    const cachedModels = models.map((m) => ({
      key: m.id,
      displayName: m.name,
      description: "Groq model",
    }));
    LLMProviderFactory.saveCachedModels("groq", cachedModels);
    return models;
  });

  ipcMain.handle(IPC_CHANNELS.LLM_GET_XAI_MODELS, async (_, apiKey?: string, baseUrl?: string) => {
    checkRateLimit(IPC_CHANNELS.LLM_GET_XAI_MODELS);
    const models = await LLMProviderFactory.getXAIModels(apiKey, baseUrl);
    const cachedModels = models.map((m) => ({
      key: m.id,
      displayName: m.name,
      description: "xAI model",
    }));
    LLMProviderFactory.saveCachedModels("xai", cachedModels);
    return models;
  });

  ipcMain.handle(IPC_CHANNELS.LLM_GET_KIMI_MODELS, async (_, apiKey?: string, baseUrl?: string) => {
    checkRateLimit(IPC_CHANNELS.LLM_GET_KIMI_MODELS);
    const models = await LLMProviderFactory.getKimiModels(apiKey, baseUrl);
    const cachedModels = models.map((m) => ({
      key: m.id,
      displayName: m.name,
      description: "Kimi model",
    }));
    LLMProviderFactory.saveCachedModels("kimi", cachedModels);
    return models;
  });

  ipcMain.handle(IPC_CHANNELS.LLM_GET_PI_MODELS, async (_, piProvider?: string) => {
    checkRateLimit(IPC_CHANNELS.LLM_GET_PI_MODELS);
    const models = await LLMProviderFactory.getPiModels(piProvider);
    const cachedModels = models.map((m) => ({
      key: m.id,
      displayName: m.name,
      description: m.description,
    }));
    LLMProviderFactory.saveCachedModels("pi", cachedModels);
    return models;
  });

  ipcMain.handle(IPC_CHANNELS.LLM_GET_PI_PROVIDERS, async () => {
    checkRateLimit(IPC_CHANNELS.LLM_GET_PI_PROVIDERS);
    return LLMProviderFactory.getPiProviders();
  });

  // OpenAI OAuth handlers
  ipcMain.handle(IPC_CHANNELS.LLM_OPENAI_OAUTH_START, async () => {
    checkRateLimit(IPC_CHANNELS.LLM_OPENAI_OAUTH_START);
    console.log("[IPC] Starting OpenAI OAuth flow with pi-ai SDK...");

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
        authMethod: "oauth",
        // Clear API key when using OAuth
        apiKey: undefined,
      };
      LLMProviderFactory.saveSettings(settings);
      LLMProviderFactory.clearCache();

      console.log("[IPC] OpenAI OAuth successful!");
      if (tokens.email) {
        console.log("[IPC] Logged in as:", tokens.email);
      }

      return { success: true, email: tokens.email };
    } catch (error: any) {
      console.error("[IPC] OpenAI OAuth failed:", error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.LLM_OPENAI_OAUTH_LOGOUT, async () => {
    checkRateLimit(IPC_CHANNELS.LLM_OPENAI_OAUTH_LOGOUT);
    console.log("[IPC] Logging out of OpenAI OAuth...");

    // Clear OAuth tokens from settings
    const settings = LLMProviderFactory.loadSettings();
    if (settings.openai) {
      settings.openai = {
        ...settings.openai,
        accessToken: undefined,
        refreshToken: undefined,
        tokenExpiresAt: undefined,
        authMethod: undefined,
      };
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
    const validated = validateInput(SearchSettingsSchema, settings, "search settings");
    SearchProviderFactory.saveSettings(validated as SearchSettings);
    SearchProviderFactory.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.SEARCH_GET_CONFIG_STATUS, async () => {
    return SearchProviderFactory.getConfigStatus();
  });

  ipcMain.handle(IPC_CHANNELS.SEARCH_TEST_PROVIDER, async (_, providerType: SearchProviderType) => {
    checkRateLimit(IPC_CHANNELS.SEARCH_TEST_PROVIDER);
    return SearchProviderFactory.testProvider(providerType);
  });

  // X/Twitter Settings handlers
  ipcMain.handle(IPC_CHANNELS.X_GET_SETTINGS, async () => {
    return XSettingsManager.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.X_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.X_SAVE_SETTINGS);
    const validated = validateInput(XSettingsSchema, settings, "x settings") as XSettingsData;
    XSettingsManager.saveSettings(validated);
    XSettingsManager.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.X_TEST_CONNECTION, async () => {
    checkRateLimit(IPC_CHANNELS.X_TEST_CONNECTION);
    const settings = XSettingsManager.loadSettings();
    return testXConnection(settings);
  });

  ipcMain.handle(IPC_CHANNELS.X_GET_STATUS, async () => {
    checkRateLimit(IPC_CHANNELS.X_GET_STATUS);
    const installStatus = await checkBirdInstalled();
    if (!installStatus.installed) {
      return { installed: false, connected: false };
    }

    const settings = XSettingsManager.loadSettings();
    if (!settings.enabled) {
      return { installed: true, connected: false };
    }

    const result = await testXConnection(settings);
    return {
      installed: true,
      connected: result.success,
      username: result.username,
      error: result.success ? undefined : result.error,
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
    const validated = validateInput(BoxSettingsSchema, settings, "box settings") as BoxSettingsData;
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

  ipcMain.handle(IPC_CHANNELS.GOOGLE_WORKSPACE_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.GOOGLE_WORKSPACE_SAVE_SETTINGS);
    const validated = validateInput(
      GoogleWorkspaceSettingsSchema,
      settings,
      "google workspace settings",
    ) as GoogleWorkspaceSettingsData;
    GoogleWorkspaceSettingsManager.saveSettings(validated);
    GoogleWorkspaceSettingsManager.clearCache();
    return { success: true };
  });

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

  ipcMain.handle(IPC_CHANNELS.GOOGLE_WORKSPACE_OAUTH_START, async (_, payload) => {
    checkRateLimit(IPC_CHANNELS.GOOGLE_WORKSPACE_OAUTH_START);
    return startGoogleWorkspaceOAuth(payload);
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
          ingestNonSelfChatsInSelfChatMode: validated.ingestNonSelfChatsInSelfChatMode ?? false,
          trustedGroupMemoryOptIn: validated.trustedGroupMemoryOptIn ?? false,
          sendReadReceipts: validated.sendReadReceipts,
          deduplicationEnabled: validated.deduplicationEnabled,
          groupRoutingMode: validated.groupRoutingMode,
        },
      );

      // Automatically enable and connect WhatsApp to start QR code generation
      // This is done asynchronously to not block the response
      gateway.enableWhatsAppWithQRForwarding(channel.id).catch((err) => {
        console.error("Failed to enable WhatsApp channel:", err);
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
        console.error("Failed to enable iMessage channel:", err);
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
        validated.sendReadReceipts ?? true,
        validated.sendTypingIndicators ?? true,
      );

      // Automatically enable and connect Signal
      gateway.enableChannel(channel.id).catch((err) => {
        console.error("Failed to enable Signal channel:", err);
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
        console.error("Failed to enable Mattermost channel:", err);
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
        console.error("Failed to enable Matrix channel:", err);
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
        console.error("Failed to enable Twitch channel:", err);
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
        console.error("Failed to enable LINE channel:", err);
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
        console.error("Failed to enable BlueBubbles channel:", err);
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
        console.error("Failed to enable Email channel:", err);
      });

      return toPublicChannel(channel, "connecting");
    }

    // TypeScript exhaustiveness check - should never reach here due to discriminated union
    throw new Error(`Unsupported channel type`);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_UPDATE_CHANNEL, async (_, data) => {
    if (!gateway) throw new Error("Gateway not initialized");

    const validated = validateInput(UpdateChannelSchema, data, "channel update");
    const channel = gateway.getChannel(validated.id);
    if (!channel) throw new Error("Channel not found");

    const updates: Record<string, unknown> = {};
    if (validated.name !== undefined) updates.name = validated.name;
    if (validated.securityMode !== undefined) {
      updates.securityConfig = { ...channel.securityConfig, mode: validated.securityMode };
    }
    if (validated.config !== undefined) {
      const mergedConfig = { ...channel.config, ...validated.config };

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

  ipcMain.handle(IPC_CHANNELS.GATEWAY_DISABLE_CHANNEL, async (_, id: string) => {
    if (!gateway) throw new Error("Gateway not initialized");
    await gateway.disableChannel(id);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_TEST_CHANNEL, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.GATEWAY_TEST_CHANNEL);
    if (!gateway) return { success: false, error: "Gateway not initialized" };
    return gateway.testChannel(id);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_GET_USERS, async (_, channelId: string) => {
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
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_GRANT_ACCESS, async (_, data) => {
    if (!gateway) throw new Error("Gateway not initialized");
    const validated = validateInput(GrantAccessSchema, data, "grant access");
    gateway.grantUserAccess(validated.channelId, validated.userId, validated.displayName);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_REVOKE_ACCESS, async (_, data) => {
    if (!gateway) throw new Error("Gateway not initialized");
    const validated = validateInput(RevokeAccessSchema, data, "revoke access");
    gateway.revokeUserAccess(validated.channelId, validated.userId);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_GENERATE_PAIRING, async (_, data) => {
    if (!gateway) throw new Error("Gateway not initialized");
    const validated = validateInput(GeneratePairingSchema, data, "generate pairing");
    return gateway.generatePairingCode(
      validated.channelId,
      validated.userId,
      validated.displayName,
    );
  });

  // WhatsApp-specific handlers
  ipcMain.handle("whatsapp:get-info", async () => {
    if (!gateway) return {};
    return gateway.getWhatsAppInfo();
  });

  ipcMain.handle("whatsapp:logout", async () => {
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

  ipcMain.handle(IPC_CHANNELS.APP_DOWNLOAD_UPDATE, async (_, updateInfo: UpdateInfo) => {
    await updateManager.downloadAndInstallUpdate(updateInfo);
    return { success: true };
  });

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
    const validated = validateInput(GuardrailSettingsSchema, settings, "guardrail settings");
    GuardrailManager.saveSettings(validated);
    GuardrailManager.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.GUARDRAIL_GET_DEFAULTS, async () => {
    return GuardrailManager.getDefaults();
  });

  // Appearance Settings handlers
  ipcMain.handle(IPC_CHANNELS.APPEARANCE_GET_SETTINGS, async () => {
    return AppearanceManager.loadSettings();
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

  ipcMain.handle(IPC_CHANNELS.PERSONALITY_SAVE_SETTINGS, async (_, settings) => {
    PersonalityManager.saveSettings(settings);
    // Event emission is handled by PersonalityManager.saveSettings()
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.PERSONALITY_GET_DEFINITIONS, async () => {
    return PersonalityManager.getDefinitions();
  });

  ipcMain.handle(IPC_CHANNELS.PERSONALITY_GET_PERSONAS, async () => {
    return PersonalityManager.getPersonaDefinitions();
  });

  ipcMain.handle(IPC_CHANNELS.PERSONALITY_GET_RELATIONSHIP_STATS, async () => {
    return PersonalityManager.getRelationshipStats();
  });

  ipcMain.handle(IPC_CHANNELS.PERSONALITY_SET_ACTIVE, async (_, personalityId) => {
    PersonalityManager.setActivePersonality(personalityId);
    // Event emission is handled by PersonalityManager.saveSettings()
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.PERSONALITY_SET_PERSONA, async (_, personaId) => {
    PersonalityManager.setActivePersona(personaId);
    // Event emission is handled by PersonalityManager.saveSettings()
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.PERSONALITY_RESET, async (_, preserveRelationship?: boolean) => {
    checkRateLimit(IPC_CHANNELS.PERSONALITY_RESET);
    PersonalityManager.resetToDefaults(preserveRelationship);
    // Event emission is handled by PersonalityManager.resetToDefaults()
    return { success: true };
  });

  // Agent Role / Squad handlers
  ipcMain.handle(IPC_CHANNELS.AGENT_ROLE_LIST, async (_, includeInactive?: boolean) => {
    return agentRoleRepo.findAll(includeInactive ?? false);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_ROLE_GET, async (_, id: string) => {
    const validated = validateInput(UUIDSchema, id, "agent role ID");
    return agentRoleRepo.findById(validated);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_ROLE_CREATE, async (_, request) => {
    checkRateLimit(IPC_CHANNELS.AGENT_ROLE_CREATE);
    // Validate name format (lowercase, alphanumeric, hyphens)
    if (!/^[a-z0-9-]+$/.test(request.name)) {
      throw new Error("Agent role name must be lowercase alphanumeric with hyphens only");
    }
    // Check for duplicate name
    if (agentRoleRepo.findByName(request.name)) {
      throw new Error(`Agent role with name "${request.name}" already exists`);
    }
    return agentRoleRepo.create(request);
  });

  ipcMain.handle(IPC_CHANNELS.AGENT_ROLE_UPDATE, async (_, request) => {
    checkRateLimit(IPC_CHANNELS.AGENT_ROLE_UPDATE);
    const validated = validateInput(UUIDSchema, request.id, "agent role ID");
    const result = agentRoleRepo.update({ ...request, id: validated });
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
        const validatedRoleId = validateInput(UUIDSchema, agentRoleId, "agent role ID");
        const role = agentRoleRepo.findById(validatedRoleId);
        if (!role) {
          throw new Error("Agent role not found");
        }
      }
      const taskUpdate: Partial<Task> = { assignedAgentRoleId: agentRoleId ?? undefined };
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
  ipcMain.handle(IPC_CHANNELS.ACTIVITY_LIST, async (_, query: any) => {
    const validated = validateInput(UUIDSchema, query.workspaceId, "workspace ID");
    return activityRepo.list({ ...query, workspaceId: validated });
  });

  ipcMain.handle(IPC_CHANNELS.ACTIVITY_CREATE, async (_, request: any) => {
    checkRateLimit(IPC_CHANNELS.ACTIVITY_CREATE);
    const validatedWorkspaceId = validateInput(UUIDSchema, request.workspaceId, "workspace ID");
    const activity = activityRepo.create({ ...request, workspaceId: validatedWorkspaceId });
    // Emit activity event for real-time updates
    getMainWindow()?.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, { type: "created", activity });
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

  ipcMain.handle(IPC_CHANNELS.ACTIVITY_MARK_ALL_READ, async (_, workspaceId: string) => {
    checkRateLimit(IPC_CHANNELS.ACTIVITY_MARK_ALL_READ);
    const validated = validateInput(UUIDSchema, workspaceId, "workspace ID");
    const count = activityRepo.markAllRead(validated);
    getMainWindow()?.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, {
      type: "all_read",
      workspaceId: validated,
    });
    return { count };
  });

  ipcMain.handle(IPC_CHANNELS.ACTIVITY_PIN, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.ACTIVITY_PIN);
    const validated = validateInput(UUIDSchema, id, "activity ID");
    const activity = activityRepo.togglePin(validated);
    if (activity) {
      getMainWindow()?.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, { type: "pinned", activity });
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
  ipcMain.handle(IPC_CHANNELS.MENTION_LIST, async (_, query: any) => {
    return mentionRepo.list(query);
  });

  ipcMain.handle(IPC_CHANNELS.MENTION_CREATE, async (_, request: any) => {
    checkRateLimit(IPC_CHANNELS.MENTION_CREATE);
    const validatedWorkspaceId = validateInput(UUIDSchema, request.workspaceId, "workspace ID");
    const mention = mentionRepo.create({ ...request, workspaceId: validatedWorkspaceId });
    // Emit mention event for real-time updates
    getMainWindow()?.webContents.send(IPC_CHANNELS.MENTION_EVENT, { type: "created", mention });
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
      getMainWindow()?.webContents.send(IPC_CHANNELS.MENTION_EVENT, { type: "completed", mention });
    }
    return mention;
  });

  ipcMain.handle(IPC_CHANNELS.MENTION_DISMISS, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.MENTION_DISMISS);
    const validated = validateInput(UUIDSchema, id, "mention ID");
    const mention = mentionRepo.dismiss(validated);
    if (mention) {
      getMainWindow()?.webContents.send(IPC_CHANNELS.MENTION_EVENT, { type: "dismissed", mention });
    }
    return mention;
  });

  // Agent Teams (Mission Control)
  const emitTeamEvent = (event: any) => {
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

  ipcMain.handle(IPC_CHANNELS.TEAM_CREATE, async (_, request: any) => {
    checkRateLimit(IPC_CHANNELS.TEAM_CREATE);
    const workspaceId = validateInput(UUIDSchema, request.workspaceId, "workspace ID");
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
      description: typeof request.description === "string" ? request.description.trim() : undefined,
      leadAgentRoleId,
      maxParallelAgents:
        typeof request.maxParallelAgents === "number" ? request.maxParallelAgents : undefined,
      defaultModelPreference:
        typeof request.defaultModelPreference === "string"
          ? request.defaultModelPreference
          : undefined,
      defaultPersonality:
        typeof request.defaultPersonality === "string" ? request.defaultPersonality : undefined,
      isActive: request.isActive !== undefined ? !!request.isActive : undefined,
    });
    emitTeamEvent({ type: "team_created", timestamp: Date.now(), team: created });
    return created;
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_UPDATE, async (_, request: any) => {
    checkRateLimit(IPC_CHANNELS.TEAM_UPDATE);
    const id = validateInput(UUIDSchema, request.id, "team ID");
    const updates: any = { id };
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
      const leadId = validateInput(UUIDSchema, request.leadAgentRoleId, "lead agent role ID");
      if (!agentRoleRepo.findById(leadId)) throw new Error("Lead agent role not found");
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
      emitTeamEvent({ type: "team_updated", timestamp: Date.now(), team: updated });
    }
    return updated;
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_DELETE, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.TEAM_DELETE);
    const validated = validateInput(UUIDSchema, id, "team ID");
    const success = teamRepo.delete(validated);
    if (success) {
      emitTeamEvent({ type: "team_deleted", timestamp: Date.now(), teamId: validated });
    }
    return { success };
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_MEMBER_LIST, async (_, teamId: string) => {
    const validated = validateInput(UUIDSchema, teamId, "team ID");
    return teamMemberRepo.listByTeam(validated);
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_MEMBER_ADD, async (_, request: any) => {
    checkRateLimit(IPC_CHANNELS.TEAM_MEMBER_ADD);
    const teamId = validateInput(UUIDSchema, request.teamId, "team ID");
    const agentRoleId = validateInput(UUIDSchema, request.agentRoleId, "agent role ID");
    if (!agentRoleRepo.findById(agentRoleId)) throw new Error("Agent role not found");
    const member = teamMemberRepo.add({
      teamId,
      agentRoleId,
      memberOrder: typeof request.memberOrder === "number" ? request.memberOrder : undefined,
      isRequired: request.isRequired !== undefined ? !!request.isRequired : undefined,
      roleGuidance: typeof request.roleGuidance === "string" ? request.roleGuidance : undefined,
    });
    emitTeamEvent({ type: "team_member_added", timestamp: Date.now(), member });
    return member;
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_MEMBER_UPDATE, async (_, request: any) => {
    checkRateLimit(IPC_CHANNELS.TEAM_MEMBER_UPDATE);
    const id = validateInput(UUIDSchema, request.id, "team member ID");
    const updated = teamMemberRepo.update({
      id,
      memberOrder: typeof request.memberOrder === "number" ? request.memberOrder : undefined,
      isRequired: request.isRequired !== undefined ? !!request.isRequired : undefined,
      roleGuidance:
        request.roleGuidance === null
          ? null
          : typeof request.roleGuidance === "string"
            ? request.roleGuidance
            : undefined,
    });
    if (updated) {
      emitTeamEvent({ type: "team_member_updated", timestamp: Date.now(), member: updated });
    }
    return updated;
  });

  ipcMain.handle(
    IPC_CHANNELS.TEAM_MEMBER_REMOVE,
    async (_, data: { teamId: string; agentRoleId: string }) => {
      checkRateLimit(IPC_CHANNELS.TEAM_MEMBER_REMOVE);
      const teamId = validateInput(UUIDSchema, data.teamId, "team ID");
      const agentRoleId = validateInput(UUIDSchema, data.agentRoleId, "agent role ID");
      const success = teamMemberRepo.removeByTeamAndRole(teamId, agentRoleId);
      if (success) {
        emitTeamEvent({ type: "team_member_removed", timestamp: Date.now(), teamId, agentRoleId });
      }
      return { success };
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.TEAM_MEMBER_REORDER,
    async (_, data: { teamId: string; orderedMemberIds: string[] }) => {
      checkRateLimit(IPC_CHANNELS.TEAM_MEMBER_REORDER);
      const teamId = validateInput(UUIDSchema, data.teamId, "team ID");
      const ordered = Array.isArray(data.orderedMemberIds) ? data.orderedMemberIds : [];
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

  ipcMain.handle(IPC_CHANNELS.TEAM_RUN_LIST, async (_, query: any) => {
    const teamId = validateInput(UUIDSchema, query.teamId, "team ID");
    const limit = typeof query.limit === "number" ? query.limit : undefined;
    return teamRunRepo.listByTeam(teamId, limit);
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_RUN_GET, async (_, id: string) => {
    const validated = validateInput(UUIDSchema, id, "team run ID");
    return teamRunRepo.findById(validated);
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_RUN_CREATE, async (_, request: any) => {
    checkRateLimit(IPC_CHANNELS.TEAM_RUN_CREATE);
    const teamId = validateInput(UUIDSchema, request.teamId, "team ID");
    const rootTaskId = validateInput(UUIDSchema, request.rootTaskId, "root task ID");
    const rootTask = taskRepo.findById(rootTaskId);
    if (!rootTask) throw new Error("Root task not found");
    const created = teamRunRepo.create({
      teamId,
      rootTaskId,
      status: request.status,
      startedAt: request.startedAt,
      collaborativeMode: request.collaborativeMode,
    });
    emitTeamEvent({ type: "team_run_created", timestamp: Date.now(), run: created });
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
      emitTeamEvent({ type: "team_run_updated", timestamp: Date.now(), run: updated });
      void teamOrchestrator.tickRun(updated.id, "resume");
    }
    return { success: !!updated };
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_RUN_PAUSE, async (_, runId: string) => {
    checkRateLimit(IPC_CHANNELS.TEAM_RUN_PAUSE);
    const validated = validateInput(UUIDSchema, runId, "team run ID");
    const updated = teamRunRepo.update(validated, { status: "paused" });
    if (updated) {
      emitTeamEvent({ type: "team_run_updated", timestamp: Date.now(), run: updated });
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

  ipcMain.handle(IPC_CHANNELS.TEAM_ITEM_CREATE, async (_, request: any) => {
    checkRateLimit(IPC_CHANNELS.TEAM_ITEM_CREATE);
    const teamRunId = validateInput(UUIDSchema, request.teamRunId, "team run ID");
    const title = typeof request.title === "string" ? request.title.trim() : "";
    if (!title) throw new Error("Item title is required");
    const created = teamItemRepo.create({
      teamRunId,
      parentItemId: request.parentItemId || undefined,
      title,
      description: typeof request.description === "string" ? request.description : undefined,
      ownerAgentRoleId: request.ownerAgentRoleId
        ? validateInput(UUIDSchema, request.ownerAgentRoleId, "owner agent role ID")
        : undefined,
      sourceTaskId: request.sourceTaskId
        ? validateInput(UUIDSchema, request.sourceTaskId, "source task ID")
        : undefined,
      status: request.status,
      sortOrder: typeof request.sortOrder === "number" ? request.sortOrder : undefined,
    });
    emitTeamEvent({ type: "team_item_created", timestamp: Date.now(), item: created });
    const run = teamRunRepo.findById(teamRunId);
    if (run?.status === "running") {
      void teamOrchestrator.tickRun(teamRunId, "item_created");
    }
    return created;
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_ITEM_UPDATE, async (_, request: any) => {
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

  ipcMain.handle(IPC_CHANNELS.TEAM_ITEM_MOVE, async (_, request: any) => {
    checkRateLimit(IPC_CHANNELS.TEAM_ITEM_MOVE);
    const id = validateInput(UUIDSchema, request.id, "team item ID");
    const updated = teamItemRepo.update({
      id,
      parentItemId: request.parentItemId,
      sortOrder: request.sortOrder,
    });
    if (updated) {
      emitTeamEvent({ type: "team_item_moved", timestamp: Date.now(), item: updated });
      const run = teamRunRepo.findById(updated.teamRunId);
      if (run?.status === "running") {
        void teamOrchestrator.tickRun(updated.teamRunId, "item_moved");
      }
    }
    return updated;
  });

  // Collaborative Thoughts
  ipcMain.handle(IPC_CHANNELS.TEAM_THOUGHT_LIST, async (_, teamRunId: string) => {
    const validated = validateInput(UUIDSchema, teamRunId, "team run ID");
    return teamThoughtRepo.listByRun(validated);
  });

  ipcMain.handle(IPC_CHANNELS.TEAM_RUN_FIND_BY_ROOT_TASK, async (_, rootTaskId: string) => {
    const validated = validateInput(UUIDSchema, rootTaskId, "root task ID");
    return teamRunRepo.findByRootTaskId(validated) || null;
  });

  // Agent Performance Reviews (Mission Control)
  ipcMain.handle(IPC_CHANNELS.REVIEW_GENERATE, async (_, request: any) => {
    checkRateLimit(IPC_CHANNELS.REVIEW_GENERATE);
    const workspaceId = validateInput(UUIDSchema, request.workspaceId, "workspace ID");
    const agentRoleId = validateInput(UUIDSchema, request.agentRoleId, "agent role ID");
    if (!agentRoleRepo.findById(agentRoleId)) {
      throw new Error("Agent role not found");
    }
    const periodDays = request.periodDays !== undefined ? Number(request.periodDays) : undefined;
    return reviewService.generate({ workspaceId, agentRoleId, periodDays });
  });

  ipcMain.handle(
    IPC_CHANNELS.REVIEW_GET_LATEST,
    async (_, workspaceId: string, agentRoleId: string) => {
      const validatedWorkspaceId = validateInput(UUIDSchema, workspaceId, "workspace ID");
      const validatedRoleId = validateInput(UUIDSchema, agentRoleId, "agent role ID");
      return reviewService.getLatest(validatedWorkspaceId, validatedRoleId);
    },
  );

  ipcMain.handle(IPC_CHANNELS.REVIEW_LIST, async (_, query: any) => {
    const validatedWorkspaceId = validateInput(UUIDSchema, query.workspaceId, "workspace ID");
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

  // Task Board handlers
  ipcMain.handle(IPC_CHANNELS.TASK_MOVE_COLUMN, async (_, taskId: string, column: string) => {
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
      getMainWindow()?.webContents.send(IPC_CHANNELS.ACTIVITY_EVENT, { type: "created", activity });
    }
    return task;
  });

  ipcMain.handle(IPC_CHANNELS.TASK_SET_PRIORITY, async (_, taskId: string, priority: number) => {
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
  });

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

  ipcMain.handle(IPC_CHANNELS.TASK_ADD_LABEL, async (_, taskId: string, labelId: string) => {
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
  });

  ipcMain.handle(IPC_CHANNELS.TASK_REMOVE_LABEL, async (_, taskId: string, labelId: string) => {
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
  });

  // Task Label handlers
  ipcMain.handle(IPC_CHANNELS.TASK_LABEL_LIST, async (_, workspaceId: string) => {
    const validated = validateInput(UUIDSchema, workspaceId, "workspace ID");
    return taskLabelRepo.list({ workspaceId: validated });
  });

  ipcMain.handle(IPC_CHANNELS.TASK_LABEL_CREATE, async (_, request: any) => {
    checkRateLimit(IPC_CHANNELS.TASK_LABEL_CREATE);
    const validatedWorkspaceId = validateInput(UUIDSchema, request.workspaceId, "workspace ID");
    return taskLabelRepo.create({ ...request, workspaceId: validatedWorkspaceId });
  });

  ipcMain.handle(IPC_CHANNELS.TASK_LABEL_UPDATE, async (_, id: string, request: any) => {
    checkRateLimit(IPC_CHANNELS.TASK_LABEL_UPDATE);
    const validated = validateInput(UUIDSchema, id, "label ID");
    return taskLabelRepo.update(validated, request);
  });

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

  ipcMain.handle(IPC_CHANNELS.WORKING_STATE_GET_CURRENT, async (_, query: any) => {
    const validatedAgentRoleId = validateInput(UUIDSchema, query.agentRoleId, "agent role ID");
    const validatedWorkspaceId = validateInput(UUIDSchema, query.workspaceId, "workspace ID");
    return workingStateRepo.getCurrent({
      agentRoleId: validatedAgentRoleId,
      workspaceId: validatedWorkspaceId,
      taskId: query.taskId,
      stateType: query.stateType,
    });
  });

  ipcMain.handle(IPC_CHANNELS.WORKING_STATE_UPDATE, async (_, request: any) => {
    checkRateLimit(IPC_CHANNELS.WORKING_STATE_UPDATE);
    const validatedAgentRoleId = validateInput(UUIDSchema, request.agentRoleId, "agent role ID");
    const validatedWorkspaceId = validateInput(UUIDSchema, request.workspaceId, "workspace ID");
    return workingStateRepo.update({
      agentRoleId: validatedAgentRoleId,
      workspaceId: validatedWorkspaceId,
      taskId: request.taskId,
      stateType: request.stateType,
      content: request.content,
      fileReferences: request.fileReferences,
    });
  });

  ipcMain.handle(IPC_CHANNELS.WORKING_STATE_HISTORY, async (_, query: any) => {
    const validatedAgentRoleId = validateInput(UUIDSchema, query.agentRoleId, "agent role ID");
    const validatedWorkspaceId = validateInput(UUIDSchema, query.workspaceId, "workspace ID");
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

  ipcMain.handle(IPC_CHANNELS.WORKING_STATE_LIST_FOR_TASK, async (_, taskId: string) => {
    const validated = validateInput(UUIDSchema, taskId, "task ID");
    return workingStateRepo.listForTask(validated);
  });

  // Context Policy handlers (per-context security DM vs group)
  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_POLICY_GET,
    async (_, channelId: string, contextType: string) => {
      return contextPolicyManager.getPolicy(channelId, contextType as "dm" | "group");
    },
  );

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_POLICY_GET_FOR_CHAT,
    async (_, channelId: string, chatId: string, isGroup: boolean) => {
      return contextPolicyManager.getPolicyForChat(channelId, chatId, isGroup);
    },
  );

  ipcMain.handle(IPC_CHANNELS.CONTEXT_POLICY_LIST, async (_, channelId: string) => {
    return contextPolicyManager.getPoliciesForChannel(channelId);
  });

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_POLICY_UPDATE,
    async (
      _,
      channelId: string,
      contextType: string,
      options: { securityMode?: string; toolRestrictions?: string[] },
    ) => {
      checkRateLimit(IPC_CHANNELS.CONTEXT_POLICY_UPDATE);
      return contextPolicyManager.updateByContext(channelId, contextType as "dm" | "group", {
        securityMode: options.securityMode as "open" | "allowlist" | "pairing" | undefined,
        toolRestrictions: options.toolRestrictions,
      });
    },
  );

  ipcMain.handle(IPC_CHANNELS.CONTEXT_POLICY_DELETE, async (_, channelId: string) => {
    checkRateLimit(IPC_CHANNELS.CONTEXT_POLICY_DELETE);
    return { count: contextPolicyManager.deleteByChannel(channelId) };
  });

  ipcMain.handle(IPC_CHANNELS.CONTEXT_POLICY_CREATE_DEFAULTS, async (_, channelId: string) => {
    checkRateLimit(IPC_CHANNELS.CONTEXT_POLICY_CREATE_DEFAULTS);
    contextPolicyManager.createDefaultPolicies(channelId);
    return { success: true };
  });

  ipcMain.handle(
    IPC_CHANNELS.CONTEXT_POLICY_IS_TOOL_ALLOWED,
    async (_, channelId: string, contextType: string, toolName: string, toolGroups: string[]) => {
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

  // MCP handlers
  setupMCPHandlers();

  // Conway Terminal handlers
  setupConwayHandlers();

  // Notification handlers
  setupNotificationHandlers();

  // Hooks (Webhooks & Gmail Pub/Sub) handlers
  await setupHooksHandlers(agentDaemon);

  // Workspace kit (.cowork) handlers
  setupKitHandlers(workspaceRepo);

  // Memory system handlers
  setupMemoryHandlers();
}

/**
 * Set up MCP (Model Context Protocol) IPC handlers
 */
function setupMCPHandlers(): void {
  // Configure rate limits for MCP channels
  rateLimiter.configure(IPC_CHANNELS.MCP_SAVE_SETTINGS, RATE_LIMIT_CONFIGS.limited);
  rateLimiter.configure(IPC_CHANNELS.MCP_CONNECT_SERVER, RATE_LIMIT_CONFIGS.expensive);
  rateLimiter.configure(IPC_CHANNELS.MCP_TEST_SERVER, RATE_LIMIT_CONFIGS.expensive);
  rateLimiter.configure(IPC_CHANNELS.MCP_REGISTRY_INSTALL, RATE_LIMIT_CONFIGS.expensive);
  rateLimiter.configure(IPC_CHANNELS.MCP_CONNECTOR_OAUTH_START, RATE_LIMIT_CONFIGS.expensive);

  // Initialize MCP settings manager
  MCPSettingsManager.initialize();

  // Get settings
  ipcMain.handle(IPC_CHANNELS.MCP_GET_SETTINGS, async () => {
    return MCPSettingsManager.getSettingsForDisplay();
  });

  // Save settings
  ipcMain.handle(IPC_CHANNELS.MCP_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.MCP_SAVE_SETTINGS);
    const validated = validateInput(MCPSettingsSchema, settings, "MCP settings") as MCPSettings;
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
    const validated = validateInput(MCPServerConfigSchema, serverConfig, "MCP server config");
    const { id: _id, ...configWithoutId } = validated;
    return MCPSettingsManager.addServer(configWithoutId as Omit<MCPServerConfig, "id">);
  });

  // Update a server
  ipcMain.handle(IPC_CHANNELS.MCP_UPDATE_SERVER, async (_, serverId: string, updates) => {
    const validatedId = validateInput(UUIDSchema, serverId, "server ID");
    const validatedUpdates = validateInput(
      MCPServerUpdateSchema,
      updates,
      "server updates",
    ) as Partial<MCPServerConfig>;
    return MCPSettingsManager.updateServer(validatedId, validatedUpdates);
  });

  // Remove a server
  ipcMain.handle(IPC_CHANNELS.MCP_REMOVE_SERVER, async (_, serverId: string) => {
    const validatedId = validateInput(UUIDSchema, serverId, "server ID");

    // Disconnect if connected
    try {
      await MCPClientManager.getInstance().disconnectServer(validatedId);
    } catch {
      // Ignore errors
    }

    return MCPSettingsManager.removeServer(validatedId);
  });

  // Connect to a server
  ipcMain.handle(IPC_CHANNELS.MCP_CONNECT_SERVER, async (_, serverId: string) => {
    checkRateLimit(IPC_CHANNELS.MCP_CONNECT_SERVER);
    const validatedId = validateInput(UUIDSchema, serverId, "server ID");
    await MCPClientManager.getInstance().connectServer(validatedId);
    return { success: true };
  });

  // Disconnect from a server
  ipcMain.handle(IPC_CHANNELS.MCP_DISCONNECT_SERVER, async (_, serverId: string) => {
    const validatedId = validateInput(UUIDSchema, serverId, "server ID");
    await MCPClientManager.getInstance().disconnectServer(validatedId);
    return { success: true };
  });

  // Get status of all servers
  ipcMain.handle(IPC_CHANNELS.MCP_GET_STATUS, async () => {
    return MCPClientManager.getInstance().getStatus();
  });

  // Get tools from a specific server
  ipcMain.handle(IPC_CHANNELS.MCP_GET_SERVER_TOOLS, async (_, serverId: string) => {
    const validatedId = validateInput(UUIDSchema, serverId, "server ID");
    return MCPClientManager.getInstance().getServerTools(validatedId);
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

  ipcMain.handle(IPC_CHANNELS.MCP_REGISTRY_INSTALL, async (_, entryId: string) => {
    checkRateLimit(IPC_CHANNELS.MCP_REGISTRY_INSTALL);
    const validatedId = validateInput(StringIdSchema, entryId, "registry entry ID");
    return MCPRegistryManager.installServer(validatedId);
  });

  ipcMain.handle(IPC_CHANNELS.MCP_REGISTRY_UNINSTALL, async (_, serverId: string) => {
    const validatedId = validateInput(UUIDSchema, serverId, "server ID");

    // Disconnect if connected
    try {
      await MCPClientManager.getInstance().disconnectServer(validatedId);
    } catch {
      // Ignore errors
    }

    await MCPRegistryManager.uninstallServer(validatedId);
  });

  ipcMain.handle(IPC_CHANNELS.MCP_REGISTRY_CHECK_UPDATES, async () => {
    return MCPRegistryManager.checkForUpdates();
  });

  ipcMain.handle(IPC_CHANNELS.MCP_REGISTRY_UPDATE_SERVER, async (_, serverId: string) => {
    const validatedId = validateInput(UUIDSchema, serverId, "server ID");
    return MCPRegistryManager.updateServer(validatedId);
  });

  // MCP Connector OAuth (Salesforce/Jira)
  ipcMain.handle(IPC_CHANNELS.MCP_CONNECTOR_OAUTH_START, async (_, payload) => {
    checkRateLimit(IPC_CHANNELS.MCP_CONNECTOR_OAUTH_START);
    const validated = validateInput(MCPConnectorOAuthSchema, payload, "connector oauth");
    return startConnectorOAuth(validated);
  });

  // MCP Host handlers
  ipcMain.handle(IPC_CHANNELS.MCP_HOST_START, async () => {
    const hostServer = MCPHostServer.getInstance();

    // If no tool provider is set, create a minimal one that exposes MCP tools
    // from connected servers (useful for tool aggregation/forwarding)
    if (!hostServer.hasToolProvider()) {
      const mcpClientManager = MCPClientManager.getInstance();

      // Create a minimal tool provider that exposes MCP tools
      hostServer.setToolProvider({
        getTools() {
          return mcpClientManager.getAllTools();
        },
        async executeTool(name: string, args: Record<string, any>) {
          return mcpClientManager.callTool(name, args);
        },
      });
    }

    await hostServer.startStdio();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.MCP_HOST_STOP, async () => {
    const hostServer = MCPHostServer.getInstance();
    await hostServer.stop();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.MCP_HOST_GET_STATUS, async () => {
    const hostServer = MCPHostServer.getInstance();
    return {
      running: hostServer.isRunning(),
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

  ipcMain.handle(IPC_CHANNELS.BUILTIN_TOOLS_SAVE_SETTINGS, async (_, settings) => {
    BuiltinToolsSettingsManager.saveSettings(settings);
    BuiltinToolsSettingsManager.clearCache(); // Clear cache to force reload
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.BUILTIN_TOOLS_GET_CATEGORIES, async () => {
    return BuiltinToolsSettingsManager.getToolsByCategory();
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
    return { success: true };
  });

  // =====================
  // Cron (Scheduled Tasks) Handlers
  // =====================
  setupCronHandlers();
}

/**
 * Set up Conway Terminal IPC handlers
 */
function setupConwayHandlers(): void {
  rateLimiter.configure(IPC_CHANNELS.CONWAY_SAVE_SETTINGS, RATE_LIMIT_CONFIGS.limited);
  rateLimiter.configure(IPC_CHANNELS.CONWAY_SETUP, RATE_LIMIT_CONFIGS.expensive);
  rateLimiter.configure(IPC_CHANNELS.CONWAY_CONNECT, RATE_LIMIT_CONFIGS.expensive);
  rateLimiter.configure(IPC_CHANNELS.CONWAY_DISCONNECT, RATE_LIMIT_CONFIGS.expensive);
  rateLimiter.configure(IPC_CHANNELS.CONWAY_RESET, RATE_LIMIT_CONFIGS.expensive);

  ipcMain.handle(IPC_CHANNELS.CONWAY_GET_STATUS, async () => {
    return ConwayManager.getInstance().getStatus();
  });

  ipcMain.handle(IPC_CHANNELS.CONWAY_GET_SETTINGS, async () => {
    return ConwaySettingsManager.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.CONWAY_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.CONWAY_SAVE_SETTINGS);
    const validated = validateInput(ConwaySettingsSchema, settings, "Conway settings");
    ConwaySettingsManager.saveSettings(validated);
    ConwaySettingsManager.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.CONWAY_SETUP, async () => {
    checkRateLimit(IPC_CHANNELS.CONWAY_SETUP);
    return ConwayManager.getInstance().setup();
  });

  ipcMain.handle(IPC_CHANNELS.CONWAY_GET_BALANCE, async () => {
    return ConwayManager.getInstance().getBalance();
  });

  ipcMain.handle(IPC_CHANNELS.CONWAY_GET_WALLET, async () => {
    return ConwayManager.getInstance().getWalletInfo();
  });

  ipcMain.handle(IPC_CHANNELS.CONWAY_GET_CREDIT_HISTORY, async () => {
    return ConwayManager.getInstance().getCreditHistory();
  });

  ipcMain.handle(IPC_CHANNELS.CONWAY_CONNECT, async () => {
    checkRateLimit(IPC_CHANNELS.CONWAY_CONNECT);
    await ConwayManager.getInstance().connect();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.CONWAY_DISCONNECT, async () => {
    checkRateLimit(IPC_CHANNELS.CONWAY_DISCONNECT);
    await ConwayManager.getInstance().disconnect();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.CONWAY_RESET, async () => {
    checkRateLimit(IPC_CHANNELS.CONWAY_RESET);
    await ConwayManager.getInstance().reset();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.CONWAY_WALLET_RESTORE, async () => {
    const success = ConwayWalletManager.restoreWalletFile();
    return { success, address: ConwayWalletManager.getAddress() || undefined };
  });

  ipcMain.handle(IPC_CHANNELS.CONWAY_WALLET_VERIFY, async () => {
    const status = ConwayWalletManager.verifyIntegrity();
    return { status, address: ConwayWalletManager.getAddress() || undefined };
  });
}

/**
 * Set up Cron (Scheduled Tasks) IPC handlers
 */
function setupCronHandlers(): void {
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
  ipcMain.handle(IPC_CHANNELS.CRON_LIST_JOBS, async (_, opts?: { includeDisabled?: boolean }) => {
    const service = getCronService();
    if (!service) return [];
    return service.list(opts);
  });

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
      return { ok: false, removed: false, error: "Cron service not initialized" };
    }
    return service.remove(id);
  });

  // Run a job immediately
  ipcMain.handle(IPC_CHANNELS.CRON_RUN_JOB, async (_, id: string, mode?: "due" | "force") => {
    const service = getCronService();
    if (!service) {
      return { ok: false, error: "Cron service not initialized" };
    }
    return service.run(id, mode);
  });

  // Get run history for a job
  ipcMain.handle("cron:getRunHistory", async (_, id: string) => {
    const service = getCronService();
    if (!service) return null;
    return service.getRunHistory(id);
  });

  // Clear run history for a job
  ipcMain.handle("cron:clearRunHistory", async (_, id: string) => {
    const service = getCronService();
    if (!service) return false;
    return service.clearRunHistory(id);
  });

  // Get webhook status
  ipcMain.handle("cron:getWebhookStatus", async () => {
    const service = getCronService();
    if (!service) return { enabled: false };
    const status = await service.status();
    return status.webhook ?? { enabled: false };
  });
}

/**
 * Set up Notification IPC handlers
 */
function setupNotificationHandlers(): void {
  // Initialize notification service with event forwarding to main window
  notificationService = new NotificationService({
    onEvent: (event) => {
      // Forward notification events to renderer
      // We need to import BrowserWindow from electron to send to all windows
      const { BrowserWindow } = require("electron");
      const windows = BrowserWindow.getAllWindows();
      for (const win of windows) {
        if (win.webContents) {
          win.webContents.send(IPC_CHANNELS.NOTIFICATION_EVENT, event);
        }
      }
    },
  });

  console.log("[Notifications] Service initialized");

  // List all notifications
  ipcMain.handle(IPC_CHANNELS.NOTIFICATION_LIST, async () => {
    if (!notificationService) return [];
    return notificationService.list();
  });

  // Get unread count
  ipcMain.handle("notification:unreadCount", async () => {
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

/**
 * Get the hooks server instance
 */
export function getHooksServer(): HooksServer | null {
  return hooksServer;
}

/**
 * Set up Hooks (Webhooks & Gmail Pub/Sub) IPC handlers
 */
async function setupHooksHandlers(agentDaemon: AgentDaemon): Promise<void> {
  const db = agentDaemon.getDatabase();
  const workspaceRepo = new WorkspaceRepository(db);
  const tempWorkspaceRoot = path.join(os.tmpdir(), TEMP_WORKSPACE_ROOT_DIR_NAME);

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

  const createTempWorkspaceForHooks = async (): Promise<Workspace> => {
    await fs.mkdir(tempWorkspaceRoot, { recursive: true });

    const key = `hooks-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
    const workspaceId = `${TEMP_WORKSPACE_ID_PREFIX}${key}`;
    const workspacePath = path.join(tempWorkspaceRoot, key);
    await fs.mkdir(workspacePath, { recursive: true });

    const now = Date.now();
    const permissions: Workspace["permissions"] = {
      read: true,
      write: true,
      delete: true,
      network: true,
      shell: false,
      unrestrictedFileAccess: true,
    };

    db.prepare(`
      INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        name = excluded.name,
        path = excluded.path,
        last_used_at = excluded.last_used_at,
        permissions = excluded.permissions
    `).run(workspaceId, TEMP_WORKSPACE_NAME, workspacePath, now, now, JSON.stringify(permissions));

    const workspace = workspaceRepo.findById(workspaceId) ?? {
      id: workspaceId,
      name: TEMP_WORKSPACE_NAME,
      path: workspacePath,
      createdAt: now,
      lastUsedAt: now,
      permissions,
      isTemp: true,
    };

    try {
      pruneTempWorkspaces({
        db,
        tempWorkspaceRoot,
        currentWorkspaceId: workspace.id,
      });
    } catch (error) {
      console.warn("[Hooks] Failed to prune temp workspaces:", error);
    }

    return workspace;
  };

  const ensureHooksServerRunning = async (): Promise<void> => {
    const settings = getHooksRuntimeSettings();

    if (!settings.enabled) return;

    if (!settings.token?.trim()) {
      // Auto-generate a token if hooks are enabled but token is missing
      // (e.g. migrated from legacy settings without a token)
      const token = HooksSettingsManager.regenerateToken();
      settings.token = token;
      console.log("[Hooks] Auto-generated missing token for enabled hooks server");
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
        console.log("[Hooks] Agent action:", action.message.substring(0, 100));

        // Create a task for the agent action
        const fallbackWorkspace = await createTempWorkspaceForHooks();
        const task = await agentDaemon.createTask({
          title: action.name || "Webhook Task",
          prompt: action.message,
          workspaceId: action.workspaceId || fallbackWorkspace.id,
          agentConfig: {
            allowUserInput: false,
          },
        });

        return { taskId: task.id };
      },
      onTaskMessage: async (action) => {
        console.log("[Hooks] Task message:", action.taskId);
        // Don't block the webhook call until the whole follow-up run completes.
        // We only validate that the task exists; execution happens asynchronously.
        const task = agentDaemon.getTask(action.taskId);
        if (!task) {
          const err: any = new Error(`Task ${action.taskId} not found`);
          err.statusCode = 404;
          throw err;
        }
        void agentDaemon.sendMessage(action.taskId, action.message).catch((err) => {
          console.error("[Hooks] Failed to process task message:", err);
        });
      },
      onApprovalRespond: async (action) => {
        console.log(
          "[Hooks] Approval respond:",
          action.approvalId,
          action.approved ? "approve" : "deny",
        );
        return agentDaemon.respondToApproval(action.approvalId, action.approved);
      },
      onEvent: (event) => {
        console.log("[Hooks] Server event:", event.action);
        // Forward events to renderer (with error handling for destroyed windows)
        const windows = BrowserWindow.getAllWindows();
        for (const win of windows) {
          try {
            if (win.webContents && !win.isDestroyed()) {
              win.webContents.send(IPC_CHANNELS.HOOKS_EVENT, event);
            }
          } catch (err) {
            // Window may have been destroyed between check and send
            console.warn("[Hooks] Failed to send event to window:", err);
          }
        }
      },
    });

    try {
      await server.start();
      hooksServer = server;
    } catch (err) {
      console.error("[Hooks] Failed to start hooks server:", err);
      throw new Error(
        `Failed to start hooks server: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      hooksServerStarting = false;
    }
  };

  // Get hooks settings
  ipcMain.handle(IPC_CHANNELS.HOOKS_GET_SETTINGS, async (): Promise<HooksSettingsData> => {
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
  });

  // Save hooks settings
  ipcMain.handle(IPC_CHANNELS.HOOKS_SAVE_SETTINGS, async (_, data: Partial<HooksSettingsData>) => {
    checkRateLimit(IPC_CHANNELS.HOOKS_SAVE_SETTINGS, RATE_LIMIT_CONFIGS.limited);

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
              : (data.resend.webhookSecret ?? currentSettings.resend?.webhookSecret),
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
  });

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
          console.warn("[Hooks] Gmail watcher not started:", result.reason);
        }
      } catch (err) {
        gmailWatcherError = err instanceof Error ? err.message : String(err);
        console.error("[Hooks] Failed to start Gmail watcher:", err);
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
    checkRateLimit(IPC_CHANNELS.HOOKS_REGENERATE_TOKEN, RATE_LIMIT_CONFIGS.limited);
    const newToken = HooksSettingsManager.regenerateToken();

    // Update the running server with new token
    if (hooksServer) {
      const settings = HooksSettingsManager.loadSettings();
      hooksServer.setHooksConfig(settings);
    }

    return { token: newToken };
  });

  // Get hooks status
  ipcMain.handle(IPC_CHANNELS.HOOKS_GET_STATUS, async (): Promise<HooksStatus> => {
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
  });

  // Auto-start the server on boot if hooks are enabled.
  // This avoids "hooks enabled but nothing listens" after app restarts.
  try {
    await ensureHooksServerRunning();

    // Auto-start Gmail watcher if configured (best-effort).
    const settings = getHooksRuntimeSettings();
    if (settings.enabled && settings.gmail?.account && !isGmailWatcherRunning()) {
      const result = await startGmailWatcher(settings);
      if (!result.started) {
        console.warn("[Hooks] Gmail watcher not started:", result.reason);
      }
    }
  } catch (err) {
    console.error("[Hooks] Auto-start failed:", err);
    // Non-fatal: user can still start it manually from Settings.
  }

  // Add a hook mapping
  ipcMain.handle(IPC_CHANNELS.HOOKS_ADD_MAPPING, async (_, mapping: HookMappingData) => {
    checkRateLimit(IPC_CHANNELS.HOOKS_ADD_MAPPING, RATE_LIMIT_CONFIGS.limited);

    // Validate the mapping input
    const validated = validateInput(HookMappingSchema, mapping, "hook mapping");

    const settings = HooksSettingsManager.addMapping(validated);

    // Update the server config if running
    if (hooksServer) {
      hooksServer.setHooksConfig(settings);
    }

    return { ok: true };
  });

  // Remove a hook mapping
  ipcMain.handle(IPC_CHANNELS.HOOKS_REMOVE_MAPPING, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.HOOKS_REMOVE_MAPPING, RATE_LIMIT_CONFIGS.limited);

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
  ipcMain.handle(IPC_CHANNELS.HOOKS_CONFIGURE_GMAIL, async (_, config: GmailHooksSettingsData) => {
    checkRateLimit(IPC_CHANNELS.HOOKS_CONFIGURE_GMAIL, RATE_LIMIT_CONFIGS.limited);

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
  });

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
    checkRateLimit(IPC_CHANNELS.HOOKS_START_GMAIL_WATCHER, RATE_LIMIT_CONFIGS.expensive);

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
    checkRateLimit(IPC_CHANNELS.HOOKS_STOP_GMAIL_WATCHER, RATE_LIMIT_CONFIGS.limited);
    await stopGmailWatcher();
    return { ok: true };
  });

  console.log("[Hooks] IPC handlers initialized");
}

/**
 * Broadcast personality settings changed event to all renderer windows.
 * This allows the UI to stay in sync when settings are changed via tools.
 */
function broadcastPersonalitySettingsChanged(settings: any): void {
  try {
    const windows = BrowserWindow.getAllWindows();
    for (const win of windows) {
      try {
        if (win.webContents && !win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.PERSONALITY_SETTINGS_CHANGED, settings);
        }
      } catch (err) {
        // Window may have been destroyed between check and send
        console.warn("[Personality] Failed to send settings changed event to window:", err);
      }
    }
  } catch (err) {
    console.error("[Personality] Failed to broadcast settings changed:", err);
  }
}

/**
 * Set up Workspace Kit (.cowork) IPC handlers
 */
function setupKitHandlers(workspaceRepo: WorkspaceRepository): void {
  const kitDirName = ".cowork";

  const getLocalDateStamp = (now: Date): string => {
    const yyyy = String(now.getFullYear());
    const mm = String(now.getMonth() + 1).padStart(2, "0");
    const dd = String(now.getDate()).padStart(2, "0");
    return `${yyyy}-${mm}-${dd}`;
  };

  const getWorkspacePath = (workspaceId: string): string => {
    const ws = workspaceRepo.findById(workspaceId);
    if (!ws) throw new Error("Workspace not found");
    if (!ws.path) throw new Error("Workspace path not set");
    return ws.path;
  };

  const computeStatus = async (workspaceId: string): Promise<WorkspaceKitStatus> => {
    const workspacePath = getWorkspacePath(workspaceId);
    const kitRoot = path.join(workspacePath, kitDirName);

    const required: string[] = [
      path.join(kitDirName, "AGENTS.md"),
      path.join(kitDirName, "MEMORY.md"),
      path.join(kitDirName, "USER.md"),
      path.join(kitDirName, "SOUL.md"),
      path.join(kitDirName, "IDENTITY.md"),
      path.join(kitDirName, "TOOLS.md"),
      path.join(kitDirName, "HEARTBEAT.md"),
      path.join(kitDirName, "PRIORITIES.md"),
      path.join(kitDirName, "CROSS_SIGNALS.md"),
      path.join(kitDirName, "MISTAKES.md"),
      path.join(kitDirName, "memory"),
      path.join(kitDirName, "memory", "hourly"),
      path.join(kitDirName, "memory", "weekly"),
      path.join(kitDirName, "projects"),
      path.join(kitDirName, "agents"),
    ];

    const hasKitDir = (() => {
      try {
        return fsSync.existsSync(kitRoot);
      } catch {
        return false;
      }
    })();

    const files: WorkspaceKitStatus["files"] = [];
    let missingCount = 0;

    for (const relPath of required) {
      const absPath = path.join(workspacePath, relPath);
      try {
        const stat = await fs.stat(absPath);
        files.push({
          relPath,
          exists: true,
          sizeBytes: stat.isFile() ? stat.size : undefined,
          modifiedAt: stat.mtimeMs,
        });
      } catch {
        missingCount += 1;
        files.push({ relPath, exists: false });
      }
    }

    return { workspaceId, workspacePath, hasKitDir, files, missingCount };
  };

  const templatesForInit = (now: Date): Array<{ relPath: string; content: string }> => {
    const stamp = getLocalDateStamp(now);
    return [
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
          `# Workspace-local tool policy hook\n` + `# Default: allow.\n` + `{"decision": "pass"}\n`,
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
          `## Daily\n` +
          `- Review open loops and next actions\n` +
          `- Summarize key decisions into .cowork/MEMORY.md\n\n` +
          `## Weekly\n` +
          `- Review team performance and update autonomy levels if needed\n`,
      },
      {
        relPath: path.join(kitDirName, "PRIORITIES.md"),
        content:
          `# Priorities\n\n` +
          `## Current\n` +
          `1. \n` +
          `2. \n` +
          `3. \n\n` +
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
      const existingInWorkspace = existing.filter((j) => j.workspaceId === workspaceId);

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
          (j) => typeof j.description === "string" && j.description.includes(marker),
        ) ?? existingInWorkspace.find((j) => j.name === name);

      for (const spec of desired) {
        const existingJob = findJob(spec.job.name, spec.marker);
        if (!existingJob) {
          const res = await cron.add(spec.job);
          if (!res.ok) {
            console.warn("[Kit] Failed to add scheduled job:", spec.job.name, res.error);
          }
          continue;
        }

        // Update kit-managed job prompts/description. Preserve schedule/enabled in "missing" mode.
        const patch: any = {
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
          if ((existingJob.description || "") !== (patch.description || "")) return true;
          if (existingJob.taskPrompt !== patch.taskPrompt) return true;
          if ((existingJob.taskTitle || "") !== (patch.taskTitle || "")) return true;
          if ((existingJob.maxHistoryEntries || 0) !== (patch.maxHistoryEntries || 0)) return true;
          if (kitMode === "overwrite") {
            if (existingJob.enabled !== patch.enabled) return true;
            if (JSON.stringify(existingJob.schedule) !== JSON.stringify(patch.schedule))
              return true;
          }
          return false;
        })();

        if (!needsUpdate) continue;

        const res = await cron.update(existingJob.id, patch);
        if (!res.ok) {
          console.warn("[Kit] Failed to update scheduled job:", spec.job.name, res.error);
        }
      }
    } catch (error) {
      console.warn("[Kit] Failed to ensure default scheduled jobs:", error);
    }
  };

  ipcMain.handle(IPC_CHANNELS.KIT_GET_STATUS, async (_event, workspaceId: string) => {
    try {
      return await computeStatus(workspaceId);
    } catch (error: any) {
      return {
        workspaceId,
        hasKitDir: false,
        files: [],
        missingCount: 0,
        error: error?.message || "Failed to load kit status",
      } as any;
    }
  });

  ipcMain.handle(IPC_CHANNELS.KIT_INIT, async (_event, request: WorkspaceKitInitRequest) => {
    checkRateLimit(IPC_CHANNELS.KIT_INIT, RATE_LIMIT_CONFIGS.limited);
    const mode = request?.mode === "overwrite" ? "overwrite" : "missing";
    const workspacePath = getWorkspacePath(request.workspaceId);

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
    const templates = templatesForInit(now);
    for (const t of templates) {
      await writeTemplate(workspacePath, t.relPath, t.content, mode);
    }

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
  });

  ipcMain.handle(
    IPC_CHANNELS.KIT_PROJECT_CREATE,
    async (_event, request: WorkspaceKitProjectCreateRequest) => {
      checkRateLimit(IPC_CHANNELS.KIT_PROJECT_CREATE, RATE_LIMIT_CONFIGS.limited);
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

      await writeTemplate(
        workspacePath,
        path.join(projectRootRel, "ACCESS.md"),
        `# Access\n\n## Allow\n- all\n\n## Deny\n- \n`,
        "missing",
      );
      await writeTemplate(
        workspacePath,
        path.join(projectRootRel, "CONTEXT.md"),
        `# Context\n\nLast updated by:\n\n## Goals\n\n## Constraints\n\n## Decisions\n\n## Notes\n`,
        "missing",
      );

      return { success: true, projectId: rawId };
    },
  );
}

/**
 * Set up Memory System IPC handlers
 */
function setupMemoryHandlers(): void {
  // Get memory settings for a workspace
  ipcMain.handle(IPC_CHANNELS.MEMORY_GET_SETTINGS, async (_, workspaceId: string) => {
    try {
      return MemoryService.getSettings(workspaceId);
    } catch (error) {
      console.error("[Memory] Failed to get settings:", error);
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
  });

  // Save memory settings for a workspace
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_SAVE_SETTINGS,
    async (_, data: { workspaceId: string; settings: Partial<MemorySettings> }) => {
      checkRateLimit(IPC_CHANNELS.MEMORY_SAVE_SETTINGS, RATE_LIMIT_CONFIGS.limited);
      try {
        MemoryService.updateSettings(data.workspaceId, data.settings);
        return { success: true };
      } catch (error) {
        console.error("[Memory] Failed to save settings:", error);
        throw error;
      }
    },
  );

  // Get global memory feature toggles
  ipcMain.handle(IPC_CHANNELS.MEMORY_FEATURES_GET_SETTINGS, async () => {
    try {
      return MemoryFeaturesManager.loadSettings();
    } catch (error) {
      console.error("[MemoryFeatures] Failed to get settings:", error);
      return {
        contextPackInjectionEnabled: true,
        heartbeatMaintenanceEnabled: true,
      };
    }
  });

  // Save global memory feature toggles
  ipcMain.handle(IPC_CHANNELS.MEMORY_FEATURES_SAVE_SETTINGS, async (_event, settings: any) => {
    checkRateLimit(IPC_CHANNELS.MEMORY_FEATURES_SAVE_SETTINGS, RATE_LIMIT_CONFIGS.limited);
    try {
      MemoryFeaturesManager.saveSettings(settings);
      return { success: true };
    } catch (error) {
      console.error("[MemoryFeatures] Failed to save settings:", error);
      throw error;
    }
  });

  // Search memories
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_SEARCH,
    async (_, data: { workspaceId: string; query: string; limit?: number }) => {
      try {
        return MemoryService.search(data.workspaceId, data.query, data.limit);
      } catch (error) {
        console.error("[Memory] Failed to search:", error);
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
        console.error("[Memory] Failed to get timeline:", error);
        return [];
      }
    },
  );

  // Get full details (Layer 3)
  ipcMain.handle(IPC_CHANNELS.MEMORY_GET_DETAILS, async (_, ids: string[]) => {
    try {
      return MemoryService.getFullDetails(ids);
    } catch (error) {
      console.error("[Memory] Failed to get details:", error);
      return [];
    }
  });

  // Get recent memories
  ipcMain.handle(
    IPC_CHANNELS.MEMORY_GET_RECENT,
    async (_, data: { workspaceId: string; limit?: number }) => {
      try {
        return MemoryService.getRecent(data.workspaceId, data.limit);
      } catch (error) {
        console.error("[Memory] Failed to get recent:", error);
        return [];
      }
    },
  );

  // Get memory statistics
  ipcMain.handle(IPC_CHANNELS.MEMORY_GET_STATS, async (_, workspaceId: string) => {
    try {
      return MemoryService.getStats(workspaceId);
    } catch (error) {
      console.error("[Memory] Failed to get stats:", error);
      return { count: 0, totalTokens: 0, compressedCount: 0, compressionRatio: 0 };
    }
  });

  // Clear all memories for a workspace
  ipcMain.handle(IPC_CHANNELS.MEMORY_CLEAR, async (_, workspaceId: string) => {
    checkRateLimit(IPC_CHANNELS.MEMORY_CLEAR, RATE_LIMIT_CONFIGS.limited);
    try {
      MemoryService.clearWorkspace(workspaceId);
      return { success: true };
    } catch (error) {
      console.error("[Memory] Failed to clear:", error);
      throw error;
    }
  });

  // Get imported ChatGPT memory stats
  ipcMain.handle(IPC_CHANNELS.MEMORY_GET_IMPORTED_STATS, async (_, workspaceId: string) => {
    try {
      return MemoryService.getImportedStats(workspaceId);
    } catch (error) {
      console.error("[Memory] Failed to get imported stats:", error);
      return { count: 0, totalTokens: 0 };
    }
  });

  // Find imported ChatGPT memories with pagination
  ipcMain.handle(IPC_CHANNELS.MEMORY_FIND_IMPORTED, async (_, data: unknown) => {
    const validated = validateInput(FindImportedSchema, data, "find imported memories");
    try {
      return MemoryService.findImported(validated.workspaceId, validated.limit, validated.offset);
    } catch (error) {
      console.error("[Memory] Failed to find imported:", error);
      return [];
    }
  });

  // Delete all imported ChatGPT memories
  ipcMain.handle(IPC_CHANNELS.MEMORY_DELETE_IMPORTED, async (_, workspaceId: string) => {
    checkRateLimit(IPC_CHANNELS.MEMORY_DELETE_IMPORTED, RATE_LIMIT_CONFIGS.limited);
    try {
      const deleted = MemoryService.deleteImported(workspaceId);
      return { success: true, deleted };
    } catch (error) {
      console.error("[Memory] Failed to delete imported:", error);
      throw error;
    }
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_GET_USER_PROFILE, async () => {
    try {
      return UserProfileService.getProfile();
    } catch (error) {
      console.error("[Memory] Failed to get user profile:", error);
      return { facts: [], updatedAt: Date.now() };
    }
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_ADD_USER_FACT, async (_, request: AddUserFactRequest) => {
    checkRateLimit(IPC_CHANNELS.MEMORY_ADD_USER_FACT, RATE_LIMIT_CONFIGS.limited);
    try {
      return UserProfileService.addFact(request);
    } catch (error) {
      console.error("[Memory] Failed to add user fact:", error);
      throw error;
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_UPDATE_USER_FACT,
    async (_, request: UpdateUserFactRequest) => {
      checkRateLimit(IPC_CHANNELS.MEMORY_UPDATE_USER_FACT, RATE_LIMIT_CONFIGS.limited);
      try {
        return UserProfileService.updateFact(request);
      } catch (error) {
        console.error("[Memory] Failed to update user fact:", error);
        throw error;
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.MEMORY_DELETE_USER_FACT, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.MEMORY_DELETE_USER_FACT, RATE_LIMIT_CONFIGS.limited);
    try {
      return { success: UserProfileService.deleteFact(id) };
    } catch (error) {
      console.error("[Memory] Failed to delete user fact:", error);
      throw error;
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_RELATIONSHIP_LIST,
    async (
      _,
      data?: {
        layer?: "identity" | "preferences" | "context" | "history" | "commitments";
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
        console.error("[Memory] Failed to list relationship memory:", error);
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
      checkRateLimit(IPC_CHANNELS.MEMORY_RELATIONSHIP_UPDATE, RATE_LIMIT_CONFIGS.limited);
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
        console.error("[Memory] Failed to update relationship memory:", error);
        throw error;
      }
    },
  );

  ipcMain.handle(IPC_CHANNELS.MEMORY_RELATIONSHIP_DELETE, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.MEMORY_RELATIONSHIP_DELETE, RATE_LIMIT_CONFIGS.limited);
    try {
      if (!id || typeof id !== "string") {
        throw new Error("id is required");
      }
      return { success: RelationshipMemoryService.deleteItem(id) };
    } catch (error) {
      console.error("[Memory] Failed to delete relationship memory item:", error);
      throw error;
    }
  });

  ipcMain.handle(IPC_CHANNELS.MEMORY_COMMITMENTS_GET, async (_, data?: { limit?: number }) => {
    try {
      const limit =
        typeof data?.limit === "number" && Number.isFinite(data.limit) ? data.limit : 25;
      return RelationshipMemoryService.listOpenCommitments(limit);
    } catch (error) {
      console.error("[Memory] Failed to list open commitments:", error);
      return [];
    }
  });

  ipcMain.handle(
    IPC_CHANNELS.MEMORY_COMMITMENTS_DUE_SOON,
    async (_, data?: { windowHours?: number }) => {
      try {
        const windowHours =
          typeof data?.windowHours === "number" && Number.isFinite(data.windowHours)
            ? data.windowHours
            : 72;
        const items = RelationshipMemoryService.listDueSoonCommitments(windowHours);
        const reminderText =
          items.length > 0
            ? `You have ${items.length} commitment(s) due soon.`
            : "No commitments due soon.";
        return { items, reminderText };
      } catch (error) {
        console.error("[Memory] Failed to list due soon commitments:", error);
        return { items: [], reminderText: "No commitments due soon." };
      }
    },
  );

  // ChatGPT Import handler
  let activeImportAbort: AbortController | null = null;
  ipcMain.handle(IPC_CHANNELS.MEMORY_IMPORT_CHATGPT, async (event, options: unknown) => {
    checkRateLimit(IPC_CHANNELS.MEMORY_IMPORT_CHATGPT, RATE_LIMIT_CONFIGS.limited);
    const validated = validateInput(ChatGPTImportSchema, options, "ChatGPT import");
    try {
      const { ChatGPTImporter } = await import("../memory/ChatGPTImporter");

      // Create an abort controller for cancellation
      activeImportAbort = new AbortController();

      // Forward progress events to renderer
      const unsubscribe = ChatGPTImporter.onProgress((progress) => {
        const win = BrowserWindow.fromWebContents(event.sender);
        if (win && !win.isDestroyed()) {
          win.webContents.send(IPC_CHANNELS.MEMORY_IMPORT_CHATGPT_PROGRESS, progress);
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
      console.error("[Memory] ChatGPT import failed:", error);
      throw error;
    }
  });

  // ChatGPT Import cancel handler
  ipcMain.handle(IPC_CHANNELS.MEMORY_IMPORT_CHATGPT_CANCEL, async () => {
    if (activeImportAbort) {
      activeImportAbort.abort();
      return { cancelled: true };
    }
    return { cancelled: false };
  });

  console.log("[Memory] Handlers initialized");

  // === Migration Status Handlers ===
  // These handlers help show one-time notifications after app migration (cowork-oss → cowork-os)

  const userDataPath = getUserDataDir();
  const migrationMarkerPath = path.join(userDataPath, ".migrated-from-cowork-oss");
  const notificationDismissedPath = path.join(userDataPath, ".migration-notification-dismissed");

  // Get migration status
  ipcMain.handle(IPC_CHANNELS.MIGRATION_GET_STATUS, async () => {
    try {
      const migrated = fsSync.existsSync(migrationMarkerPath);
      const notificationDismissed = fsSync.existsSync(notificationDismissedPath);

      let timestamp: string | undefined;
      if (migrated) {
        try {
          const markerContent = fsSync.readFileSync(migrationMarkerPath, "utf-8");
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
      console.error("[Migration] Failed to get status:", error);
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
      console.log("[Migration] Notification dismissed");
      return { success: true };
    } catch (error) {
      console.error("[Migration] Failed to dismiss notification:", error);
      throw error;
    }
  });

  console.log("[Migration] Handlers initialized");

  // === Extension / Plugin Handlers ===
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { getPluginRegistry } = require("../extensions/registry");

  // List all extensions
  ipcMain.handle(IPC_CHANNELS.EXTENSIONS_LIST, async () => {
    try {
      const registry = getPluginRegistry();
      const plugins = registry.getPlugins();
      return plugins.map((p: any) => ({
        name: p.manifest.name,
        displayName: p.manifest.displayName,
        version: p.manifest.version,
        description: p.manifest.description,
        author: p.manifest.author,
        type: p.manifest.type,
        state: p.state,
        path: p.path,
        loadedAt: p.loadedAt.getTime(),
        error: p.error?.message,
        capabilities: p.manifest.capabilities,
        configSchema: p.manifest.configSchema,
      }));
    } catch (error) {
      console.error("[Extensions] Failed to list:", error);
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
        author: plugin.manifest.author,
        type: plugin.manifest.type,
        state: plugin.state,
        path: plugin.path,
        loadedAt: plugin.loadedAt.getTime(),
        error: plugin.error?.message,
        capabilities: plugin.manifest.capabilities,
        configSchema: plugin.manifest.configSchema,
      };
    } catch (error) {
      console.error("[Extensions] Failed to get:", error);
      return null;
    }
  });

  // Enable extension
  ipcMain.handle(IPC_CHANNELS.EXTENSIONS_ENABLE, async (_, name: string) => {
    try {
      const registry = getPluginRegistry();
      await registry.enablePlugin(name);
      return { success: true };
    } catch (error: any) {
      console.error("[Extensions] Failed to enable:", error);
      return { success: false, error: error.message };
    }
  });

  // Disable extension
  ipcMain.handle(IPC_CHANNELS.EXTENSIONS_DISABLE, async (_, name: string) => {
    try {
      const registry = getPluginRegistry();
      await registry.disablePlugin(name);
      return { success: true };
    } catch (error: any) {
      console.error("[Extensions] Failed to disable:", error);
      return { success: false, error: error.message };
    }
  });

  // Reload extension
  ipcMain.handle(IPC_CHANNELS.EXTENSIONS_RELOAD, async (_, name: string) => {
    try {
      const registry = getPluginRegistry();
      await registry.reloadPlugin(name);
      return { success: true };
    } catch (error: any) {
      console.error("[Extensions] Failed to reload:", error);
      return { success: false, error: error.message };
    }
  });

  // Get extension config
  ipcMain.handle(IPC_CHANNELS.EXTENSIONS_GET_CONFIG, async (_, name: string) => {
    try {
      const registry = getPluginRegistry();
      return registry.getPluginConfig(name) || {};
    } catch (error) {
      console.error("[Extensions] Failed to get config:", error);
      return {};
    }
  });

  // Set extension config
  ipcMain.handle(
    IPC_CHANNELS.EXTENSIONS_SET_CONFIG,
    async (_, data: { name: string; config: Record<string, unknown> }) => {
      try {
        const registry = getPluginRegistry();
        await registry.setPluginConfig(data.name, data.config);
        return { success: true };
      } catch (error: any) {
        console.error("[Extensions] Failed to set config:", error);
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
      return plugins.map((p: any) => ({
        name: p.manifest.name,
        displayName: p.manifest.displayName,
        version: p.manifest.version,
        description: p.manifest.description,
        type: p.manifest.type,
        state: p.state,
      }));
    } catch (error) {
      console.error("[Extensions] Failed to discover:", error);
      return [];
    }
  });

  console.log("[Extensions] Handlers initialized");

  // === Webhook Tunnel Handlers ===
  let tunnelManager: any = null;

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
      console.error("[Tunnel] Failed to get status:", error);
      return { status: "stopped" };
    }
  });

  // Start tunnel
  ipcMain.handle(IPC_CHANNELS.TUNNEL_START, async (_, config: any) => {
    try {
      const { TunnelManager } = await import("../gateway/tunnel");
      if (tunnelManager) {
        await tunnelManager.stop();
      }
      tunnelManager = new TunnelManager(config);
      const url = await tunnelManager.start();
      return { success: true, url };
    } catch (error: any) {
      console.error("[Tunnel] Failed to start:", error);
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
    } catch (error: any) {
      console.error("[Tunnel] Failed to stop:", error);
      return { success: false, error: error.message };
    }
  });

  console.log("[Tunnel] Handlers initialized");

  // === Voice Mode Handlers ===

  // Initialize voice settings manager with secure database storage
  const voiceDb = DatabaseManager.getInstance().getDatabase();
  VoiceSettingsManager.initialize(voiceDb);

  // Get voice settings
  ipcMain.handle(IPC_CHANNELS.VOICE_GET_SETTINGS, async () => {
    try {
      return VoiceSettingsManager.loadSettings();
    } catch (error) {
      console.error("[Voice] Failed to get settings:", error);
      throw error;
    }
  });

  // Save voice settings
  ipcMain.handle(IPC_CHANNELS.VOICE_SAVE_SETTINGS, async (_, settings: any) => {
    try {
      const updated = VoiceSettingsManager.updateSettings(settings);
      // Update the voice service with new settings
      const voiceService = getVoiceService();
      voiceService.updateSettings(updated);
      return updated;
    } catch (error) {
      console.error("[Voice] Failed to save settings:", error);
      throw error;
    }
  });

  // Get voice state
  ipcMain.handle(IPC_CHANNELS.VOICE_GET_STATE, async () => {
    try {
      const voiceService = getVoiceService();
      return voiceService.getState();
    } catch (error) {
      console.error("[Voice] Failed to get state:", error);
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
    } catch (error: any) {
      console.error("[Voice] Failed to speak:", error);
      return { success: false, error: error.message, audioData: null };
    }
  });

  // Stop speaking
  ipcMain.handle(IPC_CHANNELS.VOICE_STOP_SPEAKING, async () => {
    try {
      const voiceService = getVoiceService();
      voiceService.stopSpeaking();
      return { success: true };
    } catch (error: any) {
      console.error("[Voice] Failed to stop speaking:", error);
      return { success: false, error: error.message };
    }
  });

  // Transcribe audio - accepts audio data as array from renderer
  ipcMain.handle(IPC_CHANNELS.VOICE_TRANSCRIBE, async (_, audioData: number[]) => {
    try {
      const voiceService = getVoiceService();
      // Convert array back to Buffer
      const audioBuffer = Buffer.from(audioData);
      const text = await voiceService.transcribe(audioBuffer);
      return { text };
    } catch (error: any) {
      console.error("[Voice] Failed to transcribe:", error);
      return { text: "", error: error.message };
    }
  });

  // Get ElevenLabs voices
  ipcMain.handle(IPC_CHANNELS.VOICE_GET_ELEVENLABS_VOICES, async () => {
    try {
      const voiceService = getVoiceService();
      return await voiceService.getElevenLabsVoices();
    } catch (error: any) {
      console.error("[Voice] Failed to get ElevenLabs voices:", error);
      return [];
    }
  });

  // Test ElevenLabs connection
  ipcMain.handle(IPC_CHANNELS.VOICE_TEST_ELEVENLABS, async () => {
    try {
      const voiceService = getVoiceService();
      return await voiceService.testElevenLabsConnection();
    } catch (error: any) {
      console.error("[Voice] Failed to test ElevenLabs:", error);
      return { success: false, error: error.message };
    }
  });

  // Test OpenAI voice connection
  ipcMain.handle(IPC_CHANNELS.VOICE_TEST_OPENAI, async () => {
    try {
      const voiceService = getVoiceService();
      return await voiceService.testOpenAIConnection();
    } catch (error: any) {
      console.error("[Voice] Failed to test OpenAI voice:", error);
      return { success: false, error: error.message };
    }
  });

  // Test Azure OpenAI voice connection
  ipcMain.handle(IPC_CHANNELS.VOICE_TEST_AZURE, async () => {
    try {
      const voiceService = getVoiceService();
      return await voiceService.testAzureConnection();
    } catch (error: any) {
      console.error("[Voice] Failed to test Azure OpenAI voice:", error);
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
    console.error("[Voice] Failed to initialize:", err);
  });

  console.log("[Voice] Handlers initialized");
}
