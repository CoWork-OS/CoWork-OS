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
import type {
  MemoryRepoDreamsReport,
  MemoryRepoStatusReport,
} from "../../shared/memory-repo-types";
import type { MemoryFeaturesSettings } from "../../shared/types";
import { CURATION_LLM_DEFAULT_DAILY_BUDGET } from "./memory-curation-llm";
import type { MemoryHealthCounts } from "./memory-health-sql";
import type { MemoryStatementPort } from "./memory-statement-port";
import { MEMORY_REPO_LIMITS } from "./repo/memory-repo-format";

const MIB = 1024 * 1024;

export interface MemoryHealthDeps {
  port: Pick<MemoryStatementPort, "unit">;
  getSettings: () => MemoryFeaturesSettings;
  /** Supermemory switch and whether it has credentials (never the credentials). */
  getSupermemoryStatus: () => { enabled: boolean; connected: boolean };
  getChronicleEnabled: () => boolean;
  /**
   * The memory folder's status (memory repo, design §9). Service-only: the repo lives on
   * disk, not in the database `qa:memory-health` reads, so the script has no such check.
   */
  getMemoryRepoStatus?: () => Promise<MemoryRepoStatusReport>;
  /** Dreams over the memory folder (Phase 2 design §7). Service-only, like the folder checks. */
  getMemoryRepoDreams?: () => Promise<MemoryRepoDreamsReport>;
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

/**
 * The memory folder checks: SKIP when it is off; WARN when it is not ready, git is missing,
 * the work tree has uncommitted changes, MEMORY.md is over its size limit, or the last write
 * failed; the inbox count as INFO. A null status (it could not be read) is a WARN. Not part
 * of `qa:memory-health` (no database counts).
 */
export function evaluateMemoryRepoHealth(status: MemoryRepoStatusReport | null): MemoryHealthCheck[] {
  const base = { id: "memory_repo", label: "Memory folder", value: null };
  if (!status) {
    return [{ ...base, status: "warn", detail: "The memory folder status could not be read." }];
  }
  if (!status.enabled) {
    return [{ ...base, status: "skip", detail: "The memory folder (beta) is off." }];
  }
  if (!status.ready) {
    return [
      {
        ...base,
        status: "warn",
        detail: `Not ready at ${status.root}: ${status.problem ?? "the folder could not be opened"}.`,
      },
    ];
  }
  const problems: string[] = [];
  if (!status.gitAvailable) problems.push("git not found: memory has no history");
  else if (status.clean === false) {
    problems.push("the folder has changes CoWork has not committed yet (they are committed before the next write)");
  }
  if (status.lastWriteError) problems.push(`the last write failed: ${status.lastWriteError}`);
  const checks: MemoryHealthCheck[] = [
    {
      ...base,
      status: problems.length ? "warn" : "pass",
      detail: problems.length
        ? `${problems.join("; ")}.`
        : `Ready at ${status.root}; every change is committed.`,
    },
  ];
  checks.push(
    thresholdCheck(
      {
        id: "memory_repo_entry_file",
        label: "MEMORY.md size",
        unit: "bytes",
        detail: "MEMORY.md is in every prompt; the writer refuses entries past this size.",
      },
      typeof status.entryFileBytes === "number" ? status.entryFileBytes : null,
      "<=",
      MEMORY_REPO_LIMITS.entryFileBytes,
      "MEMORY.md could not be read.",
    ),
  );
  const inbox = status.inboxEntries ?? 0;
  checks.push({
    id: "memory_repo_inbox",
    label: "Memory inbox",
    status: "info",
    value: inbox,
    unit: "count",
    detail: inbox
      ? `${inbox} ${inbox === 1 ? "entry" : "entries"} in inbox.md from tasks that read untrusted content, waiting for review.`
      : "inbox.md is empty.",
  });
  return checks;
}

const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * "Memory folder dreaming" (docs/memory-repo-phase2-design.md §7): SKIP while the folder or
 * dreaming is off; WARN when a dream failed in the last 7 days or a review has waited longer
 * than 7 days; otherwise INFO with the last run.
 */
export function evaluateMemoryRepoDreamHealth(
  status: MemoryRepoStatusReport | null,
  report: MemoryRepoDreamsReport | null,
  now: number,
): MemoryHealthCheck {
  const base = { id: "memory_repo_dreaming", label: "Memory folder dreaming", value: null };
  if (!status?.enabled || !status.ready) {
    return { ...base, status: "skip", detail: "The memory folder is off or not ready." };
  }
  if (!report) {
    return { ...base, status: "warn", detail: "The dream records could not be read." };
  }
  if (!report.dreamingEnabled) {
    return { ...base, status: "skip", detail: "Dreaming over the memory folder is off." };
  }
  const ran = report.dreams.filter((dream) => dream.status !== "skipped");
  const last = ran[0] ?? report.dreams[0];
  const failed = report.dreams.filter(
    (dream) => dream.status === "failed" && dream.startedAt >= now - WEEK_MS,
  );
  const waiting = report.dreams.filter(
    (dream) => dream.reviewStatus === "pending" && dream.finishedAt < now - WEEK_MS,
  );
  const problems: string[] = [];
  if (failed.length) {
    problems.push(
      `${failed.length} ${failed.length === 1 ? "dream" : "dreams"} failed in the last 7 days (last: ${failed[0].error ?? "unknown error"})`,
    );
  }
  if (waiting.length) {
    problems.push(
      `${waiting.length} ${waiting.length === 1 ? "proposal has" : "proposals have"} waited for review more than 7 days`,
    );
  }
  const lastLine = last
    ? `Last dream ${new Date(last.startedAt).toISOString().slice(0, 16).replace("T", " ")} UTC`
    : "No dream yet";
  const pending = report.pendingReviews ? `; ${report.pendingReviews} waiting for review` : "";
  return {
    ...base,
    status: problems.length ? "warn" : "info",
    value: report.pendingReviews,
    unit: "count",
    detail: problems.length
      ? `${problems.join("; ")}. ${lastLine}.`
      : `${lastLine}${pending}; ${report.tokensUsedToday.toLocaleString("en-US")} of ${report.dailyBudget.toLocaleString("en-US")} tokens used today.`,
  };
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
    if (this.deps.getMemoryRepoStatus) {
      const repo = await this.deps.getMemoryRepoStatus().catch(() => null);
      checks.push(...evaluateMemoryRepoHealth(repo));
      if (this.deps.getMemoryRepoDreams) {
        const dreams =
          repo?.enabled && repo.ready
            ? await this.deps.getMemoryRepoDreams().catch(() => null)
            : null;
        checks.push(evaluateMemoryRepoDreamHealth(repo, dreams, now));
      }
    }
    return {
      generatedAt: now,
      checks,
      ok: checks.every((check) => check.status !== "warn"),
    };
  }
}
