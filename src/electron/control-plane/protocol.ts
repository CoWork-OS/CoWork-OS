/**
 * WebSocket Control Plane Protocol
 *
 * Defines the frame types for communication over the WebSocket control plane.
 * Uses a tagged union pattern for type-safe message handling.
 */

import { randomUUID } from "crypto";

/**
 * Frame type discriminator
 */
export const FrameType = {
  Request: "req",
  Response: "res",
  Event: "event",
} as const;

export type FrameTypeValue = (typeof FrameType)[keyof typeof FrameType];

/**
 * Error shape for response frames
 */
export interface ErrorShape {
  code: string;
  message: string;
  details?: unknown;
}

/**
 * Request frame - sent by client to invoke a method
 */
export interface RequestFrame {
  type: typeof FrameType.Request;
  id: string;
  method: string;
  params?: unknown;
}

/**
 * Response frame - sent by server in response to a request
 */
export interface ResponseFrame {
  type: typeof FrameType.Response;
  id: string;
  ok: boolean;
  payload?: unknown;
  error?: ErrorShape;
}

/**
 * Event frame - sent by server to broadcast events
 */
export interface EventFrame {
  type: typeof FrameType.Event;
  event: string;
  payload?: unknown;
  seq?: number;
  stateVersion?: string;
}

/**
 * Union type for all frame types
 */
export type Frame = RequestFrame | ResponseFrame | EventFrame;

/**
 * Error codes
 */
export const ErrorCodes = {
  // Connection errors
  UNAUTHORIZED: "UNAUTHORIZED",
  CONNECTION_CLOSED: "CONNECTION_CLOSED",
  HANDSHAKE_TIMEOUT: "HANDSHAKE_TIMEOUT",

  // Request errors
  INVALID_FRAME: "INVALID_FRAME",
  UNKNOWN_METHOD: "UNKNOWN_METHOD",
  INVALID_PARAMS: "INVALID_PARAMS",
  METHOD_FAILED: "METHOD_FAILED",

  // Node errors (Mobile Companions)
  NODE_NOT_FOUND: "NODE_NOT_FOUND",
  NODE_UNAVAILABLE: "NODE_UNAVAILABLE",
  NODE_TIMEOUT: "NODE_TIMEOUT",
  NODE_PERMISSION_DENIED: "NODE_PERMISSION_DENIED",
  NODE_COMMAND_FAILED: "NODE_COMMAND_FAILED",
  NODE_BACKGROUND_UNAVAILABLE: "NODE_BACKGROUND_UNAVAILABLE",

  // Internal errors
  INTERNAL_ERROR: "INTERNAL_ERROR",
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/**
 * Validate and parse a frame from JSON
 *
 * Note: String fields (id, method, event) are validated to be non-empty after trimming.
 * This prevents whitespace-only values from being accepted.
 */
export function parseFrame(data: string): Frame | null {
  try {
    const parsed = JSON.parse(data);

    // Check frame type
    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const type = parsed.type;

    if (type === FrameType.Request) {
      if (typeof parsed.id !== "string" || !parsed.id.trim()) return null;
      if (typeof parsed.method !== "string" || !parsed.method.trim()) return null;
      return parsed as RequestFrame;
    }

    if (type === FrameType.Response) {
      if (typeof parsed.id !== "string" || !parsed.id.trim()) return null;
      if (typeof parsed.ok !== "boolean") return null;
      return parsed as ResponseFrame;
    }

    if (type === FrameType.Event) {
      if (typeof parsed.event !== "string" || !parsed.event.trim()) return null;
      return parsed as EventFrame;
    }

    return null;
  } catch {
    return null;
  }
}

/**
 * Serialize a frame to JSON
 */
export function serializeFrame(frame: Frame): string {
  return JSON.stringify(frame);
}

/**
 * Create a request frame
 */
export function createRequestFrame(method: string, params?: unknown): RequestFrame {
  return {
    type: FrameType.Request,
    id: randomUUID(),
    method,
    params,
  };
}

/**
 * Create a success response frame
 */
export function createResponseFrame(requestId: string, payload?: unknown): ResponseFrame {
  return {
    type: FrameType.Response,
    id: requestId,
    ok: true,
    payload,
  };
}

/**
 * Create an error response frame
 */
export function createErrorResponse(
  requestId: string,
  code: ErrorCode,
  message: string,
  details?: unknown,
): ResponseFrame {
  return {
    type: FrameType.Response,
    id: requestId,
    ok: false,
    error: { code, message, details },
  };
}

/**
 * Create an event frame
 */
export function createEventFrame(
  event: string,
  payload?: unknown,
  seq?: number,
  stateVersion?: string,
): EventFrame {
  const frame: EventFrame = {
    type: FrameType.Event,
    event,
  };

  if (payload !== undefined) frame.payload = payload;
  if (seq !== undefined) frame.seq = seq;
  if (stateVersion !== undefined) frame.stateVersion = stateVersion;

  return frame;
}

/**
 * Standard event names
 */
export const Events = {
  // Connection events
  CONNECT_CHALLENGE: "connect.challenge",
  CONNECT_SUCCESS: "connect.success",

  // Task events
  TASK_CREATED: "task.created",
  TASK_UPDATED: "task.updated",
  TASK_COMPLETED: "task.completed",
  TASK_FAILED: "task.failed",
  TASK_EVENT: "task.event",

  // Node events (Mobile Companions)
  NODE_CONNECTED: "node.connected",
  NODE_DISCONNECTED: "node.disconnected",
  NODE_CAPABILITIES_CHANGED: "node.capabilities_changed",
  NODE_EVENT: "node.event",

  // System events
  HEARTBEAT: "heartbeat",
  CONFIG_CHANGED: "config.changed",
  SHUTDOWN: "shutdown",

  // ACP (Agent Client Protocol) events
  ACP_AGENT_REGISTERED: "acp.agent.registered",
  ACP_AGENT_UNREGISTERED: "acp.agent.unregistered",
  ACP_AGENT_STATUS_CHANGED: "acp.agent.status_changed",
  ACP_MESSAGE_RECEIVED: "acp.message.received",
  ACP_TASK_UPDATED: "acp.task.updated",

  // Canvas events (cross-device)
  CANVAS_CONTENT_PUSHED: "canvas.content_pushed",
  CANVAS_SESSION_UPDATED: "canvas.session_updated",
} as const;

/**
 * Standard method names
 */
export const Methods = {
  // Connection
  CONNECT: "connect",
  PING: "ping",
  HEALTH: "health",

  // Approvals
  APPROVAL_RESPOND: "approval.respond",
  APPROVAL_LIST: "approval.list",

  // Task operations
  TASK_CREATE: "task.create",
  TASK_GET: "task.get",
  TASK_LIST: "task.list",
  TASK_EVENTS: "task.events",
  TASK_CANCEL: "task.cancel",
  TASK_SEND_MESSAGE: "task.sendMessage",

  // Agent operations
  AGENT_WAKE: "agent.wake",
  AGENT_SEND: "agent.send",

  // Node operations (Mobile Companions)
  NODE_LIST: "node.list",
  NODE_DESCRIBE: "node.describe",
  NODE_INVOKE: "node.invoke",
  NODE_EVENT: "node.event",

  // System operations
  STATUS: "status",
  CONFIG_GET: "config.get",
  CONFIG_SET: "config.set",
  LLM_CONFIGURE: "llm.configure",

  // Workspace operations
  WORKSPACE_LIST: "workspace.list",
  WORKSPACE_GET: "workspace.get",
  WORKSPACE_CREATE: "workspace.create",

  // Managed account operations (API-first signup/account lifecycle)
  ACCOUNT_LIST: "account.list",
  ACCOUNT_GET: "account.get",
  ACCOUNT_UPSERT: "account.upsert",
  ACCOUNT_REMOVE: "account.remove",

  // Channel operations (gateway)
  CHANNEL_LIST: "channel.list",
  CHANNEL_GET: "channel.get",
  CHANNEL_CREATE: "channel.create",
  CHANNEL_UPDATE: "channel.update",
  CHANNEL_TEST: "channel.test",
  CHANNEL_ENABLE: "channel.enable",
  CHANNEL_DISABLE: "channel.disable",
  CHANNEL_REMOVE: "channel.remove",

  // ACP (Agent Client Protocol) operations
  ACP_DISCOVER: "acp.discover",
  ACP_AGENT_GET: "acp.agent.get",
  ACP_AGENT_REGISTER: "acp.agent.register",
  ACP_AGENT_UNREGISTER: "acp.agent.unregister",
  ACP_MESSAGE_SEND: "acp.message.send",
  ACP_MESSAGE_LIST: "acp.message.list",
  ACP_TASK_CREATE: "acp.task.create",
  ACP_TASK_GET: "acp.task.get",
  ACP_TASK_LIST: "acp.task.list",
  ACP_TASK_CANCEL: "acp.task.cancel",

  // Canvas operations (cross-device rendering)
  CANVAS_LIST: "canvas.list",
  CANVAS_GET: "canvas.get",
  CANVAS_SNAPSHOT: "canvas.snapshot",
  CANVAS_CONTENT: "canvas.content",
  CANVAS_PUSH: "canvas.push",
  CANVAS_EVAL: "canvas.eval",
  CANVAS_CHECKPOINT_SAVE: "canvas.checkpoint.save",
  CANVAS_CHECKPOINT_LIST: "canvas.checkpoint.list",
  CANVAS_CHECKPOINT_RESTORE: "canvas.checkpoint.restore",
  CANVAS_CHECKPOINT_DELETE: "canvas.checkpoint.delete",
} as const;
