/** YYYY-MM-DD in local timezone (matches Usage Insights day buckets). */
export function usageLocalDateKey(timestampMs: number): string {
  const d = new Date(timestampMs);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

export interface UsageInsightsDateRange {
  startMs: number;
  endMs: number;
}

/** Count calendar days rather than elapsed hours across daylight-saving changes. */
export function usageInsightsDayCount(range: UsageInsightsDateRange): number {
  const start = new Date(range.startMs);
  const end = new Date(range.endMs);
  return (
    Math.round(
      (Date.UTC(end.getFullYear(), end.getMonth(), end.getDate()) -
        Date.UTC(start.getFullYear(), start.getMonth(), start.getDate())) /
        86_400_000,
    ) + 1
  );
}

/** Explicit report bounds are inclusive and retain the existing one-year scan limit. */
export function parseUsageInsightsDateRange(value: unknown): UsageInsightsDateRange | undefined {
  if (value === undefined) return undefined;
  const range = value as Partial<UsageInsightsDateRange> | null;
  if (
    !range ||
    !Number.isSafeInteger(range.startMs) ||
    !Number.isSafeInteger(range.endMs) ||
    range.startMs! < 0 ||
    range.endMs! < range.startMs! ||
    !Number.isFinite(usageInsightsDayCount(range as UsageInsightsDateRange)) ||
    usageInsightsDayCount(range as UsageInsightsDateRange) > 365
  ) {
    throw new Error("Choose valid report dates covering at most 365 days.");
  }
  return { startMs: range.startMs!, endMs: range.endMs! };
}

/** Date inputs use local days, like the report's daily buckets, including the final day. */
export function usageInsightsRangeFromDates(
  start: string,
  end: string,
): UsageInsightsDateRange | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end)) return null;
  const startMs = new Date(`${start}T00:00:00`).getTime();
  const endMs = new Date(`${end}T23:59:59.999`).getTime();
  if (usageLocalDateKey(startMs) !== start || usageLocalDateKey(endMs) !== end) return null;
  try {
    return parseUsageInsightsDateRange({ startMs, endMs }) ?? null;
  } catch {
    return null;
  }
}
