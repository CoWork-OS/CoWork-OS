/**
 * Extension System Types
 *
 * Defines the plugin manifest schema and interfaces for the CoWork extension system.
 * Extensions are loaded from cowork.plugin.json files and can provide:
 * - Channel adapters (messaging platforms)
 * - Tools (agent capabilities)
 * - Providers (LLM, search, etc.)
 */

import { ChannelAdapter, ChannelConfig } from "../gateway/channels/types";

/**
 * Plugin manifest schema (cowork.plugin.json)
 */
export interface PluginManifest {
  /** Unique plugin identifier (e.g., "signal", "matrix") */
  name: string;

  /** Human-readable display name */
  displayName: string;

  /** Plugin version (semver) */
  version: string;

  /** Brief description of the plugin */
  description: string;

  /** Plugin author */
  author?: string;

  /** License identifier */
  license?: string;

  /** Plugin homepage/repository URL */
  homepage?: string;

  /** Minimum CoWork version required */
  coworkVersion?: string;

  /** Plugin type */
  type: PluginType;

  /** Entry point file (relative to plugin directory). Optional for declarative-only plugins. */
  main?: string;

  /** Configuration schema for the plugin */
  configSchema?: PluginConfigSchema;

  /** Required dependencies (npm packages) */
  dependencies?: Record<string, string>;

  /** Optional peer dependencies */
  peerDependencies?: Record<string, string>;

  /** Plugin capabilities/features */
  capabilities?: PluginCapabilities;

  /** Platform requirements */
  platform?: {
    /** Supported platforms (darwin, linux, win32) */
    os?: string[];
    /** Minimum Node.js version */
    node?: string;
  };

  /** Keywords for discovery */
  keywords?: string[];

  /** Inline skill definitions (declarative, no code required) */
  skills?: import("../../shared/types").CustomSkill[];

  /** Slash command definitions mapping to skill IDs */
  slashCommands?: SlashCommandDefinition[];

  /** Agent role definitions for sub-agents */
  agentRoles?: AgentRoleDefinition[];

  /** Declarative connector/tool definitions (JSON-based, no code required) */
  connectors?: DeclarativeConnector[];
}

/**
 * Agent role definition within a plugin manifest
 */
export interface AgentRoleDefinition {
  /** Unique role name (e.g., "sales-agent") */
  name: string;
  /** Human-readable display name */
  displayName: string;
  /** Role description */
  description?: string;
  /** Role icon (emoji) */
  icon: string;
  /** Role color (hex) */
  color: string;
  /** Agent capabilities */
  capabilities?: string[];
  /** Additional system prompt for the role */
  systemPrompt?: string;
}

/**
 * Plugin types
 */
export type PluginType = "channel" | "tool" | "provider" | "integration" | "pack";

/**
 * Plugin configuration schema
 */
export interface PluginConfigSchema {
  /** Schema type (always "object") */
  type: "object";

  /** Configuration properties */
  properties: Record<string, PluginConfigProperty>;

  /** Required properties */
  required?: string[];
}

/**
 * Configuration property definition
 */
export interface PluginConfigProperty {
  /** Property type */
  type: "string" | "number" | "boolean" | "array" | "object";

  /** Human-readable description */
  description: string;

  /** Default value */
  default?: unknown;

  /** Whether this is a secret (will be encrypted) */
  secret?: boolean;

  /** Enum values for string type */
  enum?: string[];

  /** Array item type */
  items?: { type: string };

  /** Minimum value for numbers */
  minimum?: number;

  /** Maximum value for numbers */
  maximum?: number;

  /** Pattern for string validation */
  pattern?: string;
}

/**
 * Plugin capabilities
 */
export interface PluginCapabilities {
  /** Supports sending messages */
  sendMessage?: boolean;

  /** Supports receiving messages */
  receiveMessage?: boolean;

  /** Supports file attachments */
  attachments?: boolean;

  /** Supports reactions */
  reactions?: boolean;

  /** Supports inline keyboards/buttons */
  inlineKeyboards?: boolean;

  /** Supports reply keyboards */
  replyKeyboards?: boolean;

  /** Supports polls */
  polls?: boolean;

  /** Supports voice messages */
  voice?: boolean;

  /** Supports video messages */
  video?: boolean;

  /** Supports location sharing */
  location?: boolean;

  /** Supports contact sharing */
  contacts?: boolean;

  /** Supports message editing */
  editMessage?: boolean;

  /** Supports message deletion */
  deleteMessage?: boolean;

  /** Supports typing indicators */
  typing?: boolean;

  /** Supports read receipts */
  readReceipts?: boolean;

  /** Supports group chats */
  groups?: boolean;

  /** Supports threads/forums */
  threads?: boolean;

  /** Supports webhooks */
  webhooks?: boolean;

  /** Supports end-to-end encryption */
  e2eEncryption?: boolean;
}

/**
 * Plugin API provided to plugins during registration
 */
export interface PluginAPI {
  /** CoWork runtime environment */
  runtime: PluginRuntime;

  /** Register a channel adapter */
  registerChannel(options: RegisterChannelOptions): void;

  /** Register a tool */
  registerTool(options: RegisterToolOptions): void;

  /** Get plugin configuration */
  getConfig<T = Record<string, unknown>>(): T;

  /** Update plugin configuration */
  setConfig(config: Record<string, unknown>): Promise<void>;

  /** Get secure storage for secrets */
  getSecureStorage(): SecureStorage;

  /** Log a message */
  log(level: "debug" | "info" | "warn" | "error", message: string, ...args: unknown[]): void;

  /** Emit a plugin event */
  emit(event: string, data?: unknown): void;

  /** Listen to plugin events */
  on(event: string, handler: (data: unknown) => void): void;

  /** Remove event listener */
  off(event: string, handler: (data: unknown) => void): void;
}

/**
 * Plugin runtime environment
 */
export interface PluginRuntime {
  /** CoWork version */
  version: string;

  /** Platform (darwin, linux, win32) */
  platform: NodeJS.Platform;

  /** App data directory */
  appDataPath: string;

  /** Plugin data directory */
  pluginDataPath: string;

  /** Is development mode */
  isDev: boolean;
}

/**
 * Options for registering a channel
 */
export interface RegisterChannelOptions {
  /** Channel adapter factory */
  createAdapter(config: ChannelConfig): ChannelAdapter;

  /** Configuration schema */
  configSchema?: PluginConfigSchema;

  /** Default configuration */
  defaultConfig?: ChannelConfig;
}

/**
 * Options for registering a tool
 */
export interface RegisterToolOptions {
  /** Tool name */
  name: string;

  /** Tool description */
  description: string;

  /** Tool input schema */
  inputSchema: Record<string, unknown>;

  /** Tool handler */
  handler(input: Record<string, unknown>): Promise<unknown>;
}

/**
 * Declarative connector definition (JSON-only, no code required).
 * Allows tools to be defined as JSON within plugin manifests.
 */
export interface DeclarativeConnector {
  /** Connector name (used as the tool name) */
  name: string;

  /** Human-readable description */
  description: string;

  /** JSON Schema for input parameters */
  inputSchema: Record<string, unknown>;

  /** Connector type */
  type: "http" | "shell" | "script";

  /** HTTP connector configuration */
  http?: {
    /** URL template with {{param}} placeholders */
    url: string;
    /** HTTP method */
    method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
    /** Headers with optional {{param}} placeholders */
    headers?: Record<string, string>;
    /** Body template (JSON string with {{param}} placeholders) */
    body?: string;
    /** Response format */
    responseFormat?: "json" | "text";
  };

  /** Shell connector configuration */
  shell?: {
    /** Command template with {{param}} placeholders */
    command: string;
    /** Working directory */
    cwd?: string;
    /** Timeout in milliseconds */
    timeout?: number;
  };

  /** Script connector configuration */
  script?: {
    /** JavaScript function body (receives `input` as parameter) */
    body: string;
    /** Timeout in milliseconds */
    timeout?: number;
  };
}

/**
 * Slash command definition mapping a command name to a skill ID
 */
export interface SlashCommandDefinition {
  /** Command name (without the leading /) */
  name: string;
  /** Description shown in the autocomplete dropdown */
  description: string;
  /** Reference to a skill ID (must exist in skills array or skill loader) */
  skillId: string;
}

/**
 * Secure storage interface for secrets
 */
export interface SecureStorage {
  /** Get a secret value */
  get(key: string): Promise<string | null>;

  /** Set a secret value */
  set(key: string, value: string): Promise<void>;

  /** Delete a secret value */
  delete(key: string): Promise<void>;

  /** Check if a secret exists */
  has(key: string): Promise<boolean>;
}

/**
 * Plugin instance interface
 */
export interface Plugin {
  /** Plugin manifest */
  manifest: PluginManifest;

  /** Register the plugin with the API */
  register(api: PluginAPI): Promise<void>;

  /** Unregister/cleanup the plugin */
  unregister?(): Promise<void>;
}

/**
 * Loaded plugin state
 */
export interface LoadedPlugin {
  /** Plugin manifest */
  manifest: PluginManifest;

  /** Plugin instance */
  instance: Plugin;

  /** Plugin directory path */
  path: string;

  /** Plugin state */
  state: PluginState;

  /** Error if state is 'error' */
  error?: Error;

  /** Loaded timestamp */
  loadedAt: Date;
}

/**
 * Plugin states
 */
export type PluginState = "loading" | "loaded" | "registered" | "active" | "error" | "disabled";

/**
 * Plugin load result
 */
export interface PluginLoadResult {
  /** Whether loading succeeded */
  success: boolean;

  /** Loaded plugin (if success) */
  plugin?: LoadedPlugin;

  /** Error (if failed) */
  error?: Error;
}

/**
 * Plugin discovery result
 */
export interface PluginDiscoveryResult {
  /** Plugin directory path */
  path: string;

  /** Plugin manifest */
  manifest: PluginManifest;
}

/**
 * Plugin event types
 */
export type PluginEventType =
  | "plugin:loaded"
  | "plugin:registered"
  | "plugin:unregistered"
  | "plugin:error"
  | "plugin:config-changed";

/**
 * Plugin event
 */
export interface PluginEvent {
  type: PluginEventType;
  pluginName: string;
  timestamp: Date;
  data?: unknown;
}
