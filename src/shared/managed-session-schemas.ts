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
