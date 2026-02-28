import { useCallback, useEffect, useState } from "react";
import type { Workspace } from "../../shared/types";

interface TaskMetrics {
  totalCreated: number;
  completed: number;
  failed: number;
  cancelled: number;
  avgCompletionTimeMs: number | null;
}

interface CostMetrics {
  totalCost: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  costByModel: Array<{ model: string; cost: number; calls: number }>;
}

interface ActivityPattern {
  tasksByDayOfWeek: number[];
  tasksByHour: number[];
  mostActiveDay: string;
  mostActiveHour: number;
}

interface AwuMetrics {
  awuCount: number;
  totalTokens: number;
  totalCost: number;
  tokensPerAwu: number | null;
  costPerAwu: number | null;
  awuPerDollar: number | null;
  trend: {
    previousAwuCount: number;
    previousTokensPerAwu: number | null;
    previousCostPerAwu: number | null;
    tokensPerAwuChange: number | null;
    costPerAwuChange: number | null;
  };
}

interface UsageInsightsData {
  periodStart: number;
  periodEnd: number;
  workspaceId: string | null;
  generatedAt: number;
  taskMetrics: TaskMetrics;
  costMetrics: CostMetrics;
  activityPattern: ActivityPattern;
  topSkills: Array<{ skill: string; count: number }>;
  awuMetrics: AwuMetrics;
  formatted: string;
}

interface UsageInsightsPanelProps {
  workspaceId?: string;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDuration(ms: number | null): string {
  if (ms === null) return "\u2014";
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  return `${hours}h ${mins % 60}m`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function MiniBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="insights-bar-track">
      <div className="insights-bar-fill" style={{ width: `${pct}%` }} />
    </div>
  );
}

interface PackSkillMap {
  packName: string;
  packIcon: string;
  skills: Array<{ skill: string; count: number }>;
  totalUsage: number;
}

const ALL_WORKSPACES = "__all__";

function isValidWorkspaceId(id: string | undefined): id is string {
  return !!id && (id === ALL_WORKSPACES || !id.startsWith("__temp_workspace__"));
}

export function UsageInsightsPanel({ workspaceId: initialWorkspaceId }: UsageInsightsPanelProps) {
  const [data, setData] = useState<UsageInsightsData | null>(null);
  const [periodDays, setPeriodDays] = useState(7);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [packAnalytics, setPackAnalytics] = useState<PackSkillMap[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>(ALL_WORKSPACES);
  const [workspacesLoading, setWorkspacesLoading] = useState(true);

  const workspaceId = selectedWorkspaceId;

  const loadWorkspaces = useCallback(async () => {
    try {
      setWorkspacesLoading(true);
      const loaded = await window.electronAPI.listWorkspaces();
      const nonTemp = loaded.filter((w) => !w.id.startsWith("__temp_workspace__"));
      setWorkspaces(nonTemp);
      // Keep current selection if valid; default to "All Workspaces"
      setSelectedWorkspaceId((prev) => {
        if (prev === ALL_WORKSPACES) return ALL_WORKSPACES;
        if (prev && nonTemp.some((w) => w.id === prev)) return prev;
        return ALL_WORKSPACES;
      });
    } catch {
      setWorkspaces([]);
    } finally {
      setWorkspacesLoading(false);
    }
  }, [initialWorkspaceId]);

  const load = useCallback(async () => {
    if (!isValidWorkspaceId(workspaceId)) return;
    setLoading(true);
    setError(null);
    try {
      const result = await window.electronAPI.getUsageInsights(workspaceId, periodDays);
      setData(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : "Failed to load usage insights");
    } finally {
      setLoading(false);
    }
  }, [workspaceId, periodDays]);

  useEffect(() => {
    void loadWorkspaces();
  }, [loadWorkspaces]);

  useEffect(() => {
    setData(null);
    setPackAnalytics([]);
  }, [workspaceId]);

  useEffect(() => {
    load();
  }, [load]);

  // Cross-reference skill usage with pack data
  useEffect(() => {
    if (!data || data.topSkills.length === 0) {
      setPackAnalytics([]);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const packs = await window.electronAPI.listPluginPacks();
        if (cancelled) return;

        // Build skill-to-pack mapping
        const skillToPack = new Map<string, { packName: string; packIcon: string }>();
        for (const p of packs) {
          for (const s of p.skills) {
            skillToPack.set(s.id, { packName: p.displayName, packIcon: p.icon || "\uD83D\uDCE6" });
            skillToPack.set(s.name, {
              packName: p.displayName,
              packIcon: p.icon || "\uD83D\uDCE6",
            });
          }
        }

        // Group skills by pack
        const packMap = new Map<string, PackSkillMap>();
        for (const s of data.topSkills) {
          const packInfo = skillToPack.get(s.skill);
          const key = packInfo?.packName || "Other";
          if (!packMap.has(key)) {
            packMap.set(key, {
              packName: key,
              packIcon: packInfo?.packIcon || "\u26A1",
              skills: [],
              totalUsage: 0,
            });
          }
          const entry = packMap.get(key)!;
          entry.skills.push(s);
          entry.totalUsage += s.count;
        }

        // Sort by total usage descending
        const sorted = Array.from(packMap.values()).sort((a, b) => b.totalUsage - a.totalUsage);
        setPackAnalytics(sorted);
      } catch {
        // Pack analytics not available
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [data]);

  if (workspacesLoading) {
    return (
      <div className="settings-panel">
        <h2>Usage Insights</h2>
        <p className="settings-description">Loading workspaces\u2026</p>
      </div>
    );
  }

  if (workspaces.length === 0) {
    return (
      <div className="settings-panel">
        <h2>Usage Insights</h2>
        <p className="settings-description">No workspaces found. Create a workspace first.</p>
      </div>
    );
  }

  if (!isValidWorkspaceId(workspaceId)) {
    return (
      <div className="settings-panel">
        <h2>Usage Insights</h2>
        <p className="settings-description">Select a workspace to view usage insights.</p>
      </div>
    );
  }

  if (loading && !data) {
    return (
      <div className="settings-panel">
        <h2>Usage Insights</h2>
        <p className="settings-description">Loading\u2026</p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="settings-panel">
        <h2>Usage Insights</h2>
        <p className="settings-description" style={{ color: "var(--color-error, #ef4444)" }}>
          {error}
        </p>
        <button type="button" className="button-secondary" onClick={load}>
          Retry
        </button>
      </div>
    );
  }

  const tm = data?.taskMetrics;
  const cm = data?.costMetrics;
  const ap = data?.activityPattern;
  const awu = data?.awuMetrics;
  const maxDayTasks = ap ? Math.max(...ap.tasksByDayOfWeek, 1) : 1;
  const maxHourTasks = ap ? Math.max(...ap.tasksByHour, 1) : 1;
  const successRate =
    tm && tm.totalCreated > 0 ? Math.round((tm.completed / tm.totalCreated) * 100) : 0;

  return (
    <div className="settings-panel">
      {/* Header with workspace and period inline */}
      <div className="insights-header">
        <div className="insights-header-left">
          <h2>Usage Insights</h2>
          <div className="insights-header-controls">
            <select
              value={selectedWorkspaceId}
              onChange={(e) => setSelectedWorkspaceId(e.target.value)}
              className="insights-workspace-select"
            >
              <option value={ALL_WORKSPACES}>All Workspaces</option>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </select>
            <div className="insights-period-filter">
              {[7, 14, 30].map((d) => (
                <button
                  key={d}
                  type="button"
                  className={`insights-period-btn${periodDays === d ? " active" : ""}`}
                  onClick={() => setPeriodDays(d)}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>

      {/* Hero stats row */}
      {tm && (
        <div className="insights-hero">
          <div className="insights-hero-card">
            <div className="insights-hero-value">{tm.completed}</div>
            <div className="insights-hero-label">Completed</div>
            <div className="insights-hero-sub">of {tm.totalCreated} created</div>
          </div>
          <div className="insights-hero-card">
            <div
              className="insights-hero-value"
              style={{
                color:
                  successRate >= 70
                    ? "var(--color-success, #22c55e)"
                    : successRate >= 40
                      ? "var(--color-warning, #f59e0b)"
                      : "var(--color-error, #ef4444)",
              }}
            >
              {successRate}%
            </div>
            <div className="insights-hero-label">Success Rate</div>
            <div className="insights-hero-rate-bar">
              <div
                className="insights-hero-rate-fill"
                style={{
                  width: `${successRate}%`,
                  background:
                    successRate >= 70
                      ? "var(--color-success, #22c55e)"
                      : successRate >= 40
                        ? "var(--color-warning, #f59e0b)"
                        : "var(--color-error, #ef4444)",
                }}
              />
            </div>
          </div>
          <div className="insights-hero-card">
            <div className="insights-hero-value">{tm.failed}</div>
            <div className="insights-hero-label">Failed</div>
            <div className="insights-hero-sub">
              {tm.cancelled > 0 ? `${tm.cancelled} cancelled` : "\u00A0"}
            </div>
          </div>
          <div className="insights-hero-card">
            <div className="insights-hero-value">{formatDuration(tm.avgCompletionTimeMs)}</div>
            <div className="insights-hero-label">Avg Time</div>
            <div className="insights-hero-sub">per task</div>
          </div>
        </div>
      )}

      {/* Cost + AWU row */}
      {((cm && cm.totalCost > 0) || (awu && awu.awuCount > 0)) && (
        <div className="insights-two-col">
          {cm && cm.totalCost > 0 && (
            <div className="insights-card">
              <div className="insights-card-header">Cost & Tokens</div>
              <div className="insights-cost-hero">
                <span className="insights-cost-amount">${cm.totalCost.toFixed(2)}</span>
                <span className="insights-cost-tokens">
                  {formatTokens(cm.totalInputTokens + cm.totalOutputTokens)} tokens
                </span>
              </div>
              <div className="insights-cost-split">
                <div className="insights-cost-split-item">
                  <span className="insights-cost-split-label">Input</span>
                  <span className="insights-cost-split-value">
                    {formatTokens(cm.totalInputTokens)}
                  </span>
                </div>
                <div className="insights-cost-split-item">
                  <span className="insights-cost-split-label">Output</span>
                  <span className="insights-cost-split-value">
                    {formatTokens(cm.totalOutputTokens)}
                  </span>
                </div>
              </div>
              {cm.costByModel.length > 0 && (
                <div className="insights-model-list">
                  {cm.costByModel.slice(0, 4).map((m) => (
                    <div key={m.model} className="insights-model-row">
                      <span className="insights-model-name">{m.model}</span>
                      <MiniBar value={m.cost} max={cm.costByModel[0].cost} />
                      <span className="insights-model-cost">${m.cost.toFixed(4)}</span>
                      <span className="insights-model-calls">{m.calls}\u00D7</span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {awu && awu.awuCount > 0 && (
            <div className="insights-card">
              <div className="insights-card-header">Agent Efficiency (AWU)</div>
              <div className="insights-awu-hero">
                <span className="insights-awu-count">{awu.awuCount}</span>
                <span className="insights-awu-label">work units</span>
              </div>
              <div className="insights-awu-grid">
                <div className="insights-awu-metric">
                  <div className="insights-awu-metric-value">
                    {awu.tokensPerAwu !== null ? formatTokens(awu.tokensPerAwu) : "\u2014"}
                  </div>
                  <div className="insights-awu-metric-label">Tokens / AWU</div>
                  <TrendIndicator change={awu.trend.tokensPerAwuChange} invertColor />
                </div>
                <div className="insights-awu-metric">
                  <div className="insights-awu-metric-value">
                    {awu.costPerAwu !== null ? `$${awu.costPerAwu.toFixed(4)}` : "\u2014"}
                  </div>
                  <div className="insights-awu-metric-label">Cost / AWU</div>
                  <TrendIndicator change={awu.trend.costPerAwuChange} invertColor />
                </div>
                <div className="insights-awu-metric">
                  <div
                    className="insights-awu-metric-value"
                    style={{ color: "var(--color-success, #22c55e)" }}
                  >
                    {awu.awuPerDollar !== null ? awu.awuPerDollar.toFixed(1) : "\u2014"}
                  </div>
                  <div className="insights-awu-metric-label">AWUs / $1</div>
                </div>
              </div>
              {awu.trend.previousAwuCount > 0 && (
                <div className="insights-awu-comparison">
                  vs prev {periodDays}d: {awu.trend.previousAwuCount} AWU
                  {awu.trend.previousTokensPerAwu !== null && (
                    <> at {formatTokens(awu.trend.previousTokensPerAwu)} tok/AWU</>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* Activity charts side by side */}
      {ap && (
        <div className="insights-two-col">
          <div className="insights-card">
            <div className="insights-card-header">
              Activity by Day
              <span className="insights-card-header-sub">Peak: {ap.mostActiveDay}</span>
            </div>
            <div className="insights-day-chart">
              {DAY_NAMES.map((day, i) => (
                <div key={day} className="insights-bar-row">
                  <span className="insights-bar-label">{day}</span>
                  <MiniBar value={ap.tasksByDayOfWeek[i]} max={maxDayTasks} />
                  <span className="insights-bar-value">{ap.tasksByDayOfWeek[i]}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="insights-card">
            <div className="insights-card-header">
              Activity by Hour
              <span className="insights-card-header-sub">Peak: {ap.mostActiveHour}:00</span>
            </div>
            <div className="insights-hour-chart">
              {ap.tasksByHour.map((count, h) => (
                <div
                  key={h}
                  className={`insights-hour-bar ${count > 0 ? "has-data" : "no-data"}`}
                  title={`${h}:00 \u2014 ${count} task${count !== 1 ? "s" : ""}`}
                  style={{
                    height: `${maxHourTasks > 0 ? Math.max((count / maxHourTasks) * 100, count > 0 ? 10 : 3) : 3}%`,
                  }}
                />
              ))}
            </div>
            <div className="insights-hour-labels">
              <span>12am</span>
              <span>6am</span>
              <span>12pm</span>
              <span>6pm</span>
              <span>12am</span>
            </div>
          </div>
        </div>
      )}

      {/* Skills section */}
      {data && data.topSkills.length > 0 && (
        <div className={packAnalytics.length > 0 ? "insights-two-col" : ""}>
          <div className="insights-card">
            <div className="insights-card-header">Top Skills</div>
            <div>
              {data.topSkills.slice(0, 5).map((s) => (
                <div key={s.skill} className="insights-bar-row">
                  <span className="insights-bar-label" style={{ minWidth: 120 }}>
                    {s.skill}
                  </span>
                  <MiniBar value={s.count} max={data.topSkills[0].count} />
                  <span className="insights-bar-value" style={{ minWidth: 30 }}>
                    {s.count}\u00D7
                  </span>
                </div>
              ))}
            </div>
          </div>

          {packAnalytics.length > 0 && (
            <div className="insights-card">
              <div className="insights-card-header">By Pack</div>
              <div>
                {packAnalytics.map((pa) => (
                  <div key={pa.packName} style={{ marginBottom: 10 }}>
                    <div className="insights-bar-row" style={{ fontWeight: 500 }}>
                      <span className="insights-bar-label" style={{ minWidth: 120 }}>
                        {pa.packIcon} {pa.packName}
                      </span>
                      <MiniBar value={pa.totalUsage} max={packAnalytics[0].totalUsage} />
                      <span className="insights-bar-value" style={{ minWidth: 30 }}>
                        {pa.totalUsage}\u00D7
                      </span>
                    </div>
                    {pa.skills.length > 1 &&
                      pa.skills.slice(0, 3).map((s) => (
                        <div
                          key={s.skill}
                          className="insights-bar-row"
                          style={{ paddingLeft: 16, opacity: 0.7 }}
                        >
                          <span
                            className="insights-bar-label"
                            style={{ minWidth: 104, fontSize: 12 }}
                          >
                            {s.skill}
                          </span>
                          <MiniBar value={s.count} max={pa.skills[0].count} />
                          <span
                            className="insights-bar-value"
                            style={{ minWidth: 30, fontSize: 12 }}
                          >
                            {s.count}\u00D7
                          </span>
                        </div>
                      ))}
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function TrendIndicator({ change, invertColor }: { change: number | null; invertColor?: boolean }) {
  if (change === null) return null;
  const abs = Math.abs(change);
  if (abs < 0.5) return <span className="insights-trend neutral">\u2014</span>;
  // For per-AWU metrics, negative change = improvement (invertColor=true)
  const isGood = invertColor ? change < 0 : change > 0;
  const arrow = change < 0 ? "\u2193" : "\u2191";
  const colorClass = isGood ? "good" : "bad";
  return (
    <span className={`insights-trend ${colorClass}`}>
      {arrow} {abs.toFixed(0)}%
    </span>
  );
}
