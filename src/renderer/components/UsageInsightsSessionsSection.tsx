import {
  USAGE_SESSION_CATEGORY_HINTS,
  USAGE_SESSION_CATEGORY_LABELS,
  type UsageSessionBreakdown,
} from "../../shared/usageSessionBreakdown";
import { formatUsageCost, formatUsageTokens } from "./usageInsightsFormatting";

interface UsageInsightsSessionsSectionProps {
  sessionUsage: UsageSessionBreakdown | undefined;
  onOpenTask?: (taskId: string) => void;
}

function sharePercent(value: number, total: number): string {
  if (total <= 0) return "0%";
  const pct = (value / total) * 100;
  if (pct > 0 && pct < 1) return "<1%";
  return `${Math.round(pct)}%`;
}

/**
 * Usage by kind of work (your sessions, sub-agents, automations, bots, API and hooks,
 * background work) and the top-level sessions that used the most, sub-agents included.
 * Shares are by cost, or by tokens when nothing in the period had a price.
 */
export function UsageInsightsSessionsSection({
  sessionUsage,
  onOpenTask,
}: UsageInsightsSessionsSectionProps) {
  const categories = sessionUsage?.byCategory ?? [];
  const topSessions = sessionUsage?.topSessions ?? [];
  if (categories.length === 0) return null;

  const byCost = categories.some((row) => row.cost > 0);
  const valueOf = (row: { cost: number; tokens: number }) => (byCost ? row.cost : row.tokens);
  const formatValue = (row: { cost: number; tokens: number }) =>
    byCost ? formatUsageCost(row.cost) : `${formatUsageTokens(row.tokens)} tokens`;
  const total = categories.reduce((sum, row) => sum + valueOf(row), 0);
  const largest = Math.max(...categories.map(valueOf), 0);

  return (
    <div className={`insights-two-col${topSessions.length > 0 ? "" : " single"}`}>
      <div className="insights-card" aria-label="Usage by kind of work">
        <div className="insights-card-header">
          Where usage went
          <span className="insights-card-header-sub">by {byCost ? "cost" : "tokens"}</span>
        </div>
        <div className="insights-model-list">
          {categories.map((row) => {
            const value = valueOf(row);
            const width = largest > 0 ? Math.round((value / largest) * 100) : 0;
            return (
              <div
                key={row.category}
                className="insights-share-row"
                title={USAGE_SESSION_CATEGORY_HINTS[row.category]}
              >
                <span className="insights-share-label">
                  {USAGE_SESSION_CATEGORY_LABELS[row.category]}
                </span>
                <div className="insights-bar-track">
                  <div className="insights-bar-fill" style={{ width: `${width}%` }} />
                </div>
                <span className="insights-share-value">{formatValue(row)}</span>
                <span className="insights-share-pct">{sharePercent(value, total)}</span>
              </div>
            );
          })}
        </div>
      </div>

      {topSessions.length > 0 && (
        <div className="insights-card" aria-label="Sessions that used the most">
          <div className="insights-card-header">
            Top sessions
            <span className="insights-card-header-sub">sub-agents included</span>
          </div>
          <ol className="insights-top-sessions">
            {topSessions.map((session) => {
              const meta = [
                USAGE_SESSION_CATEGORY_LABELS[session.category],
                byCost ? `${formatUsageTokens(session.tokens)} tokens` : null,
                session.subagentCount > 0
                  ? `${session.subagentCount} sub-agent${session.subagentCount === 1 ? "" : "s"}`
                  : null,
              ]
                .filter(Boolean)
                .join(" · ");
              const content = (
                <>
                  <span className="insights-top-session-text">
                    <span className="insights-top-session-title">{session.title}</span>
                    <span className="insights-top-session-meta">{meta}</span>
                  </span>
                  <span className="insights-top-session-value">{formatValue(session)}</span>
                </>
              );
              return (
                <li key={session.taskId}>
                  {onOpenTask ? (
                    <button
                      type="button"
                      className="insights-top-session"
                      title={`Open "${session.title}"`}
                      onClick={() => onOpenTask(session.taskId)}
                    >
                      {content}
                    </button>
                  ) : (
                    <div className="insights-top-session">{content}</div>
                  )}
                </li>
              );
            })}
          </ol>
        </div>
      )}
    </div>
  );
}
