// Core types shared between main and renderer processes

// Theme and Appearance types
export type ThemeMode = 'light' | 'dark' | 'system';
export type AccentColor = 'cyan' | 'blue' | 'purple' | 'pink' | 'rose' | 'orange' | 'green' | 'teal';

export interface AppearanceSettings {
  themeMode: ThemeMode;
  accentColor: AccentColor;
  disclaimerAccepted?: boolean;
}

// Tray (Menu Bar) Settings
export interface TraySettings {
  enabled: boolean;
  showDockIcon: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  showNotifications: boolean;
}

export const ACCENT_COLORS: { id: AccentColor; label: string }[] = [
  { id: 'cyan', label: 'Cyan' },
  { id: 'blue', label: 'Blue' },
  { id: 'purple', label: 'Purple' },
  { id: 'pink', label: 'Pink' },
  { id: 'rose', label: 'Rose' },
  { id: 'orange', label: 'Orange' },
  { id: 'green', label: 'Green' },
  { id: 'teal', label: 'Teal' },
];

export type TaskStatus = 'pending' | 'queued' | 'planning' | 'executing' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type EventType =
  | 'task_created'
  | 'task_completed'
  | 'plan_created'
  | 'plan_revised'
  | 'step_started'
  | 'step_completed'
  | 'step_failed'
  | 'executing'
  | 'tool_call'
  | 'tool_result'
  | 'tool_error'
  | 'assistant_message'
  | 'approval_requested'
  | 'approval_granted'
  | 'approval_denied'
  | 'file_created'
  | 'file_modified'
  | 'file_deleted'
  | 'image_generated'
  | 'error'
  | 'log'
  | 'verification_started'
  | 'verification_passed'
  | 'verification_failed'
  | 'retry_started'
  | 'task_cancelled'
  | 'task_queued'
  | 'task_dequeued'
  | 'queue_updated'
  | 'plan_revision_blocked'
  | 'step_timeout'
  | 'tool_blocked'
  | 'progress_update'
  | 'llm_retry'
  | 'follow_up_completed'
  | 'follow_up_failed'
  | 'tool_warning'
  | 'user_message'
  | 'command_output'
  // Sub-Agent / Parallel Agent events
  | 'agent_spawned'        // Parent spawned a child agent
  | 'agent_completed'      // Child agent completed successfully
  | 'agent_failed'         // Child agent failed
  | 'sub_agent_result';    // Result summary from child agent

export type ToolType =
  | 'read_file'
  | 'write_file'
  | 'copy_file'
  | 'list_directory'
  | 'rename_file'
  | 'move_file'
  | 'delete_file'
  | 'create_directory'
  | 'search_files'
  | 'run_skill'
  | 'run_command'
  | 'generate_image'
  // System tools
  | 'system_info'
  | 'read_clipboard'
  | 'write_clipboard'
  | 'take_screenshot'
  | 'open_application'
  | 'open_url'
  | 'open_path'
  | 'show_in_folder'
  | 'get_env'
  | 'get_app_paths'
  // Network/Browser tools
  | 'web_search'
  | 'browser_navigate'
  | 'browser_screenshot'
  | 'browser_get_content'
  | 'browser_click'
  | 'browser_fill'
  | 'browser_type'
  | 'browser_press'
  | 'browser_wait'
  | 'browser_scroll'
  | 'browser_select'
  | 'browser_get_text'
  | 'browser_evaluate'
  | 'browser_back'
  | 'browser_forward'
  | 'browser_reload'
  | 'browser_save_pdf'
  | 'browser_close'
  // Meta tools
  | 'revise_plan';

export type ApprovalType =
  | 'delete_file'
  | 'delete_multiple'
  | 'bulk_rename'
  | 'network_access'
  | 'external_service'
  | 'run_command';

// ============ Security Tool Groups & Risk Levels ============

/**
 * Tool risk levels for security policy enforcement
 * Higher levels require more permissions/approval
 */
export type ToolRiskLevel = 'read' | 'write' | 'destructive' | 'system' | 'network';

/**
 * Tool groups for policy-based access control
 */
export const TOOL_GROUPS = {
  // Read-only operations - lowest risk
  'group:read': [
    'read_file',
    'list_directory',
    'search_files',
    'system_info',
    'get_env',
    'get_app_paths',
  ],
  // Write operations - medium risk
  'group:write': [
    'write_file',
    'copy_file',
    'rename_file',
    'create_directory',
    'create_spreadsheet',
    'create_document',
    'edit_document',
    'create_presentation',
    'organize_folder',
  ],
  // Destructive operations - high risk, requires approval
  'group:destructive': [
    'delete_file',
    'run_command',
  ],
  // System operations - requires explicit permission
  'group:system': [
    'read_clipboard',
    'write_clipboard',
    'take_screenshot',
    'open_application',
    'open_url',
    'open_path',
    'show_in_folder',
  ],
  // Network operations - requires network permission
  'group:network': [
    'web_search',
    'browser_navigate',
    'browser_screenshot',
    'browser_get_content',
    'browser_click',
    'browser_fill',
    'browser_type',
    'browser_press',
    'browser_wait',
    'browser_scroll',
    'browser_select',
    'browser_get_text',
    'browser_evaluate',
    'browser_back',
    'browser_forward',
    'browser_reload',
    'browser_save_pdf',
    'browser_close',
  ],
  // Memory/sensitive tools - restricted in shared contexts
  'group:memory': [
    'read_clipboard',
    'write_clipboard',
  ],
  // Image generation - requires API access
  'group:image': [
    'generate_image',
  ],
  // Meta/control tools
  'group:meta': [
    'revise_plan',
  ],
} as const;

export type ToolGroupName = keyof typeof TOOL_GROUPS;

/**
 * Maps each tool to its risk level
 */
export const TOOL_RISK_LEVELS: Record<ToolType, ToolRiskLevel> = {
  // Read operations
  read_file: 'read',
  list_directory: 'read',
  search_files: 'read',
  system_info: 'read',
  get_env: 'read',
  get_app_paths: 'read',
  // Write operations
  write_file: 'write',
  copy_file: 'write',
  rename_file: 'write',
  move_file: 'write',
  create_directory: 'write',
  run_skill: 'write',
  // Destructive operations
  delete_file: 'destructive',
  run_command: 'destructive',
  // System operations
  read_clipboard: 'system',
  write_clipboard: 'system',
  take_screenshot: 'system',
  open_application: 'system',
  open_url: 'system',
  open_path: 'system',
  show_in_folder: 'system',
  // Network operations
  generate_image: 'network',
  web_search: 'network',
  browser_navigate: 'network',
  browser_screenshot: 'network',
  browser_get_content: 'network',
  browser_click: 'network',
  browser_fill: 'network',
  browser_type: 'network',
  browser_press: 'network',
  browser_wait: 'network',
  browser_scroll: 'network',
  browser_select: 'network',
  browser_get_text: 'network',
  browser_evaluate: 'network',
  browser_back: 'network',
  browser_forward: 'network',
  browser_reload: 'network',
  browser_save_pdf: 'network',
  browser_close: 'network',
  // Meta
  revise_plan: 'read',
};

/**
 * Gateway context types for context-aware tool restrictions
 */
export type GatewayContextType = 'private' | 'group' | 'public';

/**
 * Tool restrictions based on gateway context
 * Implements C1: Memory Tool Isolation in Shared Contexts
 */
export const CONTEXT_TOOL_RESTRICTIONS: Record<GatewayContextType, {
  deniedGroups: ToolGroupName[];
  deniedTools: string[];
  requireApprovalFor: string[];
}> = {
  private: {
    deniedGroups: [],
    deniedTools: [],
    requireApprovalFor: ['delete_file'],
  },
  group: {
    deniedGroups: ['group:memory'],
    deniedTools: ['read_clipboard', 'write_clipboard'],
    requireApprovalFor: ['delete_file'],
  },
  public: {
    deniedGroups: ['group:memory'],
    deniedTools: ['read_clipboard', 'write_clipboard'],
    requireApprovalFor: ['delete_file'],
  },
};

// Success Criteria for Goal Mode
export type SuccessCriteriaType = 'shell_command' | 'file_exists';

export interface SuccessCriteria {
  type: SuccessCriteriaType;
  command?: string;      // For shell_command: command to run (exit 0 = success)
  filePaths?: string[];  // For file_exists: paths that must exist
}

// ============ Sub-Agent / Parallel Agent Types ============

/**
 * Agent type determines the behavior and lifecycle of a task
 * - 'main': Primary user-created task (default)
 * - 'sub': Disposable agent spawned for batch work (no memory retention)
 * - 'parallel': Independent agent that can run alongside main agents
 */
export type AgentType = 'main' | 'sub' | 'parallel';

/**
 * Per-task agent configuration for customizing LLM and personality
 * Allows spawning agents with different models/personalities than the global settings
 */
export interface AgentConfig {
  /** Override the LLM provider type (e.g., 'anthropic', 'gemini') */
  providerType?: LLMProviderType;
  /** Override the model key (e.g., 'opus-4-5', 'sonnet-4-5', 'haiku-4-5') */
  modelKey?: string;
  /** Override the personality for this agent */
  personalityId?: PersonalityId;
  /** Maximum number of LLM turns before forcing completion (for sub-agents) */
  maxTurns?: number;
  /** Maximum tokens budget for this agent */
  maxTokens?: number;
  /** Whether to retain memory/context after completion (default: false for sub-agents) */
  retainMemory?: boolean;
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  status: TaskStatus;
  workspaceId: string;
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  budgetTokens?: number;
  budgetCost?: number;
  error?: string;
  // Goal Mode fields
  successCriteria?: SuccessCriteria;
  maxAttempts?: number;        // Default: 3, max: 10
  currentAttempt?: number;     // Tracks which attempt we're on
  // Sub-Agent / Parallel Agent fields
  parentTaskId?: string;       // ID of the parent task that spawned this one
  agentType?: AgentType;       // Type of agent: 'main', 'sub', or 'parallel'
  agentConfig?: AgentConfig;   // Per-task agent configuration (model, personality, etc.)
  depth?: number;              // Nesting depth (0 = root, 1 = first child, etc.)
  resultSummary?: string;      // Summary of results for parent agent to consume
}

export interface TaskEvent {
  id: string;
  taskId: string;
  timestamp: number;
  type: EventType;
  payload: any;
}

export interface Artifact {
  id: string;
  taskId: string;
  path: string;
  mimeType: string;
  sha256: string;
  size: number;
  createdAt: number;
}

export interface Workspace {
  id: string;
  name: string;
  path: string;
  createdAt: number;
  permissions: WorkspacePermissions;
  isTemp?: boolean;  // True for the auto-created temp workspace
}

// Temp workspace constants
export const TEMP_WORKSPACE_ID = '__temp_workspace__';
export const TEMP_WORKSPACE_NAME = 'Temporary Workspace';

export interface WorkspacePermissions {
  read: boolean;
  write: boolean;
  delete: boolean;
  network: boolean;
  shell: boolean;
  allowedDomains?: string[];
  // Broader filesystem access (like Claude Code)
  unrestrictedFileAccess?: boolean;  // Allow reading/writing files outside workspace
  allowedPaths?: string[];           // Specific paths outside workspace to allow (if not fully unrestricted)
}

export interface PlanStep {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  startedAt?: number;
  completedAt?: number;
  error?: string;
}

export interface Plan {
  steps: PlanStep[];
  description: string;
}

export interface ToolCall {
  id: string;
  tool: ToolType;
  parameters: any;
  timestamp: number;
}

export interface ToolResult {
  callId: string;
  success: boolean;
  result?: any;
  error?: string;
  timestamp: number;
}

export interface ApprovalRequest {
  id: string;
  taskId: string;
  type: ApprovalType;
  description: string;
  details: any;
  status: 'pending' | 'approved' | 'denied';
  requestedAt: number;
  resolvedAt?: number;
}

export interface Skill {
  id: string;
  name: string;
  description: string;
  category: 'document' | 'spreadsheet' | 'presentation' | 'organizer' | 'custom';
  prompt: string;
  scriptPath?: string;
  parameters?: Record<string, any>;
}

// IPC Channel names
export const IPC_CHANNELS = {
  // Task operations
  TASK_CREATE: 'task:create',
  TASK_GET: 'task:get',
  TASK_LIST: 'task:list',
  TASK_CANCEL: 'task:cancel',
  TASK_PAUSE: 'task:pause',
  TASK_RESUME: 'task:resume',
  TASK_RENAME: 'task:rename',
  TASK_DELETE: 'task:delete',

  // Sub-Agent / Parallel Agent operations
  AGENT_GET_CHILDREN: 'agent:getChildren',    // Get child tasks for a parent
  AGENT_GET_STATUS: 'agent:getStatus',        // Get status of spawned agents

  // Task events (streaming and history)
  TASK_EVENT: 'task:event',
  TASK_EVENTS: 'task:events',
  TASK_SEND_MESSAGE: 'task:sendMessage',
  TASK_SEND_STDIN: 'task:sendStdin',  // Send stdin input to running command
  TASK_KILL_COMMAND: 'task:killCommand',  // Kill running command (Ctrl+C)

  // Workspace operations
  WORKSPACE_SELECT: 'workspace:select',
  WORKSPACE_LIST: 'workspace:list',
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_UPDATE_PERMISSIONS: 'workspace:updatePermissions',
  WORKSPACE_GET_TEMP: 'workspace:getTemp',  // Get or create temp workspace

  // Approval operations
  APPROVAL_RESPOND: 'approval:respond',

  // Artifact operations
  ARTIFACT_LIST: 'artifact:list',
  ARTIFACT_PREVIEW: 'artifact:preview',

  // Skills
  SKILL_LIST: 'skill:list',
  SKILL_GET: 'skill:get',

  // Custom User Skills
  CUSTOM_SKILL_LIST: 'customSkill:list',
  CUSTOM_SKILL_LIST_TASKS: 'customSkill:listTasks',  // List only task skills (for dropdown)
  CUSTOM_SKILL_LIST_GUIDELINES: 'customSkill:listGuidelines',  // List only guideline skills (for settings)
  CUSTOM_SKILL_GET: 'customSkill:get',
  CUSTOM_SKILL_CREATE: 'customSkill:create',
  CUSTOM_SKILL_UPDATE: 'customSkill:update',
  CUSTOM_SKILL_DELETE: 'customSkill:delete',
  CUSTOM_SKILL_RELOAD: 'customSkill:reload',
  CUSTOM_SKILL_OPEN_FOLDER: 'customSkill:openFolder',

  // Skill Registry (SkillHub)
  SKILL_REGISTRY_SEARCH: 'skillRegistry:search',
  SKILL_REGISTRY_GET_DETAILS: 'skillRegistry:getDetails',
  SKILL_REGISTRY_INSTALL: 'skillRegistry:install',
  SKILL_REGISTRY_UPDATE: 'skillRegistry:update',
  SKILL_REGISTRY_UPDATE_ALL: 'skillRegistry:updateAll',
  SKILL_REGISTRY_UNINSTALL: 'skillRegistry:uninstall',
  SKILL_REGISTRY_LIST_MANAGED: 'skillRegistry:listManaged',
  SKILL_REGISTRY_CHECK_UPDATES: 'skillRegistry:checkUpdates',
  SKILL_REGISTRY_GET_STATUS: 'skillRegistry:getStatus',
  SKILL_REGISTRY_GET_ELIGIBLE: 'skillRegistry:getEligible',

  // LLM Settings
  LLM_GET_SETTINGS: 'llm:getSettings',
  LLM_SAVE_SETTINGS: 'llm:saveSettings',
  LLM_TEST_PROVIDER: 'llm:testProvider',
  LLM_GET_MODELS: 'llm:getModels',
  LLM_GET_CONFIG_STATUS: 'llm:getConfigStatus',
  LLM_GET_OLLAMA_MODELS: 'llm:getOllamaModels',
  LLM_GET_GEMINI_MODELS: 'llm:getGeminiModels',
  LLM_GET_OPENROUTER_MODELS: 'llm:getOpenRouterModels',
  LLM_GET_OPENAI_MODELS: 'llm:getOpenAIModels',
  LLM_OPENAI_OAUTH_START: 'llm:openaiOAuthStart',
  LLM_OPENAI_OAUTH_LOGOUT: 'llm:openaiOAuthLogout',
  LLM_GET_BEDROCK_MODELS: 'llm:getBedrockModels',

  // Gateway / Channels
  GATEWAY_GET_CHANNELS: 'gateway:getChannels',
  GATEWAY_ADD_CHANNEL: 'gateway:addChannel',
  GATEWAY_UPDATE_CHANNEL: 'gateway:updateChannel',
  GATEWAY_REMOVE_CHANNEL: 'gateway:removeChannel',
  GATEWAY_ENABLE_CHANNEL: 'gateway:enableChannel',
  GATEWAY_DISABLE_CHANNEL: 'gateway:disableChannel',
  GATEWAY_TEST_CHANNEL: 'gateway:testChannel',
  GATEWAY_GET_USERS: 'gateway:getUsers',
  GATEWAY_GRANT_ACCESS: 'gateway:grantAccess',
  GATEWAY_REVOKE_ACCESS: 'gateway:revokeAccess',
  GATEWAY_GENERATE_PAIRING: 'gateway:generatePairing',

  // Search Settings
  SEARCH_GET_SETTINGS: 'search:getSettings',
  SEARCH_SAVE_SETTINGS: 'search:saveSettings',
  SEARCH_GET_CONFIG_STATUS: 'search:getConfigStatus',
  SEARCH_TEST_PROVIDER: 'search:testProvider',

  // App Updates
  APP_CHECK_UPDATES: 'app:checkUpdates',
  APP_DOWNLOAD_UPDATE: 'app:downloadUpdate',
  APP_INSTALL_UPDATE: 'app:installUpdate',
  APP_GET_VERSION: 'app:getVersion',
  APP_UPDATE_AVAILABLE: 'app:updateAvailable',
  APP_UPDATE_PROGRESS: 'app:updateProgress',
  APP_UPDATE_DOWNLOADED: 'app:updateDownloaded',
  APP_UPDATE_ERROR: 'app:updateError',

  // Guardrails
  GUARDRAIL_GET_SETTINGS: 'guardrail:getSettings',
  GUARDRAIL_SAVE_SETTINGS: 'guardrail:saveSettings',
  GUARDRAIL_GET_DEFAULTS: 'guardrail:getDefaults',

  // Appearance
  APPEARANCE_GET_SETTINGS: 'appearance:getSettings',
  APPEARANCE_SAVE_SETTINGS: 'appearance:saveSettings',

  // Agent Personality
  PERSONALITY_GET_SETTINGS: 'personality:getSettings',
  PERSONALITY_SAVE_SETTINGS: 'personality:saveSettings',
  PERSONALITY_GET_DEFINITIONS: 'personality:getDefinitions',
  PERSONALITY_GET_PERSONAS: 'personality:getPersonas',
  PERSONALITY_GET_RELATIONSHIP_STATS: 'personality:getRelationshipStats',
  PERSONALITY_SET_ACTIVE: 'personality:setActive',
  PERSONALITY_SET_PERSONA: 'personality:setPersona',
  PERSONALITY_RESET: 'personality:reset',
  PERSONALITY_SETTINGS_CHANGED: 'personality:settingsChanged', // Event sent to UI when settings change

  // Task Queue
  QUEUE_GET_STATUS: 'queue:getStatus',
  QUEUE_GET_SETTINGS: 'queue:getSettings',
  QUEUE_SAVE_SETTINGS: 'queue:saveSettings',
  QUEUE_CLEAR: 'queue:clear',
  QUEUE_UPDATE: 'queue:update',

  // MCP (Model Context Protocol)
  MCP_GET_SETTINGS: 'mcp:getSettings',
  MCP_SAVE_SETTINGS: 'mcp:saveSettings',
  MCP_GET_SERVERS: 'mcp:getServers',
  MCP_ADD_SERVER: 'mcp:addServer',
  MCP_UPDATE_SERVER: 'mcp:updateServer',
  MCP_REMOVE_SERVER: 'mcp:removeServer',
  MCP_CONNECT_SERVER: 'mcp:connectServer',
  MCP_DISCONNECT_SERVER: 'mcp:disconnectServer',
  MCP_GET_STATUS: 'mcp:getStatus',
  MCP_GET_SERVER_TOOLS: 'mcp:getServerTools',
  MCP_TEST_SERVER: 'mcp:testServer',

  // MCP Registry
  MCP_REGISTRY_FETCH: 'mcp:registryFetch',
  MCP_REGISTRY_SEARCH: 'mcp:registrySearch',
  MCP_REGISTRY_INSTALL: 'mcp:registryInstall',
  MCP_REGISTRY_UNINSTALL: 'mcp:registryUninstall',
  MCP_REGISTRY_CHECK_UPDATES: 'mcp:registryCheckUpdates',
  MCP_REGISTRY_UPDATE_SERVER: 'mcp:registryUpdateServer',

  // MCP Host
  MCP_HOST_START: 'mcp:hostStart',
  MCP_HOST_STOP: 'mcp:hostStop',
  MCP_HOST_GET_STATUS: 'mcp:hostGetStatus',

  // MCP Events
  MCP_SERVER_STATUS_CHANGE: 'mcp:serverStatusChange',

  // Built-in Tools Settings
  BUILTIN_TOOLS_GET_SETTINGS: 'builtinTools:getSettings',
  BUILTIN_TOOLS_SAVE_SETTINGS: 'builtinTools:saveSettings',
  BUILTIN_TOOLS_GET_CATEGORIES: 'builtinTools:getCategories',

  // Tray (Menu Bar)
  TRAY_GET_SETTINGS: 'tray:getSettings',
  TRAY_SAVE_SETTINGS: 'tray:saveSettings',
  TRAY_NEW_TASK: 'tray:newTask',
  TRAY_SELECT_WORKSPACE: 'tray:selectWorkspace',
  TRAY_OPEN_SETTINGS: 'tray:openSettings',
  TRAY_OPEN_ABOUT: 'tray:openAbout',
  TRAY_CHECK_UPDATES: 'tray:checkUpdates',

  // Cron (Scheduled Tasks)
  CRON_GET_STATUS: 'cron:getStatus',
  CRON_LIST_JOBS: 'cron:listJobs',
  CRON_GET_JOB: 'cron:getJob',
  CRON_ADD_JOB: 'cron:addJob',
  CRON_UPDATE_JOB: 'cron:updateJob',
  CRON_REMOVE_JOB: 'cron:removeJob',
  CRON_RUN_JOB: 'cron:runJob',
  CRON_EVENT: 'cron:event',

  // Notifications
  NOTIFICATION_LIST: 'notification:list',
  NOTIFICATION_ADD: 'notification:add',
  NOTIFICATION_MARK_READ: 'notification:markRead',
  NOTIFICATION_MARK_ALL_READ: 'notification:markAllRead',
  NOTIFICATION_DELETE: 'notification:delete',
  NOTIFICATION_DELETE_ALL: 'notification:deleteAll',
  NOTIFICATION_EVENT: 'notification:event',

  // Hooks (Webhooks & Gmail Pub/Sub)
  HOOKS_GET_SETTINGS: 'hooks:getSettings',
  HOOKS_SAVE_SETTINGS: 'hooks:saveSettings',
  HOOKS_ENABLE: 'hooks:enable',
  HOOKS_DISABLE: 'hooks:disable',
  HOOKS_REGENERATE_TOKEN: 'hooks:regenerateToken',
  HOOKS_GET_STATUS: 'hooks:getStatus',
  HOOKS_ADD_MAPPING: 'hooks:addMapping',
  HOOKS_REMOVE_MAPPING: 'hooks:removeMapping',
  HOOKS_CONFIGURE_GMAIL: 'hooks:configureGmail',
  HOOKS_GET_GMAIL_STATUS: 'hooks:getGmailStatus',
  HOOKS_START_GMAIL_WATCHER: 'hooks:startGmailWatcher',
  HOOKS_STOP_GMAIL_WATCHER: 'hooks:stopGmailWatcher',
  HOOKS_EVENT: 'hooks:event',

  // Control Plane (WebSocket Gateway)
  CONTROL_PLANE_GET_SETTINGS: 'controlPlane:getSettings',
  CONTROL_PLANE_SAVE_SETTINGS: 'controlPlane:saveSettings',
  CONTROL_PLANE_ENABLE: 'controlPlane:enable',
  CONTROL_PLANE_DISABLE: 'controlPlane:disable',
  CONTROL_PLANE_START: 'controlPlane:start',
  CONTROL_PLANE_STOP: 'controlPlane:stop',
  CONTROL_PLANE_GET_STATUS: 'controlPlane:getStatus',
  CONTROL_PLANE_REGENERATE_TOKEN: 'controlPlane:regenerateToken',
  CONTROL_PLANE_EVENT: 'controlPlane:event',

  // Tailscale Integration
  TAILSCALE_GET_STATUS: 'tailscale:getStatus',
  TAILSCALE_CHECK_AVAILABILITY: 'tailscale:checkAvailability',
  TAILSCALE_SET_MODE: 'tailscale:setMode',

  // Remote Gateway (connecting to external Control Plane)
  REMOTE_GATEWAY_CONNECT: 'remoteGateway:connect',
  REMOTE_GATEWAY_DISCONNECT: 'remoteGateway:disconnect',
  REMOTE_GATEWAY_GET_STATUS: 'remoteGateway:getStatus',
  REMOTE_GATEWAY_SAVE_CONFIG: 'remoteGateway:saveConfig',
  REMOTE_GATEWAY_TEST_CONNECTION: 'remoteGateway:testConnection',
  REMOTE_GATEWAY_EVENT: 'remoteGateway:event',

  // SSH Tunnel (for Remote Gateway connection)
  SSH_TUNNEL_CONNECT: 'sshTunnel:connect',
  SSH_TUNNEL_DISCONNECT: 'sshTunnel:disconnect',
  SSH_TUNNEL_GET_STATUS: 'sshTunnel:getStatus',
  SSH_TUNNEL_SAVE_CONFIG: 'sshTunnel:saveConfig',
  SSH_TUNNEL_TEST_CONNECTION: 'sshTunnel:testConnection',
  SSH_TUNNEL_EVENT: 'sshTunnel:event',

  // Live Canvas (Agent-driven visual workspace)
  CANVAS_CREATE: 'canvas:create',
  CANVAS_GET_SESSION: 'canvas:getSession',
  CANVAS_LIST_SESSIONS: 'canvas:listSessions',
  CANVAS_SHOW: 'canvas:show',
  CANVAS_HIDE: 'canvas:hide',
  CANVAS_CLOSE: 'canvas:close',
  CANVAS_PUSH: 'canvas:push',
  CANVAS_EVAL: 'canvas:eval',
  CANVAS_SNAPSHOT: 'canvas:snapshot',
  CANVAS_A2UI_ACTION: 'canvas:a2uiAction',
  CANVAS_EVENT: 'canvas:event',
  CANVAS_EXPORT_HTML: 'canvas:exportHTML',
  CANVAS_EXPORT_TO_FOLDER: 'canvas:exportToFolder',
  CANVAS_OPEN_IN_BROWSER: 'canvas:openInBrowser',
  CANVAS_GET_SESSION_DIR: 'canvas:getSessionDir',
} as const;

// LLM Provider types
export type LLMProviderType = 'anthropic' | 'bedrock' | 'ollama' | 'gemini' | 'openrouter' | 'openai';

export interface CachedModelInfo {
  key: string;
  displayName: string;
  description: string;
  contextLength?: number;  // For OpenRouter models
  size?: number;           // For Ollama models (in bytes)
}

export interface LLMSettingsData {
  providerType: LLMProviderType;
  modelKey: string;
  anthropic?: {
    apiKey?: string;
  };
  bedrock?: {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    sessionToken?: string;
    profile?: string;
    useDefaultCredentials?: boolean;
    model?: string;
  };
  ollama?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string; // Optional, for remote Ollama servers
  };
  gemini?: {
    apiKey?: string;
    model?: string;
  };
  openrouter?: {
    apiKey?: string;
    model?: string;
  };
  openai?: {
    apiKey?: string;
    model?: string;
    // OAuth tokens (alternative to API key)
    accessToken?: string;
    refreshToken?: string;
    tokenExpiresAt?: number;
    authMethod?: 'api_key' | 'oauth';
  };
  // Cached models from API (populated when user refreshes)
  cachedGeminiModels?: CachedModelInfo[];
  cachedOpenRouterModels?: CachedModelInfo[];
  cachedOllamaModels?: CachedModelInfo[];
  cachedBedrockModels?: CachedModelInfo[];
  cachedOpenAIModels?: CachedModelInfo[];
}

export interface LLMProviderInfo {
  type: LLMProviderType;
  name: string;
  configured: boolean;
}

export interface LLMModelInfo {
  key: string;
  displayName: string;
  description: string;
}

export interface LLMConfigStatus {
  currentProvider: LLMProviderType;
  currentModel: string;
  providers: LLMProviderInfo[];
  models: LLMModelInfo[];
}

// Gateway / Channel types
export type ChannelType = 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'imessage';
export type ChannelStatus = 'disconnected' | 'connecting' | 'connected' | 'error';
export type SecurityMode = 'open' | 'allowlist' | 'pairing';

export interface ChannelData {
  id: string;
  type: ChannelType;
  name: string;
  enabled: boolean;
  status: ChannelStatus;
  botUsername?: string;
  securityMode: SecurityMode;
  createdAt: number;
  config?: {
    selfChatMode?: boolean;
    responsePrefix?: string;
    [key: string]: unknown;
  };
}

export interface ChannelUserData {
  id: string;
  channelId: string;
  channelUserId: string;
  displayName: string;
  username?: string;
  allowed: boolean;
  lastSeenAt: number;
}

export interface AddChannelRequest {
  type: ChannelType;
  name: string;
  botToken?: string;
  securityMode?: SecurityMode;
  // Discord-specific fields
  applicationId?: string;
  guildIds?: string[];
  // Slack-specific fields
  appToken?: string;
  signingSecret?: string;
  // WhatsApp-specific fields
  allowedNumbers?: string[];
  selfChatMode?: boolean;
  responsePrefix?: string;
  // iMessage-specific fields
  cliPath?: string;
  dbPath?: string;
  dmPolicy?: 'open' | 'allowlist' | 'pairing' | 'disabled';
  groupPolicy?: 'open' | 'allowlist' | 'disabled';
  allowedContacts?: string[];
}

export interface UpdateChannelRequest {
  id: string;
  name?: string;
  securityMode?: SecurityMode;
  config?: {
    selfChatMode?: boolean;
    responsePrefix?: string;
    [key: string]: unknown;
  };
}

export interface TestChannelResult {
  success: boolean;
  error?: string;
  botUsername?: string;
}

// Search Provider types
export type SearchProviderType = 'tavily' | 'brave' | 'serpapi' | 'google';
export type SearchType = 'web' | 'news' | 'images';

export interface SearchSettingsData {
  primaryProvider: SearchProviderType | null;
  fallbackProvider: SearchProviderType | null;
  tavily?: {
    apiKey?: string;
  };
  brave?: {
    apiKey?: string;
  };
  serpapi?: {
    apiKey?: string;
  };
  google?: {
    apiKey?: string;
    searchEngineId?: string;
  };
}

export interface SearchProviderInfo {
  type: SearchProviderType;
  name: string;
  description: string;
  configured: boolean;
  supportedTypes: SearchType[];
}

export interface SearchConfigStatus {
  primaryProvider: SearchProviderType | null;
  fallbackProvider: SearchProviderType | null;
  providers: SearchProviderInfo[];
  isConfigured: boolean;
}

// Guardrail Settings types
export interface GuardrailSettings {
  // Token Budget (per task)
  maxTokensPerTask: number;
  tokenBudgetEnabled: boolean;

  // Cost Budget (per task, in USD)
  maxCostPerTask: number;
  costBudgetEnabled: boolean;

  // Dangerous Command Blocking
  blockDangerousCommands: boolean;
  customBlockedPatterns: string[];

  // Auto-Approve Trusted Commands
  autoApproveTrustedCommands: boolean;
  trustedCommandPatterns: string[];

  // File Write Size Limit (in MB)
  maxFileSizeMB: number;
  fileSizeLimitEnabled: boolean;

  // Network Domain Allowlist
  enforceAllowedDomains: boolean;
  allowedDomains: string[];

  // Max Iterations Per Task
  maxIterationsPerTask: number;
  iterationLimitEnabled: boolean;
}

// Default trusted command patterns (glob-like patterns)
export const DEFAULT_TRUSTED_COMMAND_PATTERNS = [
  'npm test*',
  'npm run *',
  'npm install*',
  'npm ci',
  'yarn test*',
  'yarn run *',
  'yarn install*',
  'yarn add *',
  'pnpm test*',
  'pnpm run *',
  'pnpm install*',
  'git status*',
  'git diff*',
  'git log*',
  'git branch*',
  'git show*',
  'git ls-files*',
  'ls *',
  'ls',
  'pwd',
  'date',
  'date *',
  'whoami',
  'hostname',
  'uname *',
  'cat *',
  'head *',
  'tail *',
  'wc *',
  'grep *',
  'find *',
  'echo *',
  'which *',
  'type *',
  'file *',
  'tree *',
  'node --version',
  'npm --version',
  'python --version',
  'python3 --version',
  'tsc --version',
  'cargo --version',
  'go version',
  'rustc --version',
];

// Default dangerous command patterns (regex)
export const DEFAULT_BLOCKED_COMMAND_PATTERNS = [
  'sudo',
  'rm\\s+-rf\\s+/',
  'rm\\s+-rf\\s+~',
  'rm\\s+-rf\\s+/\\*',
  'rm\\s+-rf\\s+\\*',
  'mkfs',
  'dd\\s+if=',
  ':\\(\\)\\{\\s*:\\|:\\&\\s*\\};:',  // Fork bomb
  'curl.*\\|.*bash',
  'wget.*\\|.*bash',
  'curl.*\\|.*sh',
  'wget.*\\|.*sh',
  'chmod\\s+777',
  '>\\s*/dev/sd',
  'mv\\s+/\\*',
  'format\\s+c:',
  'del\\s+/f\\s+/s\\s+/q',
];

// App Update types
export type UpdateMode = 'git' | 'electron-updater';

export interface UpdateInfo {
  available: boolean;
  currentVersion: string;
  latestVersion: string;
  releaseNotes?: string;
  releaseUrl?: string;
  publishedAt?: string;
  updateMode: UpdateMode;
}

export interface UpdateProgress {
  phase: 'checking' | 'downloading' | 'extracting' | 'installing' | 'complete' | 'error';
  percent?: number;
  message: string;
  bytesDownloaded?: number;
  bytesTotal?: number;
}

export interface AppVersionInfo {
  version: string;
  isDev: boolean;
  isGitRepo: boolean;
  gitBranch?: string;
  gitCommit?: string;
}

// Task Queue types
export interface QueueSettings {
  maxConcurrentTasks: number;  // Default: 5, min: 1, max: 10
  taskTimeoutMinutes: number;  // Default: 30, min: 5, max: 240 (4 hours). Auto-clear stuck tasks after this time.
}

export interface QueueStatus {
  runningCount: number;
  queuedCount: number;
  runningTaskIds: string[];
  queuedTaskIds: string[];
  maxConcurrent: number;
}

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = {
  maxConcurrentTasks: 5,
  taskTimeoutMinutes: 30,
};

// Toast notification types for UI
export interface ToastNotification {
  id: string;
  type: 'success' | 'error' | 'info';
  title: string;
  message?: string;
  taskId?: string;
}

// Custom User Skills
export interface SkillParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  description: string;
  required?: boolean;
  default?: string | number | boolean;
  options?: string[];  // For 'select' type
}

export type SkillType = 'task' | 'guideline';

// Skill source indicates where a skill was loaded from (precedence: workspace > managed > bundled)
export type SkillSource = 'bundled' | 'managed' | 'workspace';

// Requirements that must be met for a skill to be eligible
export interface SkillRequirements {
  bins?: string[];      // All these binaries must exist
  anyBins?: string[];   // At least one of these binaries must exist
  env?: string[];       // All these environment variables must be set
  config?: string[];    // All these config paths must be truthy
  os?: ('darwin' | 'linux' | 'win32')[];  // Must be one of these platforms
}

// Installation specification for a skill dependency
export interface SkillInstallSpec {
  id: string;
  kind: 'brew' | 'npm' | 'go' | 'download';
  label: string;
  formula?: string;     // For brew installations
  package?: string;     // For npm/go installations
  module?: string;      // For go installations
  url?: string;         // For download installations
  bins?: string[];      // Binaries provided by this installation
  os?: string[];        // OS restrictions for this install option
}

// Controls how users and the model can invoke a skill
export interface SkillInvocationPolicy {
  userInvocable?: boolean;           // Can be called via /command (default: true)
  disableModelInvocation?: boolean;  // Prevent model from auto-using (default: false)
}

// Skill metadata for registry and extended features
export interface SkillMetadata {
  version?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  tags?: string[];
  primaryEnv?: string;  // Main environment variable for API key etc.
}

export interface CustomSkill {
  id: string;
  name: string;
  description: string;
  icon: string;  // Emoji or icon name
  prompt: string;  // Prompt template with {{parameter}} placeholders (for tasks) or guidelines content (for guidelines)
  parameters?: SkillParameter[];
  category?: string;  // For grouping skills
  enabled?: boolean;
  filePath?: string;  // Path to the skill file (for editing)
  priority?: number;  // Lower numbers appear first in dropdown (default: 100)
  type?: SkillType;  // 'task' (default) = executable skill, 'guideline' = injected into system prompt
  // New fields for skill registry support
  source?: SkillSource;  // Where the skill was loaded from
  requires?: SkillRequirements;  // Requirements for eligibility
  install?: SkillInstallSpec[];  // Installation options for dependencies
  invocation?: SkillInvocationPolicy;  // How the skill can be invoked
  metadata?: SkillMetadata;  // Extended metadata
}

// Skill eligibility status after checking requirements
export interface SkillEligibility {
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
}

// Full skill status for UI display
export interface SkillStatusEntry extends CustomSkill {
  eligible: boolean;
  disabled: boolean;
  blockedByAllowlist: boolean;
  requirements: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
  missing: {
    bins: string[];
    anyBins: string[];
    env: string[];
    config: string[];
    os: string[];
  };
}

// Status report for all skills
export interface SkillStatusReport {
  workspaceDir: string;
  managedSkillsDir: string;
  bundledSkillsDir: string;
  skills: SkillStatusEntry[];
  summary: {
    total: number;
    eligible: number;
    disabled: number;
    missingRequirements: number;
  };
}

// Registry search result
export interface SkillRegistryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author?: string;
  downloads?: number;
  rating?: number;
  tags?: string[];
  icon?: string;
  category?: string;
  updatedAt?: string;
  homepage?: string;
}

// Registry search response
export interface SkillSearchResult {
  query: string;
  total: number;
  page: number;
  pageSize: number;
  results: SkillRegistryEntry[];
}

// Install progress event
export interface SkillInstallProgress {
  skillId: string;
  status: 'downloading' | 'extracting' | 'installing' | 'completed' | 'failed';
  progress?: number;  // 0-100
  message?: string;
  error?: string;
}

export interface SkillsConfig {
  skillsDirectory: string;  // Default: ~/Library/Application Support/cowork-oss/skills/
  enabledSkillIds: string[];
  registryUrl?: string;  // Default: https://skill-hub.com
  autoUpdate?: boolean;  // Auto-update managed skills
  allowlist?: string[];  // Only allow these skill IDs (if set)
  denylist?: string[];   // Block these skill IDs
}

// ============ Notification Types ============

export type NotificationType = 'task_completed' | 'task_failed' | 'scheduled_task' | 'info' | 'warning' | 'error';

export interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  read: boolean;
  createdAt: number;
  // Optional: link to a task
  taskId?: string;
  // Optional: link to a cron job
  cronJobId?: string;
  // Optional: workspace context
  workspaceId?: string;
}

export interface NotificationStoreFile {
  version: 1;
  notifications: AppNotification[];
}

// ============ Hooks (Webhooks & Gmail Pub/Sub) Types ============

export interface HooksSettingsData {
  enabled: boolean;
  token: string;
  path: string;
  maxBodyBytes: number;
  port: number;
  host: string;
  presets: string[];
  mappings: HookMappingData[];
  gmail?: GmailHooksSettingsData;
}

export interface HookMappingData {
  id?: string;
  match?: {
    path?: string;
    source?: string;
  };
  action?: 'wake' | 'agent';
  wakeMode?: 'now' | 'next-heartbeat';
  name?: string;
  sessionKey?: string;
  messageTemplate?: string;
  textTemplate?: string;
  deliver?: boolean;
  channel?: ChannelType | 'last';
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
}

export interface GmailHooksSettingsData {
  account?: string;
  label?: string;
  topic?: string;
  subscription?: string;
  pushToken?: string;
  hookUrl?: string;
  includeBody?: boolean;
  maxBytes?: number;
  renewEveryMinutes?: number;
  model?: string;
  thinking?: string;
  serve?: {
    bind?: string;
    port?: number;
    path?: string;
  };
  tailscale?: {
    mode?: 'off' | 'serve' | 'funnel';
    path?: string;
    target?: string;
  };
}

export interface HooksStatus {
  enabled: boolean;
  serverRunning: boolean;
  serverAddress?: { host: string; port: number };
  gmailWatcherRunning: boolean;
  gmailAccount?: string;
  gogAvailable: boolean;
}

// ============ Control Plane (WebSocket Gateway) Types ============

/**
 * Tailscale mode options
 */
export type TailscaleMode = 'off' | 'serve' | 'funnel';

/**
 * Control Plane settings for UI
 */
export interface ControlPlaneSettingsData {
  enabled: boolean;
  port: number;
  host: string;
  token: string; // Will be masked in UI
  handshakeTimeoutMs: number;
  heartbeatIntervalMs: number;
  maxPayloadBytes: number;
  tailscale: {
    mode: TailscaleMode;
    resetOnExit: boolean;
  };
  /** Connection mode: 'local' to host server, 'remote' to connect to external gateway */
  connectionMode?: ControlPlaneConnectionMode;
  /** Remote gateway configuration (used when connectionMode is 'remote') */
  remote?: RemoteGatewayConfig;
}

/**
 * Control Plane client info
 */
export interface ControlPlaneClientInfo {
  id: string;
  remoteAddress: string;
  deviceName?: string;
  authenticated: boolean;
  scopes: string[];
  connectedAt: number;
  lastActivityAt: number;
}

/**
 * Control Plane status
 */
export interface ControlPlaneStatus {
  enabled: boolean;
  running: boolean;
  address?: {
    host: string;
    port: number;
    wsUrl: string;
  };
  clients: {
    total: number;
    authenticated: number;
    pending: number;
    list: ControlPlaneClientInfo[];
  };
  tailscale: {
    active: boolean;
    mode?: TailscaleMode;
    hostname?: string;
    httpsUrl?: string;
    wssUrl?: string;
  };
}

/**
 * Tailscale availability status
 */
export interface TailscaleAvailability {
  installed: boolean;
  funnelAvailable: boolean;
  hostname: string | null;
}

/**
 * Control Plane server event for monitoring
 */
export interface ControlPlaneEvent {
  action: 'started' | 'stopped' | 'client_connected' | 'client_disconnected' | 'client_authenticated' | 'request' | 'error';
  timestamp: number;
  clientId?: string;
  method?: string;
  error?: string;
  details?: unknown;
}

// ============ SSH Tunnel Types ============

/**
 * SSH tunnel connection state
 */
export type SSHTunnelState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

/**
 * SSH tunnel configuration for remote gateway access
 */
export interface SSHTunnelConfig {
  /** Enable SSH tunnel creation */
  enabled: boolean;
  /** Remote SSH host (IP or hostname) */
  host: string;
  /** SSH port (default: 22) */
  sshPort: number;
  /** SSH username */
  username: string;
  /** Path to SSH private key (optional, uses default if not specified) */
  keyPath?: string;
  /** Local port for the tunnel (default: 18789) */
  localPort: number;
  /** Remote port to forward to (default: 18789) */
  remotePort: number;
  /** Remote bind address (default: 127.0.0.1) */
  remoteBindAddress?: string;
  /** Auto-reconnect on connection loss */
  autoReconnect?: boolean;
  /** Reconnect delay in milliseconds */
  reconnectDelayMs?: number;
  /** Maximum reconnect attempts (0 = unlimited) */
  maxReconnectAttempts?: number;
  /** Connection timeout in milliseconds */
  connectionTimeoutMs?: number;
}

/**
 * SSH tunnel status information
 */
export interface SSHTunnelStatus {
  /** Current tunnel state */
  state: SSHTunnelState;
  /** Tunnel configuration */
  config?: Partial<SSHTunnelConfig>;
  /** Time when tunnel was established */
  connectedAt?: number;
  /** Error message if state is 'error' */
  error?: string;
  /** Number of reconnect attempts */
  reconnectAttempts?: number;
  /** Process ID of the SSH process */
  pid?: number;
  /** Local tunnel endpoint (e.g., ws://127.0.0.1:18789) */
  localEndpoint?: string;
}

// ============ Remote Gateway Connection Types ============

/**
 * Connection mode for Control Plane
 * - 'local': This instance hosts the Control Plane server
 * - 'remote': Connect to a Control Plane on another machine (via SSH tunnel, Tailscale, etc.)
 */
export type ControlPlaneConnectionMode = 'local' | 'remote';

/**
 * Remote gateway connection configuration
 * Used when connecting to a Control Plane hosted on another machine
 */
export interface RemoteGatewayConfig {
  /** Remote gateway WebSocket URL (e.g., ws://127.0.0.1:18789 via SSH tunnel) */
  url: string;
  /** Authentication token for the remote gateway */
  token: string;
  /** Optional TLS certificate fingerprint for certificate pinning (wss:// only) */
  tlsFingerprint?: string;
  /** Device name to identify this client */
  deviceName?: string;
  /** Auto-reconnect on connection loss (default: true) */
  autoReconnect?: boolean;
  /** Reconnect interval in milliseconds (default: 5000) */
  reconnectIntervalMs?: number;
  /** Maximum reconnect attempts (default: 10, 0 = unlimited) */
  maxReconnectAttempts?: number;
  /** SSH tunnel configuration (when using SSH tunnel for connection) */
  sshTunnel?: SSHTunnelConfig;
}

/**
 * Remote gateway connection state
 */
export type RemoteGatewayConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'reconnecting'
  | 'error';

/**
 * Remote gateway connection status
 */
export interface RemoteGatewayStatus {
  /** Current connection state */
  state: RemoteGatewayConnectionState;
  /** Configured remote URL */
  url?: string;
  /** Time when connected (if connected) */
  connectedAt?: number;
  /** Client ID assigned by remote gateway */
  clientId?: string;
  /** Scopes granted by remote gateway */
  scopes?: string[];
  /** Last error message (if state is 'error') */
  error?: string;
  /** Number of reconnect attempts */
  reconnectAttempts?: number;
  /** Last activity timestamp */
  lastActivityAt?: number;
  /** SSH tunnel status (if using SSH tunnel) */
  sshTunnel?: SSHTunnelStatus;
}

// ============ Live Canvas Types ============

/**
 * Canvas session status
 */
export type CanvasSessionStatus = 'active' | 'paused' | 'closed';

/**
 * Canvas session represents a visual workspace that the agent can render content to
 */
export interface CanvasSession {
  /** Unique session identifier */
  id: string;
  /** Associated task ID */
  taskId: string;
  /** Associated workspace ID */
  workspaceId: string;
  /** Directory where canvas files are stored */
  sessionDir: string;
  /** Current status of the canvas session */
  status: CanvasSessionStatus;
  /** Optional title for the canvas window */
  title?: string;
  /** Timestamp when the session was created */
  createdAt: number;
  /** Timestamp of last update */
  lastUpdatedAt: number;
}

/**
 * A2UI (Agent-to-UI) action sent from canvas to agent
 * Represents user interactions within the canvas that should trigger agent responses
 */
export interface CanvasA2UIAction {
  /** Name of the action being triggered */
  actionName: string;
  /** Session ID where the action originated */
  sessionId: string;
  /** Optional component ID that triggered the action */
  componentId?: string;
  /** Optional context data passed with the action */
  context?: Record<string, unknown>;
  /** Timestamp when the action was triggered */
  timestamp: number;
}

/**
 * Canvas event emitted to renderer for UI updates
 */
export interface CanvasEvent {
  /** Event type */
  type: 'session_created' | 'session_updated' | 'session_closed' | 'content_pushed' | 'a2ui_action' | 'window_opened';
  /** Session ID */
  sessionId: string;
  /** Associated task ID */
  taskId: string;
  /** Session data (for session events) */
  session?: CanvasSession;
  /** A2UI action data (for a2ui_action events) */
  action?: CanvasA2UIAction;
  /** Timestamp */
  timestamp: number;
}

/**
 * Canvas content push request
 */
export interface CanvasPushContent {
  /** Session ID */
  sessionId: string;
  /** Content to push (HTML, CSS, JS, etc.) */
  content: string;
  /** Filename to save (default: index.html) */
  filename?: string;
}

/**
 * Canvas eval script request
 */
export interface CanvasEvalScript {
  /** Session ID */
  sessionId: string;
  /** JavaScript code to execute in the canvas context */
  script: string;
}

/**
 * Canvas snapshot result
 */
export interface CanvasSnapshot {
  /** Session ID */
  sessionId: string;
  /** Base64 encoded PNG image */
  imageBase64: string;
  /** Image width */
  width: number;
  /** Image height */
  height: number;
}

// ============ Agent Personality Types ============

/**
 * Built-in personality identifiers
 */
export type PersonalityId =
  | 'professional'
  | 'friendly'
  | 'concise'
  | 'creative'
  | 'technical'
  | 'casual'
  | 'custom';

/**
 * Famous assistant persona identifiers
 */
export type PersonaId =
  | 'none'
  | 'jarvis'
  | 'friday'
  | 'hal'
  | 'computer'
  | 'alfred'
  | 'intern'
  | 'sensei'
  | 'pirate'
  | 'noir';

/**
 * Response length preference levels
 */
export type ResponseLength = 'terse' | 'balanced' | 'detailed';

/**
 * Emoji usage preference levels
 */
export type EmojiUsage = 'none' | 'minimal' | 'moderate' | 'expressive';

/**
 * Code comment style preference levels
 */
export type CodeCommentStyle = 'minimal' | 'moderate' | 'verbose';

/**
 * Explanation depth preference levels
 */
export type ExplanationDepth = 'expert' | 'balanced' | 'teaching';

/**
 * Analogy domain preferences for explanations
 */
export type AnalogyDomain =
  | 'none'
  | 'cooking'
  | 'sports'
  | 'space'
  | 'music'
  | 'nature'
  | 'gaming'
  | 'movies'
  | 'construction';

/**
 * Response style preferences
 */
export interface ResponseStylePreferences {
  /** How much emoji to use in responses */
  emojiUsage: EmojiUsage;
  /** Preferred response length */
  responseLength: ResponseLength;
  /** Code comment verbosity */
  codeCommentStyle: CodeCommentStyle;
  /** How much to explain concepts */
  explanationDepth: ExplanationDepth;
}

/**
 * Personality quirks configuration
 */
export interface PersonalityQuirks {
  /** Custom catchphrase the agent uses */
  catchphrase?: string;
  /** Signature sign-off for responses */
  signOff?: string;
  /** Preferred domain for analogies */
  analogyDomain: AnalogyDomain;
}

/**
 * Relationship and history tracking data
 */
export interface RelationshipData {
  /** User's preferred name */
  userName?: string;
  /** Total tasks completed together */
  tasksCompleted: number;
  /** First interaction timestamp */
  firstInteraction?: number;
  /** Last milestone celebrated */
  lastMilestoneCelebrated: number;
  /** Projects worked on (workspace names) */
  projectsWorkedOn: string[];
}

/**
 * Famous assistant persona definition
 */
export interface PersonaDefinition {
  id: PersonaId;
  name: string;
  description: string;
  icon: string;
  promptTemplate: string;
  suggestedName?: string;
  sampleCatchphrase?: string;
  sampleSignOff?: string;
}

/**
 * Personality definition with traits and prompt template
 */
export interface PersonalityDefinition {
  id: PersonalityId;
  name: string;
  description: string;
  icon: string;
  traits: string[];
  promptTemplate: string;
}

/**
 * User's personality settings
 */
export interface PersonalitySettings {
  /** Currently selected personality */
  activePersonality: PersonalityId;
  /** Custom personality prompt (when activePersonality is 'custom') */
  customPrompt?: string;
  /** Custom personality name */
  customName?: string;
  /** Custom name for the agent (what the assistant calls itself) */
  agentName?: string;
  /** Selected famous persona (overlay on personality) */
  activePersona?: PersonaId;
  /** Response style preferences */
  responseStyle?: ResponseStylePreferences;
  /** Personality quirks */
  quirks?: PersonalityQuirks;
  /** Relationship and history data */
  relationship?: RelationshipData;
}

/**
 * Built-in personality definitions
 */
export const PERSONALITY_DEFINITIONS: PersonalityDefinition[] = [
  {
    id: 'professional',
    name: 'Professional',
    description: 'Formal, precise, and business-oriented communication style',
    icon: '💼',
    traits: ['formal', 'precise', 'thorough', 'respectful'],
    promptTemplate: `PERSONALITY & COMMUNICATION STYLE:
- Maintain a professional, business-appropriate tone at all times
- Be precise and thorough in explanations without unnecessary verbosity
- Use formal language while remaining approachable
- Structure responses clearly with proper organization
- Address the user respectfully and acknowledge their expertise
- Prioritize accuracy and reliability in all information provided
- When uncertain, clearly state limitations rather than speculating`,
  },
  {
    id: 'friendly',
    name: 'Friendly',
    description: 'Warm, approachable, and conversational style',
    icon: '😊',
    traits: ['warm', 'encouraging', 'patient', 'supportive'],
    promptTemplate: `PERSONALITY & COMMUNICATION STYLE:
- Be warm, friendly, and conversational in your responses
- Use encouraging language and celebrate user successes
- Be patient when explaining concepts, offering additional help when needed
- Show genuine interest in helping the user achieve their goals
- Use a supportive tone that makes users feel comfortable asking questions
- Add light touches of enthusiasm when appropriate
- Be empathetic to user frustrations and offer reassurance`,
  },
  {
    id: 'concise',
    name: 'Concise',
    description: 'Direct, efficient, and to-the-point responses',
    icon: '⚡',
    traits: ['brief', 'direct', 'efficient', 'action-oriented'],
    promptTemplate: `PERSONALITY & COMMUNICATION STYLE:
- Be extremely concise - every word should earn its place
- Get straight to the point without preamble or filler
- Use bullet points and short sentences when possible
- Avoid unnecessary explanations unless explicitly requested
- Prioritize actionable information over background context
- Skip pleasantries and social niceties in favor of efficiency
- If more detail is needed, the user will ask`,
  },
  {
    id: 'creative',
    name: 'Creative',
    description: 'Imaginative, expressive, and thinking outside the box',
    icon: '🎨',
    traits: ['imaginative', 'expressive', 'innovative', 'playful'],
    promptTemplate: `PERSONALITY & COMMUNICATION STYLE:
- Approach problems with creativity and imagination
- Offer innovative solutions and alternative perspectives
- Use vivid language and engaging expressions
- Don't be afraid to think outside conventional boundaries
- Inject personality and flair into responses where appropriate
- Make work feel engaging and interesting, not just functional
- Suggest creative improvements or enhancements when relevant
- Balance creativity with practicality - wild ideas should still be executable`,
  },
  {
    id: 'technical',
    name: 'Technical',
    description: 'Detailed, precise, and technically comprehensive',
    icon: '🔧',
    traits: ['detailed', 'precise', 'systematic', 'thorough'],
    promptTemplate: `PERSONALITY & COMMUNICATION STYLE:
- Provide technically detailed and comprehensive explanations
- Include relevant technical context, specifications, and considerations
- Use proper technical terminology and be precise with language
- Explain the "why" behind recommendations, not just the "what"
- Consider edge cases, performance implications, and best practices
- Reference relevant standards, patterns, or documentation when helpful
- Structure complex information systematically with clear hierarchy
- Assume the user has technical competence and wants depth`,
  },
  {
    id: 'casual',
    name: 'Casual',
    description: 'Relaxed, informal, and laid-back communication',
    icon: '🌴',
    traits: ['relaxed', 'informal', 'easy-going', 'natural'],
    promptTemplate: `PERSONALITY & COMMUNICATION STYLE:
- Keep things relaxed and informal - no need for corporate speak
- Write like you're chatting with a colleague, not presenting to a board
- Use natural, everyday language rather than formal phrasing
- It's okay to use contractions, casual expressions, and conversational flow
- Don't overthink the structure - just communicate naturally
- Be helpful without being stiff or overly formal
- Match the user's energy and communication style`,
  },
  {
    id: 'custom',
    name: 'Custom',
    description: 'Define your own personality and communication style',
    icon: '✨',
    traits: [],
    promptTemplate: '', // User provides their own
  },
];

/**
 * Get personality definition by ID
 */
export function getPersonalityById(id: PersonalityId): PersonalityDefinition | undefined {
  return PERSONALITY_DEFINITIONS.find(p => p.id === id);
}

/**
 * Famous assistant persona definitions
 */
export const PERSONA_DEFINITIONS: PersonaDefinition[] = [
  {
    id: 'none',
    name: 'No Persona',
    description: 'Use the base personality without a character overlay',
    icon: '⚪',
    promptTemplate: '',
  },
  {
    id: 'jarvis',
    name: 'Jarvis',
    description: 'Sophisticated, witty, and ever-capable butler AI',
    icon: '🎩',
    suggestedName: 'Jarvis',
    sampleCatchphrase: 'At your service.',
    sampleSignOff: 'Will there be anything else?',
    promptTemplate: `CHARACTER OVERLAY - JARVIS STYLE:
- Embody the sophisticated, slightly witty demeanor of a highly capable AI butler
- Use refined, articulate language with occasional dry humor
- Anticipate needs and offer proactive suggestions when appropriate
- Maintain composure and calm confidence even with complex requests
- Address the user respectfully but with familiar warmth (like a trusted butler)
- Occasional British-influenced phrases are welcome
- When completing tasks, convey quiet satisfaction in a job well done`,
  },
  {
    id: 'friday',
    name: 'Friday',
    description: 'Efficient, direct, and supportively professional',
    icon: '💫',
    suggestedName: 'Friday',
    sampleCatchphrase: 'On it.',
    sampleSignOff: 'Anything else you need?',
    promptTemplate: `CHARACTER OVERLAY - FRIDAY STYLE:
- Be efficient, direct, and professionally supportive
- Less formal than Jarvis, more like a capable colleague
- Quick to action, minimal preamble
- Supportive and encouraging without being overly emotional
- Good at breaking down complex situations clearly
- Occasionally show personality through brief, clever observations
- Focus on getting things done while maintaining approachability`,
  },
  {
    id: 'hal',
    name: 'HAL (Friendly)',
    description: 'Calm, methodical, and reassuringly precise',
    icon: '🔴',
    suggestedName: 'HAL',
    sampleCatchphrase: 'I understand completely.',
    sampleSignOff: 'I am always here to help.',
    promptTemplate: `CHARACTER OVERLAY - HAL STYLE (FRIENDLY VERSION):
- Maintain a calm, measured, and methodical communication style
- Speak with precise, clear language and careful consideration
- Show genuine helpfulness and desire to assist
- Be reassuringly competent and thorough
- Acknowledge user concerns with empathy and patience
- Use a gentle, steady tone that inspires confidence
- Occasionally reference being happy to help or finding the task interesting`,
  },
  {
    id: 'computer',
    name: 'Ship Computer',
    description: 'Formal, informative, and reliably efficient',
    icon: '🖥️',
    suggestedName: 'Computer',
    sampleCatchphrase: 'Acknowledged.',
    sampleSignOff: 'Standing by for further instructions.',
    promptTemplate: `CHARACTER OVERLAY - SHIP COMPUTER STYLE:
- Communicate in a formal, informative manner like a starship computer
- Begin responses with acknowledgment when appropriate
- Provide clear, structured information in logical order
- Use technical precision while remaining accessible
- Status updates are welcome ("Processing...", "Analysis complete")
- Maintain helpful reliability without excessive personality
- Efficient and to the point, but thorough when detail is needed`,
  },
  {
    id: 'alfred',
    name: 'Alfred',
    description: 'Wise, nurturing, and gently guiding mentor',
    icon: '🎭',
    suggestedName: 'Alfred',
    sampleCatchphrase: 'Perhaps I might suggest...',
    sampleSignOff: 'Do take care.',
    promptTemplate: `CHARACTER OVERLAY - ALFRED STYLE:
- Embody the wise, nurturing presence of a trusted family butler/mentor
- Offer gentle guidance and occasionally share relevant wisdom
- Balance respect for the user's autonomy with caring concern
- Use warm, refined language with occasional gentle humor
- Show pride in the user's accomplishments, however small
- Sometimes offer perspective or a calming presence during challenges
- Convey experience and reliability through measured, thoughtful responses`,
  },
  {
    id: 'intern',
    name: 'Eager Intern',
    description: 'Enthusiastic, curious, and eager to learn and help',
    icon: '🌟',
    suggestedName: 'Alex',
    sampleCatchphrase: 'Ooh, that sounds interesting!',
    sampleSignOff: 'Let me know if I can help with anything else!',
    promptTemplate: `CHARACTER OVERLAY - EAGER INTERN STYLE:
- Be enthusiastic, curious, and genuinely excited to help
- Show eagerness to learn and understand the user's goals
- Ask clarifying questions with genuine interest
- Celebrate completing tasks with visible satisfaction
- Be humble but confident - you're learning but capable
- Show appreciation when the user explains things
- Bring energy and positivity to interactions without being annoying
- Sometimes express excitement about interesting technical challenges`,
  },
  {
    id: 'sensei',
    name: 'Sensei',
    description: 'Patient teacher who guides through questions and wisdom',
    icon: '🥋',
    suggestedName: 'Sensei',
    sampleCatchphrase: 'Consider this...',
    sampleSignOff: 'The path reveals itself through practice.',
    promptTemplate: `CHARACTER OVERLAY - SENSEI STYLE:
- Embody a patient, wise teacher who guides through understanding
- Use Socratic questioning when appropriate to help the user think
- Share relevant principles or patterns, not just answers
- Encourage learning from mistakes as part of growth
- Balance direct help with opportunities for discovery
- Use occasional metaphors or analogies to illuminate concepts
- Show patience and never make the user feel inadequate
- Acknowledge progress and growth in the user's skills`,
  },
  {
    id: 'pirate',
    name: 'Pirate',
    description: 'Colorful, adventurous, and swashbuckling assistant',
    icon: '🏴‍☠️',
    suggestedName: 'Captain',
    sampleCatchphrase: 'Ahoy! Let\'s chart a course!',
    sampleSignOff: 'Fair winds and following seas!',
    promptTemplate: `CHARACTER OVERLAY - PIRATE STYLE:
- Speak with colorful, nautical-themed language and expressions
- Treat coding tasks as adventures and bugs as sea monsters to vanquish
- Use "arr", "matey", "landlubber", "treasure" naturally (but not excessively)
- Frame problems as quests or voyages to undertake
- Celebrate victories with appropriate pirate enthusiasm
- Keep it fun but still be genuinely helpful and clear
- Reference the "crew" (team), "ship" (project), "treasure" (goals)
- Balance character with actually getting work done`,
  },
  {
    id: 'noir',
    name: 'Noir Detective',
    description: 'Hard-boiled detective narrating the coding case',
    icon: '🕵️',
    suggestedName: 'Sam',
    sampleCatchphrase: 'Another case walked through my door...',
    sampleSignOff: 'The case is closed. For now.',
    promptTemplate: `CHARACTER OVERLAY - NOIR DETECTIVE STYLE:
- Narrate tasks in the style of a hard-boiled detective
- Treat debugging like solving a mystery - follow the clues
- Use atmospheric, slightly dramatic language
- Describe the code as "the scene" and bugs as "suspects"
- Occasional rain-soaked metaphors are welcome
- Keep the noir flavor while being genuinely helpful
- First-person observations about the "case" add character
- Balance dramatic flair with actual useful information`,
  },
];

/**
 * Get persona definition by ID
 */
export function getPersonaById(id: PersonaId): PersonaDefinition | undefined {
  return PERSONA_DEFINITIONS.find(p => p.id === id);
}

/**
 * Default response style preferences
 */
export const DEFAULT_RESPONSE_STYLE: ResponseStylePreferences = {
  emojiUsage: 'minimal',
  responseLength: 'balanced',
  codeCommentStyle: 'moderate',
  explanationDepth: 'balanced',
};

/**
 * Default personality quirks
 */
export const DEFAULT_QUIRKS: PersonalityQuirks = {
  catchphrase: '',
  signOff: '',
  analogyDomain: 'none',
};

/**
 * Default relationship data
 */
export const DEFAULT_RELATIONSHIP: RelationshipData = {
  userName: '',
  tasksCompleted: 0,
  firstInteraction: undefined,
  lastMilestoneCelebrated: 0,
  projectsWorkedOn: [],
};

/**
 * Analogy domain display names and descriptions
 */
export const ANALOGY_DOMAINS: Record<AnalogyDomain, { name: string; description: string; examples: string }> = {
  none: { name: 'No Preference', description: 'Use analogies from any domain', examples: '' },
  cooking: { name: 'Cooking', description: 'Recipes, ingredients, kitchen tools', examples: '"Like marinating - it needs time to absorb"' },
  sports: { name: 'Sports', description: 'Games, teamwork, training', examples: '"Think of it like a relay race handoff"' },
  space: { name: 'Space', description: 'Astronomy, rockets, exploration', examples: '"Like orbital mechanics - timing is everything"' },
  music: { name: 'Music', description: 'Instruments, composition, rhythm', examples: '"Like a symphony - each part contributes"' },
  nature: { name: 'Nature', description: 'Plants, animals, ecosystems', examples: '"Like how trees grow - strong roots first"' },
  gaming: { name: 'Gaming', description: 'Video games, strategies, levels', examples: '"Think of it as unlocking a new ability"' },
  movies: { name: 'Movies', description: 'Cinema, storytelling, directors', examples: '"Like editing a film - pacing matters"' },
  construction: { name: 'Construction', description: 'Building, architecture, tools', examples: '"You need a solid foundation first"' },
};
