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
} as const;

// Expose protected methods that allow the renderer process to use ipcRenderer
contextBridge.exposeInMainWorld('electronAPI', {
  // Dialog APIs
  selectFolder: () => ipcRenderer.invoke('dialog:selectFolder'),

  // File APIs
  openFile: (filePath: string) => ipcRenderer.invoke('file:open', filePath),
  showInFinder: (filePath: string) => ipcRenderer.invoke('file:showInFinder', filePath),

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
});

// Type declarations for TypeScript
export interface ElectronAPI {
  selectFolder: () => Promise<string | null>;
  openFile: (filePath: string) => Promise<string>;
  showInFinder: (filePath: string) => Promise<void>;
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
  getLLMModels: () => Promise<Array<{ key: string; displayName: string }>>;
  getLLMConfigStatus: () => Promise<{
    currentProvider: string;
    currentModel: string;
    providers: Array<{ type: string; name: string; configured: boolean }>;
    models: Array<{ key: string; displayName: string }>;
  }>;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
