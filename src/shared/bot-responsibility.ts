import type { CronSchedule } from "../electron/cron/types";
import { CHANNEL_TYPES } from "./gateway-channel-types";
import { z } from "zod";

const id = z.string().trim().min(1).max(128);
const operation = z
  .object({
    connectorId: id,
    method: z.string().trim().min(1).max(200),
    resourceId: z.string().trim().min(1).max(512),
  })
  .strict();
export const botResponsibilityDefinitionSchema = z
  .object({
    objective: z.string().trim().min(1).max(4000),
    engine: z.object({ kind: z.enum(["routine", "trigger"]), id }).strict(),
    contextId: id.optional(),
    mode: z.enum(["observe", "propose", "act"]),
    sources: z.array(operation).max(50),
    permittedActions: z.array(operation).max(50),
    expectedOutput: z.string().trim().min(1).max(2000),
    reviewBoundary: z.enum(["all_effects", "outside_granted_scope"]),
    destination: z.object({ channel: z.enum(["internal", "slack", "teams"]), id }).strict(),
    backend: z.enum(["node", "desktop"]),
    budget: z
      .object({
        maxTokens: z.number().int().min(1).max(1000000),
        maxCost: z.number().finite().min(0).max(1000),
      })
      .strict(),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.mode !== "act" && value.permittedActions.length)
      context.addIssue({
        code: "custom",
        path: ["permittedActions"],
        message: "Observe and Propose cannot grant external effects",
      });
  });
export const botResponsibilityScopeSchema = z.object({ workspaceId: id, agentRoleId: id }).strict();
export type BotResponsibilityScope = z.infer<typeof botResponsibilityScopeSchema>;
export type BotResponsibilityDefinition = z.infer<typeof botResponsibilityDefinitionSchema>;
export type ResponsibilityOperation = z.infer<typeof operation>;
export interface BotResponsibility extends BotResponsibilityScope {
  id: string;
  revision: number;
  controlVersion: number;
  futurePaused?: boolean;
  botFuturePaused?: boolean;
  futureControlVersion?: number;
  state: "paused" | "active";
  definition: BotResponsibilityDefinition;
  createdAt: number;
  updatedAt: number;
}

/** Exact matching only. The runtime supplies its trusted method catalog and current
 * policy decision; names/annotations in source content cannot grant permission. */
export function evaluateResponsibilityOperation(input: {
  definition: BotResponsibilityDefinition;
  revision: number;
  currentRevision: number;
  active: boolean;
  operation: ResponsibilityOperation;
  catalog: readonly (ResponsibilityOperation & { effect: "read" | "write" })[];
  currentPolicyAllows: boolean;
}): { allowed: boolean; reason: string } {
  const matches = (item: ResponsibilityOperation) =>
    item.connectorId === input.operation.connectorId &&
    item.method === input.operation.method &&
    item.resourceId === input.operation.resourceId;
  if (input.revision !== input.currentRevision)
    return { allowed: false, reason: "revision_changed" };
  if (!input.active) return { allowed: false, reason: "paused" };
  if (!input.currentPolicyAllows) return { allowed: false, reason: "current_policy_denied" };
  const capability = input.catalog.find(matches);
  if (!capability) return { allowed: false, reason: "unknown_method_or_resource" };
  if (capability.effect === "read")
    return input.definition.sources.some(matches)
      ? { allowed: true, reason: "selected_source" }
      : { allowed: false, reason: "source_not_selected" };
  if (input.definition.mode !== "act") return { allowed: false, reason: "mode_denies_effect" };
  if (
    input.definition.reviewBoundary === "all_effects" ||
    !input.definition.permittedActions.some(matches)
  )
    return { allowed: false, reason: "review_required" };
  return { allowed: true, reason: "granted_action" };
}

export const botResponsibilitySaveSchema = z
  .object({ scope: botResponsibilityScopeSchema, definition: botResponsibilityDefinitionSchema })
  .strict();
export const botResponsibilityReviseSchema = botResponsibilitySaveSchema
  .extend({ id, expectedRevision: z.number().int().min(1) })
  .strict();
export type BotResponsibilitySave = z.infer<typeof botResponsibilitySaveSchema>;
export type BotResponsibilityRevise = z.infer<typeof botResponsibilityReviseSchema>;
export interface BotResponsibilityEngine {
  kind: "routine" | "trigger";
  id: string;
  name: string;
  enabled: boolean;
  bindingId?: string;
}
export interface BotResponsibilityPreview {
  definition: BotResponsibilityDefinition;
  engine: BotResponsibilityEngine;
  triggerSummary: string[];
  schedules: CronSchedule[];
  nextRunIfEnabledAt?: number;
  schedulePreviewState: "calculated" | "event_or_manual" | "unavailable";
  backendPresence: "present" | "requires_desktop" | "unavailable";
  executionState: "paused";
  activationAvailable: boolean;
  activationIssues: string[];
}

export const botResponsibilityRunSchema = z
  .object({
    id,
    workspaceId: id,
    agentRoleId: id,
    revision: z.number().int().positive(),
    controlVersion: z.number().int().nonnegative().default(0),
    engine: z.object({ kind: z.enum(["routine", "trigger"]), id }).strict(),
  })
  .strict();
export type BotResponsibilityRun = z.infer<typeof botResponsibilityRunSchema>;

export const botResponsibilityControlSchema = z
  .object({
    scope: botResponsibilityScopeSchema,
    id,
    expectedRevision: z.number().int().positive(),
    expectedControlVersion: z.number().int().nonnegative(),
  })
  .strict();
export const botResponsibilityRunRequestSchema = botResponsibilityControlSchema
  .extend({ requestId: id })
  .strict();
export type BotResponsibilityControl = z.infer<typeof botResponsibilityControlSchema>;
export type BotResponsibilityRunRequest = z.infer<typeof botResponsibilityRunRequestSchema>;

/** Internal source sample proposal. It never grants permission or tool scope. */
export const botResponsibilitySignalSchema = z
  .object({
    fingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    expectedSequence: z.number().int().nonnegative(),
    channelInstances: z
      .array(z.object({ channelType: z.enum(CHANNEL_TYPES), channelId: id }).strict())
      .max(CHANNEL_TYPES.length)
      .optional(),
  })
  .strict();
export type BotResponsibilitySignal = z.infer<typeof botResponsibilitySignalSchema>;
export const RESPONSIBILITY_SIGNAL_ALREADY_ADMITTED =
  "Responsibility signal is unchanged or already admitted";

export const botResponsibilityFutureControlSchema = botResponsibilityControlSchema
  .extend({
    requestId: id,
    expectedFutureControlVersion: z.number().int().nonnegative(),
    paused: z.boolean(),
  })
  .strict();
export type BotResponsibilityFutureControl = z.infer<typeof botResponsibilityFutureControlSchema>;
export interface BotResponsibilityFutureReceipt {
  requestId: string;
  responsibilityId: string;
  futurePaused: boolean;
  futureControlVersion: number;
  recordedAt: number;
  stillActiveTaskIds: string[];
}
