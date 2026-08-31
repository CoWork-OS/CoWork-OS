import { createHash } from "crypto";
import type {
  CoreFailureCategory,
  CoreFailureRecord,
  CoreFailureSeverity,
  CoreTrace,
  CoreTraceEvent,
} from "../../shared/types";
import { CoreFailureRecordRepository } from "./CoreFailureRecordRepository";
import { CoreTraceRepository } from "./CoreTraceRepository";

function hashParts(parts: Array<string | undefined>): string {
  const hash = createHash("sha1");
  hash.update(parts.filter(Boolean).join("::"));
  return hash.digest("hex");
}

function classifyCategory(text: string): CoreFailureCategory {
  if (text.includes("cooldown")) return "cooldown_policy_mismatch";
  if (text.includes("active hours") || text.includes("outside active hours")) return "wake_timing";
  if (text.includes("budget") || text.includes("dispatch budget")) return "budget_policy_mismatch";
  if (text.includes("duplicate") || text.includes("redundant")) return "subconscious_duplication";
  if (
    text.includes("no evidence") ||
    text.includes("low signal") ||
    text.includes("insufficient evidence")
  ) {
    return "subconscious_low_signal";
  }
  if (text.includes("stale")) return "memory_staleness";
  if (
    text.includes("memory") &&
    (text.includes("noise") || text.includes("merged") || text.includes("novelty"))
  ) {
    return "memory_noise";
  }
  if (text.includes("routing") || text.includes("wrong target") || text.includes("notify-only")) {
    return "routing_mismatch";
  }
  if (text.includes("no dispatch") || text.includes("deferred") || text.includes("sleep")) {
    return "dispatch_underreach";
  }
  if (text.includes("overreach") || text.includes("too many dispatch") || text.includes("spam")) {
    return "dispatch_overreach";
  }
  if (text.includes("workspace context") || text.includes("missing context")) {
    return "workspace_context_gap";
  }
  return "unknown";
}

function classifySeverity(trace: CoreTrace, text: string): CoreFailureSeverity {
  if (trace.status === "failed") return "high";
  if (text.includes("critical")) return "critical";
  if (text.includes("blocked") || text.includes("no evidence") || text.includes("duplicate"))
    return "medium";
  return "low";
}

export class CoreFailureMiningService {
  constructor(
    private readonly traceRepo: CoreTraceRepository,
    private readonly failureRepo: CoreFailureRecordRepository,
  ) {}

  mineTrace(traceId: string): CoreFailureRecord[] {
    const existing = this.failureRepo.findByTraceId(traceId);
    if (existing.length > 0) return existing;
    const trace = this.traceRepo.findById(traceId);
    if (!trace) return [];
    const events = this.traceRepo.listEvents(traceId);
    const candidates = this.buildCandidates(trace, events);
    return candidates.map((candidate) => this.failureRepo.create(candidate));
  }

  private buildCandidates(
    trace: CoreTrace,
    events: CoreTraceEvent[],
  ): Array<Omit<CoreFailureRecord, "id">> {
    const text = [
      trace.summary,
      trace.error,
      ...events.map((event) => event.summary),
      ...events.map((event) => JSON.stringify(event.details || {})),
    ]
      .filter(Boolean)
      .join("\n")
      .toLowerCase();

    const inferred: Array<{ summary: string; details?: string }> = [];
    if (trace.status === "failed") {
      inferred.push({
        summary: trace.summary || trace.error || "Core runtime trace failed",
        details: trace.error,
      });
    }

    for (const event of events) {
      const eventType = event.eventType.toLowerCase();
      if (
        event.phase === "error" ||
        eventType.includes("error") ||
        eventType.includes("failed") ||
        eventType.includes("no_evidence") ||
        eventType.includes("dispatch_skipped") ||
        eventType.includes("no_work") ||
        eventType.includes("deferred")
      ) {
        inferred.push({
          summary: event.summary,
          details: event.details ? JSON.stringify(event.details) : undefined,
        });
      }
    }

    if (!inferred.length && trace.status === "skipped") {
      inferred.push({
        summary: trace.summary || "Core runtime skipped work",
        details: trace.error,
      });
    }

    const deduped = new Map<string, { summary: string; details?: string }>();
    for (const item of inferred) {
      const normalized = (item.summary || "").trim();
      if (!normalized) continue;
      deduped.set(normalized.toLowerCase(), item);
    }

    return [...deduped.values()].map((item) => {
      const mergedText = `${text}\n${item.summary}\n${item.details || ""}`.toLowerCase();
      const category = classifyCategory(mergedText);
      const severity = classifySeverity(trace, mergedText);
      return {
        traceId: trace.id,
        profileId: trace.profileId,
        workspaceId: trace.workspaceId,
        targetKey: trace.targetKey,
        category,
        severity,
        fingerprint: hashParts([
          trace.profileId,
          trace.workspaceId,
          trace.sourceSurface,
          trace.traceKind,
          trace.targetKey,
          category,
          item.summary.toLowerCase().replace(/\s+/g, " ").slice(0, 160),
        ]),
        summary: item.summary,
        details: item.details,
        status: "open",
        sourceSurface: trace.sourceSurface,
        taskId: trace.taskId,
        createdAt: trace.completedAt || trace.createdAt,
      };
    });
  }
}
