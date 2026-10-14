import { z } from "zod";

// These envelopes describe work, not a universal document/CRM/CAD object model.
const id = z.string().trim().min(1).max(256);
const text = z.string().trim().min(1).max(8_000);
const jsonObject = z.record(z.string(), z.json());
export const ApplicationResourceSchema = z
  .object({
    kind: z.enum(["file", "native_project", "remote_entity", "query", "application_state"]),
    system: id,
    identity: id,
    accountId: id.optional(),
    tenantId: id.optional(),
    locator: z.string().max(2_048).optional(),
    version: id.optional(),
    observedAt: z.number().finite().nonnegative().optional(),
  })
  .strict();
export type ApplicationResource = z.infer<typeof ApplicationResourceSchema>;

export const ApplicationEnvironmentSchema = z
  .object({
    id,
    kind: z.enum(["local", "service", "browser", "desktop", "isolated_worker"]),
    locality: z.enum(["local", "remote"]),
    background: z.boolean(),
    isolated: z.boolean(),
  })
  .strict();
export type ApplicationEnvironment = z.infer<typeof ApplicationEnvironmentSchema>;

export const ApplicationRouteSchema = z
  .object({
    id,
    adapterId: id,
    adapterVersion: id,
    capability: id,
    protocol: z.enum(["native", "mcp", "api", "cli", "delegated"]),
    control: z.enum(["structured", "script", "browser", "computer"]),
    environment: ApplicationEnvironmentSchema,
    resourceKinds: z.array(ApplicationResourceSchema.shape.kind).min(1).max(5),
    effect: z.enum(["read", "write", "unknown"]),
    preparationEffect: z.enum(["read", "write", "unknown"]).default("unknown"),
    replay: z.enum(["never", "read_only", "remote_idempotency"]),
    supports: z
      .object({
        prepare: z.boolean(),
        observe: z.boolean(),
        cancel: z.boolean(),
        verify: z.boolean(),
        conditionalWrite: z.boolean(),
        remoteFencing: z.boolean(),
      })
      .strict(),
    qualified: z.boolean(),
    /** Host-qualified bounded synchronous calls; callers cannot override route timing. */
    callTimeoutMs: z.number().int().min(1_000).max(120_000).optional(),
    description: text,
    inputSchema: jsonObject.default({ type: "object" }),
  })
  .strict();
export type ApplicationRoute = z.infer<typeof ApplicationRouteSchema>;

export const ApplicationOperationRequestSchema = z
  .object({
    schemaVersion: z.literal(1).default(1),
    idempotencyKey: id,
    taskId: id,
    sessionId: id,
    workspaceId: id,
    capability: id,
    routeId: id.optional(),
    objective: text,
    input: jsonObject,
    resources: z.array(ApplicationResourceSchema).max(32),
    dependsOn: z.array(id).max(32).default([]),
    supersedes: id.optional(),
    planRevision: z.number().int().min(1).default(1),
    decision: z.object({ reason: text, question: text }).strict().optional(),
    constraints: z
      .object({
        localOnly: z.boolean().optional(),
        backgroundRequired: z.boolean().optional(),
        deadlineAt: z.number().finite().nonnegative().optional(),
        maxAttempts: z.number().int().min(1).max(10).default(1),
        maxPolls: z.number().int().min(1).max(1_000).default(120),
        maxCost: z.number().finite().nonnegative().optional(),
        currency: id.optional(),
      })
      .strict()
      .default({ maxAttempts: 1, maxPolls: 120 }),
  })
  .strict();
export type ApplicationOperationRequest = z.infer<typeof ApplicationOperationRequestSchema>;

export const ApplicationPreparedChangeSchema = z
  .object({
    kind: z.enum(["summary", "diff", "preview", "simulation"]),
    summary: text,
    references: z.array(z.string().max(2_048)).max(32).default([]),
    expiresAt: z.number().finite().nonnegative().optional(),
    estimatedCost: z.number().finite().nonnegative().optional(),
    currency: id.optional(),
    estimatedDurationMs: z.number().finite().nonnegative().optional(),
    payload: jsonObject.optional(),
  })
  .strict();
export type ApplicationPreparedChange = z.infer<typeof ApplicationPreparedChangeSchema>;

export const ApplicationResultSchema = z
  .object({
    kind: z.enum(["artifact", "record", "analysis", "application_state"]),
    summary: text,
    resources: z.array(ApplicationResourceSchema).max(32),
    data: jsonObject.optional(),
    unmetCriteria: z.array(text).max(32).default([]),
  })
  .strict();
export type ApplicationResult = z.infer<typeof ApplicationResultSchema>;
export const ApplicationVerificationSchema = z
  .object({
    status: z.enum(["verified", "contradicted", "unavailable"]),
    summary: text,
    checkedAt: z.number().finite().nonnegative(),
    /** Fresh domain readback may refine an earlier partial result; it never replays an effect. */
    result: ApplicationResultSchema.optional(),
    expiresAt: z.number().finite().nonnegative().optional(),
    evidence: z
      .array(
        z
          .object({
            source: z.string().min(1).max(2_048),
            claim: text,
          })
          .strict(),
      )
      .max(32),
  })
  .strict();
export type ApplicationVerification = z.infer<typeof ApplicationVerificationSchema>;

export type ApplicationExecutionStatus =
  | "planned"
  | "prepared"
  | "submitting"
  | "running"
  | "completed"
  | "failed"
  | "unknown"
  | "cancelled";
export type ApplicationCancellationStatus = "none" | "requested" | "confirmed" | "unsupported";
export interface ApplicationDecision {
  id: string;
  operationId: string;
  binding: string;
  reason: string;
  question: string;
  status: "pending" | "accepted" | "rejected" | "revise" | "expired";
  resolutionKey?: string;
  feedback?: string;
  resolvedAt?: number;
}
export interface ApplicationOperation {
  id: string;
  request: ApplicationOperationRequest;
  route: ApplicationRoute;
  revision: number;
  execution: ApplicationExecutionStatus;
  verification: "pending" | ApplicationVerification["status"];
  cancellation: ApplicationCancellationStatus;
  prepared?: ApplicationPreparedChange;
  decision?: ApplicationDecision;
  externalId?: string;
  result?: ApplicationResult;
  verificationResult?: ApplicationVerification;
  error?: string;
  attemptCount: number;
  dispatchRequested: boolean;
  pendingAction?: "prepare" | "execute" | "cancel";
  manualResolution?: {
    key: string;
    digest: string;
    status: "applied" | "not_applied" | "stopped";
    summary: string;
    at: number;
  };
  supersededBy?: string;
  nextPollAt?: number;
  createdAt: number;
  updatedAt: number;
}
export interface ApplicationAttempt {
  id: string;
  operationId: string;
  number: number;
  phase: "prepare" | "execute" | "observe" | "verify" | "cancel";
  owner: string;
  generation: number;
  status: "started" | "completed" | "unknown";
  startedAt: number;
  finishedAt?: number;
}
export interface ApplicationOperationEvent {
  sequence: number;
  operationId: string;
  kind: string;
  at: number;
  revision: number;
}
export interface ApplicationOperationProjection {
  operationId: string;
  status:
    | "needs_decision"
    | "in_progress"
    | "complete"
    | "partial"
    | "unverified"
    | "unknown"
    | "failed"
    | "cancelled"
    | "superseded";
  objective: string;
  result?: ApplicationResult;
  decision?: ApplicationDecision;
  prepared?: ApplicationPreparedChange;
  verification?: ApplicationVerification;
  error?: string;
}

export function projectApplicationOperation(
  operation: ApplicationOperation,
  now = Date.now(),
): ApplicationOperationProjection {
  const fresh =
    !operation.verificationResult?.expiresAt || operation.verificationResult.expiresAt > now;
  const status: ApplicationOperationProjection["status"] = operation.supersededBy
    ? "superseded"
    : operation.execution === "cancelled"
      ? "cancelled"
      : operation.decision?.status === "pending"
        ? "needs_decision"
        : operation.execution === "unknown"
          ? "unknown"
          : operation.execution === "failed"
            ? "failed"
            : operation.execution !== "completed" || operation.verification === "pending"
              ? "in_progress"
              : operation.verification === "verified" &&
                  fresh &&
                  operation.result &&
                  operation.result.unmetCriteria.length === 0
                ? "complete"
                : operation.verification === "contradicted" ||
                    !!operation.result?.unmetCriteria.length
                  ? "partial"
                  : "unverified";
  return {
    operationId: operation.id,
    status,
    objective: operation.request.objective,
    result: operation.result,
    decision: operation.decision,
    prepared: operation.prepared,
    verification: operation.verificationResult,
    error: operation.error,
  };
}
