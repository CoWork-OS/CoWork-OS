import { z } from "zod";
import { WorkspaceIdSchema } from "../utils/validation";

/**
 * Schemas for the Memory Hub "Review" IPC (memoryReview:*). Payloads come from the
 * renderer, which is untrusted: every request names the workspace the Hub is showing,
 * ids are bounded, and unknown fields are refused.
 */

const ReviewIdSchema = z.string().trim().min(1).max(100);

export const MemoryReviewWorkspaceRequestSchema = z
  .object({ workspaceId: WorkspaceIdSchema })
  .strict();

export const MemoryReviewProposalRequestSchema = z
  .object({ workspaceId: WorkspaceIdSchema, id: ReviewIdSchema })
  .strict();

export const MemoryReviewUndoRequestSchema = z
  .object({ workspaceId: WorkspaceIdSchema, id: ReviewIdSchema })
  .strict();

export const MemoryReviewSetLlmRequestSchema = z
  .object({ workspaceId: WorkspaceIdSchema, enabled: z.boolean() })
  .strict();
