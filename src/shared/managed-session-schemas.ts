import { z } from "zod";

export const ManagedSessionRequirementCorrectionEventSchema = z
  .object({
    type: z.literal("requirement.corrected"),
    requirementId: z.string().trim().min(1).max(256),
    statement: z.string().trim().min(1).max(4_000),
    criterion: z.discriminatedUnion("type", [
      z
        .object({
          type: z.literal("file_exists"),
          targetPath: z.string().trim().min(1).max(4_000),
        })
        .strict(),
      z.object({ type: z.literal("unsupported") }).strict(),
    ]),
    idempotencyKey: z.string().trim().min(1).max(200),
  })
  .strict();

export const ManagedSessionRequirementCorrectionRequestSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(200),
    event: ManagedSessionRequirementCorrectionEventSchema,
  })
  .strict();

export const ManagedSessionSuccessCriteriaSchema = z.discriminatedUnion("type", [
  z
    .object({
      type: z.literal("file_exists"),
      filePaths: z.array(z.string().trim().min(1).max(4_000)).min(1).max(100),
    })
    .strict(),
  z
    .object({
      type: z.literal("shell_command"),
      command: z.string().trim().min(1).max(2_000),
    })
    .strict(),
]);

/** A durable, redacted package that carries an in-progress session to another session. */
export const SESSION_HANDOFF_KIND = "cowork.session-handoff";
export const SESSION_HANDOFF_SCHEMA_VERSION = 1;

const handoffId = z.string().trim().min(1).max(256);
// Bounded to the range a Date can represent.
const handoffTimestamp = z.number().int().nonnegative().max(8_640_000_000_000_000);
const handoffSha256 = z.string().regex(/^[a-f0-9]{64}$/);

export const SessionHandoffManifestSchema = z
  .object({
    kind: z.literal(SESSION_HANDOFF_KIND),
    schemaVersion: z.literal(SESSION_HANDOFF_SCHEMA_VERSION),
    packageId: z.string().regex(/^handoff-[a-z0-9-]{8,80}$/),
    exportedAt: handoffTimestamp,
    source: z
      .object({
        managedSessionId: handoffId.optional(),
        workSessionId: handoffId,
        taskId: handoffId,
        workspaceId: handoffId,
        agentId: handoffId.optional(),
        agentVersion: z.number().int().positive().optional(),
        environmentId: handoffId.optional(),
        branch: z.string().max(256).optional(),
        status: z.string().max(64),
        title: z.string().max(500),
      })
      .strict(),
    contract: z
      .object({
        id: handoffId,
        version: z.number().int().positive(),
        objective: z.string().max(16_000),
        status: z.enum(["pending", "satisfied", "partial", "unmet", "waived"]),
        requirements: z
          .array(
            z
              .object({
                id: handoffId,
                kind: z.enum(["objective", "output", "verification", "criterion"]),
                description: z.string().max(4_000),
                required: z.boolean(),
                status: z.enum(["pending", "satisfied", "failed", "waived"]),
                verifier: z.string().max(200).optional(),
                targetPath: z.string().max(4_000).optional(),
              })
              .strict(),
          )
          .max(200),
      })
      .strict()
      .optional(),
    constraints: z
      .array(
        z
          .object({
            id: handoffId,
            kind: z.enum(["constraint", "decision", "assumption", "requirement", "waiver"]),
            key: z.string().max(500),
            statement: z.string().max(4_000),
            status: z.enum(["active", "satisfied", "violated", "superseded"]),
            owner: z.string().max(200).optional(),
          })
          .strict(),
      )
      .max(500),
    /** Only waits that were still pending at export; none of them is granted by an import. */
    waits: z
      .array(
        z
          .object({
            id: handoffId,
            kind: z.enum(["approval", "input", "reconnect", "paused", "child", "external"]),
            reason: z.string().max(4_000),
            createdAt: handoffTimestamp,
            expiresAt: handoffTimestamp.optional(),
          })
          .strict(),
      )
      .max(100),
    evidence: z
      .array(
        z
          .object({
            id: handoffId,
            claim: z.string().max(4_000),
            sourceType: z.string().max(64),
            sourceRef: z.string().max(4_000),
            capturedAt: handoffTimestamp,
            freshnessExpiresAt: handoffTimestamp.optional(),
            confidence: z.number().min(0).max(1),
            status: z.enum(["supporting", "contradicting", "neutral", "stale"]),
            basis: z.enum(["observed", "inferred", "unknown"]).optional(),
          })
          .strict(),
      )
      .max(500),
    /** Latest committed revision per workspace-relative path; `copied` files are in artifacts/. */
    artifacts: z
      .array(
        z
          .object({
            path: z.string().min(1).max(4_000),
            sha256: handoffSha256,
            size: z.number().int().nonnegative(),
            mimeType: z.string().max(200),
            revision: z.number().int().positive(),
            copied: z.boolean(),
          })
          .strict(),
      )
      .max(200),
    /** Side-effect keys the source session already completed, so they are not repeated. */
    completedSideEffects: z.array(z.string().max(500)).max(500),
    checkpoint: z
      .object({
        createdAt: handoffTimestamp,
        messageCount: z.number().int().nonnegative().optional(),
        summary: z.string().max(8_000),
      })
      .strict()
      .optional(),
    transcript: z
      .array(
        z
          .object({
            sequence: z.number().int().nonnegative(),
            kind: z.string().max(64),
            actor: z.string().max(64),
            createdAt: handoffTimestamp,
            text: z.string().max(2_000),
          })
          .strict(),
      )
      .max(200),
    warnings: z.array(z.string().max(1_000)).max(200),
    /** sha256 of the canonical JSON of every other field. */
    checksum: handoffSha256,
  })
  .strict();

export type SessionHandoffManifest = z.infer<typeof SessionHandoffManifestSchema>;

/** The renderer exports into the default package folder only. */
export const SessionHandoffExportIpcRequestSchema = z
  .object({
    sessionId: handoffId.optional(),
    taskId: handoffId.optional(),
  })
  .strict()
  .refine((request) => Boolean(request.sessionId) !== Boolean(request.taskId), {
    message: "Provide exactly one of sessionId or taskId",
  });

export const SessionHandoffExportRequestSchema = z
  .object({
    sessionId: handoffId.optional(),
    taskId: handoffId.optional(),
    targetDir: z.string().trim().min(1).max(4_000).optional(),
  })
  .strict()
  .refine((request) => Boolean(request.sessionId) !== Boolean(request.taskId), {
    message: "Provide exactly one of sessionId or taskId",
  });

export const SessionHandoffImportRequestSchema = z
  .object({
    manifestPath: z.string().trim().min(1).max(4_000),
    environmentId: handoffId,
    agentId: handoffId.optional(),
    title: z.string().trim().min(1).max(500).optional(),
    message: z.string().trim().max(16_000).optional(),
    /** Validate and list what would be restored, without writing or starting a session. */
    dryRun: z.boolean().optional(),
  })
  .strict();
