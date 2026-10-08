// Vendored from openpactprotocol/openpactprotocol@838c6bd1da9be39da04264e8b156dbb4e848a208
// packages/protocol/src/delegation.ts (Apache-2.0, see ./LICENSE and ./NOTICE).
// Modifications: this header; the sibling import points at ./protocol.
import { z } from "zod";
import { MessageSchema } from "./protocol";

// PACT Delegated profile (spec §5). Identity-only code never needs this module.

export const DELEGATION_HEADER = "X-A2A-User-Delegation";
export const DEVICE_CODE_GRANT_TYPE = "urn:ietf:params:oauth:grant-type:device_code";
export const REFRESH_TOKEN_GRANT_TYPE = "refresh_token";

export const PACT_METADATA = {
  missingScopes: "pact.missingScopes",
  verificationUriComplete: "pact.verificationUriComplete",
  receipt: "pact.receipt",
} as const;

export function parseScope(scope: string): string[] {
  return [...new Set(scope.split(" ").filter(Boolean))];
}

export function formatScope(scopes: readonly string[]): string {
  return [...new Set(scopes)].join(" ");
}

const ScopeIdSchema = z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/);

export const DeviceCodeFlowSchema = z.object({
  deviceAuthorizationUrl: z.string().url(),
  tokenUrl: z.string().url(),
  refreshUrl: z.string().url().optional(),
  scopes: z.record(ScopeIdSchema, z.string()),
});

export const OAuth2DeviceCodeSecuritySchemeSchema = z
  .object({
    oauth2SecurityScheme: z.object({
      description: z.string().optional(),
      flows: z.object({ deviceCode: DeviceCodeFlowSchema }),
      oauth2MetadataUrl: z.string().url(),
    }),
  })
  .strict();

export const AuthorizationServerMetadataSchema = z
  .object({
    issuer: z.string().url(),
    device_authorization_endpoint: z.string().url(),
    token_endpoint: z.string().url(),
    jwks_uri: z.string().url(),
    scopes_supported: z.array(ScopeIdSchema).optional(),
    grant_types_supported: z.array(z.string()).optional(),
  })
  .passthrough();

export const DeviceAuthorizationResponseSchema = z.object({
  device_code: z.string().min(1),
  user_code: z.string().min(1),
  verification_uri: z.string().url(),
  verification_uri_complete: z.string().url(),
  expires_in: z.number().int().positive(),
  interval: z.number().int().positive().optional(),
});

export const TokenResponseSchema = z.object({
  token_type: z.string().regex(/^bearer$/i),
  access_token: z.string().min(1),
  refresh_token: z.string().min(1).optional(),
  expires_in: z.number().int().positive(),
  scope: z.string(),
});

export const OAuthErrorCodeSchema = z.enum([
  "invalid_request",
  "invalid_client",
  "invalid_grant",
  "unauthorized_client",
  "unsupported_grant_type",
  "invalid_scope",
  "authorization_pending",
  "slow_down",
  "access_denied",
  "expired_token",
]);

export const OAuthErrorResponseSchema = z.object({
  error: z.string().min(1),
  error_description: z.string().optional(),
  error_uri: z.string().optional(),
});

export const DelegationTokenClaimsSchema = z.object({
  iss: z.string().url(),
  aud: z.string().url(),
  sub: z.string().min(1),
  client_id: z.string().url(),
  scope: z.string(),
  grant_id: z.string().min(1),
  iat: z.number().int(),
  exp: z.number().int(),
});

export const TaskStateSchema = z.enum([
  "TASK_STATE_UNSPECIFIED",
  "TASK_STATE_SUBMITTED",
  "TASK_STATE_WORKING",
  "TASK_STATE_COMPLETED",
  "TASK_STATE_FAILED",
  "TASK_STATE_CANCELED",
  "TASK_STATE_INPUT_REQUIRED",
  "TASK_STATE_REJECTED",
  "TASK_STATE_AUTH_REQUIRED",
]);

export const TaskStatusSchema = z.object({
  state: TaskStateSchema,
  message: MessageSchema.optional(),
  timestamp: z.string().optional(),
});

export const TaskSchema = z.object({
  id: z.string().min(1),
  contextId: z.string().min(1),
  status: TaskStatusSchema,
  artifacts: z.array(z.record(z.string(), z.unknown())).optional(),
  history: z.array(MessageSchema).optional(),
  metadata: z.record(z.string(), z.unknown()).optional(),
});

export const StepUpMetadataSchema = z.object({
  [PACT_METADATA.missingScopes]: z.array(ScopeIdSchema).min(1),
  [PACT_METADATA.verificationUriComplete]: z.string().url().optional(),
});

export const DelegatedSendMessageResponseSchema = z.union([
  z.object({ message: MessageSchema }).strict(),
  z.object({ task: TaskSchema }).strict(),
]);

export const ReceiptActionSchema = z.object({
  tool: z.string().min(1),
  argsHash: z.string().min(1).optional(),
});

export const ReceiptClaimsSchema = z.object({
  grantId: z.string().min(1),
  user: z.string().min(1),
  pa: z.string().url(),
  brand: z.string().url(),
  scopesUsed: z.array(ScopeIdSchema),
  actions: z.array(ReceiptActionSchema),
  ts: z.string().datetime({ offset: true }),
});

export const ReceiptSchema = z.object({
  jws: z.string().regex(/^[\w-]+\.[\w-]+\.[\w-]+$/),
  claims: ReceiptClaimsSchema,
});

export type DeviceCodeFlow = z.infer<typeof DeviceCodeFlowSchema>;
export type OAuth2DeviceCodeSecurityScheme = z.infer<typeof OAuth2DeviceCodeSecuritySchemeSchema>;
export type AuthorizationServerMetadata = z.infer<typeof AuthorizationServerMetadataSchema>;
export type DeviceAuthorizationResponse = z.infer<typeof DeviceAuthorizationResponseSchema>;
export type TokenResponse = z.infer<typeof TokenResponseSchema>;
export type OAuthErrorCode = z.infer<typeof OAuthErrorCodeSchema>;
export type OAuthErrorResponse = z.infer<typeof OAuthErrorResponseSchema>;
export type DelegationTokenClaims = z.infer<typeof DelegationTokenClaimsSchema>;
export type TaskState = z.infer<typeof TaskStateSchema>;
export type TaskStatus = z.infer<typeof TaskStatusSchema>;
export type Task = z.infer<typeof TaskSchema>;
export type StepUpMetadata = z.infer<typeof StepUpMetadataSchema>;
export type DelegatedSendMessageResponse = z.infer<typeof DelegatedSendMessageResponseSchema>;
export type ReceiptAction = z.infer<typeof ReceiptActionSchema>;
export type ReceiptClaims = z.infer<typeof ReceiptClaimsSchema>;
export type Receipt = z.infer<typeof ReceiptSchema>;
