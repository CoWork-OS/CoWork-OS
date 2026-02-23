import * as path from "path";
import { contextBridge, ipcRenderer } from "electron";
import * as fs from "fs";
import * as os from "os";
import { randomBytes } from "crypto";
import type {
  AgentTeam,
  AgentTeamItem,
  AgentTeamMember,
  AgentTeamRun,
  AgentThought,
  AgentPerformanceReview,
  AgentReviewGenerateRequest,
  ConwayCreditHistoryEntry,
  ConwayCreditsBalance,
  ConwaySettings,
  ConwaySetupStatus,
  ConwayWalletInfo,
  CreateAgentTeamItemRequest,
  CreateAgentTeamMemberRequest,
  CreateAgentTeamRequest,
  CreateAgentTeamRunRequest,
  ImageAttachment,
  LLMProviderType,
  MemoryFeaturesSettings,
  WorkspaceKitInitRequest,
  WorkspaceKitProjectCreateRequest,
  WorkspaceKitStatus,
  UpdateAgentTeamItemRequest,
  UpdateAgentTeamMemberRequest,
  UpdateAgentTeamRequest,
  AddChannelRequest,
  Workspace,
} from "../shared/types";

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

// IPC Channel names - inlined to avoid require() issues in sandboxed preload
const IPC_CHANNELS = {
  TASK_CREATE: "task:create",
  TASK_GET: "task:get",
  TASK_LIST: "task:list",
  TASK_EXPORT_JSON: "task:exportJSON",
  TASK_PIN: "task:pin",
  TASK_CANCEL: "task:cancel",
  TASK_WRAP_UP: "task:wrapUp",
  TASK_PAUSE: "task:pause",
  TASK_RESUME: "task:resume",
  TASK_RENAME: "task:rename",
  TASK_DELETE: "task:delete",
  TASK_EVENT: "task:event",
  TASK_EVENTS: "task:events",
  TASK_SEND_MESSAGE: "task:sendMessage",
  TASK_SEND_STDIN: "task:sendStdin",
  TASK_KILL_COMMAND: "task:killCommand",
  WORKSPACE_SELECT: "workspace:select",
  WORKSPACE_LIST: "workspace:list",
  WORKSPACE_CREATE: "workspace:create",
  WORKSPACE_UPDATE_PERMISSIONS: "workspace:updatePermissions",
  WORKSPACE_TOUCH: "workspace:touch",
  WORKSPACE_GET_TEMP: "workspace:getTemp",
  APPROVAL_RESPOND: "approval:respond",
  APPROVAL_SESSION_AUTO_APPROVE_SET: "approval:sessionAutoApprove:set",
  APPROVAL_SESSION_AUTO_APPROVE_GET: "approval:sessionAutoApprove:get",
  ARTIFACT_LIST: "artifact:list",
  ARTIFACT_PREVIEW: "artifact:preview",
  SKILL_LIST: "skill:list",
  SKILL_GET: "skill:get",
  LLM_GET_SETTINGS: "llm:getSettings",
  LLM_SAVE_SETTINGS: "llm:saveSettings",
  LLM_TEST_PROVIDER: "llm:testProvider",
  LLM_GET_MODELS: "llm:getModels",
  LLM_GET_CONFIG_STATUS: "llm:getConfigStatus",
  LLM_SET_MODEL: "llm:setModel",
  LLM_GET_PROVIDER_MODELS: "llm:getProviderModels",
  LLM_GET_OLLAMA_MODELS: "llm:getOllamaModels",
  LLM_GET_GEMINI_MODELS: "llm:getGeminiModels",
  LLM_GET_OPENROUTER_MODELS: "llm:getOpenRouterModels",
  LLM_GET_OPENAI_MODELS: "llm:getOpenAIModels",
  LLM_GET_GROQ_MODELS: "llm:getGroqModels",
  LLM_GET_XAI_MODELS: "llm:getXAIModels",
  LLM_GET_KIMI_MODELS: "llm:getKimiModels",
  LLM_GET_PI_MODELS: "llm:getPiModels",
  LLM_GET_PI_PROVIDERS: "llm:getPiProviders",
  LLM_OPENAI_OAUTH_START: "llm:openaiOAuthStart",
  LLM_OPENAI_OAUTH_LOGOUT: "llm:openaiOAuthLogout",
  LLM_GET_BEDROCK_MODELS: "llm:getBedrockModels",
  // Gateway / Channels
  GATEWAY_GET_CHANNELS: "gateway:getChannels",
  GATEWAY_ADD_CHANNEL: "gateway:addChannel",
  GATEWAY_UPDATE_CHANNEL: "gateway:updateChannel",
  GATEWAY_REMOVE_CHANNEL: "gateway:removeChannel",
  GATEWAY_ENABLE_CHANNEL: "gateway:enableChannel",
  GATEWAY_DISABLE_CHANNEL: "gateway:disableChannel",
  GATEWAY_TEST_CHANNEL: "gateway:testChannel",
  GATEWAY_GET_USERS: "gateway:getUsers",
  GATEWAY_GRANT_ACCESS: "gateway:grantAccess",
  GATEWAY_REVOKE_ACCESS: "gateway:revokeAccess",
  GATEWAY_GENERATE_PAIRING: "gateway:generatePairing",
  // Search Settings
  SEARCH_GET_SETTINGS: "search:getSettings",
  SEARCH_SAVE_SETTINGS: "search:saveSettings",
  SEARCH_GET_CONFIG_STATUS: "search:getConfigStatus",
  SEARCH_TEST_PROVIDER: "search:testProvider",
  // X/Twitter Settings
  X_GET_SETTINGS: "x:getSettings",
  X_SAVE_SETTINGS: "x:saveSettings",
  X_TEST_CONNECTION: "x:testConnection",
  X_GET_STATUS: "x:getStatus",
  // Notion Settings
  NOTION_GET_SETTINGS: "notion:getSettings",
  NOTION_SAVE_SETTINGS: "notion:saveSettings",
  NOTION_TEST_CONNECTION: "notion:testConnection",
  NOTION_GET_STATUS: "notion:getStatus",
  // Box Settings
  BOX_GET_SETTINGS: "box:getSettings",
  BOX_SAVE_SETTINGS: "box:saveSettings",
  BOX_TEST_CONNECTION: "box:testConnection",
  BOX_GET_STATUS: "box:getStatus",
  // OneDrive Settings
  ONEDRIVE_GET_SETTINGS: "onedrive:getSettings",
  ONEDRIVE_SAVE_SETTINGS: "onedrive:saveSettings",
  ONEDRIVE_TEST_CONNECTION: "onedrive:testConnection",
  ONEDRIVE_GET_STATUS: "onedrive:getStatus",
  // Google Workspace Settings
  GOOGLE_WORKSPACE_GET_SETTINGS: "googleWorkspace:getSettings",
  GOOGLE_WORKSPACE_SAVE_SETTINGS: "googleWorkspace:saveSettings",
  GOOGLE_WORKSPACE_TEST_CONNECTION: "googleWorkspace:testConnection",
  GOOGLE_WORKSPACE_GET_STATUS: "googleWorkspace:getStatus",
  GOOGLE_WORKSPACE_OAUTH_START: "googleWorkspace:oauthStart",
  // Dropbox Settings
  DROPBOX_GET_SETTINGS: "dropbox:getSettings",
  DROPBOX_SAVE_SETTINGS: "dropbox:saveSettings",
  DROPBOX_TEST_CONNECTION: "dropbox:testConnection",
  DROPBOX_GET_STATUS: "dropbox:getStatus",
  // SharePoint Settings
  SHAREPOINT_GET_SETTINGS: "sharepoint:getSettings",
  SHAREPOINT_SAVE_SETTINGS: "sharepoint:saveSettings",
  SHAREPOINT_TEST_CONNECTION: "sharepoint:testConnection",
  SHAREPOINT_GET_STATUS: "sharepoint:getStatus",
  // App Updates
  APP_CHECK_UPDATES: "app:checkUpdates",
  APP_DOWNLOAD_UPDATE: "app:downloadUpdate",
  APP_INSTALL_UPDATE: "app:installUpdate",
  APP_GET_VERSION: "app:getVersion",
  APP_UPDATE_AVAILABLE: "app:updateAvailable",
  APP_UPDATE_PROGRESS: "app:updateProgress",
  APP_UPDATE_DOWNLOADED: "app:updateDownloaded",
  APP_UPDATE_ERROR: "app:updateError",
  SYSTEM_OPEN_SETTINGS: "system:openSettings",
  // Guardrails
  GUARDRAIL_GET_SETTINGS: "guardrail:getSettings",
  GUARDRAIL_SAVE_SETTINGS: "guardrail:saveSettings",
  GUARDRAIL_GET_DEFAULTS: "guardrail:getDefaults",
  // Appearance
  APPEARANCE_GET_SETTINGS: "appearance:getSettings",
  APPEARANCE_SAVE_SETTINGS: "appearance:saveSettings",
  // Agent Personality
  PERSONALITY_GET_SETTINGS: "personality:getSettings",
  PERSONALITY_SAVE_SETTINGS: "personality:saveSettings",
  PERSONALITY_GET_DEFINITIONS: "personality:getDefinitions",
  PERSONALITY_GET_PERSONAS: "personality:getPersonas",
  PERSONALITY_GET_RELATIONSHIP_STATS: "personality:getRelationshipStats",
  PERSONALITY_SET_ACTIVE: "personality:setActive",
  PERSONALITY_SET_PERSONA: "personality:setPersona",
  PERSONALITY_RESET: "personality:reset",
  PERSONALITY_SETTINGS_CHANGED: "personality:settingsChanged",
  // Task Queue
  QUEUE_GET_STATUS: "queue:getStatus",
  QUEUE_GET_SETTINGS: "queue:getSettings",
  QUEUE_SAVE_SETTINGS: "queue:saveSettings",
  QUEUE_CLEAR: "queue:clear",
  QUEUE_UPDATE: "queue:update",
  // Custom User Skills
  CUSTOM_SKILL_LIST: "customSkill:list",
  CUSTOM_SKILL_LIST_TASKS: "customSkill:listTasks",
  CUSTOM_SKILL_LIST_GUIDELINES: "customSkill:listGuidelines",
  CUSTOM_SKILL_GET: "customSkill:get",
  CUSTOM_SKILL_CREATE: "customSkill:create",
  CUSTOM_SKILL_UPDATE: "customSkill:update",
  CUSTOM_SKILL_DELETE: "customSkill:delete",
  CUSTOM_SKILL_RELOAD: "customSkill:reload",
  CUSTOM_SKILL_OPEN_FOLDER: "customSkill:openFolder",
  // Skill Registry (SkillHub)
  SKILL_REGISTRY_SEARCH: "skillRegistry:search",
  SKILL_REGISTRY_GET_DETAILS: "skillRegistry:getDetails",
  SKILL_REGISTRY_INSTALL: "skillRegistry:install",
  SKILL_REGISTRY_UPDATE: "skillRegistry:update",
  SKILL_REGISTRY_UPDATE_ALL: "skillRegistry:updateAll",
  SKILL_REGISTRY_UNINSTALL: "skillRegistry:uninstall",
  SKILL_REGISTRY_LIST_MANAGED: "skillRegistry:listManaged",
  SKILL_REGISTRY_CHECK_UPDATES: "skillRegistry:checkUpdates",
  SKILL_REGISTRY_GET_STATUS: "skillRegistry:getStatus",
  SKILL_REGISTRY_GET_ELIGIBLE: "skillRegistry:getEligible",
  // MCP (Model Context Protocol)
  MCP_GET_SETTINGS: "mcp:getSettings",
  MCP_SAVE_SETTINGS: "mcp:saveSettings",
  MCP_ADD_SERVER: "mcp:addServer",
  MCP_UPDATE_SERVER: "mcp:updateServer",
  MCP_REMOVE_SERVER: "mcp:removeServer",
  MCP_CONNECT_SERVER: "mcp:connectServer",
  MCP_DISCONNECT_SERVER: "mcp:disconnectServer",
  MCP_GET_STATUS: "mcp:getStatus",
  MCP_GET_SERVER_STATUS: "mcp:getServerStatus",
  MCP_GET_ALL_TOOLS: "mcp:getAllTools",
  MCP_GET_SERVER_TOOLS: "mcp:getServerTools",
  MCP_TEST_SERVER: "mcp:testServer",
  MCP_SERVER_STATUS_CHANGE: "mcp:serverStatusChange",
  MCP_CONNECTOR_OAUTH_START: "mcp:connectorOAuthStart",
  // MCP Registry
  MCP_REGISTRY_FETCH: "mcp:registryFetch",
  MCP_REGISTRY_SEARCH: "mcp:registrySearch",
  MCP_REGISTRY_INSTALL: "mcp:registryInstall",
  MCP_REGISTRY_UNINSTALL: "mcp:registryUninstall",
  MCP_REGISTRY_CHECK_UPDATES: "mcp:registryCheckUpdates",
  MCP_REGISTRY_UPDATE_SERVER: "mcp:registryUpdateServer",
  // MCP Host
  MCP_HOST_START: "mcp:hostStart",
  MCP_HOST_STOP: "mcp:hostStop",
  MCP_HOST_GET_STATUS: "mcp:hostGetStatus",
  // Conway Terminal
  CONWAY_GET_STATUS: "conway:getStatus",
  CONWAY_GET_SETTINGS: "conway:getSettings",
  CONWAY_SAVE_SETTINGS: "conway:saveSettings",
  CONWAY_SETUP: "conway:setup",
  CONWAY_GET_BALANCE: "conway:getBalance",
  CONWAY_GET_WALLET: "conway:getWallet",
  CONWAY_GET_CREDIT_HISTORY: "conway:getCreditHistory",
  CONWAY_CONNECT: "conway:connect",
  CONWAY_DISCONNECT: "conway:disconnect",
  CONWAY_RESET: "conway:reset",
  CONWAY_WALLET_RESTORE: "conway:walletRestore",
  CONWAY_WALLET_VERIFY: "conway:walletVerify",
  CONWAY_STATUS_CHANGE: "conway:statusChange",
  // Built-in Tools Settings
  BUILTIN_TOOLS_GET_SETTINGS: "builtinTools:getSettings",
  BUILTIN_TOOLS_SAVE_SETTINGS: "builtinTools:saveSettings",
  BUILTIN_TOOLS_GET_CATEGORIES: "builtinTools:getCategories",
  // Tray (Menu Bar)
  TRAY_GET_SETTINGS: "tray:getSettings",
  TRAY_SAVE_SETTINGS: "tray:saveSettings",
  TRAY_NEW_TASK: "tray:newTask",
  TRAY_SELECT_WORKSPACE: "tray:selectWorkspace",
  TRAY_OPEN_SETTINGS: "tray:openSettings",
  TRAY_OPEN_ABOUT: "tray:openAbout",
  TRAY_CHECK_UPDATES: "tray:checkUpdates",
  TRAY_QUICK_TASK: "tray:quick-task",
  // Quick Input
  QUICK_INPUT_SUBMIT: "quick-input:submit",
  QUICK_INPUT_CLOSE: "quick-input:close",
  // Cron (Scheduled Tasks)
  CRON_GET_STATUS: "cron:getStatus",
  CRON_LIST_JOBS: "cron:listJobs",
  CRON_GET_JOB: "cron:getJob",
  CRON_ADD_JOB: "cron:addJob",
  CRON_UPDATE_JOB: "cron:updateJob",
  CRON_REMOVE_JOB: "cron:removeJob",
  CRON_RUN_JOB: "cron:runJob",
  CRON_EVENT: "cron:event",
  // Notifications
  NOTIFICATION_LIST: "notification:list",
  NOTIFICATION_ADD: "notification:add",
  NOTIFICATION_MARK_READ: "notification:markRead",
  NOTIFICATION_MARK_ALL_READ: "notification:markAllRead",
  NOTIFICATION_DELETE: "notification:delete",
  NOTIFICATION_DELETE_ALL: "notification:deleteAll",
  NOTIFICATION_EVENT: "notification:event",
  // Hooks (Webhooks & Gmail Pub/Sub)
  HOOKS_GET_SETTINGS: "hooks:getSettings",
  HOOKS_SAVE_SETTINGS: "hooks:saveSettings",
  HOOKS_ENABLE: "hooks:enable",
  HOOKS_DISABLE: "hooks:disable",
  HOOKS_REGENERATE_TOKEN: "hooks:regenerateToken",
  HOOKS_GET_STATUS: "hooks:getStatus",
  HOOKS_ADD_MAPPING: "hooks:addMapping",
  HOOKS_REMOVE_MAPPING: "hooks:removeMapping",
  HOOKS_CONFIGURE_GMAIL: "hooks:configureGmail",
  HOOKS_GET_GMAIL_STATUS: "hooks:getGmailStatus",
  HOOKS_START_GMAIL_WATCHER: "hooks:startGmailWatcher",
  HOOKS_STOP_GMAIL_WATCHER: "hooks:stopGmailWatcher",
  HOOKS_EVENT: "hooks:event",
  // Control Plane (WebSocket Gateway)
  CONTROL_PLANE_GET_SETTINGS: "controlPlane:getSettings",
  CONTROL_PLANE_SAVE_SETTINGS: "controlPlane:saveSettings",
  CONTROL_PLANE_ENABLE: "controlPlane:enable",
  CONTROL_PLANE_DISABLE: "controlPlane:disable",
  CONTROL_PLANE_START: "controlPlane:start",
  CONTROL_PLANE_STOP: "controlPlane:stop",
  CONTROL_PLANE_GET_STATUS: "controlPlane:getStatus",
  CONTROL_PLANE_REGENERATE_TOKEN: "controlPlane:regenerateToken",
  CONTROL_PLANE_EVENT: "controlPlane:event",
  // Tailscale
  TAILSCALE_GET_STATUS: "tailscale:getStatus",
  TAILSCALE_CHECK_AVAILABILITY: "tailscale:checkAvailability",
  TAILSCALE_SET_MODE: "tailscale:setMode",
  // Remote Gateway (connecting to external Control Plane)
  REMOTE_GATEWAY_CONNECT: "remoteGateway:connect",
  REMOTE_GATEWAY_DISCONNECT: "remoteGateway:disconnect",
  REMOTE_GATEWAY_GET_STATUS: "remoteGateway:getStatus",
  REMOTE_GATEWAY_SAVE_CONFIG: "remoteGateway:saveConfig",
  REMOTE_GATEWAY_TEST_CONNECTION: "remoteGateway:testConnection",
  REMOTE_GATEWAY_EVENT: "remoteGateway:event",
  // SSH Tunnel (for Remote Gateway connection)
  SSH_TUNNEL_CONNECT: "sshTunnel:connect",
  SSH_TUNNEL_DISCONNECT: "sshTunnel:disconnect",
  SSH_TUNNEL_GET_STATUS: "sshTunnel:getStatus",
  SSH_TUNNEL_SAVE_CONFIG: "sshTunnel:saveConfig",
  SSH_TUNNEL_TEST_CONNECTION: "sshTunnel:testConnection",
  SSH_TUNNEL_EVENT: "sshTunnel:event",
  // Live Canvas (Agent-driven visual workspace)
  CANVAS_CREATE: "canvas:create",
  CANVAS_GET_SESSION: "canvas:getSession",
  CANVAS_LIST_SESSIONS: "canvas:listSessions",
  CANVAS_SHOW: "canvas:show",
  CANVAS_HIDE: "canvas:hide",
  CANVAS_CLOSE: "canvas:close",
  CANVAS_PUSH: "canvas:push",
  CANVAS_EVAL: "canvas:eval",
  CANVAS_SNAPSHOT: "canvas:snapshot",
  CANVAS_A2UI_ACTION: "canvas:a2uiAction",
  CANVAS_EVENT: "canvas:event",
  CANVAS_EXPORT_HTML: "canvas:exportHTML",
  CANVAS_EXPORT_TO_FOLDER: "canvas:exportToFolder",
  CANVAS_OPEN_IN_BROWSER: "canvas:openInBrowser",
  CANVAS_OPEN_URL: "canvas:openUrl",
  CANVAS_GET_SESSION_DIR: "canvas:getSessionDir",
  CANVAS_CHECKPOINT_SAVE: "canvas:checkpointSave",
  CANVAS_CHECKPOINT_LIST: "canvas:checkpointList",
  CANVAS_CHECKPOINT_RESTORE: "canvas:checkpointRestore",
  CANVAS_CHECKPOINT_DELETE: "canvas:checkpointDelete",
  CANVAS_GET_CONTENT: "canvas:getContent",
  // Mobile Companion Nodes
  NODE_LIST: "node:list",
  NODE_GET: "node:get",
  NODE_INVOKE: "node:invoke",
  NODE_EVENT: "node:event",
  // Memory System
  MEMORY_GET_SETTINGS: "memory:getSettings",
  MEMORY_SAVE_SETTINGS: "memory:saveSettings",
  MEMORY_SEARCH: "memory:search",
  MEMORY_GET_TIMELINE: "memory:getTimeline",
  MEMORY_GET_DETAILS: "memory:getDetails",
  MEMORY_GET_RECENT: "memory:getRecent",
  MEMORY_GET_STATS: "memory:getStats",
  MEMORY_CLEAR: "memory:clear",
  MEMORY_EVENT: "memory:event",
  MEMORY_IMPORT_CHATGPT: "memory:importChatGPT",
  MEMORY_IMPORT_CHATGPT_PROGRESS: "memory:importChatGPTProgress",
  MEMORY_IMPORT_CHATGPT_CANCEL: "memory:importChatGPTCancel",
  MEMORY_GET_IMPORTED_STATS: "memory:getImportedStats",
  MEMORY_FIND_IMPORTED: "memory:findImported",
  MEMORY_DELETE_IMPORTED: "memory:deleteImported",
  MEMORY_GET_USER_PROFILE: "memory:getUserProfile",
  MEMORY_ADD_USER_FACT: "memory:addUserFact",
  MEMORY_UPDATE_USER_FACT: "memory:updateUserFact",
  MEMORY_DELETE_USER_FACT: "memory:deleteUserFact",
  MEMORY_RELATIONSHIP_LIST: "memory:relationshipList",
  MEMORY_RELATIONSHIP_UPDATE: "memory:relationshipUpdate",
  MEMORY_RELATIONSHIP_DELETE: "memory:relationshipDelete",
  MEMORY_COMMITMENTS_GET: "memory:commitmentsGet",
  MEMORY_COMMITMENTS_DUE_SOON: "memory:commitmentsDueSoon",

  // Memory Features (global toggles)
  MEMORY_FEATURES_GET_SETTINGS: "memoryFeatures:getSettings",
  MEMORY_FEATURES_SAVE_SETTINGS: "memoryFeatures:saveSettings",

  // Workspace Kit (.cowork)
  KIT_GET_STATUS: "kit:getStatus",
  KIT_INIT: "kit:init",
  KIT_PROJECT_CREATE: "kit:projectCreate",

  // Migration Status (for showing one-time notifications after app rename)
  MIGRATION_GET_STATUS: "migration:getStatus",
  MIGRATION_DISMISS_NOTIFICATION: "migration:dismissNotification",

  // Extensions / Plugins
  EXTENSIONS_LIST: "extensions:list",
  EXTENSIONS_GET: "extensions:get",
  EXTENSIONS_ENABLE: "extensions:enable",
  EXTENSIONS_DISABLE: "extensions:disable",
  EXTENSIONS_RELOAD: "extensions:reload",
  EXTENSIONS_GET_CONFIG: "extensions:getConfig",
  EXTENSIONS_SET_CONFIG: "extensions:setConfig",
  EXTENSIONS_DISCOVER: "extensions:discover",

  // Webhook Tunnel
  TUNNEL_GET_STATUS: "tunnel:getStatus",
  TUNNEL_START: "tunnel:start",
  TUNNEL_STOP: "tunnel:stop",
  // Agent Roles (Agent Squad)
  AGENT_ROLE_LIST: "agentRole:list",
  AGENT_ROLE_GET: "agentRole:get",
  AGENT_ROLE_CREATE: "agentRole:create",
  AGENT_ROLE_UPDATE: "agentRole:update",
  AGENT_ROLE_DELETE: "agentRole:delete",
  AGENT_ROLE_ASSIGN_TO_TASK: "agentRole:assignToTask",
  AGENT_ROLE_GET_DEFAULTS: "agentRole:getDefaults",
  AGENT_ROLE_SEED_DEFAULTS: "agentRole:seedDefaults",
  AGENT_ROLE_SYNC_DEFAULTS: "agentRole:syncDefaults",

  // Agent Teams
  TEAM_LIST: "team:list",
  TEAM_CREATE: "team:create",
  TEAM_UPDATE: "team:update",
  TEAM_DELETE: "team:delete",
  TEAM_MEMBER_LIST: "teamMember:list",
  TEAM_MEMBER_ADD: "teamMember:add",
  TEAM_MEMBER_UPDATE: "teamMember:update",
  TEAM_MEMBER_REMOVE: "teamMember:remove",
  TEAM_MEMBER_REORDER: "teamMember:reorder",
  TEAM_RUN_LIST: "teamRun:list",
  TEAM_RUN_CREATE: "teamRun:create",
  TEAM_RUN_RESUME: "teamRun:resume",
  TEAM_RUN_PAUSE: "teamRun:pause",
  TEAM_RUN_CANCEL: "teamRun:cancel",
  TEAM_RUN_WRAP_UP: "teamRun:wrapUp",
  TEAM_ITEM_LIST: "teamItem:list",
  TEAM_ITEM_CREATE: "teamItem:create",
  TEAM_ITEM_UPDATE: "teamItem:update",
  TEAM_ITEM_DELETE: "teamItem:delete",
  TEAM_ITEM_MOVE: "teamItem:move",
  TEAM_RUN_EVENT: "teamRun:event",
  // Collaborative Thoughts
  TEAM_THOUGHT_LIST: "teamThought:list",
  TEAM_THOUGHT_EVENT: "teamThought:event",
  TEAM_RUN_FIND_BY_ROOT_TASK: "teamRun:findByRootTask",
  // Activity Feed
  ACTIVITY_LIST: "activity:list",
  ACTIVITY_CREATE: "activity:create",
  ACTIVITY_MARK_READ: "activity:markRead",
  ACTIVITY_MARK_ALL_READ: "activity:markAllRead",
  ACTIVITY_PIN: "activity:pin",
  ACTIVITY_DELETE: "activity:delete",
  ACTIVITY_EVENT: "activity:event",
  // @Mention System
  MENTION_CREATE: "mention:create",
  MENTION_LIST: "mention:list",
  MENTION_ACKNOWLEDGE: "mention:acknowledge",
  MENTION_COMPLETE: "mention:complete",
  MENTION_DISMISS: "mention:dismiss",
  MENTION_EVENT: "mention:event",
  // Task Board
  TASK_MOVE_COLUMN: "task:moveColumn",
  TASK_SET_PRIORITY: "task:setPriority",
  TASK_SET_DUE_DATE: "task:setDueDate",
  TASK_SET_ESTIMATE: "task:setEstimate",
  TASK_ADD_LABEL: "task:addLabel",
  TASK_REMOVE_LABEL: "task:removeLabel",
  TASK_BOARD_EVENT: "taskBoard:event",
  // Task Labels
  TASK_LABEL_LIST: "taskLabel:list",
  TASK_LABEL_CREATE: "taskLabel:create",
  TASK_LABEL_UPDATE: "taskLabel:update",
  TASK_LABEL_DELETE: "taskLabel:delete",
  // Agent Working State
  WORKING_STATE_GET: "workingState:get",
  WORKING_STATE_GET_CURRENT: "workingState:getCurrent",
  WORKING_STATE_UPDATE: "workingState:update",
  WORKING_STATE_HISTORY: "workingState:history",
  WORKING_STATE_RESTORE: "workingState:restore",
  WORKING_STATE_DELETE: "workingState:delete",
  WORKING_STATE_LIST_FOR_TASK: "workingState:listForTask",
  // Context Policy (per-context security DM vs group)
  CONTEXT_POLICY_GET: "contextPolicy:get",
  CONTEXT_POLICY_GET_FOR_CHAT: "contextPolicy:getForChat",
  CONTEXT_POLICY_LIST: "contextPolicy:list",
  CONTEXT_POLICY_UPDATE: "contextPolicy:update",
  CONTEXT_POLICY_DELETE: "contextPolicy:delete",
  CONTEXT_POLICY_CREATE_DEFAULTS: "contextPolicy:createDefaults",
  CONTEXT_POLICY_IS_TOOL_ALLOWED: "contextPolicy:isToolAllowed",
  // Voice Mode
  VOICE_GET_SETTINGS: "voice:getSettings",
  VOICE_SAVE_SETTINGS: "voice:saveSettings",
  VOICE_GET_STATE: "voice:getState",
  VOICE_SPEAK: "voice:speak",
  VOICE_STOP_SPEAKING: "voice:stopSpeaking",
  VOICE_TRANSCRIBE: "voice:transcribe",
  VOICE_GET_ELEVENLABS_VOICES: "voice:getElevenLabsVoices",
  VOICE_TEST_ELEVENLABS: "voice:testElevenLabs",
  VOICE_TEST_OPENAI: "voice:testOpenAI",
  VOICE_TEST_AZURE: "voice:testAzure",
  VOICE_EVENT: "voice:event",
  // Mission Control - Heartbeat
  HEARTBEAT_GET_CONFIG: "heartbeat:getConfig",
  HEARTBEAT_UPDATE_CONFIG: "heartbeat:updateConfig",
  HEARTBEAT_TRIGGER: "heartbeat:trigger",
  HEARTBEAT_GET_STATUS: "heartbeat:getStatus",
  HEARTBEAT_GET_ALL_STATUS: "heartbeat:getAllStatus",
  HEARTBEAT_EVENT: "heartbeat:event",
  // Mission Control - Task Subscriptions
  SUBSCRIPTION_LIST: "subscription:list",
  SUBSCRIPTION_ADD: "subscription:add",
  SUBSCRIPTION_REMOVE: "subscription:remove",
  SUBSCRIPTION_GET_SUBSCRIBERS: "subscription:getSubscribers",
  SUBSCRIPTION_GET_FOR_AGENT: "subscription:getForAgent",
  SUBSCRIPTION_EVENT: "subscription:event",
  // Mission Control - Standup Reports
  STANDUP_GENERATE: "standup:generate",
  STANDUP_GET_LATEST: "standup:getLatest",
  STANDUP_LIST: "standup:list",
  STANDUP_DELIVER: "standup:deliver",
  // Mission Control - Agent Performance Reviews
  REVIEW_GENERATE: "review:generate",
  REVIEW_GET_LATEST: "review:getLatest",
  REVIEW_LIST: "review:list",
  REVIEW_DELETE: "review:delete",
  // Git Worktree operations
  WORKTREE_GET_INFO: "worktree:getInfo",
  WORKTREE_LIST: "worktree:list",
  WORKTREE_MERGE: "worktree:merge",
  WORKTREE_CLEANUP: "worktree:cleanup",
  WORKTREE_GET_DIFF: "worktree:getDiff",
  WORKTREE_GET_SETTINGS: "worktree:getSettings",
  WORKTREE_SAVE_SETTINGS: "worktree:saveSettings",
  // Agent Comparison mode
  COMPARISON_CREATE: "comparison:create",
  COMPARISON_GET: "comparison:get",
  COMPARISON_LIST: "comparison:list",
  COMPARISON_CANCEL: "comparison:cancel",
  COMPARISON_GET_RESULT: "comparison:getResult",
} as const;

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

type SkillSource = "bundled" | "managed" | "workspace";

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
  skills: SkillStatusEntry[];
  summary: {
    total: number;
    eligible: number;
    disabled: number;
    missingRequirements: number;
  };
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
    properties?: Record<string, any>;
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
    browser: ToolCategoryConfig;
    search: ToolCategoryConfig;
    system: ToolCategoryConfig;
    file: ToolCategoryConfig;
    skill: ToolCategoryConfig;
    shell: ToolCategoryConfig;
    image: ToolCategoryConfig;
  };
  toolOverrides: Record<string, { enabled: boolean; priority?: "high" | "normal" | "low" }>;
  toolTimeouts: Record<string, number>;
  toolAutoApprove: Record<string, boolean>;
  runCommandApprovalMode: "per_command" | "single_bundle";
  version: string;
}

// Tray (Menu Bar) Settings (inlined for sandboxed preload)
interface TraySettings {
  enabled: boolean;
  showDockIcon: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  showNotifications: boolean;
}

// Cron (Scheduled Tasks) Types (inlined for sandboxed preload)
type CronSchedule =
  | { kind: "at"; atMs: number }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string };

type CronJobStatus = "ok" | "error" | "skipped" | "timeout";

interface CronRunHistoryEntry {
  runAtMs: number;
  durationMs: number;
  status: CronJobStatus;
  error?: string;
  taskId?: string;
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
    | "googlechat";
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
}

interface NotificationEvent {
  type: "added" | "updated" | "removed" | "cleared";
  notification?: AppNotification;
  notifications?: AppNotification[];
}

// Memory System Types (inlined for sandboxed preload)
type MemoryType = "observation" | "decision" | "error" | "insight" | "summary";
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
}

interface RemoteGatewayEvent {
  type: "stateChange" | "event";
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
  // Mission Control fields
  autonomyLevel?: AgentAutonomyLevel;
  soul?: string;
  heartbeatEnabled?: boolean;
  heartbeatIntervalMinutes?: number;
  heartbeatStaggerOffset?: number;
  lastHeartbeatAt?: number;
  heartbeatStatus?: HeartbeatStatus;
}

interface CreateAgentRoleRequest {
  name: string;
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
  // Mission Control fields
  autonomyLevel?: AgentAutonomyLevel;
  soul?: string;
  heartbeatEnabled?: boolean;
  heartbeatIntervalMinutes?: number;
  heartbeatStaggerOffset?: number;
}

interface UpdateAgentRoleRequest {
  id: string;
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
  // Mission Control fields
  autonomyLevel?: AgentAutonomyLevel;
  soul?: string;
  heartbeatEnabled?: boolean;
  heartbeatIntervalMinutes?: number;
  heartbeatStaggerOffset?: number;
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
  taskCreated?: string;
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
}

// Expose protected methods that allow the renderer process to use ipcRenderer
contextBridge.exposeInMainWorld("electronAPI", {
  // Dialog APIs
  selectFolder: () => ipcRenderer.invoke("dialog:selectFolder"),
  selectFiles: () => ipcRenderer.invoke("dialog:selectFiles"),

  // File APIs
  openFile: (filePath: string, workspacePath?: string) =>
    ipcRenderer.invoke("file:open", filePath, workspacePath),
  showInFinder: (filePath: string, workspacePath?: string) =>
    ipcRenderer.invoke("file:showInFinder", filePath, workspacePath),
  readFileForViewer: (
    filePath: string,
    workspacePath?: string,
    options?: ReadFileForViewerOptions,
  ) => ipcRenderer.invoke("file:readForViewer", { filePath, workspacePath, ...options }),
  importFilesToWorkspace: (data: { workspaceId: string; files: string[] }) =>
    ipcRenderer.invoke("file:importToWorkspace", data),
  importDataToWorkspace: (data: {
    workspaceId: string;
    files: Array<{ name: string; data: string; mimeType?: string }>;
  }) => ipcRenderer.invoke("file:importDataToWorkspace", data),

  // Shell APIs
  openExternal: (url: string) => ipcRenderer.invoke("shell:openExternal", url),
  openSystemSettings: (target: "microphone" | "dictation") =>
    ipcRenderer.invoke(IPC_CHANNELS.SYSTEM_OPEN_SETTINGS, target),

  // Task APIs
  createTask: (data: any) => ipcRenderer.invoke(IPC_CHANNELS.TASK_CREATE, data),
  getTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_GET, id),
  listTasks: () => ipcRenderer.invoke(IPC_CHANNELS.TASK_LIST),
  exportTasksJson: (query?: any) => ipcRenderer.invoke(IPC_CHANNELS.TASK_EXPORT_JSON, query),
  toggleTaskPin: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_PIN, taskId),
  cancelTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_CANCEL, id),
  wrapUpTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_WRAP_UP, id),
  pauseTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_PAUSE, id),
  resumeTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_RESUME, id),
  sendStdin: (taskId: string, input: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_SEND_STDIN, { taskId, input }),
  killCommand: (taskId: string, force?: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_KILL_COMMAND, { taskId, force }),
  renameTask: (id: string, title: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_RENAME, { id, title }),
  deleteTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_DELETE, id),

  // Task event streaming
  onTaskEvent: (callback: (event: any) => void) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.TASK_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TASK_EVENT, subscription);
  },

  // Task event history (load from DB)
  getTaskEvents: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_EVENTS, taskId),

  // Send follow-up message to a task (optionally with image attachments)
  sendMessage: (taskId: string, message: string, images?: ImageAttachment[]) => {
    const validatedImages = validateSendMessageAttachments(images);
    return ipcRenderer.invoke(IPC_CHANNELS.TASK_SEND_MESSAGE, {
      taskId,
      message,
      images: validatedImages,
    });
  },

  // Workspace APIs
  createWorkspace: (data: any) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE, data),
  listWorkspaces: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST),
  selectWorkspace: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SELECT, id),
  getTempWorkspace: (options?: { createNew?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET_TEMP, options),
  touchWorkspace: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_TOUCH, id),
  updateWorkspacePermissions: (id: string, permissions: { shell?: boolean; network?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_UPDATE_PERMISSIONS, id, permissions),

  // Approval APIs
  respondToApproval: (data: any) => ipcRenderer.invoke(IPC_CHANNELS.APPROVAL_RESPOND, data),
  setSessionAutoApprove: (enabled: boolean) =>
    ipcRenderer.invoke(IPC_CHANNELS.APPROVAL_SESSION_AUTO_APPROVE_SET, enabled),
  getSessionAutoApprove: () => ipcRenderer.invoke(IPC_CHANNELS.APPROVAL_SESSION_AUTO_APPROVE_GET),

  // Artifact APIs
  listArtifacts: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.ARTIFACT_LIST, taskId),
  previewArtifact: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.ARTIFACT_PREVIEW, id),

  // Skill APIs
  listSkills: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_LIST),
  getSkill: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_GET, id),

  // LLM Settings APIs
  getLLMSettings: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_SETTINGS),
  saveLLMSettings: (settings: any) => ipcRenderer.invoke(IPC_CHANNELS.LLM_SAVE_SETTINGS, settings),
  testLLMProvider: (config: any) => ipcRenderer.invoke(IPC_CHANNELS.LLM_TEST_PROVIDER, config),
  getLLMModels: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_MODELS),
  getLLMConfigStatus: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_CONFIG_STATUS),
  setLLMModel: (modelKey: string) => ipcRenderer.invoke(IPC_CHANNELS.LLM_SET_MODEL, modelKey),
  getProviderModels: (providerType: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_PROVIDER_MODELS, providerType),
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
  updateGatewayChannel: (data: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_UPDATE_CHANNEL, data),
  removeGatewayChannel: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_REMOVE_CHANNEL, id),
  enableGatewayChannel: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_ENABLE_CHANNEL, id),
  disableGatewayChannel: (id: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_DISABLE_CHANNEL, id),
  testGatewayChannel: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_TEST_CHANNEL, id),
  getGatewayUsers: (channelId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_GET_USERS, channelId),
  grantGatewayAccess: (channelId: string, userId: string, displayName?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_GRANT_ACCESS, { channelId, userId, displayName }),
  revokeGatewayAccess: (channelId: string, userId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_REVOKE_ACCESS, { channelId, userId }),
  generateGatewayPairing: (channelId: string, userId: string, displayName?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_GENERATE_PAIRING, { channelId, userId, displayName }),

  // Gateway event listener
  onGatewayMessage: (callback: (data: any) => void) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on("gateway:message", subscription);
    return () => ipcRenderer.removeListener("gateway:message", subscription);
  },
  onGatewayUsersUpdated: (callback: (data: { channelId: string; channelType: string }) => void) => {
    const subscription = (_: any, data: { channelId: string; channelType: string }) =>
      callback(data);
    ipcRenderer.on("gateway:users-updated", subscription);
    return () => ipcRenderer.removeListener("gateway:users-updated", subscription);
  },

  // WhatsApp-specific APIs
  getWhatsAppInfo: () => ipcRenderer.invoke("whatsapp:get-info"),
  whatsAppLogout: () => ipcRenderer.invoke("whatsapp:logout"),

  // WhatsApp event listeners
  onWhatsAppQRCode: (callback: (event: any, qr: string) => void) => {
    ipcRenderer.on("whatsapp:qr-code", callback);
  },
  onWhatsAppConnected: (callback: () => void) => {
    ipcRenderer.on("whatsapp:connected", callback);
  },
  onWhatsAppStatus: (callback: (event: any, data: { status: string; error?: string }) => void) => {
    ipcRenderer.on("whatsapp:status", callback);
  },

  // Search Settings APIs
  getSearchSettings: () => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_GET_SETTINGS),
  saveSearchSettings: (settings: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.SEARCH_SAVE_SETTINGS, settings),
  getSearchConfigStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_GET_CONFIG_STATUS),
  testSearchProvider: (providerType: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SEARCH_TEST_PROVIDER, providerType),

  // X/Twitter Settings APIs
  getXSettings: () => ipcRenderer.invoke(IPC_CHANNELS.X_GET_SETTINGS),
  saveXSettings: (settings: any) => ipcRenderer.invoke(IPC_CHANNELS.X_SAVE_SETTINGS, settings),
  testXConnection: () => ipcRenderer.invoke(IPC_CHANNELS.X_TEST_CONNECTION),
  getXStatus: () => ipcRenderer.invoke(IPC_CHANNELS.X_GET_STATUS),

  // Notion Settings APIs
  getNotionSettings: () => ipcRenderer.invoke(IPC_CHANNELS.NOTION_GET_SETTINGS),
  saveNotionSettings: (settings: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.NOTION_SAVE_SETTINGS, settings),
  testNotionConnection: () => ipcRenderer.invoke(IPC_CHANNELS.NOTION_TEST_CONNECTION),
  getNotionStatus: () => ipcRenderer.invoke(IPC_CHANNELS.NOTION_GET_STATUS),

  // Box Settings APIs
  getBoxSettings: () => ipcRenderer.invoke(IPC_CHANNELS.BOX_GET_SETTINGS),
  saveBoxSettings: (settings: any) => ipcRenderer.invoke(IPC_CHANNELS.BOX_SAVE_SETTINGS, settings),
  testBoxConnection: () => ipcRenderer.invoke(IPC_CHANNELS.BOX_TEST_CONNECTION),
  getBoxStatus: () => ipcRenderer.invoke(IPC_CHANNELS.BOX_GET_STATUS),

  // OneDrive Settings APIs
  getOneDriveSettings: () => ipcRenderer.invoke(IPC_CHANNELS.ONEDRIVE_GET_SETTINGS),
  saveOneDriveSettings: (settings: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.ONEDRIVE_SAVE_SETTINGS, settings),
  testOneDriveConnection: () => ipcRenderer.invoke(IPC_CHANNELS.ONEDRIVE_TEST_CONNECTION),
  getOneDriveStatus: () => ipcRenderer.invoke(IPC_CHANNELS.ONEDRIVE_GET_STATUS),

  // Google Workspace Settings APIs
  getGoogleWorkspaceSettings: () => ipcRenderer.invoke(IPC_CHANNELS.GOOGLE_WORKSPACE_GET_SETTINGS),
  saveGoogleWorkspaceSettings: (settings: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.GOOGLE_WORKSPACE_SAVE_SETTINGS, settings),
  testGoogleWorkspaceConnection: () =>
    ipcRenderer.invoke(IPC_CHANNELS.GOOGLE_WORKSPACE_TEST_CONNECTION),
  getGoogleWorkspaceStatus: () => ipcRenderer.invoke(IPC_CHANNELS.GOOGLE_WORKSPACE_GET_STATUS),
  startGoogleWorkspaceOAuth: (payload: {
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
  }) => ipcRenderer.invoke(IPC_CHANNELS.GOOGLE_WORKSPACE_OAUTH_START, payload),

  // Dropbox Settings APIs
  getDropboxSettings: () => ipcRenderer.invoke(IPC_CHANNELS.DROPBOX_GET_SETTINGS),
  saveDropboxSettings: (settings: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.DROPBOX_SAVE_SETTINGS, settings),
  testDropboxConnection: () => ipcRenderer.invoke(IPC_CHANNELS.DROPBOX_TEST_CONNECTION),
  getDropboxStatus: () => ipcRenderer.invoke(IPC_CHANNELS.DROPBOX_GET_STATUS),

  // SharePoint Settings APIs
  getSharePointSettings: () => ipcRenderer.invoke(IPC_CHANNELS.SHAREPOINT_GET_SETTINGS),
  saveSharePointSettings: (settings: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.SHAREPOINT_SAVE_SETTINGS, settings),
  testSharePointConnection: () => ipcRenderer.invoke(IPC_CHANNELS.SHAREPOINT_TEST_CONNECTION),
  getSharePointStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SHAREPOINT_GET_STATUS),

  // App Update APIs
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION),
  checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.APP_CHECK_UPDATES),
  downloadUpdate: (updateInfo: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.APP_DOWNLOAD_UPDATE, updateInfo),
  installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.APP_INSTALL_UPDATE),

  // Update event listeners
  onUpdateProgress: (callback: (progress: any) => void) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.APP_UPDATE_PROGRESS, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_UPDATE_PROGRESS, subscription);
  },
  onUpdateDownloaded: (callback: (info: any) => void) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.APP_UPDATE_DOWNLOADED, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_UPDATE_DOWNLOADED, subscription);
  },
  onUpdateError: (callback: (error: any) => void) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.APP_UPDATE_ERROR, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_UPDATE_ERROR, subscription);
  },

  // Guardrail Settings APIs
  getGuardrailSettings: () => ipcRenderer.invoke(IPC_CHANNELS.GUARDRAIL_GET_SETTINGS),
  saveGuardrailSettings: (settings: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.GUARDRAIL_SAVE_SETTINGS, settings),
  getGuardrailDefaults: () => ipcRenderer.invoke(IPC_CHANNELS.GUARDRAIL_GET_DEFAULTS),

  // Appearance Settings APIs
  getAppearanceSettings: () => ipcRenderer.invoke(IPC_CHANNELS.APPEARANCE_GET_SETTINGS),
  saveAppearanceSettings: (settings: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.APPEARANCE_SAVE_SETTINGS, settings),

  // Personality Settings APIs
  getPersonalitySettings: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_GET_SETTINGS),
  savePersonalitySettings: (settings: any) =>
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
  onPersonalitySettingsChanged: (callback: (settings: any) => void) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.PERSONALITY_SETTINGS_CHANGED, subscription);
    return () =>
      ipcRenderer.removeListener(IPC_CHANNELS.PERSONALITY_SETTINGS_CHANGED, subscription);
  },

  // Queue APIs
  getQueueStatus: () => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_GET_STATUS),
  getQueueSettings: () => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_GET_SETTINGS),
  saveQueueSettings: (settings: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.QUEUE_SAVE_SETTINGS, settings),
  clearQueue: () => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_CLEAR),
  onQueueUpdate: (callback: (status: any) => void) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.QUEUE_UPDATE, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.QUEUE_UPDATE, subscription);
  },

  // Custom Skills APIs
  listCustomSkills: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_LIST),
  listTaskSkills: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_LIST_TASKS),
  listGuidelineSkills: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_LIST_GUIDELINES),
  getCustomSkill: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_GET, id),
  createCustomSkill: (skill: any) => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_CREATE, skill),
  updateCustomSkill: (id: string, updates: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_UPDATE, id, updates),
  deleteCustomSkill: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_DELETE, id),
  reloadCustomSkills: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_RELOAD),
  openCustomSkillsFolder: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_OPEN_FOLDER),

  // Skill Registry (SkillHub) APIs
  searchSkillRegistry: (query: string, options?: { page?: number; pageSize?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_SEARCH, query, options),
  getSkillDetails: (skillId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_GET_DETAILS, skillId),
  installSkillFromRegistry: (skillId: string, version?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_INSTALL, skillId, version),
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
  saveMCPSettings: (settings: any) => ipcRenderer.invoke(IPC_CHANNELS.MCP_SAVE_SETTINGS, settings),
  addMCPServer: (config: any) => ipcRenderer.invoke(IPC_CHANNELS.MCP_ADD_SERVER, config),
  updateMCPServer: (id: string, updates: any) =>
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
    provider: "salesforce" | "jira" | "hubspot" | "zendesk";
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    loginUrl?: string;
    subdomain?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.MCP_CONNECTOR_OAUTH_START, payload),

  // MCP Status change event listener
  onMCPStatusChange: (callback: (status: any[]) => void) => {
    const subscription = (_: any, data: any) => callback(data);
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

  // Conway Terminal APIs
  conwayGetStatus: () => ipcRenderer.invoke(IPC_CHANNELS.CONWAY_GET_STATUS),
  conwayGetSettings: () => ipcRenderer.invoke(IPC_CHANNELS.CONWAY_GET_SETTINGS),
  conwaySaveSettings: (settings: ConwaySettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.CONWAY_SAVE_SETTINGS, settings),
  conwaySetup: () => ipcRenderer.invoke(IPC_CHANNELS.CONWAY_SETUP),
  conwayGetBalance: () => ipcRenderer.invoke(IPC_CHANNELS.CONWAY_GET_BALANCE),
  conwayGetWallet: () => ipcRenderer.invoke(IPC_CHANNELS.CONWAY_GET_WALLET),
  conwayGetCreditHistory: () => ipcRenderer.invoke(IPC_CHANNELS.CONWAY_GET_CREDIT_HISTORY),
  conwayConnect: () => ipcRenderer.invoke(IPC_CHANNELS.CONWAY_CONNECT),
  conwayDisconnect: () => ipcRenderer.invoke(IPC_CHANNELS.CONWAY_DISCONNECT),
  conwayReset: () => ipcRenderer.invoke(IPC_CHANNELS.CONWAY_RESET),
  conwayWalletRestore: () => ipcRenderer.invoke(IPC_CHANNELS.CONWAY_WALLET_RESTORE),
  conwayWalletVerify: () => ipcRenderer.invoke(IPC_CHANNELS.CONWAY_WALLET_VERIFY),
  onConwayStatusChange: (callback: (status: ConwaySetupStatus) => void) => {
    const subscription = (_: unknown, status: ConwaySetupStatus) => callback(status);
    ipcRenderer.on(IPC_CHANNELS.CONWAY_STATUS_CHANGE, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CONWAY_STATUS_CHANGE, subscription);
  },

  // Built-in Tools Settings APIs
  getBuiltinToolsSettings: () => ipcRenderer.invoke(IPC_CHANNELS.BUILTIN_TOOLS_GET_SETTINGS),
  saveBuiltinToolsSettings: (settings: BuiltinToolsSettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.BUILTIN_TOOLS_SAVE_SETTINGS, settings),
  getBuiltinToolsCategories: () => ipcRenderer.invoke(IPC_CHANNELS.BUILTIN_TOOLS_GET_CATEGORIES),

  // Tray (Menu Bar) APIs
  getTraySettings: () => ipcRenderer.invoke(IPC_CHANNELS.TRAY_GET_SETTINGS),
  saveTraySettings: (settings: TraySettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.TRAY_SAVE_SETTINGS, settings),

  // Tray event listeners (for renderer to respond to tray actions)
  onTrayNewTask: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.TRAY_NEW_TASK, callback);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TRAY_NEW_TASK, callback);
  },
  onTraySelectWorkspace: (callback: (event: any, workspaceId: string) => void) => {
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
    callback: (event: any, data: { task: string; workspaceId?: string }) => void,
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
    const subscription = (_: any, data: CronEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.CRON_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CRON_EVENT, subscription);
  },
  getCronRunHistory: (id: string) => ipcRenderer.invoke("cron:getRunHistory", id),
  clearCronRunHistory: (id: string) => ipcRenderer.invoke("cron:clearRunHistory", id),
  getCronWebhookStatus: () => ipcRenderer.invoke("cron:getWebhookStatus"),

  // Notification APIs
  listNotifications: () => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_LIST),
  addNotification: (data: {
    type: NotificationType;
    title: string;
    message: string;
    taskId?: string;
    cronJobId?: string;
    workspaceId?: string;
  }) => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_ADD, data),
  getUnreadNotificationCount: () => ipcRenderer.invoke("notification:unreadCount"),
  markNotificationRead: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_MARK_READ, id),
  markAllNotificationsRead: () => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_MARK_ALL_READ),
  deleteNotification: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_DELETE, id),
  deleteAllNotifications: () => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_DELETE_ALL),
  onNotificationEvent: (callback: (event: NotificationEvent) => void) => {
    const subscription = (_: any, data: NotificationEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.NOTIFICATION_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.NOTIFICATION_EVENT, subscription);
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
    callback: (event: { type: string; nodeId: string; node?: any; timestamp: number }) => void,
  ) => {
    const subscription = (_: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.NODE_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.NODE_EVENT, subscription);
  },

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
    const subscription = (_: Electron.IpcRendererEvent, data: any) => callback(data);
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
  getOpenCommitments: (limit?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_COMMITMENTS_GET, { limit }),
  getDueSoonCommitments: (windowHours?: number) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_COMMITMENTS_DUE_SOON, { windowHours }),

  // Memory Features APIs
  getMemoryFeaturesSettings: () => ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FEATURES_GET_SETTINGS),
  saveMemoryFeaturesSettings: (settings: MemoryFeaturesSettings) =>
    ipcRenderer.invoke(IPC_CHANNELS.MEMORY_FEATURES_SAVE_SETTINGS, settings),

  // Workspace Kit (.cowork) APIs
  getWorkspaceKitStatus: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.KIT_GET_STATUS, workspaceId) as Promise<WorkspaceKitStatus>,
  initWorkspaceKit: (request: WorkspaceKitInitRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.KIT_INIT, request) as Promise<WorkspaceKitStatus>,
  createWorkspaceKitProject: (request: WorkspaceKitProjectCreateRequest) =>
    ipcRenderer.invoke(IPC_CHANNELS.KIT_PROJECT_CREATE, request) as Promise<{
      success: boolean;
      projectId: string;
    }>,

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
  onTeamRunEvent: (callback: (event: any) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.TEAM_RUN_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TEAM_RUN_EVENT, subscription);
  },

  // Collaborative Thoughts APIs
  listTeamThoughts: (teamRunId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TEAM_THOUGHT_LIST, teamRunId),
  onTeamThoughtEvent: (callback: (event: any) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: any) => callback(data);
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
    const subscription = (_: any, data: ActivityEvent) => callback(data);
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
    const subscription = (_: any, data: MentionEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.MENTION_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MENTION_EVENT, subscription);
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
    const subscription = (_: any, data: HeartbeatEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.HEARTBEAT_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.HEARTBEAT_EVENT, subscription);
  },

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
    const subscription = (_: any, data: SubscriptionEvent) => callback(data);
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
    const subscription = (_: any, data: TaskBoardEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.TASK_BOARD_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TASK_BOARD_EVENT, subscription);
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
  saveWorktreeSettings: (settings: any) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKTREE_SAVE_SETTINGS, settings),

  // Agent Comparison APIs
  createComparison: (params: any) => ipcRenderer.invoke(IPC_CHANNELS.COMPARISON_CREATE, params),
  getComparison: (sessionId: string) => ipcRenderer.invoke(IPC_CHANNELS.COMPARISON_GET, sessionId),
  listComparisons: (workspaceId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPARISON_LIST, workspaceId),
  cancelComparison: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPARISON_CANCEL, sessionId),
  getComparisonResult: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.COMPARISON_GET_RESULT, sessionId),
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
      | "image"
      | "pptx"
      | "xlsx"
      | "html"
      | "unsupported";
    content: string | null;
    htmlContent?: string;
    ocrText?: string;
    size: number;
  };
  error?: string;
}

export type { TraySettings };

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
  selectFolder: () => Promise<string | null>;
  selectFiles: () => Promise<
    Array<{ path: string; name: string; size: number; mimeType?: string }>
  >;
  openFile: (filePath: string, workspacePath?: string) => Promise<string>;
  showInFinder: (filePath: string, workspacePath?: string) => Promise<void>;
  readFileForViewer: (
    filePath: string,
    workspacePath?: string,
    options?: ReadFileForViewerOptions,
  ) => Promise<FileViewerResult>;
  importFilesToWorkspace: (data: {
    workspaceId: string;
    files: string[];
  }) => Promise<Array<{ relativePath: string; fileName: string; size: number; mimeType?: string }>>;
  importDataToWorkspace: (data: {
    workspaceId: string;
    files: Array<{ name: string; data: string; mimeType?: string }>;
  }) => Promise<Array<{ relativePath: string; fileName: string; size: number; mimeType?: string }>>;
  openExternal: (url: string) => Promise<void>;
  openSystemSettings: (
    target: "microphone" | "dictation",
  ) => Promise<{ success: boolean; error?: string }>;
  createTask: (data: any) => Promise<any>;
  getTask: (id: string) => Promise<any>;
  listTasks: () => Promise<any[]>;
  exportTasksJson: (query?: any) => Promise<any>;
  toggleTaskPin: (taskId: string) => Promise<any>;
  cancelTask: (id: string) => Promise<void>;
  wrapUpTask: (id: string) => Promise<void>;
  pauseTask: (id: string) => Promise<void>;
  resumeTask: (id: string) => Promise<void>;
  sendStdin: (taskId: string, input: string) => Promise<boolean>;
  killCommand: (taskId: string, force?: boolean) => Promise<boolean>;
  renameTask: (id: string, title: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  onTaskEvent: (callback: (event: any) => void) => () => void;
  getTaskEvents: (taskId: string) => Promise<any[]>;
  sendMessage: (taskId: string, message: string, images?: ImageAttachment[]) => Promise<void>;
  createWorkspace: (data: any) => Promise<Workspace>;
  listWorkspaces: () => Promise<Workspace[]>;
  selectWorkspace: (id: string) => Promise<Workspace>;
  getTempWorkspace: (options?: { createNew?: boolean }) => Promise<Workspace | null>;
  touchWorkspace: (id: string) => Promise<any>;
  updateWorkspacePermissions: (
    id: string,
    permissions: { shell?: boolean; network?: boolean },
  ) => Promise<any>;
  respondToApproval: (data: any) => Promise<void>;
  setSessionAutoApprove: (enabled: boolean) => Promise<void>;
  getSessionAutoApprove: () => Promise<boolean>;
  listArtifacts: (taskId: string) => Promise<any[]>;
  previewArtifact: (id: string) => Promise<any>;
  listSkills: () => Promise<any[]>;
  getSkill: (id: string) => Promise<any>;
  // LLM Settings
  getLLMSettings: () => Promise<any>;
  saveLLMSettings: (settings: any) => Promise<{ success: boolean }>;
  testLLMProvider: (config: any) => Promise<{ success: boolean; error?: string }>;
  getLLMModels: () => Promise<Array<{ key: string; displayName: string; description: string }>>;
  getLLMConfigStatus: () => Promise<{
    currentProvider: LLMProviderType;
    currentModel: string;
    providers: Array<{
      type: LLMProviderType;
      name: string;
      configured: boolean;
      source?: string;
    }>;
    models: Array<{ key: string; displayName: string; description: string }>;
  }>;
  setLLMModel: (modelKey: string) => Promise<{ success: boolean }>;
  getProviderModels: (
    providerType: string,
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
  openaiOAuthStart: () => Promise<{ success: boolean; error?: string }>;
  openaiOAuthLogout: () => Promise<{ success: boolean }>;
  getBedrockModels: (config?: {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    profile?: string;
  }) => Promise<Array<{ id: string; name: string; provider: string; description: string }>>;
  // Gateway / Channel APIs
  getGatewayChannels: () => Promise<any[]>;
  addGatewayChannel: (data: AddChannelRequest) => Promise<any>;
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
  getGatewayUsers: (channelId: string) => Promise<any[]>;
  grantGatewayAccess: (channelId: string, userId: string, displayName?: string) => Promise<void>;
  revokeGatewayAccess: (channelId: string, userId: string) => Promise<void>;
  generateGatewayPairing: (
    channelId: string,
    userId: string,
    displayName?: string,
  ) => Promise<string>;
  onGatewayMessage: (callback: (data: any) => void) => () => void;
  onGatewayUsersUpdated: (
    callback: (data: { channelId: string; channelType: string }) => void,
  ) => () => void;
  // WhatsApp-specific APIs
  getWhatsAppInfo: () => Promise<{ qrCode?: string; phoneNumber?: string; status?: string }>;
  whatsAppLogout: () => Promise<void>;
  onWhatsAppQRCode: (callback: (event: any, qr: string) => void) => void;
  onWhatsAppConnected: (callback: () => void) => void;
  onWhatsAppStatus: (
    callback: (event: any, data: { status: string; error?: string }) => void,
  ) => void;
  // Search Settings
  getSearchSettings: () => Promise<{
    primaryProvider: "tavily" | "brave" | "serpapi" | "google" | null;
    fallbackProvider: "tavily" | "brave" | "serpapi" | "google" | null;
  }>;
  saveSearchSettings: (settings: any) => Promise<{ success: boolean }>;
  getSearchConfigStatus: () => Promise<{
    primaryProvider: "tavily" | "brave" | "serpapi" | "google" | null;
    fallbackProvider: "tavily" | "brave" | "serpapi" | "google" | null;
    providers: Array<{
      type: "tavily" | "brave" | "serpapi" | "google";
      name: string;
      description: string;
      configured: boolean;
      supportedTypes: Array<"web" | "news" | "images">;
    }>;
    isConfigured: boolean;
  }>;
  testSearchProvider: (providerType: string) => Promise<{ success: boolean; error?: string }>;
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
  }>;
  saveXSettings: (settings: any) => Promise<{ success: boolean }>;
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
  }>;
  // Notion Settings
  getNotionSettings: () => Promise<{
    enabled: boolean;
    apiKey?: string;
    notionVersion?: string;
    timeoutMs?: number;
  }>;
  saveNotionSettings: (settings: any) => Promise<{ success: boolean }>;
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
  saveBoxSettings: (settings: any) => Promise<{ success: boolean }>;
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
  saveOneDriveSettings: (settings: any) => Promise<{ success: boolean }>;
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
  saveGoogleWorkspaceSettings: (settings: any) => Promise<{ success: boolean }>;
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
  }) => Promise<{
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    tokenType?: string;
    scopes?: string[];
  }>;
  // Dropbox Settings
  getDropboxSettings: () => Promise<{
    enabled: boolean;
    accessToken?: string;
    timeoutMs?: number;
  }>;
  saveDropboxSettings: (settings: any) => Promise<{ success: boolean }>;
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
  saveSharePointSettings: (settings: any) => Promise<{ success: boolean }>;
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
  checkForUpdates: () => Promise<{
    available: boolean;
    currentVersion: string;
    latestVersion: string;
    releaseNotes?: string;
    releaseUrl?: string;
    publishedAt?: string;
    updateMode: "git" | "npm" | "electron-updater";
  }>;
  downloadUpdate: (updateInfo: any) => Promise<{ success: boolean }>;
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
  getGuardrailSettings: () => Promise<{
    maxTokensPerTask: number;
    tokenBudgetEnabled: boolean;
    maxCostPerTask: number;
    costBudgetEnabled: boolean;
    blockDangerousCommands: boolean;
    customBlockedPatterns: string[];
    autoApproveTrustedCommands: boolean;
    trustedCommandPatterns: string[];
    maxFileSizeMB: number;
    fileSizeLimitEnabled: boolean;
    enforceAllowedDomains: boolean;
    allowedDomains: string[];
    maxIterationsPerTask: number;
    iterationLimitEnabled: boolean;
  }>;
  saveGuardrailSettings: (settings: any) => Promise<{ success: boolean }>;
  getGuardrailDefaults: () => Promise<{
    maxTokensPerTask: number;
    tokenBudgetEnabled: boolean;
    maxCostPerTask: number;
    costBudgetEnabled: boolean;
    blockDangerousCommands: boolean;
    customBlockedPatterns: string[];
    autoApproveTrustedCommands: boolean;
    trustedCommandPatterns: string[];
    maxFileSizeMB: number;
    fileSizeLimitEnabled: boolean;
    enforceAllowedDomains: boolean;
    allowedDomains: string[];
    maxIterationsPerTask: number;
    iterationLimitEnabled: boolean;
  }>;
  // Appearance Settings
  getAppearanceSettings: () => Promise<{
    themeMode: "light" | "dark" | "system";
    visualTheme: "terminal" | "warm" | "oblivion";
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
    uiDensity?: "focused" | "full";
    language?: string;
    disclaimerAccepted?: boolean;
    onboardingCompleted?: boolean;
    onboardingCompletedAt?: string;
    assistantName?: string;
  }>;
  saveAppearanceSettings: (settings: {
    themeMode?: "light" | "dark" | "system";
    visualTheme?: "terminal" | "warm" | "oblivion";
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
    uiDensity?: "focused" | "full";
    language?: string;
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
  onPersonalitySettingsChanged: (callback: (settings: any) => void) => () => void;
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
  // Skill Registry (SkillHub) APIs
  searchSkillRegistry: (
    query: string,
    options?: { page?: number; pageSize?: number },
  ) => Promise<SkillSearchResult>;
  getSkillDetails: (skillId: string) => Promise<SkillRegistryEntry | null>;
  installSkillFromRegistry: (
    skillId: string,
    version?: string,
  ) => Promise<{ success: boolean; skill?: CustomSkill; error?: string }>;
  updateSkillFromRegistry: (
    skillId: string,
    version?: string,
  ) => Promise<{ success: boolean; skill?: CustomSkill; error?: string }>;
  updateAllSkills: () => Promise<{ updated: string[]; failed: string[] }>;
  uninstallSkill: (skillId: string) => Promise<{ success: boolean; error?: string }>;
  listManagedSkills: () => Promise<CustomSkill[]>;
  checkSkillUpdates: (
    skillId: string,
  ) => Promise<{ hasUpdate: boolean; currentVersion: string | null; latestVersion: string | null }>;
  getSkillStatus: () => Promise<SkillStatusReport>;
  getEligibleSkills: () => Promise<CustomSkill[]>;
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
  startConnectorOAuth: (payload: {
    provider: "salesforce" | "jira" | "hubspot" | "zendesk";
    clientId: string;
    clientSecret?: string;
    scopes?: string[];
    loginUrl?: string;
    subdomain?: string;
  }) => Promise<{
    provider: "salesforce" | "jira" | "hubspot" | "zendesk";
    accessToken: string;
    refreshToken?: string;
    expiresIn?: number;
    tokenType?: string;
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
  // Conway Terminal
  conwayGetStatus: () => Promise<ConwaySetupStatus>;
  conwayGetSettings: () => Promise<ConwaySettings>;
  conwaySaveSettings: (settings: ConwaySettings) => Promise<{ success: boolean }>;
  conwaySetup: () => Promise<ConwaySetupStatus>;
  conwayGetBalance: () => Promise<ConwayCreditsBalance | null>;
  conwayGetWallet: () => Promise<ConwayWalletInfo | null>;
  conwayGetCreditHistory: () => Promise<ConwayCreditHistoryEntry[]>;
  conwayConnect: () => Promise<{ success: boolean }>;
  conwayDisconnect: () => Promise<{ success: boolean }>;
  conwayReset: () => Promise<{ success: boolean }>;
  conwayWalletRestore: () => Promise<{ success: boolean; address?: string }>;
  conwayWalletVerify: () => Promise<{ status: string; address?: string }>;
  onConwayStatusChange: (callback: (status: ConwaySetupStatus) => void) => () => void;
  // Built-in Tools Settings
  getBuiltinToolsSettings: () => Promise<BuiltinToolsSettings>;
  saveBuiltinToolsSettings: (settings: BuiltinToolsSettings) => Promise<{ success: boolean }>;
  getBuiltinToolsCategories: () => Promise<Record<string, string[]>>;
  // Tray (Menu Bar)
  getTraySettings: () => Promise<TraySettings>;
  saveTraySettings: (settings: Partial<TraySettings>) => Promise<{ success: boolean }>;
  onTrayNewTask: (callback: () => void) => () => void;
  onTraySelectWorkspace: (callback: (event: any, workspaceId: string) => void) => () => void;
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
  // Notifications
  listNotifications: () => Promise<AppNotification[]>;
  addNotification: (data: {
    type: NotificationType;
    title: string;
    message: string;
    taskId?: string;
    cronJobId?: string;
    workspaceId?: string;
  }) => Promise<AppNotification | null>;
  getUnreadNotificationCount: () => Promise<number>;
  markNotificationRead: (id: string) => Promise<AppNotification | null>;
  markAllNotificationsRead: () => Promise<void>;
  deleteNotification: (id: string) => Promise<boolean>;
  deleteAllNotifications: () => Promise<void>;
  onNotificationEvent: (callback: (event: NotificationEvent) => void) => () => void;
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
  regenerateControlPlaneToken: () => Promise<{ ok: boolean; token?: string; error?: string }>;
  onControlPlaneEvent: (callback: (event: ControlPlaneEvent) => void) => () => void;

  // Tailscale
  checkTailscaleAvailability: () => Promise<TailscaleAvailability>;
  getTailscaleStatus: () => Promise<{ settings: any; exposure: any }>;
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
  }) => Promise<any[]>;
  updateRelationshipMemory: (data: {
    id: string;
    text?: string;
    confidence?: number;
    status?: "open" | "done";
    dueAt?: number | null;
  }) => Promise<any | null>;
  deleteRelationshipMemory: (id: string) => Promise<{ success: boolean }>;
  getOpenCommitments: (limit?: number) => Promise<any[]>;
  getDueSoonCommitments: (windowHours?: number) => Promise<{ items: any[]; reminderText: string }>;

  // Memory Features (global toggles)
  getMemoryFeaturesSettings: () => Promise<MemoryFeaturesSettings>;
  saveMemoryFeaturesSettings: (settings: MemoryFeaturesSettings) => Promise<{ success: boolean }>;

  // Workspace Kit (.cowork)
  getWorkspaceKitStatus: (workspaceId: string) => Promise<WorkspaceKitStatus>;
  initWorkspaceKit: (request: WorkspaceKitInitRequest) => Promise<WorkspaceKitStatus>;
  createWorkspaceKitProject: (
    request: WorkspaceKitProjectCreateRequest,
  ) => Promise<{ success: boolean; projectId: string }>;

  // ChatGPT Import
  importChatGPT: (options: ChatGPTImportOptions) => Promise<ChatGPTImportResult>;
  onChatGPTImportProgress: (callback: (progress: ChatGPTImportProgress) => void) => () => void;
  cancelChatGPTImport: () => Promise<{ cancelled: boolean }>;

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
  onTeamRunEvent: (callback: (event: any) => void) => () => void;

  // Collaborative Thoughts
  listTeamThoughts: (teamRunId: string) => Promise<AgentThought[]>;
  onTeamThoughtEvent: (callback: (event: any) => void) => () => void;
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
  getHeartbeatConfig: (agentRoleId: string) => Promise<
    | {
        heartbeatEnabled: boolean;
        heartbeatIntervalMinutes: number;
        heartbeatStaggerOffset: number;
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
    },
  ) => Promise<any>;
  triggerHeartbeat: (agentRoleId: string) => Promise<HeartbeatResult>;
  getHeartbeatStatus: (agentRoleId: string) => Promise<
    | {
        heartbeatEnabled: boolean;
        heartbeatStatus: HeartbeatStatus;
        lastHeartbeatAt?: number;
        nextHeartbeatAt?: number;
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
  // Task Board APIs
  moveTaskToColumn: (taskId: string, column: TaskBoardColumn) => Promise<any>;
  setTaskPriority: (taskId: string, priority: number) => Promise<any>;
  setTaskDueDate: (taskId: string, dueDate: number | null) => Promise<any>;
  setTaskEstimate: (taskId: string, estimatedMinutes: number | null) => Promise<any>;
  addTaskLabel: (taskId: string, labelId: string) => Promise<any>;
  removeTaskLabel: (taskId: string, labelId: string) => Promise<any>;
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
  getWorktreeInfo: (taskId: string) => Promise<any>;
  listWorktrees: (workspaceId: string) => Promise<any[]>;
  mergeWorktree: (taskId: string) => Promise<any>;
  cleanupWorktree: (taskId: string) => Promise<{ success: boolean }>;
  getWorktreeDiff: (taskId: string) => Promise<any>;
  getWorktreeSettings: () => Promise<any>;
  saveWorktreeSettings: (settings: any) => Promise<{ success: boolean; error?: string }>;

  // Agent Comparison APIs
  createComparison: (params: any) => Promise<any>;
  getComparison: (sessionId: string) => Promise<any>;
  listComparisons: (workspaceId: string) => Promise<any[]>;
  cancelComparison: (sessionId: string) => Promise<{ success: boolean }>;
  getComparisonResult: (sessionId: string) => Promise<any>;
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
