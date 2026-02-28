/**
 * Input validation schemas for IPC handlers using Zod
 * Provides type-safe validation to prevent malformed input attacks
 */

import * as path from "path";
import { z } from "zod";
import { LLM_PROVIDER_TYPES, isTempWorkspaceId, PersonalityId } from "../../shared/types";
import { assertSafeLoomMailboxFolder, isSecureOrLocalLoomUrl } from "./loom";

// Common validation patterns
const _MAX_STRING_LENGTH = 10000;
const MAX_PATH_LENGTH = 4096;
const MAX_TITLE_LENGTH = 500;
const MAX_PROMPT_LENGTH = 500000; // ~125K tokens; fits within 200K-token model context
const MAX_IMAGES_PER_MESSAGE = 5;
const MAX_TOTAL_TASK_IMAGE_BYTES = 125 * 1024 * 1024;
const LOOM_MAILBOX_FOLDER_ERROR = "LOOM mailbox folder contains invalid characters";

const PersonalityIdSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim() : value),
  z.enum([
    "professional",
    "friendly",
    "concise",
    "creative",
    "technical",
    "casual",
    "custom",
  ] as const satisfies readonly PersonalityId[]),
);

const OriginChannelSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.enum([
    "telegram",
    "discord",
    "slack",
    "whatsapp",
    "imessage",
    "signal",
    "mattermost",
    "matrix",
    "twitch",
    "line",
    "bluebubbles",
    "email",
    "teams",
    "googlechat",
    "x",
  ] as const),
);

const LlmProfileSchema = z.enum(["strong", "cheap"]);

// ============ Workspace Schemas ============

export const WorkspaceCreateSchema = z.object({
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  path: z.string().min(1).max(MAX_PATH_LENGTH),
  permissions: z
    .object({
      read: z.boolean().default(true),
      write: z.boolean().default(true),
      delete: z.boolean().default(false),
      network: z.boolean().default(false),
      shell: z.boolean().default(false),
      // Broader filesystem access
      unrestrictedFileAccess: z.boolean().default(false),
      allowedPaths: z.array(z.string().max(MAX_PATH_LENGTH)).max(50).optional(),
    })
    .optional(),
});

// ============ Task Schemas ============

export const AgentConfigSchema = z
  .object({
    providerType: z.enum(LLM_PROVIDER_TYPES).optional(),
    modelKey: z.string().max(200).optional(),
    llmProfile: LlmProfileSchema.optional(),
    llmProfileForced: z.boolean().optional(),
    llmProfileHint: LlmProfileSchema.optional(),
    personalityId: PersonalityIdSchema.optional(),
    gatewayContext: z.enum(["private", "group", "public"]).optional(),
    toolRestrictions: z.array(z.string().min(1).max(200)).max(50).optional(),
    allowedTools: z.array(z.string().min(1).max(200)).max(120).optional(),
    originChannel: OriginChannelSchema.optional(),
    maxTurns: z.number().int().min(1).max(100).optional(),
    maxTokens: z.number().int().min(1).max(1_000_000).optional(),
    retainMemory: z.boolean().optional(),
    bypassQueue: z.boolean().optional(),
    allowUserInput: z.boolean().optional(),
    allowSharedContextMemory: z.boolean().optional(),
    conversationMode: z.enum(["task", "chat", "hybrid"]).optional(),
    executionMode: z.enum(["execute", "propose", "analyze"]).optional(),
    taskDomain: z
      .enum(["auto", "code", "research", "operations", "writing", "general"])
      .optional(),
    autonomousMode: z.boolean().optional(),
    qualityPasses: z.union([z.literal(1), z.literal(2), z.literal(3)]).optional(),
    collaborativeMode: z.boolean().optional(),
    multiLlmMode: z.boolean().optional(),
    multiLlmConfig: z
      .object({
        participants: z
          .array(
            z.object({
              providerType: z.enum(LLM_PROVIDER_TYPES),
              modelKey: z.string().max(200),
              displayName: z.string().max(200),
              isJudge: z.boolean(),
            }),
          )
          .min(2)
          .max(10),
        judgeProviderType: z.enum(LLM_PROVIDER_TYPES),
        judgeModelKey: z.string().max(200),
      })
      .optional(),
    verificationAgent: z.boolean().optional(),
    reviewPolicy: z.enum(["off", "balanced", "strict"]).optional(),
  })
  .strict();

const isValidWorkspaceId = (workspaceId: string): boolean =>
  isTempWorkspaceId(workspaceId) || z.string().uuid().safeParse(workspaceId).success;

export const WorkspaceIdSchema = z
  .string()
  .refine(isValidWorkspaceId, { message: "Must be a valid UUID or temp workspace ID" });

const ImageAttachmentSchema = z
  .object({
    data: z.string().trim().min(1).optional(),
    filePath: z.string().trim().max(MAX_PATH_LENGTH).optional(),
    mimeType: z.enum(["image/jpeg", "image/png", "image/gif", "image/webp"]),
    filename: z.string().max(255).optional(),
    sizeBytes: z
      .number()
      .int()
      .positive()
      .max(25 * 1024 * 1024), // 25MB absolute max
    tempFile: z.boolean().optional(),
  })
  .superRefine((data, ctx) => {
    const hasData = typeof data.data === "string" && data.data.trim().length > 0;
    const hasFilePath = typeof data.filePath === "string" && data.filePath.trim().length > 0;
    if (hasData === hasFilePath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data"],
        message: 'Image attachment must provide exactly one of "data" or "filePath".',
      });
      return;
    }

    if (hasFilePath && data.filePath) {
      if (!path.isAbsolute(data.filePath)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["filePath"],
          message: "Image attachment file path must be an absolute path.",
        });
        return;
      }

      const ext = path.extname(data.filePath).toLowerCase();
      const supportedExtensions = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
      if (!supportedExtensions.has(ext)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["filePath"],
          message: `Unsupported image extension "${ext}".`,
        });
      }
    }
  });

export const TaskCreateSchema = z.object({
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
  prompt: z.string().min(1).max(MAX_PROMPT_LENGTH),
  workspaceId: WorkspaceIdSchema,
  budgetTokens: z.number().int().positive().optional(),
  budgetCost: z.number().positive().optional(),
  agentConfig: AgentConfigSchema.optional(),
  images: z.array(ImageAttachmentSchema).max(MAX_IMAGES_PER_MESSAGE).optional(),
});

export const TaskRenameSchema = z.object({
  id: z.string().uuid(),
  title: z.string().min(1).max(MAX_TITLE_LENGTH),
});

export const TaskMessageSchema = z
  .object({
    taskId: z.string().uuid(),
    message: z.string().min(1).max(MAX_PROMPT_LENGTH),
    images: z.array(ImageAttachmentSchema).max(MAX_IMAGES_PER_MESSAGE).optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.images || data.images.length === 0) {
      return;
    }

    const totalImageBytes = data.images.reduce((sum, image) => {
      const sizeBytes = Number(image.sizeBytes);
      return Number.isFinite(sizeBytes) && sizeBytes > 0 ? sum + sizeBytes : sum;
    }, 0);

    if (totalImageBytes > MAX_TOTAL_TASK_IMAGE_BYTES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["images"],
        message: `Total image payload exceeds ${MAX_TOTAL_TASK_IMAGE_BYTES} bytes`,
      });
    }
  });

export const StepFeedbackSchema = z.object({
  taskId: z.string().uuid(),
  stepId: z.string().min(1).max(100),
  action: z.enum(["retry", "skip", "stop", "drift"]),
  message: z.string().max(MAX_PROMPT_LENGTH).optional(),
});

export const FileImportSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  files: z.array(z.string().min(1).max(MAX_PATH_LENGTH)).min(1).max(20),
});

export const FileImportDataSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  files: z
    .array(
      z.object({
        name: z.string().min(1).max(MAX_PATH_LENGTH),
        data: z.string().min(1),
        mimeType: z.string().max(200).optional(),
      }),
    )
    .min(1)
    .max(20),
});

// ============ Approval Schemas ============

export const ApprovalResponseSchema = z.object({
  approvalId: z.string().uuid(),
  approved: z.boolean(),
});

// ============ LLM Settings Schemas ============

export const LLMProviderTypeSchema = z.enum(LLM_PROVIDER_TYPES);

const ProviderRoutingSettingsSchema = {
  profileRoutingEnabled: z.boolean().optional(),
  strongModelKey: z.string().max(200).optional(),
  cheapModelKey: z.string().max(200).optional(),
  preferStrongForVerification: z.boolean().optional(),
} as const;

export const AnthropicSettingsSchema = z
  .object({
    apiKey: z.string().max(500).optional(),
    ...ProviderRoutingSettingsSchema,
  })
  .optional();

export const BedrockSettingsSchema = z
  .object({
    region: z.string().max(100).optional(),
    accessKeyId: z.string().max(500).optional(),
    secretAccessKey: z.string().max(500).optional(),
    sessionToken: z.string().max(2000).optional(),
    profile: z.string().max(100).optional(),
    useDefaultCredentials: z.boolean().optional(),
    model: z.string().max(200).optional(),
    ...ProviderRoutingSettingsSchema,
  })
  .optional();

export const OllamaSettingsSchema = z
  .object({
    baseUrl: z.string().url().max(500).optional(),
    model: z.string().max(200).optional(),
    apiKey: z.string().max(500).optional(),
    ...ProviderRoutingSettingsSchema,
  })
  .optional();

export const GeminiSettingsSchema = z
  .object({
    apiKey: z.string().max(500).optional(),
    model: z.string().max(200).optional(),
    ...ProviderRoutingSettingsSchema,
  })
  .optional();

export const OpenRouterSettingsSchema = z
  .object({
    apiKey: z.string().max(500).optional(),
    model: z.string().max(200).optional(),
    baseUrl: z.string().max(500).optional(),
    ...ProviderRoutingSettingsSchema,
  })
  .optional();

export const OpenAISettingsSchema = z
  .object({
    apiKey: z.string().max(500).optional(),
    model: z.string().max(200).optional(),
    // OAuth tokens (alternative to API key)
    accessToken: z.string().max(2000).optional(),
    refreshToken: z.string().max(2000).optional(),
    tokenExpiresAt: z.number().optional(),
    authMethod: z.enum(["api_key", "oauth"]).optional(),
    ...ProviderRoutingSettingsSchema,
  })
  .optional();

export const AzureSettingsSchema = z
  .object({
    apiKey: z.string().max(500).optional(),
    endpoint: z.string().max(500).optional(),
    deployment: z.string().max(200).optional(),
    deployments: z.array(z.string().max(200)).max(50).optional(),
    apiVersion: z.string().max(200).optional(),
    ...ProviderRoutingSettingsSchema,
  })
  .optional();

export const GroqSettingsSchema = z
  .object({
    apiKey: z.string().max(500).optional(),
    model: z.string().max(200).optional(),
    baseUrl: z.string().max(500).optional(),
    ...ProviderRoutingSettingsSchema,
  })
  .optional();

export const XAISettingsSchema = z
  .object({
    apiKey: z.string().max(500).optional(),
    model: z.string().max(200).optional(),
    baseUrl: z.string().max(500).optional(),
    ...ProviderRoutingSettingsSchema,
  })
  .optional();

export const KimiSettingsSchema = z
  .object({
    apiKey: z.string().max(500).optional(),
    model: z.string().max(200).optional(),
    baseUrl: z.string().max(500).optional(),
    ...ProviderRoutingSettingsSchema,
  })
  .optional();

export const OpenAICompatibleSettingsSchema = z
  .object({
    apiKey: z.string().max(500).optional(),
    baseUrl: z.string().max(500).optional(),
    model: z.string().max(200).optional(),
    ...ProviderRoutingSettingsSchema,
  })
  .optional();

export const CustomProviderConfigSchema = z.object({
  apiKey: z.string().max(500).optional(),
  model: z.string().max(200).optional(),
  baseUrl: z.string().max(500).optional(),
  ...ProviderRoutingSettingsSchema,
});

export const CustomProvidersSchema = z.record(z.string(), CustomProviderConfigSchema).optional();

export const LLMSettingsSchema = z.object({
  providerType: LLMProviderTypeSchema,
  modelKey: z.string().max(200),
  anthropic: AnthropicSettingsSchema,
  bedrock: BedrockSettingsSchema,
  ollama: OllamaSettingsSchema,
  gemini: GeminiSettingsSchema,
  openrouter: OpenRouterSettingsSchema,
  openai: OpenAISettingsSchema,
  azure: AzureSettingsSchema,
  groq: GroqSettingsSchema,
  xai: XAISettingsSchema,
  kimi: KimiSettingsSchema,
  openaiCompatible: OpenAICompatibleSettingsSchema,
  customProviders: CustomProvidersSchema,
});

// ============ Search Settings Schemas ============

export const SearchProviderTypeSchema = z
  .enum(["tavily", "brave", "serpapi", "google", "duckduckgo"])
  .nullable();

export const SearchSettingsSchema = z.object({
  primaryProvider: SearchProviderTypeSchema,
  fallbackProvider: SearchProviderTypeSchema,
  tavily: z
    .object({
      apiKey: z.string().max(500).optional(),
    })
    .optional(),
  brave: z
    .object({
      apiKey: z.string().max(500).optional(),
    })
    .optional(),
  serpapi: z
    .object({
      apiKey: z.string().max(500).optional(),
    })
    .optional(),
  google: z
    .object({
      apiKey: z.string().max(500).optional(),
      searchEngineId: z.string().max(500).optional(),
    })
    .optional(),
});

// ============ X/Twitter Settings Schema ============

export const XSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  authMethod: z.enum(["browser", "manual"]).default("browser"),
  authToken: z.string().max(2000).optional(),
  ct0: z.string().max(2000).optional(),
  cookieSource: z.array(z.string().max(50)).max(10).optional(),
  chromeProfile: z.string().max(200).optional(),
  chromeProfileDir: z.string().max(MAX_PATH_LENGTH).optional(),
  firefoxProfile: z.string().max(200).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  cookieTimeoutMs: z.number().int().min(1000).max(120000).optional(),
  quoteDepth: z.number().int().min(0).max(5).optional(),
  mentionTrigger: z
    .object({
      enabled: z.boolean().default(false),
      commandPrefix: z.string().trim().min(1).max(50).default("do:"),
      allowedAuthors: z.array(z.string().trim().min(1).max(50)).max(200).default([]),
      pollIntervalSec: z.number().int().min(30).max(3600).default(120),
      fetchCount: z.number().int().min(1).max(200).default(25),
      workspaceMode: z.enum(["temporary"]).default("temporary"),
    })
    .default({
      enabled: false,
      commandPrefix: "do:",
      allowedAuthors: [],
      pollIntervalSec: 120,
      fetchCount: 25,
      workspaceMode: "temporary",
    }),
}).superRefine((data, ctx) => {
  if (data.mentionTrigger.enabled && data.mentionTrigger.allowedAuthors.length === 0) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["mentionTrigger", "allowedAuthors"],
      message: "At least one allowed author is required when mention trigger is enabled",
    });
  }
});

// ============ Notion Settings Schema ============

export const NotionSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  apiKey: z.string().max(2000).optional(),
  notionVersion: z.string().max(50).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
});

// ============ Box Settings Schema ============

export const BoxSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  accessToken: z.string().max(4000).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
});

// ============ OneDrive Settings Schema ============

export const OneDriveSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  accessToken: z.string().max(4000).optional(),
  driveId: z.string().max(200).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
});

// ============ Google Workspace Settings Schema ============

export const GoogleWorkspaceSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  clientId: z.string().max(4000).optional(),
  clientSecret: z.string().max(4000).optional(),
  accessToken: z.string().max(4000).optional(),
  refreshToken: z.string().max(4000).optional(),
  tokenExpiresAt: z.number().int().optional(),
  scopes: z.array(z.string().max(200)).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
});

// ============ Dropbox Settings Schema ============

export const DropboxSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  accessToken: z.string().max(4000).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
});

// ============ SharePoint Settings Schema ============

export const SharePointSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  accessToken: z.string().max(4000).optional(),
  siteId: z.string().max(500).optional(),
  driveId: z.string().max(500).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
});

// ============ Guardrail Settings Schema ============

export const GuardrailSettingsSchema = z.object({
  // Token budget
  maxTokensPerTask: z.number().int().min(1000).max(10000000).default(100000),
  tokenBudgetEnabled: z.boolean().default(true),

  // Cost budget
  maxCostPerTask: z.number().min(0.01).max(100).default(1.0),
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

// ============ Infrastructure Settings Schema ============

export const InfraSettingsSchema = z
  .object({
    enabled: z.boolean(),
    showWalletInSidebar: z.boolean(),
    e2b: z.object({
      apiKey: z.string().max(500),
      defaultRegion: z.string().max(100),
    }),
    domains: z.object({
      provider: z.literal("namecheap"),
      apiKey: z.string().max(500),
      username: z.string().max(200),
      clientIp: z.string().max(45),
    }),
    wallet: z.object({
      enabled: z.boolean(),
      provider: z.enum(["local", "coinbase_agentic"]),
      coinbase: z.object({
        enabled: z.boolean(),
        signerEndpoint: z.string().max(500),
        network: z.enum(["base-mainnet", "base-sepolia"]),
        accountId: z.string().max(200),
      }),
    }),
    payments: z.object({
      requireApproval: z.boolean(),
      maxAutoApproveUsd: z.number().min(0).max(1000),
      hardLimitUsd: z.number().min(0).max(10000),
      allowedHosts: z.array(z.string().max(255)).max(200),
    }),
    enabledCategories: z.object({
      sandbox: z.boolean(),
      domains: z.boolean(),
      payments: z.boolean(),
    }),
  })
  .strict();

// ============ Gateway/Channel Schemas ============

export const SecurityModeSchema = z.enum(["pairing", "allowlist", "open"]);

export const AddTelegramChannelSchema = z.object({
  type: z.literal("telegram"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  botToken: z.string().min(1).max(500),
  securityMode: SecurityModeSchema.optional(),
});

export const AddDiscordChannelSchema = z.object({
  type: z.literal("discord"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  botToken: z.string().min(1).max(500),
  applicationId: z.string().min(1).max(100),
  guildIds: z.array(z.string().max(100)).max(100).optional(),
  securityMode: SecurityModeSchema.optional(),
});

export const AddSlackChannelSchema = z.object({
  type: z.literal("slack"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  botToken: z.string().min(1).max(500),
  appToken: z.string().min(1).max(500),
  signingSecret: z.string().max(500).optional(),
  securityMode: SecurityModeSchema.optional(),
});

export const AddWhatsAppChannelSchema = z.object({
  type: z.literal("whatsapp"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  allowedNumbers: z.array(z.string().max(20)).max(100).optional(),
  securityMode: SecurityModeSchema.optional(),
  ambientMode: z.boolean().optional(),
  silentUnauthorized: z.boolean().optional(),
  selfChatMode: z.boolean().optional(),
  groupRoutingMode: z
    .enum(["all", "mentionsOnly", "mentionsOrCommands", "commandsOnly"])
    .optional(),
  trustedGroupMemoryOptIn: z.boolean().optional(),
  sendReadReceipts: z.boolean().optional(),
  deduplicationEnabled: z.boolean().optional(),
  responsePrefix: z.string().max(20).optional(),
  ingestNonSelfChatsInSelfChatMode: z.boolean().optional(),
});

export const DmPolicySchema = z.enum(["open", "allowlist", "pairing", "disabled"]);
export const GroupPolicySchema = z.enum(["open", "allowlist", "disabled"]);
export const SignalModeSchema = z.enum(["native", "daemon"]);
export const SignalTrustModeSchema = z.enum(["tofu", "always", "manual"]);

export const AddImessageChannelSchema = z.object({
  type: z.literal("imessage"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  cliPath: z.string().max(500).optional(),
  dbPath: z.string().max(500).optional(),
  allowedContacts: z.array(z.string().max(100)).max(100).optional(),
  securityMode: SecurityModeSchema.optional(),
  ambientMode: z.boolean().optional(),
  silentUnauthorized: z.boolean().optional(),
  dmPolicy: DmPolicySchema.optional(),
  groupPolicy: GroupPolicySchema.optional(),
  responsePrefix: z.string().max(20).optional(),
  captureSelfMessages: z.boolean().optional(),
});

export const AddSignalChannelSchema = z.object({
  type: z.literal("signal"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  phoneNumber: z.string().min(1).max(20),
  dataDir: z.string().max(MAX_PATH_LENGTH).optional(),
  securityMode: SecurityModeSchema.optional(),
  mode: SignalModeSchema.optional(),
  trustMode: SignalTrustModeSchema.optional(),
  dmPolicy: DmPolicySchema.optional(),
  groupPolicy: GroupPolicySchema.optional(),
  sendReadReceipts: z.boolean().optional(),
  sendTypingIndicators: z.boolean().optional(),
});

export const AddMattermostChannelSchema = z.object({
  type: z.literal("mattermost"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  mattermostServerUrl: z.string().url().min(1).max(500),
  mattermostToken: z.string().min(1).max(500),
  mattermostTeamId: z.string().max(100).optional(),
  securityMode: SecurityModeSchema.optional(),
});

export const AddMatrixChannelSchema = z.object({
  type: z.literal("matrix"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  matrixHomeserver: z.string().url().min(1).max(500),
  matrixUserId: z.string().min(1).max(200),
  matrixAccessToken: z.string().min(1).max(1000),
  matrixDeviceId: z.string().max(200).optional(),
  matrixRoomIds: z.array(z.string().max(200)).max(100).optional(),
  securityMode: SecurityModeSchema.optional(),
});

export const AddTwitchChannelSchema = z.object({
  type: z.literal("twitch"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  twitchUsername: z.string().min(1).max(100),
  twitchOauthToken: z.string().min(1).max(500),
  twitchChannels: z.array(z.string().max(100)).min(1).max(50),
  twitchAllowWhispers: z.boolean().optional(),
  securityMode: SecurityModeSchema.optional(),
});

export const AddLineChannelSchema = z.object({
  type: z.literal("line"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  lineChannelAccessToken: z.string().min(1).max(500),
  lineChannelSecret: z.string().min(1).max(200),
  lineWebhookPort: z.number().int().min(1024).max(65535).optional(),
  securityMode: SecurityModeSchema.optional(),
});

export const AddBlueBubblesChannelSchema = z.object({
  type: z.literal("bluebubbles"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  blueBubblesServerUrl: z.string().url().min(1).max(500),
  blueBubblesPassword: z.string().min(1).max(500),
  blueBubblesWebhookPort: z.number().int().min(1024).max(65535).optional(),
  blueBubblesAllowedContacts: z.array(z.string().max(100)).max(100).optional(),
  securityMode: SecurityModeSchema.optional(),
  ambientMode: z.boolean().optional(),
  silentUnauthorized: z.boolean().optional(),
  captureSelfMessages: z.boolean().optional(),
});

export const AddXChannelSchema = z.object({
  type: z.literal("x"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  securityMode: SecurityModeSchema.optional(),
  xCommandPrefix: z.string().trim().min(1).max(50).optional(),
  xAllowedAuthors: z.array(z.string().trim().min(1).max(50)).max(200).optional(),
  xPollIntervalSec: z.number().int().min(30).max(3600).optional(),
  xFetchCount: z.number().int().min(1).max(200).optional(),
  xOutboundEnabled: z.boolean().optional(),
});

const getOptionalString = (value: unknown): string | undefined => {
  return typeof value === "string" ? value.trim() || undefined : undefined;
};

const isSafeLoomMailboxFolder = (value: unknown): boolean => {
  if (value === undefined) return true;
  if (typeof value !== "string") return false;
  try {
    assertSafeLoomMailboxFolder(value);
    return true;
  } catch {
    return false;
  }
};

const EMAIL_FIELD_KEY_MAP = {
  add: {
    protocol: "emailProtocol",
    email: "emailAddress",
    password: "emailPassword",
    imapHost: "emailImapHost",
    imapPort: "emailImapPort",
    smtpHost: "emailSmtpHost",
    smtpPort: "emailSmtpPort",
    loomBaseUrl: "emailLoomBaseUrl",
    loomAccessToken: "emailLoomAccessToken",
  } as const,
  update: {
    protocol: "protocol",
    email: "email",
    password: "password",
    imapHost: "imapHost",
    imapPort: "imapPort",
    smtpHost: "smtpHost",
    smtpPort: "smtpPort",
    loomBaseUrl: "loomBaseUrl",
    loomAccessToken: "loomAccessToken",
  } as const,
} as const;

type EmailSchemaMode = keyof typeof EMAIL_FIELD_KEY_MAP;
type _EmailFieldKeys = (typeof EMAIL_FIELD_KEY_MAP)[EmailSchemaMode];

const EMAIL_TRANSPORT_BASE_SHAPES: Record<EmailSchemaMode, z.ZodRawShape> = {
  add: {
    [EMAIL_FIELD_KEY_MAP.add.protocol]: z.enum(["imap-smtp", "loom"]).optional(),
    [EMAIL_FIELD_KEY_MAP.add.email]: z.string().email().min(1).max(200).optional(),
    [EMAIL_FIELD_KEY_MAP.add.password]: z.string().min(1).max(500).optional(),
    [EMAIL_FIELD_KEY_MAP.add.imapHost]: z.string().min(1).max(200).optional(),
    [EMAIL_FIELD_KEY_MAP.add.imapPort]: z.number().int().min(1).max(65535).optional(),
    [EMAIL_FIELD_KEY_MAP.add.smtpHost]: z.string().min(1).max(200).optional(),
    [EMAIL_FIELD_KEY_MAP.add.smtpPort]: z.number().int().min(1).max(65535).optional(),
    [EMAIL_FIELD_KEY_MAP.add.loomBaseUrl]: z.string().url().max(500).optional(),
    [EMAIL_FIELD_KEY_MAP.add.loomAccessToken]: z.string().min(1).max(4000).optional(),
  },
  update: {
    [EMAIL_FIELD_KEY_MAP.update.protocol]: z.enum(["imap-smtp", "loom"]).optional(),
    [EMAIL_FIELD_KEY_MAP.update.email]: z.string().email().min(1).max(200).optional(),
    [EMAIL_FIELD_KEY_MAP.update.password]: z.string().min(1).max(500).optional(),
    [EMAIL_FIELD_KEY_MAP.update.imapHost]: z.string().min(1).max(200).optional(),
    [EMAIL_FIELD_KEY_MAP.update.imapPort]: z.number().int().min(1).max(65535).optional(),
    [EMAIL_FIELD_KEY_MAP.update.smtpHost]: z.string().min(1).max(200).optional(),
    [EMAIL_FIELD_KEY_MAP.update.smtpPort]: z.number().int().min(1).max(65535).optional(),
    [EMAIL_FIELD_KEY_MAP.update.loomBaseUrl]: z.string().url().max(500).optional(),
    [EMAIL_FIELD_KEY_MAP.update.loomAccessToken]: z.string().min(1).max(4000).optional(),
  },
};

const createEmailTransportSchema = (mode: EmailSchemaMode): z.ZodObject<z.ZodRawShape> => {
  const fieldMap = EMAIL_FIELD_KEY_MAP[mode];
  return z.object(EMAIL_TRANSPORT_BASE_SHAPES[mode]).superRefine((data, ctx) => {
    validateEmailChannelConfigByProtocol(data as Record<string, unknown>, ctx, fieldMap);
  });
};

const createEmailAddExtras = (): z.ZodRawShape => ({
  emailDisplayName: z.string().max(100).optional(),
  emailAllowedSenders: z.array(z.string().max(200)).max(100).optional(),
  emailSubjectFilter: z.string().max(200).optional(),
  emailLoomIdentity: z.string().max(300).optional(),
  emailLoomMailboxFolder: z
    .string()
    .max(100)
    .optional()
    .refine(isSafeLoomMailboxFolder, { message: LOOM_MAILBOX_FOLDER_ERROR }),
  emailLoomPollInterval: z.number().int().min(1000).max(300000).optional(),
});

const createEmailUpdateExtras = (): z.ZodRawShape => ({
  emailDisplayName: z.string().max(100).optional(),
  displayName: z.string().max(100).optional(),
  allowedSenders: z.array(z.string().max(200)).max(100).optional(),
  subjectFilter: z.string().max(200).optional(),
  loomIdentity: z.string().max(300).optional(),
  loomMailboxFolder: z
    .string()
    .max(100)
    .optional()
    .refine(isSafeLoomMailboxFolder, { message: LOOM_MAILBOX_FOLDER_ERROR }),
  loomPollInterval: z.number().int().min(1000).max(300000).optional(),
  pollInterval: z.number().int().min(1000).max(300000).optional(),
  mailbox: z.string().max(100).optional(),
  markAsRead: z.boolean().optional(),
  deduplicationEnabled: z.boolean().optional(),
  responsePrefix: z.string().max(100).optional(),
  sendReadReceipts: z.boolean().optional(),
  groupRoutingMode: z
    .enum(["all", "mentionsOnly", "mentionsOrCommands", "commandsOnly"])
    .optional(),
  selfChatMode: z.boolean().optional(),
  ambientMode: z.boolean().optional(),
  silentUnauthorized: z.boolean().optional(),
  securityMode: z.enum(["pairing", "allowlist", "open"]).optional(),
  allowedUsers: z.array(z.string()).optional(),
  pairingCodeTTL: z.number().int().optional(),
  maxPairingAttempts: z.number().int().optional(),
  rateLimitPerMinute: z.number().int().optional(),
});

const validateEmailChannelConfigByProtocol = (
  data: Record<string, unknown>,
  ctx: z.RefinementCtx,
  fieldMap: {
    protocol: "protocol" | "emailProtocol";
    email: string;
    password: string;
    imapHost: string;
    smtpHost: string;
    loomBaseUrl: string;
    loomAccessToken: string;
  },
): void => {
  const protocol = getOptionalString(data[fieldMap.protocol]) || "imap-smtp";
  if (protocol === "loom") {
    if (!getOptionalString(data[fieldMap.loomBaseUrl])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [fieldMap.loomBaseUrl],
        message: `LOOM base URL is required when ${fieldMap.protocol === "protocol" ? "protocol" : "emailProtocol"} is "loom"`,
      });
    } else if (
      typeof data[fieldMap.loomBaseUrl] === "string" &&
      !isSecureOrLocalLoomUrl(data[fieldMap.loomBaseUrl] as string)
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [fieldMap.loomBaseUrl],
        message: "LOOM base URL must use HTTPS unless it points to localhost/127.0.0.1/::1",
      });
    }

    if (!getOptionalString(data[fieldMap.loomAccessToken])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [fieldMap.loomAccessToken],
        message: `LOOM access token is required when ${fieldMap.protocol === "protocol" ? "protocol" : "emailProtocol"} is "loom"`,
      });
    }

    return;
  }

  if (!getOptionalString(data[fieldMap.email])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [fieldMap.email],
      message: "Email address is required for IMAP/SMTP mode",
    });
  }
  if (!getOptionalString(data[fieldMap.password])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [fieldMap.password],
      message: "Email password is required for IMAP/SMTP mode",
    });
  }
  if (!getOptionalString(data[fieldMap.imapHost])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [fieldMap.imapHost],
      message: "IMAP host is required for IMAP/SMTP mode",
    });
  }
  if (!getOptionalString(data[fieldMap.smtpHost])) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: [fieldMap.smtpHost],
      message: "SMTP host is required for IMAP/SMTP mode",
    });
  }
};

export const AddEmailChannelSchema = createEmailTransportSchema("add").extend({
  type: z.literal("email"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  ...createEmailAddExtras(),
  securityMode: SecurityModeSchema.optional(),
});

export const EmailChannelConfigSchema = createEmailTransportSchema("update")
  .passthrough()
  .extend(createEmailUpdateExtras());

export const AddChannelSchema = z.discriminatedUnion("type", [
  AddTelegramChannelSchema,
  AddDiscordChannelSchema,
  AddSlackChannelSchema,
  AddWhatsAppChannelSchema,
  AddImessageChannelSchema,
  AddSignalChannelSchema,
  AddMattermostChannelSchema,
  AddMatrixChannelSchema,
  AddTwitchChannelSchema,
  AddLineChannelSchema,
  AddBlueBubblesChannelSchema,
  AddXChannelSchema,
  AddEmailChannelSchema,
]);

export const ChannelConfigSchema = z
  .object({
    selfChatMode: z.boolean().optional(),
    responsePrefix: z.string().max(20).optional(),
    trustedGroupMemoryOptIn: z.boolean().optional(),
  })
  .passthrough();

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

// ============ ChatGPT Import Schema ============

export const ChatGPTImportSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  filePath: z
    .string()
    .min(1)
    .max(MAX_PATH_LENGTH)
    .refine((p) => path.isAbsolute(p), { message: "File path must be absolute" })
    .refine((p) => p.endsWith(".json"), { message: "File must be a .json file" }),
  maxConversations: z.number().int().min(0).max(10000).optional(),
  minMessages: z.number().int().min(1).max(100).optional(),
  forcePrivate: z.boolean().optional(),
  distillProvider: z.string().max(100).optional(),
  distillModel: z.string().max(200).optional(),
});

export const FindImportedSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});

// ============ Worktree/Comparison Schemas ============

export const WorktreeSettingsSchema = z
  .object({
    enabled: z.boolean(),
    autoCommitOnComplete: z.boolean(),
    autoCleanOnMerge: z.boolean(),
    branchPrefix: z.string().trim().min(1).max(100),
    commitMessagePrefix: z.string().max(200),
  })
  .strict();

export const ComparisonAgentSpecSchema = z
  .object({
    label: z.string().trim().min(1).max(100).optional(),
    agentConfig: AgentConfigSchema.optional(),
    assignedAgentRoleId: z.string().uuid().optional(),
  })
  .strict();

export const ComparisonCreateSchema = z
  .object({
    title: z.string().trim().min(1).max(MAX_TITLE_LENGTH),
    prompt: z.string().trim().min(1).max(MAX_PROMPT_LENGTH),
    workspaceId: WorkspaceIdSchema,
    agents: z.array(ComparisonAgentSpecSchema).min(2).max(8),
  })
  .strict();

// ============ File Operation Schemas ============

export const FilePathSchema = z.object({
  filePath: z.string().min(1).max(MAX_PATH_LENGTH),
  workspacePath: z.string().min(1).max(MAX_PATH_LENGTH),
});

// ============ ID Schemas (for simple string ID params) ============

export const UUIDSchema = z.string().uuid();
export const StringIdSchema = z.string().min(1).max(100);

// ============ MCP (Model Context Protocol) Schemas ============

export const MCPTransportTypeSchema = z.enum(["stdio", "sse", "websocket"]);

export const MCPAuthConfigSchema = z
  .object({
    type: z.enum(["none", "bearer", "api-key", "basic"]),
    token: z.string().max(2000).optional(),
    apiKey: z.string().max(2000).optional(),
    username: z.string().max(500).optional(),
    password: z.string().max(500).optional(),
    headerName: z.string().max(100).optional(),
  })
  .optional();

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
  toolNamePrefix: z.string().min(0).max(50).default("mcp_"),
  maxReconnectAttempts: z.number().int().min(0).max(20).default(5),
  reconnectDelayMs: z.number().int().min(100).max(60000).default(1000),
  registryEnabled: z.boolean().default(true),
  registryUrl: z.string().url().max(500).optional(),
  hostEnabled: z.boolean().default(false),
  hostPort: z.number().int().min(1024).max(65535).optional(),
});

// ============ Artifact Reputation Schemas ============

const ReputationActionSchema = z.enum(["allow", "warn", "block"]);

export const ReputationPolicySchema = z
  .object({
    clean: ReputationActionSchema.default("allow"),
    unknown: ReputationActionSchema.default("warn"),
    suspicious: ReputationActionSchema.default("warn"),
    malicious: ReputationActionSchema.default("block"),
    error: ReputationActionSchema.default("warn"),
  })
  .default({
    clean: "allow",
    unknown: "warn",
    suspicious: "warn",
    malicious: "block",
    error: "warn",
  });

export const ReputationSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  provider: z.enum(["virustotal"]).default("virustotal"),
  apiKey: z.string().max(500).optional(),
  allowUpload: z.boolean().default(false),
  rescanIntervalHours: z
    .number()
    .int()
    .min(1)
    .max(24 * 30)
    .default(24 * 7),
  enforceOnMCPConnect: z.boolean().default(true),
  disableMCPServerOnBlock: z.boolean().default(true),
  policy: ReputationPolicySchema,
});

// MCP Registry schemas
export const MCPRegistrySearchSchema = z.object({
  query: z.string().max(200).optional(),
  tags: z.array(z.string().max(50)).max(20).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  offset: z.number().int().min(0).default(0),
});

export const MCPConnectorOAuthSchema = z.object({
  provider: z.enum([
    "salesforce",
    "jira",
    "hubspot",
    "zendesk",
    "google-calendar",
    "google-drive",
    "gmail",
    "docusign",
    "outreach",
    "slack",
  ]),
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().max(500).optional(),
  scopes: z.array(z.string().max(200)).max(50).optional(),
  loginUrl: z.string().url().max(500).optional(),
  subdomain: z.string().max(200).optional(),
  teamDomain: z.string().max(200).optional(),
});

// ============ Hooks (Webhooks) Schemas ============

export const HookMappingChannelSchema = z.enum([
  "telegram",
  "discord",
  "slack",
  "whatsapp",
  "imessage",
  "signal",
  "mattermost",
  "matrix",
  "twitch",
  "line",
  "bluebubbles",
  "email",
  "last",
]);

export const HookMappingSchema = z.object({
  id: z.string().max(100).optional(),
  match: z
    .object({
      path: z.string().max(500).optional(),
      source: z.string().max(100).optional(),
    })
    .optional(),
  action: z.enum(["wake", "agent"]).optional(),
  wakeMode: z.enum(["now", "next-heartbeat"]).optional(),
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
    const errorMessages = issues
      .map((issue: z.ZodIssue) => `${issue.path.join(".")}: ${issue.message}`)
      .join(", ");
    const prefix = context ? `Invalid ${context}: ` : "Invalid input: ";
    throw new Error(`${prefix}${errorMessages}`);
  }
  return result.data;
}
