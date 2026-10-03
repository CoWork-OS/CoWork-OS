import {
  CoreMemoryCandidateRepository,
  CoreMemoryDistillRunRepository,
  CoreMemoryScopeStateRepository,
  CoreTraceRepository,
} from "./core-repository-facades";
import { AutomationProfileRepository } from "../agents/agent-repository-facades";
import { WorkspaceRepository } from "../database/repository-facades";

import { MemoryService } from "../memory/MemoryService";
import { CuratedMemoryService } from "../memory/CuratedMemoryService";
import { MemoryFeaturesManager } from "../settings/memory-features-manager";

import type {
  CoreMemoryCandidate,
  CoreMemoryDistillRun,
  RunCoreMemoryDistillNowRequest,
} from "../../shared/types";

import { CoreMemoryScopeResolver } from "./CoreMemoryScopeResolver";
import { coreCandidateFingerprint } from "./core-memory-hygiene";

/** Outcome of writing a group of accepted candidates (duplicates of one fingerprint). */
interface CandidateApplyResult {
  written: boolean;
  appliedIds: string[];
}

export class CoreMemoryDistiller {
  constructor(
    private readonly traceRepo: CoreTraceRepository,
    private readonly candidateRepo: CoreMemoryCandidateRepository,
    private readonly distillRunRepo: CoreMemoryDistillRunRepository,
    private readonly scopeStateRepo: CoreMemoryScopeStateRepository,
    private readonly automationProfileRepo: AutomationProfileRepository,
    private readonly workspaceRepo: WorkspaceRepository,
    private readonly scopeResolver: CoreMemoryScopeResolver,
  ) {}

  async runHotPath(traceId: string): Promise<CoreMemoryDistillRun | undefined> {
    const trace = await this.traceRepo.findById(traceId);
    if (!trace) return undefined;
    const accepted = (await this.candidateRepo
      .listForTrace(traceId))
      .filter((candidate) => candidate.status === "accepted");
    if (!accepted.length) {
      return this.distillRunRepo.create({
        profileId: trace.profileId,
        workspaceId: trace.workspaceId,
        mode: "hot_path",
        sourceTraceCount: 1,
        candidateCount: 0,
        acceptedCount: 0,
        prunedCount: 0,
        status: "skipped",
        summary: { reason: "no_accepted_candidates" },
        startedAt: Date.now(),
        completedAt: Date.now(),
      });
    }
    const run = await this.distillRunRepo.create({
      profileId: trace.profileId,
      workspaceId: trace.workspaceId,
      mode: "hot_path",
      sourceTraceCount: 1,
      candidateCount: accepted.length,
      acceptedCount: 0,
      prunedCount: 0,
      status: "running",
      startedAt: Date.now(),
    });
    try {
      let written = 0;
      const appliedCandidateIds: string[] = [];
      for (const group of this.groupCandidates(accepted)) {
        const result = await this.applyCandidateGroup(group);
        if (result.written) written += 1;
        appliedCandidateIds.push(...result.appliedIds);
      }
      return await this.distillRunRepo.update(run.id, {
        status: "completed",
        acceptedCount: written,
        summary: {
          traceId,
          acceptedCandidateIds: accepted.map((item) => item.id),
          appliedCandidateIds,
        },
        completedAt: Date.now(),
      });
    } catch (error) {
      return this.distillRunRepo.update(run.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        completedAt: Date.now(),
      });
    }
  }

  async runOffline(request: RunCoreMemoryDistillNowRequest): Promise<CoreMemoryDistillRun> {
    const profile = await this.automationProfileRepo.findById(request.profileId);
    if (!profile) {
      throw new Error("Automation profile not found");
    }
    const run = await this.distillRunRepo.create({
      profileId: profile.id,
      workspaceId: request.workspaceId,
      mode: "offline",
      sourceTraceCount: 0,
      candidateCount: 0,
      acceptedCount: 0,
      prunedCount: 0,
      status: "running",
      startedAt: Date.now(),
    });
    try {
      const traces = await this.traceRepo.list({
        profileId: profile.id,
        workspaceId: request.workspaceId,
        limit: 100,
      });
      const candidates = await this.candidateRepo.list({
        profileId: profile.id,
        workspaceId: request.workspaceId,
        status: "accepted",
        limit: 200,
      });
      // Only `accepted` candidates are pending: once written they move to `applied`, so an
      // offline pass never captures the same candidate twice.
      let acceptedCount = 0;
      const appliedCandidateIds: string[] = [];
      for (const group of this.groupCandidates(candidates)) {
        const result = await this.applyCandidateGroup(group);
        if (result.written) acceptedCount += 1;
        appliedCandidateIds.push(...result.appliedIds);
      }
      // No layered-index refresh here: the index is rebuilt by its own guarded paths, and a
      // refresh from this background pass would run without workspace access checks.
      return (await this.distillRunRepo.update(run.id, {
        status: "completed",
        sourceTraceCount: traces.length,
        candidateCount: candidates.length,
        acceptedCount,
        summary: {
          traceIds: traces.map((trace) => trace.id),
          candidateIds: candidates.map((candidate) => candidate.id),
          appliedCandidateIds,
        },
        completedAt: Date.now(),
      }))!;
    } catch (error) {
      return (await this.distillRunRepo.update(run.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        completedAt: Date.now(),
      }))!;
    }
  }

  listRuns(profileId: string, workspaceId?: string, limit?: number) {
    return this.distillRunRepo.list({ profileId, workspaceId, limit });
  }

  /** Groups candidates by fingerprint; the highest-confidence one leads each group. */
  private groupCandidates(candidates: CoreMemoryCandidate[]): CoreMemoryCandidate[][] {
    const byKey = new Map<string, CoreMemoryCandidate[]>();
    for (const candidate of candidates) {
      const key = coreCandidateFingerprint(candidate);
      const group = byKey.get(key);
      if (group) group.push(candidate);
      else byKey.set(key, [candidate]);
    }
    return [...byKey.values()].map((group) =>
      [...group].sort((a, b) => b.confidence - a.confidence),
    );
  }

  /**
   * Writes the leading candidate of a duplicate group once and records the lifecycle: the
   * leader becomes `applied`, the rest `merged`. Candidates without a workspace cannot be
   * written and become `skipped`. When the capture is declined (for example memory capture is
   * off) the group stays `accepted` so a later pass can retry.
   */
  private async applyCandidateGroup(group: CoreMemoryCandidate[]): Promise<CandidateApplyResult> {
    const [leader, ...duplicates] = group;
    if (!leader.workspaceId) {
      await this.candidateRepo.markLifecycle(
        group.map((candidate) => candidate.id),
        "skipped",
        "Not written to memory: candidate has no workspace.",
      );
      return { written: false, appliedIds: [] };
    }
    const alreadyApplied = await this.candidateRepo.findAppliedDuplicate(leader);
    if (alreadyApplied) {
      await this.candidateRepo.markLifecycle(
        group.map((candidate) => candidate.id),
        "merged",
        `Merged into candidate ${alreadyApplied.id}, already written to memory.`,
      );
      return { written: false, appliedIds: [] };
    }
    const stored = await this.writeCandidateMemory(leader);
    if (!stored) return { written: false, appliedIds: [] };
    await this.candidateRepo.markLifecycle(
      [leader.id],
      "applied",
      `Written to memory ${stored.id}.`,
    );
    if (duplicates.length) {
      await this.candidateRepo.markLifecycle(
        duplicates.map((candidate) => candidate.id),
        "merged",
        `Merged into candidate ${leader.id}.`,
      );
    }
    await this.scopeStateRepo.touchDistill(leader.scopeKind, leader.scopeRef, Date.now());
    return { written: true, appliedIds: [leader.id] };
  }

  private async writeCandidateMemory(candidate: CoreMemoryCandidate) {
    const workspaceId = candidate.workspaceId;
    if (!workspaceId) return null;
    const type = this.mapCandidateToMemoryType(candidate);
    // Provenance (trace, candidate, scope) travels in the capture options and is stored as
    // observation metadata; keeping it out of the content lets identical memories dedupe.
    const content = `${candidate.summary}${candidate.details ? `\n${candidate.details}` : ""}`;
    const archiveEntry = await MemoryService.captureCoreMemory(
      workspaceId,
      undefined,
      type,
      content,
      false,
      {
        origin: "system",
        batchKey: `core-memory:${candidate.scopeKind}:${candidate.scopeRef}`,
        priority: "high",
        batchable: false,
        profileId: candidate.profileId,
        coreTraceId: candidate.traceId,
        candidateId: candidate.id,
        scopeKind: candidate.scopeKind,
        scopeRef: candidate.scopeRef,
      },
    );
    const shouldPromoteToCurated =
      MemoryFeaturesManager.loadSettings().autoPromoteToCuratedMemoryEnabled === true &&
      (candidate.candidateType === "preference" ||
        candidate.candidateType === "constraint" ||
        candidate.candidateType === "pattern" ||
        candidate.candidateType === "correction" ||
        candidate.candidateType === "recurring_task");
    if (shouldPromoteToCurated) {
      const curatedEntry = await CuratedMemoryService.upsertDistilledEntry({
        workspaceId,
        target: "workspace",
        kind: this.mapCandidateToCuratedKind(candidate),
        content: candidate.summary,
        confidence: candidate.confidence,
      });
      return curatedEntry || archiveEntry;
    }

    return archiveEntry;
  }

  private mapCandidateToMemoryType(candidate: CoreMemoryCandidate) {
    switch (candidate.candidateType) {
      case "preference":
        return "preference" as const;
      case "constraint":
        return "constraint" as const;
      case "pattern":
        return "workflow_pattern" as const;
      case "correction":
        return "correction_rule" as const;
      case "recurring_task":
        return "workflow_pattern" as const;
      case "ignored_noise":
        return "observation" as const;
      default:
        return "observation" as const;
    }
  }

  private mapCandidateToCuratedKind(candidate: CoreMemoryCandidate) {
    switch (candidate.candidateType) {
      case "preference":
        return "preference" as const;
      case "constraint":
        return "constraint" as const;
      case "pattern":
        return "workflow_rule" as const;
      case "correction":
        return "workflow_rule" as const;
      case "recurring_task":
        return "workflow_rule" as const;
      default:
        return "project_fact" as const;
    }
  }
}
