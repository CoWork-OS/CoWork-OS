import { useEffect, useMemo, useRef, useState } from "react";

interface RequestDayRow {
  dateKey: string;
  llmCalls: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

interface OverviewProps {
  totalTokens: number;
  avgTaskTimeMs: number | null;
  requestsByDay: RequestDayRow[];
  periodLabel: string;
}

type HeatmapMode = "daily" | "weekly" | "cumulative";

const HEATMAP_MODES: Array<{ value: HeatmapMode; label: string }> = [
  { value: "daily", label: "Daily" },
  { value: "weekly", label: "Weekly" },
  { value: "cumulative", label: "Cumulative" },
];

const MIN_HEATMAP_MONTHS = 12;

// Roughly the word count of Moby-Dick (~210k words ≈ ~270k tokens).
const MOBY_DICK_TOKENS = 270_000;

// A few well-known works to cycle through for a fun comparison.
const BOOK_COMPARISONS: Array<{ name: string; tokens: number }> = [
  { name: "Moby-Dick", tokens: 270_000 },
  { name: "the Harry Potter series", tokens: 1_400_000 },
  { name: "the Lord of the Rings trilogy", tokens: 620_000 },
  { name: "War and Peace", tokens: 780_000 },
  { name: "the complete works of Shakespeare", tokens: 1_100_000 },
];

function formatBigNumber(n: number): string {
  if (n >= 1_000_000_000) return `${(n / 1_000_000_000).toFixed(1)}B`;
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toLocaleString();
}

function formatShortDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms <= 0) return "\u2014";
  const totalMinutes = Math.max(1, Math.round(ms / 60_000));
  const days = Math.floor(totalMinutes / 1440);
  const hours = Math.floor((totalMinutes % 1440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `${days}d ${hours}h`;
  if (hours > 0) return `${hours}h ${minutes}m`;
  return `${minutes}m`;
}

function parseDateKey(dateKey: string): Date | null {
  const parts = dateKey.split("-").map(Number);
  if (parts.length !== 3 || parts.some((n) => !Number.isFinite(n))) return null;
  const [y, m, d] = parts;
  return new Date(y, m - 1, d);
}

function toKey(d: Date): string {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate(),
  ).padStart(2, "0")}`;
}

interface HeatmapCell {
  dateKey: string;
  count: number;
  intensity: number; // 0..4
  inRange: boolean;
  rawCount: number;
}

interface MonthLabel {
  label: string;
  start: number;
  span: number;
}

function tokenCount(row: RequestDayRow): number {
  return row.inputTokens + row.outputTokens;
}

function buildHeatmap(
  requestsByDay: RequestDayRow[],
  mode: HeatmapMode,
): { weeks: HeatmapCell[][]; max: number; months: MonthLabel[] } {
  if (requestsByDay.length === 0) return { weeks: [], max: 0, months: [] };
  const byDate = new Map<string, number>();
  for (const row of requestsByDay) {
    byDate.set(row.dateKey, tokenCount(row));
  }

  const sorted = [...requestsByDay].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const firstDataDate = parseDateKey(sorted[0].dateKey);
  const lastDataDate = parseDateKey(sorted[sorted.length - 1].dateKey);
  if (!firstDataDate || !lastDataDate) return { weeks: [], max: 0, months: [] };

  const firstDate = new Date(firstDataDate);
  const lastDate = new Date(lastDataDate);
  const minStart = new Date(lastDate);
  minStart.setMonth(minStart.getMonth() - (MIN_HEATMAP_MONTHS - 1));
  minStart.setDate(1);
  if (firstDate > minStart) {
    firstDate.setTime(minStart.getTime());
  }

  // Back up to the preceding Sunday so the first column is a full week.
  const start = new Date(firstDate);
  start.setDate(start.getDate() - start.getDay());
  const end = new Date(lastDate);
  end.setDate(end.getDate() + (6 - end.getDay()));

  const weeks: HeatmapCell[][] = [];
  const values: number[] = [];
  let cumulative = 0;
  let cursor = new Date(start);
  while (cursor <= end) {
    const weekStart = new Date(cursor);
    let weekTotal = 0;
    for (let i = 0; i < 7; i++) {
      const next = new Date(weekStart);
      next.setDate(weekStart.getDate() + i);
      weekTotal += byDate.get(toKey(next)) ?? 0;
    }

    const week: HeatmapCell[] = [];
    for (let i = 0; i < 7; i++) {
      const key = toKey(cursor);
      const rawCount = byDate.get(key) ?? 0;
      const inRange = cursor >= firstDate && cursor <= lastDate;
      const isDataRange = cursor >= firstDataDate && cursor <= lastDataDate;
      if (isDataRange) {
        cumulative += rawCount;
      }
      const count = !inRange
        ? 0
        : mode === "weekly"
          ? rawCount > 0
            ? weekTotal
            : 0
          : mode === "cumulative" && isDataRange
            ? cumulative
            : rawCount;
      if (count > 0) {
        values.push(count);
      }
      week.push({ dateKey: key, count, intensity: 0, inRange, rawCount });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  const max = values.length > 0 ? Math.max(...values) : 0;
  for (const week of weeks) {
    for (const cell of week) {
      let intensity = 0;
      if (cell.count > 0 && max > 0) {
        const ratio = cell.count / max;
        intensity = ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1;
      }
      cell.intensity = intensity;
    }
  }

  const months = buildMonthLabels(weeks);
  return { weeks, max, months };
}

function buildMonthLabels(weeks: HeatmapCell[][]): MonthLabel[] {
  const labels: MonthLabel[] = [];
  for (let i = 0; i < weeks.length; i++) {
    const visibleCell = weeks[i].find((cell) => cell.inRange);
    if (!visibleCell) continue;
    const date = parseDateKey(visibleCell.dateKey);
    if (!date) continue;
    const label = date.toLocaleDateString(undefined, { month: "short" });
    const current = labels[labels.length - 1];
    if (current?.label === label) {
      current.span += 1;
    } else {
      labels.push({ label, start: i + 1, span: 1 });
    }
  }
  return labels;
}

function computeStreaks(requestsByDay: RequestDayRow[]): {
  activeDays: number;
  currentStreak: number;
  longestStreak: number;
} {
  const activeSet = new Set(
    requestsByDay.filter((r) => r.llmCalls > 0).map((r) => r.dateKey),
  );
  const activeDays = activeSet.size;

  if (activeSet.size === 0) {
    return { activeDays: 0, currentStreak: 0, longestStreak: 0 };
  }

  const sortedKeys = [...activeSet].sort();
  let longestStreak = 1;
  let run = 1;
  for (let i = 1; i < sortedKeys.length; i++) {
    const prev = parseDateKey(sortedKeys[i - 1]);
    const curr = parseDateKey(sortedKeys[i]);
    if (!prev || !curr) {
      run = 1;
      continue;
    }
    const diff = Math.round((curr.getTime() - prev.getTime()) / 86_400_000);
    if (diff === 1) {
      run += 1;
      longestStreak = Math.max(longestStreak, run);
    } else {
      run = 1;
    }
  }

  // Current streak: consecutive days up to the most recent activity day.
  let currentStreak = 0;
  let cursor = parseDateKey(sortedKeys[sortedKeys.length - 1]);
  while (cursor && activeSet.has(toKey(cursor))) {
    currentStreak += 1;
    cursor.setDate(cursor.getDate() - 1);
  }

  return { activeDays, currentStreak, longestStreak };
}

function pickBookComparison(totalTokens: number): string | null {
  if (totalTokens <= 0) return null;
  // Pick the book whose multiple lands closest to an impressive-but-readable number.
  let best: { name: string; multiple: number } | null = null;
  for (const book of BOOK_COMPARISONS) {
    const multiple = totalTokens / book.tokens;
    if (multiple < 0.1) continue;
    if (!best || Math.abs(Math.log10(multiple) - 0.7) < Math.abs(Math.log10(best.multiple) - 0.7)) {
      best = { name: book.name, multiple };
    }
  }
  if (!best) {
    const multiple = totalTokens / MOBY_DICK_TOKENS;
    best = { name: "Moby-Dick", multiple };
  }
  const mult = best.multiple;
  const rendered =
    mult >= 10 ? `~${Math.round(mult)}\u00D7` : `~${mult.toFixed(1)}\u00D7`;
  return `You've used ${rendered} more tokens than ${best.name}.`;
}

function heatmapTitle(cell: HeatmapCell, mode: HeatmapMode): string {
  const value = formatBigNumber(cell.count);
  const raw = formatBigNumber(cell.rawCount);
  if (mode === "weekly") {
    return `${cell.dateKey}: ${raw} tokens, ${value} for the week`;
  }
  if (mode === "cumulative") {
    return `${cell.dateKey}: ${value} cumulative tokens`;
  }
  return `${cell.dateKey}: ${value} tokens`;
}

export function UsageInsightsOverview(props: OverviewProps) {
  const { totalTokens, avgTaskTimeMs, requestsByDay, periodLabel } = props;
  const [heatmapMode, setHeatmapMode] = useState<HeatmapMode>("cumulative");
  const heatmapScrollRef = useRef<HTMLDivElement>(null);

  const { currentStreak, longestStreak } = useMemo(
    () => computeStreaks(requestsByDay),
    [requestsByDay],
  );

  const { weeks, months } = useMemo(
    () => buildHeatmap(requestsByDay, heatmapMode),
    [heatmapMode, requestsByDay],
  );

  useEffect(() => {
    const scrollEl = heatmapScrollRef.current;
    if (!scrollEl) return;
    scrollEl.scrollLeft = scrollEl.scrollWidth;
  }, [heatmapMode, weeks.length]);

  const comparison = useMemo(() => pickBookComparison(totalTokens), [totalTokens]);

  const peakTokens = useMemo(
    () => requestsByDay.reduce((peak, row) => Math.max(peak, tokenCount(row)), 0),
    [requestsByDay],
  );

  return (
    <div className="insights-overview">
      <div className="insights-overview-stats">
        <StatCard label="Total tokens" value={formatBigNumber(totalTokens)} />
        <StatCard label="Peak tokens" value={formatBigNumber(peakTokens)} />
        <StatCard label="Avg task" value={formatShortDuration(avgTaskTimeMs)} />
        <StatCard label="Current streak" value={`${currentStreak} days`} />
        <StatCard label="Longest streak" value={`${longestStreak} days`} />
      </div>

      {weeks.length > 0 && (
        <div className="insights-token-activity" aria-label="Token activity heatmap">
          <div className="insights-token-activity-header">
            <div className="insights-token-activity-title">
              <h3>Token activity</h3>
              <span className="insights-token-activity-range">{periodLabel}</span>
            </div>
            <div className="insights-token-activity-tabs" role="tablist" aria-label="Token activity view">
              {HEATMAP_MODES.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  role="tab"
                  aria-selected={heatmapMode === mode.value}
                  className={`insights-token-activity-tab${heatmapMode === mode.value ? " active" : ""}`}
                  onClick={() => setHeatmapMode(mode.value)}
                >
                  {mode.label}
                </button>
              ))}
            </div>
          </div>
          <div className="insights-overview-heatmap" ref={heatmapScrollRef}>
            <div className="insights-overview-heatmap-grid">
              {weeks.map((week, wi) => (
                <div key={wi} className="insights-overview-heatmap-col">
                  {week.map((cell) => (
                    <div
                      key={cell.dateKey}
                      className={`insights-overview-heatmap-cell insights-overview-heatmap-cell-l${cell.intensity}${cell.inRange ? "" : " out-of-range"}`}
                      title={heatmapTitle(cell, heatmapMode)}
                    />
                  ))}
                </div>
              ))}
            </div>
            {months.length > 0 && (
              <div
                className="insights-overview-heatmap-months"
                style={{ gridTemplateColumns: `repeat(${weeks.length}, 16px)` }}
              >
                {months.map((month) => (
                  <span
                    key={`${month.label}-${month.start}`}
                    style={{ gridColumn: `${month.start} / span ${month.span}` }}
                  >
                    {month.label}
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {comparison && <div className="insights-overview-caption">{comparison}</div>}
    </div>
  );
}

function StatCard({
  label,
  value,
  valueClass,
}: {
  label: string;
  value: string;
  valueClass?: string;
}) {
  return (
    <div className="insights-overview-stat">
      <div className="insights-overview-stat-label">{label}</div>
      <div className={`insights-overview-stat-value${valueClass ? ` ${valueClass}` : ""}`}>
        {value}
      </div>
    </div>
  );
}
