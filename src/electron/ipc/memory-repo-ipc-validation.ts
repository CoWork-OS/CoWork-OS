import { z } from "zod";
import { MEMORY_REPO_READ_LINES_MAX } from "../../shared/memory-repo-types";
import { parseMemoryRepoRef } from "../memory/repo/memory-repo-format";

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
