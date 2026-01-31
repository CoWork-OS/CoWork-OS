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
  | 'user_message';

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

  // Task events (streaming and history)
  TASK_EVENT: 'task:event',
  TASK_EVENTS: 'task:events',
  TASK_SEND_MESSAGE: 'task:sendMessage',

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
}

export interface SkillsConfig {
  skillsDirectory: string;  // Default: ~/.cowork/skills/
  enabledSkillIds: string[];
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
