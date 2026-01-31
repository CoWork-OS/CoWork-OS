/**
 * Input validation schemas for IPC handlers using Zod
 * Provides type-safe validation to prevent malformed input attacks
 */

import { z } from 'zod';

// Common validation patterns
const MAX_STRING_LENGTH = 10000;
const MAX_PATH_LENGTH = 4096;
const MAX_TITLE_LENGTH = 500;
const MAX_PROMPT_LENGTH = 100000;

// ============ Workspace Schemas ============

export const WorkspaceCreateSchema = z.object({
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  path: z.string().min(1).max(MAX_PATH_LENGTH),
  permissions: z.object({
    read: z.boolean().default(true),
    write: z.boolean().default(true),
    delete: z.boolean().default(false),
    network: z.boolean().default(false),
    shell: z.boolean().default(false),
    // Broader filesystem access
    unrestrictedFileAccess: z.boolean().default(false),
    allowedPaths: z.array(z.string().max(MAX_PATH_LENGTH)).max(50).optional(),
  }).optional(),
});

// ============ Task Schemas ============

export const SuccessCriteriaSchema = z.object({
  type: z.enum(['shell_command', 'file_exists']),
  command: z.string().max(5000).optional(),
  filePaths: z.array(z.string().max(MAX_PATH_LENGTH)).max(20).optional(),
});

// TEMP_WORKSPACE_ID constant for validation
const TEMP_WORKSPACE_ID = '__temp_workspace__';

export const TaskCreateSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  workspaceId: z.string().refine(
    (val) => val === TEMP_WORKSPACE_ID || z.string().uuid().safeParse(val).success,
    { message: 'Must be a valid UUID or temp workspace ID' }
  ),
  budgetTokens: z.number().int().positive().optional(),
  budgetCost: z.number().positive().optional(),
  // Goal Mode fields
  successCriteria: SuccessCriteriaSchema.optional(),
  maxAttempts: z.number().int().min(1).max(10).optional(),
});

export const TaskRenameSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
});

export const TaskMessageSchema = z.object({
  taskId: z.string().uuid(),
  message: z.string().min(1).max(MAX_PROMPT_LENGTH),
});

// ============ Approval Schemas ============

export const ApprovalResponseSchema = z.object({
  approvalId: z.string().uuid(),
  approved: z.boolean(),
});

// ============ LLM Settings Schemas ============

export const LLMProviderTypeSchema = z.enum(['anthropic', 'bedrock', 'ollama', 'gemini', 'openrouter', 'openai']);

export const AnthropicSettingsSchema = z.object({
  apiKey: z.string().max(500).optional(),
}).optional();

export const BedrockSettingsSchema = z.object({
  region: z.string().max(100).optional(),
  accessKeyId: z.string().max(500).optional(),
  secretAccessKey: z.string().max(500).optional(),
  sessionToken: z.string().max(2000).optional(),
  profile: z.string().max(100).optional(),
  useDefaultCredentials: z.boolean().optional(),
  model: z.string().max(200).optional(),
}).optional();

export const OllamaSettingsSchema = z.object({
  baseUrl: z.string().url().max(500).optional(),
  model: z.string().max(200).optional(),
  apiKey: z.string().max(500).optional(),
}).optional();

export const GeminiSettingsSchema = z.object({
  apiKey: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
}).optional();

export const OpenRouterSettingsSchema = z.object({
  apiKey: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
}).optional();

export const OpenAISettingsSchema = z.object({
  apiKey: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
  // OAuth tokens (alternative to API key)
  accessToken: z.string().max(2000).optional(),
  refreshToken: z.string().max(2000).optional(),
  tokenExpiresAt: z.number().optional(),
  authMethod: z.enum(['api_key', 'oauth']).optional(),
}).optional();

export const LLMSettingsSchema = z.object({
  providerType: LLMProviderTypeSchema,
  modelKey: z.string().max(200),
  anthropic: AnthropicSettingsSchema,
  bedrock: BedrockSettingsSchema,
  ollama: OllamaSettingsSchema,
  gemini: GeminiSettingsSchema,
  openrouter: OpenRouterSettingsSchema,
  openai: OpenAISettingsSchema,
});

// ============ Search Settings Schemas ============

export const SearchProviderTypeSchema = z.enum(['tavily', 'brave', 'serpapi', 'google']).nullable();

export const SearchSettingsSchema = z.object({
  primaryProvider: SearchProviderTypeSchema,
  fallbackProvider: SearchProviderTypeSchema,
  tavily: z.object({
    apiKey: z.string().max(500).optional(),
  }).optional(),
  brave: z.object({
    apiKey: z.string().max(500).optional(),
  }).optional(),
  serpapi: z.object({
    apiKey: z.string().max(500).optional(),
  }).optional(),
  google: z.object({
    apiKey: z.string().max(500).optional(),
    searchEngineId: z.string().max(500).optional(),
  }).optional(),
});

// ============ Guardrail Settings Schema ============

export const GuardrailSettingsSchema = z.object({
  // Token budget
  maxTokensPerTask: z.number().int().min(1000).max(10000000).default(100000),
  tokenBudgetEnabled: z.boolean().default(true),

  // Cost budget
  maxCostPerTask: z.number().min(0.01).max(100).default(1.00),
  costBudgetEnabled: z.boolean().default(false),

  // Dangerous commands
  blockDangerousCommands: z.boolean().default(true),
  customBlockedPatterns: z.array(z.string().max(500)).max(50).default([]),

  // Auto-approve trusted commands
  autoApproveTrustedCommands: z.boolean().default(false),
  trustedCommandPatterns: z.array(z.string().max(500)).max(100).default([]),

  // File size
  maxFileSizeMB: z.number().int().min(1).max(500).default(50),
  fileSizeLimitEnabled: z.boolean().default(true),

  // Network domains
  enforceAllowedDomains: z.boolean().default(false),
  allowedDomains: z.array(z.string().max(255)).max(100).default([]),

  // Iterations
  maxIterationsPerTask: z.number().int().min(5).max(500).default(50),
  iterationLimitEnabled: z.boolean().default(true),
});

// ============ Gateway/Channel Schemas ============

export const SecurityModeSchema = z.enum(['pairing', 'allowlist', 'open']);

export const AddTelegramChannelSchema = z.object({
  type: z.literal('telegram'),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  botToken: z.string().min(1).max(500),
  securityMode: SecurityModeSchema.optional(),
});

export const AddDiscordChannelSchema = z.object({
  type: z.literal('discord'),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  botToken: z.string().min(1).max(500),
  applicationId: z.string().min(1).max(100),
  guildIds: z.array(z.string().max(100)).max(100).optional(),
  securityMode: SecurityModeSchema.optional(),
});

export const AddSlackChannelSchema = z.object({
  type: z.literal('slack'),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  botToken: z.string().min(1).max(500),
  appToken: z.string().min(1).max(500),
  signingSecret: z.string().max(500).optional(),
  securityMode: SecurityModeSchema.optional(),
});

export const AddWhatsAppChannelSchema = z.object({
  type: z.literal('whatsapp'),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  allowedNumbers: z.array(z.string().max(20)).max(100).optional(),
  securityMode: SecurityModeSchema.optional(),
  selfChatMode: z.boolean().optional(),
  responsePrefix: z.string().max(20).optional(),
});

export const DmPolicySchema = z.enum(['open', 'allowlist', 'pairing', 'disabled']);
export const GroupPolicySchema = z.enum(['open', 'allowlist', 'disabled']);

export const AddImessageChannelSchema = z.object({
  type: z.literal('imessage'),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  cliPath: z.string().max(500).optional(),
  dbPath: z.string().max(500).optional(),
  allowedContacts: z.array(z.string().max(100)).max(100).optional(),
  securityMode: SecurityModeSchema.optional(),
  dmPolicy: DmPolicySchema.optional(),
  groupPolicy: GroupPolicySchema.optional(),
  responsePrefix: z.string().max(20).optional(),
});

export const AddChannelSchema = z.discriminatedUnion('type', [
  AddTelegramChannelSchema,
  AddDiscordChannelSchema,
  AddSlackChannelSchema,
  AddWhatsAppChannelSchema,
  AddImessageChannelSchema,
]);

export const ChannelConfigSchema = z.object({
  selfChatMode: z.boolean().optional(),
  responsePrefix: z.string().max(20).optional(),
}).passthrough(); // Allow additional properties

export const UpdateChannelSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
  securityMode: SecurityModeSchema.optional(),
  config: ChannelConfigSchema.optional(),
});

export const GrantAccessSchema = z.object({
  channelId: z.string().uuid(),
  userId: z.string().min(1).max(100),
  displayName: z.string().max(MAX_TITLE_LENGTH).optional(),
});

export const RevokeAccessSchema = z.object({
  channelId: z.string().uuid(),
  userId: z.string().min(1).max(100),
});

export const GeneratePairingSchema = z.object({
  channelId: z.string().uuid(),
  userId: z.string().max(100).optional(),
  displayName: z.string().max(MAX_TITLE_LENGTH).optional(),
});

// ============ File Operation Schemas ============

export const FilePathSchema = z.object({
  filePath: z.string().min(1).max(MAX_PATH_LENGTH),
  workspacePath: z.string().min(1).max(MAX_PATH_LENGTH),
});

// ============ ID Schemas (for simple string ID params) ============

export const UUIDSchema = z.string().uuid();
export const StringIdSchema = z.string().min(1).max(100);

// ============ MCP (Model Context Protocol) Schemas ============

export const MCPTransportTypeSchema = z.enum(['stdio', 'sse', 'websocket']);

export const MCPAuthConfigSchema = z.object({
  type: z.enum(['none', 'bearer', 'api-key', 'basic']),
  token: z.string().max(2000).optional(),
  apiKey: z.string().max(2000).optional(),
  username: z.string().max(500).optional(),
  password: z.string().max(500).optional(),
  headerName: z.string().max(100).optional(),
}).optional();

export const MCPServerConfigSchema = z.object({
  id: z.string().uuid().optional(), // Optional for create (will be generated)
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional(),
  enabled: z.boolean().default(true),
  transport: MCPTransportTypeSchema,

  // stdio transport config
  command: z.string().max(1000).optional(),
  args: z.array(z.string().max(500)).max(50).optional(),
  env: z.record(z.string(), z.string().max(500)).optional(),
  cwd: z.string().max(MAX_PATH_LENGTH).optional(),

  // HTTP-based transport config
  url: z.string().url().max(500).optional(),
  headers: z.record(z.string(), z.string().max(1000)).optional(),

  // Authentication
  auth: MCPAuthConfigSchema,

  // Timeouts
  connectionTimeout: z.number().int().min(1000).max(120000).optional(),
  requestTimeout: z.number().int().min(1000).max(300000).optional(),

  // Metadata
  version: z.string().max(100).optional(),
  author: z.string().max(200).optional(),
  homepage: z.string().url().max(500).optional(),
  repository: z.string().url().max(500).optional(),
  license: z.string().max(100).optional(),
});

export const MCPServerUpdateSchema = MCPServerConfigSchema.partial().omit({ id: true });

export const MCPSettingsSchema = z.object({
  servers: z.array(MCPServerConfigSchema).max(50),
  autoConnect: z.boolean().default(true),
  toolNamePrefix: z.string().min(0).max(50).default('mcp_'),
  maxReconnectAttempts: z.number().int().min(0).max(20).default(5),
  reconnectDelayMs: z.number().int().min(100).max(60000).default(1000),
  registryEnabled: z.boolean().default(true),
  registryUrl: z.string().url().max(500).optional(),
  hostEnabled: z.boolean().default(false),
  hostPort: z.number().int().min(1024).max(65535).optional(),
});

// MCP Registry schemas
export const MCPRegistrySearchSchema = z.object({
  query: z.string().max(200).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
});

// ============ Hooks (Webhooks) Schemas ============

export const HookMappingChannelSchema = z.enum(['telegram', 'discord', 'slack', 'whatsapp', 'imessage', 'last']);

export const HookMappingSchema = z.object({
  id: z.string().max(100).optional(),
  match: z.object({
    path: z.string().max(500).optional(),
    source: z.string().max(100).optional(),
  }).optional(),
  action: z.enum(['wake', 'agent']).optional(),
  wakeMode: z.enum(['now', 'next-heartbeat']).optional(),
  name: z.string().max(200).optional(),
  sessionKey: z.string().max(100).optional(),
  messageTemplate: z.string().max(10000).optional(),
  textTemplate: z.string().max(10000).optional(),
  deliver: z.boolean().optional(),
  channel: HookMappingChannelSchema.optional(),
  to: z.string().max(100).optional(),
  model: z.string().max(100).optional(),
  thinking: z.string().max(50).optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
});

// ============ Validation Helper ============

/**
 * Validate input against a schema and throw a user-friendly error if invalid
 */
export function validateInput<T>(schema: z.ZodSchema<T>, input: unknown, context?: string): T {
  const result = schema.safeParse(input);
  if (!result.success) {
    // Zod v4 uses 'issues' instead of 'errors'
    const issues = result.error.issues;
    const errorMessages = issues.map((issue: z.ZodIssue) => `${issue.path.join('.')}: ${issue.message}`).join(', ');
    const prefix = context ? `Invalid ${context}: ` : 'Invalid input: ';
    throw new Error(`${prefix}${errorMessages}`);
  }
  return result.data;
}
