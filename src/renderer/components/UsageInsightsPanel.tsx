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

interface UsageInsightsData {
  periodStart: number;
  periodEnd: number;
  workspaceId: string;
  generatedAt: number;
  taskMetrics: TaskMetrics;
  costMetrics: CostMetrics;
  activityPattern: ActivityPattern;
  topSkills: Array<{ skill: string; count: number }>;
  formatted: string;
}

interface UsageInsightsPanelProps {
  workspaceId?: string;
}

const DAY_NAMES = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function formatDuration(ms: number | null): string {
  if (ms === null) return "—";
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

function isValidWorkspaceId(id: string | undefined): id is string {
  return !!id && !id.startsWith("__temp_workspace__");
}

export function UsageInsightsPanel({ workspaceId: initialWorkspaceId }: UsageInsightsPanelProps) {
  const [data, setData] = useState<UsageInsightsData | null>(null);
  const [periodDays, setPeriodDays] = useState(7);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [packAnalytics, setPackAnalytics] = useState<PackSkillMap[]>([]);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState<string>("");
  const [workspacesLoading, setWorkspacesLoading] = useState(true);

  const workspaceId = selectedWorkspaceId;

  const loadWorkspaces = useCallback(async () => {
    try {
      setWorkspacesLoading(true);
      const loaded = await window.electronAPI.listWorkspaces();
      const nonTemp = loaded.filter((w) => !w.id.startsWith("__temp_workspace__"));
      setWorkspaces(nonTemp);
      setSelectedWorkspaceId((prev) => {
        if (prev && nonTemp.some((w) => w.id === prev)) return prev;
        if (
          isValidWorkspaceId(initialWorkspaceId) &&
          nonTemp.some((w) => w.id === initialWorkspaceId)
        ) {
          return initialWorkspaceId;
        }
        return nonTemp[0]?.id || "";
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
            skillToPack.set(s.id, { packName: p.displayName, packIcon: p.icon || "📦" });
            skillToPack.set(s.name, { packName: p.displayName, packIcon: p.icon || "📦" });
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
              packIcon: packInfo?.packIcon || "⚡",
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
        <p className="settings-description">Loading workspaces…</p>
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
        <p className="settings-description">Loading…</p>
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
  const maxDayTasks = ap ? Math.max(...ap.tasksByDayOfWeek, 1) : 1;
  const maxHourTasks = ap ? Math.max(...ap.tasksByHour, 1) : 1;

  return (
    <div className="settings-panel">
      <div className="insights-header">
        <div>
          <h2>Usage Insights</h2>
          <p className="settings-description">Task activity, cost, and productivity patterns</p>
        </div>
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

      <div className="settings-form-group" style={{ marginBottom: 16, maxWidth: 260 }}>
        <label className="settings-label">Workspace</label>
        <select
          value={selectedWorkspaceId}
          onChange={(e) => setSelectedWorkspaceId(e.target.value)}
          className="settings-select"
        >
          {workspaces.map((w) => (
            <option key={w.id} value={w.id}>
              {w.name}
            </option>
          ))}
        </select>
      </div>
      {/* Task metrics */}
      {tm && (
        <div className="settings-section">
          <h3>Tasks</h3>
          <div className="insights-stat-grid cols-4">
            <StatCard label="Created" value={tm.totalCreated} />
            <StatCard
              label="Completed"
              value={tm.completed}
              color="var(--color-success, #22c55e)"
            />
            <StatCard label="Failed" value={tm.failed} color="var(--color-error, #ef4444)" />
            <StatCard label="Avg Time" value={formatDuration(tm.avgCompletionTimeMs)} />
          </div>
        </div>
      )}

      {/* Cost metrics */}
      {cm && cm.totalCost > 0 && (
        <div className="settings-section">
          <h3>Cost & Tokens</h3>
          <div className="insights-stat-grid cols-3" style={{ marginBottom: 10 }}>
            <StatCard label="Total Cost" value={`$${cm.totalCost.toFixed(4)}`} />
            <StatCard label="Input" value={formatTokens(cm.totalInputTokens)} />
            <StatCard label="Output" value={formatTokens(cm.totalOutputTokens)} />
          </div>
          {cm.costByModel.length > 0 && (
            <div>
              {cm.costByModel.slice(0, 5).map((m) => (
                <div key={m.model} className="insights-model-row">
                  <span className="insights-model-name">{m.model}</span>
                  <MiniBar value={m.cost} max={cm.costByModel[0].cost} />
                  <span className="insights-model-cost">${m.cost.toFixed(4)}</span>
                  <span className="insights-model-calls">{m.calls}×</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Activity by day of week */}
      {ap && (
        <div className="settings-section">
          <h3>
            Activity by Day
            <span className="insights-section-subtitle">Peak: {ap.mostActiveDay}</span>
          </h3>
          <div>
            {DAY_NAMES.map((day, i) => (
              <div key={day} className="insights-bar-row">
                <span className="insights-bar-label">{day}</span>
                <MiniBar value={ap.tasksByDayOfWeek[i]} max={maxDayTasks} />
                <span className="insights-bar-value">{ap.tasksByDayOfWeek[i]}</span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Activity by hour */}
      {ap && (
        <div className="settings-section">
          <h3>
            Activity by Hour
            <span className="insights-section-subtitle">Peak: {ap.mostActiveHour}:00</span>
          </h3>
          <div className="insights-hour-chart">
            {ap.tasksByHour.map((count, h) => (
              <div
                key={h}
                className={`insights-hour-bar ${count > 0 ? "has-data" : "no-data"}`}
                title={`${h}:00 — ${count} tasks`}
                style={{
                  height: `${maxHourTasks > 0 ? Math.max((count / maxHourTasks) * 100, count > 0 ? 8 : 2) : 2}%`,
                }}
              />
            ))}
          </div>
          <div className="insights-hour-labels">
            <span>0h</span>
            <span>6h</span>
            <span>12h</span>
            <span>18h</span>
            <span>24h</span>
          </div>
        </div>
      )}

      {/* Top skills */}
      {data && data.topSkills.length > 0 && (
        <div className="settings-section">
          <h3>Top Skills</h3>
          <div>
            {data.topSkills.slice(0, 5).map((s) => (
              <div key={s.skill} className="insights-bar-row">
                <span className="insights-bar-label" style={{ minWidth: 120 }}>
                  {s.skill}
                </span>
                <MiniBar value={s.count} max={data.topSkills[0].count} />
                <span className="insights-bar-value" style={{ minWidth: 30 }}>
                  {s.count}×
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Skill usage by pack */}
      {packAnalytics.length > 0 && (
        <div className="settings-section">
          <h3>Skill Usage by Pack</h3>
          <div>
            {packAnalytics.map((pa) => (
              <div key={pa.packName} style={{ marginBottom: 12 }}>
                <div className="insights-bar-row" style={{ fontWeight: 500 }}>
                  <span className="insights-bar-label" style={{ minWidth: 120 }}>
                    {pa.packIcon} {pa.packName}
                  </span>
                  <MiniBar value={pa.totalUsage} max={packAnalytics[0].totalUsage} />
                  <span className="insights-bar-value" style={{ minWidth: 30 }}>
                    {pa.totalUsage}×
                  </span>
                </div>
                {pa.skills.length > 1 &&
                  pa.skills.slice(0, 3).map((s) => (
                    <div
                      key={s.skill}
                      className="insights-bar-row"
                      style={{ paddingLeft: 16, opacity: 0.7 }}
                    >
                      <span className="insights-bar-label" style={{ minWidth: 104, fontSize: 12 }}>
                        {s.skill}
                      </span>
                      <MiniBar value={s.count} max={pa.skills[0].count} />
                      <span className="insights-bar-value" style={{ minWidth: 30, fontSize: 12 }}>
                        {s.count}×
                      </span>
                    </div>
                  ))}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function StatCard({
  label,
  value,
  color,
}: {
  label: string;
  value: string | number;
  color?: string;
}) {
  return (
    <div className="insights-stat-card">
      <div className="insights-stat-label">{label}</div>
      <div className="insights-stat-value" style={color ? { color } : undefined}>
        {value}
      </div>
    </div>
  );
}
