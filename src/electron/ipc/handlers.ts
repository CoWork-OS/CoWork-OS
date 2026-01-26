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
import { LLMProviderFactory, LLMProviderConfig, ModelKey } from '../agent/llm';
import { SearchProviderFactory, SearchSettings, SearchProviderType } from '../agent/search';
import { ChannelGateway } from '../gateway';
import { updateManager } from '../updater';

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

  // File handlers - open files and show in Finder
  ipcMain.handle('file:open', async (_, filePath: string, workspacePath?: string) => {
    // If workspacePath is provided and filePath is relative, resolve it
    let resolvedPath = filePath;
    if (workspacePath && !path.isAbsolute(filePath)) {
      resolvedPath = path.resolve(workspacePath, filePath);
    }
    return shell.openPath(resolvedPath);
  });

  ipcMain.handle('file:showInFinder', async (_, filePath: string, workspacePath?: string) => {
    // If workspacePath is provided and filePath is relative, resolve it
    let resolvedPath = filePath;
    if (workspacePath && !path.isAbsolute(filePath)) {
      resolvedPath = path.resolve(workspacePath, filePath);
    }
    shell.showItemInFolder(resolvedPath);
  });

  // Workspace handlers
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CREATE, async (_, data) => {
    const { name, path, permissions } = data;

    // Validate path is not empty
    if (!path || typeof path !== 'string' || path.trim() === '') {
      throw new Error('Workspace path is required');
    }

    // Check if workspace with this path already exists
    if (workspaceRepo.existsByPath(path)) {
      throw new Error(`A workspace with path "${path}" already exists. Please choose a different folder.`);
    }

    return workspaceRepo.create(name, path, permissions);
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_LIST, async () => {
    return workspaceRepo.findAll();
  });

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_SELECT, async (_, id: string) => {
    return workspaceRepo.findById(id);
  });

  // Task handlers
  ipcMain.handle(IPC_CHANNELS.TASK_CREATE, async (_, data) => {
    const { title, prompt, workspaceId, budgetTokens, budgetCost } = data;
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

  ipcMain.handle(IPC_CHANNELS.TASK_RENAME, async (_, data: { id: string; title: string }) => {
    taskRepo.update(data.id, { title: data.title });
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
  ipcMain.handle(IPC_CHANNELS.TASK_SEND_MESSAGE, async (_, data: { taskId: string; message: string }) => {
    await agentDaemon.sendMessage(data.taskId, data.message);
  });

  // Approval handlers
  ipcMain.handle(IPC_CHANNELS.APPROVAL_RESPOND, async (_, data) => {
    const { approvalId, approved } = data;
    await agentDaemon.respondToApproval(approvalId, approved);
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

  ipcMain.handle(IPC_CHANNELS.LLM_SAVE_SETTINGS, async (_, settings: LLMSettingsData) => {
    LLMProviderFactory.saveSettings({
      providerType: settings.providerType,
      modelKey: settings.modelKey as ModelKey,
      anthropic: settings.anthropic,
      bedrock: settings.bedrock,
      ollama: settings.ollama,
    });
    // Clear cache so next task uses new settings
    LLMProviderFactory.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.LLM_TEST_PROVIDER, async (_, config: any) => {
    const providerConfig: LLMProviderConfig = {
      type: config.providerType,
      model: LLMProviderFactory.getModelId(config.modelKey as ModelKey, config.providerType, config.ollama?.model),
      anthropicApiKey: config.anthropic?.apiKey,
      awsRegion: config.bedrock?.region,
      awsAccessKeyId: config.bedrock?.accessKeyId,
      awsSecretAccessKey: config.bedrock?.secretAccessKey,
      awsSessionToken: config.bedrock?.sessionToken,
      awsProfile: config.bedrock?.profile,
      ollamaBaseUrl: config.ollama?.baseUrl,
      ollamaApiKey: config.ollama?.apiKey,
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
    const dbModels = llmModelRepo.findAll();
    const providers = LLMProviderFactory.getAvailableProviders();

    return {
      currentProvider: settings.providerType,
      currentModel: settings.modelKey,
      providers,
      models: dbModels.map(m => ({
        key: m.key,
        displayName: m.displayName,
        description: m.description,
      })),
    };
  });

  ipcMain.handle(IPC_CHANNELS.LLM_GET_OLLAMA_MODELS, async (_, baseUrl?: string) => {
    return LLMProviderFactory.getOllamaModels(baseUrl);
  });

  // Search Settings handlers
  ipcMain.handle(IPC_CHANNELS.SEARCH_GET_SETTINGS, async () => {
    return SearchProviderFactory.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.SEARCH_SAVE_SETTINGS, async (_, settings: SearchSettings) => {
    SearchProviderFactory.saveSettings(settings);
    SearchProviderFactory.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.SEARCH_GET_CONFIG_STATUS, async () => {
    return SearchProviderFactory.getConfigStatus();
  });

  ipcMain.handle(IPC_CHANNELS.SEARCH_TEST_PROVIDER, async (_, providerType: SearchProviderType) => {
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

  ipcMain.handle(IPC_CHANNELS.GATEWAY_ADD_CHANNEL, async (_, data: AddChannelRequest) => {
    if (!gateway) throw new Error('Gateway not initialized');

    if (data.type === 'telegram') {
      const channel = await gateway.addTelegramChannel(
        data.name,
        data.botToken,
        data.securityMode as SecurityMode || 'pairing'
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

    if (data.type === 'discord') {
      if (!data.applicationId) {
        throw new Error('Discord Application ID is required');
      }
      const channel = await gateway.addDiscordChannel(
        data.name,
        data.botToken,
        data.applicationId,
        data.guildIds,
        data.securityMode as SecurityMode || 'pairing'
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

    throw new Error(`Unsupported channel type: ${data.type}`);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_UPDATE_CHANNEL, async (_, data: UpdateChannelRequest) => {
    if (!gateway) throw new Error('Gateway not initialized');

    const channel = gateway.getChannel(data.id);
    if (!channel) throw new Error('Channel not found');

    const updates: Record<string, unknown> = {};
    if (data.name !== undefined) updates.name = data.name;
    if (data.securityMode !== undefined) {
      updates.securityConfig = { ...channel.securityConfig, mode: data.securityMode };
    }

    gateway.updateChannel(data.id, updates);
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

  ipcMain.handle(IPC_CHANNELS.GATEWAY_GRANT_ACCESS, async (_, data: { channelId: string; userId: string; displayName?: string }) => {
    if (!gateway) throw new Error('Gateway not initialized');
    gateway.grantUserAccess(data.channelId, data.userId, data.displayName);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_REVOKE_ACCESS, async (_, data: { channelId: string; userId: string }) => {
    if (!gateway) throw new Error('Gateway not initialized');
    gateway.revokeUserAccess(data.channelId, data.userId);
  });

  ipcMain.handle(IPC_CHANNELS.GATEWAY_GENERATE_PAIRING, async (_, data: { channelId: string; userId: string; displayName?: string }) => {
    if (!gateway) throw new Error('Gateway not initialized');
    return gateway.generatePairingCode(data.channelId, data.userId, data.displayName);
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
