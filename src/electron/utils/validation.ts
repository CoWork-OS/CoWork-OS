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
  }).optional(),
});

// ============ Task Schemas ============

export const TaskCreateSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  workspaceId: z.string().uuid(),
  budgetTokens: z.number().int().positive().optional(),
  budgetCost: z.number().positive().optional(),
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

export const LLMProviderTypeSchema = z.enum(['anthropic', 'bedrock', 'ollama', 'gemini', 'openrouter']);

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

export const LLMSettingsSchema = z.object({
  providerType: LLMProviderTypeSchema,
  modelKey: z.string().max(200),
  anthropic: AnthropicSettingsSchema,
  bedrock: BedrockSettingsSchema,
  ollama: OllamaSettingsSchema,
  gemini: GeminiSettingsSchema,
  openrouter: OpenRouterSettingsSchema,
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

export const AddChannelSchema = z.discriminatedUnion('type', [
  AddTelegramChannelSchema,
  AddDiscordChannelSchema,
]);

export const UpdateChannelSchema = z.object({
  id: z.string().uuid(),
  name: z.string().min(1).max(MAX_TITLE_LENGTH).optional(),
  securityMode: SecurityModeSchema.optional(),
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
  userId: z.string().min(1).max(100),
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
