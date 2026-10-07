import { z } from "zod";
import {
  MEMORY_REPO_KEEP_TARGETS,
  MEMORY_REPO_READ_LINES_MAX,
} from "../../shared/memory-repo-types";
import {
  MEMORY_REPO_LIMITS,
  isSafeRepoPath,
  parseMemoryRepoRef,
} from "../memory/repo/memory-repo-format";
import { WorkspaceIdSchema } from "../utils/validation";

/**
 * Schemas for the memory folder IPC (memoryRepo:*). Payloads come from the renderer, which
 * is untrusted. `memoryRepo:readLines` takes entry refs (`repo:<path>#L<n>`), each a safe
 * root-relative markdown path; the dream channels take a dream id (and a diff part). The
 * folder itself is never named by the renderer; main resolves it from the settings.
 */
export const MemoryRepoRefSchema = z
  .string()
  .max(600)
  .refine((ref) => parseMemoryRepoRef(ref) !== null, { message: "Invalid memory ref" });

export const MemoryRepoRefsSchema = z
  .array(MemoryRepoRefSchema)
  .min(1)
  .max(MEMORY_REPO_READ_LINES_MAX);

export const MemoryRepoReadLinesRequestSchema = z.object({ refs: MemoryRepoRefsSchema }).strict();

/** The other channels take no payload. */
export const MemoryRepoNoArgsSchema = z.undefined();

/** A dream id (`.git/cowork-dreams/<id>.json`), as MemoryRepoService accepts it. */
export const MemoryRepoDreamIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}$/, {
  message: "Invalid dream id",
});

export const MemoryRepoDreamPartSchema = z.enum(["review", "auto"]);

/** `memoryRepo:acceptDream`, `memoryRepo:rejectDream`, `memoryRepo:undoDream`. */
export const MemoryRepoDreamRequestSchema = z.object({ id: MemoryRepoDreamIdSchema }).strict();

/** `memoryRepo:dreamDiff`. */
export const MemoryRepoDreamDiffRequestSchema = z
  .object({ id: MemoryRepoDreamIdSchema, part: MemoryRepoDreamPartSchema })
  .strict();

// ---------------------------------------------------------------------------
// Memory Hub "What CoWork knows" over the folder (docs/memory-repo-phase3-design.md §5)
// ---------------------------------------------------------------------------

/** The hash of an entry's text as `memoryRepo:entries` reported it (sha256 hex). */
export const MemoryRepoEntryHashSchema = z.string().regex(/^[a-f0-9]{64}$/, {
  message: "Invalid memory hash",
});

/** `memoryRepo:entries`: the workspace the Hub shows. */
export const MemoryRepoEntriesRequestSchema = z.object({ workspaceId: WorkspaceIdSchema }).strict();

/** `memoryRepo:removeEntry`, `memoryRepo:pinEntry`. */
export const MemoryRepoEntryRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    ref: MemoryRepoRefSchema,
    hash: MemoryRepoEntryHashSchema,
  })
  .strict();

/** `memoryRepo:updateEntry`: the new text (screened again in main). */
export const MemoryRepoUpdateEntryRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    ref: MemoryRepoRefSchema,
    hash: MemoryRepoEntryHashSchema,
    text: z
      .string()
      .trim()
      .min(1)
      .max(MEMORY_REPO_LIMITS.entryChars * 2),
  })
  .strict();

/** `memoryRepo:openFile`: a repo-relative markdown path; main resolves it under the root. */
export const MemoryRepoOpenFileRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    path: z
      .string()
      .max(500)
      .refine((value) => !value.includes("\\") && isSafeRepoPath(value), {
        message: "Invalid memory file",
      }),
  })
  .strict();

/** `memoryRepo:keepEntry`: move an inbox entry to `me.md`, `lessons.md` or the workspace's file. */
export const MemoryRepoKeepEntryRequestSchema = z
  .object({
    workspaceId: WorkspaceIdSchema,
    ref: MemoryRepoRefSchema,
    hash: MemoryRepoEntryHashSchema,
    target: z.enum(MEMORY_REPO_KEEP_TARGETS),
  })
  .strict();
