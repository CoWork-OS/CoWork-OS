import { beforeEach, describe, expect, it, vi } from "vitest";
import { DreamingService } from "../DreamingService";
import type {
  CuratedMemoryEntry,
  DreamingCandidate,
  DreamingRun,
  MemoryObservationSearchResult,
} from "../../../shared/types";

describe("DreamingService", () => {
  let repo: FakeDreamingRepository;

  class FakeDreamingRepository {
    runs = new Map<string, DreamingRun>();
    candidates = new Map<string, DreamingCandidate>();

    createRun(
      input: Omit<DreamingRun, "id" | "createdAt"> & { id?: string; createdAt?: number },
    ): DreamingRun {
      const run: DreamingRun = {
        ...input,
        id: input.id || `run-${this.runs.size + 1}`,
        createdAt: input.createdAt ?? 1000,
      };
      this.runs.set(run.id, run);
      return run;
    }

    updateRun(id: string, patch: Partial<DreamingRun>): DreamingRun | undefined {
      const current = this.runs.get(id);
      if (!current) return undefined;
      const next = { ...current, ...patch };
      this.runs.set(id, next);
      return next;
    }

    bulkCreateCandidates(
      inputs: Array<
        Omit<DreamingCandidate, "id" | "createdAt"> & { id?: string; createdAt?: number }
      >,
    ): DreamingCandidate[] {
      return inputs.map((input) => {
        const candidate: DreamingCandidate = {
          ...input,
          id: input.id || `candidate-${this.candidates.size + 1}`,
          createdAt: input.createdAt ?? 1000,
        };
        this.candidates.set(candidate.id, candidate);
        return candidate;
      });
    }

    findCandidateById(id: string): DreamingCandidate | undefined {
      return this.candidates.get(id);
    }

    reviewCandidate(input: {
      id: string;
      status: DreamingCandidate["status"];
      resolution?: string;
    }): DreamingCandidate | undefined {
      const current = this.candidates.get(input.id);
      if (!current) return undefined;
      const next = {
        ...current,
        status: input.status,
        resolution: input.resolution,
        reviewedAt: 1000,
      };
      this.candidates.set(input.id, next);
      return next;
    }
  }

  beforeEach(() => {
    repo = new FakeDreamingRepository();
  });

  function observation(
    overrides: Partial<MemoryObservationSearchResult> = {},
  ): MemoryObservationSearchResult {
    return {
      memoryId: "mem-1",
      workspaceId: "ws-1",
      title: "Correction captured",
      snippet: "Actually use Vite 7 instead of the old build guidance. Follow up on the migration.",
      observationType: "correction",
      origin: "task",
      sourceLabel: "Memory",
      privacyState: "normal",
      concepts: ["Vite", "migration"],
      filesRead: [],
      filesModified: [],
      tools: [],
      sourceEventIds: [],
      createdAt: 100,
      rank: 1,
      estimatedDetailTokens: 24,
      ...overrides,
    };
  }

  function curated(overrides: Partial<CuratedMemoryEntry> = {}): CuratedMemoryEntry {
    return {
      id: "curated-1",
      workspaceId: "ws-1",
      target: "workspace",
      kind: "project_fact",
      content: "Use Vite 6 for renderer builds",
      normalizedKey: "use vite 6 for renderer builds",
      source: "agent_tool",
      confidence: 0.85,
      status: "active",
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    };
  }

  it("turns correction and open-loop evidence into proposed Dreaming candidates", async () => {
    const service = new DreamingService(repo as never, {
      now: () => 1000,
      searchMemoryObservations: () => [observation()],
      searchTranscriptSpans: async () => [],
      loadRecentTranscriptSpans: async () => [],
      listCuratedEntries: () => [],
    });

    const result = await service.run({
      workspaceId: "ws-1",
      workspacePath: "/tmp/ws-1",
      triggerSource: "heartbeat",
      triggerHeartbeatRunId: "hb-1",
      instructions: "memory drift",
    });

    expect(result.run.status).toBe("completed");
    expect(result.candidates.map((candidate) => candidate.action)).toEqual(
      expect.arrayContaining(["correction", "open_loop"]),
    );
    expect(result.candidates[0]?.evidenceRefs[0]?.sourceUrlOrPath).toBe("memory:mem-1");
  });

  it("does not apply curated-memory candidates until they are accepted", async () => {
    const applyCuratedMemory = vi.fn(async () => ({ success: true }));
    const service = new DreamingService(repo as never, {
      now: () => 1000,
      searchMemoryObservations: () => [
        observation({ snippet: "Use Vite 6 for renderer builds is outdated." }),
      ],
      searchTranscriptSpans: async () => [],
      loadRecentTranscriptSpans: async () => [],
      listCuratedEntries: () => [curated()],
      applyCuratedMemory,
    });

    const result = await service.run({
      workspaceId: "ws-1",
      workspacePath: "/tmp/ws-1",
      triggerSource: "task_completion",
      sourceTaskId: "task-1",
      taskPrompt: "Vite migration",
    });
    const archiveCandidate = result.candidates.find(
      (candidate) => candidate.action === "curated_archive",
    );

    expect(archiveCandidate).toBeTruthy();
    expect(applyCuratedMemory).not.toHaveBeenCalled();

    repo.reviewCandidate({ id: archiveCandidate!.id, status: "accepted" });
    const applied = await service.applyAcceptedCandidate(archiveCandidate!.id, "ws-1");

    expect(applyCuratedMemory).toHaveBeenCalledOnce();
    expect(applied?.status).toBe("applied");
  });
});
