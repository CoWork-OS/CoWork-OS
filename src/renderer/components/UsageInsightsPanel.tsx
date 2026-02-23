import { useCallback, useEffect, useState } from "react";

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

/** Simple horizontal bar (percentage of max) */
function MiniBar({ value, max, color }: { value: number; max: number; color?: string }) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div
      style={{
        height: 6,
        borderRadius: 3,
        background: "var(--bg-tertiary, #333)",
        overflow: "hidden",
        flex: 1,
      }}
    >
      <div
        style={{
          width: `${pct}%`,
          height: "100%",
          borderRadius: 3,
          background: color || "var(--accent, #6366f1)",
          transition: "width 0.3s ease",
        }}
      />
    </div>
  );
}

export function UsageInsightsPanel({ workspaceId }: UsageInsightsPanelProps) {
  const [data, setData] = useState<UsageInsightsData | null>(null);
  const [periodDays, setPeriodDays] = useState(7);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!workspaceId) return;
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
    load();
  }, [load]);

  if (!workspaceId) {
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
        <p className="settings-description" style={{ color: "var(--error, #ef4444)" }}>
          {error}
        </p>
        <button type="button" className="settings-btn" onClick={load}>
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
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 16,
        }}
      >
        <div>
          <h2 style={{ margin: 0 }}>Usage Insights</h2>
          <p className="settings-description" style={{ margin: "4px 0 0" }}>
            Task activity, cost, and productivity patterns
          </p>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {[7, 14, 30].map((d) => (
            <button
              key={d}
              type="button"
              className={`settings-btn${periodDays === d ? " active" : ""}`}
              onClick={() => setPeriodDays(d)}
              style={{
                padding: "4px 10px",
                fontSize: 12,
                fontWeight: periodDays === d ? 600 : 400,
                opacity: periodDays === d ? 1 : 0.6,
              }}
            >
              {d}d
            </button>
          ))}
        </div>
      </div>

      {/* Task metrics */}
      {tm && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Tasks</h3>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10 }}>
            <StatCard label="Created" value={tm.totalCreated} />
            <StatCard label="Completed" value={tm.completed} color="#22c55e" />
            <StatCard label="Failed" value={tm.failed} color="#ef4444" />
            <StatCard label="Avg Time" value={formatDuration(tm.avgCompletionTimeMs)} />
          </div>
        </div>
      )}

      {/* Cost metrics */}
      {cm && cm.totalCost > 0 && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Cost & Tokens</h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: 10,
              marginBottom: 10,
            }}
          >
            <StatCard label="Total Cost" value={`$${cm.totalCost.toFixed(4)}`} />
            <StatCard label="Input" value={formatTokens(cm.totalInputTokens)} />
            <StatCard label="Output" value={formatTokens(cm.totalOutputTokens)} />
          </div>
          {cm.costByModel.length > 0 && (
            <div style={{ fontSize: 12, color: "var(--text-secondary, #888)" }}>
              {cm.costByModel.slice(0, 5).map((m) => (
                <div
                  key={m.model}
                  style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}
                >
                  <span style={{ minWidth: 100, fontFamily: "monospace" }}>{m.model}</span>
                  <MiniBar value={m.cost} max={cm.costByModel[0].cost} />
                  <span style={{ minWidth: 60, textAlign: "right" }}>${m.cost.toFixed(4)}</span>
                  <span style={{ minWidth: 40, textAlign: "right", opacity: 0.6 }}>{m.calls}×</span>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {/* Activity heatmap - day of week */}
      {ap && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            Activity by Day
            <span style={{ fontWeight: 400, opacity: 0.6, marginLeft: 8 }}>
              Peak: {ap.mostActiveDay}
            </span>
          </h3>
          <div style={{ fontSize: 12 }}>
            {DAY_NAMES.map((day, i) => (
              <div
                key={day}
                style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 3 }}
              >
                <span style={{ minWidth: 30, color: "var(--text-secondary, #888)" }}>{day}</span>
                <MiniBar value={ap.tasksByDayOfWeek[i]} max={maxDayTasks} />
                <span style={{ minWidth: 20, textAlign: "right", opacity: 0.6 }}>
                  {ap.tasksByDayOfWeek[i]}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Activity by hour (simplified: show only non-zero hours) */}
      {ap && (
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>
            Activity by Hour
            <span style={{ fontWeight: 400, opacity: 0.6, marginLeft: 8 }}>
              Peak: {ap.mostActiveHour}:00
            </span>
          </h3>
          <div style={{ display: "flex", alignItems: "flex-end", gap: 2, height: 48 }}>
            {ap.tasksByHour.map((count, h) => (
              <div
                key={h}
                title={`${h}:00 — ${count} tasks`}
                style={{
                  flex: 1,
                  height: `${maxHourTasks > 0 ? Math.max((count / maxHourTasks) * 100, count > 0 ? 8 : 2) : 2}%`,
                  background: count > 0 ? "var(--accent, #6366f1)" : "var(--bg-tertiary, #333)",
                  borderRadius: "2px 2px 0 0",
                  opacity: count > 0 ? 1 : 0.3,
                  transition: "height 0.3s ease",
                }}
              />
            ))}
          </div>
          <div
            style={{
              display: "flex",
              justifyContent: "space-between",
              fontSize: 9,
              color: "var(--text-secondary, #888)",
              marginTop: 2,
            }}
          >
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
        <div style={{ marginBottom: 20 }}>
          <h3 style={{ fontSize: 13, fontWeight: 600, marginBottom: 8 }}>Top Skills</h3>
          <div style={{ fontSize: 12 }}>
            {data.topSkills.slice(0, 5).map((s) => (
              <div
                key={s.skill}
                style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}
              >
                <span style={{ minWidth: 120 }}>{s.skill}</span>
                <MiniBar value={s.count} max={data.topSkills[0].count} />
                <span style={{ minWidth: 30, textAlign: "right", opacity: 0.6 }}>{s.count}×</span>
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
    <div
      style={{
        background: "var(--bg-secondary, #1a1a2e)",
        borderRadius: 8,
        padding: "10px 12px",
        textAlign: "center",
      }}
    >
      <div style={{ fontSize: 11, color: "var(--text-secondary, #888)", marginBottom: 4 }}>
        {label}
      </div>
      <div style={{ fontSize: 18, fontWeight: 600, color: color || "var(--text-primary, #fff)" }}>
        {value}
      </div>
    </div>
  );
}
