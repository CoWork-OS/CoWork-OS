/**
 * ACP Method Handlers
 *
 * Registers Agent Client Protocol methods on the Control Plane server.
 * Leverages the existing WebSocket frame protocol and authentication.
 */

import { serviceStatements } from "../database/service-statements";
import { randomUUID } from "crypto";
import type Database from "better-sqlite3";
import { ErrorCodes } from "../control-plane/protocol";
import type { ControlPlaneServer } from "../control-plane/server";
import type { ControlPlaneClient } from "../control-plane/client";
import { createLogger } from "../utils/logger";
import { ACPAgentRegistry } from "./agent-registry";
import { RemoteAgentInvoker } from "./remote-invoker";
import {
  ACPMethods,
  ACPEvents,
  type ACPMessage,
  type ACPTask,
  type ACPDiscoverParams,
  type ACPAgentRegisterParams,
  type ACPMessageSendParams,
  type ACPTaskCreateParams,
} from "./types";

/**
 * Dependencies for ACP handler registration
 */
export interface ACPHandlerDeps {
  db?: Database.Database;
  requireScope?: (
    client: ControlPlaneClient,
    scope: "admin" | "read" | "write" | "operator",
  ) => void;
  /** Function to fetch active agent roles from the AgentRoleRepository */
  getActiveRoles: () =>
    | Array<{
        id: string;
        name: string;
        displayName: string;
        description?: string;
        icon: string;
        capabilities: string[];
        isActive: boolean;
      }>
    | Promise<
        Array<{
          id: string;
          name: string;
          displayName: string;
          description?: string;
          icon: string;
          capabilities: string[];
          isActive: boolean;
        }>
      >;
  /** Function to create a CoWork task for local agent delegation */
  createTask?: (params: {
    title: string;
    prompt: string;
    workspaceId: string;
    assignedAgentRoleId?: string;
  }) => Promise<{ taskId: string }>;
  createDelegatedGraphTask?: (params: {
    acpTaskId: string;
    assigneeId: string;
    title: string;
    prompt: string;
    workspaceId: string;
    assignedAgentRoleId?: string;
    remote: boolean;
  }) => Promise<{
    status: string;
    coworkTaskId?: string;
    remoteTaskId?: string;
    result?: string;
    error?: string;
  }>;
  getDelegatedGraphStatus?: (acpTaskId: string) => Promise<
    | {
        status: string;
        coworkTaskId?: string;
        remoteTaskId?: string;
        result?: string;
        error?: string;
      }
    | undefined
  >;
  cancelDelegatedGraphTask?: (acpTaskId: string) => Promise<void>;
  /** Function to get a task by ID */
  getTask?: (
    taskId: string,
  ) =>
    | { id: string; status: string; error?: string }
    | undefined
    | Promise<{ id: string; status: string; error?: string } | undefined>;
  /** Function to cancel a task by ID */
  cancelTask?: (taskId: string) => Promise<void>;
}

/** In-memory ACP task tracker */
const acpTasks = new Map<string, ACPTask>();
const remoteInvoker = new RemoteAgentInvoker();
const logger = createLogger("ACPHandler");

/** The shared ACP agent registry instance */
let registry: ACPAgentRegistry | null = null;

/**
 * Get or create the ACP agent registry singleton
 */
export function getACPRegistry(db?: Database.Database): ACPAgentRegistry {
  if (!registry) {
    registry = new ACPAgentRegistry(db);
  }
  return registry;
}

// ===== Validation helpers =====

function requireAuth(client: ControlPlaneClient): void {
  if (!client.isAuthenticated) {
    throw { code: ErrorCodes.UNAUTHORIZED, message: "Authentication required" };
  }
}

function requireScopedAuth(
  client: ControlPlaneClient,
  deps: ACPHandlerDeps,
  scope: "admin" | "read" | "write" | "operator",
): void {
  requireAuth(client);
  if (deps.requireScope) {
    deps.requireScope(client, scope);
  }
}

function hasElevatedAccess(client: ControlPlaneClient): boolean {
  return Boolean(client?.hasScope?.("operator") || client?.hasScope?.("admin"));
}

function getRequesterId(client: ControlPlaneClient): string {
  return `client:${client.id}`;
}

function enforceTaskAccess(client: ControlPlaneClient, task: ACPTask): void {
  if (task.requesterId === getRequesterId(client) || hasElevatedAccess(client)) {
    return;
  }
  throw {
    code: ErrorCodes.UNAUTHORIZED,
    message: "You do not have access to this ACP task",
  };
}

function mapRowToTask(row: Record<string, unknown>): ACPTask {
  return {
    id: String(row.id || ""),
    requesterId: String(row.requester_id || ""),
    assigneeId: String(row.assignee_id || ""),
    title: String(row.title || ""),
    prompt: String(row.prompt || ""),
    status: String(row.status || "pending") as ACPTask["status"],
    result: typeof row.result === "string" ? row.result : undefined,
    error: typeof row.error === "string" ? row.error : undefined,
    coworkTaskId: typeof row.cowork_task_id === "string" ? row.cowork_task_id : undefined,
    remoteTaskId: typeof row.remote_task_id === "string" ? row.remote_task_id : undefined,
    workspaceId: typeof row.workspace_id === "string" ? row.workspace_id : undefined,
    createdAt: Number(row.created_at || Date.now()),
    updatedAt: Number(row.updated_at || Date.now()),
    completedAt: typeof row.completed_at === "number" ? row.completed_at : undefined,
  };
}

/** Load persisted ACP tasks into memory; method handlers wait for this. */
async function loadPersistedTasks(db?: Database.Database): Promise<void> {
  acpTasks.clear();
  if (!db) return;
  const rows = await serviceStatements(db).unit("acp_taskRows", []);
  for (const row of rows) {
    const task = mapRowToTask(row);
    if (task.id) {
      acpTasks.set(task.id, task);
    }
  }
}

/** Persist a task without holding up the caller; the task stays in memory either way. */
function persistTask(db: Database.Database | undefined, task: ACPTask): void {
  if (!db) return;
  void serviceStatements(db)
    .unit("acp_persistTask", [task])
    .catch((error: unknown) => logger.warn("Failed to persist ACP task:", error));
}

async function syncTaskStatus(
  task: ACPTask,
  deps: ACPHandlerDeps,
  reg: ACPAgentRegistry,
): Promise<ACPTask> {
  if (deps.getDelegatedGraphStatus) {
    const graphStatus = await deps.getDelegatedGraphStatus(task.id);
    if (graphStatus) {
      task.status = graphStatus.status as ACPTask["status"];
      task.result = graphStatus.result;
      task.error = graphStatus.error;
      task.coworkTaskId = graphStatus.coworkTaskId;
      task.remoteTaskId = graphStatus.remoteTaskId;
      task.updatedAt = Date.now();
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        task.completedAt = Date.now();
      }
      persistTask(deps.db, task);
      return task;
    }
  }
  if (task.coworkTaskId && deps.getTask) {
    const coworkTask = await deps.getTask(task.coworkTaskId);
    if (coworkTask) {
      const statusMap: Record<string, ACPTask["status"]> = {
        pending: "pending",
        running: "running",
        completed: "completed",
        failed: "failed",
        cancelled: "cancelled",
      };
      const newStatus = statusMap[coworkTask.status] || task.status;
      if (newStatus !== task.status) {
        task.status = newStatus;
        task.updatedAt = Date.now();
        if (newStatus === "completed" || newStatus === "failed" || newStatus === "cancelled") {
          task.completedAt = Date.now();
        }
      }
      if (coworkTask.error) {
        task.error = coworkTask.error;
      }
      persistTask(deps.db, task);
    }
  } else if (task.remoteTaskId) {
    const roles = await deps.getActiveRoles();
    const assignee = reg.getAgent(task.assigneeId, roles);
    if (assignee?.origin === "remote" && assignee.endpoint) {
      try {
        const result = await remoteInvoker.pollStatus(assignee, task.remoteTaskId);
        task.status = result.status;
        task.result = result.result;
        task.error = result.error;
        task.updatedAt = Date.now();
        if (
          result.status === "completed" ||
          result.status === "failed" ||
          result.status === "cancelled"
        ) {
          task.completedAt = Date.now();
        }
      } catch (err: Any) {
        task.status = "failed";
        task.error = err?.message || "Failed to poll remote agent";
        task.updatedAt = Date.now();
        task.completedAt = Date.now();
      }
      persistTask(deps.db, task);
    }
  }
  return task;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw {
      code: ErrorCodes.INVALID_PARAMS,
      message: `${field} is required and must be a non-empty string`,
    };
  }
  return value.trim();
}

// ===== Handler registration =====

/**
 * Register all ACP method handlers on the Control Plane server.
 * Call this during server startup alongside registerTaskAndWorkspaceMethods.
 */
export function registerACPMethods(server: ControlPlaneServer, deps: ACPHandlerDeps): void {
  const reg = getACPRegistry(deps.db);
  // Handlers run once the persisted tasks and remote agents are loaded.
  const loaded = Promise.all([loadPersistedTasks(deps.db), reg.ready]).catch((error: unknown) => {
    logger.warn("Failed to load persisted ACP state:", error);
  });
  const registerMethod: typeof server.registerMethod = (name, handler) =>
    server.registerMethod(name, async (client, params) => {
      await loaded;
      return handler(client, params);
    });

  // ----- acp.discover -----
  registerMethod(ACPMethods.DISCOVER, async (client, params) => {
    requireScopedAuth(client, deps, "read");
    const p = (params || {}) as ACPDiscoverParams;
    const roles = await deps.getActiveRoles();
    const agents = reg.discover(p, roles);
    return { agents };
  });

  // ----- acp.agent.get -----
  registerMethod(ACPMethods.AGENT_GET, async (client, params) => {
    requireScopedAuth(client, deps, "read");
    const p = params as { agentId?: string } | undefined;
    const agentId = requireString(p?.agentId, "agentId");
    const roles = await deps.getActiveRoles();
    const agent = reg.getAgent(agentId, roles);
    if (!agent) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Agent not found: ${agentId}` };
    }
    return { agent };
  });

  // ----- acp.agent.register -----
  registerMethod(ACPMethods.AGENT_REGISTER, async (client, params) => {
    requireScopedAuth(client, deps, "admin");
    const p = (params || {}) as ACPAgentRegisterParams;
    requireString(p.name, "name");
    requireString(p.description, "description");

    const card = reg.registerRemoteAgent(p);

    // Broadcast registration event
    server.broadcast(ACPEvents.AGENT_REGISTERED, { agent: card });

    return { agent: card };
  });

  // ----- acp.agent.unregister -----
  registerMethod(ACPMethods.AGENT_UNREGISTER, async (client, params) => {
    requireScopedAuth(client, deps, "admin");
    const p = params as { agentId?: string } | undefined;
    const agentId = requireString(p?.agentId, "agentId");

    if (!agentId.startsWith("remote:")) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: "Only remote agents can be unregistered" };
    }

    const removed = reg.unregisterRemoteAgent(agentId);
    if (!removed) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Agent not found: ${agentId}` };
    }

    // Broadcast unregistration event
    server.broadcast(ACPEvents.AGENT_UNREGISTERED, { agentId });

    return { ok: true };
  });

  // ----- acp.message.send -----
  registerMethod(ACPMethods.MESSAGE_SEND, async (client, params) => {
    requireScopedAuth(client, deps, "write");
    const p = (params || {}) as ACPMessageSendParams & { from?: string };
    const to = requireString(p.to, "to");
    const body = requireString(p.body, "body");
    if (p.from && p.from !== getRequesterId(client) && !hasElevatedAccess(client)) {
      throw {
        code: ErrorCodes.UNAUTHORIZED,
        message: "Custom ACP message sender IDs require operator access",
      };
    }

    // Validate target agent exists
    const roles = await deps.getActiveRoles();
    const targetAgent = reg.getAgent(to, roles);
    if (!targetAgent) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Target agent not found: ${to}` };
    }

    const message: ACPMessage = {
      id: randomUUID(),
      from: p.from || getRequesterId(client),
      to,
      contentType: p.contentType || "text/plain",
      body,
      data: p.data,
      correlationId: p.correlationId,
      replyTo: p.replyTo,
      priority: p.priority || "normal",
      timestamp: Date.now(),
      ttlMs: p.ttlMs,
    };

    // Store in recipient's inbox
    reg.pushMessage(to, message);

    // Broadcast message event
    server.broadcast(ACPEvents.MESSAGE_RECEIVED, { message });

    // If the target is a local agent and we have task creation capability,
    // auto-create a task from high-priority messages
    if (
      targetAgent.origin === "local" &&
      targetAgent.localRoleId &&
      p.priority === "high" &&
      deps.createTask
    ) {
      try {
        const result = await deps.createTask({
          title: `ACP message from ${message.from}`,
          prompt: body,
          workspaceId: "", // Will use default workspace
          assignedAgentRoleId: targetAgent.localRoleId,
        });
        message.data = { ...(message.data as Any), autoTaskId: result.taskId };
      } catch {
        // Non-fatal: message was still delivered to inbox
      }
    }

    return { messageId: message.id, delivered: true };
  });

  // ----- acp.message.list -----
  registerMethod(ACPMethods.MESSAGE_LIST, async (client, params) => {
    requireScopedAuth(client, deps, "read");
    const p = (params || {}) as { agentId?: string; drain?: boolean };
    const agentId = requireString(p.agentId, "agentId");
    if (agentId !== getRequesterId(client) && !hasElevatedAccess(client)) {
      throw {
        code: ErrorCodes.UNAUTHORIZED,
        message: "Reading another agent inbox requires operator access",
      };
    }
    const drain = p.drain === true;
    const messages = reg.getMessages(agentId, drain);
    return { messages };
  });

  // ----- acp.task.create -----
  registerMethod(ACPMethods.TASK_CREATE, async (client, params) => {
    requireScopedAuth(client, deps, "write");
    const p = (params || {}) as ACPTaskCreateParams & { requesterId?: string };
    const assigneeId = requireString(p.assigneeId, "assigneeId");
    const title = requireString(p.title, "title");
    const prompt = requireString(p.prompt, "prompt");
    if (p.requesterId && p.requesterId !== getRequesterId(client) && !hasElevatedAccess(client)) {
      throw {
        code: ErrorCodes.UNAUTHORIZED,
        message: "Custom ACP requester IDs require operator access",
      };
    }

    // Validate assignee exists
    const roles = await deps.getActiveRoles();
    const assignee = reg.getAgent(assigneeId, roles);
    if (!assignee) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Assignee agent not found: ${assigneeId}` };
    }

    const acpTask: ACPTask = {
      id: randomUUID(),
      requesterId: p.requesterId || getRequesterId(client),
      assigneeId,
      title,
      prompt,
      status: "pending",
      workspaceId: p.workspaceId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    if (assignee.origin === "local" && assignee.localRoleId && !deps.createTask) {
      acpTask.status = "failed";
      acpTask.error = "Local ACP task delegation is not configured on this server";
    }

    if (deps.createDelegatedGraphTask) {
      try {
        const result = await deps.createDelegatedGraphTask({
          acpTaskId: acpTask.id,
          assigneeId,
          title,
          prompt,
          workspaceId: p.workspaceId || "",
          assignedAgentRoleId: assignee.origin === "local" ? assignee.localRoleId : undefined,
          remote: assignee.origin === "remote",
        });
        acpTask.coworkTaskId = result.coworkTaskId;
        acpTask.remoteTaskId = result.remoteTaskId;
        acpTask.status = result.status as ACPTask["status"];
        acpTask.result = result.result;
        acpTask.error = result.error;
        if (
          acpTask.status === "completed" ||
          acpTask.status === "failed" ||
          acpTask.status === "cancelled"
        ) {
          acpTask.completedAt = Date.now();
        }
      } catch (err: Any) {
        acpTask.status = "failed";
        acpTask.error = err?.message || "Failed to create delegated graph task";
      }
    } else if (assignee.origin === "local" && assignee.localRoleId && deps.createTask) {
      // If assignee is a local agent, delegate to the CoWork task system
      try {
        const result = await deps.createTask({
          title,
          prompt,
          workspaceId: p.workspaceId || "",
          assignedAgentRoleId: assignee.localRoleId,
        });
        acpTask.coworkTaskId = result.taskId;
        acpTask.status = "running";
      } catch (err: Any) {
        acpTask.status = "failed";
        acpTask.error = err?.message || "Failed to create task";
      }
    } else if (assignee.origin === "remote") {
      // New remote sends go only through the orchestration graph, which runs
      // remote dispatch admission (policy, network policy, approval). Without it
      // this server must not invoke the agent directly. Polling and cancelling an
      // already-admitted remote task below stay on the invoker.
      acpTask.status = "failed";
      acpTask.error = "Remote ACP task delegation is not configured on this server";
      acpTask.completedAt = Date.now();
    }

    acpTasks.set(acpTask.id, acpTask);
    persistTask(deps.db, acpTask);

    // Broadcast task creation event
    server.broadcast(ACPEvents.TASK_UPDATED, { task: acpTask });

    return { task: acpTask };
  });

  // ----- acp.task.get -----
  registerMethod(ACPMethods.TASK_GET, async (client, params) => {
    requireScopedAuth(client, deps, "read");
    const p = params as { taskId?: string } | undefined;
    const taskId = requireString(p?.taskId, "taskId");

    const acpTask = acpTasks.get(taskId);
    if (!acpTask) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `ACP task not found: ${taskId}` };
    }
    enforceTaskAccess(client, acpTask);
    await syncTaskStatus(acpTask, deps, reg);

    return { task: acpTask };
  });

  // ----- acp.task.list -----
  registerMethod(ACPMethods.TASK_LIST, async (client, params) => {
    requireScopedAuth(client, deps, "read");
    const p = (params || {}) as { assigneeId?: string; requesterId?: string; status?: string };

    let tasks = Array.from(acpTasks.values());

    if (p.assigneeId) {
      tasks = tasks.filter((t) => t.assigneeId === p.assigneeId);
    }
    if (p.requesterId) {
      if (p.requesterId !== getRequesterId(client) && !hasElevatedAccess(client)) {
        throw {
          code: ErrorCodes.UNAUTHORIZED,
          message: "Listing another client's ACP tasks requires operator access",
        };
      }
      tasks = tasks.filter((t) => t.requesterId === p.requesterId);
    } else if (!hasElevatedAccess(client)) {
      tasks = tasks.filter((t) => t.requesterId === getRequesterId(client));
    }
    if (p.status) {
      tasks = tasks.filter((t) => t.status === p.status);
    }

    tasks = await Promise.all(tasks.map((task) => syncTaskStatus(task, deps, reg)));

    // Sort by creation time, newest first
    tasks.sort((a, b) => b.createdAt - a.createdAt);

    return { tasks };
  });

  // ----- acp.task.cancel -----
  registerMethod(ACPMethods.TASK_CANCEL, async (client, params) => {
    requireScopedAuth(client, deps, "write");
    const p = params as { taskId?: string } | undefined;
    const taskId = requireString(p?.taskId, "taskId");

    const acpTask = acpTasks.get(taskId);
    if (!acpTask) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `ACP task not found: ${taskId}` };
    }
    enforceTaskAccess(client, acpTask);
    await syncTaskStatus(acpTask, deps, reg);

    if (acpTask.status === "completed" || acpTask.status === "cancelled") {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Task is already ${acpTask.status}` };
    }

    if (deps.cancelDelegatedGraphTask) {
      await deps.cancelDelegatedGraphTask(acpTask.id);
    } else if (acpTask.coworkTaskId && deps.cancelTask) {
      // Cancel the underlying CoWork task if it exists
      await deps.cancelTask(acpTask.coworkTaskId);
    } else if (acpTask.remoteTaskId) {
      const roles = await deps.getActiveRoles();
      const assignee = reg.getAgent(acpTask.assigneeId, roles);
      if (assignee?.origin === "remote" && assignee.endpoint) {
        const result = await remoteInvoker.cancel(assignee, acpTask.remoteTaskId);
        acpTask.result = result.result;
        acpTask.error = result.error;
      }
    }

    acpTask.status = "cancelled";
    acpTask.updatedAt = Date.now();
    acpTask.completedAt = Date.now();
    persistTask(deps.db, acpTask);

    // Broadcast cancellation event
    server.broadcast(ACPEvents.TASK_UPDATED, { task: acpTask });

    return { task: acpTask };
  });

  logger.info("Registered 10 ACP method handlers on Control Plane");
}

/**
 * Cleanup ACP state (call on shutdown)
 */
export function shutdownACP(): void {
  acpTasks.clear();
  if (registry) {
    registry.clear();
    registry = null;
  }
}
