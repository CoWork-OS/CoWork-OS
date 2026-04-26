import { AutomationProfileRepository } from "../agents/AutomationProfileRepository";
import { MemoryService } from "../memory/MemoryService";
import { LayeredMemoryIndexService } from "../memory/LayeredMemoryIndexService";
import { CuratedMemoryService } from "../memory/CuratedMemoryService";
import { MemoryFeaturesManager } from "../settings/memory-features-manager";
import { WorkspaceRepository } from "../database/repositories";
import type {
  CoreMemoryCandidate,
  CoreMemoryDistillRun,
  RunCoreMemoryDistillNowRequest,
} from "../../shared/types";
import { CoreMemoryCandidateRepository } from "./CoreMemoryCandidateRepository";
import { CoreMemoryDistillRunRepository } from "./CoreMemoryDistillRunRepository";
import { CoreMemoryScopeResolver } from "./CoreMemoryScopeResolver";
import { CoreMemoryScopeStateRepository } from "./CoreMemoryScopeStateRepository";
import { CoreTraceRepository } from "./CoreTraceRepository";

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
    const trace = this.traceRepo.findById(traceId);
    if (!trace) return undefined;
    const accepted = this.candidateRepo
      .listForTrace(traceId)
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
    const run = this.distillRunRepo.create({
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
      for (const candidate of accepted) {
        const stored = await this.writeCandidateMemory(candidate);
        if (stored) {
          written += 1;
          this.scopeStateRepo.touchDistill(candidate.scopeKind, candidate.scopeRef, Date.now());
        }
      }
      return this.distillRunRepo.update(run.id, {
        status: "completed",
        acceptedCount: written,
        summary: { traceId, acceptedCandidateIds: accepted.map((item) => item.id) },
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
    const profile = this.automationProfileRepo.findById(request.profileId);
    if (!profile) {
      throw new Error("Automation profile not found");
    }
    const run = this.distillRunRepo.create({
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
      const traces = this.traceRepo.list({
        profileId: profile.id,
        workspaceId: request.workspaceId,
        limit: 100,
      });
      const candidates = this.candidateRepo.list({
        profileId: profile.id,
        workspaceId: request.workspaceId,
        status: "accepted",
        limit: 200,
      });
      let acceptedCount = 0;
      for (const candidate of this.mergeCandidates(candidates)) {
        const stored = await this.writeCandidateMemory(candidate);
        if (stored) {
          acceptedCount += 1;
          this.scopeStateRepo.touchDistill(candidate.scopeKind, candidate.scopeRef, Date.now());
        }
      }

      const workspacePath =
        request.workspaceId ? this.workspaceRepo.findById(request.workspaceId)?.path : undefined;
      if (request.workspaceId && workspacePath) {
        await LayeredMemoryIndexService.refreshIndex({
          workspaceId: request.workspaceId,
          workspacePath,
          taskPrompt: `Core memory distillation for profile ${profile.id}`,
        });
      }
      return this.distillRunRepo.update(run.id, {
        status: "completed",
        sourceTraceCount: traces.length,
        candidateCount: candidates.length,
        acceptedCount,
        summary: {
          traceIds: traces.map((trace) => trace.id),
          candidateIds: candidates.map((candidate) => candidate.id),
        },
        completedAt: Date.now(),
      })!;
    } catch (error) {
      return this.distillRunRepo.update(run.id, {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        completedAt: Date.now(),
      })!;
    }
  }

  listRuns(profileId: string, workspaceId?: string, limit?: number) {
    return this.distillRunRepo.list({ profileId, workspaceId, limit });
  }

  private mergeCandidates(candidates: CoreMemoryCandidate[]): CoreMemoryCandidate[] {
    const byKey = new Map<string, CoreMemoryCandidate>();
    for (const candidate of candidates) {
      const key = [
        candidate.scopeKind,
        candidate.scopeRef,
        candidate.candidateType,
        candidate.summary.toLowerCase(),
      ].join("::");
      const existing = byKey.get(key);
      if (!existing || candidate.confidence > existing.confidence) {
        byKey.set(key, candidate);
      }
    }
    return [...byKey.values()];
  }

  private async writeCandidateMemory(candidate: CoreMemoryCandidate) {
    const workspaceId = candidate.workspaceId;
    if (!workspaceId) return null;
    const type = this.mapCandidateToMemoryType(candidate);
    const content = `[core-trace:${candidate.traceId}] [scope:${candidate.scopeKind}:${candidate.scopeRef}] ${candidate.summary}${candidate.details ? `\n${candidate.details}` : ""}`;
    const archiveEntry = await MemoryService.captureCoreMemory(workspaceId, undefined, type, content, false, {
      origin: "system",
      batchKey: `core-memory:${candidate.scopeKind}:${candidate.scopeRef}`,
      priority: "high",
      batchable: false,
      profileId: candidate.profileId,
      coreTraceId: candidate.traceId,
      candidateId: candidate.id,
      scopeKind: candidate.scopeKind,
      scopeRef: candidate.scopeRef,
    });
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
