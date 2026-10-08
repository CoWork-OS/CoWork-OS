/**
 * Input schemas for every PACT surface (IPC, Control Plane, browser host, CLI). Renderer and
 * remote input is untrusted: everything is strict, bounded, and validated on the main side.
 */
import { z } from "zod";

const Id = z.string().trim().min(1).max(200);
const ScopeId = z.string().regex(/^[\x21\x23-\x5B\x5D-\x7E]+$/).max(200);
const HttpsUrl = z.string().trim().min(1).max(2048);

export const PactNoArgsSchema = z.union([z.undefined(), z.object({}).strict()]);

export const PactDiscoverSchema = z
  .object({
    domain: z.string().trim().min(1).max(253).optional(),
    cardUrl: HttpsUrl.optional(),
    refresh: z.boolean().optional(),
    workspaceId: Id.optional(),
  })
  .strict()
  .refine((value) => Boolean(value.domain) !== Boolean(value.cardUrl), {
    message: "Provide exactly one of domain or cardUrl",
  });

export const PactIdSchema = z.object({ id: Id }).strict();

export const PactConversationListSchema = z
  .object({
    businessId: Id.optional(),
    taskId: Id.optional(),
    limit: z.number().int().min(1).max(200).optional(),
  })
  .strict();

export const PactSendSchema = z
  .object({
    businessId: Id,
    conversationId: Id.optional(),
    text: z.string().max(4000),
    effect: z.enum(["inspect", "change", "unknown"]),
    requiredScopes: z.array(ScopeId).max(20).default([]),
    purpose: z.string().max(300).optional(),
    reconcileOperationId: Id.optional(),
    /** The owner confirmed this exact message on their own surface. */
    confirmed: z.boolean().default(false),
    workspaceId: Id.optional(),
  })
  .strict();

export const PactAuthorizationStartSchema = z
  .object({
    businessId: Id,
    scopes: z.array(ScopeId).min(1).max(20),
    purpose: z.string().max(300).optional(),
    workspaceId: Id.optional(),
  })
  .strict();

export const PactAuthorizationListSchema = z
  .object({ pendingOnly: z.boolean().optional(), taskId: Id.optional() })
  .strict();

export const PactAuthorizationByInputSchema = z.object({ inputRequestId: Id }).strict();

const ProviderSchema = z
  .object({
    origin: HttpsUrl,
    audience: z.string().trim().min(1).max(512),
    label: z.string().max(120).optional(),
  })
  .strict();

export const PactSettingsUpdateSchema = z
  .object({
    enabled: z.boolean().optional(),
    preference: z.enum(["prefer-pact", "require-pact", "disabled"]).optional(),
    identity: z
      .object({
        deployment: z.enum(["managed", "self_hosted", "development", "none"]),
        issuer: HttpsUrl.optional(),
        signerUrl: HttpsUrl.optional(),
        authMode: z.enum(["credential", "device_key"]).optional(),
      })
      .strict()
      .optional(),
    providers: z.array(ProviderSchema).max(100).optional(),
  })
  .strict();

export const PactSignerCredentialSchema = z
  .object({ credential: z.string().min(16).max(4096).nullable() })
  .strict();

export type PactDiscoverInput = z.infer<typeof PactDiscoverSchema>;
export type PactSendInput = z.infer<typeof PactSendSchema>;
export type PactAuthorizationStartInput = z.infer<typeof PactAuthorizationStartSchema>;
export type PactSettingsUpdateInput = z.infer<typeof PactSettingsUpdateSchema>;
