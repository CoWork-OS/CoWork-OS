/**
 * Input validation schemas for IPC handlers using Zod
 * Provides type-safe validation to prevent malformed input attacks
 */

import * as os from "os";
import * as path from "path";
import { z } from "zod";
import {
  CoreEvalCaseStatus,
  CoreExperimentStatus,
  CoreFailureCategory,
  CoreFailureClusterStatus,
  CoreFailureRecordStatus,
  CoreMemoryCandidateStatus,
  CoreMemoryScopeKind,
  CoreTraceKind,
  CoreTraceStatus,
  LLM_PROVIDER_TYPES,
  isTempWorkspaceId,
  PersonalityId,
  TaskStatus,
} from "../../shared/types";
import { SUBCONSCIOUS_TARGET_KINDS } from "../../shared/subconscious";
import { getUserDataDir } from "./user-data-dir";
import { assertSafeLoomMailboxFolder, isSecureOrLocalLoomUrl } from "./loom";

// Common validation patterns
const _MAX_STRING_LENGTH = 10000;
const MAX_PATH_LENGTH = 4096;
const MAX_TITLE_LENGTH = 500;
const MAX_PROMPT_LENGTH = 500000; // ~125K tokens; fits within 200K-token model context
const MAX_IMAGES_PER_MESSAGE = 5;
const MAX_TOTAL_TASK_IMAGE_BYTES = 125 * 1024 * 1024;
const LOOM_MAILBOX_FOLDER_ERROR =
  "LOOM mailbox folder contains invalid characters";

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
    "feishu",
    "wecom",
    "x",
  ] as const),
);

const LlmProfileSchema = z.enum(["strong", "cheap"]);
const PermissionModeSchema = z.enum([
  "default",
  "plan",
  "dangerous_only",
  "accept_edits",
  "dont_ask",
  "bypass_permissions",
]);
const PermissionRuleScopeSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("tool"),
    toolName: z.string().min(1).max(200),
  }),
  z.object({
    kind: z.literal("path"),
    path: z.string().min(1).max(MAX_PATH_LENGTH),
    toolName: z.string().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal("domain"),
    domain: z.string().min(1).max(200),
    toolName: z.string().min(1).max(200).optional(),
  }),
  z.object({
    kind: z.literal("command_prefix"),
    prefix: z.string().min(1).max(MAX_PATH_LENGTH),
  }),
  z.object({
    kind: z.literal("mcp_server"),
    serverName: z.string().min(1).max(200),
  }),
]);
const PermissionRuleSchema = z.object({
  id: z.string().min(1).max(200).optional(),
  source: z.enum([
    "session",
    "workspace_db",
    "workspace_manifest",
    "profile",
    "legacy_guardrails",
    "legacy_builtin_settings",
  ]),
  effect: z.enum(["allow", "deny", "ask"]),
  scope: PermissionRuleScopeSchema,
  createdAt: z.number().int().positive().optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

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
    integrationMentions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            label: z.string().min(1).max(120),
            source: z.enum(["builtin", "gateway", "mcp"]),
            providerKey: z.string().min(1).max(120),
            iconKey: z.string().min(1).max(80),
            tools: z.array(z.string().min(1).max(200)).max(50),
            promptHint: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .max(12)
      .optional(),
    originChannel: OriginChannelSchema.optional(),
    maxTurns: z.number().int().min(1).max(250).optional(),
    lifetimeMaxTurns: z.number().int().min(1).max(5000).optional(),
    maxTokens: z.number().int().min(1).max(1_000_000).optional(),
    retainMemory: z.boolean().optional(),
    bypassQueue: z.boolean().optional(),
    allowUserInput: z.boolean().optional(),
    chronicleMode: z.enum(["inherit", "enabled", "disabled"]).optional(),
    shellAccess: z.boolean().optional(),
    requireWorktree: z.boolean().optional(),
    autoApproveTypes: z.array(z.string().min(1).max(200)).max(50).optional(),
    allowSharedContextMemory: z.boolean().optional(),
    conversationMode: z.enum(["task", "chat", "hybrid"]).optional(),
    executionMode: z
      .enum(["execute", "chat", "plan", "analyze", "verified", "debug"])
      .optional(),
    taskDomain: z
      .enum([
        "auto",
        "code",
        "research",
        "operations",
        "writing",
        "general",
        "media",
      ])
      .optional(),
    autonomousMode: z.boolean().optional(),
    permissionMode: PermissionModeSchema.optional(),
    qualityPasses: z
      .union([z.literal(1), z.literal(2), z.literal(3)])
      .optional(),
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
              seatLabel: z.string().max(200).optional(),
              roleInstruction: z.string().max(5000).optional(),
              isIdeaProposer: z.boolean().optional(),
            }),
          )
          .min(2)
          .max(10),
        judgeProviderType: z.enum(LLM_PROVIDER_TYPES),
        judgeModelKey: z.string().max(200),
        maxParallelParticipants: z.number().int().min(1).max(10).optional(),
      })
      .optional(),
    researchWorkflow: z
      .object({
        enabled: z.boolean(),
        researcher: z
          .object({
            providerType: z.enum(LLM_PROVIDER_TYPES).optional(),
            modelKey: z.string().max(200).optional(),
          })
          .strict()
          .optional(),
        critic: z
          .object({
            providerType: z.enum(LLM_PROVIDER_TYPES).optional(),
            modelKey: z.string().max(200).optional(),
          })
          .strict()
          .optional(),
        refiner: z
          .object({
            providerType: z.enum(LLM_PROVIDER_TYPES).optional(),
            modelKey: z.string().max(200).optional(),
          })
          .strict()
          .optional(),
        judge: z
          .object({
            providerType: z.enum(LLM_PROVIDER_TYPES).optional(),
            modelKey: z.string().max(200).optional(),
          })
          .strict()
          .optional(),
        emitSemanticProgress: z.boolean().optional(),
      })
      .strict()
      .optional(),
    councilMode: z.boolean().optional(),
    councilRunId: z.string().uuid().optional(),
    verificationAgent: z.boolean().optional(),
    reviewPolicy: z.enum(["off", "balanced", "strict"]).optional(),
    entropySweepPolicy: z.enum(["off", "balanced", "strict"]).optional(),
    stepIntentAlignmentPolicy: z.enum(["off", "balanced", "strict"]).optional(),
    stepDecompositionPolicy: z.enum(["off", "balanced", "strict"]).optional(),
    autoContinueOnTurnLimit: z.boolean().optional(),
    maxAutoContinuations: z.number().int().min(0).max(20).optional(),
    minProgressScoreForAutoContinue: z.number().min(-1).max(1).optional(),
    continuationStrategy: z
      .enum(["adaptive_progress", "fixed_caps"])
      .optional(),
    compactOnContinuation: z.boolean().optional(),
    compactionThresholdRatio: z.number().min(0.5).max(0.95).optional(),
    loopWarningThreshold: z.number().int().min(1).max(200).optional(),
    loopCriticalThreshold: z.number().int().min(1).max(400).optional(),
    globalNoProgressCircuitBreaker: z
      .number()
      .int()
      .min(1)
      .max(1000)
      .optional(),
    sideChannelDuringExecution: z
      .enum(["paused", "limited", "enabled"])
      .optional(),
    sideChannelMaxCallsPerWindow: z.number().int().min(0).max(100).optional(),
    externalRuntime: z
      .object({
        kind: z.literal("acpx"),
        agent: z.enum(["codex", "claude"]),
        sessionMode: z.literal("persistent"),
        outputMode: z.literal("json"),
        permissionMode: z.enum(["approve-reads", "approve-all", "deny-all"]),
        ttlSeconds: z.number().int().min(0).max(86_400).optional(),
      })
      .strict()
      .optional(),
    videoGenerationMode: z.boolean().optional(),
  })
  .strict();

const isValidWorkspaceId = (workspaceId: string): boolean =>
  isTempWorkspaceId(workspaceId) ||
  z.string().uuid().safeParse(workspaceId).success;

export const WorkspaceIdSchema = z
  .string()
  .refine(isValidWorkspaceId, {
    message: "Must be a valid UUID or temp workspace ID",
  });

export const ImageAttachmentSchema = z
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
    const hasData =
      typeof data.data === "string" && data.data.trim().length > 0;
    const hasFilePath =
      typeof data.filePath === "string" && data.filePath.trim().length > 0;
    if (hasData === hasFilePath) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["data"],
        message:
          'Image attachment must provide exactly one of "data" or "filePath".',
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
      const supportedExtensions = new Set([
        ".jpg",
        ".jpeg",
        ".png",
        ".gif",
        ".webp",
      ]);
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
    images: z
      .array(ImageAttachmentSchema)
      .max(MAX_IMAGES_PER_MESSAGE)
      .optional(),
    quotedAssistantMessage: z
      .object({
        eventId: z.string().min(1).max(200).optional(),
        taskId: z.string().uuid().optional(),
        message: z.string().min(1).max(MAX_PROMPT_LENGTH),
        truncated: z.boolean().optional(),
      })
      .optional(),
    permissionMode: PermissionModeSchema.optional(),
    shellAccess: z.boolean().optional(),
    integrationMentions: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            label: z.string().min(1).max(120),
            source: z.enum(["builtin", "gateway", "mcp"]),
            providerKey: z.string().min(1).max(120),
            iconKey: z.string().min(1).max(80),
            tools: z.array(z.string().min(1).max(200)).max(50),
            promptHint: z.string().min(1).max(1000),
          })
          .strict(),
      )
      .max(12)
      .optional(),
  })
  .superRefine((data, ctx) => {
    if (!data.images || data.images.length === 0) {
      return;
    }

    const totalImageBytes = data.images.reduce((sum, image) => {
      const sizeBytes = Number(image.sizeBytes);
      return Number.isFinite(sizeBytes) && sizeBytes > 0
        ? sum + sizeBytes
        : sum;
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

export const DocumentEditorOpenSessionSchema = z.object({
  filePath: z
    .string()
    .min(1)
    .max(MAX_PATH_LENGTH * 4),
  workspacePath: z
    .string()
    .max(MAX_PATH_LENGTH * 4)
    .optional(),
});

export const DocumentEditorListVersionsSchema = DocumentEditorOpenSessionSchema;

export const DocumentEditRequestSchema = z.object({
  sessionId: z.string().uuid(),
  instruction: z.string().min(1).max(MAX_PROMPT_LENGTH),
  selection: z.discriminatedUnion("kind", [
    z.object({
      kind: z.literal("pdf"),
      pageIndex: z.number().int().min(0),
      x: z.number().min(0).max(1),
      y: z.number().min(0).max(1),
      w: z.number().positive().max(1),
      h: z.number().positive().max(1),
      excerpt: z.string().max(10_000).optional(),
    }),
    z.object({
      kind: z.literal("docx"),
      startBlockId: z.string().max(100).optional(),
      endBlockId: z.string().max(100).optional(),
      blockIds: z.array(z.string().max(100)).min(1).max(200),
      excerpt: z.string().max(10_000).optional(),
    }),
  ]),
});

// ============ Approval Schemas ============

export const ApprovalResponseSchema = z
  .object({
    approvalId: z.string().uuid(),
    approved: z.boolean().optional(),
    action: z
      .enum([
        "allow_once",
        "deny_once",
        "allow_session",
        "deny_session",
        "allow_workspace",
        "deny_workspace",
        "allow_profile",
        "deny_profile",
      ])
      .optional(),
  })
  .refine(
    (data) =>
      typeof data.approved === "boolean" || typeof data.action === "string",
    {
      message: "Either approved or action must be provided",
    },
  );

export const PermissionSettingsSchema = z.object({
  version: z.literal(1),
  defaultMode: PermissionModeSchema,
  defaultShellEnabled: z.boolean().default(false),
  defaultPermissionAccess: z.enum(["default", "full"]).default("default"),
  rules: z.array(PermissionRuleSchema).default([]),
});

const InputRequestAnswerSchema = z.object({
  optionLabel: z.string().min(1).max(200).optional(),
  otherText: z.string().min(1).max(MAX_PROMPT_LENGTH).optional(),
});

export const InputRequestResponseSchema = z.object({
  requestId: z.string().uuid(),
  status: z.enum(["submitted", "dismissed"]),
  answers: z
    .record(z.string().regex(/^[a-z][a-z0-9_]*$/), InputRequestAnswerSchema)
    .optional(),
});

// ============ LLM Settings Schemas ============

export const LLMProviderTypeSchema = z.enum(LLM_PROVIDER_TYPES);

const ProviderFailoverSettingsSchema = {
  fallbackProviders: z
    .array(
      z.object({
        providerType: LLMProviderTypeSchema,
        modelKey: z.string().max(200).optional(),
      }),
    )
    .max(5)
    .optional(),
  failoverPrimaryRetryCooldownSeconds: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .optional(),
} as const;

const ProviderRoutingSettingsSchema = {
  ...ProviderFailoverSettingsSchema,
  profileRoutingEnabled: z.boolean().optional(),
  strongModelKey: z.string().max(200).optional(),
  cheapModelKey: z.string().max(200).optional(),
  automatedTaskModelKey: z.string().max(200).optional(),
  preferStrongForVerification: z.boolean().optional(),
} as const;

export const AnthropicSettingsSchema = z
  .object({
    apiKey: z.string().max(500).optional(),
    subscriptionToken: z.string().max(2000).optional(),
    authMethod: z.enum(["api_key", "subscription"]).optional(),
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
    reasoningEffort: z.enum(["low", "medium", "high", "xhigh"]).optional(),
    textVerbosity: z.enum(["low", "medium", "high"]).optional(),
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
    reasoningEffort: z.enum(["low", "medium", "high", "extra_high"]).optional(),
    ...ProviderRoutingSettingsSchema,
  })
  .optional();

export const AzureAnthropicSettingsSchema = z
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
  cachedModels: z
    .array(
      z.object({
        key: z.string().max(500),
        displayName: z.string().max(500),
        description: z.string().max(1000),
        contextLength: z.number().optional(),
        size: z.number().optional(),
      }),
    )
    .optional(),
  ...ProviderRoutingSettingsSchema,
});

export const CustomProvidersSchema = z
  .record(z.string(), CustomProviderConfigSchema)
  .optional();

// ============ Video Generation Settings Schema ============

export const VideoGenerationSettingsSchema = z
  .object({
    defaultProvider: z
      .enum(["openai", "azure", "gemini", "vertex", "kling"])
      .optional(),
    fallbackProvider: z
      .enum(["openai", "azure", "gemini", "vertex", "kling"])
      .optional(),
    openai: z
      .object({
        defaultModel: z.string().max(200).optional(),
        defaultDuration: z.number().int().min(1).max(60).optional(),
        defaultAspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional(),
        defaultResolution: z.enum(["480p", "720p", "1080p"]).optional(),
      })
      .optional(),
    azure: z
      .object({
        videoApiKey: z.string().max(500).optional(),
        videoEndpoint: z.string().max(500).optional(),
        videoDeployment: z.string().max(200).optional(),
        videoApiVersion: z.string().max(50).optional(),
        defaultDuration: z.number().int().min(1).max(60).optional(),
        defaultAspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional(),
        defaultResolution: z.enum(["480p", "720p", "1080p"]).optional(),
      })
      .optional(),
    gemini: z
      .object({
        defaultModel: z
          .enum(["veo-3.1", "veo-3.1-fast-preview", "veo-3.0"])
          .optional(),
        defaultDuration: z.number().int().min(1).max(60).optional(),
        defaultAspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional(),
      })
      .optional(),
    vertex: z
      .object({
        model: z.enum(["veo-3", "veo-3.1"]).optional(),
        projectId: z.string().max(200).optional(),
        location: z.string().max(100).optional(),
        outputGcsUri: z.string().max(1000).optional(),
        accessToken: z.string().max(4000).optional(),
        defaultDuration: z.number().int().min(1).max(60).optional(),
        defaultAspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional(),
      })
      .optional(),
    kling: z
      .object({
        apiKey: z.string().max(500).optional(),
        baseUrl: z.string().max(500).optional(),
        model: z.string().max(200).optional(),
        defaultDuration: z.number().int().min(1).max(60).optional(),
        defaultAspectRatio: z.enum(["16:9", "9:16", "1:1"]).optional(),
      })
      .optional(),
  })
  .optional();

export const PromptCachingSettingsSchema = z
  .object({
    mode: z.enum(["auto", "off"]).optional(),
    ttl: z.enum(["5m", "1h"]).optional(),
    openRouterClaudeStrategy: z.enum(["explicit_system_and_3"]).optional(),
    strictStablePrefix: z.boolean().optional(),
    surfaceCoverage: z
      .object({
        executor: z.boolean().optional(),
        followUps: z.boolean().optional(),
        chatMode: z.boolean().optional(),
        sideCalls: z.boolean().optional(),
      })
      .optional(),
  })
  .optional();

export const LLMSettingsSchema = z.object({
  providerType: LLMProviderTypeSchema,
  modelKey: z.string().max(200),
  fallbackProviders: z
    .array(
      z.object({
        providerType: LLMProviderTypeSchema,
        modelKey: z.string().max(200).optional(),
      }),
    )
    .max(5)
    .optional(),
  failoverPrimaryRetryCooldownSeconds: z
    .number()
    .int()
    .min(0)
    .max(3600)
    .optional(),
  promptCaching: PromptCachingSettingsSchema,
  anthropic: AnthropicSettingsSchema,
  bedrock: BedrockSettingsSchema,
  ollama: OllamaSettingsSchema,
  gemini: GeminiSettingsSchema,
  openrouter: OpenRouterSettingsSchema,
  openai: OpenAISettingsSchema,
  azure: AzureSettingsSchema,
  azureAnthropic: AzureAnthropicSettingsSchema,
  groq: GroqSettingsSchema,
  xai: XAISettingsSchema,
  kimi: KimiSettingsSchema,
  openaiCompatible: OpenAICompatibleSettingsSchema,
  customProviders: CustomProvidersSchema,
  imageGeneration: z
    .object({
      defaultProvider: z
        .enum(["openai", "openai-codex", "azure", "openrouter", "gemini"])
        .optional(),
      defaultModel: z.enum(["gpt-image-2", "gpt-image-1.5", "nano-banana-2"]).optional(),
      backupProvider: z
        .enum(["openai", "openai-codex", "azure", "openrouter", "gemini"])
        .optional(),
      backupModel: z.enum(["gpt-image-2", "gpt-image-1.5", "nano-banana-2"]).optional(),
      timeouts: z
        .object({
          openai: z.number().min(30).max(1800).optional(),
          openaiCodex: z.number().min(30).max(1800).optional(),
          azure: z.number().min(30).max(1800).optional(),
          openrouter: z.number().min(30).max(1800).optional(),
          gemini: z.number().min(30).max(1800).optional(),
        })
        .optional(),
      openai: z
        .object({
          apiKey: z.string().max(500).optional(),
          model: z.string().max(200).optional(),
        })
        .optional(),
      azure: z
        .object({
          imageApiKey: z.string().max(500).optional(),
          imageEndpoint: z.string().max(500).optional(),
          imageDeployment: z.string().max(200).optional(),
          imageApiVersion: z.string().max(100).optional(),
        })
        .optional(),
      gemini: z
        .object({
          apiKey: z.string().max(500).optional(),
          model: z.enum(["nano-banana-2"]).optional(),
        })
        .optional(),
      openrouter: z
        .object({
          apiKey: z.string().max(500).optional(),
          baseUrl: z.string().max(500).optional(),
          model: z.string().max(200).optional(),
        })
        .optional(),
      openaiCodex: z
        .object({
          model: z.string().max(200).optional(),
        })
        .optional(),
    })
    .optional(),
  videoGeneration: VideoGenerationSettingsSchema,
});

// ============ Search Settings Schemas ============

export const SearchProviderTypeSchema = z
  .enum(["tavily", "exa", "brave", "serpapi", "google", "duckduckgo"])
  .nullable();

export const SearchSettingsSchema = z.object({
  primaryProvider: SearchProviderTypeSchema,
  fallbackProvider: SearchProviderTypeSchema,
  tavily: z
    .object({
      apiKey: z.string().max(500).optional(),
    })
    .optional(),
  exa: z
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

export const XSettingsSchema = z
  .object({
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
        allowedAuthors: z
          .array(z.string().trim().min(1).max(50))
          .max(200)
          .default([]),
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
  })
  .superRefine((data, ctx) => {
    if (
      data.mentionTrigger.enabled &&
      data.mentionTrigger.allowedAuthors.length === 0
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["mentionTrigger", "allowedAuthors"],
        message:
          "At least one allowed author is required when mention trigger is enabled",
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
  loginHint: z.string().email().max(254).optional(),
});

export const AgentMailSettingsSchema = z.object({
  enabled: z.boolean().default(false),
  apiKey: z.string().max(4000).optional(),
  baseUrl: z.string().url().max(500).optional(),
  websocketUrl: z.string().url().max(500).optional(),
  timeoutMs: z.number().int().min(1000).max(120000).optional(),
  realtimeEnabled: z.boolean().optional(),
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

  // Web search policy
  webSearchMode: z.enum(["disabled", "cached", "live"]).default("cached"),
  webSearchMaxUsesPerTask: z.number().int().min(1).max(500).default(8),
  webSearchMaxUsesPerStep: z.number().int().min(1).max(100).default(3),
  webSearchAllowedDomains: z.array(z.string().max(255)).max(100).default([]),
  webSearchBlockedDomains: z.array(z.string().max(255)).max(100).default([]),

  // Iterations
  maxIterationsPerTask: z.number().int().min(5).max(500).default(50),
  iterationLimitEnabled: z.boolean().default(true),

  // Execution continuation
  autoContinuationEnabled: z.boolean().default(true),
  defaultMaxAutoContinuations: z.number().int().min(0).max(20).default(3),
  defaultMinProgressScore: z.number().min(-1).max(1).default(0.25),
  lifetimeTurnCapEnabled: z.boolean().default(true),
  defaultLifetimeTurnCap: z.number().int().min(20).max(5000).default(320),
  compactOnContinuation: z.boolean().default(true),
  compactionThresholdRatio: z.number().min(0.5).max(0.95).default(0.75),
  loopWarningThreshold: z.number().int().min(1).max(200).default(8),
  loopCriticalThreshold: z.number().int().min(1).max(400).default(14),
  globalNoProgressCircuitBreaker: z.number().int().min(1).max(1000).default(20),
  sideChannelDuringExecution: z
    .enum(["paused", "limited", "enabled"])
    .default("paused"),
  sideChannelMaxCallsPerWindow: z.number().int().min(0).max(100).default(2),

  // Adaptive Style Engine
  adaptiveStyleEnabled: z.boolean().default(false),
  adaptiveStyleMaxDriftPerWeek: z.number().int().min(0).max(10).default(1),

  // Cross-Channel Persona Coherence
  channelPersonaEnabled: z.boolean().default(false),
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

const DISCORD_SUPERVISOR_CONFIG_SHAPE = {
  enabled: z.boolean(),
  coordinationChannelId: z.string().trim().min(1).max(100).optional(),
  watchedChannelIds: z
    .array(z.string().trim().min(1).max(100))
    .max(100)
    .optional(),
  workerAgentRoleId: z.string().uuid().optional(),
  supervisorAgentRoleId: z.string().uuid().optional(),
  humanEscalationChannelId: z.string().trim().min(1).max(100).optional(),
  humanEscalationUserId: z.string().trim().min(1).max(100).optional(),
  peerBotUserIds: z.array(z.string().trim().min(1).max(100)).max(20).optional(),
  strictMode: z.boolean().optional(),
} satisfies z.ZodRawShape;

type DiscordSupervisorConfigRefinementValue = {
  enabled?: boolean;
  coordinationChannelId?: string;
  workerAgentRoleId?: string;
  supervisorAgentRoleId?: string;
  peerBotUserIds?: string[];
};

function addDiscordSupervisorConfigRefinement(
  schema: z.ZodObject<z.ZodRawShape>,
): z.ZodObject<z.ZodRawShape> {
  return schema.superRefine((value, ctx) => {
    const config = value as DiscordSupervisorConfigRefinementValue;
    if (!config.enabled) return;

    if (!config.coordinationChannelId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["coordinationChannelId"],
        message:
          "Coordination channel ID is required when supervisor mode is enabled",
      });
    }
    if (!config.workerAgentRoleId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["workerAgentRoleId"],
        message:
          "Worker agent role is required when supervisor mode is enabled",
      });
    }
    if (!config.supervisorAgentRoleId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["supervisorAgentRoleId"],
        message:
          "Supervisor agent role is required when supervisor mode is enabled",
      });
    }
    if (!config.peerBotUserIds || config.peerBotUserIds.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["peerBotUserIds"],
        message:
          "At least one peer bot user ID is required when supervisor mode is enabled",
      });
    }
  });
}

const AddDiscordSupervisorConfigSchema = addDiscordSupervisorConfigRefinement(
  z.object({
    ...DISCORD_SUPERVISOR_CONFIG_SHAPE,
    enabled: z.boolean().optional(),
  }),
);

const DiscordSupervisorConfigSchema = addDiscordSupervisorConfigRefinement(
  z.object(DISCORD_SUPERVISOR_CONFIG_SHAPE),
);

export const AddTelegramChannelSchema = z.object({
  type: z.literal("telegram"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  botToken: z.string().min(1).max(500),
  groupRoutingMode: z
    .enum(["all", "mentionsOnly", "mentionsOrCommands", "commandsOnly"])
    .optional(),
  telegramAllowedGroupChatIds: z.array(z.string().max(100)).max(200).optional(),
  securityMode: SecurityModeSchema.optional(),
});

export const AddDiscordChannelSchema = z.object({
  type: z.literal("discord"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  botToken: z.string().min(1).max(500),
  applicationId: z.string().min(1).max(100),
  guildIds: z.array(z.string().max(100)).max(100).optional(),
  discordSupervisor: AddDiscordSupervisorConfigSchema.optional(),
  securityMode: SecurityModeSchema.optional(),
});

export const AddSlackChannelSchema = z.object({
  type: z.literal("slack"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  botToken: z.string().min(1).max(500),
  appToken: z.string().min(1).max(500),
  signingSecret: z.string().max(500).optional(),
  progressRelayMode: z.enum(["minimal", "curated"]).optional(),
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

export const DmPolicySchema = z.enum([
  "open",
  "allowlist",
  "pairing",
  "disabled",
]);
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
  allowedNumbers: z.array(z.string().max(20)).max(100).optional(),
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
  xAllowedAuthors: z
    .array(z.string().trim().min(1).max(50))
    .max(200)
    .optional(),
  xPollIntervalSec: z.number().int().min(30).max(3600).optional(),
  xFetchCount: z.number().int().min(1).max(200).optional(),
  xOutboundEnabled: z.boolean().optional(),
});

export const AddFeishuChannelSchema = z.object({
  type: z.literal("feishu"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  feishuAppId: z.string().min(1).max(200),
  feishuAppSecret: z.string().min(1).max(500),
  feishuVerificationToken: z.string().max(500).optional(),
  feishuEncryptKey: z.string().max(500).optional(),
  webhookPort: z.number().int().min(1024).max(65535).optional(),
  webhookPath: z.string().min(1).max(200).optional(),
  securityMode: SecurityModeSchema.optional(),
});

export const AddWeComChannelSchema = z.object({
  type: z.literal("wecom"),
  name: z.string().min(1).max(MAX_TITLE_LENGTH),
  wecomCorpId: z.string().min(1).max(200),
  wecomAgentId: z.number().int().min(1).max(1_000_000_000),
  wecomSecret: z.string().min(1).max(500),
  wecomToken: z.string().min(1).max(500),
  wecomEncodingAESKey: z.string().length(43).optional(),
  webhookPort: z.number().int().min(1024).max(65535).optional(),
  webhookPath: z.string().min(1).max(200).optional(),
  securityMode: SecurityModeSchema.optional(),
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
    authMethod: "emailAuthMethod",
    oauthProvider: "emailOauthProvider",
    oauthClientId: "emailOauthClientId",
    accessToken: "emailAccessToken",
    refreshToken: "emailRefreshToken",
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
    authMethod: "authMethod",
    oauthProvider: "oauthProvider",
    oauthClientId: "oauthClientId",
    accessToken: "accessToken",
    refreshToken: "refreshToken",
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
    [EMAIL_FIELD_KEY_MAP.add.protocol]: z
      .enum(["imap-smtp", "loom"])
      .optional(),
    [EMAIL_FIELD_KEY_MAP.add.authMethod]: z
      .enum(["password", "oauth"])
      .optional(),
    [EMAIL_FIELD_KEY_MAP.add.oauthProvider]: z.enum(["microsoft"]).optional(),
    [EMAIL_FIELD_KEY_MAP.add.oauthClientId]: z
      .string()
      .min(1)
      .max(500)
      .optional(),
    [EMAIL_FIELD_KEY_MAP.add.accessToken]: z
      .string()
      .min(1)
      .max(4000)
      .optional(),
    [EMAIL_FIELD_KEY_MAP.add.refreshToken]: z
      .string()
      .min(1)
      .max(4000)
      .optional(),
    [EMAIL_FIELD_KEY_MAP.add.email]: z
      .string()
      .email()
      .min(1)
      .max(200)
      .optional(),
    [EMAIL_FIELD_KEY_MAP.add.password]: z.string().min(1).max(500).optional(),
    [EMAIL_FIELD_KEY_MAP.add.imapHost]: z.string().min(1).max(200).optional(),
    [EMAIL_FIELD_KEY_MAP.add.imapPort]: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional(),
    [EMAIL_FIELD_KEY_MAP.add.smtpHost]: z.string().min(1).max(200).optional(),
    [EMAIL_FIELD_KEY_MAP.add.smtpPort]: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional(),
    [EMAIL_FIELD_KEY_MAP.add.loomBaseUrl]: z.string().url().max(500).optional(),
    [EMAIL_FIELD_KEY_MAP.add.loomAccessToken]: z
      .string()
      .min(1)
      .max(4000)
      .optional(),
  },
  update: {
    [EMAIL_FIELD_KEY_MAP.update.protocol]: z
      .enum(["imap-smtp", "loom"])
      .optional(),
    [EMAIL_FIELD_KEY_MAP.update.authMethod]: z
      .enum(["password", "oauth"])
      .optional(),
    [EMAIL_FIELD_KEY_MAP.update.oauthProvider]: z
      .enum(["microsoft"])
      .optional(),
    [EMAIL_FIELD_KEY_MAP.update.oauthClientId]: z
      .string()
      .min(1)
      .max(500)
      .optional(),
    [EMAIL_FIELD_KEY_MAP.update.accessToken]: z
      .string()
      .min(1)
      .max(4000)
      .optional(),
    [EMAIL_FIELD_KEY_MAP.update.refreshToken]: z
      .string()
      .min(1)
      .max(4000)
      .optional(),
    [EMAIL_FIELD_KEY_MAP.update.email]: z
      .string()
      .email()
      .min(1)
      .max(200)
      .optional(),
    [EMAIL_FIELD_KEY_MAP.update.password]: z
      .string()
      .min(1)
      .max(500)
      .optional(),
    [EMAIL_FIELD_KEY_MAP.update.imapHost]: z
      .string()
      .min(1)
      .max(200)
      .optional(),
    [EMAIL_FIELD_KEY_MAP.update.imapPort]: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional(),
    [EMAIL_FIELD_KEY_MAP.update.smtpHost]: z
      .string()
      .min(1)
      .max(200)
      .optional(),
    [EMAIL_FIELD_KEY_MAP.update.smtpPort]: z
      .number()
      .int()
      .min(1)
      .max(65535)
      .optional(),
    [EMAIL_FIELD_KEY_MAP.update.loomBaseUrl]: z
      .string()
      .url()
      .max(500)
      .optional(),
    [EMAIL_FIELD_KEY_MAP.update.loomAccessToken]: z
      .string()
      .min(1)
      .max(4000)
      .optional(),
  },
};

const createEmailTransportSchema = (
  mode: EmailSchemaMode,
): z.ZodObject<z.ZodRawShape> => {
  const fieldMap = EMAIL_FIELD_KEY_MAP[mode];
  return z
    .object(EMAIL_TRANSPORT_BASE_SHAPES[mode])
    .superRefine((data, ctx) => {
      validateEmailChannelConfigByProtocol(
        data as Record<string, unknown>,
        ctx,
        fieldMap,
      );
    });
};

const createEmailAddExtras = (): z.ZodRawShape => ({
  emailDisplayName: z.string().max(100).optional(),
  emailOauthClientSecret: z.string().max(500).optional(),
  emailOauthTenant: z.string().max(200).optional(),
  emailTokenExpiresAt: z.number().int().optional(),
  emailScopes: z.array(z.string().max(200)).max(50).optional(),
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
  oauthClientSecret: z.string().max(500).optional(),
  oauthTenant: z.string().max(200).optional(),
  tokenExpiresAt: z.number().int().optional(),
  scopes: z.array(z.string().max(200)).max(50).optional(),
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
    authMethod: string;
    oauthProvider: string;
    oauthClientId: string;
    accessToken: string;
    refreshToken: string;
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
        message:
          "LOOM base URL must use HTTPS unless it points to localhost/127.0.0.1/::1",
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

  const authMethod = getOptionalString(data[fieldMap.authMethod]) || "password";
  if (authMethod === "oauth") {
    if (!getOptionalString(data[fieldMap.oauthProvider])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [fieldMap.oauthProvider],
        message: "OAuth provider is required for IMAP/SMTP OAuth mode",
      });
    }
    if (!getOptionalString(data[fieldMap.oauthClientId])) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [fieldMap.oauthClientId],
        message: "OAuth client ID is required for IMAP/SMTP OAuth mode",
      });
    }
    if (
      !getOptionalString(data[fieldMap.accessToken]) &&
      !getOptionalString(data[fieldMap.refreshToken])
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: [fieldMap.accessToken],
        message: "OAuth tokens are required for IMAP/SMTP OAuth mode",
      });
    }
  } else if (!getOptionalString(data[fieldMap.password])) {
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
  AddFeishuChannelSchema,
  AddWeComChannelSchema,
  AddXChannelSchema,
  AddEmailChannelSchema,
]);

export const ChannelConfigSchema = z
  .object({
    selfChatMode: z.boolean().optional(),
    supervisor: DiscordSupervisorConfigSchema.optional(),
    progressRelayMode: z.enum(["minimal", "curated"]).optional(),
    responsePrefix: z.string().max(20).optional(),
    trustedGroupMemoryOptIn: z.boolean().optional(),
    researchChatIds: z.array(z.string().max(200)).max(50).optional(),
    researchAgentRoleId: z.string().uuid().optional(),
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

// ============ ID Schemas (for simple string ID params) ============

export const UUIDSchema = z.string().uuid();
export const StringIdSchema = z.string().min(1).max(100);
export const TargetKeySchema = z.string().trim().min(1).max(1024);
export const ProviderApiKeySchema = z.string().max(4000).optional();
export const ProviderBaseUrlSchema = z.string().url().max(500).optional();
const HEARTBEAT_PROFILE_VALUES = ["observer", "operator", "dispatcher"] as const;
const CHANNEL_TYPE_VALUES = [
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
  "feishu",
  "wecom",
  "x",
] as const;
export const HeartbeatProfileSchema = z.enum(HEARTBEAT_PROFILE_VALUES);
export const ChannelTypeSchema = z.enum(CHANNEL_TYPE_VALUES);
export const HeartbeatActiveHoursSchema = z
  .object({
    timezone: z.string().trim().min(1).max(100).optional(),
    startHour: z.number().int().min(0).max(23),
    endHour: z.number().int().min(0).max(23),
    weekdays: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.weekdays) {
      const unique = new Set(value.weekdays);
      if (unique.size !== value.weekdays.length) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["weekdays"],
          message: "weekdays must not contain duplicates",
        });
      }
    }
  });
export const HeartbeatConfigSchema = z
  .object({
    heartbeatEnabled: z.boolean().optional(),
    heartbeatIntervalMinutes: z.number().int().min(15).max(7 * 24 * 60).optional(),
    heartbeatStaggerOffset: z.number().int().min(0).max(7 * 24 * 60).optional(),
    pulseEveryMinutes: z.number().int().min(15).max(7 * 24 * 60).optional(),
    dispatchCooldownMinutes: z.number().int().min(15).max(7 * 24 * 60).optional(),
    maxDispatchesPerDay: z.number().int().min(1).max(96).optional(),
    heartbeatProfile: HeartbeatProfileSchema.optional(),
    activeHours: HeartbeatActiveHoursSchema.nullable().optional(),
  })
  .strict();
export const AutomationProfileCreateRequestSchema = z
  .object({
    agentRoleId: UUIDSchema,
    enabled: z.boolean().optional(),
    cadenceMinutes: z.number().int().min(15).max(7 * 24 * 60).optional(),
    staggerOffsetMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
    dispatchCooldownMinutes: z.number().int().min(15).max(7 * 24 * 60).optional(),
    maxDispatchesPerDay: z.number().int().min(1).max(96).optional(),
    profile: HeartbeatProfileSchema.optional(),
    activeHours: HeartbeatActiveHoursSchema.nullable().optional(),
  })
  .strict();
export const AutomationProfileUpdateRequestSchema = z
  .object({
    id: UUIDSchema,
    enabled: z.boolean().optional(),
    cadenceMinutes: z.number().int().min(15).max(7 * 24 * 60).optional(),
    staggerOffsetMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
    dispatchCooldownMinutes: z.number().int().min(15).max(7 * 24 * 60).optional(),
    maxDispatchesPerDay: z.number().int().min(1).max(96).optional(),
    profile: HeartbeatProfileSchema.optional(),
    activeHours: HeartbeatActiveHoursSchema.nullable().optional(),
  })
  .strict();
export const AutomationProfileAttachRequestSchema = z
  .object({
    enabled: z.boolean().optional(),
    cadenceMinutes: z.number().int().min(15).max(7 * 24 * 60).optional(),
    staggerOffsetMinutes: z.number().int().min(0).max(7 * 24 * 60).optional(),
    dispatchCooldownMinutes: z.number().int().min(15).max(7 * 24 * 60).optional(),
    maxDispatchesPerDay: z.number().int().min(1).max(96).optional(),
    profile: HeartbeatProfileSchema.optional(),
    activeHours: HeartbeatActiveHoursSchema.nullable().optional(),
  })
  .strict();
export const StandupDeliveryRequestSchema = z
  .object({
    reportId: UUIDSchema,
    channelType: ChannelTypeSchema,
    channelId: z.string().trim().min(1).max(200),
  })
  .strict();
export const CoreTraceKindSchema = z.enum([
  "pulse_cycle",
  "subconscious_cycle",
  "memory_update",
  "dream_distill",
] as const satisfies readonly CoreTraceKind[]);
export const CoreTraceStatusSchema = z.enum([
  "running",
  "completed",
  "failed",
  "skipped",
] as const satisfies readonly CoreTraceStatus[]);
export const CoreMemoryScopeKindSchema = z.enum([
  "global",
  "workspace",
  "automation_profile",
  "code_workspace",
  "pull_request",
] as const satisfies readonly CoreMemoryScopeKind[]);
export const CoreMemoryCandidateStatusSchema = z.enum([
  "proposed",
  "accepted",
  "rejected",
  "merged",
] as const satisfies readonly CoreMemoryCandidateStatus[]);
export const CoreFailureCategorySchema = z.enum([
  "wake_timing",
  "dispatch_overreach",
  "dispatch_underreach",
  "memory_noise",
  "memory_staleness",
  "subconscious_duplication",
  "subconscious_low_signal",
  "routing_mismatch",
  "workspace_context_gap",
  "cooldown_policy_mismatch",
  "budget_policy_mismatch",
  "unknown",
] as const satisfies readonly CoreFailureCategory[]);
export const CoreFailureRecordStatusSchema = z.enum([
  "open",
  "clustered",
  "resolved",
  "archived",
] as const satisfies readonly CoreFailureRecordStatus[]);
export const CoreFailureClusterStatusSchema = z.enum([
  "open",
  "stable",
  "evaluating",
  "resolved",
  "dismissed",
] as const satisfies readonly CoreFailureClusterStatus[]);
export const CoreEvalCaseStatusSchema = z.enum([
  "draft",
  "active",
  "failing",
  "archived",
] as const satisfies readonly CoreEvalCaseStatus[]);
export const CoreExperimentStatusSchema = z.enum([
  "proposed",
  "running",
  "passed_gate",
  "failed_gate",
  "promoted",
  "rejected",
] as const satisfies readonly CoreExperimentStatus[]);
export const CoreTraceListRequestSchema = z
  .object({
    profileId: UUIDSchema.optional(),
    workspaceId: UUIDSchema.optional(),
    targetKey: TargetKeySchema.optional(),
    traceKind: CoreTraceKindSchema.optional(),
    status: CoreTraceStatusSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
const TaskStatusSchema = z.enum([
  "pending",
  "queued",
  "planning",
  "executing",
  "paused",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
] as const satisfies readonly TaskStatus[]);
export const TaskTraceListRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema.optional(),
    status: z.union([TaskStatusSchema, z.literal("all")]).optional(),
    query: z.string().max(1000).optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();
export const TaskTraceGetRequestSchema = UUIDSchema;
export const CoreMemoryCandidateListRequestSchema = z
  .object({
    profileId: UUIDSchema.optional(),
    workspaceId: UUIDSchema.optional(),
    traceId: StringIdSchema.optional(),
    scopeKind: CoreMemoryScopeKindSchema.optional(),
    status: CoreMemoryCandidateStatusSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export const CoreMemoryCandidateReviewSchema = z
  .object({
    id: StringIdSchema,
    status: z.enum(["accepted", "rejected", "merged"]),
    resolution: z.string().max(4000).optional(),
  })
  .strict();
export const CoreMemoryDistillRunNowSchema = z
  .object({
    profileId: UUIDSchema,
    workspaceId: UUIDSchema.optional(),
  })
  .strict();
export const CoreFailureRecordListRequestSchema = z
  .object({
    profileId: UUIDSchema.optional(),
    workspaceId: UUIDSchema.optional(),
    traceId: StringIdSchema.optional(),
    category: CoreFailureCategorySchema.optional(),
    status: CoreFailureRecordStatusSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export const CoreFailureClusterListRequestSchema = z
  .object({
    profileId: UUIDSchema.optional(),
    workspaceId: UUIDSchema.optional(),
    category: CoreFailureCategorySchema.optional(),
    status: CoreFailureClusterStatusSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export const CoreFailureClusterReviewSchema = z
  .object({
    id: StringIdSchema,
    status: z.enum(["stable", "resolved", "dismissed"]),
    rootCauseSummary: z.string().max(4000).optional(),
  })
  .strict();
export const CoreEvalCaseListRequestSchema = z
  .object({
    profileId: UUIDSchema.optional(),
    workspaceId: UUIDSchema.optional(),
    clusterId: StringIdSchema.optional(),
    status: CoreEvalCaseStatusSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export const CoreEvalCaseReviewSchema = z
  .object({
    id: StringIdSchema,
    status: z.enum(["active", "archived", "failing"]),
  })
  .strict();
export const CoreExperimentListRequestSchema = z
  .object({
    profileId: UUIDSchema.optional(),
    workspaceId: UUIDSchema.optional(),
    clusterId: StringIdSchema.optional(),
    status: CoreExperimentStatusSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export const CoreExperimentRunSchema = z
  .object({
    experimentId: StringIdSchema.optional(),
    clusterId: StringIdSchema.optional(),
    profileId: UUIDSchema.optional(),
    workspaceId: UUIDSchema.optional(),
    autoPromote: z.boolean().optional(),
  })
  .strict()
  .refine((value) => Boolean(value.experimentId || value.clusterId), {
    message: "experimentId or clusterId is required",
  });
export const CoreExperimentReviewSchema = z
  .object({
    id: StringIdSchema,
    action: z.enum(["promote", "reject"]),
  })
  .strict();
export const CoreLearningsListRequestSchema = z
  .object({
    profileId: UUIDSchema.optional(),
    workspaceId: UUIDSchema.optional(),
    relatedClusterId: StringIdSchema.optional(),
    relatedExperimentId: StringIdSchema.optional(),
    limit: z.number().int().min(1).max(500).optional(),
  })
  .strict();
export const SubconsciousSettingsSchema = z
  .object({
    enabled: z.boolean(),
    autoRun: z.boolean(),
    cadenceMinutes: z.number().int().min(15).max(7 * 24 * 60),
    enabledTargetKinds: z
      .array(
        z.string().refine(
          (value) => SUBCONSCIOUS_TARGET_KINDS.includes(value as (typeof SUBCONSCIOUS_TARGET_KINDS)[number]),
          "Invalid subconscious target kind",
        ),
      )
      .min(1)
      .max(SUBCONSCIOUS_TARGET_KINDS.length),
    durableTargetKinds: z
      .array(
        z.string().refine(
          (value) => SUBCONSCIOUS_TARGET_KINDS.includes(value as (typeof SUBCONSCIOUS_TARGET_KINDS)[number]),
          "Invalid subconscious target kind",
        ),
      )
      .max(SUBCONSCIOUS_TARGET_KINDS.length),
    catchUpOnRestart: z.boolean(),
    journalingEnabled: z.boolean(),
    dreamsEnabled: z.boolean(),
    dreamCadenceHours: z.number().int().min(1).max(24 * 30),
    autonomyMode: z.enum(["recommendation_first", "balanced_autopilot", "strong_autonomy"]),
    trustedTargetKeys: z.array(z.string().trim().min(1).max(1024)).max(1000),
    phaseModels: z
      .object({
        collectingEvidence: z.string().max(200).optional(),
        ideation: z.string().max(200).optional(),
        critique: z.string().max(200).optional(),
        synthesis: z.string().max(200).optional(),
      })
      .strict(),
    dispatchDefaults: z
      .object({
        autoDispatch: z.boolean(),
        defaultKinds: z.record(z.string(), z.string().max(200)),
      })
      .strict(),
    artifactRetentionDays: z.number().int().min(1).max(365),
    maxHypothesesPerRun: z.number().int().min(3).max(5),
    notificationPolicy: z
      .object({
        inputNeeded: z.boolean(),
        importantActionTaken: z.boolean(),
        completedWhileAway: z.boolean(),
        throttleMinutes: z.number().int().min(0).max(24 * 60),
        quietHoursStart: z.number().int().min(0).max(23),
        quietHoursEnd: z.number().int().min(0).max(23),
      })
      .strict(),
    perExecutorPolicy: z
      .object({
        task: z.object({ enabled: z.boolean() }).strict(),
        suggestion: z.object({ enabled: z.boolean() }).strict(),
        notify: z.object({ enabled: z.boolean() }).strict(),
        codeChangeTask: z
          .object({
            enabled: z.boolean(),
            requireWorktree: z.boolean(),
            strictReview: z.boolean(),
            verificationRequired: z.boolean(),
          })
          .strict(),
      })
      .strict(),
  })
  .strict();
export const ImprovementLoopSettingsSchema = z
  .object({
    enabled: z.boolean(),
    autoRun: z.boolean(),
    includeDevLogs: z.boolean(),
    intervalMinutes: z.number().int().min(15).max(7 * 24 * 60),
    variantsPerCampaign: z.number().int().min(1).max(10),
    maxConcurrentCampaigns: z.number().int().min(1).max(20),
    maxConcurrentImprovementExecutors: z.number().int().min(1).max(20),
    maxQueuedImprovementCampaigns: z.number().int().min(1).max(100),
    maxOpenCandidatesPerWorkspace: z.number().int().min(1).max(500),
    requireWorktree: z.boolean(),
    requireRepoChecks: z.boolean(),
    enforcePatchScope: z.boolean(),
    maxPatchFiles: z.number().int().min(1).max(500),
    reviewRequired: z.boolean(),
    judgeRequired: z.boolean(),
    promotionMode: z.enum(["merge", "github_pr"]),
    evalWindowDays: z.number().int().min(1).max(365),
    replaySetSize: z.number().int().min(1).max(100),
    campaignTimeoutMinutes: z.number().int().min(1).max(24 * 60),
    campaignTokenBudget: z.number().int().min(1).max(5_000_000),
    campaignCostBudget: z.number().min(0).max(10_000),
    improvementProgramPath: z.string().max(MAX_PATH_LENGTH).optional(),
  })
  .strict();

// ============ ChatGPT Import Schema ============

export const ChatGPTImportSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  filePath: z
    .string()
    .min(1)
    .max(MAX_PATH_LENGTH)
    .refine((p) => path.isAbsolute(p), {
      message: "File path must be absolute",
    })
    .refine((p) => p.endsWith(".json"), {
      message: "File must be a .json file",
    }),
  maxConversations: z.number().int().min(0).max(10000).optional(),
  minMessages: z.number().int().min(1).max(100).optional(),
  forcePrivate: z.boolean().optional(),
  distillProvider: z.string().max(100).optional(),
  distillModel: z.string().max(200).optional(),
});

const MAX_PERSONALITY_IMPORT_BYTES = 512 * 1024; // 500KB
const MAX_PERSONALITY_CONFIG_BYTES = 512 * 1024; // 500KB for save/preview
export const MAX_PERSONALITY_PREVIEW_BYTES = MAX_PERSONALITY_CONFIG_BYTES;

export const PersonalityImportSchema = z
  .string()
  .min(1, "Personality import data cannot be empty")
  .max(
    MAX_PERSONALITY_IMPORT_BYTES,
    `Personality import must be under ${MAX_PERSONALITY_IMPORT_BYTES / 1024}KB`,
  )
  .refine(
    (data) => {
      const trimmed = data.trim();
      if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
        try {
          const parsed = JSON.parse(trimmed) as unknown;
          return parsed !== null && typeof parsed === "object";
        } catch {
          return false;
        }
      }
      return true; // SOUL.md or other format
    },
    { message: "Invalid JSON structure for personality import" },
  );

export const TextMemoryImportSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  provider: z.string().trim().min(1).max(80),
  pastedText: z.string().trim().min(1).max(1_000_000),
  forcePrivate: z.boolean().optional(),
});

export const FindImportedSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  limit: z.number().int().min(1).max(500).optional(),
  offset: z.number().int().min(0).optional(),
});

export const DeleteImportedEntrySchema = z.object({
  workspaceId: WorkspaceIdSchema,
  memoryId: UUIDSchema,
});

export const SetImportedRecallIgnoredSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  memoryId: UUIDSchema,
  ignored: z.boolean(),
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

export const MCPServerUpdateSchema = MCPServerConfigSchema.partial().omit({
  id: true,
});

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
    "microsoft-email",
  ]),
  clientId: z.string().min(1).max(500),
  clientSecret: z.string().max(500).optional(),
  scopes: z.array(z.string().max(200)).max(50).optional(),
  loginUrl: z.string().url().max(500).optional(),
  subdomain: z.string().max(200).optional(),
  teamDomain: z.string().max(200).optional(),
  tenant: z.string().max(200).optional(),
  loginHint: z.string().max(500).optional(),
});

// ============ Health Platform Schemas ============

export const HealthSourceInputSchema = z.object({
  provider: z.enum([
    "apple-health",
    "fitbit",
    "oura",
    "garmin",
    "whoop",
    "lab-results",
    "medical-records",
    "custom",
  ]),
  kind: z.enum(["wearable", "lab", "record", "manual"]),
  connectionMode: z.enum(["native", "import"]).optional(),
  name: z.string().min(1).max(200),
  description: z.string().max(500).optional(),
  accountLabel: z.string().max(200).optional(),
  notes: z.string().max(2000).optional(),
});

export const HealthWorkflowRequestSchema = z.object({
  workflowType: z.enum([
    "marathon-training",
    "visit-prep",
    "nutrition-plan",
    "trend-analysis",
  ]),
  sourceIds: z.array(z.string().max(200)).max(20).optional(),
});

/**
 * Allowed roots for health import file paths (prevents path traversal).
 * Paths must resolve under one of these directories.
 */
function getAllowedHealthImportRoots(): string[] {
  const roots: string[] = [];
  try {
    const home = os.homedir();
    roots.push(home);
    roots.push(path.join(home, "Downloads"));
    roots.push(path.join(home, "Desktop"));
    roots.push(path.join(home, "Documents"));
    roots.push(getUserDataDir());
  } catch {
    roots.push(process.cwd());
  }
  return roots;
}

function isPathAllowedForHealthImport(filePath: string): boolean {
  const resolved = path.resolve(filePath);
  const roots = getAllowedHealthImportRoots();
  return roots.some(
    (root) => resolved === root || resolved.startsWith(root + path.sep),
  );
}

export const HealthImportFilesSchema = z
  .object({
    sourceId: z.string().min(1).max(200),
    filePaths: z.array(z.string().min(1).max(MAX_PATH_LENGTH)).min(1).max(20),
  })
  .superRefine((data, ctx) => {
    for (let i = 0; i < data.filePaths.length; i++) {
      const p = data.filePaths[i];
      if (!path.isAbsolute(p)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["filePaths", i],
          message: "Health import paths must be absolute",
        });
      } else if (!isPathAllowedForHealthImport(p)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["filePaths", i],
          message:
            "Health import path must be under home, Downloads, Desktop, Documents, or app user data",
        });
      }
    }
  });

const AwarenessSourceSchema = z.enum([
  "conversation",
  "feedback",
  "files",
  "git",
  "apps",
  "browser",
  "calendar",
  "notifications",
  "clipboard",
  "tasks",
]);
const AwarenessSourcePolicySchema = z.object({
  enabled: z.boolean().optional(),
  ttlMinutes: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 7)
    .optional(),
  allowPromotion: z.boolean().optional(),
  allowPromptInjection: z.boolean().optional(),
  allowHeartbeat: z.boolean().optional(),
});

export const AwarenessConfigSchema = z.object({
  privateModeEnabled: z.boolean().optional(),
  defaultTtlMinutes: z
    .number()
    .int()
    .min(1)
    .max(60 * 24 * 7)
    .optional(),
  sources: z
    .record(AwarenessSourceSchema, AwarenessSourcePolicySchema)
    .optional(),
});

const ChiefOfStaffActionTypeSchema = z.enum([
  "prepare_briefing",
  "create_task",
  "schedule_follow_up",
  "draft_message",
  "draft_agenda",
  "organize_work_session",
  "nudge_user",
  "execute_local_action",
]);
const AutonomyPolicyLevelSchema = z.enum([
  "observe_only",
  "suggest_only",
  "execute_local",
  "execute_with_approval",
  "never",
]);
const ActionPolicySchema = z.object({
  actionType: ChiefOfStaffActionTypeSchema.optional(),
  level: AutonomyPolicyLevelSchema.optional(),
  allowExternalSideEffects: z.boolean().optional(),
  cooldownMinutes: z.number().int().min(0).max(10080).optional(),
});

export const AutonomyConfigSchema = z.object({
  enabled: z.boolean().optional(),
  autoEvaluate: z.boolean().optional(),
  maxPendingDecisions: z.number().int().min(1).max(100).optional(),
  actionPolicies: z
    .record(ChiefOfStaffActionTypeSchema, ActionPolicySchema)
    .optional(),
});

export const QAStartRunSchema = z.object({
  taskId: z.string().min(1).max(200),
  workspaceId: WorkspaceIdSchema,
  config: z
    .object({
      targetUrl: z.string().url().max(500).optional(),
      serverCommand: z.string().max(500).optional(),
      serverCwd: z.string().max(MAX_PATH_LENGTH).optional(),
      serverPort: z.number().int().min(1).max(65535).optional(),
      headless: z.boolean().optional(),
      autoFix: z.boolean().optional(),
      enabledChecks: z.array(z.string().max(50)).max(20).optional(),
    })
    .optional(),
});

// ============ Personality V2 Schemas ============

export const ContextModeSchema = z.enum([
  "coding",
  "chat",
  "planning",
  "writing",
  "research",
  "all",
]);
const PersonaIdSchema = z.enum([
  "none",
  "jarvis",
  "friday",
  "hal",
  "computer",
  "alfred",
  "intern",
  "sensei",
  "companion",
]);

const PersonalityTraitSchema = z.object({
  id: z.string().max(80),
  label: z.string().max(200),
  intensity: z.number().int().min(0).max(100),
  description: z.string().max(500),
});
const BehavioralRuleSchema = z.object({
  id: z.string().max(100),
  type: z.enum(["always", "never", "prefer", "avoid"]),
  rule: z.string().max(2000),
  enabled: z.boolean(),
  context: z.array(ContextModeSchema).max(10).optional(),
});

function normalizeCommunicationStyleInput(value: unknown): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }

  const style = { ...(value as Record<string, unknown>) };
  if (style.codeCommentStyle === "thorough") {
    style.codeCommentStyle = "verbose";
  }
  if (style.explanationDepth === "minimal") {
    style.explanationDepth = "expert";
  } else if (style.explanationDepth === "thorough") {
    style.explanationDepth = "teaching";
  }
  if (style.structurePreference === "prose") {
    style.structurePreference = "freeform";
  } else if (style.structurePreference === "mixed") {
    style.structurePreference = "structured";
  }
  if (style.errorHandling === "technical") {
    style.errorHandling = "detailed";
  }
  return style;
}

const CommunicationStyleObjectSchema = z.object({
  emojiUsage: z.enum(["none", "minimal", "moderate", "expressive"]).optional(),
  responseLength: z.enum(["terse", "balanced", "detailed"]).optional(),
  codeCommentStyle: z.enum(["minimal", "moderate", "verbose"]).optional(),
  explanationDepth: z.enum(["expert", "balanced", "teaching"]).optional(),
  formality: z.enum(["casual", "balanced", "formal"]).optional(),
  structurePreference: z.enum(["freeform", "bullets", "structured", "headers"]).optional(),
  proactivity: z.enum(["reactive", "balanced", "proactive"]).optional(),
  errorHandling: z.enum(["gentle", "direct", "detailed"]).optional(),
});
const CommunicationStyleSchema = z.preprocess(
  normalizeCommunicationStyleInput,
  CommunicationStyleObjectSchema,
);
const CommunicationStyleOverrideSchema = z.preprocess(
  normalizeCommunicationStyleInput,
  CommunicationStyleObjectSchema.partial(),
);
const ExpertiseAreaSchema = z.object({
  id: z.string().max(100),
  domain: z.string().max(200),
  level: z.enum(["familiar", "proficient", "expert"]),
  notes: z.string().max(2000).optional(),
});
const ConversationExampleSchema = z.object({
  id: z.string().max(100),
  userMessage: z.string().max(5000),
  idealResponse: z.string().max(10000),
  context: z.string().max(200).optional(),
});
const ContextOverrideSchema = z.object({
  mode: ContextModeSchema,
  traitOverrides: z
    .record(z.string(), z.number().int().min(0).max(100))
    .optional(),
  additionalRules: z.array(BehavioralRuleSchema).max(20).optional(),
  styleOverrides: CommunicationStyleOverrideSchema.optional(),
});
const CustomInstructionsSchema = z.object({
  aboutUser: z.string().max(20000).optional(),
  responseGuidance: z.string().max(20000).optional(),
});
const PersonalityQuirksV2Schema = z.object({
  catchphrase: z.string().max(200).optional(),
  signOff: z.string().max(200).optional(),
  analogyDomain: z.string().max(100).optional(),
  greetingStyle: z.enum(["none", "brief", "warm", "humorous"]).optional(),
  thinkingNarration: z.boolean().optional(),
});
const RelationshipDataSchema = z.object({
  userName: z.string().max(200).optional(),
  tasksCompleted: z.number().int().min(0).optional(),
  firstInteraction: z.number().optional(),
  lastInteraction: z.number().optional(),
  lastMilestoneCelebrated: z.number().optional(),
  projectsWorkedOn: z.array(z.string().max(200)).max(100).optional(),
});

export const PersonalityConfigV2Schema = z
  .object({
    version: z.literal(2).optional(),
    agentName: z.string().max(200).optional(),
    traits: z.array(PersonalityTraitSchema).max(20).optional(),
    rules: z.array(BehavioralRuleSchema).max(100).optional(),
    style: CommunicationStyleSchema.optional(),
    expertise: z.array(ExpertiseAreaSchema).max(50).optional(),
    examples: z.array(ConversationExampleSchema).max(50).optional(),
    customInstructions: CustomInstructionsSchema.optional(),
    contextOverrides: z.array(ContextOverrideSchema).max(20).optional(),
    activePersona: PersonaIdSchema.optional(),
    quirks: PersonalityQuirksV2Schema.optional(),
    relationship: RelationshipDataSchema.optional(),
    workStyle: z.enum(["planner", "flexible"]).optional(),
    soulDocument: z.string().max(200000).optional(),
    metadata: z
      .object({
        name: z.string().max(200),
        description: z.string().max(500).optional(),
        author: z.string().max(200).optional(),
        createdAt: z.number(),
        exportedAt: z.number().optional(),
      })
      .optional(),
    activePersonality: PersonalityIdSchema.optional(),
    customPrompt: z.string().max(200000).optional(),
    customName: z.string().max(200).optional(),
  })
  .passthrough()
  .refine(
    (data) => {
      try {
        const s = JSON.stringify(data);
        return s.length <= MAX_PERSONALITY_CONFIG_BYTES;
      } catch {
        return false;
      }
    },
    {
      message: `Personality config must be under ${MAX_PERSONALITY_CONFIG_BYTES / 1024}KB`,
    },
  );

export const AwarenessUpdateBeliefSchema = z.object({
  id: z.string().min(1).max(200),
  patch: z
    .record(z.string(), z.unknown())
    .optional()
    .refine(
      (p) =>
        p == null ||
        (typeof p === "object" && JSON.stringify(p).length <= 50000),
      { message: "Patch must be under 50KB" },
    ),
});

export const AutonomyUpdateDecisionSchema = z.object({
  id: z.string().min(1).max(200),
  patch: z
    .record(z.string(), z.unknown())
    .optional()
    .refine(
      (p) =>
        p == null ||
        (typeof p === "object" && JSON.stringify(p).length <= 50000),
      { message: "Patch must be under 50KB" },
    ),
});

// ============ Health Platform Schemas ============

export const HealthWritebackRequestSchema = z.object({
  sourceId: z.string().min(1).max(200),
  items: z.array(
    z.object({
      id: z.string().min(1).max(200),
      type: z.enum([
        "steps",
        "sleep",
        "heart_rate",
        "hrv",
        "weight",
        "workout",
        "glucose",
        "nutrition",
        "custom",
      ]),
      label: z.string().min(1).max(200),
      value: z.string().min(1).max(200),
      unit: z.string().max(50).optional(),
      startDate: z.number().optional(),
      endDate: z.number().optional(),
      sourceId: z.string().max(200).optional(),
    }),
  ),
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
  "feishu",
  "wecom",
  "last",
]);

export const HookMappingSchema = z.object({
  id: z.string().max(100).optional(),
  match: z
    .object({
      path: z.string().max(500).optional(),
      source: z.string().max(100).optional(),
      type: z.string().max(100).optional(),
    })
    .optional(),
  token: z.string().max(200).optional(),
  action: z.enum(["wake", "agent"]).optional(),
  wakeMode: z.enum(["now", "next-heartbeat"]).optional(),
  name: z.string().max(200).optional(),
  sessionKey: z.string().max(100).optional(),
  messageTemplate: z.string().max(10000).optional(),
  textTemplate: z.string().max(10000).optional(),
  deliver: z.boolean().optional(),
  channel: HookMappingChannelSchema.optional(),
  to: z.string().max(100).optional(),
  workspaceId: z.string().max(200).optional(),
  model: z.string().max(100).optional(),
  thinking: z.string().max(50).optional(),
  timeoutSeconds: z.number().int().min(1).max(3600).optional(),
});

// ============ Validation Helper ============

/**
 * Validate input against a schema and throw a user-friendly error if invalid
 */
export function validateInput<T>(
  schema: z.ZodSchema<T>,
  input: unknown,
  context?: string,
): T {
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
