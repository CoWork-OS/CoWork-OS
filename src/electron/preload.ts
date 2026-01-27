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
  WORKSPACE_SELECT: 'workspace:select',
  WORKSPACE_LIST: 'workspace:list',
  WORKSPACE_CREATE: 'workspace:create',
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
  // Custom User Skills
  CUSTOM_SKILL_LIST: 'customSkill:list',
  CUSTOM_SKILL_GET: 'customSkill:get',
  CUSTOM_SKILL_CREATE: 'customSkill:create',
  CUSTOM_SKILL_UPDATE: 'customSkill:update',
  CUSTOM_SKILL_DELETE: 'customSkill:delete',
  CUSTOM_SKILL_RELOAD: 'customSkill:reload',
  CUSTOM_SKILL_OPEN_FOLDER: 'customSkill:openFolder',
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

// Expose protected methods that allow the renderer process to use ipcRenderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Dialog APIs
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),

  // File APIs
  openFile: (filePath: string, workspacePath?: string) => ipcRenderer.invoke('file:open', filePath, workspacePath),
  showInFinder: (filePath: string, workspacePath?: string) => ipcRenderer.invoke('file:showInFinder', filePath, workspacePath),

  // Shell APIs
  openExternal: (url: string) => ipcRenderer.invoke('shell:openExternal', url),

  // Task APIs
  createTask: (data: any) => ipcRenderer.invoke(IPC_CHANNELS.TASK_CREATE, data),
  getTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_GET, id),
  listTasks: () => ipcRenderer.invoke(IPC_CHANNELS.TASK_LIST),
  cancelTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_CANCEL, id),
  pauseTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_PAUSE, id),
  resumeTask: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.TASK_RESUME, id),
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

  // Queue APIs
  getQueueStatus: () => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_GET_STATUS),
  getQueueSettings: () => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_GET_SETTINGS),
  saveQueueSettings: (settings: any) => ipcRenderer.invoke(IPC_CHANNELS.QUEUE_SAVE_SETTINGS, settings),
  onQueueUpdate: (callback: (status: any) => void) => {
    const subscription = (_: any, data: any) => callback(data);
    ipcRenderer.on(IPC_CHANNELS.QUEUE_UPDATE, subscription);
    return () => ipcRenderer.removeListener(IPC_CHANNELS.QUEUE_UPDATE, subscription);
  },

  // Custom Skills APIs
  listCustomSkills: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_LIST),
  getCustomSkill: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_GET, id),
  createCustomSkill: (skill: any) => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_CREATE, skill),
  updateCustomSkill: (id: string, updates: any) => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_UPDATE, id, updates),
  deleteCustomSkill: (id: string) => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_DELETE, id),
  reloadCustomSkills: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_RELOAD),
  openCustomSkillsFolder: () => ipcRenderer.invoke(IPC_CHANNELS.CUSTOM_SKILL_OPEN_FOLDER),

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
});

// Type declarations for TypeScript
export interface ElectronAPI {
  selectFolder: () => Promise<string | null>;
  openFile: (filePath: string, workspacePath?: string) => Promise<string>;
  showInFinder: (filePath: string, workspacePath?: string) => Promise<void>;
  openExternal: (url: string) => Promise<void>;
  createTask: (data: any) => Promise<any>;
  getTask: (id: string) => Promise<any>;
  listTasks: () => Promise<any[]>;
  cancelTask: (id: string) => Promise<void>;
  pauseTask: (id: string) => Promise<void>;
  resumeTask: (id: string) => Promise<void>;
  renameTask: (id: string, title: string) => Promise<void>;
  deleteTask: (id: string) => Promise<void>;
  onTaskEvent: (callback: (event: any) => void) => () => void;
  getTaskEvents: (taskId: string) => Promise<any[]>;
  sendMessage: (taskId: string, message: string) => Promise<void>;
  createWorkspace: (data: any) => Promise<any>;
  listWorkspaces: () => Promise<any[]>;
  selectWorkspace: (id: string) => Promise<any>;
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
  getBedrockModels: (config?: { region?: string; accessKeyId?: string; secretAccessKey?: string; profile?: string }) => Promise<Array<{ id: string; name: string; provider: string; description: string }>>;
  // Gateway / Channel APIs
  getGatewayChannels: () => Promise<any[]>;
  addGatewayChannel: (data: { type: string; name: string; botToken: string; securityMode?: string; applicationId?: string; guildIds?: string[] }) => Promise<any>;
  updateGatewayChannel: (data: { id: string; name?: string; securityMode?: string }) => Promise<void>;
  removeGatewayChannel: (id: string) => Promise<void>;
  enableGatewayChannel: (id: string) => Promise<void>;
  disableGatewayChannel: (id: string) => Promise<void>;
  testGatewayChannel: (id: string) => Promise<{ success: boolean; error?: string; botUsername?: string }>;
  getGatewayUsers: (channelId: string) => Promise<any[]>;
  grantGatewayAccess: (channelId: string, userId: string, displayName?: string) => Promise<void>;
  revokeGatewayAccess: (channelId: string, userId: string) => Promise<void>;
  generateGatewayPairing: (channelId: string, userId: string, displayName?: string) => Promise<string>;
  onGatewayMessage: (callback: (data: any) => void) => () => void;
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
  }>;
  saveQueueSettings: (settings: { maxConcurrentTasks?: number }) => Promise<{ success: boolean }>;
  onQueueUpdate: (callback: (status: {
    runningCount: number;
    queuedCount: number;
    runningTaskIds: string[];
    queuedTaskIds: string[];
    maxConcurrent: number;
  }) => void) => () => void;
  // Custom Skills APIs
  listCustomSkills: () => Promise<CustomSkill[]>;
  getCustomSkill: (id: string) => Promise<CustomSkill | undefined>;
  createCustomSkill: (skill: Omit<CustomSkill, 'filePath'>) => Promise<CustomSkill>;
  updateCustomSkill: (id: string, updates: Partial<CustomSkill>) => Promise<CustomSkill>;
  deleteCustomSkill: (id: string) => Promise<boolean>;
  reloadCustomSkills: () => Promise<CustomSkill[]>;
  openCustomSkillsFolder: () => Promise<void>;
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
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
