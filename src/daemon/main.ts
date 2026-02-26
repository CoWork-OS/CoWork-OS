import path from "node:path";
import * as fs from "node:fs/promises";
import os from "node:os";
import { DatabaseManager } from "../electron/database/schema";
import { SecureSettingsRepository } from "../electron/database/SecureSettingsRepository";
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
  getEnvSettingsImportModeFromArgsOrEnv,
  isHeadlessMode,
  shouldEnableControlPlaneFromArgsOrEnv,
  shouldImportEnvSettingsFromArgsOrEnv,
  shouldPrintControlPlaneTokenFromArgsOrEnv,
} from "../electron/utils/runtime-mode";
import { getUserDataDir } from "../electron/utils/user-data-dir";
import { ChannelGateway } from "../electron/gateway";
import { ControlPlaneServer } from "../electron/control-plane/server";
import { ControlPlaneSettingsManager } from "../electron/control-plane/settings";
import { TailscaleSettingsManager } from "../electron/tailscale/settings";
import {
  initRemoteGatewayClient,
  shutdownRemoteGatewayClient,
} from "../electron/control-plane/remote-client";
import { getExposureStatus } from "../electron/tailscale";
import { MCPClientManager } from "../electron/mcp/client/MCPClientManager";
import { CronService, setCronService, getCronStorePath } from "../electron/cron";
import {
  TaskEventRepository,
  TaskRepository,
  WorkspaceRepository as _WorkspaceRepository,
  ChannelRepository,
  ChannelUserRepository,
  ChannelMessageRepository,
} from "../electron/database/repositories";
import { formatChatTranscriptForPrompt } from "../electron/gateway/chat-transcript";
import { MemoryService } from "../electron/memory/MemoryService";
import { CrossSignalService } from "../electron/agents/CrossSignalService";
import { FeedbackService } from "../electron/agents/FeedbackService";
import { attachAgentDaemonTaskBridge, registerControlPlaneMethods } from "./control-plane-methods";

interface StartedControlPlane {
  server: ControlPlaneServer;
  detachAgentBridge: (() => void) | null;
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
  deps: { agentDaemon: AgentDaemon; dbManager: DatabaseManager; channelGateway: ChannelGateway };
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

    if (!settings.enabled) {
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

    const server = new ControlPlaneServer({
      port: settings.port,
      host: settings.host,
      token: settings.token,
      handshakeTimeoutMs: settings.handshakeTimeoutMs,
      heartbeatIntervalMs: settings.heartbeatIntervalMs,
      maxPayloadBytes: settings.maxPayloadBytes,
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
  if (!process.env.COWORK_HEADLESS) {
    process.env.COWORK_HEADLESS = "1";
  }
  const HEADLESS = isHeadlessMode();
  const FORCE_ENABLE_CONTROL_PLANE = shouldEnableControlPlaneFromArgsOrEnv();
  const PRINT_CONTROL_PLANE_TOKEN = shouldPrintControlPlaneTokenFromArgsOrEnv();
  const IMPORT_ENV_SETTINGS = shouldImportEnvSettingsFromArgsOrEnv();
  const IMPORT_ENV_SETTINGS_MODE = getEnvSettingsImportModeFromArgsOrEnv();

  const userDataDir = getUserDataDir();
  await fs.mkdir(userDataDir, { recursive: true });

  console.log("[Daemon] Starting CoWork OS (Node-only)");
  console.log(`[Daemon] userData: ${userDataDir}`);
  console.log(`[Daemon] headless: ${HEADLESS}`);

  // Initialize database first - required for SecureSettingsRepository.
  const dbManager = new DatabaseManager();
  new SecureSettingsRepository(dbManager.getDatabase());
  console.log("[Daemon] SecureSettingsRepository initialized");

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
    const importResult = await importProcessEnvToSettings({ mode: IMPORT_ENV_SETTINGS_MODE });
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

  // Initialize agent daemon.
  const agentDaemon = new AgentDaemon(dbManager);
  await agentDaemon.initialize();

  await maybeBootstrapWorkspace(agentDaemon);

  // Optional cross-agent helpers (best-effort).
  try {
    const crossSignalService = new CrossSignalService(dbManager.getDatabase());
    await crossSignalService.start(agentDaemon);
    console.log("[Daemon] CrossSignalService initialized");
  } catch (error) {
    console.error("[Daemon] Failed to initialize CrossSignalService:", error);
  }

  try {
    const feedbackService = new FeedbackService(dbManager.getDatabase());
    await feedbackService.start(agentDaemon);
    console.log("[Daemon] FeedbackService initialized");
  } catch (error) {
    console.error("[Daemon] Failed to initialize FeedbackService:", error);
  }

  try {
    MemoryService.initialize(dbManager);
    console.log("[Daemon] Memory Service initialized");
  } catch (error) {
    console.error("[Daemon] Failed to initialize Memory Service:", error);
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

  // Initialize channel gateway (no UI).
  const channelGateway = new ChannelGateway(dbManager.getDatabase(), {
    autoConnect: true,
    agentDaemon,
  });
  try {
    await channelGateway.initialize();
    console.log("[Daemon] Channel Gateway initialized");
  } catch (error) {
    console.error("[Daemon] Failed to initialize Channel Gateway:", error);
  }

  // Initialize Cron Service for scheduled tasks (best-effort).
  let cronService: CronService | null = null;
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

        const channel = channelRepo.findByType(channelType as Any);
        if (!channel) return {};

        const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
        const sinceMs = Math.max(
          0,
          Number.isFinite(prevRunAtMs) ? prevRunAtMs! : runAtMs - sevenDaysMs,
        );

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

        const events = taskEventRepo.findByTaskId(taskId);
        for (let i = events.length - 1; i >= 0; i--) {
          const evt = events[i];
          if (evt.type !== "assistant_message") continue;
          const payload = evt.payload || {};
          const text =
            (typeof (payload as Any).message === "string" ? (payload as Any).message : "") ||
            (typeof (payload as Any).content === "string" ? (payload as Any).content : "");
          const trimmed = String(text).trim();
          if (trimmed) return trimmed;
        }
        return undefined;
      },
      deliverToChannel: async (params) => {
        const hasResult =
          params.status === "ok" &&
          !params.summaryOnly &&
          typeof params.resultText === "string" &&
          params.resultText.trim().length > 0;
        const statusEmoji = params.status === "ok" ? "✅" : params.status === "error" ? "❌" : "⏱️";
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
          await channelGateway.sendMessage(params.channelType as Any, params.channelId, message, {
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
        console.log("[Cron] Event:", evt.action, evt.jobId);
      },
    });

    setCronService(cronService);
    await cronService.start();
    console.log("[Daemon] Cron Service initialized");
  } catch (error) {
    console.error("[Daemon] Failed to initialize Cron Service:", error);
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
      console.warn("[Daemon] Failed to apply Control Plane overrides:", error);
    }
  }

  // Start Control Plane (local by default).
  let startedControlPlane: StartedControlPlane | null = null;
  const cp = await startControlPlane({
    deps: { agentDaemon, dbManager, channelGateway },
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

  const shutdown = async (reason: string) => {
    console.log(`[Daemon] Shutting down (${reason})...`);
    try {
      await shutdownRemoteGatewayClient();
    } catch {
      // ignore
    }
    try {
      if (startedControlPlane?.detachAgentBridge) startedControlPlane.detachAgentBridge();
    } catch {
      // ignore
    }
    try {
      if (startedControlPlane?.server?.isRunning) await startedControlPlane.server.stop();
    } catch (error) {
      console.warn("[Daemon] Failed to stop Control Plane:", error);
    }
    try {
      await channelGateway.shutdown();
    } catch (error) {
      console.warn("[Daemon] Failed to shutdown Channel Gateway:", error);
    }
    try {
      if (cronService) await cronService.stop();
    } catch (error) {
      console.warn("[Daemon] Failed to stop Cron Service:", error);
    }
    try {
      if (mcpClientManager) await mcpClientManager.shutdown();
    } catch (error) {
      console.warn("[Daemon] Failed to shutdown MCP Client Manager:", error);
    }
    try {
      await agentDaemon.shutdown();
    } catch (error) {
      console.warn("[Daemon] Failed to shutdown AgentDaemon:", error);
    }
    // eslint-disable-next-line no-process-exit
    process.exit(0);
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
