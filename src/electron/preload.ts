import { contextBridge, ipcRenderer } from 'electron';

// IPC Channel names - inlined to avoid require() issues in sandboxed preload
const IPC_CHANNELS = {
  TASK_CREATE: 'task:create',
  TASK_GET: 'task:get',
  TASK_LIST: 'task:list',
  TASK_CANCEL: 'task:cancel',
  TASK_PAUSE: 'task:pause',
  TASK_RESUME: 'task:resume',
  TASK_RENAME: 'task:rename',
  TASK_DELETE: 'task:delete',
  TASK_EVENT: 'task:event',
  TASK_EVENTS: 'task:events',
  TASK_SEND_MESSAGE: 'task:sendMessage',
  TASK_SEND_STDIN: 'task:sendStdin',
  TASK_KILL_COMMAND: 'task:killCommand',
  WORKSPACE_SELECT: 'workspace:select',
  WORKSPACE_LIST: 'workspace:list',
  WORKSPACE_CREATE: 'workspace:create',
  WORKSPACE_UPDATE_PERMISSIONS: 'workspace:updatePermissions',
  WORKSPACE_GET_TEMP: 'workspace:getTemp',
  APPROVAL_RESPOND: 'approval:respond',
  ARTIFACT_LIST: 'artifact:list',
  ARTIFACT_PREVIEW: 'artifact:preview',
  SKILL_LIST: 'skill:list',
  SKILL_GET: 'skill:get',
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
  PERSONALITY_SETTINGS_CHANGED: 'personality:settingsChanged',
  // Task Queue
  QUEUE_GET_STATUS: 'queue:getStatus',
  QUEUE_GET_SETTINGS: 'queue:getSettings',
  QUEUE_SAVE_SETTINGS: 'queue:saveSettings',
  QUEUE_CLEAR: 'queue:clear',
  QUEUE_UPDATE: 'queue:update',
  // Custom User Skills
  CUSTOM_SKILL_LIST: 'customSkill:list',
  CUSTOM_SKILL_LIST_TASKS: 'customSkill:listTasks',
  CUSTOM_SKILL_LIST_GUIDELINES: 'customSkill:listGuidelines',
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
  // MCP (Model Context Protocol)
  MCP_GET_SETTINGS: 'mcp:getSettings',
  MCP_SAVE_SETTINGS: 'mcp:saveSettings',
  MCP_ADD_SERVER: 'mcp:addServer',
  MCP_UPDATE_SERVER: 'mcp:updateServer',
  MCP_REMOVE_SERVER: 'mcp:removeServer',
  MCP_CONNECT_SERVER: 'mcp:connectServer',
  MCP_DISCONNECT_SERVER: 'mcp:disconnectServer',
  MCP_GET_STATUS: 'mcp:getStatus',
  MCP_GET_SERVER_STATUS: 'mcp:getServerStatus',
  MCP_GET_ALL_TOOLS: 'mcp:getAllTools',
  MCP_GET_SERVER_TOOLS: 'mcp:getServerTools',
  MCP_TEST_SERVER: 'mcp:testServer',
  MCP_SERVER_STATUS_CHANGE: 'mcp:serverStatusChange',
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
  TRAY_QUICK_TASK: 'tray:quick-task',
  // Quick Input
  QUICK_INPUT_SUBMIT: 'quick-input:submit',
  QUICK_INPUT_CLOSE: 'quick-input:close',
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
  // Tailscale
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

// Custom Skill types (inlined for sandboxed preload)
interface SkillParameter {
  name: string;
  type: 'string' | 'number' | 'boolean' | 'select';
  description: string;
  required?: boolean;
  default?: string | number | boolean;
  options?: string[];
}

type SkillSource = 'bundled' | 'managed' | 'workspace';

interface SkillRequirements {
  bins?: string[];
  anyBins?: string[];
  env?: string[];
  config?: string[];
  os?: ('darwin' | 'linux' | 'win32')[];
}

interface SkillMetadata {
  version?: string;
  author?: string;
  homepage?: string;
  repository?: string;
  license?: string;
  tags?: string[];
  primaryEnv?: string;
}

interface CustomSkill {
  id: string;
  name: string;
  description: string;
  icon: string;
  prompt: string;
  parameters?: SkillParameter[];
  category?: string;
  enabled?: boolean;
  filePath?: string;
  source?: SkillSource;
  requires?: SkillRequirements;
  metadata?: SkillMetadata;
}

// Skill Registry types (inlined for sandboxed preload)
interface SkillRegistryEntry {
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

interface SkillSearchResult {
  query: string;
  total: number;
  page: number;
  pageSize: number;
  results: SkillRegistryEntry[];
}

interface SkillStatusEntry extends CustomSkill {
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

interface SkillStatusReport {
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

// MCP types (inlined for sandboxed preload)
type MCPTransportType = 'stdio' | 'sse' | 'websocket';
type MCPConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting' | 'error';

interface MCPServerConfig {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  transport: MCPTransportType;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  cwd?: string;
  url?: string;
  headers?: Record<string, string>;
  connectionTimeout?: number;
  requestTimeout?: number;
}

interface MCPTool {
  name: string;
  description?: string;
  inputSchema: {
    type: 'object';
    properties?: Record<string, any>;
    required?: string[];
  };
}

interface MCPServerStatus {
  id: string;
  name: string;
  status: MCPConnectionStatus;
  error?: string;
  tools: MCPTool[];
  lastPing?: number;
}

interface MCPSettings {
  servers: MCPServerConfig[];
  autoConnect: boolean;
  toolNamePrefix: string;
  maxReconnectAttempts: number;
  reconnectDelayMs: number;
  registryEnabled: boolean;
  registryUrl?: string;
  hostEnabled: boolean;
  hostPort?: number;
}

interface MCPRegistryEntry {
  id: string;
  name: string;
  description: string;
  version: string;
  author: string;
  installMethod: 'npm' | 'pip' | 'binary' | 'docker';
  installCommand?: string;
  transport: MCPTransportType;
  defaultCommand?: string;
  tools: Array<{ name: string; description: string }>;
  tags: string[];
  verified: boolean;
}

interface MCPRegistry {
  version: string;
  lastUpdated: string;
  servers: MCPRegistryEntry[];
}

interface MCPUpdateInfo {
  serverId: string;
  currentVersion: string;
  latestVersion: string;
  registryEntry: MCPRegistryEntry;
}

// Canvas types (inlined for sandboxed preload)
type CanvasSessionStatus = 'active' | 'paused' | 'closed';

interface CanvasSession {
  id: string;
  taskId: string;
  workspaceId: string;
  sessionDir: string;
  status: CanvasSessionStatus;
  title?: string;
  createdAt: number;
  lastUpdatedAt: number;
}

interface CanvasA2UIAction {
  actionName: string;
  sessionId: string;
  componentId?: string;
  context?: Record<string, unknown>;
  timestamp: number;
}

interface CanvasEvent {
  type: 'session_created' | 'session_updated' | 'session_closed' | 'content_pushed' | 'a2ui_action';
  sessionId: string;
  taskId: string;
  session?: CanvasSession;
  action?: CanvasA2UIAction;
  timestamp: number;
}

// Built-in Tools Settings types (inlined for sandboxed preload)
interface ToolCategoryConfig {
  enabled: boolean;
  priority: 'high' | 'normal' | 'low';
  description?: string;
}

interface BuiltinToolsSettings {
  categories: {
    browser: ToolCategoryConfig;
    search: ToolCategoryConfig;
    system: ToolCategoryConfig;
    file: ToolCategoryConfig;
    skill: ToolCategoryConfig;
    shell: ToolCategoryConfig;
    image: ToolCategoryConfig;
  };
  toolOverrides: Record<string, { enabled: boolean; priority?: 'high' | 'normal' | 'low' }>;
  version: string;
}

// Tray (Menu Bar) Settings (inlined for sandboxed preload)
interface TraySettings {
  enabled: boolean;
  showDockIcon: boolean;
  startMinimized: boolean;
  closeToTray: boolean;
  showNotifications: boolean;
}

// Cron (Scheduled Tasks) Types (inlined for sandboxed preload)
type CronSchedule =
  | { kind: 'at'; atMs: number }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string };

type CronJobStatus = 'ok' | 'error' | 'skipped';

interface CronRunHistoryEntry {
  runAtMs: number;
  durationMs: number;
  status: CronJobStatus;
  error?: string;
  taskId?: string;
}

interface CronJobState {
  nextRunAtMs?: number;
  runningAtMs?: number;
  lastRunAtMs?: number;
  lastStatus?: CronJobStatus;
  lastError?: string;
  lastDurationMs?: number;
  lastTaskId?: string;
  runHistory?: CronRunHistoryEntry[];
  totalRuns?: number;
  successfulRuns?: number;
  failedRuns?: number;
}

interface CronDeliveryConfig {
  enabled: boolean;
  channelType?: 'telegram' | 'discord' | 'slack' | 'whatsapp';
  channelId?: string;
  deliverOnSuccess?: boolean;
  deliverOnError?: boolean;
  summaryOnly?: boolean;
}

interface CronJob {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  createdAtMs: number;
  updatedAtMs: number;
  schedule: CronSchedule;
  workspaceId: string;
  taskPrompt: string;
  taskTitle?: string;
  timeoutMs?: number;
  modelKey?: string;
  maxHistoryEntries?: number;
  delivery?: CronDeliveryConfig;
  state: CronJobState;
}

interface CronJobCreate {
  name: string;
  description?: string;
  enabled: boolean;
  deleteAfterRun?: boolean;
  schedule: CronSchedule;
  workspaceId: string;
  taskPrompt: string;
  taskTitle?: string;
  timeoutMs?: number;
  modelKey?: string;
  maxHistoryEntries?: number;
  delivery?: CronDeliveryConfig;
}

interface CronJobPatch {
  name?: string;
  description?: string;
  enabled?: boolean;
  deleteAfterRun?: boolean;
  schedule?: CronSchedule;
  workspaceId?: string;
  taskPrompt?: string;
  taskTitle?: string;
  timeoutMs?: number;
  modelKey?: string;
  maxHistoryEntries?: number;
  delivery?: CronDeliveryConfig;
}

interface CronRunHistoryResult {
  jobId: string;
  jobName: string;
  entries: CronRunHistoryEntry[];
  totalRuns: number;
  successfulRuns: number;
  failedRuns: number;
}

interface CronWebhookStatus {
  enabled: boolean;
  host?: string;
  port?: number;
}

interface CronStatusSummary {
  enabled: boolean;
  storePath: string;
  jobCount: number;
  enabledJobCount: number;
  runningJobCount: number;
  maxConcurrentRuns: number;
  nextWakeAtMs: number | null;
  webhook?: CronWebhookStatus;
}

interface CronEvent {
  jobId: string;
  action: 'added' | 'updated' | 'removed' | 'started' | 'finished';
  runAtMs?: number;
  durationMs?: number;
  status?: CronJobStatus;
  error?: string;
  taskId?: string;
  nextRunAtMs?: number;
}

// Notification Types (inlined for sandboxed preload)
type NotificationType = 'task_completed' | 'task_failed' | 'scheduled_task' | 'info' | 'warning' | 'error';

interface AppNotification {
  id: string;
  type: NotificationType;
  title: string;
  message: string;
  read: boolean;
  createdAt: number;
  taskId?: string;
  cronJobId?: string;
  workspaceId?: string;
}

interface NotificationEvent {
  type: 'added' | 'updated' | 'removed' | 'cleared';
  notification?: AppNotification;
  notifications?: AppNotification[];
}

// Hooks types (inlined for sandboxed preload)
interface HooksSettings {
  enabled: boolean;
  token: string;
  path: string;
  maxBodyBytes: number;
  port: number;
  host: string;
  presets: string[];
  mappings: HookMapping[];
  gmail?: GmailHooksConfig;
}

interface HookMapping {
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
  channel?: 'telegram' | 'discord' | 'slack' | 'whatsapp' | 'imessage' | 'last';
  to?: string;
  model?: string;
  thinking?: string;
  timeoutSeconds?: number;
}

interface GmailHooksConfig {
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

interface HooksStatus {
  enabled: boolean;
  serverRunning: boolean;
  serverAddress?: { host: string; port: number };
  gmailWatcherRunning: boolean;
  gmailAccount?: string;
  gogAvailable: boolean;
}

interface GmailHooksStatus {
  configured: boolean;
  running: boolean;
  account?: string;
  topic?: string;
  gogAvailable: boolean;
}

interface HooksEvent {
  action: 'started' | 'stopped' | 'request' | 'error';
  timestamp: number;
  path?: string;
  method?: string;
  statusCode?: number;
  error?: string;
}

// Control Plane types (inlined for sandboxed preload)
// NOTE: These types are intentionally duplicated from shared/types.ts because
// the preload script runs in a sandboxed context and cannot import from other modules.
// When updating these types, ensure shared/types.ts is also updated to stay in sync.
type TailscaleMode = 'off' | 'serve' | 'funnel';
type ControlPlaneConnectionMode = 'local' | 'remote';

interface ControlPlaneSettingsData {
  enabled: boolean;
  port: number;
  host: string;
  token: string;
  handshakeTimeoutMs: number;
  heartbeatIntervalMs: number;
  maxPayloadBytes: number;
  tailscale: {
    mode: TailscaleMode;
    resetOnExit: boolean;
  };
  connectionMode?: ControlPlaneConnectionMode;
  remote?: RemoteGatewayConfig;
}

interface ControlPlaneClientInfo {
  id: string;
  remoteAddress: string;
  deviceName?: string;
  authenticated: boolean;
  scopes: string[];
  connectedAt: number;
  lastActivityAt: number;
}

interface ControlPlaneStatus {
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

interface ControlPlaneEvent {
  action: 'started' | 'stopped' | 'client_connected' | 'client_disconnected' | 'client_authenticated' | 'request' | 'error';
  timestamp: number;
  clientId?: string;
  method?: string;
  error?: string;
  details?: unknown;
}

interface TailscaleAvailability {
  installed: boolean;
  funnelAvailable: boolean;
  hostname: string | null;
}

// Remote Gateway types
interface RemoteGatewayConfig {
  url: string;
  token: string;
  tlsFingerprint?: string;
  deviceName?: string;
  autoReconnect?: boolean;
  reconnectIntervalMs?: number;
  maxReconnectAttempts?: number;
  sshTunnel?: SSHTunnelConfig;
}

type RemoteGatewayConnectionState =
  | 'disconnected'
  | 'connecting'
  | 'authenticating'
  | 'connected'
  | 'reconnecting'
  | 'error';

interface RemoteGatewayStatus {
  state: RemoteGatewayConnectionState;
  url?: string;
  connectedAt?: number;
  clientId?: string;
  scopes?: string[];
  error?: string;
  reconnectAttempts?: number;
  lastActivityAt?: number;
}

interface RemoteGatewayEvent {
  type: 'stateChange' | 'event';
  state?: RemoteGatewayConnectionState;
  event?: string;
  payload?: unknown;
  error?: string;
}

// SSH Tunnel types
type SSHTunnelState =
  | 'disconnected'
  | 'connecting'
  | 'connected'
  | 'reconnecting'
  | 'error';

interface SSHTunnelConfig {
  enabled: boolean;
  host: string;
  sshPort: number;
  username: string;
  keyPath?: string;
  localPort: number;
  remotePort: number;
  remoteBindAddress?: string;
  autoReconnect?: boolean;
  reconnectDelayMs?: number;
  maxReconnectAttempts?: number;
  connectionTimeoutMs?: number;
}

interface SSHTunnelStatus {
  state: SSHTunnelState;
  config?: Partial<SSHTunnelConfig>;
  connectedAt?: number;
  error?: string;
  reconnectAttempts?: number;
  pid?: number;
  localEndpoint?: string;
}

interface SSHTunnelEvent {
  type: 'stateChange' | 'connected' | 'disconnected' | 'error';
  state?: SSHTunnelState;
  reason?: string;
  error?: string;
}

// Expose protected methods that allow the renderer process to use ipcRenderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Dialog APIs
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),

  // File APIs
  openFile: (filePath: string, workspacePath?: string) => ipcRenderer.invoke('file:open', filePath, workspacePath),
  showInFinder: (filePath: string, workspacePath?: string) => ipcRenderer.invoke('file:showInFinder', filePath, workspacePath),
  readFileForViewer: (filePath: string, workspacePath: string) => ipcRenderer.invoke('file:readForViewer', { filePath, workspacePath }),

  // Shell APIs
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // Task APIs
  createTask: (data: any) => ipcRenderer.invoke(IPC_CHANNELS.TASK_CREATE, data),
  getTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_GET, id),
  listTasks: () => ipcRenderer.invoke(IPC_CHANNELS.TASK_LIST),
  cancelTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_CANCEL, id),
  pauseTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_PAUSE, id),
  resumeTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_RESUME, id),
  sendStdin: (taskId: string, input: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_SEND_STDIN, { taskId, input }),
  killCommand: (taskId: string, force?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.TASK_KILL_COMMAND, { taskId, force }),
  renameTask: (id: string, title: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_RENAME, { id, title }),
  deleteTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_DELETE, id),

  // Task event streaming
  onTaskEvent: (callback: (event: any) => void) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.TASK_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TASK_EVENT, subscription);
  },

  // Task event history (load from DB)
  getTaskEvents: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_EVENTS, taskId),

  // Send follow-up message to a task
  sendMessage: (taskId: string, message: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.TASK_SEND_MESSAGE, { taskId, message }),

  // Workspace APIs
  createWorkspace: (data: any) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_CREATE, data),
  listWorkspaces: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_LIST),
  selectWorkspace: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_SELECT, id),
  getTempWorkspace: () => ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_GET_TEMP),
  updateWorkspacePermissions: (id: string, permissions: { shell?: boolean; network?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.WORKSPACE_UPDATE_PERMISSIONS, id, permissions),

  // Approval APIs
  respondToApproval: (data: any) => ipcRenderer.invoke(IPC_CHANNELS.APPROVAL_RESPOND, data),

  // Artifact APIs
  listArtifacts: (taskId: string) => ipcRenderer.invoke(IPC_CHANNELS.ARTIFACT_LIST, taskId),
  previewArtifact: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.ARTIFACT_PREVIEW, id),

  // Skill APIs
  listSkills: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_LIST),
  getSkill: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.SKILL_GET, id),

  // LLM Settings APIs
  getLLMSettings: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_SETTINGS),
  saveLLMSettings: (settings: any) => ipcRenderer.invoke(IPC_CHANNELS.LLM_SAVE_SETTINGS, settings),
  testLLMProvider: (config: any) => ipcRenderer.invoke(IPC_CHANNELS.LLM_TEST_PROVIDER, config),
  getLLMModels: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_MODELS),
  getLLMConfigStatus: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_CONFIG_STATUS),
  getOllamaModels: (baseUrl?: string) => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_OLLAMA_MODELS, baseUrl),
  getGeminiModels: (apiKey?: string) => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_GEMINI_MODELS, apiKey),
  getOpenRouterModels: (apiKey?: string) => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_OPENROUTER_MODELS, apiKey),
  getOpenAIModels: (apiKey?: string) => ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_OPENAI_MODELS, apiKey),
  openaiOAuthStart: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_OPENAI_OAUTH_START),
  openaiOAuthLogout: () => ipcRenderer.invoke(IPC_CHANNELS.LLM_OPENAI_OAUTH_LOGOUT),
  getBedrockModels: (config?: { region?: string; accessKeyId?: string; secretAccessKey?: string; profile?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.LLM_GET_BEDROCK_MODELS, config),

  // Gateway / Channel APIs
  getGatewayChannels: () => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_GET_CHANNELS),
  addGatewayChannel: (data: any) => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_ADD_CHANNEL, data),
  updateGatewayChannel: (data: any) => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_UPDATE_CHANNEL, data),
  removeGatewayChannel: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_REMOVE_CHANNEL, id),
  enableGatewayChannel: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_ENABLE_CHANNEL, id),
  disableGatewayChannel: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_DISABLE_CHANNEL, id),
  testGatewayChannel: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_TEST_CHANNEL, id),
  getGatewayUsers: (channelId: string) => ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_GET_USERS, channelId),
  grantGatewayAccess: (channelId: string, userId: string, displayName?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_GRANT_ACCESS, { channelId, userId, displayName }),
  revokeGatewayAccess: (channelId: string, userId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_REVOKE_ACCESS, { channelId, userId }),
  generateGatewayPairing: (channelId: string, userId: string, displayName?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.GATEWAY_GENERATE_PAIRING, { channelId, userId, displayName }),

  // Gateway event listener
  onGatewayMessage: (callback: (data: any) => void) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on('gateway:message', subscription);
    return () => ipcRenderer.removeListener('gateway:message', subscription);
  },

  // WhatsApp-specific APIs
  getWhatsAppInfo: () => ipcRenderer.invoke('whatsapp:get-info'),
  whatsAppLogout: () => ipcRenderer.invoke('whatsapp:logout'),

  // WhatsApp event listeners
  onWhatsAppQRCode: (callback: (event: any, qr: string) => void) => {
    ipcRenderer.on('whatsapp:qr-code', callback);
  },
  onWhatsAppConnected: (callback: () => void) => {
    ipcRenderer.on('whatsapp:connected', callback);
  },
  onWhatsAppStatus: (callback: (event: any, data: { status: string; error?: string }) => void) => {
    ipcRenderer.on('whatsapp:status', callback);
  },

  // Search Settings APIs
  getSearchSettings: () => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_GET_SETTINGS),
  saveSearchSettings: (settings: any) => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_SAVE_SETTINGS, settings),
  getSearchConfigStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_GET_CONFIG_STATUS),
  testSearchProvider: (providerType: string) => ipcRenderer.invoke(IPC_CHANNELS.SEARCH_TEST_PROVIDER, providerType),

  // App Update APIs
  getAppVersion: () => ipcRenderer.invoke(IPC_CHANNELS.APP_GET_VERSION),
  checkForUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.APP_CHECK_UPDATES),
  downloadUpdate: (updateInfo: any) => ipcRenderer.invoke(IPC_CHANNELS.APP_DOWNLOAD_UPDATE, updateInfo),
  installUpdate: () => ipcRenderer.invoke(IPC_CHANNELS.APP_INSTALL_UPDATE),

  // Update event listeners
  onUpdateProgress: (callback: (progress: any) => void) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.APP_UPDATE_PROGRESS, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_UPDATE_PROGRESS, subscription);
  },
  onUpdateDownloaded: (callback: (info: any) => void) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.APP_UPDATE_DOWNLOADED, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_UPDATE_DOWNLOADED, subscription);
  },
  onUpdateError: (callback: (error: any) => void) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.APP_UPDATE_ERROR, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.APP_UPDATE_ERROR, subscription);
  },

  // Guardrail Settings APIs
  getGuardrailSettings: () => ipcRenderer.invoke(IPC_CHANNELS.GUARDRAIL_GET_SETTINGS),
  saveGuardrailSettings: (settings: any) => ipcRenderer.invoke(IPC_CHANNELS.GUARDRAIL_SAVE_SETTINGS, settings),
  getGuardrailDefaults: () => ipcRenderer.invoke(IPC_CHANNELS.GUARDRAIL_GET_DEFAULTS),

  // Appearance Settings APIs
  getAppearanceSettings: () => ipcRenderer.invoke(IPC_CHANNELS.APPEARANCE_GET_SETTINGS),
  saveAppearanceSettings: (settings: any) => ipcRenderer.invoke(IPC_CHANNELS.APPEARANCE_SAVE_SETTINGS, settings),

  // Personality Settings APIs
  getPersonalitySettings: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_GET_SETTINGS),
  savePersonalitySettings: (settings: any) => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_SAVE_SETTINGS, settings),
  getPersonalityDefinitions: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_GET_DEFINITIONS),
  getPersonaDefinitions: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_GET_PERSONAS),
  getRelationshipStats: () => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_GET_RELATIONSHIP_STATS),
  setActivePersonality: (personalityId: string) => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_SET_ACTIVE, personalityId),
  setActivePersona: (personaId: string) => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_SET_PERSONA, personaId),
  resetPersonalitySettings: (preserveRelationship?: boolean) => ipcRenderer.invoke(IPC_CHANNELS.PERSONALITY_RESET, preserveRelationship),
  onPersonalitySettingsChanged: (callback: (settings: any) => void) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.PERSONALITY_SETTINGS_CHANGED, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.PERSONALITY_SETTINGS_CHANGED, subscription);
  },

  // Queue APIs
  getQueueStatus: () => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_GET_STATUS),
  getQueueSettings: () => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_GET_SETTINGS),
  saveQueueSettings: (settings: any) => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_SAVE_SETTINGS, settings),
  clearQueue: () => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_CLEAR),
  onQueueUpdate: (callback: (status: any) => void) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.QUEUE_UPDATE, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.QUEUE_UPDATE, subscription);
  },

  // Custom Skills APIs
  listCustomSkills: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_LIST),
  listTaskSkills: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_LIST_TASKS),
  listGuidelineSkills: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_LIST_GUIDELINES),
  getCustomSkill: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_GET, id),
  createCustomSkill: (skill: any) => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_CREATE, skill),
  updateCustomSkill: (id: string, updates: any) => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_UPDATE, id, updates),
  deleteCustomSkill: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_DELETE, id),
  reloadCustomSkills: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_RELOAD),
  openCustomSkillsFolder: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_OPEN_FOLDER),

  // Skill Registry (SkillHub) APIs
  searchSkillRegistry: (query: string, options?: { page?: number; pageSize?: number }) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_SEARCH, query, options),
  getSkillDetails: (skillId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_GET_DETAILS, skillId),
  installSkillFromRegistry: (skillId: string, version?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_INSTALL, skillId, version),
  updateSkillFromRegistry: (skillId: string, version?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_UPDATE, skillId, version),
  updateAllSkills: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_UPDATE_ALL),
  uninstallSkill: (skillId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_UNINSTALL, skillId),
  listManagedSkills: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_LIST_MANAGED),
  checkSkillUpdates: (skillId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_CHECK_UPDATES, skillId),
  getSkillStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_GET_STATUS),
  getEligibleSkills: () => ipcRenderer.invoke(IPC_CHANNELS.SKILL_REGISTRY_GET_ELIGIBLE),

  // MCP (Model Context Protocol) APIs
  getMCPSettings: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_SETTINGS),
  saveMCPSettings: (settings: any) => ipcRenderer.invoke(IPC_CHANNELS.MCP_SAVE_SETTINGS, settings),
  addMCPServer: (config: any) => ipcRenderer.invoke(IPC_CHANNELS.MCP_ADD_SERVER, config),
  updateMCPServer: (id: string, updates: any) => ipcRenderer.invoke(IPC_CHANNELS.MCP_UPDATE_SERVER, id, updates),
  removeMCPServer: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_REMOVE_SERVER, id),
  connectMCPServer: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_CONNECT_SERVER, serverId),
  disconnectMCPServer: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_DISCONNECT_SERVER, serverId),
  getMCPStatus: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_STATUS),
  getMCPServerStatus: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_SERVER_STATUS, serverId),
  getMCPAllTools: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_ALL_TOOLS),
  getMCPServerTools: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_GET_SERVER_TOOLS, serverId),
  testMCPServer: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_TEST_SERVER, serverId),

  // MCP Status change event listener
  onMCPStatusChange: (callback: (status: any[]) => void) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.MCP_SERVER_STATUS_CHANGE, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.MCP_SERVER_STATUS_CHANGE, subscription);
  },

  // MCP Registry APIs
  fetchMCPRegistry: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_REGISTRY_FETCH),
  searchMCPRegistry: (query: string, tags?: string[]) =>
    ipcRenderer.invoke(IPC_CHANNELS.MCP_REGISTRY_SEARCH, { query, tags }),
  installMCPServer: (entryId: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_REGISTRY_INSTALL, entryId),
  uninstallMCPServer: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_REGISTRY_UNINSTALL, serverId),
  checkMCPUpdates: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_REGISTRY_CHECK_UPDATES),
  updateMCPServerFromRegistry: (serverId: string) => ipcRenderer.invoke(IPC_CHANNELS.MCP_REGISTRY_UPDATE_SERVER, serverId),

  // MCP Host APIs
  startMCPHost: (port?: number) => ipcRenderer.invoke(IPC_CHANNELS.MCP_HOST_START, port),
  stopMCPHost: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_HOST_STOP),
  getMCPHostStatus: () => ipcRenderer.invoke(IPC_CHANNELS.MCP_HOST_GET_STATUS),

  // Built-in Tools Settings APIs
  getBuiltinToolsSettings: () => ipcRenderer.invoke(IPC_CHANNELS.BUILTIN_TOOLS_GET_SETTINGS),
  saveBuiltinToolsSettings: (settings: BuiltinToolsSettings) => ipcRenderer.invoke(IPC_CHANNELS.BUILTIN_TOOLS_SAVE_SETTINGS, settings),
  getBuiltinToolsCategories: () => ipcRenderer.invoke(IPC_CHANNELS.BUILTIN_TOOLS_GET_CATEGORIES),

  // Tray (Menu Bar) APIs
  getTraySettings: () => ipcRenderer.invoke(IPC_CHANNELS.TRAY_GET_SETTINGS),
  saveTraySettings: (settings: TraySettings) => ipcRenderer.invoke(IPC_CHANNELS.TRAY_SAVE_SETTINGS, settings),

  // Tray event listeners (for renderer to respond to tray actions)
  onTrayNewTask: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.TRAY_NEW_TASK, callback);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TRAY_NEW_TASK, callback);
  },
  onTraySelectWorkspace: (callback: (event: any, workspaceId: string) => void) => {
    ipcRenderer.on(IPC_CHANNELS.TRAY_SELECT_WORKSPACE, callback);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TRAY_SELECT_WORKSPACE, callback);
  },
  onTrayOpenSettings: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.TRAY_OPEN_SETTINGS, callback);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TRAY_OPEN_SETTINGS, callback);
  },
  onTrayOpenAbout: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.TRAY_OPEN_ABOUT, callback);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TRAY_OPEN_ABOUT, callback);
  },
  onTrayCheckUpdates: (callback: () => void) => {
    ipcRenderer.on(IPC_CHANNELS.TRAY_CHECK_UPDATES, callback);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TRAY_CHECK_UPDATES, callback);
  },
  onTrayQuickTask: (callback: (event: any, data: { task: string; workspaceId?: string }) => void) => {
    ipcRenderer.on(IPC_CHANNELS.TRAY_QUICK_TASK, callback);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.TRAY_QUICK_TASK, callback);
  },

  // Quick Input APIs (for the floating quick input window)
  quickInputSubmit: (task: string, workspaceId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.QUICK_INPUT_SUBMIT, task, workspaceId),
  quickInputClose: () => ipcRenderer.invoke(IPC_CHANNELS.QUICK_INPUT_CLOSE),

  // Cron (Scheduled Tasks) APIs
  getCronStatus: () => ipcRenderer.invoke(IPC_CHANNELS.CRON_GET_STATUS),
  listCronJobs: (opts?: { includeDisabled?: boolean }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CRON_LIST_JOBS, opts),
  getCronJob: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CRON_GET_JOB, id),
  addCronJob: (job: CronJobCreate) => ipcRenderer.invoke(IPC_CHANNELS.CRON_ADD_JOB, job),
  updateCronJob: (id: string, patch: CronJobPatch) =>
    ipcRenderer.invoke(IPC_CHANNELS.CRON_UPDATE_JOB, id, patch),
  removeCronJob: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CRON_REMOVE_JOB, id),
  runCronJob: (id: string, mode?: 'due' | 'force') =>
    ipcRenderer.invoke(IPC_CHANNELS.CRON_RUN_JOB, id, mode),
  onCronEvent: (callback: (event: CronEvent) => void) => {
    const subscription = (_: any, data: CronEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.CRON_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CRON_EVENT, subscription);
  },
  getCronRunHistory: (id: string) => ipcRenderer.invoke('cron:getRunHistory', id),
  clearCronRunHistory: (id: string) => ipcRenderer.invoke('cron:clearRunHistory', id),
  getCronWebhookStatus: () => ipcRenderer.invoke('cron:getWebhookStatus'),

  // Notification APIs
  listNotifications: () => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_LIST),
  getUnreadNotificationCount: () => ipcRenderer.invoke('notification:unreadCount'),
  markNotificationRead: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_MARK_READ, id),
  markAllNotificationsRead: () => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_MARK_ALL_READ),
  deleteNotification: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_DELETE, id),
  deleteAllNotifications: () => ipcRenderer.invoke(IPC_CHANNELS.NOTIFICATION_DELETE_ALL),
  onNotificationEvent: (callback: (event: NotificationEvent) => void) => {
    const subscription = (_: any, data: NotificationEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.NOTIFICATION_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.NOTIFICATION_EVENT, subscription);
  },

  // Hooks (Webhooks & Gmail Pub/Sub) APIs
  getHooksSettings: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_GET_SETTINGS),
  saveHooksSettings: (settings: Partial<HooksSettings>) => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_SAVE_SETTINGS, settings),
  enableHooks: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_ENABLE),
  disableHooks: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_DISABLE),
  regenerateHookToken: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_REGENERATE_TOKEN),
  getHooksStatus: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_GET_STATUS),
  addHookMapping: (mapping: HookMapping) => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_ADD_MAPPING, mapping),
  removeHookMapping: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_REMOVE_MAPPING, id),
  configureGmailHooks: (config: GmailHooksConfig) => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_CONFIGURE_GMAIL, config),
  getGmailHooksStatus: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_GET_GMAIL_STATUS),
  startGmailWatcher: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_START_GMAIL_WATCHER),
  stopGmailWatcher: () => ipcRenderer.invoke(IPC_CHANNELS.HOOKS_STOP_GMAIL_WATCHER),
  onHooksEvent: (callback: (event: HooksEvent) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: HooksEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.HOOKS_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.HOOKS_EVENT, subscription);
  },

  // Control Plane (WebSocket Gateway)
  getControlPlaneSettings: () => ipcRenderer.invoke(IPC_CHANNELS.CONTROL_PLANE_GET_SETTINGS),
  saveControlPlaneSettings: (settings: ControlPlaneSettingsData) => ipcRenderer.invoke(IPC_CHANNELS.CONTROL_PLANE_SAVE_SETTINGS, settings),
  enableControlPlane: () => ipcRenderer.invoke(IPC_CHANNELS.CONTROL_PLANE_ENABLE),
  disableControlPlane: () => ipcRenderer.invoke(IPC_CHANNELS.CONTROL_PLANE_DISABLE),
  startControlPlane: () => ipcRenderer.invoke(IPC_CHANNELS.CONTROL_PLANE_START),
  stopControlPlane: () => ipcRenderer.invoke(IPC_CHANNELS.CONTROL_PLANE_STOP),
  getControlPlaneStatus: () => ipcRenderer.invoke(IPC_CHANNELS.CONTROL_PLANE_GET_STATUS),
  regenerateControlPlaneToken: () => ipcRenderer.invoke(IPC_CHANNELS.CONTROL_PLANE_REGENERATE_TOKEN),
  onControlPlaneEvent: (callback: (event: ControlPlaneEvent) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: ControlPlaneEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.CONTROL_PLANE_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CONTROL_PLANE_EVENT, subscription);
  },

  // Tailscale
  checkTailscaleAvailability: () => ipcRenderer.invoke(IPC_CHANNELS.TAILSCALE_CHECK_AVAILABILITY),
  getTailscaleStatus: () => ipcRenderer.invoke(IPC_CHANNELS.TAILSCALE_GET_STATUS),
  setTailscaleMode: (mode: TailscaleMode) => ipcRenderer.invoke(IPC_CHANNELS.TAILSCALE_SET_MODE, mode),

  // Remote Gateway
  connectRemoteGateway: (config?: RemoteGatewayConfig) => ipcRenderer.invoke(IPC_CHANNELS.REMOTE_GATEWAY_CONNECT, config),
  disconnectRemoteGateway: () => ipcRenderer.invoke(IPC_CHANNELS.REMOTE_GATEWAY_DISCONNECT),
  getRemoteGatewayStatus: () => ipcRenderer.invoke(IPC_CHANNELS.REMOTE_GATEWAY_GET_STATUS),
  saveRemoteGatewayConfig: (config: RemoteGatewayConfig) => ipcRenderer.invoke(IPC_CHANNELS.REMOTE_GATEWAY_SAVE_CONFIG, config),
  testRemoteGatewayConnection: (config: RemoteGatewayConfig) => ipcRenderer.invoke(IPC_CHANNELS.REMOTE_GATEWAY_TEST_CONNECTION, config),
  onRemoteGatewayEvent: (callback: (event: RemoteGatewayEvent) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: RemoteGatewayEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.REMOTE_GATEWAY_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.REMOTE_GATEWAY_EVENT, subscription);
  },

  // SSH Tunnel
  connectSSHTunnel: (config: SSHTunnelConfig) => ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_CONNECT, config),
  disconnectSSHTunnel: () => ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_DISCONNECT),
  getSSHTunnelStatus: () => ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_GET_STATUS),
  saveSSHTunnelConfig: (config: SSHTunnelConfig) => ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_SAVE_CONFIG, config),
  testSSHTunnelConnection: (config: SSHTunnelConfig) => ipcRenderer.invoke(IPC_CHANNELS.SSH_TUNNEL_TEST_CONNECTION, config),
  onSSHTunnelEvent: (callback: (event: SSHTunnelEvent) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: SSHTunnelEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.SSH_TUNNEL_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.SSH_TUNNEL_EVENT, subscription);
  },

  // Live Canvas APIs
  canvasCreate: (data: { taskId: string; workspaceId: string; title?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_CREATE, data),
  canvasGetSession: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_GET_SESSION, sessionId),
  canvasListSessions: (taskId?: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_LIST_SESSIONS, taskId),
  canvasShow: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_SHOW, sessionId),
  canvasHide: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_HIDE, sessionId),
  canvasClose: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_CLOSE, sessionId),
  canvasPush: (data: { sessionId: string; content: string; filename?: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_PUSH, data),
  canvasEval: (data: { sessionId: string; script: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_EVAL, data),
  canvasSnapshot: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_SNAPSHOT, sessionId),
  canvasExportHTML: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_EXPORT_HTML, sessionId),
  canvasExportToFolder: (data: { sessionId: string; targetDir: string }) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_EXPORT_TO_FOLDER, data),
  canvasOpenInBrowser: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_OPEN_IN_BROWSER, sessionId),
  canvasGetSessionDir: (sessionId: string) =>
    ipcRenderer.invoke(IPC_CHANNELS.CANVAS_GET_SESSION_DIR, sessionId),
  onCanvasEvent: (callback: (event: CanvasEvent) => void) => {
    const subscription = (_: Electron.IpcRendererEvent, data: CanvasEvent) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.CANVAS_EVENT, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.CANVAS_EVENT, subscription);
  },
});

// Type declarations for TypeScript
export interface FileViewerResult {
  success: boolean;
  data?: {
    path: string;
    fileName: string;
    fileType: 'markdown' | 'code' | 'text' | 'docx' | 'pdf' | 'image' | 'pptx' | 'unsupported';
    content: string | null;
    htmlContent?: string;
    size: number;
  };
  error?: string;
}

export type { TraySettings };

export interface ElectronAPI {
  selectFolder: () => Promise<string | null>;
  openFile: (filePath: string, workspacePath?: string) => Promise<string>;
  showInFinder: (filePath: string, workspacePath?: string) => Promise<void>;
  readFileForViewer: (filePath: string, workspacePath: string) => Promise<FileViewerResult>;
  openExternal: (url: string) => Promise<void>;
  createTask: (data: any) => Promise<any>;
  getTask: (id: string) => Promise<any>;
  listTasks: () => Promise<any[]>;
  cancelTask: (id: string) => Promise<void>;
  pauseTask: (id: string) => Promise<void>;
  resumeTask: (id: string) => Promise<void>;
  sendStdin: (taskId: string, input: string) => Promise<boolean>;
  killCommand: (taskId: string, force?: boolean) => Promise<boolean>;
  renameTask: (id: string, title: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  onTaskEvent: (callback: (event: any) => void) => () => void;
  getTaskEvents: (taskId: string) => Promise<any[]>;
  sendMessage: (taskId: string, message: string) => Promise<void>;
  createWorkspace: (data: any) => Promise<any>;
  listWorkspaces: () => Promise<any[]>;
  selectWorkspace: (id: string) => Promise<any>;
  getTempWorkspace: () => Promise<any>;
  updateWorkspacePermissions: (id: string, permissions: { shell?: boolean; network?: boolean }) => Promise<any>;
  respondToApproval: (data: any) => Promise<void>;
  listArtifacts: (taskId: string) => Promise<any[]>;
  previewArtifact: (id: string) => Promise<any>;
  listSkills: () => Promise<any[]>;
  getSkill: (id: string) => Promise<any>;
  // LLM Settings
  getLLMSettings: () => Promise<any>;
  saveLLMSettings: (settings: any) => Promise<{ success: boolean }>;
  testLLMProvider: (config: any) => Promise<{ success: boolean; error?: string }>;
  getLLMModels: () => Promise<Array<{ key: string; displayName: string; description: string }>>;
  getLLMConfigStatus: () => Promise<{
    currentProvider: 'anthropic' | 'bedrock' | 'ollama';
    currentModel: string;
    providers: Array<{ type: 'anthropic' | 'bedrock' | 'ollama'; name: string; configured: boolean; source?: string }>;
    models: Array<{ key: string; displayName: string; description: string }>;
  }>;
  getOllamaModels: (baseUrl?: string) => Promise<Array<{ name: string; size: number; modified: string }>>;
  getGeminiModels: (apiKey?: string) => Promise<Array<{ name: string; displayName: string; description: string }>>;
  getOpenRouterModels: (apiKey?: string) => Promise<Array<{ id: string; name: string; context_length: number }>>;
  getOpenAIModels: (apiKey?: string) => Promise<Array<{ id: string; name: string; description: string }>>;
  openaiOAuthStart: () => Promise<{ success: boolean; error?: string }>;
  openaiOAuthLogout: () => Promise<{ success: boolean }>;
  getBedrockModels: (config?: { region?: string; accessKeyId?: string; secretAccessKey?: string; profile?: string }) => Promise<Array<{ id: string; name: string; provider: string; description: string }>>;
  // Gateway / Channel APIs
  getGatewayChannels: () => Promise<any[]>;
  addGatewayChannel: (data: { type: string; name: string; botToken?: string; securityMode?: string; applicationId?: string; guildIds?: string[]; appToken?: string; signingSecret?: string; allowedNumbers?: string[]; selfChatMode?: boolean; responsePrefix?: string; cliPath?: string; dbPath?: string; allowedContacts?: string[]; dmPolicy?: string; groupPolicy?: string }) => Promise<any>;
  updateGatewayChannel: (data: { id: string; name?: string; securityMode?: string; config?: { selfChatMode?: boolean; responsePrefix?: string; [key: string]: unknown } }) => Promise<void>;
  removeGatewayChannel: (id: string) => Promise<void>;
  enableGatewayChannel: (id: string) => Promise<void>;
  disableGatewayChannel: (id: string) => Promise<void>;
  testGatewayChannel: (id: string) => Promise<{ success: boolean; error?: string; botUsername?: string }>;
  getGatewayUsers: (channelId: string) => Promise<any[]>;
  grantGatewayAccess: (channelId: string, userId: string, displayName?: string) => Promise<void>;
  revokeGatewayAccess: (channelId: string, userId: string) => Promise<void>;
  generateGatewayPairing: (channelId: string, userId: string, displayName?: string) => Promise<string>;
  onGatewayMessage: (callback: (data: any) => void) => () => void;
  // WhatsApp-specific APIs
  getWhatsAppInfo: () => Promise<{ qrCode?: string; phoneNumber?: string; status?: string }>;
  whatsAppLogout: () => Promise<void>;
  onWhatsAppQRCode: (callback: (event: any, qr: string) => void) => void;
  onWhatsAppConnected: (callback: () => void) => void;
  onWhatsAppStatus: (callback: (event: any, data: { status: string; error?: string }) => void) => void;
  // Search Settings
  getSearchSettings: () => Promise<{
    primaryProvider: 'tavily' | 'brave' | 'serpapi' | 'google' | null;
    fallbackProvider: 'tavily' | 'brave' | 'serpapi' | 'google' | null;
  }>;
  saveSearchSettings: (settings: any) => Promise<{ success: boolean }>;
  getSearchConfigStatus: () => Promise<{
    primaryProvider: 'tavily' | 'brave' | 'serpapi' | 'google' | null;
    fallbackProvider: 'tavily' | 'brave' | 'serpapi' | 'google' | null;
    providers: Array<{
      type: 'tavily' | 'brave' | 'serpapi' | 'google';
      name: string;
      description: string;
      configured: boolean;
      supportedTypes: Array<'web' | 'news' | 'images'>;
    }>;
    isConfigured: boolean;
  }>;
  testSearchProvider: (providerType: string) => Promise<{ success: boolean; error?: string }>;
  // App Updates
  getAppVersion: () => Promise<{
    version: string;
    isDev: boolean;
    isGitRepo: boolean;
    gitBranch?: string;
    gitCommit?: string;
  }>;
  checkForUpdates: () => Promise<{
    available: boolean;
    currentVersion: string;
    latestVersion: string;
    releaseNotes?: string;
    releaseUrl?: string;
    publishedAt?: string;
    updateMode: 'git' | 'electron-updater';
  }>;
  downloadUpdate: (updateInfo: any) => Promise<{ success: boolean }>;
  installUpdate: () => Promise<{ success: boolean }>;
  onUpdateProgress: (callback: (progress: {
    phase: 'checking' | 'downloading' | 'extracting' | 'installing' | 'complete' | 'error';
    percent?: number;
    message: string;
    bytesDownloaded?: number;
    bytesTotal?: number;
  }) => void) => () => void;
  onUpdateDownloaded: (callback: (info: { requiresRestart: boolean; message: string }) => void) => () => void;
  onUpdateError: (callback: (error: { error: string }) => void) => () => void;
  // Guardrail Settings
  getGuardrailSettings: () => Promise<{
    maxTokensPerTask: number;
    tokenBudgetEnabled: boolean;
    maxCostPerTask: number;
    costBudgetEnabled: boolean;
    blockDangerousCommands: boolean;
    customBlockedPatterns: string[];
    autoApproveTrustedCommands: boolean;
    trustedCommandPatterns: string[];
    maxFileSizeMB: number;
    fileSizeLimitEnabled: boolean;
    enforceAllowedDomains: boolean;
    allowedDomains: string[];
    maxIterationsPerTask: number;
    iterationLimitEnabled: boolean;
  }>;
  saveGuardrailSettings: (settings: any) => Promise<{ success: boolean }>;
  getGuardrailDefaults: () => Promise<{
    maxTokensPerTask: number;
    tokenBudgetEnabled: boolean;
    maxCostPerTask: number;
    costBudgetEnabled: boolean;
    blockDangerousCommands: boolean;
    customBlockedPatterns: string[];
    autoApproveTrustedCommands: boolean;
    trustedCommandPatterns: string[];
    maxFileSizeMB: number;
    fileSizeLimitEnabled: boolean;
    enforceAllowedDomains: boolean;
    allowedDomains: string[];
    maxIterationsPerTask: number;
    iterationLimitEnabled: boolean;
  }>;
  // Appearance Settings
  getAppearanceSettings: () => Promise<{
    themeMode: 'light' | 'dark' | 'system';
    accentColor: 'cyan' | 'blue' | 'purple' | 'pink' | 'rose' | 'orange' | 'green' | 'teal';
    disclaimerAccepted?: boolean;
  }>;
  saveAppearanceSettings: (settings: {
    themeMode?: 'light' | 'dark' | 'system';
    accentColor?: 'cyan' | 'blue' | 'purple' | 'pink' | 'rose' | 'orange' | 'green' | 'teal';
    disclaimerAccepted?: boolean;
  }) => Promise<{ success: boolean }>;
  // Personality Settings
  getPersonalitySettings: () => Promise<{
    activePersonality: 'professional' | 'friendly' | 'concise' | 'creative' | 'technical' | 'casual' | 'custom';
    customPrompt?: string;
    customName?: string;
    agentName?: string;
    activePersona?: 'none' | 'jarvis' | 'friday' | 'hal' | 'computer' | 'alfred' | 'intern' | 'sensei' | 'pirate' | 'noir';
    responseStyle?: {
      emojiUsage: 'none' | 'minimal' | 'moderate' | 'expressive';
      responseLength: 'terse' | 'balanced' | 'detailed';
      codeCommentStyle: 'minimal' | 'moderate' | 'verbose';
      explanationDepth: 'expert' | 'balanced' | 'teaching';
    };
    quirks?: {
      catchphrase?: string;
      signOff?: string;
      analogyDomain: 'none' | 'cooking' | 'sports' | 'space' | 'music' | 'nature' | 'gaming' | 'movies' | 'construction';
    };
    relationship?: {
      userName?: string;
      tasksCompleted: number;
      firstInteraction?: number;
      lastMilestoneCelebrated: number;
      projectsWorkedOn: string[];
    };
  }>;
  savePersonalitySettings: (settings: {
    activePersonality?: 'professional' | 'friendly' | 'concise' | 'creative' | 'technical' | 'casual' | 'custom';
    customPrompt?: string;
    customName?: string;
    agentName?: string;
    activePersona?: 'none' | 'jarvis' | 'friday' | 'hal' | 'computer' | 'alfred' | 'intern' | 'sensei' | 'pirate' | 'noir';
    responseStyle?: {
      emojiUsage?: 'none' | 'minimal' | 'moderate' | 'expressive';
      responseLength?: 'terse' | 'balanced' | 'detailed';
      codeCommentStyle?: 'minimal' | 'moderate' | 'verbose';
      explanationDepth?: 'expert' | 'balanced' | 'teaching';
    };
    quirks?: {
      catchphrase?: string;
      signOff?: string;
      analogyDomain?: 'none' | 'cooking' | 'sports' | 'space' | 'music' | 'nature' | 'gaming' | 'movies' | 'construction';
    };
    relationship?: {
      userName?: string;
      tasksCompleted?: number;
      firstInteraction?: number;
      lastMilestoneCelebrated?: number;
      projectsWorkedOn?: string[];
    };
  }) => Promise<{ success: boolean }>;
  getPersonalityDefinitions: () => Promise<Array<{
    id: 'professional' | 'friendly' | 'concise' | 'creative' | 'technical' | 'casual' | 'custom';
    name: string;
    description: string;
    icon: string;
    traits: string[];
    promptTemplate: string;
  }>>;
  getPersonaDefinitions: () => Promise<Array<{
    id: 'none' | 'jarvis' | 'friday' | 'hal' | 'computer' | 'alfred' | 'intern' | 'sensei' | 'pirate' | 'noir';
    name: string;
    description: string;
    icon: string;
    promptTemplate: string;
    suggestedName?: string;
    sampleCatchphrase?: string;
    sampleSignOff?: string;
  }>>;
  getRelationshipStats: () => Promise<{
    tasksCompleted: number;
    projectsCount: number;
    daysTogether: number;
    nextMilestone: number | null;
  }>;
  setActivePersonality: (personalityId: string) => Promise<{ success: boolean }>;
  setActivePersona: (personaId: string) => Promise<{ success: boolean }>;
  resetPersonalitySettings: (preserveRelationship?: boolean) => Promise<{ success: boolean }>;
  onPersonalitySettingsChanged: (callback: (settings: any) => void) => () => void;
  // Queue APIs
  getQueueStatus: () => Promise<{
    runningCount: number;
    queuedCount: number;
    runningTaskIds: string[];
    queuedTaskIds: string[];
    maxConcurrent: number;
  }>;
  getQueueSettings: () => Promise<{
    maxConcurrentTasks: number;
    taskTimeoutMinutes: number;
  }>;
  saveQueueSettings: (settings: { maxConcurrentTasks?: number; taskTimeoutMinutes?: number }) => Promise<{ success: boolean }>;
  clearQueue: () => Promise<{ success: boolean; clearedRunning: number; clearedQueued: number }>;
  onQueueUpdate: (callback: (status: {
    runningCount: number;
    queuedCount: number;
    runningTaskIds: string[];
    queuedTaskIds: string[];
    maxConcurrent: number;
  }) => void) => () => void;
  // Custom Skills APIs
  listCustomSkills: () => Promise<CustomSkill[]>;
  listTaskSkills: () => Promise<CustomSkill[]>;
  listGuidelineSkills: () => Promise<CustomSkill[]>;
  getCustomSkill: (id: string) => Promise<CustomSkill | undefined>;
  createCustomSkill: (skill: Omit<CustomSkill, 'filePath'>) => Promise<CustomSkill>;
  updateCustomSkill: (id: string, updates: Partial<CustomSkill>) => Promise<CustomSkill>;
  deleteCustomSkill: (id: string) => Promise<boolean>;
  reloadCustomSkills: () => Promise<CustomSkill[]>;
  openCustomSkillsFolder: () => Promise<void>;
  // Skill Registry (SkillHub) APIs
  searchSkillRegistry: (query: string, options?: { page?: number; pageSize?: number }) => Promise<SkillSearchResult>;
  getSkillDetails: (skillId: string) => Promise<SkillRegistryEntry | null>;
  installSkillFromRegistry: (skillId: string, version?: string) => Promise<{ success: boolean; skill?: CustomSkill; error?: string }>;
  updateSkillFromRegistry: (skillId: string, version?: string) => Promise<{ success: boolean; skill?: CustomSkill; error?: string }>;
  updateAllSkills: () => Promise<{ updated: string[]; failed: string[] }>;
  uninstallSkill: (skillId: string) => Promise<{ success: boolean; error?: string }>;
  listManagedSkills: () => Promise<CustomSkill[]>;
  checkSkillUpdates: (skillId: string) => Promise<{ hasUpdate: boolean; currentVersion: string | null; latestVersion: string | null }>;
  getSkillStatus: () => Promise<SkillStatusReport>;
  getEligibleSkills: () => Promise<CustomSkill[]>;
  // MCP (Model Context Protocol)
  getMCPSettings: () => Promise<MCPSettings>;
  saveMCPSettings: (settings: MCPSettings) => Promise<{ success: boolean }>;
  addMCPServer: (config: Omit<MCPServerConfig, 'id'>) => Promise<MCPServerConfig>;
  updateMCPServer: (id: string, updates: Partial<MCPServerConfig>) => Promise<MCPServerConfig>;
  removeMCPServer: (id: string) => Promise<void>;
  connectMCPServer: (serverId: string) => Promise<void>;
  disconnectMCPServer: (serverId: string) => Promise<void>;
  getMCPStatus: () => Promise<MCPServerStatus[]>;
  getMCPServerStatus: (serverId: string) => Promise<MCPServerStatus | null>;
  getMCPAllTools: () => Promise<MCPTool[]>;
  getMCPServerTools: (serverId: string) => Promise<MCPTool[]>;
  testMCPServer: (serverId: string) => Promise<{ success: boolean; error?: string; tools?: number }>;
  onMCPStatusChange: (callback: (status: MCPServerStatus[]) => void) => () => void;
  // MCP Registry
  fetchMCPRegistry: () => Promise<MCPRegistry>;
  searchMCPRegistry: (query: string, tags?: string[]) => Promise<MCPRegistryEntry[]>;
  installMCPServer: (entryId: string) => Promise<MCPServerConfig>;
  uninstallMCPServer: (serverId: string) => Promise<void>;
  checkMCPUpdates: () => Promise<MCPUpdateInfo[]>;
  updateMCPServerFromRegistry: (serverId: string) => Promise<MCPServerConfig>;
  // MCP Host
  startMCPHost: (port?: number) => Promise<{ success: boolean; port?: number }>;
  stopMCPHost: () => Promise<void>;
  getMCPHostStatus: () => Promise<{ running: boolean; port?: number }>;
  // Built-in Tools Settings
  getBuiltinToolsSettings: () => Promise<BuiltinToolsSettings>;
  saveBuiltinToolsSettings: (settings: BuiltinToolsSettings) => Promise<{ success: boolean }>;
  getBuiltinToolsCategories: () => Promise<Record<string, string[]>>;
  // Tray (Menu Bar)
  getTraySettings: () => Promise<TraySettings>;
  saveTraySettings: (settings: Partial<TraySettings>) => Promise<{ success: boolean }>;
  onTrayNewTask: (callback: () => void) => () => void;
  onTraySelectWorkspace: (callback: (event: any, workspaceId: string) => void) => () => void;
  onTrayOpenSettings: (callback: () => void) => () => void;
  onTrayOpenAbout: (callback: () => void) => () => void;
  onTrayCheckUpdates: (callback: () => void) => () => void;
  // Cron (Scheduled Tasks)
  getCronStatus: () => Promise<CronStatusSummary>;
  listCronJobs: (opts?: { includeDisabled?: boolean }) => Promise<CronJob[]>;
  getCronJob: (id: string) => Promise<CronJob | null>;
  addCronJob: (job: CronJobCreate) => Promise<{ ok: true; job: CronJob } | { ok: false; error: string }>;
  updateCronJob: (id: string, patch: CronJobPatch) => Promise<{ ok: true; job: CronJob } | { ok: false; error: string }>;
  removeCronJob: (id: string) => Promise<{ ok: true; removed: boolean } | { ok: false; removed: false; error: string }>;
  runCronJob: (id: string, mode?: 'due' | 'force') => Promise<
    | { ok: true; ran: true; taskId: string }
    | { ok: true; ran: false; reason: 'not-due' | 'disabled' | 'not-found' }
    | { ok: false; error: string }
  >;
  onCronEvent: (callback: (event: CronEvent) => void) => () => void;
  getCronRunHistory: (id: string) => Promise<CronRunHistoryResult | null>;
  clearCronRunHistory: (id: string) => Promise<boolean>;
  getCronWebhookStatus: () => Promise<CronWebhookStatus>;
  // Notifications
  listNotifications: () => Promise<AppNotification[]>;
  getUnreadNotificationCount: () => Promise<number>;
  markNotificationRead: (id: string) => Promise<AppNotification | null>;
  markAllNotificationsRead: () => Promise<void>;
  deleteNotification: (id: string) => Promise<boolean>;
  deleteAllNotifications: () => Promise<void>;
  onNotificationEvent: (callback: (event: NotificationEvent) => void) => () => void;
  // Hooks (Webhooks & Gmail Pub/Sub)
  getHooksSettings: () => Promise<HooksSettings>;
  saveHooksSettings: (settings: Partial<HooksSettings>) => Promise<HooksSettings>;
  enableHooks: () => Promise<{ enabled: boolean; gmailWatcherError?: string }>;
  disableHooks: () => Promise<{ enabled: boolean }>;
  regenerateHookToken: () => Promise<{ token: string }>;
  getHooksStatus: () => Promise<HooksStatus>;
  addHookMapping: (mapping: HookMapping) => Promise<{ ok: boolean }>;
  removeHookMapping: (id: string) => Promise<{ ok: boolean }>;
  configureGmailHooks: (config: GmailHooksConfig) => Promise<{ ok: boolean; gmail?: GmailHooksConfig }>;
  getGmailHooksStatus: () => Promise<GmailHooksStatus>;
  startGmailWatcher: () => Promise<{ ok: boolean; error?: string }>;
  stopGmailWatcher: () => Promise<{ ok: boolean }>;
  onHooksEvent: (callback: (event: HooksEvent) => void) => () => void;

  // Control Plane (WebSocket Gateway)
  getControlPlaneSettings: () => Promise<ControlPlaneSettingsData>;
  saveControlPlaneSettings: (settings: Partial<ControlPlaneSettingsData>) => Promise<{ ok: boolean; error?: string }>;
  enableControlPlane: () => Promise<{ ok: boolean; token?: string; error?: string }>;
  disableControlPlane: () => Promise<{ ok: boolean; error?: string }>;
  startControlPlane: () => Promise<{
    ok: boolean;
    address?: { host: string; port: number; wsUrl: string };
    tailscale?: { httpsUrl?: string; wssUrl?: string };
    error?: string;
  }>;
  stopControlPlane: () => Promise<{ ok: boolean; error?: string }>;
  getControlPlaneStatus: () => Promise<ControlPlaneStatus>;
  regenerateControlPlaneToken: () => Promise<{ ok: boolean; token?: string; error?: string }>;
  onControlPlaneEvent: (callback: (event: ControlPlaneEvent) => void) => () => void;

  // Tailscale
  checkTailscaleAvailability: () => Promise<TailscaleAvailability>;
  getTailscaleStatus: () => Promise<{ settings: any; exposure: any }>;
  setTailscaleMode: (mode: TailscaleMode) => Promise<{ ok: boolean; error?: string }>;

  // Remote Gateway
  connectRemoteGateway: (config?: RemoteGatewayConfig) => Promise<{ ok: boolean; error?: string }>;
  disconnectRemoteGateway: () => Promise<{ ok: boolean; error?: string }>;
  getRemoteGatewayStatus: () => Promise<RemoteGatewayStatus>;
  saveRemoteGatewayConfig: (config: RemoteGatewayConfig) => Promise<{ ok: boolean; error?: string }>;
  testRemoteGatewayConnection: (config: RemoteGatewayConfig) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  onRemoteGatewayEvent: (callback: (event: RemoteGatewayEvent) => void) => () => void;

  // SSH Tunnel
  connectSSHTunnel: (config: SSHTunnelConfig) => Promise<{ ok: boolean; error?: string }>;
  disconnectSSHTunnel: () => Promise<{ ok: boolean; error?: string }>;
  getSSHTunnelStatus: () => Promise<SSHTunnelStatus>;
  saveSSHTunnelConfig: (config: SSHTunnelConfig) => Promise<{ ok: boolean; error?: string }>;
  testSSHTunnelConnection: (config: SSHTunnelConfig) => Promise<{ ok: boolean; latencyMs?: number; error?: string }>;
  onSSHTunnelEvent: (callback: (event: SSHTunnelEvent) => void) => () => void;

  // Live Canvas APIs
  canvasCreate: (data: { taskId: string; workspaceId: string; title?: string }) => Promise<CanvasSession>;
  canvasGetSession: (sessionId: string) => Promise<CanvasSession | null>;
  canvasListSessions: (taskId?: string) => Promise<CanvasSession[]>;
  canvasShow: (sessionId: string) => Promise<{ success: boolean }>;
  canvasHide: (sessionId: string) => Promise<{ success: boolean }>;
  canvasClose: (sessionId: string) => Promise<{ success: boolean }>;
  canvasPush: (data: { sessionId: string; content: string; filename?: string }) => Promise<{ success: boolean }>;
  canvasEval: (data: { sessionId: string; script: string }) => Promise<{ result: unknown }>;
  canvasSnapshot: (sessionId: string) => Promise<{ imageBase64: string; width: number; height: number }>;
  canvasExportHTML: (sessionId: string) => Promise<{ content: string; filename: string }>;
  canvasExportToFolder: (data: { sessionId: string; targetDir: string }) => Promise<{ files: string[]; targetDir: string }>;
  canvasOpenInBrowser: (sessionId: string) => Promise<{ success: boolean; path: string }>;
  canvasGetSessionDir: (sessionId: string) => Promise<string | null>;
  onCanvasEvent: (callback: (event: CanvasEvent) => void) => () => void;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
