import { z } from "zod";

const id = z.string().trim().min(1).max(128);
export const botOutcomeMetricsRequestSchema = z
  .object({
    workspaceId: id,
    agentRoleId: id.optional(),
    windowDays: z.number().int().min(1).max(90).default(7),
  })
  .strict();
export type BotOutcomeMetricsRequest = z.input<typeof botOutcomeMetricsRequestSchema>;

/**
 * Baseline counters for the bot rollout. They describe recorded state only; no
 * numeric targets are implied. Bot-scoped sections follow the same visible task
 * lineage as the work view; dispatch, budget, trigger and idle-model sections are
 * workspace-wide because those producers are not owned by a single bot.
 */
export interface BotOutcomeMetrics {
  scope: { workspaceId: string; agentRoleId: string | null };
  window: { since: number; until: number; days: number };
  outcomes: { completed: number; verified: number; failed: number; cancelled: number };
  unresolvedWaits: { approvals: number; inputRequests: number; oldestRequestedAt: number | null };
  effects: { committed: number; uncertain: number };
  recovery: { interruptedTasks: number; uncertainTriggerOutcomes: number };
  delivery: { storedInInbox: number; unknown: number; cancelled: number };
  dispatch: {
    reservations: number;
    committed: number;
    refunded: number;
    duplicateAdmissions: number;
    denials: Record<string, number>;
  };
  modelUsage: {
    taskCalls: number;
    taskTokens: number;
    unattachedCalls: number;
    unattachedTokens: number;
  };
  workView: { samples: number; medianMs: number | null; p95Ms: number | null };
}
