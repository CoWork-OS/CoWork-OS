import path from "path";
import os from "os";
import * as fs from "fs/promises";
import { pathToFileURL } from "url";
import { app, BrowserWindow, ipcMain, dialog, session, shell, Notification } from "electron";
import mime from "mime-types";
import { DatabaseManager } from "./database/schema";
import { SecureSettingsRepository } from "./database/SecureSettingsRepository";
import {
  setupIpcHandlers,
  getNotificationService,
  setHeartbeatWakeSubmitter,
} from "./ipc/handlers";
import { setupMissionControlHandlers } from "./ipc/mission-control-handlers";
import { setupWorktreeHandlers } from "./ipc/worktree-handlers";
import { ComparisonService } from "./git/ComparisonService";
import { TaskSubscriptionRepository } from "./agents/TaskSubscriptionRepository";
import { StandupReportService } from "./reports/StandupReportService";
import { HeartbeatService, HeartbeatServiceDeps } from "./agents/HeartbeatService";
import { AgentRoleRepository } from "./agents/AgentRoleRepository";
import { MentionRepository } from "./agents/MentionRepository";
import { ActivityRepository } from "./activity/ActivityRepository";
import { WorkingStateRepository } from "./agents/WorkingStateRepository";
import { CrossSignalService } from "./agents/CrossSignalService";
import { FeedbackService } from "./agents/FeedbackService";
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
import { ConwayManager } from "./conway/conway-manager";
import { trayManager } from "./tray";
import { CronService, setCronService, getCronStorePath } from "./cron";
import { MemoryService } from "./memory/MemoryService";
import {
  ControlPlaneSettingsManager,
  setupControlPlaneHandlers,
  shutdownControlPlane,
  startControlPlaneFromSettings,
} from "./control-plane";
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
import { getPluginRegistry } from "./extensions/registry";

let mainWindow: BrowserWindow | null = null;
let dbManager: DatabaseManager;
let agentDaemon: AgentDaemon;
let channelGateway: ChannelGateway;
let cronService: CronService | null = null;
let crossSignalService: CrossSignalService | null = null;
let feedbackService: FeedbackService | null = null;
let tempWorkspacePruneTimer: NodeJS.Timeout | null = null;
const TEMP_WORKSPACE_PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;

const HEADLESS = isHeadlessMode();
const FORCE_ENABLE_CONTROL_PLANE = shouldEnableControlPlaneFromArgsOrEnv();
const PRINT_CONTROL_PLANE_TOKEN = shouldPrintControlPlaneTokenFromArgsOrEnv();
const IMPORT_ENV_SETTINGS = shouldImportEnvSettingsFromArgsOrEnv();
const IMPORT_ENV_SETTINGS_MODE = getEnvSettingsImportModeFromArgsOrEnv();

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
    mainWindow = new BrowserWindow({
      width: 1600,
      height: 1000,
      minWidth: 1200,
      minHeight: 800,
      center: true,
      titleBarStyle: "hiddenInset",
      vibrancy: "under-window",
      visualEffectState: "active",
      transparent: true,
      backgroundColor: "#00000000",
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
      mainWindow.loadFile(path.join(__dirname, "../../renderer/index.html"));
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
        console.log(`[Main] Using userData directory override: ${resolved}`);
      } catch (error) {
        console.warn("[Main] Failed to apply userData directory override:", error);
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
    dbManager = new DatabaseManager();
    const tempWorkspaceRoot = path.join(os.tmpdir(), TEMP_WORKSPACE_ROOT_DIR_NAME);
    const runTempWorkspacePrune = () => {
      try {
        pruneTempWorkspaces({
          db: dbManager.getDatabase(),
          tempWorkspaceRoot,
        });
      } catch (error) {
        console.warn("[Main] Failed to prune temp workspaces:", error);
      }
    };
    runTempWorkspacePrune();
    tempWorkspacePruneTimer = setInterval(runTempWorkspacePrune, TEMP_WORKSPACE_PRUNE_INTERVAL_MS);
    tempWorkspacePruneTimer.unref();

    // Initialize secure settings repository for encrypted settings storage
    // This MUST be done before provider factories so they can migrate legacy settings
    new SecureSettingsRepository(dbManager.getDatabase());
    console.log("[Main] SecureSettingsRepository initialized");

    // Initialize provider factories (loads settings from disk, migrates legacy files)
    LLMProviderFactory.initialize();
    SearchProviderFactory.initialize();
    GuardrailManager.initialize();
    AppearanceManager.initialize();
    PersonalityManager.initialize();
    MemoryFeaturesManager.initialize();

    // Migrate .env configuration to Settings (one-time upgrade path)
    const migrationResult = await migrateEnvToSettings();

    // Optional: import process.env keys into Settings (explicit opt-in; useful for headless/server deployments).
    if (IMPORT_ENV_SETTINGS) {
      const importResult = await importProcessEnvToSettings({ mode: IMPORT_ENV_SETTINGS_MODE });
      if (importResult.migrated && importResult.migratedKeys.length > 0) {
        console.log(
          `[Main] Imported credentials from process.env (${IMPORT_ENV_SETTINGS_MODE}): ${importResult.migratedKeys.join(", ")}`,
        );
      }
      if (importResult.error) {
        console.warn("[Main] Failed to import credentials from process.env:", importResult.error);
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
          console.warn(
            "[Main] No LLM credentials configured. In headless mode, set COWORK_IMPORT_ENV_SETTINGS=1 and an LLM key (e.g. OPENAI_API_KEY or ANTHROPIC_API_KEY), then restart.",
          );
        }
      } catch (error) {
        console.warn("[Main] Failed to check LLM credential configuration:", error);
      }
    }

    // Initialize agent daemon
    agentDaemon = new AgentDaemon(dbManager);
    await agentDaemon.initialize();

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
        const expanded =
          raw.startsWith("~/") && process.env.HOME
            ? path.join(process.env.HOME, raw.slice(2))
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
          console.log(`[Main] Bootstrapped workspace: ${ws.id} (${ws.name}) at ${ws.path}`);
        } else {
          console.log(
            `[Main] Bootstrap workspace exists: ${existing.id} (${existing.name}) at ${existing.path}`,
          );
        }
      }
    } catch (error) {
      console.warn("[Main] Failed to bootstrap workspace:", error);
    }

    // Initialize cross-agent signal tracker (best-effort; do not block app startup)
    try {
      crossSignalService = new CrossSignalService(dbManager.getDatabase());
      await crossSignalService.start(agentDaemon);
      console.log("[Main] CrossSignalService initialized");
    } catch (error) {
      console.error("[Main] Failed to initialize CrossSignalService:", error);
    }

    // Initialize feedback logger (best-effort; persists approve/reject/edit/next into workspace kit files)
    try {
      feedbackService = new FeedbackService(dbManager.getDatabase());
      await feedbackService.start(agentDaemon);
      console.log("[Main] FeedbackService initialized");
    } catch (error) {
      console.error("[Main] Failed to initialize FeedbackService:", error);
    }

    // Initialize Memory Service for cross-session context
    try {
      MemoryService.initialize(dbManager);
      console.log("[Main] Memory Service initialized");
    } catch (error) {
      console.error("[Main] Failed to initialize Memory Service:", error);
      // Don't fail app startup if memory init fails
    }

    // Initialize MCP Client Manager - auto-connects enabled servers on startup
    try {
      const mcpClientManager = MCPClientManager.getInstance();
      await mcpClientManager.initialize();
      console.log("[Main] MCP Client Manager initialized");
    } catch (error) {
      console.error("[Main] Failed to initialize MCP Client Manager:", error);
      // Don't fail app startup if MCP init fails
    }

    // Initialize Conway Terminal Manager - restores state and auto-connects if enabled
    try {
      await ConwayManager.getInstance().initialize();
      console.log("[Main] Conway Manager initialized");
    } catch (error) {
      console.error("[Main] Failed to initialize Conway Manager:", error);
      // Don't fail app startup if Conway init fails
    }

    // Initialize Cron Service for scheduled task execution
    try {
      const db = dbManager.getDatabase();
      const taskRepo = new TaskRepository(db);
      const taskEventRepo = new TaskEventRepository(db);
      const channelRepo = new ChannelRepository(db);
      const channelUserRepo = new ChannelUserRepository(db);
      const channelMessageRepo = new ChannelMessageRepository(db);

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
        createTask: async (params) => {
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
          const userCache = new Map<string, any>();
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
          const task = taskRepo.findById(taskId);
          if (!task) return null;
          return {
            status: task.status,
            error: task.error ?? null,
            resultSummary: task.resultSummary ?? null,
          };
        },
        getTaskResultText: async (taskId) => {
          const task = taskRepo.findById(taskId);
          const summary = typeof task?.resultSummary === "string" ? task.resultSummary.trim() : "";
          if (summary) return summary;

          // Fall back to the last assistant message event (best-effort).
          const events = taskEventRepo.findByTaskId(taskId);
          for (let i = events.length - 1; i >= 0; i--) {
            const evt = events[i];
            if (evt.type !== "assistant_message") continue;
            const payload = evt.payload || {};
            const text =
              (typeof payload.message === "string" ? payload.message : "") ||
              (typeof payload.content === "string" ? payload.content : "");
            const trimmed = text.trim();
            if (trimmed) return trimmed;
          }
          return undefined;
        },
        // Channel delivery handler - sends job results to messaging platforms
        deliverToChannel: async (params) => {
          if (!channelGateway) {
            console.warn("[Cron] Cannot deliver to channel - gateway not initialized");
            return;
          }

          const hasResult =
            params.status === "ok" &&
            !params.summaryOnly &&
            typeof params.resultText === "string" &&
            params.resultText.trim().length > 0;

          // Build the message
          const statusEmoji =
            params.status === "ok" ? "✅" : params.status === "error" ? "❌" : "⏱️";
          const message = hasResult
            ? `**${params.jobName}**\n\n${params.resultText!.trim()}`
            : (() => {
                let msg = `${statusEmoji} **Scheduled Task: ${params.jobName}**\n\n`;

                if (params.status === "ok") {
                  msg += `Task completed successfully.\n`;
                } else if (params.status === "error") {
                  msg += `Task failed.\n`;
                } else {
                  msg += `Task timed out.\n`;
                }

                if (params.error) {
                  msg += `\n**Error:** ${params.error}\n`;
                }

                if (params.taskId && !params.summaryOnly) {
                  msg += `\n_Task ID: ${params.taskId}_`;
                }

                return msg;
              })();

          try {
            // Send the message via the gateway
            await channelGateway.sendMessage(params.channelType as any, params.channelId, message, {
              parseMode: "markdown",
            });
            console.log(`[Cron] Delivered to ${params.channelType}:${params.channelId}`);
          } catch (err) {
            console.error(
              `[Cron] Failed to deliver to ${params.channelType}:${params.channelId}:`,
              err,
            );
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
            const statusEmoji = evt.status === "ok" ? "✅" : evt.status === "error" ? "❌" : "⏱️";
            const statusText =
              evt.status === "ok" ? "completed" : evt.status === "error" ? "failed" : "timed out";

            // Add in-app notification
            const notificationService = getNotificationService();
            if (notificationService) {
              try {
                // Get job name for the notification
                const job = cronService ? await cronService.get(evt.jobId) : null;
                const jobName = job?.name || "Scheduled Task";
                await notificationService.add({
                  type: evt.status === "ok" ? "task_completed" : "task_failed",
                  title: `${statusEmoji} ${jobName} ${statusText}`,
                  message:
                    evt.error ||
                    (evt.status === "ok"
                      ? "Task completed successfully."
                      : "Task did not complete."),
                  taskId: evt.taskId,
                  cronJobId: evt.jobId,
                  workspaceId: job?.workspaceId,
                });
              } catch (err) {
                console.error("[Cron] Failed to add in-app notification:", err);
              }
            }

            // Show macOS notification
            if (Notification.isSupported()) {
              const notification = new Notification({
                title: `${statusEmoji} Scheduled Task ${statusText}`,
                body: evt.error ? `Error: ${evt.error}` : "Click to view results in the app.",
                silent: false,
              });

              notification.on("click", () => {
                // Bring the main window to focus
                if (mainWindow) {
                  if (mainWindow.isMinimized()) mainWindow.restore();
                  mainWindow.focus();
                }
              });

              notification.show();
            }
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
      console.log("[Main] Cron Service initialized");
    } catch (error) {
      console.error("[Main] Failed to initialize Cron Service:", error);
      // Don't fail app startup if cron init fails
    }

    // Initialize extension/plugin system — auto-discovers and loads plugins
    try {
      const pluginRegistry = getPluginRegistry();
      await pluginRegistry.initialize();
      const pluginCount = pluginRegistry.getPlugins().length;
      if (pluginCount > 0) {
        console.log(`[Main] Plugin registry initialized (${pluginCount} plugins)`);
      }
    } catch (error) {
      console.error("[Main] Failed to initialize Plugin Registry:", error);
      // Don't fail app startup if plugin init fails
    }

    // Initialize channel gateway with agent daemon for task processing
    channelGateway = new ChannelGateway(dbManager.getDatabase(), {
      autoConnect: true, // Auto-connect enabled channels on startup
      agentDaemon,
    });

    // Setup IPC handlers
    await setupIpcHandlers(dbManager, agentDaemon, channelGateway);

    // Initialize heartbeat and Mission Control services
    let heartbeatService: HeartbeatService | null = null;
    try {
      const db = dbManager.getDatabase();
      const agentRoleRepo = new AgentRoleRepository(db);

      // Sync any new default agents to existing workspaces
      const addedAgents = agentRoleRepo.syncNewDefaults();
      if (addedAgents.length > 0) {
        console.log(`[Main] Added ${addedAgents.length} new default agent(s)`);
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
        createTask: async (workspaceId, prompt, title, _agentRoleId) => {
          const task = await agentDaemon.createTask({
            title,
            prompt,
            workspaceId,
            agentConfig: {
              allowUserInput: false,
            },
          });
          if (_agentRoleId) {
            taskRepo.update(task.id, {
              assignedAgentRoleId: _agentRoleId,
            });
          }
          return task;
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
      };

      heartbeatService = new HeartbeatService(heartbeatDeps);
      await heartbeatService.start();

      setHeartbeatWakeSubmitter(async ({ text, mode }) => {
        heartbeatService?.submitWakeForAll({
          text,
          mode,
          source: "hook",
        });
      });
    } catch (error) {
      console.error("[Main] Failed to initialize Heartbeat:", error);
      // Don't fail app startup if heartbeat init fails
    }

    // Setup Mission Control IPC handlers
    try {
      if (!heartbeatService) {
        console.error("[Main] Mission Control handlers skipped: Heartbeat service unavailable");
      } else {
        const db = dbManager.getDatabase();
        const agentRoleRepo = new AgentRoleRepository(db);
        const taskSubscriptionRepo = new TaskSubscriptionRepository(db);
        const standupService = new StandupReportService(db);

        setupMissionControlHandlers({
          agentRoleRepo,
          taskSubscriptionRepo,
          standupService,
          heartbeatService,
          getMainWindow: () => mainWindow,
        });

        console.log("[Main] Mission Control services initialized");
      }
    } catch (error) {
      console.error("[Main] Failed to initialize Mission Control:", error);
      // Don't fail app startup if Mission Control init fails
    }

    if (HEADLESS) {
      console.log("[Main] Headless mode enabled (no UI)");
      console.log(`[Main] userData: ${getUserDataDir()}`);

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
          console.warn("[Main] Failed to apply Control Plane overrides:", error);
        }
      }

      // Initialize messaging gateway without a BrowserWindow
      try {
        await channelGateway.initialize();
      } catch (error) {
        console.error("[Main] Failed to initialize Channel Gateway (headless):", error);
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
        console.error("[Main] Control Plane failed to start:", cp.error);
      } else if (!cp.skipped && cp.address) {
        console.log(`[Main] Control Plane listening: ${cp.address.wsUrl}`);
        if (
          (FORCE_ENABLE_CONTROL_PLANE || PRINT_CONTROL_PLANE_TOKEN) &&
          (PRINT_CONTROL_PLANE_TOKEN || !hadControlPlaneToken)
        ) {
          try {
            const settings = ControlPlaneSettingsManager.loadSettings();
            if (settings?.token) {
              console.log(`[Main] Control Plane token: ${settings.token}`);
            }
          } catch {
            // ignore
          }
        }
      } else if (cp.skipped) {
        console.log("[Main] Control Plane disabled (skipping auto-start)");
      }

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

      await channelGateway.initialize(mainWindow);
      // Initialize update manager with main window reference
      updateManager.setMainWindow(mainWindow);

      // Restore persisted canvas sessions from disk
      await CanvasManager.getInstance().restoreSessions();

      // Initialize control plane (WebSocket gateway)
      setupControlPlaneHandlers(mainWindow, { agentDaemon, dbManager, channelGateway });
      // Auto-start control plane if enabled (and register methods/bridge)
      await startControlPlaneFromSettings({ deps: { agentDaemon, dbManager, channelGateway } });

      // Initialize menu bar tray (macOS native companion)
      if (process.platform === "darwin") {
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
        console.log(`[Main] Received ${sig}, shutting down...`);
        app.quit();
      });
    }
  }

  app.on("before-quit", async () => {
    if (tempWorkspacePruneTimer) {
      clearInterval(tempWorkspacePruneTimer);
      tempWorkspacePruneTimer = null;
    }

    // Destroy tray
    trayManager.destroy();

    // Stop cron service (async to properly shutdown webhook server)
    if (cronService) {
      await cronService.stop();
      setCronService(null);
    }

    // Cleanup canvas manager (close all windows and watchers)
    await cleanupCanvasHandlers();

    // Shutdown control plane (WebSocket gateway and Tailscale)
    await shutdownControlPlane();

    if (channelGateway) {
      await channelGateway.shutdown();
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
