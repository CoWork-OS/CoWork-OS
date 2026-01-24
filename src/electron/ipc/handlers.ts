import { ipcMain, shell } from 'electron';
import { DatabaseManager } from '../database/schema';
import {
  WorkspaceRepository,
  TaskRepository,
  TaskEventRepository,
  ArtifactRepository,
  SkillRepository,
  LLMModelRepository,
} from '../database/repositories';
import { IPC_CHANNELS, LLMSettingsData } from '../../shared/types';
import { AgentDaemon } from '../agent/daemon';
import { LLMProviderFactory, LLMProviderConfig, ModelKey } from '../agent/llm';

export function setupIpcHandlers(dbManager: DatabaseManager, agentDaemon: AgentDaemon) {
  const db = dbManager.getDatabase();
  const workspaceRepo = new WorkspaceRepository(db);
  const taskRepo = new TaskRepository(db);
  const taskEventRepo = new TaskEventRepository(db);
  const artifactRepo = new ArtifactRepository(db);
  const skillRepo = new SkillRepository(db);
  const llmModelRepo = new LLMModelRepository(db);

  // File handlers - open files and show in Finder
  ipcMain.handle('file:open', async (_, filePath: string) => {
    return shell.openPath(filePath);
  });

  ipcMain.handle('file:showInFinder', async (_, filePath: string) => {
    shell.showItemInFolder(filePath);
  });

  // Workspace handlers
  ipcMain.handle(IPC_CHANNELS.WORKSPACE_CREATE, async (_, data) => {
    const { name, path, permissions } = data;
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
    await agentDaemon.cancelTask(id);
    taskRepo.update(id, { status: 'cancelled' });
  });

  ipcMain.handle(IPC_CHANNELS.TASK_PAUSE, async (_, id: string) => {
    await agentDaemon.pauseTask(id);
    taskRepo.update(id, { status: 'paused' });
  });

  ipcMain.handle(IPC_CHANNELS.TASK_RESUME, async (_, id: string) => {
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
    });
    // Clear cache so next task uses new settings
    LLMProviderFactory.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.LLM_TEST_PROVIDER, async (_, config: any) => {
    const providerConfig: LLMProviderConfig = {
      type: config.providerType,
      model: LLMProviderFactory.getModelId(config.modelKey as ModelKey, config.providerType),
      anthropicApiKey: config.anthropic?.apiKey,
      awsRegion: config.bedrock?.region,
      awsAccessKeyId: config.bedrock?.accessKeyId,
      awsSecretAccessKey: config.bedrock?.secretAccessKey,
      awsSessionToken: config.bedrock?.sessionToken,
      awsProfile: config.bedrock?.profile,
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
}
