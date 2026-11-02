/**
 * Speculative run IPC: a read-only query the UI uses to list recent speculative
 * reproduce-and-fix runs and their outcomes.
 */
import { ipcMain } from "electron";
import { z } from "zod";
import { IPC_CHANNELS, type SpeculativeRun } from "../../shared/types";
import { validateInput, WorkspaceIdSchema } from "../utils/validation";
import { rateLimiter, RATE_LIMIT_CONFIGS } from "../utils/rate-limiter";
import type { SpeculativeFixService } from "../triggers/SpeculativeFixService";

export const SpeculativeRunListQuerySchema = z
  .object({
    workspaceId: WorkspaceIdSchema.optional(),
    limit: z.number().int().min(1).max(100).optional(),
  })
  .strict();

/** The renderer's query, validated: it arrives from a web context. */
export function parseSpeculativeRunListQuery(
  raw: unknown,
): z.infer<typeof SpeculativeRunListQuerySchema> {
  return validateInput(SpeculativeRunListQuerySchema, raw ?? {}, "speculative run query");
}

export function setupSpeculativeRunHandlers(getService: () => SpeculativeFixService | null): void {
  rateLimiter.configure(IPC_CHANNELS.SPECULATIVE_RUNS_LIST, RATE_LIMIT_CONFIGS.standard);
  ipcMain.handle(
    IPC_CHANNELS.SPECULATIVE_RUNS_LIST,
    async (_, raw: unknown): Promise<SpeculativeRun[]> => {
      if (!rateLimiter.check(IPC_CHANNELS.SPECULATIVE_RUNS_LIST)) {
        const resetSec = Math.ceil(
          rateLimiter.getResetTime(IPC_CHANNELS.SPECULATIVE_RUNS_LIST) / 1000,
        );
        throw new Error(`Rate limit exceeded. Try again in ${resetSec} seconds.`);
      }
      const query = parseSpeculativeRunListQuery(raw);
      return getService()?.listRuns(query) ?? [];
    },
  );
}
