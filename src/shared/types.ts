// Core types shared between main and renderer processes

// Theme and Appearance types
export type ThemeMode = 'light' | 'dark' | 'system';
export type AccentColor = 'cyan' | 'blue' | 'purple' | 'pink' | 'rose' | 'orange' | 'green' | 'teal';

export interface AppearanceSettings {
  themeMode: ThemeMode;
  accentColor: AccentColor;
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
  // Meta tools
  | 'revise_plan';

export type ApprovalType =
  | 'delete_file'
  | 'delete_multiple'
  | 'bulk_rename'
  | 'network_access'
  | 'external_service'
  | 'run_command';

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
}

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

  // Task Queue
  QUEUE_GET_STATUS: 'queue:getStatus',
  QUEUE_GET_SETTINGS: 'queue:getSettings',
  QUEUE_SAVE_SETTINGS: 'queue:saveSettings',
  QUEUE_UPDATE: 'queue:update',
} as const;

// LLM Provider types
export type LLMProviderType = 'anthropic' | 'bedrock' | 'ollama' | 'gemini' | 'openrouter';

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
  // Cached models from API (populated when user refreshes)
  cachedGeminiModels?: CachedModelInfo[];
  cachedOpenRouterModels?: CachedModelInfo[];
  cachedOllamaModels?: CachedModelInfo[];
  cachedBedrockModels?: CachedModelInfo[];
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
export type ChannelType = 'telegram' | 'discord' | 'slack' | 'whatsapp';
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
  botToken: string;
  securityMode?: SecurityMode;
  // Discord-specific fields
  applicationId?: string;
  guildIds?: string[];
}

export interface UpdateChannelRequest {
  id: string;
  name?: string;
  securityMode?: SecurityMode;
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
  maxConcurrentTasks: number;  // Default: 3, min: 1, max: 10
}

export interface QueueStatus {
  runningCount: number;
  queuedCount: number;
  runningTaskIds: string[];
  queuedTaskIds: string[];
  maxConcurrent: number;
}

export const DEFAULT_QUEUE_SETTINGS: QueueSettings = {
  maxConcurrentTasks: 3,
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

export interface CustomSkill {
  id: string;
  name: string;
  description: string;
  icon: string;  // Emoji or icon name
  prompt: string;  // Prompt template with {{parameter}} placeholders
  parameters?: SkillParameter[];
  category?: string;  // For grouping skills
  enabled?: boolean;
  filePath?: string;  // Path to the skill file (for editing)
}

export interface SkillsConfig {
  skillsDirectory: string;  // Default: ~/.cowork/skills/
  enabledSkillIds: string[];
}
