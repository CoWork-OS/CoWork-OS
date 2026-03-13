import path from "path";
import os from "os";
import * as fs from "fs/promises";
import * as fsSync from "fs";
import { randomUUID } from "crypto";
import { pathToFileURL } from "url";
import {
  app,
  BrowserWindow,
  ipcMain,
  dialog,
  session,
  shell,
  Notification,
  nativeTheme,
} from "electron";
import mime from "mime-types";
import { DatabaseManager } from "./database/schema";
import { SecureSettingsRepository } from "./database/SecureSettingsRepository";
import {
  setupIpcHandlers,
  getNotificationService,
  setHeartbeatWakeSubmitter,
} from "./ipc/handlers";
import { setupMissionControlHandlers } from "./ipc/mission-control-handlers";
import { setupPersonaTemplateHandlers } from "./ipc/persona-template-handlers";
import { setupPluginPackHandlers } from "./ipc/plugin-pack-handlers";
import { setupPluginDistributionHandlers } from "./ipc/plugin-distribution-handlers";
import { setupAdminPolicyHandlers } from "./ipc/admin-policy-handlers";
import { getPersonaTemplateService } from "./agents/PersonaTemplateService";
import { setupWorktreeHandlers } from "./ipc/worktree-handlers";
import { ComparisonService } from "./git/ComparisonService";
import { TaskSubscriptionRepository } from "./agents/TaskSubscriptionRepository";
import { StandupReportService } from "./reports/StandupReportService";
import {
  HeartbeatService,
  HeartbeatServiceDeps,
  setHeartbeatService,
} from "./agents/HeartbeatService";
import { AgentRoleRepository } from "./agents/AgentRoleRepository";
import { MentionRepository } from "./agents/MentionRepository";
import { ActivityRepository } from "./activity/ActivityRepository";
import { WorkingStateRepository } from "./agents/WorkingStateRepository";
import { CrossSignalService } from "./agents/CrossSignalService";
import { FeedbackService } from "./agents/FeedbackService";
import { LoreService } from "./agents/LoreService";
import { ProactiveSuggestionsService } from "./agent/ProactiveSuggestionsService";
import { AgentDaemon } from "./agent/daemon";
import {
  ChannelMessageRepository,
  ChannelRepository,
  ChannelUserRepository,
  TaskEventRepository,
  TaskRepository,
  WorkspaceRepository,
} from "./database/repositories";
import { LLMProviderFactory } from "./agent/llm";
import { SearchProviderFactory } from "./agent/search";
import { ChannelGateway } from "./gateway";
import { formatChatTranscriptForPrompt } from "./gateway/chat-transcript";
import { updateManager } from "./updater";
import { importProcessEnvToSettings, migrateEnvToSettings } from "./utils/env-migration";
import {
  TEMP_WORKSPACE_ID,
  TEMP_WORKSPACE_ROOT_DIR_NAME,
  isTempWorkspaceId,
} from "../shared/types";
import { GuardrailManager } from "./guardrails/guardrail-manager";
import { AppearanceManager } from "./settings/appearance-manager";
import { MemoryFeaturesManager } from "./settings/memory-features-manager";
import { PersonalityManager } from "./settings/personality-manager";
import { MCPClientManager } from "./mcp/client/MCPClientManager";
import { InfraManager } from "./infra/infra-manager";
import { trayManager } from "./tray";
import { CronService, setCronService, getCronStorePath } from "./cron";
import { resolveTaskResultText } from "./cron/result-text";
import {
  StrategicPlannerService,
  setStrategicPlannerService,
} from "./control-plane/StrategicPlannerService";
import { attachControlPlaneTaskLifecycleSync } from "./control-plane/task-run-sync";
import {
  buildManagedScheduledWorkspacePath,
  createScheduledRunDirectory,
  isManagedScheduledWorkspacePath,
} from "./cron/workspace-context";
import { MemoryService } from "./memory/MemoryService";
import { KnowledgeGraphService } from "./knowledge-graph/KnowledgeGraphService";
import {
  ControlPlaneSettingsManager,
  setupControlPlaneHandlers,
  shutdownControlPlane,
  startControlPlaneFromSettings,
} from "./control-plane";
import { sanitizeTaskMessageParams } from "./control-plane/sanitize";
import {
  getArgValue,
  getEnvSettingsImportModeFromArgsOrEnv,
  isHeadlessMode,
  shouldEnableControlPlaneFromArgsOrEnv,
  shouldImportEnvSettingsFromArgsOrEnv,
  shouldPrintControlPlaneTokenFromArgsOrEnv,
} from "./utils/runtime-mode";
import { getUserDataDir } from "./utils/user-data-dir";
// Live Canvas feature
import { registerCanvasScheme, registerCanvasProtocol, CanvasManager } from "./canvas";
import { setupCanvasHandlers, cleanupCanvasHandlers } from "./ipc/canvas-handlers";
import { pruneTempWorkspaces } from "./utils/temp-workspace";
import { getActiveTempWorkspaceLeases } from "./utils/temp-workspace-lease";
import { getPluginRegistry } from "./extensions/registry";
import { getCustomSkillLoader } from "./agent/custom-skill-loader";
import { pruneTempSandboxProfiles } from "./utils/temp-sandbox-profiles";
// Gap features: triggers, briefing, file hub, web access
import { EventTriggerService } from "./triggers/EventTriggerService";
import { setupTriggerHandlers } from "./ipc/trigger-handlers";
import { DailyBriefingService } from "./briefing/DailyBriefingService";
import { syncDailyBriefingCronJob, DAILY_BRIEFING_MARKER } from "./briefing/briefing-scheduler";
import {
  readWorkspaceOpenLoops,
  readWorkspacePriorities,
} from "./briefing/workspace-briefing-context";
import { setupBriefingHandlers } from "./ipc/briefing-handlers";
import { setupImprovementHandlers } from "./ipc/improvement-handlers";
import { FileHubService } from "./file-hub/FileHubService";
import { setupFileHubHandlers } from "./ipc/file-hub-handlers";
import { WebAccessServer } from "./web-server/WebAccessServer";
import { DEFAULT_WEB_ACCESS_CONFIG, type WebAccessConfig } from "./web-server/types";
import { setupWebAccessHandlers } from "./ipc/web-access-handlers";
import { ManagedAccountManager, type ManagedAccountStatus } from "./accounts/managed-account-manager";
import { initializeXMentionBridgeService, XMentionBridgeService } from "./x-mentions";
import { AmbientMonitoringService } from "./monitoring/AmbientMonitoringService";
import { ImprovementCandidateService } from "./improvement/ImprovementCandidateService";
import { ImprovementLoopService } from "./improvement/ImprovementLoopService";
import { createLogger } from "./utils/logger";

let mainWindow: BrowserWindow | null = null;
let dbManager: DatabaseManager;
let agentDaemon: AgentDaemon;
let channelGateway: ChannelGateway;
let cronService: CronService | null = null;
let dailyBriefingService: DailyBriefingService | null = null;
let ambientMonitoringService: AmbientMonitoringService | null = null;
let improvementLoopService: ImprovementLoopService | null = null;
let crossSignalService: CrossSignalService | null = null;
let feedbackService: FeedbackService | null = null;
let loreService: LoreService | null = null;
let xMentionBridgeService: XMentionBridgeService | null = null;
let strategicPlannerService: StrategicPlannerService | null = null;
let detachTaskLifecycleSync: (() => void) | null = null;
let tempWorkspacePruneTimer: NodeJS.Timeout | null = null;
let tempSandboxProfilePruneTimer: NodeJS.Timeout | null = null;
const TEMP_WORKSPACE_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const TEMP_SANDBOX_PROFILE_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;
const managedBriefingRuns = new Map<
  string,
  {
    text: string;
    delivered: boolean;
    generatedAt: number;
  }
>();

const HEADLESS = isHeadlessMode();
const FORCE_ENABLE_CONTROL_PLANE = shouldEnableControlPlaneFromArgsOrEnv();
const PRINT_CONTROL_PLANE_TOKEN = shouldPrintControlPlaneTokenFromArgsOrEnv();
const IMPORT_ENV_SETTINGS = shouldImportEnvSettingsFromArgsOrEnv();
const IMPORT_ENV_SETTINGS_MODE = getEnvSettingsImportModeFromArgsOrEnv();
const logger = createLogger("Main");
const TRANSIENT_MAIN_PROCESS_ERROR_RE =
  /(ECONNRESET|ETIMEDOUT|EPIPE|ENOTFOUND|ENETUNREACH|EHOSTUNREACH|socket hang up|Timed Out|Connection Closed)/i;
let processErrorGuardsInstalled = false;

function toErrorMessage(reason: unknown): string {
  if (reason instanceof Error) {
    return `${reason.name}: ${reason.message}`;
  }
  if (typeof reason === "string") {
    return reason;
  }
  try {
    return JSON.stringify(reason);
  } catch {
    return String(reason);
  }
}

function isTransientMainProcessError(reason: unknown): boolean {
  return TRANSIENT_MAIN_PROCESS_ERROR_RE.test(toErrorMessage(reason));
}

function installProcessErrorGuards(): void {
  if (processErrorGuardsInstalled) {
    return;
  }
  processErrorGuardsInstalled = true;

  process.on("unhandledRejection", (reason) => {
    if (isTransientMainProcessError(reason)) {
      logger.warn(`Suppressed transient unhandledRejection: ${toErrorMessage(reason)}`);
      return;
    }
    logger.error("unhandledRejection:", reason);
  });

  process.on("uncaughtException", (error) => {
    if (isTransientMainProcessError(error)) {
      logger.warn(`Suppressed transient uncaughtException: ${toErrorMessage(error)}`);
      return;
    }
    logger.error("uncaughtException:", error);
  });
}

installProcessErrorGuards();

// Suppress GPU-related Chromium errors that occur with transparent windows and vibrancy
// These are cosmetic errors that don't affect functionality
app.commandLine.appendSwitch("disable-gpu-driver-bug-workarounds");
app.commandLine.appendSwitch("enable-gpu-rasterization");
app.commandLine.appendSwitch("ignore-gpu-blocklist");

// Register canvas:// protocol scheme (must be called before app.ready)
registerCanvasScheme();

// Ensure only one CoWork OS instance runs at a time.
// Without this, a second instance can mark in-flight tasks as "orphaned" (failed) and contend on the DB.
const gotTheLock = app.requestSingleInstanceLock();
if (!gotTheLock) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (HEADLESS) return;
    // Focus the existing window instead of starting a second instance.
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
      return;
    }
    // If the window was closed (but app kept running), recreate it.
    createWindow();
  });

  function createWindow() {
    const isMac = process.platform === "darwin";
    let useMacVibrancy = isMac && !nativeTheme.prefersReducedTransparency;

    // Determine initial background color when the window should be opaque.
    let windowBgColor = "#1a1a1c";
    try {
      const saved = AppearanceManager.loadSettings();
      if (isMac && saved.transparencyEffectsEnabled === false) {
        useMacVibrancy = false;
      }
      const mode = saved.themeMode || "dark";
      const isLight =
        mode === "light" || (mode === "system" && nativeTheme.shouldUseDarkColors === false);
      if (isLight) windowBgColor = "#f0f0f2";
    } catch {
      // Fallback to dark if settings aren't available yet
    }

    mainWindow = new BrowserWindow({
      width: 1600,
      height: 1000,
      minWidth: 1200,
      minHeight: 800,
      center: true,
      titleBarStyle: isMac ? "hiddenInset" : "hidden",
      ...(useMacVibrancy
        ? {
            vibrancy: "under-window" as const,
            visualEffectState: "active" as const,
            transparent: true,
            backgroundColor: "#00000000",
          }
        : {
            transparent: false,
            backgroundColor: windowBgColor,
          }),
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: false, // Preload needs Node built-ins (path/fs/os/crypto)
        webviewTag: true, // Enable webview for canvas interactive mode
        preload: path.join(__dirname, "preload.js"),
      },
    });

    // Load the app
    if (process.env.NODE_ENV === "development") {
      mainWindow.loadURL("http://localhost:5173");
      mainWindow.webContents.openDevTools();
    } else {
      const rendererDir = path.join(__dirname, "../../renderer");
      const rendererIndex = path.join(rendererDir, "index.html");

      if (!fsSync.existsSync(rendererIndex)) {
        console.error(
          `[Main] Renderer entry not found: ${rendererIndex}. ` +
            "The installed package is missing UI assets."
        );
        const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>CoWork OS - Installation Error</title>
  <style>
    body { font-family: Segoe UI, Arial, sans-serif; margin: 0; background: #111215; color: #f3f4f6; }
    .wrap { max-width: 760px; margin: 40px auto; padding: 0 20px; }
    h1 { font-size: 22px; margin-bottom: 8px; }
    p { color: #d1d5db; line-height: 1.6; }
    pre { background: #0a0a0c; border: 1px solid #27272a; padding: 12px; overflow-x: auto; border-radius: 8px; }
  </style>
</head>
<body>
  <div class="wrap">
    <h1>CoWork OS could not load UI assets</h1>
    <p>The installed npm package is missing <code>dist/renderer/index.html</code>.</p>
    <p>Reinstall the latest release, or ask the maintainer to republish with built renderer assets.</p>
    <pre>${rendererIndex}</pre>
  </div>
</body>
</html>`;
        mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`);
      } else {
        mainWindow.loadFile(rendererIndex);
      }
    }

    mainWindow.on("closed", () => {
      mainWindow = null;
    });

    // Open external links in the system browser instead of inside the app
    mainWindow.webContents.setWindowOpenHandler(({ url }) => {
      // Open all new window requests in external browser
      shell.openExternal(url);
      return { action: "deny" };
    });

    mainWindow.webContents.on("will-navigate", (event, url) => {
      // Allow navigation to the app itself (dev server or file://), block external URLs
      const appUrl =
        process.env.NODE_ENV === "development"
          ? "http://localhost:5173"
          : `file://${path.join(__dirname, "../../renderer")}`;

      if (!url.startsWith(appUrl)) {
        event.preventDefault();
        shell.openExternal(url);
      }
    });
  }

  app.whenReady().then(async () => {
    const startupStartedAt = Date.now();
    const logPhase = (name: string, phaseStartedAt: number): void => {
      logger.debug(`Startup phase "${name}" completed in ${Date.now() - phaseStartedAt} ms`);
    };
    let mcpStartupSummary = { enabled: 0, attempted: 0, connected: 0, failed: 0 };
    let pluginStartupSummary = { loaded: 0, enabled: 0 };

    // Allow overriding userData path for headless/VPS deployments (e.g., mount a persistent volume).
    const userDataOverride = process.env.COWORK_USER_DATA_DIR || getArgValue("--user-data-dir");
    if (
      userDataOverride &&
      typeof userDataOverride === "string" &&
      userDataOverride.trim().length > 0
    ) {
      const resolved = path.resolve(userDataOverride.trim());
      try {
        await fs.mkdir(resolved, { recursive: true });
        app.setPath("userData", resolved);
        logger.info(`Using userData directory override: ${resolved}`);
      } catch (error) {
        logger.warn("Failed to apply userData directory override:", error);
      }
    }

    // Set up Content Security Policy for production builds
    if (process.env.NODE_ENV !== "development") {
      const appRoot = pathToFileURL(path.join(__dirname, "../../renderer")).toString();
      session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
        if (!details.url.startsWith(appRoot)) {
          callback({ responseHeaders: details.responseHeaders });
          return;
        }
        callback({
          responseHeaders: {
            ...details.responseHeaders,
            "Content-Security-Policy": [
              "default-src 'self'; " +
                "script-src 'self'; " +
                "style-src 'self' 'unsafe-inline'; " + // Allow inline styles for React
                "img-src 'self' data: https:; " + // Allow images from self, data URIs, and HTTPS
                "font-src 'self' data:; " + // Allow fonts from self and data URIs
                "connect-src 'self' https:; " + // Allow API calls to HTTPS endpoints
                "worker-src 'self' blob:; " + // Allow web workers from blob URLs
                "frame-ancestors 'none'; " + // Prevent embedding in iframes
                "form-action 'self';", // Restrict form submissions
            ],
          },
        });
      });
    }

    // Initialize database first - required for SecureSettingsRepository
    const coreInitStartedAt = Date.now();
    dbManager = new DatabaseManager();
    const tempWorkspaceRoot = path.join(os.tmpdir(), TEMP_WORKSPACE_ROOT_DIR_NAME);
    const runTempWorkspacePrune = () => {
      try {
        pruneTempWorkspaces({
          db: dbManager.getDatabase(),
          tempWorkspaceRoot,
          protectedWorkspaceIds: getActiveTempWorkspaceLeases(),
        });
      } catch (error) {
        logger.warn("Failed to prune temp workspaces:", error);
      }
    };
    runTempWorkspacePrune();
    tempWorkspacePruneTimer = setInterval(runTempWorkspacePrune, TEMP_WORKSPACE_PRUNE_INTERVAL_MS);
    tempWorkspacePruneTimer.unref();
    const runTempSandboxProfilePrune = () => {
      try {
        pruneTempSandboxProfiles();
      } catch (error) {
        logger.warn("Failed to prune temp sandbox profiles:", error);
      }
    };
    runTempSandboxProfilePrune();
    tempSandboxProfilePruneTimer = setInterval(
      runTempSandboxProfilePrune,
      TEMP_SANDBOX_PROFILE_PRUNE_INTERVAL_MS,
    );
    tempSandboxProfilePruneTimer.unref();

    // Initialize secure settings repository for encrypted settings storage
    // This MUST be done before provider factories so they can migrate legacy settings
    new SecureSettingsRepository(dbManager.getDatabase());
    logger.info("SecureSettingsRepository initialized");

    // Initialize provider factories (loads settings from disk, migrates legacy files)
    LLMProviderFactory.initialize();
    SearchProviderFactory.initialize();
    GuardrailManager.initialize();
    AppearanceManager.initialize();
    PersonalityManager.initialize();
    MemoryFeaturesManager.initialize();
    logPhase("core-init", coreInitStartedAt);

    // Migrate .env configuration to Settings (one-time upgrade path)
    const migrationResult = await migrateEnvToSettings();

    // Optional: import process.env keys into Settings (explicit opt-in; useful for headless/server deployments).
    if (IMPORT_ENV_SETTINGS) {
      const importResult = await importProcessEnvToSettings({ mode: IMPORT_ENV_SETTINGS_MODE });
      if (importResult.migrated && importResult.migratedKeys.length > 0) {
        logger.info(
          `Imported credentials from process.env (${IMPORT_ENV_SETTINGS_MODE}): ${importResult.migratedKeys.join(", ")}`,
        );
      }
      if (importResult.error) {
        logger.warn("Failed to import credentials from process.env:", importResult.error);
      }
    }

    // Headless deployments commonly forget to configure LLM creds; warn early with a concrete next step.
    if (HEADLESS) {
      try {
        const llmSettings = LLMProviderFactory.loadSettings();
        const hasAnyLlmCreds = !!(
          llmSettings?.anthropic?.apiKey ||
          llmSettings?.openai?.apiKey ||
          llmSettings?.openai?.accessToken ||
          llmSettings?.gemini?.apiKey ||
          llmSettings?.openrouter?.apiKey ||
          llmSettings?.groq?.apiKey ||
          llmSettings?.xai?.apiKey ||
          llmSettings?.kimi?.apiKey ||
          llmSettings?.azure?.apiKey ||
          llmSettings?.bedrock?.accessKeyId ||
          llmSettings?.bedrock?.profile
        );
        if (!hasAnyLlmCreds) {
          logger.warn(
            "No LLM credentials configured. In headless mode, set COWORK_IMPORT_ENV_SETTINGS=1 and an LLM key (e.g. OPENAI_API_KEY or ANTHROPIC_API_KEY), then restart.",
          );
        }
      } catch (error) {
        logger.warn("Failed to check LLM credential configuration:", error);
      }
    }

    // Initialize agent daemon
    agentDaemon = new AgentDaemon(dbManager);
    await agentDaemon.initialize();
    detachTaskLifecycleSync = attachControlPlaneTaskLifecycleSync({
      agentDaemon,
      db: dbManager.getDatabase(),
      log: (...args) => logger.warn(...args),
    });

    // Optional: bootstrap a default workspace on startup for headless/server deployments.
    // This makes a fresh VPS instance usable without first opening the desktop UI.
    try {
      const bootstrapPathRaw =
        process.env.COWORK_BOOTSTRAP_WORKSPACE_PATH || getArgValue("--bootstrap-workspace");
      if (
        bootstrapPathRaw &&
        typeof bootstrapPathRaw === "string" &&
        bootstrapPathRaw.trim().length > 0
      ) {
        const raw = bootstrapPathRaw.trim();
        const homeDir = process.env.HOME || process.env.USERPROFILE;
        const expanded =
          raw.startsWith("~/") && homeDir
            ? path.join(homeDir, raw.slice(2))
            : raw;
        const workspacePath = path.resolve(expanded);
        await fs.mkdir(workspacePath, { recursive: true });

        const existing = agentDaemon.getWorkspaceByPath(workspacePath);
        if (!existing) {
          const nameFromEnv =
            process.env.COWORK_BOOTSTRAP_WORKSPACE_NAME ||
            getArgValue("--bootstrap-workspace-name");
          const workspaceName =
            typeof nameFromEnv === "string" && nameFromEnv.trim().length > 0
              ? nameFromEnv.trim()
              : path.basename(workspacePath) || "Workspace";

          const ws = agentDaemon.createWorkspace(workspaceName, workspacePath);
          logger.info(`Bootstrapped workspace: ${ws.id} (${ws.name}) at ${ws.path}`);
        } else {
          logger.info(
            `Bootstrap workspace exists: ${existing.id} (${existing.name}) at ${existing.path}`,
          );
        }
      }
    } catch (error) {
      logger.warn("Failed to bootstrap workspace:", error);
    }

    // Initialize cross-agent signal tracker (best-effort; do not block app startup)
    try {
      crossSignalService = new CrossSignalService(dbManager.getDatabase());
      await crossSignalService.start(agentDaemon);
      logger.info("CrossSignalService initialized");
    } catch (error) {
      logger.error("Failed to initialize CrossSignalService:", error);
    }

    // Initialize feedback logger (best-effort; persists approve/reject/edit/next into workspace kit files)
    try {
      feedbackService = new FeedbackService(dbManager.getDatabase());
      await feedbackService.start(agentDaemon);
      logger.info("FeedbackService initialized");
    } catch (error) {
      logger.error("Failed to initialize FeedbackService:", error);
    }

    // Initialize lore service (best-effort; auto-records workspace history from task completions)
    try {
      loreService = new LoreService(dbManager.getDatabase());
      await loreService.start(agentDaemon);
      logger.info("LoreService initialized");
    } catch (error) {
      logger.error("Failed to initialize LoreService:", error);
    }

    // Initialize Memory Service for cross-session context
    try {
      MemoryService.initialize(dbManager);
      logger.info("Memory Service initialized");
    } catch (error) {
      logger.error("Failed to initialize Memory Service:", error);
      // Don't fail app startup if memory init fails
    }

    try {
      const candidateService = new ImprovementCandidateService(dbManager.getDatabase());
      await candidateService.start(agentDaemon);
      improvementLoopService = new ImprovementLoopService(dbManager.getDatabase(), candidateService, {
        notify: async ({ type, title, message, taskId, workspaceId }) => {
          const notificationService = getNotificationService();
          if (notificationService) {
            try {
              await notificationService.add({
                type,
                title,
                message,
                taskId,
                workspaceId,
              });
            } catch (error) {
              console.error("[Main] Failed to add improvement notification:", error);
            }
          }
          try {
            trayManager.showNotification(title, message, taskId);
          } catch (error) {
            console.error("[Main] Failed to show improvement desktop notification:", error);
          }
        },
      });
      await improvementLoopService.start(agentDaemon);
      logger.info("ImprovementLoopService initialized");
    } catch (error) {
      logger.error("Failed to initialize ImprovementLoopService:", error);
    }

    // Initialize Knowledge Graph Service for structured entity/relationship memory
    try {
      KnowledgeGraphService.initialize(dbManager.getDatabase());
      logger.info("Knowledge Graph Service initialized");
    } catch (error) {
      logger.error("Failed to initialize Knowledge Graph Service:", error);
      // Don't fail app startup if KG init fails
    }

    // Initialize MCP Client Manager - auto-connects enabled servers on startup
    try {
      const mcpInitStartedAt = Date.now();
      const mcpClientManager = MCPClientManager.getInstance();
      await mcpClientManager.initialize();
      mcpStartupSummary = mcpClientManager.getStartupStats();
      logger.info(
        `MCP summary: enabled=${mcpStartupSummary.enabled}, attempted=${mcpStartupSummary.attempted}, connected=${mcpStartupSummary.connected}, failed=${mcpStartupSummary.failed}`,
      );
      logger.info("MCP Client Manager initialized");
      logPhase("mcp-init", mcpInitStartedAt);
    } catch (error) {
      logger.error("Failed to initialize MCP Client Manager:", error);
      // Don't fail app startup if MCP init fails
    }

    // Initialize Infrastructure Manager - restores wallet, configures providers
    try {
      await InfraManager.getInstance().initialize();
      logger.info("InfraManager initialized");
    } catch (error) {
      logger.error("Failed to initialize InfraManager:", error);
      // Don't fail app startup if infra init fails
    }

    // Initialize Cron Service for scheduled task execution
    try {
      const db = dbManager.getDatabase();
      const taskRepo = new TaskRepository(db);
      const taskEventRepo = new TaskEventRepository(db);
      const channelRepo = new ChannelRepository(db);
      const channelUserRepo = new ChannelUserRepository(db);
      const channelMessageRepo = new ChannelMessageRepository(db);
      const workspaceRepo = new WorkspaceRepository(db);
      const userDataDir = getUserDataDir();

      const ensureManagedWorkspaceForCronJob = async (
        job: { id: string; name: string },
        nowMs: number,
      ) => {
        const managedPath = buildManagedScheduledWorkspacePath(userDataDir, job.name, job.id);
        await fs.mkdir(managedPath, { recursive: true });

        let workspace = workspaceRepo.findByPath(managedPath);
        if (!workspace) {
          workspace = agentDaemon.createWorkspace(`Scheduled: ${job.name}`.trim(), managedPath);
        } else {
          workspaceRepo.updateLastUsedAt(workspace.id, nowMs);
        }

        return workspace;
      };

      cronService = new CronService({
        cronEnabled: true,
        storePath: getCronStorePath(),
        maxConcurrentRuns: 3, // Allow up to 3 concurrent jobs
        // Webhook configuration (disabled by default, can be enabled in settings)
        webhook: {
          enabled: false, // Set to true to enable webhook triggers
          port: 9876,
          host: "127.0.0.1",
          // secret: 'your-secret-here', // Uncomment and set for secure webhooks
        },
        resolveWorkspaceContext: async ({ job, nowMs, phase }) => {
          let workspace = workspaceRepo.findById(job.workspaceId);

          const needsManagedWorkspace =
            !workspace || workspace.isTemp || isTempWorkspaceId(workspace.id);
          if (!workspace) {
            return null;
          }

          if (needsManagedWorkspace) {
            workspace = await ensureManagedWorkspaceForCronJob(job, nowMs);
            if (!workspace) {
              return null;
            }
          } else {
            workspaceRepo.updateLastUsedAt(workspace.id, nowMs);
          }

          const managedWorkspace = isManagedScheduledWorkspacePath(workspace.path, userDataDir);
          if (phase === "run" && managedWorkspace) {
            let runDirectory: ReturnType<typeof createScheduledRunDirectory> | null = null;
            try {
              runDirectory = createScheduledRunDirectory(workspace.path, { nowMs });
            } catch (error) {
              console.warn(
                `[Cron] Failed to prepare run directory for job "${job.name}" (${job.id})`,
                error,
              );
            }
            if (runDirectory) {
              return {
                workspaceId: workspace.id,
                workspacePath: workspace.path,
                runWorkspacePath: runDirectory.path,
                runWorkspaceRelativePath: runDirectory.relativePath,
              };
            }
          }

          return {
            workspaceId: workspace.id,
            workspacePath: workspace.path,
          };
        },
        createTask: async (params) => {
          const isManagedBriefing =
            params.title.startsWith("Daily Briefing:") ||
            params.prompt.includes(DAILY_BRIEFING_MARKER);
          if (isManagedBriefing && dailyBriefingService) {
            const briefing = await dailyBriefingService.generateBriefing(params.workspaceId);
            const text = dailyBriefingService.renderBriefingAsText(briefing);
            const syntheticTaskId = `briefing:${randomUUID()}`;
            managedBriefingRuns.set(syntheticTaskId, {
              text,
              delivered: briefing.delivered,
              generatedAt: briefing.generatedAt,
            });
            return { id: syntheticTaskId };
          }
          const allowUserInput = params.allowUserInput ?? false;
          const mergedAgentConfig = {
            ...(params.agentConfig ? params.agentConfig : {}),
            ...(params.modelKey ? { modelKey: params.modelKey } : {}),
            allowUserInput,
          };
          const task = await agentDaemon.createTask({
            title: params.title,
            prompt: params.prompt,
            workspaceId: params.workspaceId,
            agentConfig: mergedAgentConfig,
            source: "cron",
          });
          return { id: task.id };
        },
        resolveTemplateVariables: async ({
          job,
          runAtMs,
          prevRunAtMs,
        }): Promise<Record<string, string>> => {
          const template = typeof job?.taskPrompt === "string" ? job.taskPrompt : "";
          const wantsChatVars =
            template.includes("{{chat_messages}}") ||
            template.includes("{{chat_since}}") ||
            template.includes("{{chat_until}}") ||
            template.includes("{{chat_message_count}}") ||
            template.includes("{{chat_truncated}}");
          if (!wantsChatVars) return {};

          const chatContext =
            job.chatContext ||
            (job.delivery?.channelType && job.delivery?.channelId
              ? { channelType: job.delivery.channelType, channelId: job.delivery.channelId }
              : null);
          const channelType = chatContext?.channelType;
          const chatId = chatContext?.channelId;
          if (!channelType || !chatId) return {};

          const channel = channelRepo.findByType(channelType);
          if (!channel) return {};

          const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
          const sinceMs = Math.max(
            0,
            Number.isFinite(prevRunAtMs) ? prevRunAtMs! : runAtMs - sevenDaysMs,
          );

          // Fetch a bounded window; formatting further caps message count/size.
          const raw = channelMessageRepo.findByChatId(channel.id, chatId, 500);
          const userCache = new Map<string, Any>();
          const lookupUser = (id: string) => {
            if (!id) return undefined;
            if (userCache.has(id)) return userCache.get(id);
            const u = channelUserRepo.findById(id);
            userCache.set(id, u);
            return u;
          };

          const rendered = formatChatTranscriptForPrompt(raw, {
            lookupUser,
            sinceMs,
            untilMs: runAtMs,
            includeOutgoing: false,
            dropCommands: true,
            maxMessages: 120,
            maxChars: 30_000,
            maxMessageChars: 500,
          });

          return {
            chat_messages: rendered.usedCount > 0 ? rendered.transcript : "[no messages found]",
            chat_since: new Date(sinceMs).toISOString(),
            chat_until: new Date(runAtMs).toISOString(),
            chat_message_count: String(rendered.usedCount),
            chat_truncated: rendered.truncated ? "true" : "false",
          };
        },
        getTaskStatus: async (taskId) => {
          const managedRun = managedBriefingRuns.get(taskId);
          if (managedRun) {
            return {
              status: "completed",
              error: null,
              resultSummary: managedRun.text,
              terminalStatus: "ok",
              failureClass: null,
              budgetUsage: null,
            };
          }
          const task = taskRepo.findById(taskId);
          if (!task) return null;
          return {
            status: task.status,
            error: task.error ?? null,
            resultSummary: task.resultSummary ?? null,
            terminalStatus: task.terminalStatus ?? null,
            failureClass: task.failureClass ?? null,
            budgetUsage: task.budgetUsage ?? null,
          };
        },
        getTaskResultText: async (taskId) => {
          const managedRun = managedBriefingRuns.get(taskId);
          if (managedRun) {
            return managedRun.text;
          }
          const task = taskRepo.findById(taskId);
          const events = taskEventRepo.findByTaskId(taskId);
          return resolveTaskResultText({
            summary: task?.resultSummary,
            events,
          });
        },
        // Channel delivery handler - sends job results to messaging platforms
        deliverToChannel: async (params) => {
          if (!channelGateway) {
            throw new Error("Cannot deliver to channel - gateway not initialized");
          }

          const resultAvailable =
            typeof params.resultText === "string" && params.resultText.trim().length > 0;
          const hasFullResult =
            (params.status === "ok" ||
              params.status === "partial_success" ||
              params.status === "needs_user_action") &&
            !params.summaryOnly &&
            resultAvailable;

          console.log(
            `[Cron] Delivery for "${params.jobName}": hasFullResult=${hasFullResult}, ` +
              `resultTextLength=${params.resultText?.length ?? 0}, summaryOnly=${params.summaryOnly}`,
          );

          // Build the message
          const statusEmoji =
            params.status === "ok"
              ? "✅"
              : params.status === "partial_success" || params.status === "needs_user_action"
                ? "⚠️"
                : params.status === "error"
                  ? "❌"
                  : "⏱️";
          let message: string;

          if (hasFullResult) {
            // Full result mode — send the complete task output
            message = `**${params.jobName}**\n\n${params.resultText!.trim()}`;
          } else if (params.summaryOnly && resultAvailable) {
            // Summary-only mode but result exists — include a truncated preview
            const preview = params.resultText!.trim();
            const truncated = preview.length > 500 ? `${preview.slice(0, 500)}…` : preview;
            message = `${statusEmoji} **${params.jobName}**\n\n${truncated}`;
          } else {
            // No result text or error/timeout — generic status message
            let msg = `${statusEmoji} **Scheduled Task: ${params.jobName}**\n\n`;

            if (params.status === "ok") {
              msg += `Task completed successfully.\n`;
            } else if (params.status === "partial_success") {
              msg += `Task completed with partial results.\n`;
            } else if (params.status === "needs_user_action") {
              msg += `Task completed - action required.\n`;
            } else if (params.status === "error") {
              msg += `Task failed.\n`;
            } else {
              msg += `Task timed out.\n`;
            }

            if (params.error) {
              msg += `\n**Error:** ${params.error}\n`;
            }

            if (params.taskId) {
              msg += `\n_Task ID: ${params.taskId}_`;
            }

            message = msg;
          }

          try {
            // Resolve the actual channel type when a specific channel DB ID is provided
            let resolvedType = params.channelType as string;
            if (params.channelDbId) {
              const ch = channelGateway.getChannel(params.channelDbId);
              if (ch) {
                resolvedType = ch.type;
              }
            }

            // Send the message via the gateway
            await channelGateway.sendMessage(resolvedType as Any, params.channelId, message, {
              parseMode: "markdown",
              idempotencyKey: params.idempotencyKey,
            });
            console.log(`[Cron] Delivered to ${resolvedType}:${params.channelId}`);
          } catch (err) {
            console.error(
              `[Cron] Failed to deliver to ${params.channelType}:${params.channelId}:`,
              err,
            );
            throw err;
          }
        },
        onEvent: async (evt) => {
          // Forward cron events to renderer
          if (mainWindow?.webContents) {
            mainWindow.webContents.send("cron:event", evt);
          }
          console.log("[Cron] Event:", evt.action, evt.jobId);

          // Show desktop notification when scheduled task finishes
          if (evt.action === "finished") {
            const statusEmoji =
              evt.status === "ok"
                ? "✅"
                : evt.status === "partial_success" || evt.status === "needs_user_action"
                  ? "⚠️"
                  : evt.status === "error"
                    ? "❌"
                    : "⏱️";
            const statusText =
              evt.status === "ok"
                ? "completed"
                : evt.status === "partial_success"
                  ? "completed with partial results"
                  : evt.status === "needs_user_action"
                    ? "completed, action required"
                  : evt.status === "error"
                    ? "failed"
                    : "timed out";

            // Add in-app notification
            const notificationService = getNotificationService();
            if (notificationService) {
              try {
                // Get job name for the notification
                const job = cronService ? await cronService.get(evt.jobId) : null;
                const jobName = job?.name || "Scheduled Task";
                await notificationService.add({
                  type:
                    evt.status === "ok"
                      ? "task_completed"
                      : evt.status === "partial_success" || evt.status === "needs_user_action"
                        ? "warning"
                        : "task_failed",
                  title: `${statusEmoji} ${jobName} ${statusText}`,
                  message:
                    evt.error ||
                    (evt.status === "ok"
                      ? "Task completed successfully."
                      : evt.status === "needs_user_action"
                        ? "Task completed but is waiting on user action."
                      : "Task did not complete."),
                  taskId: evt.taskId,
                  cronJobId: evt.jobId,
                  workspaceId: job?.workspaceId,
                });
              } catch (err) {
                console.error("[Cron] Failed to add in-app notification:", err);
              }
            }

            // Custom overlay notification is shown automatically via
            // notificationService.add() -> onEvent -> NotificationOverlayManager
          }
        },
        log: {
          debug: (msg, data) => console.log(`[Cron] ${msg}`, data ?? ""),
          info: (msg, data) => console.log(`[Cron] ${msg}`, data ?? ""),
          warn: (msg, data) => console.warn(`[Cron] ${msg}`, data ?? ""),
          error: (msg, data) => console.error(`[Cron] ${msg}`, data ?? ""),
        },
      });
      setCronService(cronService);
      await cronService.start();
      logger.info("Cron Service initialized");
    } catch (error) {
      logger.error("Failed to initialize Cron Service:", error);
      // Don't fail app startup if cron init fails
    }

    // Initialize extension/plugin system — auto-discovers and loads plugins
    try {
      const pluginInitStartedAt = Date.now();
      const pluginRegistry = getPluginRegistry();
      await pluginRegistry.initialize();
      const plugins = pluginRegistry.getPlugins();
      pluginStartupSummary = {
        loaded: plugins.length,
        enabled: plugins.filter((plugin: Any) => plugin.state === "enabled").length,
      };
      logger.info(
        `Plugins summary: loaded=${pluginStartupSummary.loaded}, enabled=${pluginStartupSummary.enabled}`,
      );
      logger.info(`Plugin registry initialized (${plugins.length} plugins)`);
      logPhase("plugin-init", pluginInitStartedAt);
    } catch (error) {
      logger.error("Failed to initialize Plugin Registry:", error);
      // Don't fail app startup if plugin init fails
    }

    // Initialize channel gateway with agent daemon for task processing
    channelGateway = new ChannelGateway(dbManager.getDatabase(), {
      autoConnect: true, // Auto-connect enabled channels on startup
      agentDaemon,
    });

    // Setup IPC handlers
    await setupIpcHandlers(dbManager, agentDaemon, channelGateway);
    if (improvementLoopService) {
      setupImprovementHandlers(improvementLoopService);
    }
    void getCustomSkillLoader()
      .initialize()
      .then(() => {
        const skills = getCustomSkillLoader().getLoadStats();
        logger.info(
          `Skills summary: total=${skills.total}, bundled=${skills.bundled}, managed=${skills.managed}, workspace=${skills.workspace}, overrides=${skills.overridden}`,
        );
      })
      .catch((error) => {
        logger.debug("Skills summary unavailable:", error);
      });

    const startXMentionBridge = () => {
      if (!xMentionBridgeService) {
        xMentionBridgeService = initializeXMentionBridgeService(agentDaemon, {
          isNativeXChannelEnabled: () => {
            const nativeX = channelGateway.getChannelByType("x");
            return nativeX?.enabled === true && nativeX.status === "connected";
          },
        });
      }
      xMentionBridgeService.start();
    };

    // Initialize heartbeat and Mission Control services
    let heartbeatService: HeartbeatService | null = null;
    try {
      const db = dbManager.getDatabase();
      const agentRoleRepo = new AgentRoleRepository(db);

      // Sync any new default agents to existing workspaces
      const addedAgents = agentRoleRepo.syncNewDefaults();
      if (addedAgents.length > 0) {
        logger.info(`Added ${addedAgents.length} new default agent(s)`);
      }

      const mentionRepo = new MentionRepository(db);
      const activityRepo = new ActivityRepository(db);
      const workingStateRepo = new WorkingStateRepository(db);

      // Create repositories for heartbeat service
      const taskRepo = new TaskRepository(db);
      const workspaceRepo = new WorkspaceRepository(db);

      const resolveDefaultWorkspace = (): ReturnType<typeof workspaceRepo.findById> | undefined => {
        const workspaces = workspaceRepo.findAll();
        return (
          workspaces.find((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id)) ??
          workspaces[0]
        );
      };

      // Initialize HeartbeatService with dependencies
      const heartbeatDeps: HeartbeatServiceDeps = {
        agentRoleRepo,
        mentionRepo,
        activityRepo,
        workingStateRepo,
        createTask: async (workspaceId, prompt, title, _agentRoleId, options) => {
          const task = await agentDaemon.createTask({
            title,
            prompt,
            workspaceId,
            agentConfig: {
              allowUserInput: false,
              ...(options?.agentConfig ?? {}),
            },
            ...(options?.source ? { source: options.source } : {}),
          });
          if (_agentRoleId) {
            taskRepo.update(task.id, {
              assignedAgentRoleId: _agentRoleId,
            });
          }
          return task;
        },
        updateTask: (taskId, updates) => {
          taskRepo.update(taskId, updates);
        },
        getTasksForAgent: (agentRoleId, workspaceId) => {
          const tasks = workspaceId
            ? taskRepo.findByWorkspace(workspaceId)
            : taskRepo.findByStatus(["pending", "running"]);
          return tasks.filter(
            (t: { assignedAgentRoleId?: string }) => t.assignedAgentRoleId === agentRoleId,
          );
        },
        getDefaultWorkspaceId: () => {
          const fallbackTemp = workspaceRepo
            .findAll()
            .find((workspace) => workspace.isTemp || isTempWorkspaceId(workspace.id));
          return resolveDefaultWorkspace()?.id ?? fallbackTemp?.id ?? TEMP_WORKSPACE_ID;
        },
        getDefaultWorkspacePath: () => {
          const fallbackTempPath = workspaceRepo
            .findAll()
            .find((workspace) => workspace.isTemp || isTempWorkspaceId(workspace.id))?.path;
          return resolveDefaultWorkspace()?.path || fallbackTempPath;
        },
        getWorkspacePath: (workspaceId: string) => {
          const workspace = workspaceRepo.findById(workspaceId);
          return workspace?.path;
        },
        recordActivity: ({ workspaceId, agentRoleId, title, description, metadata }) => {
          activityRepo.create({
            workspaceId,
            agentRoleId,
            actorType: "system",
            activityType: "info",
            title,
            description,
            metadata,
          });
        },
        listWorkspaceContexts: () =>
          workspaceRepo
            .findAll()
            .filter((workspace) => workspace.path && !workspace.isTemp && !isTempWorkspaceId(workspace.id))
            .map((workspace) => ({
              workspaceId: workspace.id,
              workspacePath: workspace.path,
            })),
        getMemoryFeaturesSettings: () => MemoryFeaturesManager.loadSettings(),
      };

      heartbeatService = new HeartbeatService(heartbeatDeps);
      setHeartbeatService(heartbeatService);
      await heartbeatService.start();

      setHeartbeatWakeSubmitter(async ({ text, mode }) => {
        heartbeatService?.submitWakeForAll({
          text,
          mode,
          source: "hook",
        });
      });
    } catch (error) {
      logger.error("Failed to initialize Heartbeat:", error);
      // Don't fail app startup if heartbeat init fails
    }

    // Setup Mission Control IPC handlers
    try {
      if (!heartbeatService) {
        logger.error("Mission Control handlers skipped: Heartbeat service unavailable");
      } else {
        const db = dbManager.getDatabase();
        const agentRoleRepo = new AgentRoleRepository(db);
        const taskSubscriptionRepo = new TaskSubscriptionRepository(db);
        const standupService = new StandupReportService(db);

        setupMissionControlHandlers({
          db,
          agentRoleRepo,
          taskSubscriptionRepo,
          standupService,
          heartbeatService,
          getPlannerService: () => strategicPlannerService,
          getMainWindow: () => mainWindow,
        });

        logger.info("Mission Control services initialized");
      }
    } catch (error) {
      logger.error("Failed to initialize Mission Control:", error);
      // Don't fail app startup if Mission Control init fails
    }

    try {
      strategicPlannerService = new StrategicPlannerService({
        db: dbManager.getDatabase(),
        agentDaemon,
        log: (...args) => logger.info(...args),
      });
      setStrategicPlannerService(strategicPlannerService);
      strategicPlannerService.start();
      logger.info("Strategic Planner initialized");
    } catch (error) {
      logger.error("Failed to initialize Strategic Planner:", error);
    }

    // Initialize Persona Templates (Digital Twins) service — independent of heartbeat
    try {
      const db = dbManager.getDatabase();
      const agentRoleRepo = new AgentRoleRepository(db);
      const personaTemplateService = getPersonaTemplateService(agentRoleRepo);
      await personaTemplateService.initialize();
      setupPersonaTemplateHandlers({ personaTemplateService });
      logger.info("Persona Template service initialized");
    } catch (error) {
      logger.error("Failed to initialize Persona Templates:", error);
    }

    // Initialize Plugin Pack handlers (Customize panel)
    try {
      setupPluginPackHandlers();
      logger.debug("Plugin Pack handlers initialized");
    } catch (error) {
      logger.error("Failed to initialize Plugin Pack handlers:", error);
    }

    // Initialize Plugin Distribution handlers (scaffold, install, registry)
    try {
      setupPluginDistributionHandlers();
      logger.debug("Plugin Distribution handlers initialized");
    } catch (error) {
      logger.error("Failed to initialize Plugin Distribution handlers:", error);
    }

    // Initialize Admin Policy handlers
    try {
      setupAdminPolicyHandlers();
      logger.debug("Admin Policy handlers initialized");
    } catch (error) {
      logger.error("Failed to initialize Admin Policy handlers:", error);
    }

    if (HEADLESS) {
      logger.info("Headless mode enabled (no UI)");
      logger.info(`userData: ${getUserDataDir()}`);

      // For security, only print the token when explicitly requested, or when it was just generated.
      let hadControlPlaneToken = false;
      if (FORCE_ENABLE_CONTROL_PLANE || PRINT_CONTROL_PLANE_TOKEN) {
        try {
          ControlPlaneSettingsManager.initialize();
          const before = ControlPlaneSettingsManager.loadSettings();
          hadControlPlaneToken = Boolean(before?.token);
        } catch {
          // ignore
        }
      }

      // Apply Control Plane overrides (optional)
      const cpHost = process.env.COWORK_CONTROL_PLANE_HOST || getArgValue("--control-plane-host");
      const cpPortRaw =
        process.env.COWORK_CONTROL_PLANE_PORT || getArgValue("--control-plane-port");
      const cpPort = cpPortRaw ? Number.parseInt(cpPortRaw, 10) : undefined;
      if (
        (typeof cpHost === "string" && cpHost.trim()) ||
        (typeof cpPort === "number" && Number.isFinite(cpPort))
      ) {
        try {
          ControlPlaneSettingsManager.updateSettings({
            ...(typeof cpHost === "string" && cpHost.trim() ? { host: cpHost.trim() } : {}),
            ...(typeof cpPort === "number" && Number.isFinite(cpPort) ? { port: cpPort } : {}),
          });
        } catch (error) {
          logger.warn("Failed to apply Control Plane overrides:", error);
        }
      }

      // Initialize messaging gateway without a BrowserWindow
      try {
        const channelInitStartedAt = Date.now();
        await channelGateway.initialize();
        const channelStats = channelGateway.getStartupStats();
        logger.info(
          `Channels summary: loaded=${channelStats.loaded}, enabled=${channelStats.enabled}, connected=${channelStats.connected}`,
        );
        logPhase("channel-gateway-headless", channelInitStartedAt);
        startXMentionBridge();
      } catch (error) {
        logger.error("Failed to initialize Channel Gateway (headless):", error);
        // Don't fail app startup if gateway init fails
      }

      // Start Control Plane if enabled (or force-enabled via flag/env)
      const cp = await startControlPlaneFromSettings({
        deps: { agentDaemon, dbManager, channelGateway },
        forceEnable: FORCE_ENABLE_CONTROL_PLANE,
        onEvent: (event) => {
          try {
            const action = typeof event?.action === "string" ? event.action : "event";
            console.log(`[ControlPlane] ${action}`);
          } catch {
            // ignore
          }
        },
      });

      if (!cp.ok) {
        logger.error("Control Plane failed to start:", cp.error);
      } else if (!cp.skipped && cp.address) {
        logger.info(`Control Plane listening: ${cp.address.wsUrl}`);
        if (
          (FORCE_ENABLE_CONTROL_PLANE || PRINT_CONTROL_PLANE_TOKEN) &&
          (PRINT_CONTROL_PLANE_TOKEN || !hadControlPlaneToken)
        ) {
          try {
            const settings = ControlPlaneSettingsManager.loadSettings();
            if (settings?.token) {
              logger.info(`Control Plane token: ${settings.token}`);
            }
          } catch {
            // ignore
          }
        }
      } else if (cp.skipped) {
        logger.info("Control Plane disabled (skipping auto-start)");
      }

      logger.info(`Startup complete in ${Date.now() - startupStartedAt} ms`);
      return;
    }

    // Register canvas:// protocol handler (must be after app.ready)
    registerCanvasProtocol();

    // Create window
    createWindow();

    // Initialize gateway with main window reference
    if (mainWindow) {
      // Initialize Live Canvas handlers BEFORE async operations so IPC handlers
      // are registered before the renderer finishes loading and calls them
      setupCanvasHandlers(mainWindow, agentDaemon);
      CanvasManager.getInstance().setMainWindow(mainWindow);

      // Initialize Git Worktree & Comparison handlers
      const comparisonService = new ComparisonService(dbManager.getDatabase(), agentDaemon);
      agentDaemon.setComparisonService(comparisonService);
      setupWorktreeHandlers(agentDaemon);

      const channelInitStartedAt = Date.now();
      await channelGateway.initialize(mainWindow);
      const channelStats = channelGateway.getStartupStats();
      logger.info(
        `Channels summary: loaded=${channelStats.loaded}, enabled=${channelStats.enabled}, connected=${channelStats.connected}`,
      );
      logPhase("channel-gateway-ui", channelInitStartedAt);
      startXMentionBridge();
      // Initialize update manager with main window reference
      updateManager.setMainWindow(mainWindow);

      // Restore persisted canvas sessions from disk
      await CanvasManager.getInstance().restoreSessions();

      // Initialize control plane (WebSocket gateway)
      setupControlPlaneHandlers(mainWindow, { agentDaemon, dbManager, channelGateway });
      // Auto-start control plane if enabled (and register methods/bridge)
      await startControlPlaneFromSettings({ deps: { agentDaemon, dbManager, channelGateway } });

      // ── Gap features: triggers, briefing, file hub, web access ───────
      const db = dbManager.getDatabase();
      const workspaceRepo = new WorkspaceRepository(db);
      const activityRepo = new ActivityRepository(db);
      const resolveDefaultWorkspace = (): ReturnType<typeof workspaceRepo.findById> | undefined => {
        const workspaces = workspaceRepo.findAll();
        return (
          workspaces.find((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id)) ??
          workspaces[0]
        );
      };

      // Event Triggers
      const triggerService = new EventTriggerService(
        {
          createTask: async (params: { title: string; prompt: string; workspaceId: string }) => {
            const task = await agentDaemon.createTask({
              title: params.title,
              prompt: params.prompt,
              workspaceId: params.workspaceId,
              source: "hook",
            });
            return { id: task.id };
          },
          deliverToChannel: async (params: {
            channelType: string;
            channelId: string;
            text: string;
          }) => {
            await channelGateway.sendMessage?.(
              params.channelType as Any,
              params.channelId,
              params.text,
            );
          },
          getDefaultWorkspaceId: () => "",
          log: (...args: unknown[]) => console.log("[EventTriggers]", ...args),
        },
        db,
      );
      triggerService.start();
      setupTriggerHandlers(triggerService);
      ambientMonitoringService = new AmbientMonitoringService({
        listWorkspaces: () =>
          workspaceRepo
            .findAll()
            .filter(
              (workspace) =>
                workspace.path &&
                !workspace.isTemp &&
                !isTempWorkspaceId(workspace.id) &&
                !isManagedScheduledWorkspacePath(workspace.path, getUserDataDir()),
            )
            .map((workspace) => ({
              workspaceId: workspace.id,
              workspacePath: workspace.path,
              name: workspace.name,
            })),
        getDefaultWorkspaceId: () => resolveDefaultWorkspace()?.id ?? TEMP_WORKSPACE_ID,
        recordActivity: ({ workspaceId, activityType, title, description, metadata }) => {
          activityRepo.create({
            workspaceId,
            actorType: "system",
            activityType,
            title,
            description,
            metadata,
          });
        },
        emitTrigger: (event) => {
          void triggerService.evaluateEvent(event);
        },
        wakeHeartbeats: ({ text, mode }) => {
          heartbeatService?.submitWakeForAll({
            text,
            mode,
            source: "hook",
          });
        },
        log: (...args: unknown[]) => console.log("[AmbientMonitoring]", ...args),
      });
      await ambientMonitoringService.start();

      // Daily Briefing
      dailyBriefingService = new DailyBriefingService(
        {
          getRecentTasks: (_workspaceId, _sinceMs) => {
            try {
              const taskRepo = new TaskRepository(db);
              return (taskRepo.findByWorkspace(_workspaceId, 200) || []).filter(
                (task) => typeof task.createdAt === "number" && task.createdAt >= _sinceMs,
              );
            } catch {
              return [];
            }
          },
          searchMemory: (workspaceId, query, limit) => {
            try {
              return MemoryService.search(workspaceId, query, limit).map((memory) => ({
                summary: memory.snippet,
                content: memory.snippet,
                snippet: memory.snippet,
                type: memory.type,
              }));
            } catch {
              return [];
            }
          },
          refreshSuggestions: async (workspaceId) => {
            await ProactiveSuggestionsService.generateAll(workspaceId);
          },
          getActiveSuggestions: (workspaceId) =>
            ProactiveSuggestionsService.getTopForBriefing(workspaceId, 5),
          getPriorities: (workspaceId) => {
            const workspacePath = workspaceRepo.findById(workspaceId)?.path;
            return readWorkspacePriorities(workspacePath);
          },
          getUpcomingJobs: async (workspaceId, limit) => {
            if (!cronService) return [];
            try {
              const jobs = await cronService.list({ includeDisabled: false });
              return jobs
                .filter((job) => job.workspaceId === workspaceId)
                .sort(
                  (a, b) =>
                    (a.state?.nextRunAtMs ?? Number.MAX_SAFE_INTEGER) -
                    (b.state?.nextRunAtMs ?? Number.MAX_SAFE_INTEGER),
                )
                .slice(0, limit);
            } catch {
              return [];
            }
          },
          getOpenLoops: (workspaceId) => {
            const workspacePath = workspaceRepo.findById(workspaceId)?.path;
            return readWorkspaceOpenLoops(workspacePath);
          },
          deliverToChannel: async (params) => {
            await channelGateway.sendMessage?.(
              params.channelType as Any,
              params.channelId,
              params.text,
            );
          },
          log: (...args: unknown[]) => console.log("[Briefing]", ...args),
        },
        db,
      );
      setupBriefingHandlers(dailyBriefingService, {
        onConfigSaved: async (workspaceId, config) => {
          await syncDailyBriefingCronJob(cronService, workspaceId, config);
        },
      });
      for (const workspace of workspaceRepo.findAll().filter(
        (entry) =>
          !entry.isTemp &&
          !isTempWorkspaceId(entry.id) &&
          !isManagedScheduledWorkspacePath(entry.path, getUserDataDir()),
      )) {
        await syncDailyBriefingCronJob(
          cronService,
          workspace.id,
          dailyBriefingService.getConfig(workspace.id),
        );
      }

      // File Hub
      const fileHubService = new FileHubService(
        {
          getWorkspacePath: (wsId) => {
            try {
              const wsRepo = new WorkspaceRepository(db);
              const ws =
                (wsId ? wsRepo.findById(wsId) : null) ||
                wsRepo
                  .findAll()
                  .find((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id)) ||
                wsRepo.findAll()[0];
              return ws?.path || "";
            } catch {
              return "";
            }
          },
          getArtifacts: () => [],
          getConnectedSources: () => [],
        },
        db,
      );
      setupFileHubHandlers(fileHubService);

      // Web Access
      const loadWebAccessSettings = (): WebAccessConfig => {
        try {
          if (!SecureSettingsRepository.isInitialized()) {
            return { ...DEFAULT_WEB_ACCESS_CONFIG };
          }
          const repository = SecureSettingsRepository.getInstance();
          const stored = repository.load<Partial<WebAccessConfig>>("webaccess");
          if (!stored) {
            return { ...DEFAULT_WEB_ACCESS_CONFIG };
          }
          const allowedOrigins = Array.isArray(stored.allowedOrigins)
            ? stored.allowedOrigins
                .filter((origin): origin is string => typeof origin === "string")
                .map((origin) => origin.trim())
                .filter(Boolean)
            : DEFAULT_WEB_ACCESS_CONFIG.allowedOrigins;
          return {
            ...DEFAULT_WEB_ACCESS_CONFIG,
            ...stored,
            enabled: stored.enabled === true,
            port: Number.isFinite(Number(stored.port))
              ? Math.min(65535, Math.max(1, Math.floor(Number(stored.port))))
              : DEFAULT_WEB_ACCESS_CONFIG.port,
            host:
              typeof stored.host === "string" && stored.host.trim().length > 0
                ? stored.host.trim()
                : DEFAULT_WEB_ACCESS_CONFIG.host,
            token: typeof stored.token === "string" ? stored.token.trim() : "",
            allowedOrigins,
          };
        } catch (error) {
          console.warn("[WebAccess] Failed to load settings; using defaults:", error);
          return { ...DEFAULT_WEB_ACCESS_CONFIG };
        }
      };

      const saveWebAccessSettings = (settings: WebAccessConfig): void => {
        try {
          if (!SecureSettingsRepository.isInitialized()) return;
          const repository = SecureSettingsRepository.getInstance();
          repository.save("webaccess", settings);
        } catch (error) {
          console.error("[WebAccess] Failed to persist settings:", error);
        }
      };

      const webAccessTaskRepo = new TaskRepository(db);
      const webAccessWorkspaceRepo = new WorkspaceRepository(db);

      const getDefaultWebWorkspaceId = (): string => {
        const firstWorkspace = webAccessWorkspaceRepo
          .findAll()
          .find((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id));
        return firstWorkspace?.id || "";
      };

      const initialWebAccessSettings = loadWebAccessSettings();
      const webAccessServer = new WebAccessServer(initialWebAccessSettings, {
        handleIpcInvoke: async (channel: string, ...args: Any[]) => {
          switch (channel) {
            case "task:list":
              return webAccessTaskRepo.findAll();
            case "task:create": {
              const payload = args[0] && typeof args[0] === "object" ? args[0] : {};
              const prompt = typeof payload.prompt === "string" ? payload.prompt.trim() : "";
              if (!prompt) {
                throw new Error("Task prompt is required.");
              }
              const workspaceId =
                typeof payload.workspaceId === "string" && payload.workspaceId.trim().length > 0
                  ? payload.workspaceId.trim()
                  : getDefaultWebWorkspaceId();
              if (!workspaceId) {
                throw new Error("No workspace available for task creation.");
              }
              const title =
                typeof payload.title === "string" && payload.title.trim().length > 0
                  ? payload.title.trim()
                  : "Web Access Task";
              return agentDaemon.createTask({
                title,
                prompt,
                workspaceId,
                source: "api",
              });
            }
            case "task:get": {
              const taskId = typeof args[0] === "string" ? args[0].trim() : "";
              if (!taskId) {
                throw new Error("Task ID is required.");
              }
              return webAccessTaskRepo.findById(taskId) ?? null;
            }
            case "task:sendMessage": {
              const payload = args[0] && typeof args[0] === "object" ? args[0] : {};
              let taskId: string;
              let message: string;
              let images: import("../shared/types").ImageAttachment[] | undefined;
              try {
                const sanitized = sanitizeTaskMessageParams(payload);
                taskId = sanitized.taskId;
                message = sanitized.message;
                images = sanitized.images;
              } catch (err) {
                throw new Error(
                  err instanceof Error ? err.message : "taskId and message are required.",
                );
              }
              return agentDaemon.sendMessage(taskId, message, images);
            }
            case "task:events": {
              const taskId = typeof args[0] === "string" ? args[0].trim() : "";
              if (!taskId) {
                throw new Error("Task ID is required.");
              }
              const events = agentDaemon.getTaskEvents(taskId);
              const maxEvents = 600;
              return events.length > maxEvents ? events.slice(-maxEvents) : events;
            }
            case "workspace:list":
              return webAccessWorkspaceRepo
                .findAll()
                .filter((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id));
            case "account:list": {
              const payload = args[0] && typeof args[0] === "object" ? args[0] : {};
              const status =
                typeof payload.status === "string" ? payload.status.trim() : undefined;
              const accounts = ManagedAccountManager.list({
                provider: typeof payload.provider === "string" ? payload.provider : undefined,
                status: status as ManagedAccountStatus | undefined,
              });
              const includeSecrets = payload.includeSecrets === true;
              return {
                accounts: accounts.map((account) =>
                  ManagedAccountManager.toPublicView(account, includeSecrets),
                ),
              };
            }
            case "account:get": {
              const payload = args[0] && typeof args[0] === "object" ? args[0] : {};
              const accountId = typeof payload.accountId === "string" ? payload.accountId.trim() : "";
              if (!accountId) {
                throw new Error("accountId is required.");
              }
              const account = ManagedAccountManager.getById(accountId);
              if (!account) {
                return { account: null };
              }
              return {
                account: ManagedAccountManager.toPublicView(account, payload.includeSecrets === true),
              };
            }
            case "account:upsert": {
              const payload = args[0] && typeof args[0] === "object" ? args[0] : {};
              const account = ManagedAccountManager.upsert(payload);
              return { account: ManagedAccountManager.toPublicView(account, false) };
            }
            case "account:remove": {
              const payload = args[0] && typeof args[0] === "object" ? args[0] : {};
              const accountId = typeof payload.accountId === "string" ? payload.accountId.trim() : "";
              if (!accountId) {
                throw new Error("accountId is required.");
              }
              return { removed: ManagedAccountManager.remove(accountId) };
            }
            case "briefing:generate": {
              const workspaceId =
                typeof args[0] === "string" && args[0].trim().length > 0
                  ? args[0].trim()
                  : getDefaultWebWorkspaceId();
              if (!workspaceId) {
                throw new Error("workspaceId is required.");
              }
              if (!dailyBriefingService) {
                throw new Error("Daily briefing service is not initialized.");
              }
              return dailyBriefingService.generateBriefing(workspaceId);
            }
            case "suggestions:list": {
              const workspaceId = typeof args[0] === "string" ? args[0].trim() : "";
              if (!workspaceId) return [];
              const { ProactiveSuggestionsService } =
                await import("./agent/ProactiveSuggestionsService");
              return ProactiveSuggestionsService.listActive(workspaceId);
            }
            default:
              throw new Error(`Unsupported web access channel: ${channel}`);
          }
        },
        getRendererPath: () => {
          // oxlint-disable-next-line typescript-eslint(no-require-imports)
          const { app } = require("electron");
          return path.join(app.getAppPath(), "dist", "renderer");
        },
        log: (...args: unknown[]) => console.log("[WebAccess]", ...args),
      });
      const normalizedWebAccessSettings = webAccessServer.getConfig();
      if (
        JSON.stringify(initialWebAccessSettings) !== JSON.stringify(normalizedWebAccessSettings)
      ) {
        saveWebAccessSettings(normalizedWebAccessSettings);
      }
      if (normalizedWebAccessSettings.enabled) {
        try {
          await webAccessServer.start();
        } catch (error) {
          console.error("[WebAccess] Failed to start enabled server:", error);
        }
      }
      setupWebAccessHandlers(webAccessServer, { saveSettings: saveWebAccessSettings });

      // Hook triggers into gateway message events
      channelGateway.onEvent((event) => {
        if (event.type === "message:received" && event.data) {
          triggerService.evaluateEvent({
            source: "channel_message",
            fields: {
              channelType: event.channel || "",
              chatId: (event.data.chatId as string) || "",
              text: (event.data.text as string) || "",
              senderName: (event.data.senderName as string) || "",
            },
            timestamp: Date.now(),
          });
        }
      });

      // Initialize system tray (macOS menu bar / Windows system tray)
      if (process.platform === "darwin" || process.platform === "win32") {
        await trayManager.initialize(mainWindow, channelGateway, dbManager, agentDaemon);
      }

      // Show migration notification after window is ready
      if (migrationResult.migrated && migrationResult.migratedKeys.length > 0) {
        mainWindow.webContents.once("did-finish-load", () => {
          dialog.showMessageBox(mainWindow!, {
            type: "info",
            title: "Configuration Migrated",
            message: "Your API credentials have been migrated",
            detail:
              `The following credentials were migrated from your .env file to secure Settings storage:\n\n` +
              `${migrationResult.migratedKeys.map((k) => `• ${k}`).join("\n")}\n\n` +
              `Your .env file has been renamed to .env.migrated. ` +
              `You can safely delete it after verifying your settings work correctly.\n\n` +
              `Open Settings (gear icon) to review your configuration.`,
            buttons: ["OK"],
          });
        });
      }
    }

    logger.info(`Startup complete in ${Date.now() - startupStartedAt} ms`);

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createWindow();
      }
    });
  });

  app.on("window-all-closed", () => {
    if (HEADLESS) return;
    if (process.platform !== "darwin") {
      app.quit();
    }
  });

  // In headless/server mode, allow clean shutdown via systemd/docker signals.
  if (HEADLESS) {
    for (const sig of ["SIGINT", "SIGTERM"] as const) {
      process.on(sig, () => {
        logger.info(`Received ${sig}, shutting down...`);
        app.quit();
      });
    }
  }

  app.on("before-quit", async () => {
    if (tempWorkspacePruneTimer) {
      clearInterval(tempWorkspacePruneTimer);
      tempWorkspacePruneTimer = null;
    }
    if (tempSandboxProfilePruneTimer) {
      clearInterval(tempSandboxProfilePruneTimer);
      tempSandboxProfilePruneTimer = null;
    }

    // Destroy tray
    trayManager.destroy();

    // Stop cron service (async to properly shutdown webhook server)
    if (cronService) {
      await cronService.stop();
      setCronService(null);
    }
    if (ambientMonitoringService) {
      await ambientMonitoringService.stop();
      ambientMonitoringService = null;
    }
    if (strategicPlannerService) {
      try {
        strategicPlannerService.stop();
      } catch (error) {
        console.error("[Main] Failed to stop Strategic Planner:", error);
      }
      strategicPlannerService = null;
      setStrategicPlannerService(null);
    }

    if (xMentionBridgeService) {
      try {
        xMentionBridgeService.stop();
      } catch (error) {
        console.error("[Main] Failed to stop X mention bridge service:", error);
      }
      xMentionBridgeService = null;
    }

    if (improvementLoopService) {
      try {
        improvementLoopService.stop();
      } catch (error) {
        console.error("[Main] Failed to stop ImprovementLoopService:", error);
      }
      improvementLoopService = null;
    }

    // Cleanup canvas manager (close all windows and watchers)
    await cleanupCanvasHandlers();

    // Shutdown control plane (WebSocket gateway and Tailscale)
    await shutdownControlPlane();

    if (channelGateway) {
      await channelGateway.shutdown();
    }

    // Stop lore service to flush any debounced workspace history updates
    if (loreService) {
      try {
        await loreService.stop();
      } catch (error) {
        console.error("[Main] Failed to shutdown LoreService:", error);
      }
      loreService = null;
    }

    // Disconnect all MCP servers
    try {
      const mcpClientManager = MCPClientManager.getInstance();
      await mcpClientManager.shutdown();
    } catch (error) {
      console.error("[Main] Failed to shutdown MCP servers:", error);
    }
    // Shutdown Memory Service
    try {
      MemoryService.shutdown();
    } catch (error) {
      console.error("[Main] Failed to shutdown Memory Service:", error);
    }

    if (dbManager) {
      dbManager.close();
    }
    if (agentDaemon) {
      agentDaemon.shutdown();
    }
    if (detachTaskLifecycleSync) {
      try {
        detachTaskLifecycleSync();
      } catch (error) {
        console.error("[Main] Failed to detach task lifecycle sync:", error);
      }
      detachTaskLifecycleSync = null;
    }
  });

  // Window control handlers (used by custom title bar buttons on Windows)
  ipcMain.handle("window:minimize", () => {
    BrowserWindow.getFocusedWindow()?.minimize();
  });
  ipcMain.handle("window:maximize", () => {
    const win = BrowserWindow.getFocusedWindow();
    if (win?.isMaximized()) {
      win.unmaximize();
    } else {
      win?.maximize();
    }
  });
  ipcMain.handle("window:close", () => {
    BrowserWindow.getFocusedWindow()?.close();
  });
  ipcMain.handle("window:isMaximized", () => {
    return BrowserWindow.getFocusedWindow()?.isMaximized() ?? false;
  });

  // Handle folder selection
  ipcMain.handle("dialog:selectFolder", async () => {
    const result = await dialog.showOpenDialog({
      // Allow creating folders directly from the native picker when supported.
      properties: ["openDirectory", "createDirectory"],
      title: "Select Workspace Folder",
    });

    if (!result.canceled && result.filePaths.length > 0) {
      return result.filePaths[0];
    }
    return null;
  });

  // Handle file selection (attachments)
  ipcMain.handle("dialog:selectFiles", async () => {
    const result = await dialog.showOpenDialog({
      properties: ["openFile", "multiSelections"],
      title: "Select Files to Upload",
    });

    if (result.canceled || result.filePaths.length === 0) {
      return [];
    }

    const entries = await Promise.all(
      result.filePaths.map(async (filePath) => {
        try {
          const stats = await fs.stat(filePath);
          if (!stats.isFile()) {
            return null;
          }
          return {
            path: filePath,
            name: path.basename(filePath),
            size: stats.size,
            mimeType: (mime.lookup(filePath) || undefined) as string | undefined,
          };
        } catch {
          return null;
        }
      }),
    );

    return entries.filter(
      (
        entry,
      ): entry is { path: string; name: string; size: number; mimeType: string | undefined } =>
        Boolean(entry),
    );
  });
} // single-instance guard
