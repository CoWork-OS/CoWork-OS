/**
 * MCP (Model Context Protocol) Types
 *
 * These types define the core data structures for MCP server connections,
 * tool definitions, and protocol messages.
 */

// Transport types supported by MCP
export type MCPTransportType = "stdio" | "sse" | "websocket";

// Connection status for MCP servers
export type MCPConnectionStatus =
  | "disconnected"
  | "connecting"
  | "connected"
  | "reconnecting"
  | "error";

// Authentication types
export interface MCPAuthConfig {
  type: "none" | "bearer" | "api-key" | "basic";
  token?: string; // Encrypted when stored
  apiKey?: string; // Encrypted when stored
  username?: string;
  password?: string; // Encrypted when stored
  headerName?: string; // Custom header name for API key auth
}

// MCP Server Configuration
export interface MCPServerConfig {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  transport: MCPTransportType;

  // stdio transport config
  command?: string; // e.g., "npx", "python", "/path/to/binary"
  args?: string[]; // e.g., ["-m", "mcp_server", "--port", "8080"]
  env?: Record<string, string>; // Environment variables
  cwd?: string; // Working directory

  // HTTP-based transport config (SSE/WebSocket)
  url?: string; // e.g., "http://localhost:8080/mcp"
  headers?: Record<string, string>; // Custom headers

  // Authentication
  auth?: MCPAuthConfig;

  // Timeouts (in ms)
  connectionTimeout?: number; // Default: 30000
  requestTimeout?: number; // Default: 60000

  // Metadata
  version?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;

  // State tracking
  installedAt?: number;
  lastConnectedAt?: number;
  lastError?: string;

  // Cached tools (populated after connection)
  tools?: MCPTool[];
}

// MCP Tool Definition (follows MCP spec)
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, MCPToolProperty>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

// Tool property schema
export interface MCPToolProperty {
  type: string;
  description?: string;
  enum?: string[];
  default?: Any;
  items?: MCPToolProperty; // For array types
  properties?: Record<string, MCPToolProperty>; // For nested objects
  required?: string[];
}

// MCP Resource (for servers that provide resources)
export interface MCPResource {
  uri: string;
  name: string;
  description?: string;
  mimeType?: string;
}

// MCP Prompt (for servers that provide prompts)
export interface MCPPrompt {
  name: string;
  description?: string;
  arguments?: Array<{
    name: string;
    description?: string;
    required?: boolean;
  }>;
}

// MCP Server Capabilities
export interface MCPServerCapabilities {
  tools?: {
    listChanged?: boolean;
  };
  resources?: {
    subscribe?: boolean;
    listChanged?: boolean;
  };
  prompts?: {
    listChanged?: boolean;
  };
  logging?: Record<string, never>;
}

// MCP Server Info (returned by initialize)
export interface MCPServerInfo {
  name: string;
  version: string;
  protocolVersion?: string;
  capabilities?: MCPServerCapabilities;
}

// Tool call result content types
export interface MCPTextContent {
  type: "text";
  text: string;
}

export interface MCPImageContent {
  type: "image";
  data: string; // Base64 encoded
  mimeType: string;
}

export interface MCPResourceContent {
  type: "resource";
  resource: {
    uri: string;
    text?: string;
    blob?: string; // Base64 encoded
    mimeType?: string;
  };
}

export type MCPContent = MCPTextContent | MCPImageContent | MCPResourceContent;

// Tool call result
export interface MCPCallResult {
  content: MCPContent[];
  isError?: boolean;
}

// Server status for UI
export interface MCPServerStatus {
  id: string;
  name: string;
  status: MCPConnectionStatus;
  error?: string;
  tools: MCPTool[];
  resources?: MCPResource[];
  prompts?: MCPPrompt[];
  serverInfo?: MCPServerInfo;
  lastPing?: number;
  uptime?: number; // Time since connected (ms)
}

// MCP Settings
export interface MCPSettings {
  // Server configurations
  servers: MCPServerConfig[];

  // Client settings
  autoConnect: boolean; // Auto-connect enabled servers on startup
  toolNamePrefix: string; // Prefix for MCP tools (default: "mcp_")
  maxReconnectAttempts: number; // Max reconnection attempts (default: 5)
  reconnectDelayMs: number; // Initial reconnect delay (default: 1000)

  // Registry settings
  registryEnabled: boolean;
  registryUrl: string; // Default MCP registry URL

  // Host settings
  hostEnabled: boolean;
  hostPort?: number; // For HTTP-based host
}

// Default settings
export const DEFAULT_MCP_SETTINGS: MCPSettings = {
  servers: [],
  autoConnect: true,
  toolNamePrefix: "mcp_",
  maxReconnectAttempts: 5,
  reconnectDelayMs: 1000,
  registryEnabled: true,
  registryUrl: "https://registry.modelcontextprotocol.io/servers.json",
  hostEnabled: false,
};

// JSON-RPC types for MCP protocol
export interface JSONRPCRequest {
  jsonrpc: "2.0";
  id: string | number;
  method: string;
  params?: Record<string, Any>;
}

export interface JSONRPCResponse {
  jsonrpc: "2.0";
  id: string | number;
  result?: Any;
  error?: JSONRPCError;
}

export interface JSONRPCError {
  code: number;
  message: string;
  data?: Any;
}

export interface JSONRPCNotification {
  jsonrpc: "2.0";
  method: string;
  params?: Record<string, Any>;
}

// MCP Protocol Methods
export const MCP_METHODS = {
  // Lifecycle
  INITIALIZE: "initialize",
  INITIALIZED: "notifications/initialized",
  SHUTDOWN: "shutdown",

  // Tools
  TOOLS_LIST: "tools/list",
  TOOLS_CALL: "tools/call",

  // Resources
  RESOURCES_LIST: "resources/list",
  RESOURCES_READ: "resources/read",
  RESOURCES_SUBSCRIBE: "resources/subscribe",
  RESOURCES_UNSUBSCRIBE: "resources/unsubscribe",

  // Prompts
  PROMPTS_LIST: "prompts/list",
  PROMPTS_GET: "prompts/get",

  // Logging
  LOGGING_SET_LEVEL: "logging/setLevel",

  // Notifications
  TOOLS_LIST_CHANGED: "notifications/tools/list_changed",
  RESOURCES_LIST_CHANGED: "notifications/resources/list_changed",
  RESOURCES_UPDATED: "notifications/resources/updated",
  PROMPTS_LIST_CHANGED: "notifications/prompts/list_changed",
  CANCELLED: "notifications/cancelled",
  PROGRESS: "notifications/progress",
  MESSAGE: "notifications/message",
} as const;

// MCP Error Codes
export const MCP_ERROR_CODES = {
  PARSE_ERROR: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL_ERROR: -32603,
  SERVER_ERROR: -32000,
  SERVER_NOT_INITIALIZED: -32002,
  UNKNOWN_ERROR: -32001,
} as const;

// Transport interface for different connection types
export interface MCPTransport {
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(message: JSONRPCRequest | JSONRPCNotification): Promise<void>;
  sendRequest(method: string, params?: Record<string, Any>): Promise<Any>;
  onMessage(handler: (message: JSONRPCResponse | JSONRPCNotification) => void): void;
  onClose(handler: (error?: Error) => void): void;
  onError(handler: (error: Error) => void): void;
  isConnected(): boolean;
}

// Events emitted by MCP client manager
export type MCPClientEvent =
  | { type: "server_connected"; serverId: string; serverInfo: MCPServerInfo }
  | { type: "server_disconnected"; serverId: string; error?: string }
  | { type: "server_error"; serverId: string; error: string }
  | { type: "server_reconnecting"; serverId: string; attempt: number }
  | { type: "tools_changed"; serverId: string; tools: MCPTool[] }
  | { type: "resources_changed"; serverId: string; resources: MCPResource[] }
  | { type: "prompts_changed"; serverId: string; prompts: MCPPrompt[] };

// ==================== MCP Registry Types ====================

// Installation method for MCP servers
export type MCPInstallMethod = "npm" | "pip" | "binary" | "docker" | "manual";

// Registry entry for an MCP server
export interface MCPRegistryEntry {
  id: string; // Unique identifier
  name: string;
  description: string;
  version: string;
  author: string;
  homepage?: string;
  repository?: string;
  license?: string;

  // Installation
  installMethod: MCPInstallMethod;
  installCommand?: string; // e.g., "npx -y @modelcontextprotocol/server-filesystem"
  packageName?: string; // e.g., "@modelcontextprotocol/server-filesystem"

  // Default configuration
  transport: MCPTransportType;
  defaultCommand?: string;
  defaultArgs?: string[];
  defaultEnv?: Record<string, string>;

  // Tool information
  tools: Array<{
    name: string;
    description: string;
  }>;

  // Categorization
  tags: string[];
  category?: string;

  // Trust indicators
  verified: boolean; // Verified by MCP maintainers
  featured?: boolean; // Featured in registry
  downloads?: number; // Download count

  // Timestamps
  createdAt?: string;
  updatedAt?: string;
}

// Full registry response
export interface MCPRegistry {
  version: string;
  lastUpdated: string;
  servers: MCPRegistryEntry[];
}

// Registry search options
export interface MCPRegistrySearchOptions {
  query?: string;
  tags?: string[];
  category?: string;
  verified?: boolean;
  limit?: number;
  offset?: number;
}

// Update information for installed servers
export interface MCPUpdateInfo {
  serverId: string;
  currentVersion: string;
  latestVersion: string;
  registryEntry: MCPRegistryEntry;
}
