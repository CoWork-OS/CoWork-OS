import { useEffect, useState } from "react";
import type { BotOutcomeMetrics } from "../../shared/bot-outcome-metrics";

export interface BotUsageSummary {
  days: number;
  calls: number;
  /** Input plus output tokens; shown when no cost was recorded for them. */
  tokens: number;
  cost: number;
  /** Share of input tokens read from the prompt cache (0..1), or null with no input. */
  cacheReuse: number | null;
}

/** The usage line's numbers from a metrics summary. */
export function summarizeBotUsage(metrics: BotOutcomeMetrics): BotUsageSummary {
  const usage = metrics.modelUsage;
  const input = Number(usage.taskInputTokens ?? 0);
  const cached = Number(usage.taskCachedTokens ?? 0);
  return {
    days: metrics.window.days,
    calls: Number(usage.taskCalls ?? 0),
    tokens: input + Number(usage.taskOutputTokens ?? 0),
    cost: Number(usage.taskCost ?? 0),
    cacheReuse: input > 0 ? Math.min(1, Math.max(0, cached / input)) : null,
  };
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M tokens`;
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k tokens`;
  return `${tokens} tokens`;
}

/**
 * "$0.42 · 18 calls · 72% from cache", or null when the bot made no calls. A zero cost with
 * tokens means no price was recorded (a subscription, or a model with no pricing entry),
 * so the tokens are shown rather than a claim that the calls were free.
 */
export function formatBotUsage(summary: BotUsageSummary): string | null {
  if (summary.calls === 0) return null;
  const parts = [
    summary.cost > 0
      ? `$${summary.cost < 0.01 ? summary.cost.toFixed(4) : summary.cost.toFixed(2)}`
      : summary.tokens > 0
        ? `${formatTokens(summary.tokens)}, no cost recorded`
        : "No billed cost",
    `${summary.calls} ${summary.calls === 1 ? "call" : "calls"}`,
  ];
  if (summary.cacheReuse !== null) {
    parts.push(`${Math.round(summary.cacheReuse * 100)}% from cache`);
  }
  return parts.join(" · ");
}

/** A bot's model usage in a workspace over the last `windowDays`, for its details panel. */
export function useBotUsage(
  workspaceId: string | undefined,
  botId: string | undefined,
  refreshKey?: unknown,
  windowDays = 7,
): BotUsageSummary | null {
  const [summary, setSummary] = useState<BotUsageSummary | null>(null);
  useEffect(() => {
    const api = window.electronAPI;
    if (!workspaceId || !botId || !api?.getBotMetricsSummary) {
      setSummary(null);
      return;
    }
    let cancelled = false;
    api
      .getBotMetricsSummary({ workspaceId, agentRoleId: botId, windowDays })
      .then((metrics) => {
        if (!cancelled) setSummary(metrics ? summarizeBotUsage(metrics) : null);
      })
      .catch(() => {
        if (!cancelled) setSummary(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId, botId, refreshKey, windowDays]);
  return summary;
}
