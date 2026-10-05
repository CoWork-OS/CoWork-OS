import { z } from "zod";
import type { EverydayAgentClearDataRequest } from "../../shared/types";

/**
 * A clear-data request from the renderer or a remote client: known flags only, and a
 * workspace id (a UUID) for the memory candidates to clear. Anything else is refused rather
 * than treated as "clear all".
 */
export const EverydayAgentClearDataRequestSchema = z
  .object({
    profile: z.boolean().optional(),
    receipts: z.boolean().optional(),
    previews: z.boolean().optional(),
    trustPatterns: z.boolean().optional(),
    consentHistory: z.boolean().optional(),
    pauseScopes: z.boolean().optional(),
    memoryCandidates: z.boolean().optional(),
    routineProvenance: z.boolean().optional(),
    cachedConnectorSummaries: z.boolean().optional(),
    browserProfileMetadata: z.boolean().optional(),
    workspaceId: z
      .string()
      .regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i)
      .optional(),
  })
  .strict();

/** Validate a clear-data request; `undefined`/`null` stays "clear everything". */
export function parseEverydayAgentClearDataRequest(
  request: unknown,
): EverydayAgentClearDataRequest | undefined {
  if (request === undefined || request === null) return undefined;
  return EverydayAgentClearDataRequestSchema.parse(request);
}
