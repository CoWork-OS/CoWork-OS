/**
 * Memory Hub "Sources" and "Health" (audit §8.4): where the workspace's memory comes from,
 * and the aggregate checks of `npm run qa:memory-health` with PASS / WARN against the
 * shared thresholds (src/shared/memory-health-thresholds.json). Read-only; every query is
 * a read unit of the memory domain (memory-health-sql.ts), so it runs in the database
 * worker when memory is routed there. Counts only, never memory content or secrets.
 */
import {
  MEMORY_HEALTH_STUCK_AFTER_MS,
  MEMORY_HEALTH_THRESHOLDS,
  type MemoryHealthCheck,
  type MemoryHealthReport,
  type MemorySourcesReport,
} from "../../shared/memory-health-types";
import type { MemoryHubSource } from "../../shared/memory-hub-types";
import type { MemoryFeaturesSettings } from "../../shared/types";
import { CURATION_LLM_DEFAULT_DAILY_BUDGET } from "./memory-curation-llm";
import type { MemoryHealthCounts } from "./memory-health-sql";
import type { MemoryStatementPort } from "./memory-statement-port";

const MIB = 1024 * 1024;

export interface MemoryHealthDeps {
  port: Pick<MemoryStatementPort, "unit">;
  getSettings: () => MemoryFeaturesSettings;
  /** Supermemory switch and whether it has credentials (never the credentials). */
  getSupermemoryStatus: () => { enabled: boolean; connected: boolean };
  getChronicleEnabled: () => boolean;
  now?: () => number;
}

const ratio = (part: number, whole: number) => (whole > 0 ? part / whole : 0);

function thresholdCheck(
  base: Omit<MemoryHealthCheck, "status" | "value" | "op" | "threshold">,
  value: number | null,
  op: "<=" | ">=",
  threshold: number,
  skipReason = "Not recorded in this profile yet.",
): MemoryHealthCheck {
  if (value === null) {
    return { ...base, status: "skip", value: null, op, threshold, detail: skipReason };
  }
  const ok = op === "<=" ? value <= threshold : value >= threshold;
  return { ...base, status: ok ? "pass" : "warn", value, op, threshold };
}

export function evaluateMemoryHealth(
  counts: MemoryHealthCounts,
  context: {
    llmEnabled: boolean;
    llmDailyBudget: number;
    thresholds?: typeof MEMORY_HEALTH_THRESHOLDS;
  },
): MemoryHealthCheck[] {
  const t = context.thresholds ?? MEMORY_HEALTH_THRESHOLDS;
  const checks: MemoryHealthCheck[] = [];
  const { archive, memoryItems, heartbeat, dreaming, embeddings, pendingWrites } = counts;

  checks.push(
    thresholdCheck(
      {
        id: "archive_telemetry_ratio",
        label: "Archive noise (tool and trace telemetry)",
        unit: "ratio",
        detail: archive
          ? `${archive.telemetry} of ${archive.total} archive rows are raw tool events or traces.`
          : "",
      },
      archive ? ratio(archive.telemetry, archive.total) : null,
      "<=",
      t.maxTelemetryRatio,
    ),
    thresholdCheck(
      {
        id: "archive_duplicate_rate",
        label: "Archive duplicates",
        unit: "ratio",
        detail: archive
          ? `${archive.duplicateRows} rows repeat another row of the same workspace and type.`
          : "",
      },
      archive ? ratio(archive.duplicateRows, archive.total) : null,
      "<=",
      t.maxDuplicateRate,
    ),
    thresholdCheck(
      {
        id: "memory_items_duplicate_rate",
        label: "Duplicate facts",
        unit: "ratio",
        detail: memoryItems
          ? `${memoryItems.duplicateRows} of ${memoryItems.active} active facts repeat another fact in the same scope.`
          : "",
      },
      memoryItems ? ratio(memoryItems.duplicateRows, memoryItems.active) : null,
      "<=",
      t.maxDuplicateRate,
    ),
    thresholdCheck(
      {
        id: "stuck_heartbeat_runs",
        label: "Stuck heartbeat runs",
        unit: "count",
        detail: "Heartbeat runs still marked running after an hour.",
      },
      heartbeat?.stuck ?? null,
      "<=",
      t.maxStuckHeartbeat,
    ),
    thresholdCheck(
      {
        id: "stuck_dreaming_runs",
        label: "Stuck Dreaming runs",
        unit: "count",
        detail: "Dreaming runs still marked running after an hour.",
      },
      dreaming?.stuck ?? null,
      "<=",
      t.maxStuckDreaming,
    ),
    thresholdCheck(
      {
        id: "dreaming_failures",
        label: "Failed Dreaming runs (7 days)",
        unit: "count",
        detail: "Dreaming runs that ended with an error in the last 7 days.",
      },
      dreaming?.failedLast7d ?? null,
      "<=",
      t.maxDreamingFailures7d,
    ),
  );

  checks.push({
    id: "dreaming_last_run",
    label: "Dreaming last run",
    status: dreaming ? "info" : "skip",
    value: dreaming?.lastRunAt ?? null,
    detail: dreaming?.lastRunAt
      ? "When Dreaming last started curating a workspace."
      : "Dreaming has not run yet.",
  });

  if (!context.llmEnabled) {
    checks.push({
      id: "dreaming_llm_budget",
      label: "Dreaming AI synthesis tokens (24 h)",
      status: "info",
      value: dreaming?.llmTokensLastDay ?? null,
      unit: "tokens",
      detail: "AI synthesis is off; Dreaming uses no model tokens.",
    });
  } else {
    const used = dreaming?.llmTokensLastDay ?? null;
    const budget = Math.max(1, context.llmDailyBudget);
    checks.push(
      thresholdCheck(
        {
          id: "dreaming_llm_budget",
          label: "Dreaming AI synthesis budget (24 h)",
          unit: "ratio",
          detail:
            used === null
              ? ""
              : `${used.toLocaleString("en-US")} of ${budget.toLocaleString("en-US")} daily tokens used.`,
        },
        used === null ? null : used / budget,
        "<=",
        t.maxLlmBudgetRatio,
      ),
    );
  }

  checks.push(
    thresholdCheck(
      {
        id: "orphan_embeddings",
        label: "Orphan embeddings",
        unit: "count",
        detail: embeddings
          ? `${embeddings.orphans} of ${embeddings.total} embeddings belong to a deleted archive row.`
          : "",
      },
      embeddings?.orphans ?? null,
      "<=",
      t.maxOrphanEmbeddings,
    ),
    thresholdCheck(
      {
        id: "pending_memory_writes",
        label: "Memory writes waiting for approval",
        unit: "count",
        detail: "Writes held by the memory write approval mode until you approve them.",
      },
      pendingWrites?.pending ?? null,
      "<=",
      t.maxPendingWrites,
    ),
    thresholdCheck(
      {
        id: "database_size",
        label: "Profile database size",
        unit: "mib",
        detail: `Includes ${Math.round(counts.database.freelistBytes / MIB)} MiB of free pages.`,
      },
      Math.round((counts.database.totalBytes / MIB) * 10) / 10,
      "<=",
      t.maxDbMb,
    ),
  );

  const markers = counts.markers;
  const missing = markers?.filter((marker) => !marker.present).map((marker) => marker.key) ?? [];
  checks.push({
    id: "migration_markers",
    label: "Memory migrations",
    status: !markers ? "skip" : missing.length ? "warn" : "pass",
    value: markers ? markers.length - missing.length : null,
    op: ">=",
    threshold: markers?.length ?? 0,
    unit: "count",
    detail: !markers
      ? "No maintenance state recorded yet."
      : missing.length
        ? `Not finished yet: ${missing.join(", ")}.`
        : "Every one-time memory migration has finished.",
  });
  return checks;
}

export class MemoryHealthService {
  constructor(private readonly deps: MemoryHealthDeps) {}

  private now(): number {
    return Math.floor(this.deps.now?.() ?? Date.now());
  }

  async sources(workspaceId: string): Promise<MemorySourcesReport> {
    const counts = await this.deps.port.unit("memoryHealth_sources", { workspaceId });
    const supermemory = this.deps.getSupermemoryStatus();
    return {
      generatedAt: this.now(),
      workspaceId,
      facts: {
        total: counts.facts.total,
        bySource: counts.facts.bySource.map((row) => ({
          ...row,
          key: row.key as MemoryHubSource,
        })),
        byStore: counts.facts.byStore,
      },
      archive: {
        total: counts.archive.total,
        private: counts.archive.private,
        byType: counts.archive.byType,
        byOrigin: counts.archive.byOrigin,
      },
      imports: { archiveRows: counts.archive.imported, facts: counts.facts.imported },
      chronicle: {
        enabled: this.deps.getChronicleEnabled(),
        archiveRows: counts.archive.screenContext,
      },
      supermemory: {
        enabled: supermemory.enabled,
        connected: supermemory.connected,
        remoteRefs: counts.supermemoryRemoteRefs,
      },
      knowledgeGraph: counts.knowledgeGraph,
    };
  }

  async health(): Promise<MemoryHealthReport> {
    const now = this.now();
    const counts = await this.deps.port.unit("memoryHealth_check", {
      now,
      stuckAfterMs: MEMORY_HEALTH_STUCK_AFTER_MS,
    });
    const settings = this.deps.getSettings();
    const checks = evaluateMemoryHealth(counts, {
      llmEnabled: settings.dreamingLlmEnabled === true,
      llmDailyBudget: settings.dreamingLlmDailyTokenBudget ?? CURATION_LLM_DEFAULT_DAILY_BUDGET,
    });
    return {
      generatedAt: now,
      checks,
      ok: checks.every((check) => check.status !== "warn"),
    };
  }
}
