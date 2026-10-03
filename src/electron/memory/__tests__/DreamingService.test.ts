import { beforeEach, describe, expect, it } from "vitest";
import { DREAMING_WORKSPACE_COOLDOWN_MS, DreamingService } from "../DreamingService";
import type { MemoryWriter } from "../MemoryWriter";
import type { DreamingCandidate, DreamingRun } from "../../../shared/types";

// Curation itself is covered with a real database in memory-curation.test.ts; these tests
// cover run scheduling (cooldown, overlapping triggers) with a writer that is not ready.

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

    listRuns(request: { workspaceId?: string; limit?: number } = {}): DreamingRun[] {
      return Array.from(this.runs.values())
        .filter((run) => !request.workspaceId || run.workspaceId === request.workspaceId)
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, request.limit ?? 100);
    }

    listCandidates(request: { workspaceId?: string; limit?: number } = {}): DreamingCandidate[] {
      return Array.from(this.candidates.values())
        .filter(
          (candidate) => !request.workspaceId || candidate.workspaceId === request.workspaceId,
        )
        .slice(0, request.limit ?? 100);
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

  const curation = {
    archiveEvidence: async () => [],
    llmTokensSince: async () => 0,
    undoneFingerprints: async () => [],
  };

  /** A writer whose lane migration has not finished: runs complete as `skipped`. */
  function pendingWriter(gate?: Promise<void>): MemoryWriter {
    return {
      supportsCuration: true,
      repository: {
        isLaneMigrationComplete: async () => {
          await gate;
          return false;
        },
      },
    } as unknown as MemoryWriter;
  }

  function evidenceService(now: () => number) {
    return new DreamingService(repo as never, {
      now,
      curation,
      getWriter: () => pendingWriter(),
    });
  }

  const request = {
    workspaceId: "ws-1",
    workspacePath: "/tmp/ws-1",
    triggerSource: "heartbeat" as const,
    instructions: "memory drift",
  };

  it("applies a per-workspace cooldown to automatic triggers but not to manual runs", async () => {
    let clock = 10_000;
    const service = evidenceService(() => clock);

    const first = await service.run(request);
    clock += 60 * 60 * 1000;
    const second = await service.run({ ...request, triggerSource: "task_completion" });
    const otherWorkspace = await service.run({ ...request, workspaceId: "ws-2" });
    const manual = await service.run({ ...request, triggerSource: "manual" });

    expect(first.skipped).toBeUndefined();
    expect(second.skipped).toBe("cooldown");
    expect(second.run.id).toBe(first.run.id);
    expect(otherWorkspace.skipped).toBeUndefined();
    expect(manual.skipped).toBeUndefined();
    expect(repo.runs.size).toBe(3);

    clock += DREAMING_WORKSPACE_COOLDOWN_MS;
    expect((await service.run(request)).skipped).toBeUndefined();
  });

  it("shares one run between overlapping triggers for the same workspace", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const service = new DreamingService(repo as never, {
      now: () => 10_000,
      curation,
      getWriter: () => pendingWriter(gate),
    });

    const first = service.run(request);
    const overlapping = new DreamingService(repo as never, { curation }).run({
      ...request,
      triggerSource: "system",
    });
    release();
    const [firstResult, overlappingResult] = await Promise.all([first, overlapping]);

    expect(firstResult.skipped).toBeUndefined();
    expect(overlappingResult.skipped).toBe("in_flight");
    expect(overlappingResult.run.id).toBe(firstResult.run.id);
    expect(repo.runs.size).toBe(1);
  });
});
