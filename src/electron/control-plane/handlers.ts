/**
 * Control Plane IPC Handlers
 *
 * IPC handlers for managing the WebSocket control plane from the renderer.
 */

import { app, ipcMain, BrowserWindow } from "electron";
import { randomUUID } from "crypto";
import * as fs from "fs/promises";
import path from "path";
import { IPC_CHANNELS, isTempWorkspaceId } from "../../shared/types";
import type {
  ControlPlaneSettingsData,
  ControlPlaneStatus,
  TailscaleAvailability,
  TailscaleMode,
  RemoteGatewayConfig,
  RemoteGatewayStatus,
  SSHTunnelConfig,
  SSHTunnelStatus,
} from "../../shared/types";
import { ControlPlaneServer, ControlPlaneSettingsManager } from "./index";
import { Methods, Events, ErrorCodes } from "./protocol";
import type { AgentConfig } from "../../shared/types";
import type { AgentDaemon } from "../agent/daemon";
import type { DatabaseManager } from "../database/schema";
import type { ChannelGateway } from "../gateway";
import {
  ApprovalRepository,
  TaskEventRepository,
  TaskRepository,
  WorkspaceRepository,
} from "../database/repositories";
import { SearchProviderFactory } from "../agent/search";
import { configureLlmFromControlPlaneParams, getControlPlaneLlmStatus } from "./llm-configure";
import { checkTailscaleAvailability, getExposureStatus } from "../tailscale";
import { registerACPMethods, shutdownACP, type ACPHandlerDeps } from "../acp";
import { AgentRoleRepository } from "../agents/AgentRoleRepository";
import { TailscaleSettingsManager } from "../tailscale/settings";
import {
  RemoteGatewayClient,
  initRemoteGatewayClient,
  getRemoteGatewayClient,
  shutdownRemoteGatewayClient,
} from "./remote-client";
import {
  SSHTunnelManager,
  initSSHTunnelManager,
  getSSHTunnelManager,
  shutdownSSHTunnelManager,
} from "./ssh-tunnel";
import {
  getEnvSettingsImportModeFromArgsOrEnv,
  isHeadlessMode,
  shouldImportEnvSettingsFromArgsOrEnv,
} from "../utils/runtime-mode";
import { getUserDataDir } from "../utils/user-data-dir";
import { CanvasManager } from "../canvas/canvas-manager";
import { TASK_EVENT_BRIDGE_ALLOWLIST } from "./task-event-bridge-contract";

// Server instance
let controlPlaneServer: ControlPlaneServer | null = null;

// Reference to main window for sending events
let mainWindowRef: BrowserWindow | null = null;

export interface ControlPlaneMethodDeps {
  agentDaemon: AgentDaemon;
  dbManager: DatabaseManager;
  channelGateway?: ChannelGateway;
}

let controlPlaneDeps: ControlPlaneMethodDeps | null = null;
let detachAgentDaemonBridge: (() => void) | null = null;

/**
 * Get the current control plane server instance
 */
export function getControlPlaneServer(): ControlPlaneServer | null {
  return controlPlaneServer;
}

function requireScope(client: Any, scope: "admin" | "read" | "write" | "operator"): void {
  if (!client?.hasScope?.(scope)) {
    throw { code: ErrorCodes.UNAUTHORIZED, message: `Missing required scope: ${scope}` };
  }
}

function sanitizeTaskCreateParams(params: unknown): {
  title: string;
  prompt: string;
  workspaceId: string;
  assignedAgentRoleId?: string;
  agentConfig?: AgentConfig;
  budgetTokens?: number;
  budgetCost?: number;
} {
  const p = (params ?? {}) as Any;
  const title = typeof p.title === "string" ? p.title.trim() : "";
  const prompt = typeof p.prompt === "string" ? p.prompt.trim() : "";
  const workspaceId = typeof p.workspaceId === "string" ? p.workspaceId.trim() : "";
  const assignedAgentRoleId =
    typeof p.assignedAgentRoleId === "string" ? p.assignedAgentRoleId.trim() : "";

  const budgetTokens =
    typeof p.budgetTokens === "number" && Number.isFinite(p.budgetTokens)
      ? Math.max(0, Math.floor(p.budgetTokens))
      : undefined;
  const budgetCost =
    typeof p.budgetCost === "number" && Number.isFinite(p.budgetCost)
      ? Math.max(0, p.budgetCost)
      : undefined;

  const agentConfig: AgentConfig | undefined = (() => {
    if (!p.agentConfig || typeof p.agentConfig !== "object") return undefined;
    return p.agentConfig as AgentConfig;
  })();

  if (!title) throw { code: ErrorCodes.INVALID_PARAMS, message: "title is required" };
  if (!prompt) throw { code: ErrorCodes.INVALID_PARAMS, message: "prompt is required" };
  if (!workspaceId) throw { code: ErrorCodes.INVALID_PARAMS, message: "workspaceId is required" };

  return {
    title,
    prompt,
    workspaceId,
    ...(assignedAgentRoleId ? { assignedAgentRoleId } : {}),
    ...(agentConfig ? { agentConfig } : {}),
    ...(budgetTokens !== undefined ? { budgetTokens } : {}),
    ...(budgetCost !== undefined ? { budgetCost } : {}),
  };
}

function sanitizeTaskIdParams(params: unknown): { taskId: string } {
  const p = (params ?? {}) as Any;
  const taskId = typeof p.taskId === "string" ? p.taskId.trim() : "";
  if (!taskId) throw { code: ErrorCodes.INVALID_PARAMS, message: "taskId is required" };
  return { taskId };
}

function sanitizeTaskMessageParams(params: unknown): { taskId: string; message: string } {
  const p = (params ?? {}) as Any;
  const taskId = typeof p.taskId === "string" ? p.taskId.trim() : "";
  const message = typeof p.message === "string" ? p.message.trim() : "";
  if (!taskId) throw { code: ErrorCodes.INVALID_PARAMS, message: "taskId is required" };
  if (!message) throw { code: ErrorCodes.INVALID_PARAMS, message: "message is required" };
  return { taskId, message };
}

function sanitizeApprovalRespondParams(params: unknown): { approvalId: string; approved: boolean } {
  const p = (params ?? {}) as Any;
  const approvalId = typeof p.approvalId === "string" ? p.approvalId.trim() : "";
  const approved = p.approved;
  if (!approvalId) throw { code: ErrorCodes.INVALID_PARAMS, message: "approvalId is required" };
  if (typeof approved !== "boolean")
    throw { code: ErrorCodes.INVALID_PARAMS, message: "approved is required (boolean)" };
  return { approvalId, approved };
}

function sanitizeTaskListParams(params: unknown): {
  limit: number;
  offset: number;
  workspaceId?: string;
} {
  const p = (params ?? {}) as Any;
  const rawLimit =
    typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 100;
  const rawOffset =
    typeof p.offset === "number" && Number.isFinite(p.offset) ? Math.floor(p.offset) : 0;
  const limit = Math.min(Math.max(rawLimit, 1), 500);
  const offset = Math.max(rawOffset, 0);
  const workspaceId = typeof p.workspaceId === "string" ? p.workspaceId.trim() : "";
  return { limit, offset, ...(workspaceId ? { workspaceId } : {}) };
}

function sanitizeApprovalListParams(params: unknown): {
  limit: number;
  offset: number;
  taskId?: string;
} {
  const p = (params ?? {}) as Any;
  const rawLimit =
    typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 100;
  const rawOffset =
    typeof p.offset === "number" && Number.isFinite(p.offset) ? Math.floor(p.offset) : 0;
  const limit = Math.min(Math.max(rawLimit, 1), 500);
  const offset = Math.max(rawOffset, 0);
  const taskId = typeof p.taskId === "string" ? p.taskId.trim() : "";
  return { limit, offset, ...(taskId ? { taskId } : {}) };
}

function sanitizeTaskEventsParams(params: unknown): { taskId: string; limit: number } {
  const p = (params ?? {}) as Any;
  const { taskId } = sanitizeTaskIdParams(params);
  const rawLimit =
    typeof p.limit === "number" && Number.isFinite(p.limit) ? Math.floor(p.limit) : 200;
  const limit = Math.min(Math.max(rawLimit, 1), 2000);
  return { taskId, limit };
}

function sanitizeWorkspaceIdParams(params: unknown): { workspaceId: string } {
  const p = (params ?? {}) as Any;
  const workspaceId = typeof p.workspaceId === "string" ? p.workspaceId.trim() : "";
  if (!workspaceId) throw { code: ErrorCodes.INVALID_PARAMS, message: "workspaceId is required" };
  return { workspaceId };
}

function sanitizeWorkspaceCreateParams(params: unknown): { name: string; path: string } {
  const p = (params ?? {}) as Any;
  const name = typeof p.name === "string" ? p.name.trim() : "";
  const rawPath = typeof p.path === "string" ? p.path.trim() : "";
  if (!name) throw { code: ErrorCodes.INVALID_PARAMS, message: "name is required" };
  if (!rawPath) throw { code: ErrorCodes.INVALID_PARAMS, message: "path is required" };

  const homeDir = process.env.HOME || process.env.USERPROFILE;
  const expanded =
    rawPath.startsWith("~/") && homeDir
      ? path.join(homeDir, rawPath.slice(2))
      : rawPath;
  if (!path.isAbsolute(expanded)) {
    throw {
      code: ErrorCodes.INVALID_PARAMS,
      message: "path must be an absolute path (or start with ~/)",
    };
  }

  return { name, path: path.resolve(expanded) };
}

function sanitizeChannelIdParams(params: unknown): { channelId: string } {
  const p = (params ?? {}) as Any;
  const channelId = typeof p.channelId === "string" ? p.channelId.trim() : "";
  if (!channelId) throw { code: ErrorCodes.INVALID_PARAMS, message: "channelId is required" };
  return { channelId };
}

function sanitizeChannelCreateParams(params: unknown): {
  type: string;
  name: string;
  enabled: boolean;
  config: Record<string, unknown>;
  securityConfig: Record<string, unknown>;
} {
  const p = (params ?? {}) as Any;
  const type = typeof p.type === "string" ? p.type.trim() : "";
  const name = typeof p.name === "string" ? p.name.trim() : "";
  const enabled = typeof p.enabled === "boolean" ? p.enabled : false;
  const config =
    p.config && typeof p.config === "object" ? (p.config as Record<string, unknown>) : {};
  const securityConfigRaw =
    p.securityConfig && typeof p.securityConfig === "object"
      ? (p.securityConfig as Record<string, unknown>)
      : {};

  if (!type) throw { code: ErrorCodes.INVALID_PARAMS, message: "type is required" };
  if (!name) throw { code: ErrorCodes.INVALID_PARAMS, message: "name is required" };

  // Provide safe defaults for security config if not specified.
  const defaults = {
    mode: "pairing",
    pairingCodeTTL: 300,
    maxPairingAttempts: 5,
    rateLimitPerMinute: 30,
  };

  const mode = typeof securityConfigRaw.mode === "string" ? securityConfigRaw.mode : undefined;
  const normalizedMode =
    mode === "open" || mode === "allowlist" || mode === "pairing" ? mode : defaults.mode;
  const allowedUsers = Array.isArray(securityConfigRaw.allowedUsers)
    ? securityConfigRaw.allowedUsers.filter((x) => typeof x === "string")
    : undefined;

  const securityConfig = {
    ...defaults,
    ...securityConfigRaw,
    mode: normalizedMode,
    ...(allowedUsers ? { allowedUsers } : {}),
  };

  return { type, name, enabled, config, securityConfig };
}

function sanitizeChannelUpdateParams(params: unknown): {
  channelId: string;
  updates: {
    name?: string;
    config?: Record<string, unknown>;
    securityConfig?: Record<string, unknown>;
  };
} {
  const p = (params ?? {}) as Any;
  const channelId = typeof p.channelId === "string" ? p.channelId.trim() : "";
  if (!channelId) throw { code: ErrorCodes.INVALID_PARAMS, message: "channelId is required" };

  const updates: Any = {};
  if (p.name !== undefined) {
    const name = typeof p.name === "string" ? p.name.trim() : "";
    if (!name)
      throw { code: ErrorCodes.INVALID_PARAMS, message: "name must be a non-empty string" };
    updates.name = name;
  }
  if (p.config !== undefined) {
    if (!p.config || typeof p.config !== "object") {
      throw { code: ErrorCodes.INVALID_PARAMS, message: "config must be an object" };
    }
    updates.config = p.config as Record<string, unknown>;
  }
  if (p.securityConfig !== undefined) {
    if (!p.securityConfig || typeof p.securityConfig !== "object") {
      throw { code: ErrorCodes.INVALID_PARAMS, message: "securityConfig must be an object" };
    }
    updates.securityConfig = p.securityConfig as Record<string, unknown>;
  }

  return { channelId, updates };
}

function maskSecretString(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "[redacted]";
  return `${trimmed.slice(0, 2)}...${trimmed.slice(-4)}`;
}

function redactObjectSecrets(input: unknown, depth = 0): unknown {
  if (depth > 8) return "[truncated]";
  if (input === null || input === undefined) return input;
  if (typeof input === "string") return input;
  if (typeof input !== "object") return input;
  if (Array.isArray(input)) return input.map((x) => redactObjectSecrets(x, depth + 1));

  const obj = input as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  const secretKeyRe = /(token|secret|password|apiKey|accessKey|privateKey|signing|oauth)/i;
  for (const [k, v] of Object.entries(obj)) {
    if (secretKeyRe.test(k) && typeof v === "string") {
      out[k] = maskSecretString(v);
      continue;
    }
    out[k] = redactObjectSecrets(v, depth + 1);
  }
  return out;
}

const MAX_BROADCAST_STRING_CHARS = 2000;
const MAX_BROADCAST_ARRAY_ITEMS = 50;
const MAX_BROADCAST_OBJECT_KEYS = 50;
const MAX_BROADCAST_DEPTH = 3;
const SENSITIVE_KEY_RE = /(token|api[_-]?key|secret|password|authorization)/i;

function truncateForBroadcast(value: string): string {
  if (value.length <= MAX_BROADCAST_STRING_CHARS) return value;
  return (
    value.slice(0, MAX_BROADCAST_STRING_CHARS) + `\n\n[... truncated (${value.length} chars) ...]`
  );
}

const ALWAYS_REDACT_KEY_RE = /^(prompt|systemPrompt)$/i;

function truncateForBroadcastKey(value: string, key?: string): string {
  // Allow longer message bodies, but keep other fields short by default.
  const maxChars = key === "message" ? 12000 : MAX_BROADCAST_STRING_CHARS;
  if (value.length <= maxChars) return value;
  return value.slice(0, maxChars) + `\n\n[... truncated (${value.length} chars) ...]`;
}

function sanitizeForBroadcast(value: unknown, depth = 0, key?: string): unknown {
  if (depth > MAX_BROADCAST_DEPTH) {
    return "[... truncated ...]";
  }

  if (value === null || value === undefined) return value;
  if (typeof value === "string") return truncateForBroadcastKey(value, key);
  if (typeof value === "number" || typeof value === "boolean") return value;

  if (Array.isArray(value)) {
    const next = value
      .slice(0, MAX_BROADCAST_ARRAY_ITEMS)
      .map((item) => sanitizeForBroadcast(item, depth + 1));
    if (value.length > MAX_BROADCAST_ARRAY_ITEMS) {
      next.push(`[... ${value.length - MAX_BROADCAST_ARRAY_ITEMS} more items truncated ...]`);
    }
    return next;
  }

  if (typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    const out: Record<string, unknown> = {};

    for (const key of keys.slice(0, MAX_BROADCAST_OBJECT_KEYS)) {
      if (ALWAYS_REDACT_KEY_RE.test(key)) {
        out[key] = "[REDACTED]";
        continue;
      }
      if (SENSITIVE_KEY_RE.test(key)) {
        out[key] = "[REDACTED]";
        continue;
      }
      out[key] = sanitizeForBroadcast(obj[key], depth + 1, key);
    }

    if (keys.length > MAX_BROADCAST_OBJECT_KEYS) {
      out.__truncated_keys__ = keys.length - MAX_BROADCAST_OBJECT_KEYS;
    }

    return out;
  }

  try {
    return truncateForBroadcast(String(value));
  } catch {
    return "[unserializable]";
  }
}

function attachAgentDaemonTaskBridge(server: ControlPlaneServer, daemon: AgentDaemon): () => void {
  // Avoid broadcasting tool_result blobs by default; remote clients can fetch details via task.get if needed.
  const allowlist = TASK_EVENT_BRIDGE_ALLOWLIST;

  const unsubscribes: Array<() => void> = [];

  for (const eventType of allowlist) {
    const handler = (evt: Any) => {
      try {
        const taskId = typeof evt?.taskId === "string" ? evt.taskId : "";
        if (!taskId) return;

        const payload = { ...evt };
        delete payload.taskId;

        // Avoid leaking full prompts in broadcast; clients can call task.get if needed.
        if (eventType === "task_created" && payload?.task && typeof payload.task === "object") {
          const t = payload.task as Any;
          payload.task = {
            id: t.id,
            title: t.title,
            status: t.status,
            workspaceId: t.workspaceId,
            createdAt: t.createdAt,
            updatedAt: t.updatedAt,
            completedAt: t.completedAt,
            parentTaskId: t.parentTaskId,
            agentType: t.agentType,
            depth: t.depth,
            resultSummary: t.resultSummary,
            error: t.error,
            assignedAgentRoleId: t.assignedAgentRoleId,
            boardColumn: t.boardColumn,
            priority: t.priority,
          };
        }

        if (
          eventType === "assistant_message" &&
          typeof payload?.message === "string" &&
          payload.message.length > 12000
        ) {
          payload.message =
            payload.message.slice(0, 12000) + "\n\n[... truncated for control-plane broadcast ...]";
        }

        if (eventType === "tool_call" && payload?.input !== undefined) {
          payload.input = sanitizeForBroadcast(payload.input);
        }

        const sanitizedPayload = sanitizeForBroadcast(payload);

        server.broadcastToOperators(Events.TASK_EVENT, {
          taskId,
          type: eventType,
          payload: sanitizedPayload,
          timestamp: Date.now(),
        });
      } catch (error) {
        console.error("[ControlPlane] Failed to broadcast task event:", error);
      }
    };

    daemon.on(eventType, handler);
    unsubscribes.push(() => daemon.off(eventType, handler));
  }

  return () => {
    for (const off of unsubscribes) off();
  };
}

export async function startControlPlaneFromSettings(
  options: {
    deps?: ControlPlaneMethodDeps;
    forceEnable?: boolean;
    onEvent?: (event: Any) => void;
  } = {},
): Promise<{
  ok: boolean;
  skipped?: boolean;
  address?: { host: string; port: number; wsUrl: string };
  tailscale?: { httpsUrl?: string; wssUrl?: string };
  error?: string;
}> {
  try {
    ControlPlaneSettingsManager.initialize();
    TailscaleSettingsManager.initialize();

    if (options.deps) {
      controlPlaneDeps = options.deps;
    }

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

      // Stop local server if running
      if (controlPlaneServer?.isRunning) {
        if (detachAgentDaemonBridge) {
          detachAgentDaemonBridge();
          detachAgentDaemonBridge = null;
        }
        await controlPlaneServer.stop();
        controlPlaneServer = null;
      }

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

    if (controlPlaneServer?.isRunning) {
      const addr = controlPlaneServer.getAddress();
      const tailscale = getExposureStatus();
      return {
        ok: true,
        address: addr || undefined,
        tailscale: tailscale.active
          ? { httpsUrl: tailscale.httpsUrl, wssUrl: tailscale.wssUrl }
          : undefined,
      };
    }

    // Cleanup a previous failed/partial server instance.
    if (controlPlaneServer && !controlPlaneServer.isRunning) {
      if (detachAgentDaemonBridge) {
        detachAgentDaemonBridge();
        detachAgentDaemonBridge = null;
      }
      controlPlaneServer = null;
    }

    const server = new ControlPlaneServer({
      port: settings.port,
      host: settings.host,
      token: settings.token,
      handshakeTimeoutMs: settings.handshakeTimeoutMs,
      heartbeatIntervalMs: settings.heartbeatIntervalMs,
      maxPayloadBytes: settings.maxPayloadBytes,
      onEvent: (event) => {
        options.onEvent?.(event);
        if (mainWindowRef && !mainWindowRef.isDestroyed()) {
          mainWindowRef.webContents.send(IPC_CHANNELS.CONTROL_PLANE_EVENT, event);
        }
      },
    });

    controlPlaneServer = server;

    try {
      if (controlPlaneDeps) {
        registerTaskAndWorkspaceMethods(server, controlPlaneDeps);
        registerACPMethodsOnServer(server, controlPlaneDeps);
        detachAgentDaemonBridge = attachAgentDaemonTaskBridge(server, controlPlaneDeps.agentDaemon);
      } else {
        console.warn("[ControlPlane] No deps provided; task/workspace methods are disabled");
      }
      registerCanvasMethods(server);

      const tailscaleResult = await server.startWithTailscale();
      const address = server.getAddress();

      return {
        ok: true,
        address: address || undefined,
        tailscale: tailscaleResult?.success
          ? { httpsUrl: tailscaleResult.httpsUrl, wssUrl: tailscaleResult.wssUrl }
          : undefined,
      };
    } catch (error) {
      if (detachAgentDaemonBridge) {
        detachAgentDaemonBridge();
        detachAgentDaemonBridge = null;
      }
      try {
        await server.stop();
      } catch (stopError) {
        console.error("[ControlPlane] Failed to cleanup server after start error:", stopError);
      }
      if (controlPlaneServer === server) {
        controlPlaneServer = null;
      }
      throw error;
    }
  } catch (error: Any) {
    console.error("[ControlPlane] Auto-start error:", error);
    return { ok: false, error: error?.message || String(error) };
  }
}

/**
 * Register ACP (Agent Client Protocol) methods on the server.
 * Bridges local AgentRoles and external agents into the ACP discovery and messaging system.
 */
function registerACPMethodsOnServer(
  server: ControlPlaneServer,
  deps: ControlPlaneMethodDeps,
): void {
  const db = deps.dbManager.getDatabase();
  const roleRepo = new AgentRoleRepository(db);
  const taskRepo = new TaskRepository(db);

  const acpDeps: ACPHandlerDeps = {
    getActiveRoles: () => roleRepo.findActive(),
    createTask: async (params) => {
      // Find a workspace — use the provided one or fall back to the first available
      let workspaceId = params.workspaceId;
      if (!workspaceId) {
        const workspaceRepo = new WorkspaceRepository(db);
        const workspaces = workspaceRepo.findAll().filter((w: Any) => !w.isTemp);
        if (workspaces.length > 0) {
          workspaceId = workspaces[0].id;
        } else {
          throw new Error("No workspace available for ACP task delegation");
        }
      }
      const task = taskRepo.create({
        title: params.title,
        prompt: params.prompt,
        status: "pending",
        workspaceId,
        assignedAgentRoleId: params.assignedAgentRoleId,
      } as Any);
      await deps.agentDaemon.startTask(task);
      return { taskId: task.id };
    },
    getTask: (taskId) => {
      const task = taskRepo.findById(taskId);
      if (!task) return undefined;
      return { id: task.id, status: task.status, error: (task as Any).error };
    },
    cancelTask: async (taskId) => {
      await deps.agentDaemon.cancelTask(taskId);
    },
  };

  registerACPMethods(server, acpDeps);
}

/**
 * Register Canvas methods on the Control Plane server.
 * Enables cross-device canvas rendering: remote clients can list sessions,
 * fetch content, push content, take snapshots, and manage checkpoints.
 */
function registerCanvasMethods(server: ControlPlaneServer): void {
  let manager: CanvasManager;
  try {
    manager = CanvasManager.getInstance();
  } catch {
    console.log("[ControlPlane] Canvas not available (headless mode) — skipping canvas methods");
    return;
  }

  const requireAuth = (client: Any) => {
    if (!client.isAuthenticated) {
      throw { code: ErrorCodes.UNAUTHORIZED, message: "Authentication required" };
    }
  };

  const requireString = (value: unknown, field: string): string => {
    if (typeof value !== "string" || !value.trim()) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `${field} is required` };
    }
    return value.trim();
  };

  // canvas.list — list all active canvas sessions
  server.registerMethod(Methods.CANVAS_LIST, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as { taskId?: string };
    let sessions = manager.listAllSessions();
    if (p.taskId) {
      sessions = sessions.filter((s) => s.taskId === p.taskId);
    }
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        taskId: s.taskId,
        title: s.title,
        mode: s.mode,
        status: s.status,
        createdAt: s.createdAt,
        lastUpdatedAt: s.lastUpdatedAt,
      })),
    };
  });

  // canvas.get — get session details
  server.registerMethod(Methods.CANVAS_GET, async (client, params) => {
    requireAuth(client);
    const p = params as { sessionId?: string } | undefined;
    const sessionId = requireString(p?.sessionId, "sessionId");
    const session = manager.getSession(sessionId);
    if (!session) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Canvas session not found: ${sessionId}` };
    }
    return {
      session: {
        id: session.id,
        taskId: session.taskId,
        title: session.title,
        mode: session.mode,
        url: session.url,
        status: session.status,
        createdAt: session.createdAt,
        lastUpdatedAt: session.lastUpdatedAt,
      },
    };
  });

  // canvas.snapshot — take a screenshot of a canvas session
  server.registerMethod(Methods.CANVAS_SNAPSHOT, async (client, params) => {
    requireAuth(client);
    const p = params as { sessionId?: string } | undefined;
    const sessionId = requireString(p?.sessionId, "sessionId");
    const snapshot = await manager.takeSnapshot(sessionId);
    return { snapshot };
  });

  // canvas.content — get the HTML/CSS/JS files of a canvas session
  server.registerMethod(Methods.CANVAS_CONTENT, async (client, params) => {
    requireAuth(client);
    const p = params as { sessionId?: string } | undefined;
    const sessionId = requireString(p?.sessionId, "sessionId");
    const files = await manager.getSessionContent(sessionId);
    return { files };
  });

  // canvas.push — push content to a canvas session
  server.registerMethod(Methods.CANVAS_PUSH, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as { sessionId?: string; content?: string; filename?: string };
    const sessionId = requireString(p.sessionId, "sessionId");
    const content = requireString(p.content, "content");
    await manager.pushContent(sessionId, content, p.filename || "index.html");
    server.broadcast(Events.CANVAS_CONTENT_PUSHED, { sessionId });
    return { ok: true };
  });

  // canvas.eval — execute JavaScript in a canvas session
  server.registerMethod(Methods.CANVAS_EVAL, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as { sessionId?: string; script?: string };
    const sessionId = requireString(p.sessionId, "sessionId");
    const script = requireString(p.script, "script");
    const result = await manager.evalScript(sessionId, script);
    return { result };
  });

  // canvas.checkpoint.save — save a named checkpoint
  server.registerMethod(Methods.CANVAS_CHECKPOINT_SAVE, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as { sessionId?: string; label?: string };
    const sessionId = requireString(p.sessionId, "sessionId");
    const checkpoint = await manager.saveCheckpoint(sessionId, p.label);
    return {
      checkpoint: {
        id: checkpoint.id,
        label: checkpoint.label,
        createdAt: checkpoint.createdAt,
      },
    };
  });

  // canvas.checkpoint.list — list checkpoints for a session
  server.registerMethod(Methods.CANVAS_CHECKPOINT_LIST, async (client, params) => {
    requireAuth(client);
    const p = params as { sessionId?: string } | undefined;
    const sessionId = requireString(p?.sessionId, "sessionId");
    const checkpoints = manager.listCheckpoints(sessionId);
    return {
      checkpoints: checkpoints.map((cp) => ({
        id: cp.id,
        label: cp.label,
        createdAt: cp.createdAt,
      })),
    };
  });

  // canvas.checkpoint.restore — restore a session to a checkpoint
  server.registerMethod(Methods.CANVAS_CHECKPOINT_RESTORE, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as { sessionId?: string; checkpointId?: string };
    const sessionId = requireString(p.sessionId, "sessionId");
    const checkpointId = requireString(p.checkpointId, "checkpointId");
    const checkpoint = await manager.restoreCheckpoint(sessionId, checkpointId);
    return {
      checkpoint: {
        id: checkpoint.id,
        label: checkpoint.label,
        createdAt: checkpoint.createdAt,
      },
    };
  });

  // canvas.checkpoint.delete — delete a checkpoint
  server.registerMethod(Methods.CANVAS_CHECKPOINT_DELETE, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as { sessionId?: string; checkpointId?: string };
    const sessionId = requireString(p.sessionId, "sessionId");
    const checkpointId = requireString(p.checkpointId, "checkpointId");
    const removed = manager.deleteCheckpoint(sessionId, checkpointId);
    if (!removed) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Checkpoint not found: ${checkpointId}` };
    }
    return { ok: true };
  });

  console.log("[ControlPlane] Registered 10 canvas methods");
}

function registerTaskAndWorkspaceMethods(
  server: ControlPlaneServer,
  deps: ControlPlaneMethodDeps,
): void {
  const db = deps.dbManager.getDatabase();
  const taskRepo = new TaskRepository(db);
  const workspaceRepo = new WorkspaceRepository(db);
  const approvalRepo = new ApprovalRepository(db);
  const eventRepo = new TaskEventRepository(db);
  const agentDaemon = deps.agentDaemon;
  const channelGateway = deps.channelGateway;
  const isAdminClient = (client: Any) => !!client?.hasScope?.("admin");

  const redactWorkspaceForRead = (workspace: Any) => ({
    id: workspace.id,
    name: workspace.name,
    createdAt: workspace.createdAt,
    lastUsedAt: workspace.lastUsedAt,
  });

  const redactTaskForRead = (task: Any) => ({
    id: task.id,
    title: task.title,
    status: task.status,
    workspaceId: task.workspaceId,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
    completedAt: task.completedAt,
    parentTaskId: task.parentTaskId,
    agentType: task.agentType,
    depth: task.depth,
    assignedAgentRoleId: task.assignedAgentRoleId,
    boardColumn: task.boardColumn,
    priority: task.priority,
    labels: task.labels,
    dueDate: task.dueDate,
  });

  const redactChannelForRead = (channel: Any) => ({
    id: channel.id,
    type: channel.type,
    name: channel.name,
    enabled: channel.enabled,
    status: channel.status,
    botUsername: channel.botUsername,
    securityConfig: channel.securityConfig ? { mode: channel.securityConfig.mode } : undefined,
    createdAt: channel.createdAt,
    updatedAt: channel.updatedAt,
  });

  // Workspaces
  server.registerMethod(Methods.WORKSPACE_LIST, async (client) => {
    requireScope(client, "read");
    const all = workspaceRepo.findAll();
    const workspaces = all.filter((w) => !w.isTemp && !isTempWorkspaceId(w.id));
    return {
      workspaces: isAdminClient(client) ? workspaces : workspaces.map(redactWorkspaceForRead),
    };
  });

  server.registerMethod(Methods.WORKSPACE_GET, async (client, params) => {
    requireScope(client, "read");
    const { workspaceId } = sanitizeWorkspaceIdParams(params);
    const workspace = workspaceRepo.findById(workspaceId);
    if (!workspace) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Workspace not found: ${workspaceId}` };
    }
    return { workspace: isAdminClient(client) ? workspace : redactWorkspaceForRead(workspace) };
  });

  server.registerMethod(Methods.WORKSPACE_CREATE, async (client, params) => {
    requireScope(client, "admin");
    const validated = sanitizeWorkspaceCreateParams(params);

    if (workspaceRepo.existsByPath(validated.path)) {
      throw {
        code: ErrorCodes.INVALID_PARAMS,
        message: `A workspace with path "${validated.path}" already exists`,
      };
    }

    try {
      await fs.mkdir(validated.path, { recursive: true });
    } catch (error: Any) {
      throw {
        code: ErrorCodes.METHOD_FAILED,
        message: error?.message || `Failed to create workspace directory: ${validated.path}`,
      };
    }

    const defaultPermissions = {
      read: true,
      write: true,
      delete: false,
      network: true,
      shell: false,
    };

    const workspace = workspaceRepo.create(
      validated.name,
      validated.path,
      defaultPermissions as Any,
    );
    return { workspace };
  });

  // Tasks
  server.registerMethod(Methods.TASK_CREATE, async (client, params) => {
    requireScope(client, "admin");
    const validated = sanitizeTaskCreateParams(params);

    const workspace = workspaceRepo.findById(validated.workspaceId);
    if (!workspace) {
      throw {
        code: ErrorCodes.INVALID_PARAMS,
        message: `Workspace not found: ${validated.workspaceId}`,
      };
    }

    // Create task record
    const normalizedAgentConfig = validated.agentConfig
      ? {
          ...validated.agentConfig,
          ...(validated.agentConfig.autonomousMode ? { allowUserInput: false } : {}),
        }
      : undefined;

    const task = taskRepo.create({
      title: validated.title,
      prompt: validated.prompt,
      status: "pending",
      workspaceId: validated.workspaceId,
      agentConfig: normalizedAgentConfig,
      budgetTokens: validated.budgetTokens,
      budgetCost: validated.budgetCost,
    });

    // Apply assignment metadata (update DB + in-memory object before starting).
    const initialUpdates: Any = {};
    if (validated.assignedAgentRoleId) {
      initialUpdates.assignedAgentRoleId = validated.assignedAgentRoleId;
      initialUpdates.boardColumn = "todo";
    }
    if (Object.keys(initialUpdates).length > 0) {
      taskRepo.update(task.id, initialUpdates);
      Object.assign(task, initialUpdates);
    }

    if (!isTempWorkspaceId(validated.workspaceId) && !workspace?.isTemp) {
      try {
        workspaceRepo.updateLastUsedAt(validated.workspaceId);
      } catch (error) {
        console.warn("[ControlPlane] Failed to update workspace last used time:", error);
      }
    }

    try {
      await agentDaemon.startTask(task);
    } catch (error: Any) {
      taskRepo.update(task.id, {
        status: "failed",
        error: error?.message || "Failed to start task",
        completedAt: Date.now(),
      });
      throw {
        code: ErrorCodes.METHOD_FAILED,
        message: error?.message || "Failed to start task. Check LLM provider settings.",
      };
    }

    return { taskId: task.id, task };
  });

  server.registerMethod(Methods.TASK_EVENTS, async (client, params) => {
    requireScope(client, "admin");
    const { taskId, limit } = sanitizeTaskEventsParams(params);

    // Note: This can be large for long tasks; we return only the most recent `limit`.
    const all = eventRepo.findByTaskId(taskId);
    const sliced = all.slice(Math.max(all.length - limit, 0));
    const events = sliced.map((e) => ({
      id: e.id,
      taskId: e.taskId,
      timestamp: e.timestamp,
      type: e.type,
      payload: sanitizeForBroadcast(e.payload),
    }));

    return { events };
  });

  server.registerMethod(Methods.TASK_GET, async (client, params) => {
    requireScope(client, "read");
    const { taskId } = sanitizeTaskIdParams(params);
    const task = taskRepo.findById(taskId);
    if (!task) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Task not found: ${taskId}` };
    }
    return { task: isAdminClient(client) ? task : redactTaskForRead(task) };
  });

  server.registerMethod(Methods.TASK_LIST, async (client, params) => {
    requireScope(client, "read");
    const { limit, offset, workspaceId } = sanitizeTaskListParams(params);

    if (workspaceId) {
      const total = taskRepo.countByWorkspace(workspaceId);
      const tasks = taskRepo.findByWorkspace(workspaceId, limit, offset);
      return {
        tasks: isAdminClient(client) ? tasks : tasks.map(redactTaskForRead),
        total,
        limit,
        offset,
      };
    }

    const tasks = taskRepo.findAll(limit, offset);
    return { tasks: isAdminClient(client) ? tasks : tasks.map(redactTaskForRead), limit, offset };
  });

  server.registerMethod(Methods.TASK_CANCEL, async (client, params) => {
    requireScope(client, "admin");
    const { taskId } = sanitizeTaskIdParams(params);
    await agentDaemon.cancelTask(taskId);
    return { ok: true };
  });

  server.registerMethod(Methods.TASK_SEND_MESSAGE, async (client, params) => {
    requireScope(client, "admin");
    const { taskId, message } = sanitizeTaskMessageParams(params);
    await agentDaemon.sendMessage(taskId, message);
    return { ok: true };
  });

  // Approvals
  server.registerMethod(Methods.APPROVAL_LIST, async (client, params) => {
    requireScope(client, "admin");
    const { limit, offset, taskId } = sanitizeApprovalListParams(params);

    const approvals = taskId
      ? approvalRepo.findPendingByTaskId(taskId).slice(offset, offset + limit)
      : (() => {
          // The repository only has findPendingByTaskId; implement global listing here.
          const stmt = db.prepare(`
            SELECT * FROM approvals
            WHERE status = 'pending'
            ORDER BY requested_at ASC
            LIMIT ? OFFSET ?
          `);
          const rows = stmt.all(limit, offset) as Any[];
          return rows.map((row) => ({
            id: String(row.id ?? ""),
            taskId: String(row.task_id ?? ""),
            type: row.type,
            description: row.description,
            details: (() => {
              try {
                return row.details ? JSON.parse(String(row.details)) : {};
              } catch {
                return {};
              }
            })(),
            status: row.status,
            requestedAt: Number(row.requested_at ?? 0),
            resolvedAt: row.resolved_at ? Number(row.resolved_at) : undefined,
          }));
        })();

    const enriched = approvals.map((a: Any) => {
      const t = a.taskId ? taskRepo.findById(a.taskId) : undefined;
      return {
        ...a,
        ...(t ? { taskTitle: t.title, workspaceId: t.workspaceId, taskStatus: t.status } : {}),
        details: sanitizeForBroadcast(a.details),
      };
    });

    return { approvals: enriched };
  });

  server.registerMethod(Methods.APPROVAL_RESPOND, async (client, params) => {
    requireScope(client, "admin");
    const { approvalId, approved } = sanitizeApprovalRespondParams(params);
    const status = await agentDaemon.respondToApproval(approvalId, approved);
    return { status };
  });

  // Channels (gateway)
  server.registerMethod(Methods.CHANNEL_LIST, async (client) => {
    requireScope(client, "read");
    const rows = db.prepare("SELECT * FROM channels ORDER BY created_at ASC").all() as Any[];
    const channels = rows.map((row) => ({
      id: String(row.id ?? ""),
      type: String(row.type ?? ""),
      name: String(row.name ?? ""),
      enabled: row.enabled === 1,
      config: (() => {
        try {
          return row.config ? JSON.parse(String(row.config)) : {};
        } catch {
          return {};
        }
      })(),
      securityConfig: (() => {
        try {
          return row.security_config
            ? JSON.parse(String(row.security_config))
            : { mode: "pairing" };
        } catch {
          return { mode: "pairing" };
        }
      })(),
      status: String(row.status ?? ""),
      botUsername: row.bot_username ? String(row.bot_username) : undefined,
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    }));

    if (!isAdminClient(client)) {
      return { channels: channels.map(redactChannelForRead) };
    }

    return {
      channels: channels.map((c) => ({
        ...redactChannelForRead(c),
        config: redactObjectSecrets(c.config),
        securityConfig: {
          mode: c.securityConfig?.mode,
          allowedUsersCount: Array.isArray(c.securityConfig?.allowedUsers)
            ? c.securityConfig.allowedUsers.length
            : 0,
        },
      })),
    };
  });

  server.registerMethod(Methods.CHANNEL_GET, async (client, params) => {
    requireScope(client, "read");
    const { channelId } = sanitizeChannelIdParams(params);
    const row = db.prepare("SELECT * FROM channels WHERE id = ?").get(channelId) as Any;
    if (!row) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Channel not found: ${channelId}` };
    }

    const channel = {
      id: String(row.id ?? ""),
      type: String(row.type ?? ""),
      name: String(row.name ?? ""),
      enabled: row.enabled === 1,
      config: (() => {
        try {
          return row.config ? JSON.parse(String(row.config)) : {};
        } catch {
          return {};
        }
      })(),
      securityConfig: (() => {
        try {
          return row.security_config
            ? JSON.parse(String(row.security_config))
            : { mode: "pairing" };
        } catch {
          return { mode: "pairing" };
        }
      })(),
      status: String(row.status ?? ""),
      botUsername: row.bot_username ? String(row.bot_username) : undefined,
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    };

    if (!isAdminClient(client)) return { channel: redactChannelForRead(channel) };

    return {
      channel: {
        ...redactChannelForRead(channel),
        config: redactObjectSecrets(channel.config),
        securityConfig: {
          mode: channel.securityConfig?.mode,
          allowedUsersCount: Array.isArray(channel.securityConfig?.allowedUsers)
            ? channel.securityConfig.allowedUsers.length
            : 0,
        },
      },
    };
  });

  server.registerMethod(Methods.CHANNEL_CREATE, async (client, params) => {
    requireScope(client, "admin");
    const validated = sanitizeChannelCreateParams(params);

    // Enforce one channel per type (router registers by type).
    const existing = db
      .prepare("SELECT id FROM channels WHERE type = ? LIMIT 1")
      .get(validated.type) as Any;
    if (existing?.id) {
      throw {
        code: ErrorCodes.INVALID_PARAMS,
        message: `Channel type "${validated.type}" already exists (id=${existing.id})`,
      };
    }

    const now = Date.now();
    const id = randomUUID();
    db.prepare(`
      INSERT INTO channels (id, type, name, enabled, config, security_config, status, bot_username, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      id,
      validated.type,
      validated.name,
      validated.enabled ? 1 : 0,
      JSON.stringify(validated.config || {}),
      JSON.stringify(validated.securityConfig || { mode: "pairing" }),
      "disconnected",
      null,
      now,
      now,
    );

    // If the gateway is running, optionally connect immediately when enabled.
    if (validated.enabled && channelGateway) {
      try {
        await channelGateway.enableChannel(id);
      } catch (error: Any) {
        // Keep the channel record but surface the connection error.
        db.prepare("UPDATE channels SET enabled = 0, status = ?, updated_at = ? WHERE id = ?").run(
          "disconnected",
          Date.now(),
          id,
        );
        throw {
          code: ErrorCodes.METHOD_FAILED,
          message: error?.message || "Failed to enable channel",
        };
      }
    }

    return { channelId: id };
  });

  server.registerMethod(Methods.CHANNEL_UPDATE, async (client, params) => {
    requireScope(client, "admin");
    const { channelId, updates } = sanitizeChannelUpdateParams(params);

    if (channelGateway) {
      channelGateway.updateChannel(channelId, updates as Any);
      return { ok: true };
    }

    // Fallback: update DB only (restart required to take effect).
    const fields: string[] = [];
    const values: Any[] = [];
    if (updates.name !== undefined) {
      fields.push("name = ?");
      values.push(updates.name);
    }
    if (updates.config !== undefined) {
      fields.push("config = ?");
      values.push(JSON.stringify(updates.config));
    }
    if (updates.securityConfig !== undefined) {
      fields.push("security_config = ?");
      values.push(JSON.stringify(updates.securityConfig));
    }
    if (fields.length === 0) return { ok: true };
    fields.push("updated_at = ?");
    values.push(Date.now());
    values.push(channelId);
    db.prepare(`UPDATE channels SET ${fields.join(", ")} WHERE id = ?`).run(...values);
    return { ok: true, restartRequired: true };
  });

  server.registerMethod(Methods.CHANNEL_TEST, async (client, params) => {
    requireScope(client, "admin");
    const { channelId } = sanitizeChannelIdParams(params);
    if (!channelGateway) {
      return { success: false, error: "Channel gateway not available (restart required)" };
    }
    return await channelGateway.testChannel(channelId);
  });

  server.registerMethod(Methods.CHANNEL_ENABLE, async (client, params) => {
    requireScope(client, "admin");
    const { channelId } = sanitizeChannelIdParams(params);
    if (!channelGateway) {
      db.prepare("UPDATE channels SET enabled = 1, updated_at = ? WHERE id = ?").run(
        Date.now(),
        channelId,
      );
      return { ok: true, restartRequired: true };
    }
    await channelGateway.enableChannel(channelId);
    return { ok: true };
  });

  server.registerMethod(Methods.CHANNEL_DISABLE, async (client, params) => {
    requireScope(client, "admin");
    const { channelId } = sanitizeChannelIdParams(params);
    if (!channelGateway) {
      db.prepare("UPDATE channels SET enabled = 0, status = ?, updated_at = ? WHERE id = ?").run(
        "disconnected",
        Date.now(),
        channelId,
      );
      return { ok: true, restartRequired: true };
    }
    await channelGateway.disableChannel(channelId);
    return { ok: true };
  });

  server.registerMethod(Methods.CHANNEL_REMOVE, async (client, params) => {
    requireScope(client, "admin");
    const { channelId } = sanitizeChannelIdParams(params);
    if (!channelGateway) {
      // Best-effort delete only the channel row. (Associated rows may remain.)
      db.prepare("DELETE FROM channels WHERE id = ?").run(channelId);
      return { ok: true, restartRequired: true };
    }
    await channelGateway.removeChannel(channelId);
    return { ok: true };
  });

  // LLM setup (headless-friendly credential/provider configuration).
  server.registerMethod(Methods.LLM_CONFIGURE, async (client, params) => {
    requireScope(client, "admin");
    return configureLlmFromControlPlaneParams(params);
  });

  // Config/health (sanitized; no secrets).
  server.registerMethod(Methods.CONFIG_GET, async (client) => {
    requireScope(client, "read");
    const isAdmin = isAdminClient(client);

    const allWorkspaces = workspaceRepo
      .findAll()
      .filter((w) => !w.isTemp && !isTempWorkspaceId(w.id));
    const workspacesForClient = isAdmin ? allWorkspaces : allWorkspaces.map(redactWorkspaceForRead);

    const taskStatusRows = db
      .prepare(`SELECT status, COUNT(1) AS count FROM tasks GROUP BY status`)
      .all() as Array<{ status: string; count: number }>;

    const tasksByStatus: Record<string, number> = {};
    let taskTotal = 0;
    for (const row of taskStatusRows) {
      const status = String(row.status || "");
      const count = typeof row.count === "number" ? row.count : Number(row.count);
      const safeCount = Number.isFinite(count) ? count : 0;
      if (status) tasksByStatus[status] = safeCount;
      taskTotal += safeCount;
    }

    const llm = getControlPlaneLlmStatus();
    const anyLlmConfigured = llm.providers.some((p) => p.configured);
    const currentProviderConfigured =
      llm.providers.find((p) => p.type === llm.currentProvider)?.configured || false;

    const searchStatus = SearchProviderFactory.getConfigStatus();

    const controlPlane = ControlPlaneSettingsManager.getSettingsForDisplay();
    const envImport = {
      enabled: shouldImportEnvSettingsFromArgsOrEnv(),
      mode: getEnvSettingsImportModeFromArgsOrEnv(),
    };

    const runtime = {
      platform: process.platform,
      arch: process.arch,
      node: process.version,
      electron: process.versions.electron,
      coworkVersion: typeof app.getVersion === "function" ? app.getVersion() : undefined,
      headless: isHeadlessMode(),
      cwd: process.cwd(),
      userDataDir: getUserDataDir(),
      importEnvSettings: envImport,
    };

    const warnings: string[] = [];
    if (controlPlane.host === "0.0.0.0" || controlPlane.host === "::") {
      warnings.push(
        "Control Plane is bound to all interfaces (host=0.0.0.0/::). This is unsafe unless you have strong network controls (prefer loopback + SSH tunnel/Tailscale).",
      );
    }
    if (allWorkspaces.length === 0) {
      warnings.push(
        "No workspaces configured. Set COWORK_BOOTSTRAP_WORKSPACE_PATH on startup or create one via workspace.create.",
      );
    }
    if (!anyLlmConfigured) {
      warnings.push(
        "No LLM provider credentials configured. Configure one via Control Plane (LLM Setup / llm.configure), or use COWORK_IMPORT_ENV_SETTINGS=1 with provider env vars and restart.",
      );
    } else if (!currentProviderConfigured) {
      warnings.push(
        `Selected LLM provider "${llm.currentProvider}" is not configured. Either switch provider or configure its credentials.`,
      );
    }
    if (!envImport.enabled && !anyLlmConfigured) {
      warnings.push(
        "Tip: enable env import with COWORK_IMPORT_ENV_SETTINGS=1 (or --import-env-settings) so provider env vars are persisted into Secure Settings at boot.",
      );
    }
    if (!searchStatus.isConfigured) {
      warnings.push(
        "No search provider configured (optional). Set TAVILY_API_KEY/BRAVE_API_KEY/SERPAPI_API_KEY if you want web search.",
      );
    }

    // Channels summary (no secrets).
    const channelRows = db
      .prepare(
        `SELECT id, type, name, enabled, status, bot_username, security_config, created_at, updated_at FROM channels ORDER BY created_at ASC`,
      )
      .all() as Any[];
    const channels = channelRows.map((row) => ({
      id: String(row.id ?? ""),
      type: String(row.type ?? ""),
      name: String(row.name ?? ""),
      enabled: row.enabled === 1,
      status: String(row.status ?? ""),
      botUsername: row.bot_username ? String(row.bot_username) : undefined,
      securityConfig: (() => {
        try {
          return row.security_config
            ? JSON.parse(String(row.security_config))
            : { mode: "pairing" };
        } catch {
          return { mode: "pairing" };
        }
      })(),
      createdAt: Number(row.created_at ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    }));
    const channelsEnabled = channels.filter((c) => c.enabled).length;

    return {
      runtime,
      controlPlane,
      workspaces: { count: allWorkspaces.length, workspaces: workspacesForClient },
      tasks: { total: taskTotal, byStatus: tasksByStatus },
      channels: {
        count: channels.length,
        enabled: channelsEnabled,
        channels: channels.map(redactChannelForRead),
      },
      llm,
      search: searchStatus,
      warnings,
    };
  });
}

/**
 * Initialize control plane IPC handlers
 */
export function setupControlPlaneHandlers(
  mainWindow: BrowserWindow,
  deps?: ControlPlaneMethodDeps,
): void {
  mainWindowRef = mainWindow;
  controlPlaneDeps = deps ?? null;

  // Initialize settings managers
  ControlPlaneSettingsManager.initialize();
  TailscaleSettingsManager.initialize();

  // Get settings (with masked token)
  ipcMain.handle(
    IPC_CHANNELS.CONTROL_PLANE_GET_SETTINGS,
    async (): Promise<ControlPlaneSettingsData> => {
      return ControlPlaneSettingsManager.getSettingsForDisplay();
    },
  );

  // Save settings
  ipcMain.handle(
    IPC_CHANNELS.CONTROL_PLANE_SAVE_SETTINGS,
    async (
      _,
      settings: Partial<ControlPlaneSettingsData>,
    ): Promise<{ ok: boolean; error?: string }> => {
      try {
        ControlPlaneSettingsManager.updateSettings(settings);
        return { ok: true };
      } catch (error: Any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Enable control plane
  ipcMain.handle(
    IPC_CHANNELS.CONTROL_PLANE_ENABLE,
    async (): Promise<{
      ok: boolean;
      token?: string;
      error?: string;
    }> => {
      try {
        const settings = ControlPlaneSettingsManager.enable();
        return { ok: true, token: settings.token };
      } catch (error: Any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Disable control plane
  ipcMain.handle(
    IPC_CHANNELS.CONTROL_PLANE_DISABLE,
    async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        // Stop server if running
        if (controlPlaneServer) {
          if (detachAgentDaemonBridge) {
            detachAgentDaemonBridge();
            detachAgentDaemonBridge = null;
          }
          await controlPlaneServer.stop();
          controlPlaneServer = null;
        }
        ControlPlaneSettingsManager.disable();
        return { ok: true };
      } catch (error: Any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Start control plane server
  ipcMain.handle(
    IPC_CHANNELS.CONTROL_PLANE_START,
    async (): Promise<{
      ok: boolean;
      address?: { host: string; port: number; wsUrl: string };
      tailscale?: { httpsUrl?: string; wssUrl?: string };
      error?: string;
    }> => {
      try {
        if (controlPlaneServer?.isRunning) {
          const addr = controlPlaneServer.getAddress();
          const tailscale = getExposureStatus();
          return {
            ok: true,
            address: addr || undefined,
            tailscale: tailscale.active
              ? {
                  httpsUrl: tailscale.httpsUrl,
                  wssUrl: tailscale.wssUrl,
                }
              : undefined,
          };
        }

        // Cleanup a previous failed/partial server instance.
        if (controlPlaneServer && !controlPlaneServer.isRunning) {
          if (detachAgentDaemonBridge) {
            detachAgentDaemonBridge();
            detachAgentDaemonBridge = null;
          }
          controlPlaneServer = null;
        }

        const settings = ControlPlaneSettingsManager.loadSettings();

        if (!settings.token) {
          return { ok: false, error: "No authentication token configured" };
        }

        // Create server instance
        const server = new ControlPlaneServer({
          port: settings.port,
          host: settings.host,
          token: settings.token,
          handshakeTimeoutMs: settings.handshakeTimeoutMs,
          heartbeatIntervalMs: settings.heartbeatIntervalMs,
          maxPayloadBytes: settings.maxPayloadBytes,
          onEvent: (event) => {
            // Forward events to renderer
            if (mainWindowRef && !mainWindowRef.isDestroyed()) {
              mainWindowRef.webContents.send(IPC_CHANNELS.CONTROL_PLANE_EVENT, event);
            }
          },
        });
        controlPlaneServer = server;

        try {
          // Register task/workspace methods + event bridge (enables multi-Mac orchestration).
          if (controlPlaneDeps) {
            registerTaskAndWorkspaceMethods(server, controlPlaneDeps);
            detachAgentDaemonBridge = attachAgentDaemonTaskBridge(
              server,
              controlPlaneDeps.agentDaemon,
            );
          } else {
            console.warn("[ControlPlane] No deps provided; task/workspace methods are disabled");
          }
          registerCanvasMethods(server);

          // Start with Tailscale if configured
          const tailscaleResult = await server.startWithTailscale();

          const address = server.getAddress();

          return {
            ok: true,
            address: address || undefined,
            tailscale: tailscaleResult?.success
              ? {
                  httpsUrl: tailscaleResult.httpsUrl,
                  wssUrl: tailscaleResult.wssUrl,
                }
              : undefined,
          };
        } catch (error) {
          if (detachAgentDaemonBridge) {
            detachAgentDaemonBridge();
            detachAgentDaemonBridge = null;
          }
          try {
            await server.stop();
          } catch (stopError) {
            console.error("[ControlPlane] Failed to cleanup server after start error:", stopError);
          }
          if (controlPlaneServer === server) {
            controlPlaneServer = null;
          }
          throw error;
        }
      } catch (error: Any) {
        console.error("[ControlPlane Handlers] Start error:", error);
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Stop control plane server
  ipcMain.handle(
    IPC_CHANNELS.CONTROL_PLANE_STOP,
    async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        if (controlPlaneServer) {
          if (detachAgentDaemonBridge) {
            detachAgentDaemonBridge();
            detachAgentDaemonBridge = null;
          }
          await controlPlaneServer.stop();
          controlPlaneServer = null;
        }
        return { ok: true };
      } catch (error: Any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Get control plane status
  ipcMain.handle(IPC_CHANNELS.CONTROL_PLANE_GET_STATUS, async (): Promise<ControlPlaneStatus> => {
    const settings = ControlPlaneSettingsManager.loadSettings();
    const tailscale = getExposureStatus();

    if (!controlPlaneServer || !controlPlaneServer.isRunning) {
      return {
        enabled: settings.enabled,
        running: false,
        clients: {
          total: 0,
          authenticated: 0,
          pending: 0,
          list: [],
        },
        tailscale: {
          active: tailscale.active,
          mode: tailscale.mode,
          hostname: tailscale.hostname,
          httpsUrl: tailscale.httpsUrl,
          wssUrl: tailscale.wssUrl,
        },
      };
    }

    const serverStatus = controlPlaneServer.getStatus();

    return {
      enabled: settings.enabled,
      running: serverStatus.running,
      address: serverStatus.address || undefined,
      clients: {
        total: serverStatus.clients.total,
        authenticated: serverStatus.clients.authenticated,
        pending: serverStatus.clients.pending,
        list: serverStatus.clients.clients,
      },
      tailscale: {
        active: serverStatus.tailscale.active,
        mode: serverStatus.tailscale.mode,
        hostname: serverStatus.tailscale.hostname,
        httpsUrl: serverStatus.tailscale.httpsUrl,
        wssUrl: serverStatus.tailscale.wssUrl,
      },
    };
  });

  // Regenerate token
  ipcMain.handle(
    IPC_CHANNELS.CONTROL_PLANE_REGENERATE_TOKEN,
    async (): Promise<{
      ok: boolean;
      token?: string;
      error?: string;
    }> => {
      try {
        const newToken = ControlPlaneSettingsManager.regenerateToken();

        // If server is running, we need to restart it with new token
        if (controlPlaneServer?.isRunning) {
          if (detachAgentDaemonBridge) {
            detachAgentDaemonBridge();
            detachAgentDaemonBridge = null;
          }
          await controlPlaneServer.stop();
          const settings = ControlPlaneSettingsManager.loadSettings();

          controlPlaneServer = new ControlPlaneServer({
            port: settings.port,
            host: settings.host,
            token: settings.token,
            handshakeTimeoutMs: settings.handshakeTimeoutMs,
            heartbeatIntervalMs: settings.heartbeatIntervalMs,
            maxPayloadBytes: settings.maxPayloadBytes,
            onEvent: (event) => {
              if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                mainWindowRef.webContents.send(IPC_CHANNELS.CONTROL_PLANE_EVENT, event);
              }
            },
          });

          if (controlPlaneDeps) {
            registerTaskAndWorkspaceMethods(controlPlaneServer, controlPlaneDeps);
            registerACPMethodsOnServer(controlPlaneServer, controlPlaneDeps);
            detachAgentDaemonBridge = attachAgentDaemonTaskBridge(
              controlPlaneServer,
              controlPlaneDeps.agentDaemon,
            );
          }
          registerCanvasMethods(controlPlaneServer);

          await controlPlaneServer.startWithTailscale();
        }

        return { ok: true, token: newToken };
      } catch (error: Any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // ===== Tailscale Handlers =====

  // Check Tailscale availability
  ipcMain.handle(
    IPC_CHANNELS.TAILSCALE_CHECK_AVAILABILITY,
    async (): Promise<TailscaleAvailability> => {
      return await checkTailscaleAvailability();
    },
  );

  // Get Tailscale status
  ipcMain.handle(IPC_CHANNELS.TAILSCALE_GET_STATUS, async () => {
    const settings = TailscaleSettingsManager.loadSettings();
    const exposure = getExposureStatus();

    return {
      settings,
      exposure,
    };
  });

  // Set Tailscale mode
  ipcMain.handle(
    IPC_CHANNELS.TAILSCALE_SET_MODE,
    async (_, mode: TailscaleMode): Promise<{ ok: boolean; error?: string }> => {
      try {
        // Update settings
        ControlPlaneSettingsManager.updateSettings({
          tailscale: { mode, resetOnExit: true },
        });

        // If server is running, restart to apply new mode
        if (controlPlaneServer?.isRunning) {
          if (detachAgentDaemonBridge) {
            detachAgentDaemonBridge();
            detachAgentDaemonBridge = null;
          }
          await controlPlaneServer.stop();
          const settings = ControlPlaneSettingsManager.loadSettings();

          controlPlaneServer = new ControlPlaneServer({
            port: settings.port,
            host: settings.host,
            token: settings.token,
            handshakeTimeoutMs: settings.handshakeTimeoutMs,
            heartbeatIntervalMs: settings.heartbeatIntervalMs,
            maxPayloadBytes: settings.maxPayloadBytes,
            onEvent: (event) => {
              if (mainWindowRef && !mainWindowRef.isDestroyed()) {
                mainWindowRef.webContents.send(IPC_CHANNELS.CONTROL_PLANE_EVENT, event);
              }
            },
          });

          if (controlPlaneDeps) {
            registerTaskAndWorkspaceMethods(controlPlaneServer, controlPlaneDeps);
            detachAgentDaemonBridge = attachAgentDaemonTaskBridge(
              controlPlaneServer,
              controlPlaneDeps.agentDaemon,
            );
          }
          registerCanvasMethods(controlPlaneServer);

          await controlPlaneServer.startWithTailscale();
        }

        return { ok: true };
      } catch (error: Any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // ===== Remote Gateway Handlers =====

  // Connect to remote gateway
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_CONNECT,
    async (_, config?: RemoteGatewayConfig): Promise<{ ok: boolean; error?: string }> => {
      try {
        // Get config from settings if not provided
        const settings = ControlPlaneSettingsManager.loadSettings();
        const remoteConfig = config || settings.remote;

        if (!remoteConfig?.url || !remoteConfig?.token) {
          return { ok: false, error: "Remote gateway URL and token are required" };
        }

        // Stop local server if running
        if (controlPlaneServer?.isRunning) {
          if (detachAgentDaemonBridge) {
            detachAgentDaemonBridge();
            detachAgentDaemonBridge = null;
          }
          await controlPlaneServer.stop();
          controlPlaneServer = null;
        }

        // Initialize and connect remote client
        const client = initRemoteGatewayClient({
          ...remoteConfig,
          onStateChange: (state, error) => {
            if (mainWindowRef && !mainWindowRef.isDestroyed()) {
              mainWindowRef.webContents.send(IPC_CHANNELS.REMOTE_GATEWAY_EVENT, {
                type: "stateChange",
                state,
                error,
              });
            }
          },
          onEvent: (event, payload) => {
            if (mainWindowRef && !mainWindowRef.isDestroyed()) {
              mainWindowRef.webContents.send(IPC_CHANNELS.REMOTE_GATEWAY_EVENT, {
                type: "event",
                event,
                payload,
              });
            }
          },
        });

        await client.connect();

        // Update settings with connection mode
        ControlPlaneSettingsManager.updateSettings({
          connectionMode: "remote",
          remote: remoteConfig,
        });

        return { ok: true };
      } catch (error: Any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Disconnect from remote gateway
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_DISCONNECT,
    async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        shutdownRemoteGatewayClient();
        ControlPlaneSettingsManager.updateSettings({
          connectionMode: "local",
        });
        return { ok: true };
      } catch (error: Any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Get remote gateway status
  ipcMain.handle(IPC_CHANNELS.REMOTE_GATEWAY_GET_STATUS, async (): Promise<RemoteGatewayStatus> => {
    const client = getRemoteGatewayClient();
    const tunnel = getSSHTunnelManager();

    if (!client) {
      return {
        state: "disconnected",
        sshTunnel: tunnel?.getStatus(),
      };
    }

    const status = client.getStatus();
    return {
      ...status,
      sshTunnel: tunnel?.getStatus(),
    };
  });

  // Save remote gateway config
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_SAVE_CONFIG,
    async (_, config: RemoteGatewayConfig): Promise<{ ok: boolean; error?: string }> => {
      try {
        ControlPlaneSettingsManager.updateSettings({
          remote: config,
        });
        return { ok: true };
      } catch (error: Any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Test remote gateway connection
  ipcMain.handle(
    IPC_CHANNELS.REMOTE_GATEWAY_TEST_CONNECTION,
    async (
      _,
      config: RemoteGatewayConfig,
    ): Promise<{
      ok: boolean;
      latencyMs?: number;
      error?: string;
    }> => {
      try {
        const client = new RemoteGatewayClient(config);
        const result = await client.testConnection();
        return {
          ok: result.success,
          latencyMs: result.latencyMs,
          error: result.error,
        };
      } catch (error: Any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // ===== SSH Tunnel Handlers =====

  // Connect SSH tunnel
  ipcMain.handle(
    IPC_CHANNELS.SSH_TUNNEL_CONNECT,
    async (_, config?: SSHTunnelConfig): Promise<{ ok: boolean; error?: string }> => {
      try {
        // Get config from settings if not provided
        const settings = ControlPlaneSettingsManager.loadSettings();
        const tunnelConfig = config || settings.remote?.sshTunnel;

        if (!tunnelConfig?.host || !tunnelConfig?.username) {
          return { ok: false, error: "SSH host and username are required" };
        }

        // Initialize and connect SSH tunnel
        const tunnel = initSSHTunnelManager({
          ...tunnelConfig,
          enabled: true,
        });

        // Setup event forwarding to renderer
        tunnel.on("stateChange", (state: string, error?: string) => {
          if (mainWindowRef && !mainWindowRef.isDestroyed()) {
            mainWindowRef.webContents.send(IPC_CHANNELS.SSH_TUNNEL_EVENT, {
              type: "stateChange",
              state,
              error,
            });
          }
        });

        tunnel.on("connected", () => {
          if (mainWindowRef && !mainWindowRef.isDestroyed()) {
            mainWindowRef.webContents.send(IPC_CHANNELS.SSH_TUNNEL_EVENT, {
              type: "connected",
            });
          }
        });

        tunnel.on("disconnected", (reason: string) => {
          if (mainWindowRef && !mainWindowRef.isDestroyed()) {
            mainWindowRef.webContents.send(IPC_CHANNELS.SSH_TUNNEL_EVENT, {
              type: "disconnected",
              reason,
            });
          }
        });

        tunnel.on("error", (error: Error) => {
          if (mainWindowRef && !mainWindowRef.isDestroyed()) {
            mainWindowRef.webContents.send(IPC_CHANNELS.SSH_TUNNEL_EVENT, {
              type: "error",
              error: error.message,
            });
          }
        });

        await tunnel.connect();

        // Save SSH tunnel config to settings
        if (config) {
          ControlPlaneSettingsManager.updateSettings({
            remote: {
              ...settings.remote,
              url: tunnel.getLocalUrl(),
              token: settings.remote?.token || "",
              sshTunnel: config,
            } as Any,
          });
        }

        return { ok: true };
      } catch (error: Any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Disconnect SSH tunnel
  ipcMain.handle(
    IPC_CHANNELS.SSH_TUNNEL_DISCONNECT,
    async (): Promise<{ ok: boolean; error?: string }> => {
      try {
        shutdownSSHTunnelManager();
        return { ok: true };
      } catch (error: Any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Get SSH tunnel status
  ipcMain.handle(IPC_CHANNELS.SSH_TUNNEL_GET_STATUS, async (): Promise<SSHTunnelStatus> => {
    const tunnel = getSSHTunnelManager();
    if (!tunnel) {
      return { state: "disconnected" };
    }
    return tunnel.getStatus();
  });

  // Save SSH tunnel config
  ipcMain.handle(
    IPC_CHANNELS.SSH_TUNNEL_SAVE_CONFIG,
    async (_, config: SSHTunnelConfig): Promise<{ ok: boolean; error?: string }> => {
      try {
        const settings = ControlPlaneSettingsManager.loadSettings();
        ControlPlaneSettingsManager.updateSettings({
          remote: {
            ...settings.remote,
            url: settings.remote?.url || "",
            token: settings.remote?.token || "",
            sshTunnel: config,
          } as Any,
        });
        return { ok: true };
      } catch (error: Any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Test SSH tunnel connection
  ipcMain.handle(
    IPC_CHANNELS.SSH_TUNNEL_TEST_CONNECTION,
    async (
      _,
      config: SSHTunnelConfig,
    ): Promise<{
      ok: boolean;
      latencyMs?: number;
      error?: string;
    }> => {
      try {
        const tunnel = new SSHTunnelManager(config);
        const result = await tunnel.testConnection();
        return {
          ok: result.success,
          latencyMs: result.latencyMs,
          error: result.error,
        };
      } catch (error: Any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // ===== Node (Mobile Companion) Handlers =====

  // List connected nodes
  ipcMain.handle(
    IPC_CHANNELS.NODE_LIST,
    async (): Promise<{
      ok: boolean;
      nodes?: import("../../shared/types").NodeInfo[];
      error?: string;
    }> => {
      try {
        if (!controlPlaneServer || !controlPlaneServer.isRunning) {
          return { ok: true, nodes: [] };
        }
        const nodes = (controlPlaneServer as Any).clients.getNodeInfoList();
        return { ok: true, nodes };
      } catch (error: Any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Get a specific node
  ipcMain.handle(
    IPC_CHANNELS.NODE_GET,
    async (
      _,
      nodeId: string,
    ): Promise<{
      ok: boolean;
      node?: import("../../shared/types").NodeInfo;
      error?: string;
    }> => {
      try {
        if (!controlPlaneServer || !controlPlaneServer.isRunning) {
          return { ok: false, error: "Control Plane is not running" };
        }
        const client = (controlPlaneServer as Any).clients.getNodeByIdOrName(nodeId);
        if (!client) {
          return { ok: false, error: `Node not found: ${nodeId}` };
        }
        return { ok: true, node: client.getNodeInfo() };
      } catch (error: Any) {
        return { ok: false, error: error.message || String(error) };
      }
    },
  );

  // Invoke a command on a node
  ipcMain.handle(
    IPC_CHANNELS.NODE_INVOKE,
    async (
      _,
      params: import("../../shared/types").NodeInvokeParams,
    ): Promise<import("../../shared/types").NodeInvokeResult> => {
      try {
        if (!controlPlaneServer || !controlPlaneServer.isRunning) {
          return {
            ok: false,
            error: { code: "SERVER_NOT_RUNNING", message: "Control Plane is not running" },
          };
        }

        const { nodeId, command, params: commandParams, timeoutMs = 30000 } = params;

        // Find the node
        const client = (controlPlaneServer as Any).clients.getNodeByIdOrName(nodeId);
        if (!client) {
          return {
            ok: false,
            error: { code: "NODE_NOT_FOUND", message: `Node not found: ${nodeId}` },
          };
        }

        const nodeInfo = client.getNodeInfo();
        if (!nodeInfo) {
          return {
            ok: false,
            error: { code: "NODE_NOT_FOUND", message: `Node not found: ${nodeId}` },
          };
        }

        // Check if node supports the command
        if (!nodeInfo.commands.includes(command)) {
          return {
            ok: false,
            error: {
              code: "COMMAND_NOT_SUPPORTED",
              message: `Node does not support command: ${command}`,
            },
          };
        }

        // Forward to the server's internal method
        const result = await (controlPlaneServer as Any).invokeNodeCommand(
          client,
          command,
          commandParams,
          timeoutMs,
        );
        return result;
      } catch (error: Any) {
        return {
          ok: false,
          error: { code: "INVOKE_FAILED", message: error.message || String(error) },
        };
      }
    },
  );

  console.log("[ControlPlane] IPC handlers initialized");
}

/**
 * Shutdown the control plane server, remote client, and SSH tunnel
 * Call this during app quit
 */
export async function shutdownControlPlane(): Promise<void> {
  // Shutdown SSH tunnel
  shutdownSSHTunnelManager();

  // Shutdown remote client
  shutdownRemoteGatewayClient();

  // Shutdown ACP registry
  shutdownACP();

  // Shutdown local server
  if (controlPlaneServer) {
    console.log("[ControlPlane] Shutting down server...");
    if (detachAgentDaemonBridge) {
      detachAgentDaemonBridge();
      detachAgentDaemonBridge = null;
    }
    await controlPlaneServer.stop();
    controlPlaneServer = null;
  }
}
