import { CoreMemoryCandidateRepository, CoreTraceRepository } from "./core-repository-facades";
import type { CoreMemoryCandidate, CoreMemoryCandidateType, CoreTrace } from "../../shared/types";
import type { SubconsciousTargetRef } from "../../shared/subconscious";

import { CoreMemoryScopeResolver } from "./CoreMemoryScopeResolver";
import { coreCandidateFingerprint, isRoutineCoreOutcome } from "./core-memory-hygiene";

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

export class CoreMemoryCandidateService {
  constructor(
    private readonly traceRepo: CoreTraceRepository,
    private readonly candidateRepo: CoreMemoryCandidateRepository,
    private readonly scopeResolver: CoreMemoryScopeResolver,
  ) {}

  async extractFromTrace(
    traceId: string,
    params?: { target?: SubconsciousTargetRef; sourceRunId?: string },
  ): Promise<CoreMemoryCandidate[]> {
    const trace = await this.traceRepo.findById(traceId);
    if (!trace) return [];
    const events = await this.traceRepo.listEvents(traceId);
    // Healthy "nothing to do" outcomes (idle, deferred, gated, cooldown, no fresh evidence)
    // are runtime telemetry, not evidence about the user or workspace.
    if (isRoutineCoreOutcome(trace, events)) return [];
    const candidates: Array<Omit<CoreMemoryCandidate, "id" | "createdAt">> = [];

    const normalized =
      `${trace.summary || ""}\n${events.map((event) => event.summary).join("\n")}`.toLowerCase();
    const scope = params?.target
      ? this.scopeResolver.resolveFromTarget(params.target, trace.profileId)
      : this.scopeResolver.resolveProfileScope(trace.profileId, trace.workspaceId);

    const pushCandidate = (
      candidateType: CoreMemoryCandidateType,
      summary: string,
      details: string,
      confidence: number,
      noveltyScore: number,
      stabilityScore: number,
    ) => {
      candidates.push({
        traceId: trace.id,
        profileId: trace.profileId,
        workspaceId: trace.workspaceId,
        scopeKind: scope.scopeKind,
        scopeRef: scope.scopeRef,
        candidateType,
        summary,
        details,
        confidence: clamp(confidence, 0, 1),
        noveltyScore: clamp(noveltyScore, 0, 1),
        stabilityScore: clamp(stabilityScore, 0, 1),
        status: "proposed",
        sourceRunId: params?.sourceRunId,
      });
    };

    if (trace.status === "failed") {
      pushCandidate(
        "watch_item",
        "Repeated autonomous failure path needs review",
        trace.error || trace.summary || "The core runtime hit a failed cycle.",
        0.74,
        0.62,
        0.58,
      );
    }

    if (
      normalized.includes("correct") ||
      normalized.includes("rejected") ||
      normalized.includes("invalidated")
    ) {
      pushCandidate(
        "correction",
        "Workflow intelligence should adjust a prior assumption",
        trace.summary || "The run produced a correction or invalidated a previous path.",
        0.78,
        0.58,
        0.7,
      );
    }

    if (normalized.includes("worktree")) {
      pushCandidate(
        "pattern",
        "Code-change automation prefers worktree-isolated execution",
        trace.summary || "A code automation path referenced worktree requirements.",
        0.83,
        0.47,
        0.84,
      );
    }

    if (normalized.includes("notification") || normalized.includes("notify")) {
      pushCandidate(
        "preference",
        "Operator favors notification-only outcomes when direct action is unnecessary",
        trace.summary || "The runtime used a notification-oriented action path.",
        0.68,
        0.42,
        0.66,
      );
    }

    if (
      trace.traceKind === "subconscious_cycle" &&
      (normalized.includes("dispatch") || normalized.includes("suggest"))
    ) {
      pushCandidate(
        "open_loop",
        "Workflow intelligence surfaced a reviewable next action",
        trace.summary || "Reflection produced a recommendation for the user to review.",
        0.78,
        0.46,
        0.66,
      );
    }

    if (
      trace.traceKind === "subconscious_cycle" &&
      (normalized.includes("no fresh evidence") || normalized.includes("slept"))
    ) {
      pushCandidate(
        "ignored_noise",
        "Workflow intelligence should ignore low-signal context like this",
        trace.summary || "Reflection found no fresh evidence worth surfacing.",
        0.76,
        0.44,
        0.72,
      );
    }

    if (
      normalized.includes("recurring") ||
      normalized.includes("cadence") ||
      normalized.includes("every ")
    ) {
      pushCandidate(
        "recurring_task",
        "This workflow may be recurring",
        trace.summary || "The trace suggests a repeated workflow or cadence.",
        0.76,
        0.52,
        0.62,
      );
    }

    // A pulse summary is the scheduler's decision reason, which is telemetry rather than an
    // open loop worth remembering.
    if (
      !candidates.length &&
      trace.status === "completed" &&
      trace.summary &&
      trace.traceKind !== "pulse_cycle"
    ) {
      pushCandidate("open_loop", trace.summary.slice(0, 140), trace.summary, 0.55, 0.31, 0.45);
    }

    if (!candidates.length) return [];
    return this.candidateRepo.upsertByFingerprint(this.dedupeCandidates(candidates));
  }

  async autoAcceptHighSignalCandidates(traceId: string): Promise<CoreMemoryCandidate[]> {
    const accepted: CoreMemoryCandidate[] = [];
    for (const candidate of await this.candidateRepo.listForTrace(traceId)) {
      if (candidate.status !== "proposed") continue;
      if (candidate.confidence < 0.75) continue;
      if (candidate.stabilityScore < 0.55) continue;
      const reviewed = await this.candidateRepo.review({
        id: candidate.id,
        status: "accepted",
        resolution: "Auto-accepted by hot-path learning threshold.",
      });
      if (reviewed) accepted.push(reviewed);
    }
    return accepted;
  }

  private dedupeCandidates(
    candidates: Array<Omit<CoreMemoryCandidate, "id" | "createdAt">>,
  ): Array<Omit<CoreMemoryCandidate, "id" | "createdAt">> {
    const seen = new Set<string>();
    const result: Array<Omit<CoreMemoryCandidate, "id" | "createdAt">> = [];
    for (const candidate of candidates) {
      const key = coreCandidateFingerprint(candidate);
      if (seen.has(key)) continue;
      seen.add(key);
      result.push(candidate);
    }
    return result;
  }
}
