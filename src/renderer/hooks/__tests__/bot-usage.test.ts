import { describe, expect, it } from "vitest";
import { formatBotUsage, summarizeBotUsage } from "../useBotUsage";
import type { BotOutcomeMetrics } from "../../../shared/bot-outcome-metrics";

const metrics = (usage: Partial<BotOutcomeMetrics["modelUsage"]>): BotOutcomeMetrics =>
  ({
    window: { since: 0, until: 1, days: 7 },
    modelUsage: {
      taskCalls: 0,
      taskTokens: 0,
      taskInputTokens: 0,
      taskOutputTokens: 0,
      taskCachedTokens: 0,
      taskCost: 0,
      unattachedCalls: 0,
      unattachedTokens: 0,
      ...usage,
    },
  }) as BotOutcomeMetrics;

describe("bot usage line", () => {
  it("shows cost, calls and the share of input read from cache", () => {
    const summary = summarizeBotUsage(
      metrics({ taskCalls: 18, taskInputTokens: 1000, taskCachedTokens: 720, taskCost: 0.4249 }),
    );
    expect(summary).toEqual({ days: 7, calls: 18, cost: 0.4249, cacheReuse: 0.72 });
    expect(formatBotUsage(summary)).toBe("$0.42 · 18 calls · 72% from cache");
  });

  it("handles tiny costs, subscriptions, no input and no calls", () => {
    expect(
      formatBotUsage(
        summarizeBotUsage(metrics({ taskCalls: 1, taskInputTokens: 10, taskCost: 0.0031 })),
      ),
    ).toBe("$0.0031 · 1 call · 0% from cache");
    expect(formatBotUsage(summarizeBotUsage(metrics({ taskCalls: 3 })))).toBe(
      "No billed cost · 3 calls",
    );
    expect(formatBotUsage(summarizeBotUsage(metrics({})))).toBeNull();
  });
});
