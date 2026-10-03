import * as path from "path";
import { z } from "zod";
import { WORKSPACE_KIT_CONTRACTS } from "../context/kit-contracts";
import { validateExcludedPatterns } from "../memory/excluded-patterns";
import {
  canonicalizeAccessPath,
  isAccessPathWithin,
  isProtectedWorkspacePath,
} from "../security/access-profile-paths";
import { StringIdSchema, WorkspaceIdSchema } from "../utils/validation";

/**
 * Schemas for the memory and kit IPC handlers (SEC-11). Every payload comes from the
 * renderer, which is untrusted: shapes are whitelisted, strings and lists are bounded,
 * limits are capped, and calls that read memory rows name the workspace they read.
 */

const MAX_QUERY_LENGTH = 1_000;
const MAX_DETAIL_IDS = 50;
const MAX_FILTER_VALUES = 20;
const MAX_FACT_LENGTH = 2_000;
const MAX_NOTE_LENGTH = 2_000;

/** A positive integer limit, clamped to `max` rather than rejected when too large. */
const cappedLimit = (max: number) =>
  z
    .number()
    .finite()
    .transform((value) => Math.max(1, Math.min(max, Math.floor(value))));

const QuerySchema = z.string().max(MAX_QUERY_LENGTH);
const ConfidenceSchema = z.number().finite().min(0).max(1);
const TimestampSchema = z.number().finite().min(0);

export const MemorySearchRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    query: QuerySchema,
    limit: cappedLimit(100).optional(),
  })
  .strict();

export const MemoryTimelineRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    memoryId: StringIdSchema,
    windowSize: cappedLimit(20).optional(),
  })
  .strict();

export const MemoryDetailsRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    ids: z.array(StringIdSchema).max(MAX_DETAIL_IDS),
  })
  .strict();

const FilterListSchema = z.array(z.string().trim().min(1).max(64)).max(MAX_FILTER_VALUES);

export const MemoryObservationSearchRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    query: QuerySchema.optional(),
    limit: cappedLimit(100).optional(),
    offset: z.number().int().min(0).max(10_000).optional(),
    observationTypes: FilterListSchema.optional(),
    origins: FilterListSchema.optional(),
    privacyStates: z
      .array(z.enum(["normal", "private", "redacted", "suppressed"]))
      .max(4)
      .optional(),
    dateStart: TimestampSchema.optional(),
    dateEnd: TimestampSchema.optional(),
  })
  .strict();

export const MemoryObservationTimelineRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    memoryId: StringIdSchema.optional(),
    query: QuerySchema.optional(),
    windowSize: cappedLimit(20).optional(),
  })
  .strict();

export const MemoryRecentRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    limit: cappedLimit(200).optional(),
  })
  .strict();

/**
 * Settings patch. `excludedPatterns` are compiled as RegExp in main, so each is bounded
 * and screened for catastrophic backtracking (see `memory/excluded-patterns.ts`).
 * Unknown keys are stripped rather than rejected: the renderer sends whole settings
 * objects that also carry read-only fields such as `workspaceId`.
 */
export const MemorySaveSettingsRequestSchema = z.object({
  workspaceId: WorkspaceIdSchema,
  settings: z.object({
    enabled: z.boolean().optional(),
    autoCapture: z.boolean().optional(),
    compressionEnabled: z.boolean().optional(),
    retentionDays: z.number().int().min(1).max(3650).optional(),
    maxStorageMb: z.number().int().min(1).max(100_000).optional(),
    privacyMode: z.enum(["normal", "strict", "disabled"]).optional(),
    excludedPatterns: z
      .unknown()
      .transform((value, ctx) => {
        try {
          return validateExcludedPatterns(value);
        } catch (error) {
          ctx.addIssue({
            code: "custom",
            message: error instanceof Error ? error.message : "Invalid excluded patterns",
          });
          return z.NEVER;
        }
      })
      .optional(),
  }),
});

export const CommitmentsGetRequestSchema = z
  .object({ limit: cappedLimit(100).optional() })
  .strict()
  .optional();

export const RelationshipListRequestSchema = z
  .object({
    layer: z.enum(["identity", "preferences", "context", "history", "commitments"]).optional(),
    includeDone: z.boolean().optional(),
    limit: cappedLimit(500).optional(),
  })
  .strict()
  .optional();

export const RelationshipUpdateRequestSchema = z
  .object({
    id: StringIdSchema,
    text: z.string().max(MAX_FACT_LENGTH).optional(),
    confidence: ConfidenceSchema.optional(),
    status: z.enum(["open", "done"]).optional(),
    dueAt: TimestampSchema.nullable().optional(),
  })
  .strict();

const UserFactCategorySchema = z.enum([
  "identity",
  "preference",
  "bio",
  "work",
  "goal",
  "operating",
  "voice",
  "accountability",
  "constraint",
  "other",
]);

/**
 * A fact added from the UI is always a manual fact. `source` is accepted for
 * compatibility but overwritten, so the renderer cannot label its own input as
 * conversation- or feedback-derived.
 */
export const AddUserFactRequestSchema = z
  .object({
    category: UserFactCategorySchema,
    value: z.string().trim().min(1).max(MAX_FACT_LENGTH),
    confidence: ConfidenceSchema.optional(),
    source: z.enum(["conversation", "feedback", "manual"]).optional(),
    pinned: z.boolean().optional(),
    taskId: StringIdSchema.optional(),
  })
  .strict()
  .transform((request) => ({ ...request, source: "manual" as const }));

export const UpdateUserFactRequestSchema = z
  .object({
    id: StringIdSchema,
    category: UserFactCategorySchema.optional(),
    value: z.string().trim().min(1).max(MAX_FACT_LENGTH).optional(),
    confidence: ConfidenceSchema.optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

/** Reasons offered by the message feedback menu in the renderer. */
export const MESSAGE_FEEDBACK_REASONS = [
  "incorrect",
  "too_verbose",
  "ignored_instructions",
  "wrong_tone",
  "unsafe",
] as const;

export const MessageFeedbackRequestSchema = z
  .object({
    taskId: StringIdSchema,
    messageId: z.string().min(1).max(200).optional(),
    decision: z.enum(["accepted", "rejected"]),
    reason: z.enum(MESSAGE_FEEDBACK_REASONS).optional(),
    note: z.string().max(MAX_NOTE_LENGTH).optional(),
  })
  .strict();

export const MemoryWriteApproveRequestSchema = z
  .object({
    id: StringIdSchema,
    workspaceId: WorkspaceIdSchema,
  })
  .strict();

export const MemoryWriteRejectRequestSchema = z
  .object({
    id: StringIdSchema,
    workspaceId: WorkspaceIdSchema,
    reason: z.string().max(MAX_NOTE_LENGTH).optional(),
  })
  .strict();

export const KitOpenFileRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    relPath: z.string().min(1).max(512),
  })
  .strict();

const IMPORTED_MEMORY_PREFIX = /^\s*(?:\[cowork:prompt_recall=ignore\]\s*)?\[Imported from /i;

/**
 * Imported memories are searched across every workspace today (see SEC-10), so a
 * workspace search can legitimately return them; detail reads allow them too.
 */
export function isMemoryVisibleInWorkspace(
  memory: { workspaceId?: string; content?: string },
  workspaceId: string,
): boolean {
  if (memory.workspaceId === workspaceId) return true;
  return typeof memory.content === "string" && IMPORTED_MEMORY_PREFIX.test(memory.content);
}

/**
 * Resolve a renderer-supplied kit path for `KIT_OPEN_FILE`.
 *
 * The path must be a Markdown file under `<workspace>/.cowork/` with no `.`/`..`
 * segments, must stay inside `.cowork` after symlinks are resolved, and must not touch
 * a protected location (`.cowork/policy/**`, `.git/**`, ...). Only the top-level kit
 * files named in `WORKSPACE_KIT_CONTRACTS` may be created when missing; anything else
 * must already exist. Markdown only, because the file is handed to `shell.openPath`,
 * which would launch an executable.
 */
export function resolveKitOpenPath(
  workspacePath: string,
  rawRelPath: string,
): { absPath: string; fileName: string; seedable: boolean } {
  const relPath = rawRelPath.replace(/\\/g, "/").trim();
  const segments = relPath.split("/");
  if (
    segments[0] !== ".cowork" ||
    segments.length < 2 ||
    relPath.includes("\0") ||
    segments.some((segment) => segment === "" || segment === "." || segment === "..")
  ) {
    throw new Error("Invalid relPath");
  }
  const fileName = segments[segments.length - 1];
  if (!/\.md$/i.test(fileName)) {
    throw new Error("Only Markdown kit files can be opened");
  }

  const coworkRoot = path.resolve(workspacePath, ".cowork");
  const absPath = path.resolve(workspacePath, ...segments);
  if (!isAccessPathWithin(workspacePath, absPath) || !isAccessPathWithin(coworkRoot, absPath)) {
    throw new Error("Invalid relPath");
  }
  if (
    isProtectedWorkspacePath(workspacePath, absPath) ||
    isProtectedWorkspacePath(workspacePath, canonicalizeAccessPath(absPath))
  ) {
    throw new Error("Kit path is protected");
  }

  const seedable =
    segments.length === 2 &&
    Object.prototype.hasOwnProperty.call(WORKSPACE_KIT_CONTRACTS, fileName);
  return { absPath, fileName, seedable };
}
