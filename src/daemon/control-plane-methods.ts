import * as fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { ErrorCodes, Events, Methods } from "../electron/control-plane/protocol";
import type { ControlPlaneServer } from "../electron/control-plane/server";
import { ControlPlaneSettingsManager } from "../electron/control-plane/settings";
import type { AgentConfig } from "../shared/types";
import { isTempWorkspaceId } from "../shared/types";
import type { AgentDaemon } from "../electron/agent/daemon";
import type { DatabaseManager } from "../electron/database/schema";
import type { ChannelGateway } from "../electron/gateway";
import {
  ApprovalRepository,
  ChannelRepository,
  TaskEventRepository,
  TaskRepository,
  WorkspaceRepository,
} from "../electron/database/repositories";
import { SearchProviderFactory } from "../electron/agent/search";
import {
  configureLlmFromControlPlaneParams,
  getControlPlaneLlmStatus,
} from "../electron/control-plane/llm-configure";
import {
  getEnvSettingsImportModeFromArgsOrEnv,
  isHeadlessMode,
  shouldImportEnvSettingsFromArgsOrEnv,
} from "../electron/utils/runtime-mode";
import { getUserDataDir } from "../electron/utils/user-data-dir";

export interface ControlPlaneMethodDeps {
  agentDaemon: AgentDaemon;
  dbManager: DatabaseManager;
  channelGateway?: ChannelGateway;
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

  const home = os.homedir();
  const expanded =
    rawPath === "~" ? home : rawPath.startsWith("~/") ? path.join(home, rawPath.slice(2)) : rawPath;
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
    if (typeof p.name !== "string" || !p.name.trim())
      throw { code: ErrorCodes.INVALID_PARAMS, message: "name must be a non-empty string" };
    updates.name = p.name.trim();
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

    for (const k of keys.slice(0, MAX_BROADCAST_OBJECT_KEYS)) {
      if (ALWAYS_REDACT_KEY_RE.test(k) || SENSITIVE_KEY_RE.test(k)) {
        out[k] = "[REDACTED]";
        continue;
      }
      out[k] = sanitizeForBroadcast(obj[k], depth + 1, k);
    }

    if (keys.length > MAX_BROADCAST_OBJECT_KEYS) {
      out.__truncated_keys__ = keys.length - MAX_BROADCAST_OBJECT_KEYS;
    }

    return out;
  }

  try {
    return truncateForBroadcastKey(String(value));
  } catch {
    return "[unserializable]";
  }
}

function getCoworkVersionFromNearestPackageJson(): string | undefined {
  // Try to find a package.json by walking up from this compiled file's directory.
  // Works for both dist/electron/... and dist/daemon/... layouts.
  let dir = __dirname;
  for (let i = 0; i < 10; i++) {
    const candidate = path.join(dir, "package.json");
    try {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const pkg = require(candidate) as Any;
      const version = typeof pkg?.version === "string" ? pkg.version.trim() : "";
      if (version) return version;
    } catch {
      // ignore
    }
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

export function attachAgentDaemonTaskBridge(
  server: ControlPlaneServer,
  daemon: AgentDaemon,
): () => void {
  // Avoid broadcasting tool_result blobs by default; remote clients can fetch details via task.get if needed.
  const allowlist = [
    "task_created",
    "task_queued",
    "task_dequeued",
    "task_paused",
    "task_resumed",
    "task_cancelled",
    "task_completed",
    "plan_created",
    "plan_revised",
    "assistant_message",
    "user_message",
    "progress_update",
    "approval_requested",
    "approval_granted",
    "approval_denied",
    "step_started",
    "step_completed",
    "step_failed",
    "tool_call",
    "tool_error",
    "verification_passed",
    "verification_failed",
    "file_created",
    "file_modified",
    "file_deleted",
    "error",
    "llm_error",
    "step_timeout",
  ] as const;

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

export function registerControlPlaneMethods(
  server: ControlPlaneServer,
  deps: ControlPlaneMethodDeps,
): void {
  const db = deps.dbManager.getDatabase();
  const taskRepo = new TaskRepository(db);
  const workspaceRepo = new WorkspaceRepository(db);
  const approvalRepo = new ApprovalRepository(db);
  const eventRepo = new TaskEventRepository(db);
  const channelRepo = new ChannelRepository(db);
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
    const workspaces = all.filter((w) => !isTempWorkspaceId(w.id));
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

    const task = taskRepo.create({
      title: validated.title,
      prompt: validated.prompt,
      status: "pending",
      workspaceId: validated.workspaceId,
      agentConfig: validated.agentConfig,
      budgetTokens: validated.budgetTokens,
      budgetCost: validated.budgetCost,
    });

    const initialUpdates: Any = {};
    if (validated.assignedAgentRoleId) {
      initialUpdates.assignedAgentRoleId = validated.assignedAgentRoleId;
      initialUpdates.boardColumn = "todo";
    }
    if (Object.keys(initialUpdates).length > 0) {
      taskRepo.update(task.id, initialUpdates);
      Object.assign(task, initialUpdates);
    }

    if (!isTempWorkspaceId(validated.workspaceId)) {
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

    const allWorkspaces = workspaceRepo.findAll().filter((w) => !isTempWorkspaceId(w.id));
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
      coworkVersion: getCoworkVersionFromNearestPackageJson(),
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

  // Basic channel sanity check: report adapters available (best-effort).
  server.registerMethod("gateway.channelsSupported", async (client) => {
    requireScope(client, "read");
    const types = [
      "telegram",
      "discord",
      "slack",
      "whatsapp",
      "imessage",
      "signal",
      "matrix",
      "mattermost",
      "twitch",
      "line",
      "bluebubbles",
      "email",
    ];
    return { types };
  });

  // Best-effort: Ensure channel settings category is initialized (legacy compatibility).
  try {
    if (channelRepo && ControlPlaneSettingsManager) {
      // no-op
    }
  } catch {
    // ignore
  }
}
