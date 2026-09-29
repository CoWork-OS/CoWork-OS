import type Database from "better-sqlite3";
import { UsageInsightsProjector } from "../../reports/UsageInsightsProjector";
import {
  type UsageInsights,
  UsageInsightsService,
  type UsageReportPlan,
} from "../../reports/UsageInsightsService";
import { InvalidCommandArgumentsError } from "./command-errors";

/**
 * Usage insights commands for the database worker and the reporting reader (async
 * SQLite migration plan, DB4). The host projector keeps the watermarks, the dirty set,
 * and the report cache; the scans and rollup rebuilds run here, each command bounded:
 * one backfill chunk, or at most MAX_ROLLUP_ITEMS workspace-days.
 */

const projectorsByConnection = new WeakMap<Database.Database, UsageInsightsProjector>();

function projectorFor(db: Database.Database): UsageInsightsProjector {
  let projector = projectorsByConnection.get(db);
  if (!projector) {
    projector = UsageInsightsProjector.createDetached(db);
    projectorsByConnection.set(db, projector);
  }
  return projector;
}

export const MAX_LEGACY_TELEMETRY_CHUNK = 5_000;
export const MAX_ROLLUP_ITEMS = 64;
const MAX_REPORT_PERIOD_DAYS = 365;

const ROLLUP_TABLES = [
  "tasks",
  "task_events",
  "llm_call_events",
  "usage_insights_day",
  "usage_insights_hour",
  "usage_insights_skill_day",
  "usage_insights_tool_day",
  "usage_insights_persona_day",
  "usage_insights_feedback_reason_day",
] as const;

function requireObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new InvalidCommandArgumentsError("arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function requireCursor(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new InvalidCommandArgumentsError(`${name} must be a non-negative integer`);
  }
  return value;
}

function requireRollupItems(value: unknown): Array<{ workspaceId: string; dateKey: string }> {
  if (!Array.isArray(value) || value.length > MAX_ROLLUP_ITEMS) {
    throw new InvalidCommandArgumentsError(`items must be an array of at most ${MAX_ROLLUP_ITEMS}`);
  }
  return value.map((item) => {
    const entry = requireObject(item);
    if (
      typeof entry.workspaceId !== "string" ||
      !/^\d{4}-\d{2}-\d{2}$/.test(String(entry.dateKey))
    ) {
      throw new InvalidCommandArgumentsError(
        "each item needs a workspaceId and a YYYY-MM-DD dateKey",
      );
    }
    return { workspaceId: entry.workspaceId, dateKey: String(entry.dateKey) };
  });
}

function requirePlan(value: unknown): UsageReportPlan {
  const plan = requireObject(value);
  if (plan.kind === "fast") return { kind: "fast" };
  if (plan.kind === "raw") return { kind: "raw", canonical: plan.canonical === true };
  if (plan.kind === "duringBackfill") {
    const watermarks = requireObject(plan.watermarks);
    const read = (name: string) => {
      const raw = watermarks[name];
      if (typeof raw !== "number" || !Number.isFinite(raw)) {
        throw new InvalidCommandArgumentsError(`watermarks.${name} must be a finite number`);
      }
      return raw;
    };
    return {
      kind: "duringBackfill",
      watermarks: {
        taskWatermarkMs: read("taskWatermarkMs"),
        eventWatermarkMs: read("eventWatermarkMs"),
        llmWatermarkMs: read("llmWatermarkMs"),
      },
    };
  }
  throw new InvalidCommandArgumentsError("plan.kind must be fast, duringBackfill, or raw");
}

export const USAGE_COMMANDS = {
  /** Clear every rollup table before a full rebuild. */
  "usage.resetRollups": {
    kind: "write",
    tables: ROLLUP_TABLES,
    run(db: Database.Database): { ok: true } {
      projectorFor(db).resetRollups();
      return { ok: true };
    },
  },
  /** One rowid-bounded pass copying legacy usage/error events into llm_call_events. */
  "usage.backfillLegacyTelemetryChunk": {
    kind: "write",
    tables: ["task_events", "tasks", "llm_call_events"],
    run(
      db: Database.Database,
      rawArgs: { successAfter: number; errorAfter: number; limit: number },
    ): { successAfter: number; errorAfter: number; done: boolean } {
      const args = requireObject(rawArgs);
      const limit = requireCursor(args.limit, "limit");
      if (limit < 1 || limit > MAX_LEGACY_TELEMETRY_CHUNK) {
        throw new InvalidCommandArgumentsError(
          `limit must be between 1 and ${MAX_LEGACY_TELEMETRY_CHUNK}`,
        );
      }
      return projectorFor(db).backfillLegacyLlmTelemetryChunk(
        {
          successAfter: requireCursor(args.successAfter, "successAfter"),
          errorAfter: requireCursor(args.errorAfter, "errorAfter"),
        },
        limit,
      );
    },
  },
  /** The workspace-days that have usage activity, in date order. */
  "usage.collectRollupPairs": {
    kind: "read",
    tables: ["tasks", "task_events", "llm_call_events"],
    run(db: Database.Database): Array<{ workspaceId: string; dateKey: string }> {
      return projectorFor(db).collectWorkspaceDatePairs();
    },
  },
  /** Rebuild the rollups of a bounded set of workspace-days. */
  "usage.rebuildRollupDates": {
    kind: "write",
    tables: ROLLUP_TABLES,
    run(
      db: Database.Database,
      rawArgs: { items: Array<{ workspaceId: string; dateKey: string }> },
    ): { rebuilt: number } {
      const items = requireRollupItems(requireObject(rawArgs).items);
      projectorFor(db).rebuildWorkspaceDates(items);
      return { rebuilt: items.length };
    },
  },
  /** A usage insights report, run in the reporting reader with the plan the host chose. */
  "usage.generateReport": {
    kind: "read",
    tables: [...ROLLUP_TABLES, "usage_insights_state"],
    run(
      db: Database.Database,
      rawArgs: {
        workspaceId: string | null;
        periodDays: number;
        plan: UsageReportPlan;
        /** Pins the period end; defaults to now. */
        nowMs?: number;
      },
    ): UsageInsights {
      const args = requireObject(rawArgs);
      const workspaceId = args.workspaceId;
      if (workspaceId !== null && typeof workspaceId !== "string") {
        throw new InvalidCommandArgumentsError("workspaceId must be a string or null");
      }
      const periodDays = requireCursor(args.periodDays, "periodDays");
      if (periodDays < 1 || periodDays > MAX_REPORT_PERIOD_DAYS) {
        throw new InvalidCommandArgumentsError(
          `periodDays must be between 1 and ${MAX_REPORT_PERIOD_DAYS}`,
        );
      }
      if (
        args.nowMs !== undefined &&
        (typeof args.nowMs !== "number" || !Number.isFinite(args.nowMs))
      ) {
        throw new InvalidCommandArgumentsError("nowMs must be a finite number");
      }
      return new UsageInsightsService(db).generateWithPlan(
        workspaceId,
        periodDays,
        requirePlan(args.plan),
        (args.nowMs as number | undefined) ?? Date.now(),
      );
    },
  },
} as const;
