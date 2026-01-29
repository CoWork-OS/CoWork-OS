import { ipcMain, shell } from 'electron';
import * as path from 'path';
import * as fs from 'fs/promises';
import mammoth from 'mammoth';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const pdfParse = require('pdf-parse') as (dataBuffer: Buffer) => Promise<{
  text: string;
  numpages: number;
  info: { Title?: string; Author?: string };
}>;

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
import { LLMProviderFactory, LLMProviderConfig, ModelKey, MODELS, GEMINI_MODELS, OPENROUTER_MODELS, OLLAMA_MODELS, OpenAIOAuth } from '../agent/llm';
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
  GuardrailSettingsSchema,
  UUIDSchema,
  StringIdSchema,
} from '../utils/validation';
import { GuardrailManager } from '../guardrails/guardrail-manager';
import { AppearanceManager } from '../settings/appearance-manager';
import { getCustomSkillLoader } from '../agent/custom-skill-loader';
import { CustomSkill } from '../../shared/types';
import { MCPSettingsManager } from '../mcp/settings';
import { MCPClientManager } from '../mcp/client/MCPClientManager';
import { MCPRegistryManager } from '../mcp/registry/MCPRegistryManager';
import { MCPHostServer } from '../mcp/host/MCPHostServer';
import { BuiltinToolsSettingsManager } from '../agent/tools/builtin-settings';
import {
  MCPServerConfigSchema,
  MCPServerUpdateSchema,
  MCPSettingsSchema,
  MCPRegistrySearchSchema,
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
rateLimiter.configure(IPC_CHANNELS.GUARDRAIL_SAVE_SETTINGS, RATE_LIMIT_CONFIGS.limited);

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

  // Open external URL in system browser
  ipcMain.handle('shell:openExternal', async (_, url: string) => {
    // Validate URL to prevent security issues
    try {
      const parsedUrl = new URL(url);
      if (!['http:', 'https:'].includes(parsedUrl.protocol)) {
        throw new Error('Only http and https URLs are allowed');
      }
      await shell.openExternal(url);
    } catch (error: any) {
      throw new Error(`Failed to open URL: ${error.message}`);
    }
  });

  // File viewer handler - read file content for in-app preview
  ipcMain.handle('file:readForViewer', async (_, data: { filePath: string; workspacePath: string }) => {
    const { filePath, workspacePath } = data;

    // Security: require workspacePath and validate path is within it
    if (!workspacePath) {
      return { success: false, error: 'Workspace path is required for file operations' };
    }

    // Resolve the path relative to workspace
    const resolvedPath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(workspacePath, filePath);

    // Validate path is within workspace (prevent path traversal)
    if (!isPathWithinWorkspace(resolvedPath, workspacePath)) {
      return { success: false, error: 'Access denied: file path is outside the workspace' };
    }

    // Check if file exists
    try {
      await fs.access(resolvedPath);
    } catch {
      return { success: false, error: 'File not found' };
    }

    // Get file stats
    const stats = await fs.stat(resolvedPath);
    const extension = path.extname(resolvedPath).toLowerCase();
    const fileName = path.basename(resolvedPath);

    // Determine file type
    const getFileType = (ext: string): 'markdown' | 'code' | 'text' | 'docx' | 'pdf' | 'image' | 'pptx' | 'unsupported' => {
      const codeExtensions = ['.js', '.ts', '.tsx', '.jsx', '.py', '.java', '.go', '.rs', '.c', '.cpp', '.h', '.css', '.scss', '.html', '.xml', '.json', '.yaml', '.yml', '.toml', '.sh', '.bash', '.zsh', '.sql', '.graphql', '.vue', '.svelte', '.rb', '.php', '.swift', '.kt', '.scala'];
      const textExtensions = ['.txt', '.log', '.csv', '.env', '.gitignore', '.dockerignore', '.editorconfig', '.prettierrc', '.eslintrc'];
      const imageExtensions = ['.png', '.jpg', '.jpeg', '.gif', '.webp', '.svg', '.bmp', '.ico'];

      if (ext === '.md' || ext === '.markdown') return 'markdown';
      if (ext === '.docx') return 'docx';
      if (ext === '.pdf') return 'pdf';
      if (ext === '.pptx') return 'pptx';
      if (imageExtensions.includes(ext)) return 'image';
      if (codeExtensions.includes(ext)) return 'code';
      if (textExtensions.includes(ext)) return 'text';

      return 'unsupported';
    };

    const fileType = getFileType(extension);

    // Size limits
    const MAX_TEXT_SIZE = 5 * 1024 * 1024; // 5MB
    const MAX_IMAGE_SIZE = 10 * 1024 * 1024; // 10MB

    if (fileType === 'image' && stats.size > MAX_IMAGE_SIZE) {
      return { success: false, error: 'File too large for preview (max 10MB for images)' };
    }
    if (fileType !== 'image' && fileType !== 'unsupported' && stats.size > MAX_TEXT_SIZE) {
      return { success: false, error: 'File too large for preview (max 5MB for text files)' };
    }

    try {
      let content: string | null = null;
      let htmlContent: string | undefined;

      switch (fileType) {
        case 'markdown':
        case 'code':
        case 'text': {
          content = await fs.readFile(resolvedPath, 'utf-8');
          break;
        }

        case 'docx': {
          const buffer = await fs.readFile(resolvedPath);
          const result = await mammoth.convertToHtml({ buffer });
          htmlContent = result.value;
          content = null; // HTML content is in htmlContent
          break;
        }

        case 'pdf': {
          const buffer = await fs.readFile(resolvedPath);
          const pdfData = await pdfParse(buffer);
          content = pdfData.text;
          break;
        }

        case 'image': {
          const buffer = await fs.readFile(resolvedPath);
          const mimeTypes: Record<string, string> = {
            '.png': 'image/png',
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.gif': 'image/gif',
            '.webp': 'image/webp',
            '.svg': 'image/svg+xml',
            '.bmp': 'image/bmp',
            '.ico': 'image/x-icon',
          };
          const mimeType = mimeTypes[extension] || 'image/png';
          content = `data:${mimeType};base64,${buffer.toString('base64')}`;
          break;
        }

        case 'pptx':
          // PowerPoint files are complex to render, return placeholder
          content = null;
          break;

        default:
          return { success: false, error: 'Unsupported file type', fileType: 'unsupported' };
      }

      return {
        success: true,
        data: {
          path: resolvedPath,
          fileName,
          fileType,
          content,
          htmlContent,
          size: stats.size,
        },
      };
    } catch (error: any) {
      return { success: false, error: `Failed to read file: ${error.message}` };
    }
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
    // Note: network is enabled by default for browser tools (web access)
    const defaultPermissions = {
      read: true,
      write: true,
      delete: false,
      network: true,
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

  ipcMain.handle(IPC_CHANNELS.WORKSPACE_UPDATE_PERMISSIONS, async (_, id: string, permissions: { shell?: boolean; network?: boolean; read?: boolean; write?: boolean; delete?: boolean }) => {
    const workspace = workspaceRepo.findById(id);
    if (!workspace) {
      throw new Error(`Workspace not found: ${id}`);
    }
    const updatedPermissions = { ...workspace.permissions, ...permissions };
    workspaceRepo.updatePermissions(id, updatedPermissions);
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

  // Custom User Skills handlers
  const customSkillLoader = getCustomSkillLoader();

  // Initialize custom skill loader
  customSkillLoader.initialize().catch(error => {
    console.error('[IPC] Failed to initialize custom skill loader:', error);
  });

  ipcMain.handle(IPC_CHANNELS.CUSTOM_SKILL_LIST, async () => {
    return customSkillLoader.listSkills();
  });

  ipcMain.handle(IPC_CHANNELS.CUSTOM_SKILL_LIST_TASKS, async () => {
    return customSkillLoader.listTaskSkills();
  });

  ipcMain.handle(IPC_CHANNELS.CUSTOM_SKILL_LIST_GUIDELINES, async () => {
    return customSkillLoader.listGuidelineSkills();
  });

  ipcMain.handle(IPC_CHANNELS.CUSTOM_SKILL_GET, async (_, id: string) => {
    return customSkillLoader.getSkill(id);
  });

  ipcMain.handle(IPC_CHANNELS.CUSTOM_SKILL_CREATE, async (_, skillData: Omit<CustomSkill, 'filePath'>) => {
    return customSkillLoader.createSkill(skillData);
  });

  ipcMain.handle(IPC_CHANNELS.CUSTOM_SKILL_UPDATE, async (_, id: string, updates: Partial<CustomSkill>) => {
    return customSkillLoader.updateSkill(id, updates);
  });

  ipcMain.handle(IPC_CHANNELS.CUSTOM_SKILL_DELETE, async (_, id: string) => {
    return customSkillLoader.deleteSkill(id);
  });

  ipcMain.handle(IPC_CHANNELS.CUSTOM_SKILL_RELOAD, async () => {
    return customSkillLoader.reloadSkills();
  });

  ipcMain.handle(IPC_CHANNELS.CUSTOM_SKILL_OPEN_FOLDER, async () => {
    return customSkillLoader.openSkillsFolder();
  });

  // LLM Settings handlers
  ipcMain.handle(IPC_CHANNELS.LLM_GET_SETTINGS, async () => {
    return LLMProviderFactory.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.LLM_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.LLM_SAVE_SETTINGS);
    const validated = validateInput(LLMSettingsSchema, settings, 'LLM settings');

    // Load existing settings to preserve cached models and OAuth tokens
    const existingSettings = LLMProviderFactory.loadSettings();

    // Build OpenAI settings, preserving OAuth tokens from existing settings
    let openaiSettings = validated.openai;
    if (existingSettings.openai?.authMethod === 'oauth') {
      // Preserve OAuth tokens when saving settings
      openaiSettings = {
        ...validated.openai,
        accessToken: existingSettings.openai.accessToken,
        refreshToken: existingSettings.openai.refreshToken,
        tokenExpiresAt: existingSettings.openai.tokenExpiresAt,
        authMethod: existingSettings.openai.authMethod,
      };
    }

    LLMProviderFactory.saveSettings({
      providerType: validated.providerType,
      modelKey: validated.modelKey as ModelKey,
      anthropic: validated.anthropic,
      bedrock: validated.bedrock,
      ollama: validated.ollama,
      gemini: validated.gemini,
      openrouter: validated.openrouter,
      openai: openaiSettings,
      // Preserve cached models from existing settings
      cachedGeminiModels: existingSettings.cachedGeminiModels,
      cachedOpenRouterModels: existingSettings.cachedOpenRouterModels,
      cachedOllamaModels: existingSettings.cachedOllamaModels,
      cachedBedrockModels: existingSettings.cachedBedrockModels,
      cachedOpenAIModels: existingSettings.cachedOpenAIModels,
    });
    // Clear cache so next task uses new settings
    LLMProviderFactory.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.LLM_TEST_PROVIDER, async (_, config: any) => {
    checkRateLimit(IPC_CHANNELS.LLM_TEST_PROVIDER);
    // For OpenAI OAuth, get tokens from stored settings if authMethod is 'oauth'
    let openaiAccessToken: string | undefined;
    let openaiRefreshToken: string | undefined;
    if (config.providerType === 'openai' && config.openai?.authMethod === 'oauth') {
      const settings = LLMProviderFactory.loadSettings();
      openaiAccessToken = settings.openai?.accessToken;
      openaiRefreshToken = settings.openai?.refreshToken;
    }
    const providerConfig: LLMProviderConfig = {
      type: config.providerType,
      model: LLMProviderFactory.getModelId(
        config.modelKey as ModelKey,
        config.providerType,
        config.ollama?.model,
        config.gemini?.model,
        config.openrouter?.model,
        config.openai?.model
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
      openaiApiKey: config.openai?.apiKey,
      openaiAccessToken: openaiAccessToken,
      openaiRefreshToken: openaiRefreshToken,
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

      case 'gemini': {
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
      }

      case 'openrouter': {
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
      }

      case 'ollama': {
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
      }

      case 'openai': {
        // For OpenAI, use the specific model from settings
        currentModel = settings.openai?.model || 'gpt-4o-mini';
        // Use cached models if available, otherwise fall back to static list
        const cachedOpenAI = LLMProviderFactory.getCachedModels('openai');
        if (cachedOpenAI && cachedOpenAI.length > 0) {
          models = cachedOpenAI;
        } else {
          // Fall back to static models
          models = [
            { key: 'gpt-4o', displayName: 'GPT-4o', description: 'Most capable model for complex tasks' },
            { key: 'gpt-4o-mini', displayName: 'GPT-4o Mini', description: 'Fast and affordable for most tasks' },
            { key: 'gpt-4-turbo', displayName: 'GPT-4 Turbo', description: 'Previous generation flagship' },
            { key: 'gpt-3.5-turbo', displayName: 'GPT-3.5 Turbo', description: 'Fast and cost-effective' },
            { key: 'o1', displayName: 'o1', description: 'Advanced reasoning model' },
            { key: 'o1-mini', displayName: 'o1 Mini', description: 'Fast reasoning model' },
          ];
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
      }

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
    console.log('[IPC] Handling LLM_GET_OLLAMA_MODELS request');
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

  ipcMain.handle(IPC_CHANNELS.LLM_GET_OPENAI_MODELS, async (_, apiKey?: string) => {
    checkRateLimit(IPC_CHANNELS.LLM_GET_OPENAI_MODELS);
    const models = await LLMProviderFactory.getOpenAIModels(apiKey);
    // Cache the models for use in config status
    const cachedModels = models.map(m => ({
      key: m.id,
      displayName: m.name,
      description: m.description,
    }));
    LLMProviderFactory.saveCachedModels('openai', cachedModels);
    return models;
  });

  // OpenAI OAuth handlers
  ipcMain.handle(IPC_CHANNELS.LLM_OPENAI_OAUTH_START, async () => {
    checkRateLimit(IPC_CHANNELS.LLM_OPENAI_OAUTH_START);
    console.log('[IPC] Starting OpenAI OAuth flow with pi-ai SDK...');

    try {
      const oauth = new OpenAIOAuth();
      const tokens = await oauth.authenticate();

      // Save tokens to settings
      const settings = LLMProviderFactory.loadSettings();
      settings.openai = {
        ...settings.openai,
        accessToken: tokens.access_token,
        refreshToken: tokens.refresh_token,
        tokenExpiresAt: tokens.expires_at,
        authMethod: 'oauth',
        // Clear API key when using OAuth
        apiKey: undefined,
      };
      LLMProviderFactory.saveSettings(settings);
      LLMProviderFactory.clearCache();

      console.log('[IPC] OpenAI OAuth successful!');
      if (tokens.email) {
        console.log('[IPC] Logged in as:', tokens.email);
      }

      return { success: true, email: tokens.email };
    } catch (error: any) {
      console.error('[IPC] OpenAI OAuth failed:', error.message);
      return { success: false, error: error.message };
    }
  });

  ipcMain.handle(IPC_CHANNELS.LLM_OPENAI_OAUTH_LOGOUT, async () => {
    checkRateLimit(IPC_CHANNELS.LLM_OPENAI_OAUTH_LOGOUT);
    console.log('[IPC] Logging out of OpenAI OAuth...');

    // Clear OAuth tokens from settings
    const settings = LLMProviderFactory.loadSettings();
    if (settings.openai) {
      settings.openai = {
        ...settings.openai,
        accessToken: undefined,
        refreshToken: undefined,
        tokenExpiresAt: undefined,
        authMethod: undefined,
      };
      LLMProviderFactory.saveSettings(settings);
    }

    return { success: true };
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

    if (validated.type === 'slack') {
      const channel = await gateway.addSlackChannel(
        validated.name,
        validated.botToken,
        validated.appToken,
        validated.signingSecret,
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

  // Guardrail Settings handlers
  ipcMain.handle(IPC_CHANNELS.GUARDRAIL_GET_SETTINGS, async () => {
    return GuardrailManager.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.GUARDRAIL_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.GUARDRAIL_SAVE_SETTINGS);
    const validated = validateInput(GuardrailSettingsSchema, settings, 'guardrail settings');
    GuardrailManager.saveSettings(validated);
    GuardrailManager.clearCache();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.GUARDRAIL_GET_DEFAULTS, async () => {
    return GuardrailManager.getDefaults();
  });

  // Appearance Settings handlers
  ipcMain.handle(IPC_CHANNELS.APPEARANCE_GET_SETTINGS, async () => {
    return AppearanceManager.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.APPEARANCE_SAVE_SETTINGS, async (_, settings) => {
    AppearanceManager.saveSettings(settings);
    return { success: true };
  });

  // Queue handlers
  ipcMain.handle(IPC_CHANNELS.QUEUE_GET_STATUS, async () => {
    return agentDaemon.getQueueStatus();
  });

  ipcMain.handle(IPC_CHANNELS.QUEUE_GET_SETTINGS, async () => {
    return agentDaemon.getQueueSettings();
  });

  ipcMain.handle(IPC_CHANNELS.QUEUE_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.QUEUE_SAVE_SETTINGS);
    agentDaemon.saveQueueSettings(settings);
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.QUEUE_CLEAR, async () => {
    checkRateLimit(IPC_CHANNELS.QUEUE_CLEAR);
    const result = await agentDaemon.clearStuckTasks();
    return { success: true, ...result };
  });

  // MCP handlers
  setupMCPHandlers();
}

/**
 * Set up MCP (Model Context Protocol) IPC handlers
 */
function setupMCPHandlers(): void {
  // Configure rate limits for MCP channels
  rateLimiter.configure(IPC_CHANNELS.MCP_SAVE_SETTINGS, RATE_LIMIT_CONFIGS.limited);
  rateLimiter.configure(IPC_CHANNELS.MCP_CONNECT_SERVER, RATE_LIMIT_CONFIGS.expensive);
  rateLimiter.configure(IPC_CHANNELS.MCP_TEST_SERVER, RATE_LIMIT_CONFIGS.expensive);
  rateLimiter.configure(IPC_CHANNELS.MCP_REGISTRY_INSTALL, RATE_LIMIT_CONFIGS.expensive);

  // Initialize MCP settings manager
  MCPSettingsManager.initialize();

  // Get settings
  ipcMain.handle(IPC_CHANNELS.MCP_GET_SETTINGS, async () => {
    return MCPSettingsManager.getSettingsForDisplay();
  });

  // Save settings
  ipcMain.handle(IPC_CHANNELS.MCP_SAVE_SETTINGS, async (_, settings) => {
    checkRateLimit(IPC_CHANNELS.MCP_SAVE_SETTINGS);
    const validated = validateInput(MCPSettingsSchema, settings, 'MCP settings');
    MCPSettingsManager.saveSettings(validated as any);
    MCPSettingsManager.clearCache();
    return { success: true };
  });

  // Get all servers
  ipcMain.handle(IPC_CHANNELS.MCP_GET_SERVERS, async () => {
    const settings = MCPSettingsManager.loadSettings();
    return settings.servers;
  });

  // Add a server
  ipcMain.handle(IPC_CHANNELS.MCP_ADD_SERVER, async (_, serverConfig) => {
    checkRateLimit(IPC_CHANNELS.MCP_ADD_SERVER);
    const validated = validateInput(MCPServerConfigSchema, serverConfig, 'MCP server config');
    const { id, ...configWithoutId } = validated;
    return MCPSettingsManager.addServer(configWithoutId as any);
  });

  // Update a server
  ipcMain.handle(IPC_CHANNELS.MCP_UPDATE_SERVER, async (_, serverId: string, updates) => {
    const validatedId = validateInput(UUIDSchema, serverId, 'server ID');
    const validatedUpdates = validateInput(MCPServerUpdateSchema, updates, 'server updates');
    return MCPSettingsManager.updateServer(validatedId, validatedUpdates as any);
  });

  // Remove a server
  ipcMain.handle(IPC_CHANNELS.MCP_REMOVE_SERVER, async (_, serverId: string) => {
    const validatedId = validateInput(UUIDSchema, serverId, 'server ID');

    // Disconnect if connected
    try {
      await MCPClientManager.getInstance().disconnectServer(validatedId);
    } catch {
      // Ignore errors
    }

    return MCPSettingsManager.removeServer(validatedId);
  });

  // Connect to a server
  ipcMain.handle(IPC_CHANNELS.MCP_CONNECT_SERVER, async (_, serverId: string) => {
    checkRateLimit(IPC_CHANNELS.MCP_CONNECT_SERVER);
    const validatedId = validateInput(UUIDSchema, serverId, 'server ID');
    await MCPClientManager.getInstance().connectServer(validatedId);
    return { success: true };
  });

  // Disconnect from a server
  ipcMain.handle(IPC_CHANNELS.MCP_DISCONNECT_SERVER, async (_, serverId: string) => {
    const validatedId = validateInput(UUIDSchema, serverId, 'server ID');
    await MCPClientManager.getInstance().disconnectServer(validatedId);
    return { success: true };
  });

  // Get status of all servers
  ipcMain.handle(IPC_CHANNELS.MCP_GET_STATUS, async () => {
    return MCPClientManager.getInstance().getStatus();
  });

  // Get tools from a specific server
  ipcMain.handle(IPC_CHANNELS.MCP_GET_SERVER_TOOLS, async (_, serverId: string) => {
    const validatedId = validateInput(UUIDSchema, serverId, 'server ID');
    return MCPClientManager.getInstance().getServerTools(validatedId);
  });

  // Test server connection
  ipcMain.handle(IPC_CHANNELS.MCP_TEST_SERVER, async (_, serverId: string) => {
    checkRateLimit(IPC_CHANNELS.MCP_TEST_SERVER);
    const validatedId = validateInput(UUIDSchema, serverId, 'server ID');
    return MCPClientManager.getInstance().testServer(validatedId);
  });

  // MCP Registry handlers
  ipcMain.handle(IPC_CHANNELS.MCP_REGISTRY_FETCH, async () => {
    const registry = await MCPRegistryManager.fetchRegistry();
    const categories = await MCPRegistryManager.getCategories();
    const featured = registry.servers.filter(s => s.featured);
    return { ...registry, categories, featured };
  });

  ipcMain.handle(IPC_CHANNELS.MCP_REGISTRY_SEARCH, async (_, options) => {
    const validatedOptions = validateInput(MCPRegistrySearchSchema, options, 'registry search options');
    return MCPRegistryManager.searchServers(validatedOptions);
  });

  ipcMain.handle(IPC_CHANNELS.MCP_REGISTRY_INSTALL, async (_, entryId: string) => {
    checkRateLimit(IPC_CHANNELS.MCP_REGISTRY_INSTALL);
    const validatedId = validateInput(StringIdSchema, entryId, 'registry entry ID');
    return MCPRegistryManager.installServer(validatedId);
  });

  ipcMain.handle(IPC_CHANNELS.MCP_REGISTRY_UNINSTALL, async (_, serverId: string) => {
    const validatedId = validateInput(UUIDSchema, serverId, 'server ID');

    // Disconnect if connected
    try {
      await MCPClientManager.getInstance().disconnectServer(validatedId);
    } catch {
      // Ignore errors
    }

    await MCPRegistryManager.uninstallServer(validatedId);
  });

  ipcMain.handle(IPC_CHANNELS.MCP_REGISTRY_CHECK_UPDATES, async () => {
    return MCPRegistryManager.checkForUpdates();
  });

  ipcMain.handle(IPC_CHANNELS.MCP_REGISTRY_UPDATE_SERVER, async (_, serverId: string) => {
    const validatedId = validateInput(UUIDSchema, serverId, 'server ID');
    return MCPRegistryManager.updateServer(validatedId);
  });

  // MCP Host handlers
  ipcMain.handle(IPC_CHANNELS.MCP_HOST_START, async () => {
    const hostServer = MCPHostServer.getInstance();

    // If no tool provider is set, create a minimal one that exposes MCP tools
    // from connected servers (useful for tool aggregation/forwarding)
    if (!hostServer.hasToolProvider()) {
      const mcpClientManager = MCPClientManager.getInstance();

      // Create a minimal tool provider that exposes MCP tools
      hostServer.setToolProvider({
        getTools() {
          return mcpClientManager.getAllTools();
        },
        async executeTool(name: string, args: Record<string, any>) {
          return mcpClientManager.callTool(name, args);
        },
      });
    }

    await hostServer.startStdio();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.MCP_HOST_STOP, async () => {
    const hostServer = MCPHostServer.getInstance();
    await hostServer.stop();
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.MCP_HOST_GET_STATUS, async () => {
    const hostServer = MCPHostServer.getInstance();
    return {
      running: hostServer.isRunning(),
      toolCount: hostServer.hasToolProvider() ? MCPClientManager.getInstance().getAllTools().length : 0,
    };
  });

  // =====================
  // Built-in Tools Settings Handlers
  // =====================

  ipcMain.handle(IPC_CHANNELS.BUILTIN_TOOLS_GET_SETTINGS, async () => {
    return BuiltinToolsSettingsManager.loadSettings();
  });

  ipcMain.handle(IPC_CHANNELS.BUILTIN_TOOLS_SAVE_SETTINGS, async (_, settings) => {
    BuiltinToolsSettingsManager.saveSettings(settings);
    BuiltinToolsSettingsManager.clearCache(); // Clear cache to force reload
    return { success: true };
  });

  ipcMain.handle(IPC_CHANNELS.BUILTIN_TOOLS_GET_CATEGORIES, async () => {
    return BuiltinToolsSettingsManager.getToolsByCategory();
  });
}
