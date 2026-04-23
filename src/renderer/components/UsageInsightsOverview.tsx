import { useMemo } from "react";

interface RequestDayRow {
  dateKey: string;
  llmCalls: number;
  cost: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

interface OverviewProps {
  sessions: number;
  messages: number;
  totalTokens: number;
  mostActiveHour: number | null;
  favoriteModel: string | null;
  requestsByDay: RequestDayRow[];
}

const DAY_LABELS = ["Mon", "Wed", "Fri"];

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

function formatHourRange(hour: number): string {
  const wrap = (h: number) => {
    const suffix = h < 12 ? "AM" : "PM";
    const hh = h % 12 === 0 ? 12 : h % 12;
    return `${hh} ${suffix}`;
  };
  return wrap(hour);
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
}

function buildHeatmap(
  requestsByDay: RequestDayRow[],
): { weeks: HeatmapCell[][]; max: number } {
  if (requestsByDay.length === 0) return { weeks: [], max: 0 };
  const byDate = new Map<string, number>();
  for (const row of requestsByDay) {
    byDate.set(row.dateKey, row.llmCalls);
  }

  const sorted = [...requestsByDay].sort((a, b) => a.dateKey.localeCompare(b.dateKey));
  const firstDate = parseDateKey(sorted[0].dateKey);
  const lastDate = parseDateKey(sorted[sorted.length - 1].dateKey);
  if (!firstDate || !lastDate) return { weeks: [], max: 0 };

  // Back up to the preceding Sunday so the first column is a full week.
  const start = new Date(firstDate);
  start.setDate(start.getDate() - start.getDay());
  const end = new Date(lastDate);
  end.setDate(end.getDate() + (6 - end.getDay()));

  const values = Array.from(byDate.values()).filter((v) => v > 0);
  const max = values.length > 0 ? Math.max(...values) : 0;

  const weeks: HeatmapCell[][] = [];
  let cursor = new Date(start);
  while (cursor <= end) {
    const week: HeatmapCell[] = [];
    for (let i = 0; i < 7; i++) {
      const key = toKey(cursor);
      const count = byDate.get(key) ?? 0;
      const inRange = cursor >= firstDate && cursor <= lastDate;
      let intensity = 0;
      if (count > 0 && max > 0) {
        const ratio = count / max;
        intensity = ratio > 0.75 ? 4 : ratio > 0.5 ? 3 : ratio > 0.25 ? 2 : 1;
      }
      week.push({ dateKey: key, count, intensity, inRange });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }
  return { weeks, max };
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

export function UsageInsightsOverview(props: OverviewProps) {
  const { sessions, messages, totalTokens, mostActiveHour, favoriteModel, requestsByDay } = props;

  const { activeDays, currentStreak, longestStreak } = useMemo(
    () => computeStreaks(requestsByDay),
    [requestsByDay],
  );

  const { weeks } = useMemo(() => buildHeatmap(requestsByDay), [requestsByDay]);
  const comparison = useMemo(() => pickBookComparison(totalTokens), [totalTokens]);

  const peakLabel =
    mostActiveHour !== null && mostActiveHour >= 0 ? formatHourRange(mostActiveHour) : "\u2014";

  return (
    <div className="insights-overview">
      <div className="insights-overview-stats">
        <StatCard label="Sessions" value={formatBigNumber(sessions)} />
        <StatCard label="Messages" value={formatBigNumber(messages)} />
        <StatCard label="Total tokens" value={formatBigNumber(totalTokens)} />
        <StatCard label="Active days" value={formatBigNumber(activeDays)} />
        <StatCard label="Current streak" value={`${currentStreak}d`} />
        <StatCard label="Longest streak" value={`${longestStreak}d`} />
        <StatCard label="Peak hour" value={peakLabel} />
        <StatCard
          label="Favorite model"
          value={favoriteModel ?? "\u2014"}
          valueClass="insights-overview-stat-value--small"
        />
      </div>

      {weeks.length > 0 && (
        <div className="insights-overview-heatmap" aria-label="Daily activity heatmap">
          <div className="insights-overview-heatmap-labels">
            {DAY_LABELS.map((d) => (
              <span key={d}>{d}</span>
            ))}
          </div>
          <div className="insights-overview-heatmap-grid">
            {weeks.map((week, wi) => (
              <div key={wi} className="insights-overview-heatmap-col">
                {week.map((cell) => (
                  <div
                    key={cell.dateKey}
                    className={`insights-overview-heatmap-cell insights-overview-heatmap-cell-l${cell.intensity}${cell.inRange ? "" : " out-of-range"}`}
                    title={`${cell.dateKey}: ${cell.count} call${cell.count === 1 ? "" : "s"}`}
                  />
                ))}
              </div>
            ))}
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
