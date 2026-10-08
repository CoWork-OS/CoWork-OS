import { BotNotificationRuntime } from "../electron/notifications/BotNotificationRuntime";
import { BotWorkControlRecovery } from "../electron/automation/BotWorkControlRecovery";
import { PermissionSettingsManager } from "../electron/security/permission-settings-manager";
import { loadPolicies, watchPolicies } from "../electron/admin/policies";
import { prepareResponsibilitySchedule } from "../electron/automation/responsibility-signals";
import { BotResponsibilityRepository } from "../electron/automation/BotResponsibilityRepository";
import { SchedulerOwnership } from "../electron/automation/SchedulerOwnership";
import { createHeadlessBotAutomation } from "../electron/automation/headless-bot-services";
import { AutomationRuntime, setAutomationRuntime } from "../electron/automation/AutomationRuntime";
import { PersistentDispatchBudget } from "../electron/automation/PersistentDispatchBudget";
import { setBackgroundDispatchBudget } from "../electron/agents/BackgroundDispatchBudget";
import { TaskRepository } from "../electron/database/repository-facades";
import { ChannelRepository, ChannelUserRepository } from "../electron/database/repository-facades";
import { ChannelMessageRepository } from "../electron/database/repository-facades";
import path from "node:path";
import * as fs from "node:fs/promises";
import os from "node:os";
import { DatabaseManager } from "../electron/database/schema";
import { SecureSettingsRepository } from "../electron/database/SecureSettingsRepository";
import { describeCronRunStatus } from "../shared/cron-outcomes";
import { PulseService } from "../electron/telemetry/pulse-service";
import { AgentDaemon } from "../electron/agent/daemon";
import { LLMProviderFactory } from "../electron/agent/llm";
import { SearchProviderFactory } from "../electron/agent/search";
import { GuardrailManager } from "../electron/guardrails/guardrail-manager";
import { AppearanceManager } from "../electron/settings/appearance-manager";
import { PersonalityManager } from "../electron/settings/personality-manager";
import { MemoryFeaturesManager } from "../electron/settings/memory-features-manager";
import { importProcessEnvToSettings, migrateEnvToSettings } from "../electron/utils/env-migration";
import {
  getArgValue,
  getControlPlaneAllowedOriginsFromEnv,
  getControlPlaneBindContextFromEnv,
  getEnvSettingsImportModeFromArgsOrEnv,
  isHeadlessMode,
  shouldAllowInsecureControlPlanePublicBindFromEnv,
  shouldEnableControlPlaneFromArgsOrEnv,
  shouldImportEnvSettingsFromArgsOrEnv,
  shouldPrintControlPlaneTokenFromArgsOrEnv,
  shouldTrustControlPlaneProxyFromEnv,
  shouldUseManagedDeploymentModeFromEnv,
} from "../electron/utils/runtime-mode";
import { getActiveProfileId, getUserDataDir } from "../electron/utils/user-data-dir";
import { ChannelGateway } from "../electron/gateway";
import { ControlPlaneServer } from "../electron/control-plane/server";
import { ControlPlaneSettingsManager } from "../electron/control-plane/settings";
import { evaluateControlPlaneDeploymentPosture } from "../electron/control-plane/deployment-posture";
import { TailscaleSettingsManager } from "../electron/tailscale/settings";
import {
  initRemoteGatewayClient,
  shutdownRemoteGatewayClient,
} from "../electron/control-plane/remote-client";
import { getExposureStatus } from "../electron/tailscale";
import { MCPClientManager } from "../electron/mcp/client/MCPClientManager";
import { CronService, setCronService, getCronStorePath } from "../electron/cron";
import { resolveTaskResultText } from "../electron/cron/result-text";
import { TaskEventRepository } from "../electron/database/repositories";
import {
  TaskEventReplayRepository,
  WorkspaceRepository,
} from "../electron/database/repository-facades";
import {
  formatChatTranscriptForPrompt,
  prefetchTranscriptUsers,
} from "../electron/gateway/chat-transcript";
import { CuratedMemoryService } from "../electron/memory/CuratedMemoryService";
import { MemoryService } from "../electron/memory/MemoryService";
import { DurableContextService } from "../electron/memory/DurableContextService";
import { MemoryWriter } from "../electron/memory/MemoryWriter";
import { MemoryRetentionService } from "../electron/memory/MemoryRetentionService";
import { startMemoryEngine } from "../electron/memory/memory-engine-bootstrap";
import { startMemoryRepo, stopMemoryRepo } from "../electron/memory/repo/memory-repo-bootstrap";
import { KnowledgeGraphService } from "../electron/knowledge-graph/KnowledgeGraphService";
import { createKitWriterOwnership } from "../electron/agents/kit-writers";
import type { KitWriterOwnership } from "../electron/agents/kit-writer-ownership";
import { attachAgentDaemonTaskBridge, registerControlPlaneMethods } from "./control-plane-methods";
import { initializeXMentionBridgeService, XMentionBridgeService } from "../electron/x-mentions";
import {
  StrategicPlannerService,
  setStrategicPlannerService,
} from "../electron/control-plane/StrategicPlannerService";
import { attachControlPlaneTaskLifecycleSync } from "../electron/control-plane/task-run-sync";
import { NumbatService } from "../electron/security/numbat";
import { runShutdownSteps, type ShutdownStep } from "../electron/utils/graceful-shutdown";
import { startHostPerfMonitor } from "../electron/utils/host-perf-monitor";
import { startDatabaseWorker, stopDatabaseWorker } from "../electron/database/async/runtime";
import { FtsWorkerClient } from "../electron/database/FtsWorkerClient";
import { createWebHostIdentity } from "../host/web/host-identity";
import { createBrowserHostApplication } from "../host/services/browser-host-application";
import { isBrowserWebEnabled, webDeploymentFromEnv } from "../host/services/browser-web-config";
import { NotificationService } from "../electron/notifications/service";

interface StartedControlPlane {
  server: ControlPlaneServer;
  detachAgentBridge: (() => void) | null;
}

async function readNodeAppVersion(): Promise<string> {
  const manifestPath = path.resolve(__dirname, "../../../package.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8")) as { version?: unknown };
  if (typeof manifest.version !== "string" || !manifest.version.trim()) {
    throw new Error(`Invalid CoWork package version in ${manifestPath}`);
  }
  return manifest.version;
}

async function maybeBootstrapWorkspace(agentDaemon: AgentDaemon): Promise<void> {
  try {
    const bootstrapPathRaw =
      process.env.COWORK_BOOTSTRAP_WORKSPACE_PATH || getArgValue("--bootstrap-workspace");
    if (
      !bootstrapPathRaw ||
      typeof bootstrapPathRaw !== "string" ||
      bootstrapPathRaw.trim().length === 0
    )
      return;

    const raw = bootstrapPathRaw.trim();
    const home = os.homedir();
    const expanded =
      raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw;
    const workspacePath = path.resolve(expanded);
    await fs.mkdir(workspacePath, { recursive: true });

    const existing = agentDaemon.getWorkspaceByPath(workspacePath);
    if (existing) {
      console.log(
        `[Daemon] Bootstrap workspace exists: ${existing.id} (${existing.name}) at ${existing.path}`,
      );
      return;
    }

    const nameFromEnv =
      process.env.COWORK_BOOTSTRAP_WORKSPACE_NAME || getArgValue("--bootstrap-workspace-name");
    const workspaceName =
      typeof nameFromEnv === "string" && nameFromEnv.trim().length > 0
        ? nameFromEnv.trim()
        : path.basename(workspacePath) || "Workspace";

    const ws = agentDaemon.createWorkspace(workspaceName, workspacePath);
    console.log(`[Daemon] Bootstrapped workspace: ${ws.id} (${ws.name}) at ${ws.path}`);
  } catch (error) {
    console.warn("[Daemon] Failed to bootstrap workspace:", error);
  }
}

async function startControlPlane(options: {
  deps: {
    agentDaemon: AgentDaemon;
    dbManager: DatabaseManager;
    channelGateway: ChannelGateway;
    getRoutineService: () => import("../electron/routines/service").RoutineService | null;
  };
  forceEnable: boolean;
  onEvent?: (evt: Any) => void;
}): Promise<{
  ok: boolean;
  skipped?: boolean;
  address?: { host: string; port: number; wsUrl: string };
  error?: string;
  started?: StartedControlPlane;
}> {
  try {
    ControlPlaneSettingsManager.initialize();
    TailscaleSettingsManager.initialize();

    const settings = options.forceEnable
      ? ControlPlaneSettingsManager.enable()
      : ControlPlaneSettingsManager.loadSettings();

    if (!settings.enabled && settings.connectionMode !== "remote") {
      return { ok: true, skipped: true };
    }

    if (settings.connectionMode === "remote") {
      const remoteConfig = settings.remote;
      if (!remoteConfig?.url || !remoteConfig?.token) {
        return {
          ok: false,
          error: "Remote gateway URL and token are required (connectionMode=remote)",
        };
      }

      // Ensure local mode isn't running.
      try {
        // eslint-disable-next-line no-empty
      } catch {}

      const client = initRemoteGatewayClient({
        ...remoteConfig,
        onStateChange: () => {},
        onEvent: () => {},
      });

      await client.connect();
      return { ok: true };
    }

    if (!settings.token) {
      return { ok: false, error: "No authentication token configured" };
    }

    const posture = evaluateControlPlaneDeploymentPosture({
      settings,
      headless: isHeadlessMode(),
      managedDeployment: shouldUseManagedDeploymentModeFromEnv(),
      bindContext: getControlPlaneBindContextFromEnv(),
      allowInsecurePublicBind: shouldAllowInsecureControlPlanePublicBindFromEnv(),
    });
    if (posture.status === "blocked") {
      return {
        ok: false,
        error: `Control Plane deployment posture blocked startup: ${posture.reasons.join(" ")}`,
      };
    }
    if (posture.status === "degraded") {
      console.warn(
        `[Daemon] Control Plane deployment posture degraded: ${posture.reasons.join(" ")}`,
      );
    }

    const server = new ControlPlaneServer({
      port: settings.port,
      host: settings.host,
      trustProxy: settings.trustProxy,
      token: settings.token,
      handshakeTimeoutMs: settings.handshakeTimeoutMs,
      heartbeatIntervalMs: settings.heartbeatIntervalMs,
      maxPayloadBytes: settings.maxPayloadBytes,
      allowedOrigins: settings.allowedOrigins,
      onEvent: (evt) => options.onEvent?.(evt),
    });

    registerControlPlaneMethods(server, options.deps);
    const detach = attachAgentDaemonTaskBridge(server, options.deps.agentDaemon);

    try {
      await server.startWithTailscale();
      const address = server.getAddress();
      return {
        ok: true,
        address: address || undefined,
        started: { server, detachAgentBridge: detach },
      };
    } catch (error) {
      try {
        detach();
      } catch {
        // Best effort detach on startup failure.
      }
      try {
        await server.stop();
      } catch {
        // Best effort server shutdown on startup failure.
      }
      throw error;
    }
  } catch (error: Any) {
    console.error("[Daemon] Control Plane start error:", error);
    return { ok: false, error: error?.message || String(error) };
  }
}

async function main(): Promise<void> {
  // Daemon is always headless; set an env flag to keep core logic consistent even if the caller
  // forgot to pass `--headless`.
  // Also when `--headless` is passed with a different env value: worker threads see
  // only the env, and must apply the same headless approval policy.
  if (!process.env.COWORK_HEADLESS || isHeadlessMode()) {
    process.env.COWORK_HEADLESS = "1";
  }
  const HEADLESS = isHeadlessMode();
  const FORCE_ENABLE_CONTROL_PLANE = shouldEnableControlPlaneFromArgsOrEnv();
  const PRINT_CONTROL_PLANE_TOKEN = shouldPrintControlPlaneTokenFromArgsOrEnv();
  const IMPORT_ENV_SETTINGS = shouldImportEnvSettingsFromArgsOrEnv();
  const IMPORT_ENV_SETTINGS_MODE = getEnvSettingsImportModeFromArgsOrEnv();

  const userDataDir = getUserDataDir();
  const appVersion = await readNodeAppVersion();
  await fs.mkdir(userDataDir, { recursive: true });

  console.log("[Daemon] Starting CoWork OS (Node-only)");
  console.log(`[Daemon] userData: ${userDataDir}`);
  console.log(`[Daemon] headless: ${HEADLESS}`);

  // Initialize database first - required for SecureSettingsRepository.
  // Schema initialization runs in a bootstrap worker (DB6).
  const dbManager = await DatabaseManager.open();
  setBackgroundDispatchBudget(
    new PersistentDispatchBudget(dbManager.getDatabase(), {
      getSchedulerFence: () => automationRuntime.captureFence(),
    }),
  );
  const automationRuntime = new AutomationRuntime("node");
  automationRuntime.attachOwnership(new SchedulerOwnership(dbManager.getDatabase()));
  setAutomationRuntime(automationRuntime);
  dbManager.beginRun("daemon");
  let databaseWorkerDrained = true;
  const hostPerfMonitor = startHostPerfMonitor({ runtime: "daemon" });
  // Opt-in database worker (async SQLite plan, DB2); starts after schema setup.
  await startDatabaseWorker({ dbPath: dbManager.getDatabasePath(), runtime: "daemon" });
  new SecureSettingsRepository(dbManager.getDatabase());
  console.log("[Daemon] SecureSettingsRepository initialized");
  // Opt-in telemetry must never block daemon startup.
  let pulseService: PulseService | null = null;
  try {
    pulseService = new PulseService(dbManager.getDatabase(), {
      version: appVersion,
      runtime: "daemon",
    });
    pulseService.start();
  } catch (error) {
    console.warn(
      `[Daemon] CoWork Pulse could not start: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  // Initialize provider factories (loads settings from disk, migrates legacy files).
  LLMProviderFactory.initialize();
  SearchProviderFactory.initialize();
  GuardrailManager.initialize();
  AppearanceManager.initialize();
  PersonalityManager.initialize();
  MemoryFeaturesManager.initialize();

  // Migrate .env configuration to Settings (one-time upgrade path).
  await migrateEnvToSettings();

  // Optional: import process.env keys into Settings (explicit opt-in; useful for headless/server deployments).
  if (IMPORT_ENV_SETTINGS) {
    const importResult = await importProcessEnvToSettings({
      mode: IMPORT_ENV_SETTINGS_MODE,
    });
    if (importResult.migrated && importResult.migratedKeys.length > 0) {
      console.log(
        `[Daemon] Imported credentials from process.env (${IMPORT_ENV_SETTINGS_MODE}): ${importResult.migratedKeys.join(", ")}`,
      );
    }
    if (importResult.error) {
      console.warn("[Daemon] Failed to import credentials from process.env:", importResult.error);
    }
  }

  // Headless deployments commonly forget to configure LLM creds; warn early with a concrete next step.
  if (HEADLESS) {
    try {
      const llmSettings = LLMProviderFactory.loadSettings();
      const hasAnyLlmCreds = !!(
        llmSettings?.anthropic?.apiKey ||
        llmSettings?.anthropic?.subscriptionToken ||
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
          "[Daemon] No LLM credentials configured. In headless mode, set COWORK_IMPORT_ENV_SETTINGS=1 and an LLM key (e.g. OPENAI_API_KEY or ANTHROPIC_API_KEY), then restart.",
        );
      }
    } catch (error) {
      console.warn("[Daemon] Failed to check LLM credential configuration:", error);
    }
  }

  let ftsWorkerClient: FtsWorkerClient | null = null;
  // The host connection for the memory-side services below (one handle, as on desktop).
  const memoryHostDb = dbManager.getDatabase();
  let stopMemoryEngine: (() => void) | null = null;
  let memoryRetentionService: MemoryRetentionService | null = null;
  // Initialize memory before queue recovery starts. AgentDaemon.initialize() can
  // immediately resume queued tasks, and their early timeline events capture to memory.
  try {
    MemoryService.initialize(dbManager);
    CuratedMemoryService.initialize(dbManager);
    // Memory engine, as on desktop (docs/memory-engine.md): the MemoryWriter, the one-time
    // lane migration (awaited before anything reads memory), the read-side syncs and the
    // facts snapshot. The migration is claimed in the database, so a desktop app on the
    // same profile never runs it at the same time.
    const memoryStatements = MemoryService.getStatements();
    if (memoryStatements) {
      stopMemoryEngine = await startMemoryEngine(memoryStatements, {
        getWorkspacePolicy: (workspaceId) => MemoryService.getSettings(workspaceId),
      });
    }
    // Memory repo, as on desktop: off unless enabled; stopped by the "memory repo" step.
    const memoryRepoWorkspaces = new WorkspaceRepository(memoryHostDb);
    const memoryRepoTasks = new TaskRepository(memoryHostDb);
    const memoryRepoTaskEvents = new TaskEventReplayRepository(memoryHostDb);
    void startMemoryRepo({
      runtime: "node",
      getWorkspacePolicy: (workspaceId) => MemoryService.getSettings(workspaceId),
      listWorkspacePaths: async () => (await memoryRepoWorkspaces.findAll()).map((w) => w.path),
      workspaceName: async (id) => (await memoryRepoWorkspaces.findById(id))?.name ?? null,
      findTasksCreatedBetween: (params) => memoryRepoTasks.findByCreatedAtRange(params),
      findTaskEvents: (taskId, types, maxEvents) =>
        memoryRepoTaskEvents.findByTaskIdAndTypes(taskId, types, maxEvents),
    });
    console.log("[Daemon] Memory Service initialized");
  } catch (error) {
    console.error("[Daemon] Failed to initialize Memory Service:", error);
  }
  // Daily retention for memory items and background-loop history (LIFE-3); the first
  // run is deferred well past startup.
  try {
    memoryRetentionService = new MemoryRetentionService();
    memoryRetentionService.start();
  } catch (error) {
    console.error("[Daemon] Failed to start memory retention:", error);
  }
  try {
    // Knowledge graph lane of memory recall and the kg_* tools (database only).
    KnowledgeGraphService.initialize(memoryHostDb);
  } catch (error) {
    console.error("[Daemon] Failed to initialize Knowledge Graph Service:", error);
  }
  try {
    // Off-main-thread memory search, as on desktop; without it prompt recall returns nothing.
    ftsWorkerClient = new FtsWorkerClient(dbManager.getDatabasePath());
    MemoryService.initFtsWorker(ftsWorkerClient);
  } catch (error) {
    console.error("[Daemon] Failed to start the memory search worker:", error);
  }

  // Initialize agent daemon.
  const numbatService = NumbatService.initialize(dbManager.getDatabase());
  const agentDaemon = new AgentDaemon(dbManager);
  const botInboxNotifications = new NotificationService({ db: dbManager.getDatabase() });
  automationRuntime.registerRecovery(
    new BotWorkControlRecovery(
      dbManager.getDatabase(),
      agentDaemon,
      automationRuntime,
      new BotNotificationRuntime(
        dbManager.getDatabase(),
        automationRuntime,
        () => botInboxNotifications,
        false,
      ),
    ),
  );
  numbatService.attachTaskEventEmitter((taskId, type, payload) => {
    agentDaemon.logEvent(taskId, type, payload);
  });
  await agentDaemon.initialize();
  const detachTaskLifecycleSync = attachControlPlaneTaskLifecycleSync({
    agentDaemon,
    db: dbManager.getDatabase(),
    log: (...args) => console.warn(...args),
  });

  await maybeBootstrapWorkspace(agentDaemon);

  // Workspace kit writers (cross-agent signals, feedback, lore; best-effort), as on desktop.
  // They run only while this process owns the profile's kit-writer lease; a desktop app on
  // the same profile takes it over, and the daemon takes it back when the desktop quits.
  let kitWriterOwnership: KitWriterOwnership | null = null;
  try {
    kitWriterOwnership = createKitWriterOwnership({
      db: memoryHostDb,
      agentDaemon,
      runtime: "node",
    });
    const owned = await kitWriterOwnership.start();
    console.log(
      owned
        ? "[Daemon] Kit writers started"
        : "[Daemon] Kit writers waiting for the kit-writer lease (another process owns it)",
    );
  } catch (error) {
    kitWriterOwnership = null;
    console.error("[Daemon] Failed to start the kit writers:", error);
  }

  // Initialize MCP client manager (best-effort).
  let mcpClientManager: MCPClientManager | null = null;
  try {
    mcpClientManager = MCPClientManager.getInstance();
    await mcpClientManager.initialize();
    console.log("[Daemon] MCP Client Manager initialized");
  } catch (error) {
    console.error("[Daemon] Failed to initialize MCP Client Manager:", error);
  }

  // Admin policy connectors.blocked: apply policies.json edits without a restart.
  let stopConnectorPolicyWatch: (() => void) | null = null;
  if (mcpClientManager) {
    const manager = mcpClientManager;
    try {
      stopConnectorPolicyWatch = watchPolicies(() => {
        void manager.reconcileConnectorPolicy().catch((error) => {
          console.error("[Daemon] Failed to apply connector policy change:", error);
        });
      });
    } catch (error) {
      console.error("[Daemon] Failed to watch admin policies:", error);
    }
  }

  // Initialize channel gateway (no UI).
  const channelGateway = new ChannelGateway(dbManager.getDatabase(), {
    autoConnect: true,
    agentDaemon,
  });
  let xMentionBridgeService: XMentionBridgeService | null = null;
  try {
    await channelGateway.initialize();
    xMentionBridgeService = initializeXMentionBridgeService(agentDaemon, {
      isNativeXChannelEnabled: async () => {
        const nativeX = await channelGateway.getChannelByType("x");
        return nativeX?.enabled === true && nativeX.status === "connected";
      },
    });
    xMentionBridgeService.start();
    console.log("[Daemon] Channel Gateway initialized");
  } catch (error) {
    console.error("[Daemon] Failed to initialize Channel Gateway:", error);
  }

  // Initialize Cron Service for scheduled tasks (best-effort).
  let cronService: CronService | null = null;
  let botAutomation: ReturnType<typeof createHeadlessBotAutomation> | null = null;
  try {
    const db = dbManager.getDatabase();
    const taskRepo = new TaskRepository(db);
    const taskEventRepo = new TaskEventRepository(db);
    const channelRepo = new ChannelRepository(db);
    const channelUserRepo = new ChannelUserRepository(db);
    const channelMessageRepo = new ChannelMessageRepository(db);

    cronService = new CronService({
      beforeExecuteJob: async (job) => {
        await automationRuntime.assertOwnership();
        await new BotResponsibilityRepository(db).assertCronJobMayExecute(job.id);
        return prepareResponsibilitySchedule(db, job, {
          settings: PermissionSettingsManager.loadSettings(),
          adminPolicies: loadPolicies(),
        });
      },
      beforeDeliverJob: async (jobId) => {
        await automationRuntime.assertOwnership();
        await new BotResponsibilityRepository(db).assertCronJobMayDeliver(jobId);
      },
      cronEnabled: true,
      runnerKind: "daemon",
      storePath: getCronStorePath(),
      maxConcurrentRuns: 3,
      webhook: {
        enabled: false,
        port: 9876,
        host: "127.0.0.1",
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
          ...(params.assignedAgentRoleId
            ? { taskOverrides: { assignedAgentRoleId: params.assignedAgentRoleId } }
            : {}),
          agentConfig: {
            ...mergedAgentConfig,
            backgroundSchedulerFence: automationRuntime.captureFence(),
          },
          source: "cron",
        });
        return { id: task.id };
      },
      sendTaskMessage: async (params) => {
        await automationRuntime.assertOwnership();
        const task = await taskRepo.findById(params.taskId);
        if (!task) {
          throw new Error(`Target task not found: ${params.taskId}`);
        }
        return agentDaemon.sendMessage(params.taskId, params.message, undefined, undefined, {
          agentConfigOverride:
            params.agentConfig && Object.keys(params.agentConfig).length > 0
              ? {
                  ...params.agentConfig,
                  allowUserInput: params.allowUserInput ?? params.agentConfig.allowUserInput,
                }
              : undefined,
        });
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
            ? {
                channelType: job.delivery.channelType,
                channelId: job.delivery.channelId,
              }
            : null);
        const channelType = chatContext?.channelType;
        const chatId = chatContext?.channelId;
        if (!channelType || !chatId) return {};

        const channel = await channelRepo.findByType(channelType as Any);
        if (!channel) return {};

        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        const sinceMs = Math.max(
          0,
          Number.isFinite(prevRunAtMs) ? prevRunAtMs! : runAtMs - sevenDaysMs,
        );

        const raw = await channelMessageRepo.findByChatId(channel.id, chatId, 500);
        const lookupUser = await prefetchTranscriptUsers(raw, (id) => channelUserRepo.findById(id));

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
      findTaskForRun: async ({ workspaceId, jobId, runAtMs }) =>
        taskRepo.findByScheduledRun(workspaceId, jobId, runAtMs),
      getTaskStatus: async (taskId) => {
        const task = await taskRepo.findById(taskId);
        if (!task) return null;
        return {
          status: task.status,
          error: task.error ?? null,
          resultSummary: task.resultSummary ?? null,
          terminalStatus: task.terminalStatus ?? null,
        };
      },
      getTaskResultText: async (taskId) => {
        const task = await taskRepo.findById(taskId);
        const events = taskEventRepo.findByTaskId(taskId);
        return resolveTaskResultText({
          summary: task?.resultSummary,
          events,
        });
      },
      deliverToChannel: async (params) => {
        await automationRuntime.assertOwnership();
        const hasResult =
          params.status === "ok" &&
          !params.summaryOnly &&
          typeof params.resultText === "string" &&
          params.resultText.trim().length > 0;
        const statusLabel = describeCronRunStatus(params.status);
        const statusEmoji = statusLabel.emoji;
        const message = hasResult
          ? `**${params.jobName}**\n\n${params.resultText!.trim()}`
          : (() => {
              let msg = `${statusEmoji} **Scheduled Task: ${params.jobName}**\n\n`;

              msg += `${statusLabel.sentence}\n`;

              if (params.error) {
                msg += `\n**Error:** ${params.error}\n`;
              }

              if (params.taskId && !params.summaryOnly) {
                msg += `\n_Task ID: ${params.taskId}_`;
              }

              return msg;
            })();

        try {
          await channelGateway.sendMessage(params.channelType as Any, params.channelId, message, {
            channelDbId: params.channelDbId,
            parseMode: "markdown",
            idempotencyKey: params.idempotencyKey,
          });
          console.log(`[Cron] Delivered to ${params.channelType}:${params.channelId}`);
        } catch (err) {
          console.error(
            `[Cron] Failed to deliver to ${params.channelType}:${params.channelId}:`,
            err,
          );
          throw err;
        }
      },
      onEvent: async (evt) => {
        console.log("[Cron] Event:", evt.action, evt.jobId);
        await botAutomation?.routines.recordScheduledEvent(evt);
      },
    });

    setCronService(cronService);
    botAutomation = createHeadlessBotAutomation({
      db: dbManager.getDatabase(),
      runtime: automationRuntime,
      agentDaemon,
      channelGateway,
      getCronService: () => cronService,
      mcpClientManager,
      log: (...args) => console.warn("[BotAutomation]", ...args),
    });
    await botAutomation.start();
    automationRuntime.register("cron", cronService);
    await automationRuntime.start("cron");
    console.log("[Daemon] Cron Service initialized");
  } catch (error) {
    console.error("[Daemon] Failed to initialize Cron Service:", error);
  }

  let strategicPlannerService: StrategicPlannerService | null = null;
  try {
    strategicPlannerService = new StrategicPlannerService({
      db: dbManager.getDatabase(),
      agentDaemon,
      log: (...args) => console.log(...args),
    });
    setStrategicPlannerService(strategicPlannerService);
    automationRuntime.register("strategic_planner", strategicPlannerService);
    await automationRuntime.start("strategic_planner");
    console.log("[Daemon] Strategic Planner initialized");
  } catch (error) {
    console.error("[Daemon] Failed to initialize Strategic Planner:", error);
  }

  // Control Plane token printing gating.
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

  // Apply Control Plane host/port overrides.
  const cpHost = process.env.COWORK_CONTROL_PLANE_HOST || getArgValue("--control-plane-host");
  const cpPortRaw = process.env.COWORK_CONTROL_PLANE_PORT || getArgValue("--control-plane-port");
  const cpPort = cpPortRaw ? Number.parseInt(cpPortRaw, 10) : undefined;
  const cpAllowedOrigins = getControlPlaneAllowedOriginsFromEnv();
  if (
    (typeof cpHost === "string" && cpHost.trim()) ||
    (typeof cpPort === "number" && Number.isFinite(cpPort)) ||
    typeof cpAllowedOrigins !== "undefined" ||
    process.env.COWORK_CONTROL_PLANE_TRUST_PROXY !== undefined
  ) {
    try {
      ControlPlaneSettingsManager.updateSettings({
        ...(typeof cpHost === "string" && cpHost.trim() ? { host: cpHost.trim() } : {}),
        ...(typeof cpPort === "number" && Number.isFinite(cpPort) ? { port: cpPort } : {}),
        ...(typeof cpAllowedOrigins !== "undefined" ? { allowedOrigins: cpAllowedOrigins } : {}),
        ...(process.env.COWORK_CONTROL_PLANE_TRUST_PROXY !== undefined
          ? { trustProxy: shouldTrustControlPlaneProxyFromEnv() }
          : {}),
      });
    } catch (error) {
      console.warn("[Daemon] Failed to apply Control Plane overrides:", error);
    }
  }

  // Start Control Plane (local by default).
  let startedControlPlane: StartedControlPlane | null = null;
  const cp = await startControlPlane({
    deps: {
      agentDaemon,
      dbManager,
      channelGateway,
      getRoutineService: () => botAutomation?.routines ?? null,
    },
    forceEnable: FORCE_ENABLE_CONTROL_PLANE,
    onEvent: (evt) => {
      try {
        const action = typeof evt?.action === "string" ? evt.action : "event";
        console.log(`[ControlPlane] ${action}`);
      } catch {
        // ignore
      }
    },
  });

  if (!cp.ok) {
    console.error("[Daemon] Control Plane failed to start:", cp.error);
  } else if (!cp.skipped && cp.address) {
    startedControlPlane = cp.started ?? null;
    console.log(`[Daemon] Control Plane listening: ${cp.address.wsUrl}`);
    const tailscale = getExposureStatus();
    if (tailscale.active && tailscale.httpsUrl) {
      console.log(`[Daemon] Tailscale URL: ${tailscale.httpsUrl}`);
    }
    if (
      (FORCE_ENABLE_CONTROL_PLANE || PRINT_CONTROL_PLANE_TOKEN) &&
      (PRINT_CONTROL_PLANE_TOKEN || !hadControlPlaneToken)
    ) {
      try {
        const settings = ControlPlaneSettingsManager.loadSettings();
        if (settings?.token) {
          console.log(`[Daemon] Control Plane token: ${settings.token}`);
        }
      } catch {
        // ignore
      }
    }
  } else if (cp.skipped) {
    console.log("[Daemon] Control Plane disabled (skipping auto-start)");
  }

  if (isBrowserWebEnabled()) {
    if (!startedControlPlane?.server?.isRunning) {
      console.warn(
        "[Daemon] Browser app requested, but no local Control Plane listener is running.",
      );
    } else {
      try {
        const notificationService = botInboxNotifications;
        const identity = await createWebHostIdentity({
          userDataDir,
          profileId: getActiveProfileId(),
          runtime: "node",
          appVersion,
        });
        const browserDb = dbManager.getDatabase();
        const browserApp = createBrowserHostApplication({
          db: browserDb,
          webDirectory: path.resolve(__dirname, "../../web"),
          deployment: webDeploymentFromEnv(),
          identity,
          taskCommands: agentDaemon,
          agentDaemon,
          channelGateway,
          notificationService,
        });
        await startedControlPlane.server.setWebApplication(browserApp);
        startedControlPlane.server.registerMethod("web.pair", async (client) => {
          if (!client.hasScope("admin")) throw new Error("Admin scope is required.");
          return browserApp.createPairingCode("control-plane");
        });
        console.log(
          "[Daemon] Browser app enabled. Use an admin Control Plane client to call web.pair.",
        );
      } catch (error) {
        console.error("[Daemon] Browser app failed to start:", error);
      }
    }
  }

  let shutdownPromise: Promise<void> | undefined;
  let fatalShutdownRequested = false;
  const shutdown = (reason: string): Promise<void> => {
    if (reason === "uncaughtException") fatalShutdownRequested = true;
    if (shutdownPromise) return shutdownPromise;

    shutdownPromise = (async () => {
      console.log(`[Daemon] Shutting down (${reason})...`);
      const steps: readonly ShutdownStep[] = [
        // Stop automation ingress before fencing the agent; keep storage open for drains.
        { name: "bot automation", run: () => botAutomation?.stop() },
        { name: "automation ownership", run: () => automationRuntime.shutdown() },
        // Fence and drain the agent before closing anything it may still use.
        { name: "agent daemon", run: () => agentDaemon.shutdown() },
        {
          name: "remote gateway",
          requiresQuiescence: true,
          run: () => shutdownRemoteGatewayClient(),
        },
        {
          name: "control plane bridge",
          requiresQuiescence: true,
          run: () => startedControlPlane?.detachAgentBridge?.(),
        },
        {
          name: "control plane",
          requiresQuiescence: true,
          run: async () => {
            if (startedControlPlane?.server?.isRunning) await startedControlPlane.server.stop();
          },
        },
        {
          name: "X mention bridge",
          requiresQuiescence: true,
          run: () => {
            xMentionBridgeService?.stop();
            xMentionBridgeService = null;
          },
        },
        {
          name: "channel gateway",
          requiresQuiescence: true,
          run: () => channelGateway.shutdown(),
        },
        {
          name: "strategic planner",
          requiresQuiescence: true,
          run: async () => {
            await automationRuntime.stop("strategic_planner");
            setStrategicPlannerService(null);
          },
        },
        {
          name: "cron",
          requiresQuiescence: true,
          run: async () => {
            await automationRuntime.stop("cron");
          },
        },
        { name: "task lifecycle sync", run: () => detachTaskLifecycleSync() },
        {
          name: "security monitor",
          requiresQuiescence: true,
          run: () => NumbatService.getInstance()?.shutdown(),
        },
        {
          name: "connector policy watch",
          run: () => {
            stopConnectorPolicyWatch?.();
            stopConnectorPolicyWatch = null;
          },
        },
        // Lore, cross signals, feedback: flush and release the kit-writer lease.
        {
          name: "kit writers",
          run: async () => {
            await kitWriterOwnership?.stop();
            kitWriterOwnership = null;
          },
        },
        // Finish the memory repo write in progress (bounded) and stop its writer.
        {
          name: "memory repo",
          requiresQuiescence: true,
          run: () => stopMemoryRepo(),
        },
        {
          name: "MCP servers",
          requiresQuiescence: true,
          run: () => mcpClientManager?.shutdown(),
        },
        // Stop the deferred memory jobs and let queued memory_items writes land.
        {
          name: "memory engine",
          requiresQuiescence: true,
          run: async () => {
            memoryRetentionService?.stop();
            memoryRetentionService = null;
            stopMemoryEngine?.();
            stopMemoryEngine = null;
            await MemoryWriter.get()?.flush();
          },
        },
        // Conversation-index writes are batched (250 ms); write the queue before closing.
        {
          name: "conversation index",
          requiresQuiescence: true,
          run: () => DurableContextService.flushIndexQueue(),
        },
        {
          name: "memory",
          requiresQuiescence: true,
          // Let a running compression batch, markdown sync or cleanup finish first.
          run: async () => {
            await MemoryService.drain();
            MemoryService.shutdown();
          },
        },
        // Settle in-flight Pulse requests so no late callback writes to a closed database.
        { name: "pulse", run: () => pulseService?.shutdown() },
        { name: "host perf monitor", run: () => hostPerfMonitor.stop() },
        { name: "memory search worker", run: () => ftsWorkerClient?.destroy() },
        {
          name: "database worker",
          requiresQuiescence: true,
          run: async () => {
            databaseWorkerDrained = (await stopDatabaseWorker()).drained;
          },
        },
        {
          name: "database",
          requiresQuiescence: true,
          // A failed step or an undrained worker leaves this run marked incomplete (DB6).
          run: ({ quiescent }) => dbManager.close({ clean: quiescent && databaseWorkerDrained }),
        },
      ];

      let quiescent = false;
      try {
        const result = await runShutdownSteps(
          steps,
          (step, error) => console.warn(`[Daemon] Failed to stop ${step}:`, error),
          10_000,
        );
        quiescent = result.quiescent;
        if (result.skippedSteps.length > 0) {
          console.warn(
            `[Daemon] Skipped dependent shutdown steps after non-quiescent stop: ${result.skippedSteps.join(", ")}`,
          );
        }
      } catch (error) {
        console.error("[Daemon] Shutdown coordinator failed:", error);
      }

      // eslint-disable-next-line no-process-exit
      process.exit(fatalShutdownRequested || !quiescent ? 1 : 0);
    })();

    return shutdownPromise;
  };

  process.on("SIGINT", () => {
    void shutdown("SIGINT");
  });
  process.on("SIGTERM", () => {
    void shutdown("SIGTERM");
  });
  process.on("uncaughtException", (err) => {
    console.error("[Daemon] uncaughtException:", err);
    void shutdown("uncaughtException");
  });
  process.on("unhandledRejection", (reason) => {
    console.error("[Daemon] unhandledRejection:", reason);
  });
}

void main().catch((err) => {
  console.error(err?.stack || String(err));
  // eslint-disable-next-line no-process-exit
  process.exit(1);
});
