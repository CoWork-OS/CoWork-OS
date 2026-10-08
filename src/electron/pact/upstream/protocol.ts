// Vendored from openpactprotocol/openpactprotocol@838c6bd1da9be39da04264e8b156dbb4e848a208
// packages/protocol/src/index.ts (Apache-2.0, see ./LICENSE and ./NOTICE).
// Modifications: this header only.
import { z } from "zod";

export const A2A_VERSION = "1.0";

export const A2A_ERRORS = {
  INVALID_PARAMS: { httpStatus: 400, status: "INVALID_ARGUMENT" },
  CONTENT_TYPE_NOT_SUPPORTED: { httpStatus: 400, status: "INVALID_ARGUMENT" },
  UNSUPPORTED_OPERATION: { httpStatus: 400, status: "FAILED_PRECONDITION" },
  PUSH_NOTIFICATION_NOT_SUPPORTED: { httpStatus: 400, status: "FAILED_PRECONDITION" },
  TASK_NOT_FOUND: { httpStatus: 404, status: "NOT_FOUND" },
  INTERNAL: { httpStatus: 500, status: "INTERNAL" },
} as const;

export const A2AErrorResponseSchema = z.object({
  error: z.object({
    code: z.number().int(),
    status: z.enum(["NOT_FOUND", "FAILED_PRECONDITION", "INVALID_ARGUMENT", "INTERNAL"]),
    message: z.string(),
    details: z.array(
      z
        .object({
          "@type": z.literal("type.googleapis.com/google.rpc.ErrorInfo"),
          reason: z.string(),
          domain: z.literal("a2a-protocol.org"),
        })
        .passthrough(),
    ),
  }),
});

export const RoleSchema = z.enum(["ROLE_UNSPECIFIED", "ROLE_USER", "ROLE_AGENT"]);

const JsonValueSchema: z.ZodType<unknown> = z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(z.lazy(() => JsonValueSchema)),
  z.record(
    z.string(),
    z.lazy(() => JsonValueSchema),
  ),
]);

const partFields = {
  metadata: z.record(z.string(), z.unknown()).optional(),
  filename: z.string().optional(),
  mediaType: z.string().optional(),
};

export const PartSchema = z.union([
  z.object({ ...partFields, text: z.string() }).strict(),
  z
    .object({
      ...partFields,
      raw: z.string().regex(/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/),
    })
    .strict(),
  z.object({ ...partFields, url: z.string() }).strict(),
  z.object({ ...partFields, data: JsonValueSchema }).strict(),
]);

export const MessageSchema = z.object({
  messageId: z.string().min(1),
  contextId: z.string().optional(),
  taskId: z.string().optional(),
  role: RoleSchema,
  parts: z.array(PartSchema).min(1),
  metadata: z.record(z.string(), z.unknown()).optional(),
  extensions: z.array(z.string()).optional(),
  referenceTaskIds: z.array(z.string()).optional(),
});

export const SendMessageConfigurationSchema = z.object({
  acceptedOutputModes: z.array(z.string()).optional(),
  taskPushNotificationConfig: z.record(z.string(), z.unknown()).optional(),
  historyLength: z.number().int().nonnegative().optional(),
  returnImmediately: z.boolean().optional(),
});

export const SendMessageRequestSchema = z.object({
  message: MessageSchema,
  configuration: SendMessageConfigurationSchema.optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const SendMessageResponseSchema = z.object({ message: MessageSchema }).strict();

export const ListTasksResponseSchema = z
  .object({
    tasks: z.array(z.never()),
    nextPageToken: z.string(),
    pageSize: z.number().int().min(1).max(100),
    totalSize: z.number().int().nonnegative(),
  })
  .strict();

export const SecuritySchemeSchema = z.union([
  z
    .object({
      apiKeySecurityScheme: z.object({
        name: z.string(),
        location: z.string(),
        description: z.string().optional(),
      }),
    })
    .strict(),
  z
    .object({
      httpAuthSecurityScheme: z.object({
        scheme: z.string(),
        bearerFormat: z.string().optional(),
        description: z.string().optional(),
      }),
    })
    .strict(),
  z.object({ oauth2SecurityScheme: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ openIdConnectSecurityScheme: z.record(z.string(), z.unknown()) }).strict(),
  z.object({ mtlsSecurityScheme: z.record(z.string(), z.unknown()) }).strict(),
]);

export const SecurityRequirementSchema = z.object({
  schemes: z.record(z.string(), z.object({ list: z.array(z.string()) })),
});

export const AgentInterfaceSchema = z.object({
  url: z.string().url(),
  protocolBinding: z.string(),
  tenant: z.string().optional(),
  protocolVersion: z.string(),
});

export const AgentProviderSchema = z.object({
  url: z.string().url(),
  organization: z.string(),
});

export const AgentExtensionSchema = z.object({
  uri: z.string(),
  description: z.string(),
  required: z.boolean(),
  params: z.record(z.string(), z.unknown()).optional(),
});

export const AgentCapabilitiesSchema = z.object({
  streaming: z.boolean().optional(),
  pushNotifications: z.boolean().optional(),
  extensions: z.array(AgentExtensionSchema).optional(),
  extendedAgentCard: z.boolean().optional(),
});

export const AgentSkillSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  tags: z.array(z.string()),
  examples: z.array(z.string()).optional(),
  inputModes: z.array(z.string()).optional(),
  outputModes: z.array(z.string()).optional(),
  securityRequirements: z.array(SecurityRequirementSchema).optional(),
});

export const AgentCardSchema = z.object({
  name: z.string(),
  description: z.string(),
  supportedInterfaces: z.array(AgentInterfaceSchema),
  provider: AgentProviderSchema.optional(),
  version: z.string(),
  documentationUrl: z.string().url().optional(),
  capabilities: AgentCapabilitiesSchema,
  securitySchemes: z.record(z.string(), SecuritySchemeSchema).optional(),
  securityRequirements: z.array(SecurityRequirementSchema).optional(),
  defaultInputModes: z.array(z.string()),
  defaultOutputModes: z.array(z.string()),
  skills: z.array(AgentSkillSchema),
  signatures: z.array(z.record(z.string(), z.unknown())).optional(),
  iconUrl: z.string().url().optional(),
});

export const PlatformJwtClaimsSchema = z.object({
  iss: z.string(),
  sub: z.string().min(1),
  aud: z.string(),
  iat: z.number().int(),
  exp: z.number().int(),
  jti: z.string().min(1).optional(),
});

export type Role = z.infer<typeof RoleSchema>;
export type Part = z.infer<typeof PartSchema>;
export type Message = z.infer<typeof MessageSchema>;
export type SendMessageConfiguration = z.infer<typeof SendMessageConfigurationSchema>;
export type SendMessageRequest = z.infer<typeof SendMessageRequestSchema>;
export type SendMessageResponse = z.infer<typeof SendMessageResponseSchema>;
export type ListTasksResponse = z.infer<typeof ListTasksResponseSchema>;
export type SecurityScheme = z.infer<typeof SecuritySchemeSchema>;
export type SecurityRequirement = z.infer<typeof SecurityRequirementSchema>;
export type AgentInterface = z.infer<typeof AgentInterfaceSchema>;
export type AgentProvider = z.infer<typeof AgentProviderSchema>;
export type AgentCapabilities = z.infer<typeof AgentCapabilitiesSchema>;
export type AgentExtension = z.infer<typeof AgentExtensionSchema>;
export type AgentSkill = z.infer<typeof AgentSkillSchema>;
export type AgentCard = z.infer<typeof AgentCardSchema>;
export type A2AErrorResponse = z.infer<typeof A2AErrorResponseSchema>;
export type PlatformJwtClaims = z.infer<typeof PlatformJwtClaimsSchema>;

// Platform registration is a Provider-specific API, separate from A2A messages.
export const PlatformRegistrationRequestSchema = z
  .object({
    name: z.string().regex(/^[a-z0-9][a-z0-9-]{1,62}$/),
    jwksUri: z.string().min(1),
  })
  .strict();

export const RegisteredPlatformSchema = z
  .object({
    id: z.string().uuid(),
    name: z.string(),
    issuer: z.string().url(),
    jwksUri: z.string().url(),
    enabled: z.boolean(),
  })
  .strict();

export const PlatformRegistrationResponseSchema = z
  .object({ platform: RegisteredPlatformSchema })
  .strict();

export type PlatformRegistrationRequest = z.infer<typeof PlatformRegistrationRequestSchema>;
export type RegisteredPlatform = z.infer<typeof RegisteredPlatformSchema>;
