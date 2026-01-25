// Core types shared between main and renderer processes

export type TaskStatus = 'pending' | 'planning' | 'executing' | 'paused' | 'completed' | 'failed' | 'cancelled';

export type EventType =
  | 'task_created'
  | 'task_completed'
  | 'plan_created'
  | 'step_started'
  | 'step_completed'
  | 'executing'
  | 'tool_call'
  | 'tool_result'
  | 'assistant_message'
  | 'approval_requested'
  | 'approval_granted'
  | 'approval_denied'
  | 'file_created'
  | 'file_modified'
  | 'file_deleted'
  | 'error'
  | 'log';

export type ToolType =
  | 'read_file'
  | 'write_file'
  | 'list_directory'
  | 'rename_file'
  | 'move_file'
  | 'delete_file'
  | 'create_directory'
  | 'search_files'
  | 'run_skill';

export type ApprovalType =
  | 'delete_file'
  | 'delete_multiple'
  | 'bulk_rename'
  | 'network_access'
  | 'external_service';

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
  allowedDomains?: string[];
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

  // LLM Settings
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
} as const;

// LLM Provider types
export type LLMProviderType = 'anthropic' | 'bedrock' | 'ollama';

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
  };
  ollama?: {
    baseUrl?: string;
    model?: string;
    apiKey?: string; // Optional, for remote Ollama servers
  };
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
