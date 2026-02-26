/**
 * ACP Method Handlers
 *
 * Registers Agent Client Protocol methods on the Control Plane server.
 * Leverages the existing WebSocket frame protocol and authentication.
 */

import { randomUUID } from "crypto";
import { ErrorCodes } from "../control-plane/protocol";
import type { ControlPlaneServer } from "../control-plane/server";
import type { ControlPlaneClient } from "../control-plane/client";
import { ACPAgentRegistry } from "./agent-registry";
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
  /** Function to fetch active agent roles from the AgentRoleRepository */
  getActiveRoles: () => Array<{
    id: string;
    name: string;
    displayName: string;
    description?: string;
    icon: string;
    capabilities: string[];
    isActive: boolean;
  }>;
  /** Function to create a CoWork task for local agent delegation */
  createTask?: (params: {
    title: string;
    prompt: string;
    workspaceId: string;
    assignedAgentRoleId?: string;
  }) => Promise<{ taskId: string }>;
  /** Function to get a task by ID */
  getTask?: (taskId: string) => { id: string; status: string; error?: string } | undefined;
  /** Function to cancel a task by ID */
  cancelTask?: (taskId: string) => Promise<void>;
}

/** In-memory ACP task tracker */
const acpTasks = new Map<string, ACPTask>();

/** The shared ACP agent registry instance */
let registry: ACPAgentRegistry | null = null;

/**
 * Get or create the ACP agent registry singleton
 */
export function getACPRegistry(): ACPAgentRegistry {
  if (!registry) {
    registry = new ACPAgentRegistry();
  }
  return registry;
}

// ===== Validation helpers =====

function requireAuth(client: ControlPlaneClient): void {
  if (!client.isAuthenticated) {
    throw { code: ErrorCodes.UNAUTHORIZED, message: "Authentication required" };
  }
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
  const reg = getACPRegistry();

  // ----- acp.discover -----
  server.registerMethod(ACPMethods.DISCOVER, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as ACPDiscoverParams;
    const roles = deps.getActiveRoles();
    const agents = reg.discover(p, roles);
    return { agents };
  });

  // ----- acp.agent.get -----
  server.registerMethod(ACPMethods.AGENT_GET, async (client, params) => {
    requireAuth(client);
    const p = params as { agentId?: string } | undefined;
    const agentId = requireString(p?.agentId, "agentId");
    const roles = deps.getActiveRoles();
    const agent = reg.getAgent(agentId, roles);
    if (!agent) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Agent not found: ${agentId}` };
    }
    return { agent };
  });

  // ----- acp.agent.register -----
  server.registerMethod(ACPMethods.AGENT_REGISTER, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as ACPAgentRegisterParams;
    requireString(p.name, "name");
    requireString(p.description, "description");

    const card = reg.registerRemoteAgent(p);

    // Broadcast registration event
    server.broadcast(ACPEvents.AGENT_REGISTERED, { agent: card });

    return { agent: card };
  });

  // ----- acp.agent.unregister -----
  server.registerMethod(ACPMethods.AGENT_UNREGISTER, async (client, params) => {
    requireAuth(client);
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
  server.registerMethod(ACPMethods.MESSAGE_SEND, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as ACPMessageSendParams & { from?: string };
    const to = requireString(p.to, "to");
    const body = requireString(p.body, "body");

    // Validate target agent exists
    const roles = deps.getActiveRoles();
    const targetAgent = reg.getAgent(to, roles);
    if (!targetAgent) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Target agent not found: ${to}` };
    }

    const message: ACPMessage = {
      id: randomUUID(),
      from: p.from || `client:${client.id}`,
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
  server.registerMethod(ACPMethods.MESSAGE_LIST, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as { agentId?: string; drain?: boolean };
    const agentId = requireString(p.agentId, "agentId");
    const drain = p.drain === true;
    const messages = reg.getMessages(agentId, drain);
    return { messages };
  });

  // ----- acp.task.create -----
  server.registerMethod(ACPMethods.TASK_CREATE, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as ACPTaskCreateParams & { requesterId?: string };
    const assigneeId = requireString(p.assigneeId, "assigneeId");
    const title = requireString(p.title, "title");
    const prompt = requireString(p.prompt, "prompt");

    // Validate assignee exists
    const roles = deps.getActiveRoles();
    const assignee = reg.getAgent(assigneeId, roles);
    if (!assignee) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Assignee agent not found: ${assigneeId}` };
    }

    const acpTask: ACPTask = {
      id: randomUUID(),
      requesterId: p.requesterId || `client:${client.id}`,
      assigneeId,
      title,
      prompt,
      status: "pending",
      workspaceId: p.workspaceId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    };

    // If assignee is a local agent, delegate to the CoWork task system
    if (assignee.origin === "local" && assignee.localRoleId && deps.createTask) {
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
    }

    acpTasks.set(acpTask.id, acpTask);

    // Broadcast task creation event
    server.broadcast(ACPEvents.TASK_UPDATED, { task: acpTask });

    return { task: acpTask };
  });

  // ----- acp.task.get -----
  server.registerMethod(ACPMethods.TASK_GET, async (client, params) => {
    requireAuth(client);
    const p = params as { taskId?: string } | undefined;
    const taskId = requireString(p?.taskId, "taskId");

    const acpTask = acpTasks.get(taskId);
    if (!acpTask) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `ACP task not found: ${taskId}` };
    }

    // Sync status from CoWork task if applicable
    if (acpTask.coworkTaskId && deps.getTask) {
      const coworkTask = deps.getTask(acpTask.coworkTaskId);
      if (coworkTask) {
        const statusMap: Record<string, ACPTask["status"]> = {
          pending: "pending",
          running: "running",
          completed: "completed",
          failed: "failed",
          cancelled: "cancelled",
        };
        const newStatus = statusMap[coworkTask.status] || acpTask.status;
        if (newStatus !== acpTask.status) {
          acpTask.status = newStatus;
          acpTask.updatedAt = Date.now();
          if (newStatus === "completed" || newStatus === "failed" || newStatus === "cancelled") {
            acpTask.completedAt = Date.now();
          }
          if (coworkTask.error) {
            acpTask.error = coworkTask.error;
          }
        }
      }
    }

    return { task: acpTask };
  });

  // ----- acp.task.list -----
  server.registerMethod(ACPMethods.TASK_LIST, async (client, params) => {
    requireAuth(client);
    const p = (params || {}) as { assigneeId?: string; requesterId?: string; status?: string };

    let tasks = Array.from(acpTasks.values());

    if (p.assigneeId) {
      tasks = tasks.filter((t) => t.assigneeId === p.assigneeId);
    }
    if (p.requesterId) {
      tasks = tasks.filter((t) => t.requesterId === p.requesterId);
    }
    if (p.status) {
      tasks = tasks.filter((t) => t.status === p.status);
    }

    // Sort by creation time, newest first
    tasks.sort((a, b) => b.createdAt - a.createdAt);

    return { tasks };
  });

  // ----- acp.task.cancel -----
  server.registerMethod(ACPMethods.TASK_CANCEL, async (client, params) => {
    requireAuth(client);
    const p = params as { taskId?: string } | undefined;
    const taskId = requireString(p?.taskId, "taskId");

    const acpTask = acpTasks.get(taskId);
    if (!acpTask) {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `ACP task not found: ${taskId}` };
    }

    if (acpTask.status === "completed" || acpTask.status === "cancelled") {
      throw { code: ErrorCodes.INVALID_PARAMS, message: `Task is already ${acpTask.status}` };
    }

    // Cancel the underlying CoWork task if it exists
    if (acpTask.coworkTaskId && deps.cancelTask) {
      try {
        await deps.cancelTask(acpTask.coworkTaskId);
      } catch {
        // Best-effort cancellation
      }
    }

    acpTask.status = "cancelled";
    acpTask.updatedAt = Date.now();
    acpTask.completedAt = Date.now();

    // Broadcast cancellation event
    server.broadcast(ACPEvents.TASK_UPDATED, { task: acpTask });

    return { task: acpTask };
  });

  console.log("[ACP] Registered 10 ACP method handlers on Control Plane");
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
