import { ipcMain, shell } from 'electron';
import * as path from 'path';
import { DatabaseManager } from '../database/schema';
import {
  WorkspaceRepository,
  TaskRepository,
  TaskEventRepository,
  ArtifactRepository,
  SkillRepository,
  LLMModelRepository,
} from '../database/repositories';
import { IPC_CHANNELS, LLMSettingsData, AddChannelRequest, UpdateChannelRequest, SecurityMode, UpdateInfo } from '../../shared/types';
import { AgentDaemon } from '../agent/daemon';
import { LLMProviderFactory, LLMProviderConfig, ModelKey, MODELS, GEMINI_MODELS, OPENROUTER_MODELS, OLLAMA_MODELS } from '../agent/llm';
import { SearchProviderFactory, SearchSettings, SearchProviderType } from '../agent/search';
import { ChannelGateway } from '../gateway';
import { updateManager } from '../updater';
import { rateLimiter, RATE_LIMIT_CONFIGS } from '../utils/rate-limiter';
import {
  validateInput,
  WorkspaceCreateSchema,
  TaskCreateSchema,
  TaskRenameSchema,
  TaskMessageSchema,
  ApprovalResponseSchema,
  LLMSettingsSchema,
  SearchSettingsSchema,
  AddChannelSchema,
  UpdateChannelSchema,
  GrantAccessSchema,
  RevokeAccessSchema,
  GeneratePairingSchema,
  UUIDSchema,
  StringIdSchema,
} from '../utils/validation';

// Helper to check rate limit and throw if exceeded
function checkRateLimit(channel: string, config = RATE_LIMIT_CONFIGS.standard): void {
  if (!rateLimiter.check(channel)) {
    const resetMs = rateLimiter.getResetTime(channel);
    const resetSec = Math.ceil(resetMs / 1000);
    throw new Error(`Rate limit exceeded. Try again in ${resetSec} seconds.`);
  }
}

// Configure rate limits for sensitive channels
rateLimiter.configure(IPC_CHANNELS.TASK_CREATE, RATE_LIMIT_CONFIGS.expensive);
rateLimiter.configure(IPC_CHANNELS.TASK_SEND_MESSAGE, RATE_LIMIT_CONFIGS.expensive);
rateLimiter.configure(IPC_CHANNELS.LLM_SAVE_SETTINGS, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.LLM_TEST_PROVIDER, RATE_LIMIT_CONFIGS.expensive);
rateLimiter.configure(IPC_CHANNELS.LLM_GET_OLLAMA_MODELS, RATE_LIMIT_CONFIGS.standard);
rateLimiter.configure(IPC_CHANNELS.LLM_GET_GEMINI_MODELS, RATE_LIMIT_CONFIGS.standard);
rateLimiter.configure(IPC_CHANNELS.LLM_GET_OPENROUTER_MODELS, RATE_LIMIT_CONFIGS.standard);
rateLimiter.configure(IPC_CHANNELS.LLM_GET_BEDROCK_MODELS, RATE_LIMIT_CONFIGS.standard);
rateLimiter.configure(IPC_CHANNELS.SEARCH_SAVE_SETTINGS, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.SEARCH_TEST_PROVIDER, RATE_LIMIT_CONFIGS.expensive);
rateLimiter.configure(IPC_CHANNELS.GATEWAY_ADD_CHANNEL, RATE_LIMIT_CONFIGS.limited);
rateLimiter.configure(IPC_CHANNELS.GATEWAY_TEST_CHANNEL, RATE_LIMIT_CONFIGS.expensive);

export function setupIpcHandlers(
  dbManager: DatabaseManager,
  agentDaemon: AgentDaemon,
  gateway?: ChannelGateway
) {
  const db = dbManager.getDatabase();
  const workspaceRepo = new WorkspaceRepository(db);
  const taskRepo = new TaskRepository(db);
  const taskEventRepo = new TaskEventRepository(db);
  const artifactRepo = new ArtifactRepository(db);
  const skillRepo = new SkillRepository(db);
  const llmModelRepo = new LLMModelRepository(db);

  // Helper to validate path is within workspace (prevent path traversal attacks)
  const isPathWithinWorkspace = (filePath: string, workspacePath: string): boolean => {
    const normalizedWorkspace = path.resolve(workspacePath);
    const normalizedFile = path.resolve(normalizedWorkspace, filePath);
    const relative = path.relative(normalizedWorkspace, normalizedFile);
    // If relative path starts with '..' or is absolute, it's outside workspace
    return !relative.startsWith('..') && !path.isAbsolute(relative);
  };

  // File handlers - open files and show in Finder
  ipcMain.handle('file:open', async (_, filePath: string, workspacePath?: string) => {
    // Security: require workspacePath and validate path is within it
    if (!workspacePath) {
      throw new Error('Workspace path is required for file operations');
    }

    // Resolve the path relative to workspace
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workspacePath, filePath);

    // Validate path is within workspace (prevent path traversal)
    if (!isPathWithinWorkspace(resolvedPath, workspacePath)) {
      throw new Error('Access denied: file path is outside the workspace');
    }

    return shell.openPath(resolvedPath);
  });

  ipcMain.handle('file:showInFinder', async (_, filePath: string, workspacePath?: string) => {
    // Security: require workspacePath and validate path is within it
    if (!workspacePath) {
      throw new Error('Workspace path is required for file operations');
    }

    // Resolve the path relative to workspace
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workspacePath, filePath);

    // Validate path is within workspace (prevent path traversal)
    if (!isPathWithinWorkspace(resolvedPath, workspacePath)) {
      throw new Error('Access denied: file path is outside the workspace');
    }

    shell.showItemInFolder(resolvedPath);
  });

  // Workspace handlers
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CREATE, async (_, data) => {
    const validated = validateInput(WorkspaceCreateSchema, data, 'workspace');
    const { name, path, permissions } = validated;

    // Check if workspace with this path already exists
    if (workspaceRepo.existsByPath(path)) {
      throw new Error(`A workspace with path "${path}" already exists. Please choose a different folder.`);
    }

    // Provide default permissions if not specified
    const defaultPermissions = {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    };

    return workspaceRepo.create(name, path, permissions ?? defaultPermissions);
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST, async () => {
    return workspaceRepo.findAll();
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SELECT, async (_, id: string) => {
    return workspaceRepo.findById(id);
  });

  // Task handlers
  ipcMain.handle(IPC_CHANNELS.TASK_CREATE, async (_, data) => {
    checkRateLimit(IPC_CHANNELS.TASK_CREATE);
    const validated = validateInput(TaskCreateSchema, data, 'task');
    const { title, prompt, workspaceId, budgetTokens, budgetCost } = validated;
    const task = taskRepo.create({
      title,
      prompt,
      status: 'pending',
      workspaceId,
      budgetTokens,
      budgetCost,
    });

    // Start task execution in agent daemon
    try {
      await agentDaemon.startTask(task);
    } catch (error: any) {
      // Update task status to failed if we can't start it
      taskRepo.update(task.id, {
        status: 'failed',
        error: error.message || 'Failed to start task',
      });
      throw new Error(error.message || 'Failed to start task. Please check your LLM provider settings.');
    }

    return task;
  });

  ipcMain.handle(IPC_CHANNELS.TASK_GET, async (_, id: string) => {
    return taskRepo.findById(id);
  });

  ipcMain.handle(IPC_CHANNELS.TASK_LIST, async () => {
    return taskRepo.findAll();
  });

  ipcMain.handle(IPC_CHANNELS.TASK_CANCEL, async (_, id: string) => {
    try {
      await agentDaemon.cancelTask(id);
    } finally {
      // Always update status even if daemon cancel fails
      taskRepo.update(id, { status: 'cancelled' });
    }
  });

  ipcMain.handle(IPC_CHANNELS.TASK_PAUSE, async (_, id: string) => {
    // Pause daemon first - if it fails, exception propagates and status won't be updated
    await agentDaemon.pauseTask(id);
    taskRepo.update(id, { status: 'paused' });
  });

  ipcMain.handle(IPC_CHANNELS.TASK_RESUME, async (_, id: string) => {
    // Resume daemon first - if it fails, exception propagates and status won't be updated
    await agentDaemon.resumeTask(id);
    taskRepo.update(id, { status: 'executing' });
  });

  ipcMain.handle(IPC_CHANNELS.TASK_RENAME, async (_, data) => {
    const validated = validateInput(TaskRenameSchema, data, 'task rename');
    taskRepo.update(validated.id, { title: validated.title });
  });

  ipcMain.handle(IPC_CHANNELS.TASK_DELETE, async (_, id: string) => {
    // Cancel the task if it's running
    await agentDaemon.cancelTask(id);
    // Delete from database
    taskRepo.delete(id);
  });

  // Task events handler - get historical events from database
  ipcMain.handle(IPC_CHANNELS.TASK_EVENTS, async (_, taskId: string) => {
    return taskEventRepo.findByTaskId(taskId);
  });

  // Send follow-up message to a task
  ipcMain.handle(IPC_CHANNELS.TASK_SEND_MESSAGE, async (_, data) => {
    checkRateLimit(IPC_CHANNELS.TASK_SEND_MESSAGE);
    const validated = validateInput(TaskMessageSchema, data, 'task message');
    await agentDaemon.sendMessage(validated.taskId, validated.message);
  });

  // Approval handlers
  ipcMain.handle(IPC_CHANNELS.APPROVAL_RESPOND, async (_, data) => {
    const validated = validateInput(ApprovalResponseSchema, data, 'approval response');
    await agentDaemon.respondToApproval(validated.approvalId, validated.approved);
  });

  // Artifact handlers
  ipcMain.handle(IPC_CHANNELS.ARTIFACT_LIST, async (_, taskId: string) => {
    return artifactRepo.findByTaskId(taskId);
  });

  ipcMain.handle(IPC_CHANNELS.ARTIFACT_PREVIEW, async (_, id: string) => {
    // TODO: Implement artifact preview
    return null;
  });

  // Skill handlers
  ipcMain.handle(IPC_CHANNELS.SKILL_LIST, async () => {
    return skillRepo.findAll();
  });

  ipcMain.handle(IPC_CHANNELS.SKILL_GET, async (_, id: string) => {
    return skillRepo.findById(id);
  });

  // LLM Settings handlers
  ipcMain.handle(IPC_CHANNELS.LLM_GET_SETTINGS, async () => {
    return LLMProviderFactory.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.LLM_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.LLM_SAVE_SETTINGS);
    const validated = validateInput(LLMSettingsSchema, settings, 'LLM settings');

    // Load existing settings to preserve cached models
    const existingSettings = LLMProviderFactory.loadSettings();

    LLMProviderFactory.saveSettings({
      providerType: validated.providerType,
      modelKey: validated.modelKey as ModelKey,
      anthropic: validated.anthropic,
      bedrock: validated.bedrock,
      ollama: validated.ollama,
      gemini: validated.gemini,
      openrouter: validated.openrouter,
      // Preserve cached models from existing settings
      cachedGeminiModels: existingSettings.cachedGeminiModels,
      cachedOpenRouterModels: existingSettings.cachedOpenRouterModels,
      cachedOllamaModels: existingSettings.cachedOllamaModels,
    });
    // Clear cache so next task uses new settings
    LLMProviderFactory.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.LLM_TEST_PROVIDER, async (_, config: any) => {
    checkRateLimit(IPC_CHANNELS.LLM_TEST_PROVIDER);
    const providerConfig: LLMProviderConfig = {
      type: config.providerType,
      model: LLMProviderFactory.getModelId(
        config.modelKey as ModelKey,
        config.providerType,
        config.ollama?.model,
        config.gemini?.model,
        config.openrouter?.model
      ),
      anthropicApiKey: config.anthropic?.apiKey,
      awsRegion: config.bedrock?.region,
      awsAccessKeyId: config.bedrock?.accessKeyId,
      awsSecretAccessKey: config.bedrock?.secretAccessKey,
      awsSessionToken: config.bedrock?.sessionToken,
      awsProfile: config.bedrock?.profile,
      ollamaBaseUrl: config.ollama?.baseUrl,
      ollamaApiKey: config.ollama?.apiKey,
      geminiApiKey: config.gemini?.apiKey,
      openrouterApiKey: config.openrouter?.apiKey,
    };
    return LLMProviderFactory.testProvider(providerConfig);
  });

  ipcMain.handle(IPC_CHANNELS.LLM_GET_MODELS, async () => {
    // Get models from database
    const dbModels = llmModelRepo.findAll();
    return dbModels.map(m => ({
      key: m.key,
      displayName: m.displayName,
      description: m.description,
    }));
  });

  ipcMain.handle(IPC_CHANNELS.LLM_GET_CONFIG_STATUS, async () => {
    const settings = LLMProviderFactory.loadSettings();
    const providers = LLMProviderFactory.getAvailableProviders();

    // Get models based on the current provider type
    let models: Array<{ key: string; displayName: string; description: string }> = [];
    let currentModel = settings.modelKey;

    switch (settings.providerType) {
      case 'anthropic':
      case 'bedrock':
        // Use Anthropic/Bedrock models from MODELS
        models = Object.entries(MODELS).map(([key, value]) => ({
          key,
          displayName: value.displayName,
          description: key.includes('opus') ? 'Most capable for complex work' :
                       key.includes('sonnet') ? 'Balanced performance and speed' :
                       'Fast and efficient',
        }));
        break;

      case 'gemini':
        // For Gemini, use the specific model from settings (full model ID)
        currentModel = settings.gemini?.model || 'gemini-2.0-flash';
        // Use cached models if available, otherwise fall back to static list
        const cachedGemini = LLMProviderFactory.getCachedModels('gemini');
        if (cachedGemini && cachedGemini.length > 0) {
          models = cachedGemini;
        } else {
          // Fall back to static models
          models = Object.values(GEMINI_MODELS).map((value) => ({
            key: value.id,
            displayName: value.displayName,
            description: value.description,
          }));
        }
        // Ensure the currently selected model is in the list
        if (currentModel && !models.some(m => m.key === currentModel)) {
          models.unshift({
            key: currentModel,
            displayName: currentModel,
            description: 'Selected model',
          });
        }
        break;

      case 'openrouter':
        // For OpenRouter, use the specific model from settings (full model ID)
        currentModel = settings.openrouter?.model || 'anthropic/claude-3.5-sonnet';
        // Use cached models if available, otherwise fall back to static list
        const cachedOpenRouter = LLMProviderFactory.getCachedModels('openrouter');
        if (cachedOpenRouter && cachedOpenRouter.length > 0) {
          models = cachedOpenRouter;
        } else {
          // Fall back to static models
          models = Object.values(OPENROUTER_MODELS).map((value) => ({
            key: value.id,
            displayName: value.displayName,
            description: value.description,
          }));
        }
        // Ensure the currently selected model is in the list
        if (currentModel && !models.some(m => m.key === currentModel)) {
          models.unshift({
            key: currentModel,
            displayName: currentModel,
            description: 'Selected model',
          });
        }
        break;

      case 'ollama':
        // For Ollama, use the specific model from settings
        currentModel = settings.ollama?.model || 'llama3.2';
        // Use cached models if available, otherwise fall back to static list
        const cachedOllama = LLMProviderFactory.getCachedModels('ollama');
        if (cachedOllama && cachedOllama.length > 0) {
          models = cachedOllama;
        } else {
          // Fall back to static models
          models = Object.entries(OLLAMA_MODELS).map(([key, value]) => ({
            key,
            displayName: value.displayName,
            description: `${value.size} parameter model`,
          }));
        }
        // Ensure the currently selected model is in the list
        if (currentModel && !models.some(m => m.key === currentModel)) {
          models.unshift({
            key: currentModel,
            displayName: currentModel,
            description: 'Selected model',
          });
        }
        break;

      default:
        // Fallback to Anthropic models
        models = Object.entries(MODELS).map(([key, value]) => ({
          key,
          displayName: value.displayName,
          description: 'Claude model',
        }));
    }

    return {
      currentProvider: settings.providerType,
      currentModel,
      providers,
      models,
    };
  });

  ipcMain.handle(IPC_CHANNELS.LLM_GET_OLLAMA_MODELS, async (_, baseUrl?: string) => {
    checkRateLimit(IPC_CHANNELS.LLM_GET_OLLAMA_MODELS);
    const models = await LLMProviderFactory.getOllamaModels(baseUrl);
    // Cache the models for use in config status
    const cachedModels = models.map(m => ({
      key: m.name,
      displayName: m.name,
      description: `${Math.round(m.size / 1e9)}B parameter model`,
      size: m.size,
    }));
    LLMProviderFactory.saveCachedModels('ollama', cachedModels);
    return models;
  });

  ipcMain.handle(IPC_CHANNELS.LLM_GET_GEMINI_MODELS, async (_, apiKey?: string) => {
    checkRateLimit(IPC_CHANNELS.LLM_GET_GEMINI_MODELS);
    const models = await LLMProviderFactory.getGeminiModels(apiKey);
    // Cache the models for use in config status
    const cachedModels = models.map(m => ({
      key: m.name,
      displayName: m.displayName,
      description: m.description,
    }));
    LLMProviderFactory.saveCachedModels('gemini', cachedModels);
    return models;
  });

  ipcMain.handle(IPC_CHANNELS.LLM_GET_OPENROUTER_MODELS, async (_, apiKey?: string) => {
    checkRateLimit(IPC_CHANNELS.LLM_GET_OPENROUTER_MODELS);
    const models = await LLMProviderFactory.getOpenRouterModels(apiKey);
    // Cache the models for use in config status
    const cachedModels = models.map(m => ({
      key: m.id,
      displayName: m.name,
      description: `Context: ${Math.round(m.context_length / 1000)}k tokens`,
      contextLength: m.context_length,
    }));
    LLMProviderFactory.saveCachedModels('openrouter', cachedModels);
    return models;
  });

  ipcMain.handle(IPC_CHANNELS.LLM_GET_BEDROCK_MODELS, async (_, config?: {
    region?: string;
    accessKeyId?: string;
    secretAccessKey?: string;
    profile?: string;
  }) => {
    checkRateLimit(IPC_CHANNELS.LLM_GET_BEDROCK_MODELS);
    const models = await LLMProviderFactory.getBedrockModels(config);
    // Cache the models for use in config status
    const cachedModels = models.map(m => ({
      key: m.id,
      displayName: m.name,
      description: m.description,
    }));
    LLMProviderFactory.saveCachedModels('bedrock', cachedModels);
    return models;
  });

  // Search Settings handlers
  ipcMain.handle(IPC_CHANNELS.SEARCH_GET_SETTINGS, async () => {
    return SearchProviderFactory.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.SEARCH_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.SEARCH_SAVE_SETTINGS);
    const validated = validateInput(SearchSettingsSchema, settings, 'search settings');
    SearchProviderFactory.saveSettings(validated as SearchSettings);
    SearchProviderFactory.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.SEARCH_GET_CONFIG_STATUS, async () => {
    return SearchProviderFactory.getConfigStatus();
  });

  ipcMain.handle(IPC_CHANNELS.SEARCH_TEST_PROVIDER, async (_, providerType: SearchProviderType) => {
    checkRateLimit(IPC_CHANNELS.SEARCH_TEST_PROVIDER);
    return SearchProviderFactory.testProvider(providerType);
  });

  // Gateway / Channel handlers
  ipcMain.handle(IPC_CHANNELS.GATEWAY_GET_CHANNELS, async () => {
    if (!gateway) return [];
    return gateway.getChannels().map(ch => ({
      id: ch.id,
      type: ch.type,
      name: ch.name,
      enabled: ch.enabled,
      status: ch.status,
      botUsername: ch.botUsername,
      securityMode: ch.securityConfig.mode,
      createdAt: ch.createdAt,
    }));
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_ADD_CHANNEL, async (_, data) => {
    checkRateLimit(IPC_CHANNELS.GATEWAY_ADD_CHANNEL);
    if (!gateway) throw new Error('Gateway not initialized');

    const validated = validateInput(AddChannelSchema, data, 'channel');

    if (validated.type === 'telegram') {
      const channel = await gateway.addTelegramChannel(
        validated.name,
        validated.botToken,
        validated.securityMode || 'pairing'
      );
      return {
        id: channel.id,
        type: channel.type,
        name: channel.name,
        enabled: channel.enabled,
        status: channel.status,
        securityMode: channel.securityConfig.mode,
        createdAt: channel.createdAt,
      };
    }

    if (validated.type === 'discord') {
      const channel = await gateway.addDiscordChannel(
        validated.name,
        validated.botToken,
        validated.applicationId,
        validated.guildIds,
        validated.securityMode || 'pairing'
      );
      return {
        id: channel.id,
        type: channel.type,
        name: channel.name,
        enabled: channel.enabled,
        status: channel.status,
        securityMode: channel.securityConfig.mode,
        createdAt: channel.createdAt,
      };
    }

    // TypeScript exhaustiveness check - should never reach here due to discriminated union
    throw new Error(`Unsupported channel type`);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_UPDATE_CHANNEL, async (_, data) => {
    if (!gateway) throw new Error('Gateway not initialized');

    const validated = validateInput(UpdateChannelSchema, data, 'channel update');
    const channel = gateway.getChannel(validated.id);
    if (!channel) throw new Error('Channel not found');

    const updates: Record<string, unknown> = {};
    if (validated.name !== undefined) updates.name = validated.name;
    if (validated.securityMode !== undefined) {
      updates.securityConfig = { ...channel.securityConfig, mode: validated.securityMode };
    }

    gateway.updateChannel(validated.id, updates);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_REMOVE_CHANNEL, async (_, id: string) => {
    if (!gateway) throw new Error('Gateway not initialized');
    await gateway.removeChannel(id);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_ENABLE_CHANNEL, async (_, id: string) => {
    if (!gateway) throw new Error('Gateway not initialized');
    await gateway.enableChannel(id);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_DISABLE_CHANNEL, async (_, id: string) => {
    if (!gateway) throw new Error('Gateway not initialized');
    await gateway.disableChannel(id);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_TEST_CHANNEL, async (_, id: string) => {
    checkRateLimit(IPC_CHANNELS.GATEWAY_TEST_CHANNEL);
    if (!gateway) return { success: false, error: 'Gateway not initialized' };
    return gateway.testChannel(id);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_GET_USERS, async (_, channelId: string) => {
    if (!gateway) return [];
    return gateway.getChannelUsers(channelId).map(u => ({
      id: u.id,
      channelId: u.channelId,
      channelUserId: u.channelUserId,
      displayName: u.displayName,
      username: u.username,
      allowed: u.allowed,
      lastSeenAt: u.lastSeenAt,
    }));
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_GRANT_ACCESS, async (_, data) => {
    if (!gateway) throw new Error('Gateway not initialized');
    const validated = validateInput(GrantAccessSchema, data, 'grant access');
    gateway.grantUserAccess(validated.channelId, validated.userId, validated.displayName);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_REVOKE_ACCESS, async (_, data) => {
    if (!gateway) throw new Error('Gateway not initialized');
    const validated = validateInput(RevokeAccessSchema, data, 'revoke access');
    gateway.revokeUserAccess(validated.channelId, validated.userId);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_GENERATE_PAIRING, async (_, data) => {
    if (!gateway) throw new Error('Gateway not initialized');
    const validated = validateInput(GeneratePairingSchema, data, 'generate pairing');
    return gateway.generatePairingCode(validated.channelId, validated.userId, validated.displayName);
  });

  // App Update handlers
  ipcMain.handle(IPC_CHANNELS.APP_GET_VERSION, async () => {
    return updateManager.getVersionInfo();
  });

  ipcMain.handle(IPC_CHANNELS.APP_CHECK_UPDATES, async () => {
    return updateManager.checkForUpdates();
  });

  ipcMain.handle(IPC_CHANNELS.APP_DOWNLOAD_UPDATE, async (_, updateInfo: UpdateInfo) => {
    await updateManager.downloadAndInstallUpdate(updateInfo);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.APP_INSTALL_UPDATE, async () => {
    await updateManager.installUpdateAndRestart();
    return { success: true };
  });
}
