/**
 * Agent Client Protocol (ACP) Types
 *
 * Defines the data structures for agent-to-agent communication.
 * ACP enables agents to discover each other, exchange messages,
 * and delegate tasks across process and network boundaries.
 *
 * This complements MCP (Model Context Protocol) which handles
 * agent-to-tool communication.
 */

/**
 * ACP Agent Card - describes an agent's identity and capabilities.
 * Modeled after the ACP specification's AgentCard concept.
 */
export interface ACPAgentCard {
  /** Unique agent identifier */
  id: string;
  /** Human-readable display name */
  name: string;
  /** What this agent does */
  description: string;
  /** Agent version (semver) */
  version: string;
  /** Agent provider/author */
  provider?: string;
  /** Agent icon (emoji or URL) */
  icon?: string;
  /** Capabilities this agent supports */
  capabilities: ACPCapability[];
  /** Skills this agent can perform */
  skills?: string[];
  /** Accepted input content types */
  inputContentTypes?: string[];
  /** Output content types this agent produces */
  outputContentTypes?: string[];
  /** Whether this agent supports streaming responses */
  supportsStreaming?: boolean;
  /** Wire protocol used by the remote endpoint. Defaults to cowork-legacy. */
  protocol?: "cowork-legacy" | "a2a-v1";
  /** Agent endpoint URL (for remote agents) */
  endpoint?: string;
  /** Agent origin: 'local' (CoWork role) or 'remote' (external agent) */
  origin: "local" | "remote";
  /** The local agent role ID if origin is 'local' */
  localRoleId?: string;
  /** Registration timestamp */
  registeredAt: number;
  /** Last activity timestamp */
  lastActiveAt: number;
  /** Agent status */
  status: "available" | "busy" | "offline";
  /** Custom metadata */
  metadata?: Record<string, unknown>;
}

/**
 * ACP Capability descriptor
 */
export interface ACPCapability {
  /** Capability identifier (e.g., 'code', 'analyze', 'design') */
  id: string;
  /** Human-readable name */
  name: string;
  /** Description of what this capability enables */
  description?: string;
}

/**
 * ACP Message - a message exchanged between agents
 */
export interface ACPMessage {
  /** Unique message ID */
  id: string;
  /** Sender agent ID */
  from: string;
  /** Recipient agent ID */
  to: string;
  /** Message content type */
  contentType: "text/plain" | "application/json" | "text/markdown";
  /** Message body */
  body: string;
  /** Structured data payload (optional) */
  data?: unknown;
  /** Correlation ID for request-response flows */
  correlationId?: string;
  /** Reference to a parent message (for threading) */
  replyTo?: string;
  /** Message priority */
  priority?: "low" | "normal" | "high";
  /** Message timestamp */
  timestamp: number;
  /** Time-to-live in milliseconds (0 = no expiry) */
  ttlMs?: number;
}

/**
 * ACP Task - a task delegated from one agent to another
 */
export interface ACPTask {
  /** Unique task ID (maps to CoWork task ID for local agents) */
  id: string;
  /** ID of the agent that created/delegated the task */
  requesterId: string;
  /** ID of the agent assigned to execute the task */
  assigneeId: string;
  /** Task title */
  title: string;
  /** Task prompt/instructions */
  prompt: string;
  /** Task status */
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  /** Task result (when completed) */
  result?: string;
  /** Error message (when failed) */
  error?: string;
  /** Associated CoWork task ID (if delegated to a local agent) */
  coworkTaskId?: string;
  /** Remote task ID returned by an external agent endpoint */
  remoteTaskId?: string;
  /** Associated workspace ID */
  workspaceId?: string;
  /** Creation timestamp */
  createdAt: number;
  /** Last update timestamp */
  updatedAt: number;
  /** Completion timestamp */
  completedAt?: number;
}

/**
 * Parameters for acp.discover method
 */
export interface ACPDiscoverParams {
  /** Filter by capability */
  capability?: string;
  /** Filter by status */
  status?: "available" | "busy" | "offline";
  /** Filter by origin */
  origin?: "local" | "remote";
  /** Search query (matches name, description, skills) */
  query?: string;
}

/**
 * Parameters for acp.agent.register
 */
export interface ACPAgentRegisterParams {
  /** Agent card to register */
  name: string;
  description: string;
  version?: string;
  provider?: string;
  icon?: string;
  capabilities?: Array<{ id: string; name: string; description?: string }>;
  skills?: string[];
  inputContentTypes?: string[];
  outputContentTypes?: string[];
  supportsStreaming?: boolean;
  protocol?: "cowork-legacy" | "a2a-v1";
  endpoint?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Parameters for acp.message.send
 */
export interface ACPMessageSendParams {
  /** Target agent ID */
  to: string;
  /** Message content */
  body: string;
  /** Content type */
  contentType?: "text/plain" | "application/json" | "text/markdown";
  /** Structured data */
  data?: unknown;
  /** Correlation ID for request-response flows */
  correlationId?: string;
  /** Reply to a previous message */
  replyTo?: string;
  /** Message priority */
  priority?: "low" | "normal" | "high";
  /** Time-to-live in milliseconds */
  ttlMs?: number;
}

/**
 * Parameters for acp.task.create
 */
export interface ACPTaskCreateParams {
  /** Target agent ID */
  assigneeId: string;
  /** Task title */
  title: string;
  /** Task instructions */
  prompt: string;
  /** Workspace ID to execute in */
  workspaceId?: string;
}

export interface A2AJsonRpcRequest {
  jsonrpc: "2.0";
  id: string;
  method:
    | "message/send"
    | "message/stream"
    | "tasks/send"
    | "tasks/create"
    | "tasks/get"
    | "tasks/cancel";
  params: Record<string, unknown>;
}

export interface A2AV1Message {
  messageId: string;
  role: "ROLE_USER" | "ROLE_AGENT";
  contextId?: string;
  taskId?: string;
  parts: Array<
    | { text: string; mediaType?: string }
    | { data: unknown; mediaType?: string }
    | { url?: string; raw?: string; filename?: string; mediaType?: string }
  >;
}

export interface A2AV1TaskResult {
  kind?: "task";
  id?: string;
  taskId?: string;
  contextId?: string;
  status?: {
    state?: string;
    message?: A2AV1Message;
  };
  artifacts?: Array<{
    artifactId?: string;
    name?: string;
    parts?: A2AV1Message["parts"];
  }>;
  message?: A2AV1Message;
  /** Direct message responses are accepted in addition to task responses. */
  messageId?: string;
  role?: A2AV1Message["role"];
  parts?: A2AV1Message["parts"];
}

export interface A2AJsonRpcSuccessResponse<T = unknown> {
  jsonrpc: "2.0";
  id: string;
  result: T;
}

export interface A2AJsonRpcErrorResponse {
  jsonrpc: "2.0";
  id: string;
  error: {
    code: number;
    message: string;
    data?: unknown;
  };
}

export interface A2ARemoteTaskResult {
  id?: string;
  taskId?: string;
  status?: "pending" | "running" | "completed" | "failed" | "cancelled";
  result?: string;
  output?: string;
  error?: string;
}

/**
 * ACP Events
 */
export const ACPEvents = {
  /** Emitted when a new agent registers */
  AGENT_REGISTERED: "acp.agent.registered",
  /** Emitted when an agent unregisters */
  AGENT_UNREGISTERED: "acp.agent.unregistered",
  /** Emitted when an agent's status changes */
  AGENT_STATUS_CHANGED: "acp.agent.status_changed",
  /** Emitted when a message is received */
  MESSAGE_RECEIVED: "acp.message.received",
  /** Emitted when a task status changes */
  TASK_UPDATED: "acp.task.updated",
} as const;

/**
 * ACP Method names (registered on the Control Plane)
 */
export const ACPMethods = {
  /** Discover available agents */
  DISCOVER: "acp.discover",
  /** Get a specific agent's card */
  AGENT_GET: "acp.agent.get",
  /** Register a remote agent */
  AGENT_REGISTER: "acp.agent.register",
  /** Unregister a remote agent */
  AGENT_UNREGISTER: "acp.agent.unregister",
  /** Send a message to an agent */
  MESSAGE_SEND: "acp.message.send",
  /** List messages for the calling agent */
  MESSAGE_LIST: "acp.message.list",
  /** Create a task for an agent */
  TASK_CREATE: "acp.task.create",
  /** Get task status */
  TASK_GET: "acp.task.get",
  /** List ACP tasks */
  TASK_LIST: "acp.task.list",
  /** Cancel an ACP task */
  TASK_CANCEL: "acp.task.cancel",
} as const;
