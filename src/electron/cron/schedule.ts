/**
 * Schedule computation for cron jobs
 * Supports: at (one-shot), every (interval), cron (cron expressions)
 */

import type { CronSchedule } from "./types";

/**
 * Compute the next run time in milliseconds for a given schedule
 * Returns undefined if the schedule has no future runs
 */
export function computeNextRunAtMs(schedule: CronSchedule, nowMs: number): number | undefined {
  switch (schedule.kind) {
    case "at":
      // One-shot: run at specific time, or undefined if already passed
      return schedule.atMs > nowMs ? schedule.atMs : undefined;

    case "every": {
      // Interval: compute next run based on anchor
      const everyMs = Math.max(1, Math.floor(schedule.everyMs));
      const anchor = Math.max(0, Math.floor(schedule.anchorMs ?? nowMs));

      // If we're before the anchor, the next run is at the anchor
      if (nowMs < anchor) return anchor;

      // Calculate how many intervals have passed since anchor
      const elapsed = nowMs - anchor;
      const steps = Math.max(1, Math.floor((elapsed + everyMs - 1) / everyMs));

      return anchor + steps * everyMs;
    }

    case "cron": {
      // Cron expression: parse and compute next run
      const expr = schedule.expr.trim();
      if (!expr) return undefined;

      return computeNextCronRun(expr, new Date(nowMs), schedule.tz);
    }
  }
}

/**
 * Simple cron expression parser
 * Supports standard 5-field cron: minute hour day-of-month month day-of-week
 *
 * Examples:
 * - "* * * * *" - Every minute
 * - "0 * * * *" - Every hour
 * - "0 9 * * *" - Daily at 9:00 AM
 * - "0 9 * * 1-5" - Weekdays at 9:00 AM
 * - "0 0 1 * *" - First of every month
 * - "0/15 * * * *" - Every 15 minutes (step syntax)
 */
function computeNextCronRun(expr: string, now: Date, _tz?: string): number | undefined {
  const parts = expr.split(/\s+/);
  if (parts.length !== 5) {
    console.warn("[Cron] Invalid cron expression (expected 5 fields):", expr);
    return undefined;
  }

  const [minuteExpr, hourExpr, dayExpr, monthExpr, dowExpr] = parts;

  // Parse each field into allowed values
  const minutes = parseField(minuteExpr, 0, 59);
  const hours = parseField(hourExpr, 0, 23);
  const days = parseField(dayExpr, 1, 31);
  const months = parseField(monthExpr, 1, 12);
  const dows = parseField(dowExpr, 0, 6); // 0 = Sunday

  if (!minutes || !hours || !days || !months || !dows) {
    console.warn("[Cron] Failed to parse cron expression:", expr);
    return undefined;
  }

  // Search for the next valid time
  // Start from the next minute
  const candidate = new Date(now.getTime());
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  // Search up to 2 years ahead
  const maxIterations = 365 * 2 * 24 * 60; // ~2 years of minutes

  for (let i = 0; i < maxIterations; i++) {
    const month = candidate.getMonth() + 1; // 1-12
    const day = candidate.getDate();
    const dow = candidate.getDay(); // 0-6, 0 = Sunday
    const hour = candidate.getHours();
    const minute = candidate.getMinutes();

    // Check if this time matches the cron expression
    if (
      months.has(month) &&
      days.has(day) &&
      dows.has(dow) &&
      hours.has(hour) &&
      minutes.has(minute)
    ) {
      return candidate.getTime();
    }

    // Move to next minute
    candidate.setMinutes(candidate.getMinutes() + 1);
  }

  // No valid time found within 2 years
  return undefined;
}

/**
 * Parse a cron field into a set of allowed values
 * Supports: *, N, N-M, N/step, *, /step
 */
function parseField(field: string, min: number, max: number): Set<number> | null {
  const values = new Set<number>();

  // Split by comma for multiple values
  const parts = field.split(",");

  for (const part of parts) {
    const trimmed = part.trim();

    // Wildcard with optional step: * or */N
    if (trimmed === "*" || trimmed.startsWith("*/")) {
      const step = trimmed === "*" ? 1 : parseInt(trimmed.slice(2), 10);
      if (isNaN(step) || step < 1) return null;

      for (let i = min; i <= max; i += step) {
        values.add(i);
      }
      continue;
    }

    // Range with optional step: N-M or N-M/step
    const rangeMatch = trimmed.match(/^(\d+)-(\d+)(?:\/(\d+))?$/);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      const step = rangeMatch[3] ? parseInt(rangeMatch[3], 10) : 1;

      if (isNaN(start) || isNaN(end) || isNaN(step) || step < 1) return null;
      if (start < min || end > max || start > end) return null;

      for (let i = start; i <= end; i += step) {
        values.add(i);
      }
      continue;
    }

    // Single value with optional step: N or N/step
    const singleMatch = trimmed.match(/^(\d+)(?:\/(\d+))?$/);
    if (singleMatch) {
      const value = parseInt(singleMatch[1], 10);

      if (isNaN(value) || value < min || value > max) return null;

      if (singleMatch[2]) {
        // N/step means starting from N, every step
        const step = parseInt(singleMatch[2], 10);
        if (isNaN(step) || step < 1) return null;

        for (let i = value; i <= max; i += step) {
          values.add(i);
        }
      } else {
        values.add(value);
      }
      continue;
    }

    // Invalid field
    return null;
  }

  return values.size > 0 ? values : null;
}

/**
 * Validate a cron expression
 * Returns true if valid, false otherwise
 */
export function validateCronExpression(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const [minute, hour, day, month, dow] = parts;

  return (
    parseField(minute, 0, 59) !== null &&
    parseField(hour, 0, 23) !== null &&
    parseField(day, 1, 31) !== null &&
    parseField(month, 1, 12) !== null &&
    parseField(dow, 0, 6) !== null
  );
}

/**
 * Common cron presets for the UI
 */
export const CRON_PRESETS = [
  { label: "Every minute", value: "* * * * *" },
  { label: "Every 5 minutes", value: "*/5 * * * *" },
  { label: "Every 15 minutes", value: "*/15 * * * *" },
  { label: "Every 30 minutes", value: "*/30 * * * *" },
  { label: "Every hour", value: "0 * * * *" },
  { label: "Every 2 hours", value: "0 */2 * * *" },
  { label: "Every 6 hours", value: "0 */6 * * *" },
  { label: "Daily at midnight", value: "0 0 * * *" },
  { label: "Daily at 9:00 AM", value: "0 9 * * *" },
  { label: "Daily at 6:00 PM", value: "0 18 * * *" },
  { label: "Weekdays at 9:00 AM", value: "0 9 * * 1-5" },
  { label: "Weekly on Sunday", value: "0 0 * * 0" },
  { label: "Weekly on Monday", value: "0 0 * * 1" },
  { label: "Monthly on the 1st", value: "0 0 1 * *" },
  { label: "Monthly on the 15th", value: "0 0 15 * *" },
] as const;
