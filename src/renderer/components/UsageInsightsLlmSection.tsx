import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ComposedChart,
  LabelList,
  Legend,
  Line,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { getLlmProviderDisplayName } from "../../shared/llmProviderDisplay";

export interface LlmSummaryProps {
  totalLlmCalls: number;
  totalCost: number;
  chargeableCallRate: number | null;
  avgTokensPerCall: number | null;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  cacheReadRate: number | null;
  distinctTaskCount: number;
}

export interface RequestDayRow {
  dateKey: string;
  llmCalls: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export interface ProviderSlice {
  provider: string;
  calls: number;
  distinctTasks: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  percent: number;
}

export interface CostByModelRow {
  model: string;
  cost: number;
  calls: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  distinctTasks: number;
}

const CHART_COLORS = ["#3b82f6", "#14b8a6", "#22c55e", "#f59e0b", "#a855f7", "#ec4899"];

function formatDayLabel(dateKey: string): string {
  const parts = dateKey.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return dateKey;
  const [y, m, d] = parts;
  const dt = new Date(y, m - 1, d);
  return dt.toLocaleDateString(undefined, { day: "2-digit", month: "short" });
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

const tooltipProps = {
  contentStyle: {
    backgroundColor: "var(--color-bg-elevated, rgba(28, 28, 32, 0.96))",
    border: "1px solid var(--color-border, rgba(255,255,255,0.12))",
    borderRadius: 8,
    fontSize: 12,
  },
};

export interface UsageInsightsLlmSectionProps {
  llmSummary: LlmSummaryProps;
  llmSuccessRate: number | null;
  requestsByDay: RequestDayRow[];
  providerBreakdown: ProviderSlice[];
  costByModel: CostByModelRow[];
}

export function UsageInsightsLlmSection({
  llmSummary: ls,
  llmSuccessRate,
  requestsByDay,
  providerBreakdown,
  costByModel,
}: UsageInsightsLlmSectionProps) {
  const hasLlmUsage = ls.totalLlmCalls > 0;

  const dailyRows = requestsByDay.map((d) => ({
    ...d,
    label: formatDayLabel(d.dateKey),
    avgCostPerCall: d.llmCalls > 0 ? d.cost / d.llmCalls : 0,
  }));

  const byModelChart = [...costByModel]
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 12)
    .map((m) => ({
      name: m.model.length > 40 ? `${m.model.slice(0, 38)}\u2026` : m.model,
      calls: m.calls,
    }));
  const maxModelCalls = byModelChart.length ? Math.max(...byModelChart.map((r) => r.calls), 1) : 1;

  const pieData = providerBreakdown
    .filter((p) => p.calls > 0)
    .map((p) => ({
      name: getLlmProviderDisplayName(p.provider),
      value: ls.totalCost > 0 ? p.cost : p.calls,
      percent: p.percent,
    }));

  const tableRows = [...costByModel].sort((a, b) => b.calls - a.calls).slice(0, 15);
  const providerTableRows = [...providerBreakdown].slice(0, 12);

  const chargeablePct =
    ls.chargeableCallRate !== null ? `${ls.chargeableCallRate.toFixed(1)}%` : "\u2014";
  const successPct =
    llmSuccessRate !== null ? `${llmSuccessRate.toFixed(1)}%` : "\u2014";
  const cachePct =
    ls.totalCachedTokens > 0 && ls.cacheReadRate !== null
      ? `${ls.cacheReadRate.toFixed(1)}%`
      : "\u2014";

  return (
    <div className="insights-llm-section">
      <h3 className="insights-llm-section-title">LLM usage</h3>
      <p className="insights-llm-section-hint">
        LLM call success measures completed model responses vs logged LLM errors (not task outcome).
      </p>

      <div className="insights-llm-kpi-grid">
        <div className="insights-hero-card insights-llm-kpi-card">
          <div className="insights-hero-value">{ls.totalLlmCalls}</div>
          <div className="insights-hero-label">LLM calls</div>
        </div>
        <div className="insights-hero-card insights-llm-kpi-card">
          <div className="insights-hero-value">{chargeablePct}</div>
          <div className="insights-hero-label">Chargeable calls</div>
        </div>
        <div className="insights-hero-card insights-llm-kpi-card">
          <div className="insights-hero-value">{successPct}</div>
          <div className="insights-hero-label">LLM call success</div>
        </div>
        <div className="insights-hero-card insights-llm-kpi-card">
          <div className="insights-hero-value">{ls.distinctTaskCount}</div>
          <div className="insights-hero-label">Tasks with LLM</div>
        </div>
        <div className="insights-hero-card insights-llm-kpi-card">
          <div className="insights-hero-value">
            {ls.avgTokensPerCall !== null ? formatTokens(ls.avgTokensPerCall) : "\u2014"}
          </div>
          <div className="insights-hero-label">Avg tokens / call</div>
        </div>
        <div className="insights-hero-card insights-llm-kpi-card">
          <div className="insights-hero-value">{cachePct}</div>
          <div className="insights-hero-label">Cache read (of prompt)</div>
          {ls.totalCachedTokens === 0 && (
            <div className="insights-hero-sub">No cache data yet</div>
          )}
        </div>
      </div>

      {!hasLlmUsage && (
        <div className="insights-card insights-llm-empty-banner" role="status">
          <p className="insights-llm-empty-title">No LLM usage in this period</p>
          <p className="insights-llm-empty-body">
            Charts below stay hidden until at least one model call is recorded in this date range. Tool runs
            alone do not increment LLM metrics. Try a longer range (14d / 30d) if your tasks finished outside
            the last 7 days.
          </p>
        </div>
      )}

      {!hasLlmUsage ? null : (
        <>
      <div className="insights-two-col insights-chart-row">
        <div className="insights-card insights-chart-card">
          <div className="insights-card-header">LLM calls by day</div>
          <div className="insights-chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={dailyRows} margin={{ top: 8, right: 8, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border, rgba(255,255,255,0.08))" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: "var(--color-text-muted, #888)" }}
                  interval="preserveStartEnd"
                />
                <YAxis tick={{ fontSize: 10, fill: "var(--color-text-muted, #888)" }} allowDecimals={false} />
                <Tooltip {...tooltipProps} />
                <Bar dataKey="llmCalls" fill="#3b82f6" name="Calls" radius={[4, 4, 0, 0]}>
                  <LabelList
                    dataKey="llmCalls"
                    position="top"
                    fontSize={10}
                    fill="var(--color-text-muted, #888)"
                    formatter={(v: number | string) => (Number(v) > 0 ? String(v) : "")}
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="insights-card insights-chart-card">
          <div className="insights-card-header">Cost trend</div>
          <div className="insights-card-header-sub">Daily cost and avg cost per call</div>
          <div className="insights-chart-wrap">
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart data={dailyRows} margin={{ top: 8, right: 12, left: 0, bottom: 4 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border, rgba(255,255,255,0.08))" />
                <XAxis
                  dataKey="label"
                  tick={{ fontSize: 10, fill: "var(--color-text-muted, #888)" }}
                  interval="preserveStartEnd"
                />
                <YAxis
                  yAxisId="left"
                  tick={{ fontSize: 10, fill: "var(--color-text-muted, #888)" }}
                  tickFormatter={(v) => `$${Number(v).toFixed(2)}`}
                />
                <YAxis
                  yAxisId="right"
                  orientation="right"
                  tick={{ fontSize: 10, fill: "var(--color-text-muted, #888)" }}
                  tickFormatter={(v) => `$${Number(v).toFixed(3)}`}
                />
                <Tooltip
                  {...tooltipProps}
                  formatter={(value: number, name: string) => {
                    if (name === "Daily cost") return [`$${value.toFixed(4)}`, name];
                    if (name === "Avg $/call") return [`$${value.toFixed(4)}`, name];
                    return [value, name];
                  }}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Line
                  yAxisId="left"
                  type="monotone"
                  dataKey="cost"
                  name="Daily cost"
                  stroke="#3b82f6"
                  dot={false}
                  strokeWidth={2}
                />
                <Line
                  yAxisId="right"
                  type="monotone"
                  dataKey="avgCostPerCall"
                  name="Avg $/call"
                  stroke="#14b8a6"
                  dot={false}
                  strokeWidth={2}
                />
              </ComposedChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      <div className="insights-two-col insights-chart-row">
        <div className="insights-card insights-chart-card">
          <div className="insights-card-header">Calls by model</div>
          <div className="insights-chart-wrap insights-chart-wrap-tall">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart
                layout="vertical"
                data={byModelChart}
                margin={{ top: 8, right: 28, left: 8, bottom: 8 }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border, rgba(255,255,255,0.08))" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 10, fill: "var(--color-text-muted, #888)" }} allowDecimals={false} domain={[0, maxModelCalls]} />
                <YAxis
                  type="category"
                  dataKey="name"
                  width={132}
                  tick={{ fontSize: 10, fill: "var(--color-text-muted, #888)" }}
                />
                <Tooltip {...tooltipProps} />
                <Bar dataKey="calls" fill="#3b82f6" name="Calls" radius={[0, 4, 4, 0]}>
                  <LabelList
                    dataKey="calls"
                    position="right"
                    fontSize={10}
                    fill="var(--color-text-muted, #888)"
                  />
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="insights-card insights-chart-card">
          <div className="insights-card-header">
            Provider share
            <span className="insights-card-header-sub">
              {ls.totalCost > 0 ? "Share of cost" : "Share of calls"}
            </span>
          </div>
          <div className="insights-chart-wrap">
            {pieData.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <PieChart margin={{ top: 8, right: 8, bottom: 8, left: 8 }}>
                  <Pie
                    data={pieData}
                    dataKey="value"
                    nameKey="name"
                    cx="50%"
                    cy="50%"
                    innerRadius="48%"
                    outerRadius="72%"
                    paddingAngle={1}
                  >
                    {pieData.map((_, i) => (
                      <Cell key={i} fill={CHART_COLORS[i % CHART_COLORS.length]} />
                    ))}
                  </Pie>
                  <Tooltip {...tooltipProps} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                </PieChart>
              </ResponsiveContainer>
            ) : (
              <p className="insights-chart-empty">No provider data</p>
            )}
          </div>
        </div>
      </div>

      <div className="insights-card insights-chart-card insights-model-table-card">
        <div className="insights-card-header">Model breakdown</div>
        <div className="insights-table-wrap">
          <table className="insights-data-table">
            <thead>
              <tr>
                <th>Model</th>
                <th className="num">Calls</th>
                <th className="num">Tasks</th>
                <th className="num">Cost</th>
                <th className="num">In tok</th>
                <th className="num">Out tok</th>
                <th className="num">Cache</th>
              </tr>
            </thead>
            <tbody>
              {tableRows.map((row) => (
                <tr key={row.model}>
                  <td className="insights-table-model" title={row.model}>
                    {row.model}
                  </td>
                  <td className="num">{row.calls}</td>
                  <td className="num">{row.distinctTasks}</td>
                  <td className="num">${row.cost.toFixed(4)}</td>
                  <td className="num">{formatTokens(row.inputTokens)}</td>
                  <td className="num">{formatTokens(row.outputTokens)}</td>
                  <td className="num">{formatTokens(row.cachedTokens)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      {providerTableRows.length > 0 && (
        <div className="insights-card insights-chart-card insights-model-table-card">
          <div className="insights-card-header">Provider breakdown</div>
          <div className="insights-table-wrap">
            <table className="insights-data-table">
              <thead>
                <tr>
                  <th>Provider</th>
                  <th className="num">Calls</th>
                  <th className="num">Tasks</th>
                  <th className="num">Cost</th>
                  <th className="num">In tok</th>
                  <th className="num">Out tok</th>
                  <th className="num">Cache</th>
                </tr>
              </thead>
              <tbody>
                {providerTableRows.map((row) => (
                  <tr key={row.provider}>
                    <td
                      className="insights-table-model"
                      title={getLlmProviderDisplayName(row.provider)}
                    >
                      {getLlmProviderDisplayName(row.provider)}
                    </td>
                    <td className="num">{row.calls}</td>
                    <td className="num">{row.distinctTasks}</td>
                    <td className="num">${row.cost.toFixed(4)}</td>
                    <td className="num">{formatTokens(row.inputTokens)}</td>
                    <td className="num">{formatTokens(row.outputTokens)}</td>
                    <td className="num">{formatTokens(row.cachedTokens)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
        </>
      )}
    </div>
  );
}
