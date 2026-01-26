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
} as const;

// Expose protected methods that allow the renderer process to use ipcRenderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Dialog APIs
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),

  // File APIs
  openFile: (filePath: string, workspacePath?: string) => ipcRenderer.invoke('file:open', filePath, workspacePath),
  showInFinder: (filePath: string, workspacePath?: string) => ipcRenderer.invoke('file:showInFinder', filePath, workspacePath),

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
});

// Type declarations for TypeScript
export interface ElectronAPI {
  selectFolder: () => Promise<string | null>;
  openFile: (filePath: string, workspacePath?: string) => Promise<string>;
  showInFinder: (filePath: string, workspacePath?: string) => Promise<void>;
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
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
