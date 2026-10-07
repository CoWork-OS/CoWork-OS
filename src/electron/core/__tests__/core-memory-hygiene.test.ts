import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CoreTrace, CoreTraceEvent } from "../../../shared/types";
import { CuratedMemoryService } from "../../memory/CuratedMemoryService";
import { MemoryService } from "../../memory/MemoryService";
import { MemoryFeaturesManager } from "../../settings/memory-features-manager";
import { CoreFailureMiningService } from "../CoreFailureMiningService";
import { CoreLearningsStore } from "../CoreLearningsRepository";
import { CoreMemoryCandidateService } from "../CoreMemoryCandidateService";
import { CoreMemoryCandidateStore } from "../CoreMemoryCandidateRepository";
import { CORE_MEMORY_CLEANUP_MARKER, CoreMemoryCleanupStore } from "../CoreMemoryCleanupRepository";
import { CoreMemoryDistiller } from "../CoreMemoryDistiller";
import { CoreMemoryScopeResolver } from "../CoreMemoryScopeResolver";
import {
  coreCandidateFingerprint,
  isRoutineCoreOutcome,
  normalizeCandidateSummary,
} from "../core-memory-hygiene";

const nativeSqliteAvailable = (() => {
  try {
    new Database(":memory:").close();
    return true;
  } catch {
    return false;
  }
})();
const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

const DAY = 24 * 60 * 60 * 1000;

function createSchema(db: Database.Database) {
  db.exec(`
    CREATE TABLE core_memory_candidates (
      id TEXT PRIMARY KEY, trace_id TEXT NOT NULL, profile_id TEXT NOT NULL, workspace_id TEXT,
      scope_kind TEXT NOT NULL, scope_ref TEXT NOT NULL, candidate_type TEXT NOT NULL,
      summary TEXT NOT NULL, details TEXT, confidence REAL NOT NULL, novelty_score REAL NOT NULL,
      stability_score REAL NOT NULL, status TEXT NOT NULL, resolution TEXT, source_run_id TEXT,
      created_at INTEGER NOT NULL, resolved_at INTEGER
    );
    CREATE TABLE core_learnings_log (
      id TEXT PRIMARY KEY, profile_id TEXT NOT NULL, workspace_id TEXT, kind TEXT NOT NULL,
      summary TEXT NOT NULL, details TEXT, related_cluster_id TEXT, related_experiment_id TEXT,
      created_at INTEGER NOT NULL
    );
    CREATE TABLE memories (
      id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, task_id TEXT, type TEXT NOT NULL,
      content TEXT NOT NULL, summary TEXT, tokens INTEGER NOT NULL DEFAULT 0,
      is_compressed INTEGER NOT NULL DEFAULT 0, is_private INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
    );
    CREATE TABLE memory_embeddings (
      memory_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, embedding TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE memory_observation_metadata (
      memory_id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, content_hash TEXT NOT NULL
    );
  `);
}

function trace(overrides: Partial<CoreTrace> = {}): CoreTrace {
  return {
    id: "trace-1",
    profileId: "profile-1",
    workspaceId: "ws-1",
    sourceSurface: "subconscious",
    traceKind: "subconscious_cycle",
    status: "completed",
    summary: "Reflection suggested a dispatch for the release checklist",
    startedAt: 1,
    createdAt: 1,
    ...overrides,
  } as CoreTrace;
}

function event(eventType: string, phase = "decision", summary = eventType): CoreTraceEvent {
  return { id: eventType, traceId: "trace-1", phase, eventType, summary, createdAt: 1 } as never;
}

describe("core memory hygiene rules", () => {
  it("treats idle, deferred, gated and no-evidence outcomes as routine", () => {
    expect(isRoutineCoreOutcome(trace(), [event("heartbeat.idle")])).toBe(true);
    expect(isRoutineCoreOutcome(trace(), [event("heartbeat.deferred", "gating")])).toBe(true);
    expect(isRoutineCoreOutcome(trace(), [event("heartbeat.gated", "gating")])).toBe(true);
    expect(isRoutineCoreOutcome(trace(), [event("subconscious.no_evidence", "evidence")])).toBe(
      true,
    );
    expect(isRoutineCoreOutcome(trace({ summary: "Dispatch cooldown active" }), [])).toBe(true);
  });

  it("never treats failures or dispatches as routine", () => {
    expect(isRoutineCoreOutcome(trace({ status: "failed" }), [event("heartbeat.idle")])).toBe(
      false,
    );
    expect(
      isRoutineCoreOutcome(trace(), [
        event("heartbeat.idle"),
        event("heartbeat.dispatch_started", "dispatch"),
      ]),
    ).toBe(false);
    expect(isRoutineCoreOutcome(trace(), [event("subconscious.decision_synthesized")])).toBe(false);
  });

  it("normalizes trace prefixes, ids and numbers out of candidate summaries", () => {
    expect(
      normalizeCandidateSummary(
        "[core-trace:4f9c2d1e-1111-2222-3333-444455556666] [scope:workspace:ws-1] Signal strength 0.82 crossed!",
      ),
    ).toBe(normalizeCandidateSummary("Signal strength 0.91 crossed"));
    const base = {
      profileId: "p",
      scopeKind: "workspace" as const,
      scopeRef: "ws",
      candidateType: "pattern" as const,
    };
    expect(coreCandidateFingerprint({ ...base, summary: "Use worktrees." })).toBe(
      coreCandidateFingerprint({ ...base, summary: "use   WORKTREES" }),
    );
    expect(coreCandidateFingerprint({ ...base, summary: "Use worktrees" })).not.toBe(
      coreCandidateFingerprint({ ...base, scopeRef: "other", summary: "Use worktrees" }),
    );
  });
});

describe("CoreFailureMiningService", () => {
  function mine(t: CoreTrace, events: CoreTraceEvent[]) {
    const created: unknown[] = [];
    const service = new CoreFailureMiningService(
      { findById: async () => t, listEvents: async () => events } as never,
      {
        findByTraceId: async () => [],
        create: async (record: unknown) => {
          created.push(record);
          return record;
        },
      } as never,
    );
    return service.mineTrace(t.id).then(() => created);
  }

  it("does not record healthy deferred, idle or no-evidence runs as failures", async () => {
    const pulse = trace({ sourceSurface: "heartbeat", traceKind: "pulse_cycle" });
    expect(await mine(pulse, [event("heartbeat.deferred", "gating", "Foreground work")])).toEqual(
      [],
    );
    expect(await mine(pulse, [event("heartbeat.idle", "decision", "cooldown")])).toEqual([]);
    expect(
      await mine(trace(), [event("subconscious.no_evidence", "evidence", "No fresh evidence")]),
    ).toEqual([]);
  });

  it("still records failed runs", async () => {
    const failed = trace({ status: "failed", error: "boom", summary: "Run failed" });
    const records = await mine(failed, [event("subconscious.error", "error", "boom")]);
    expect(records.length).toBeGreaterThan(0);
  });
});

describeWithSqlite("core memory candidates, distillation and cleanup", () => {
  let db: Database.Database;
  let store: CoreMemoryCandidateStore;

  beforeEach(() => {
    db = new Database(":memory:");
    createSchema(db);
    store = new CoreMemoryCandidateStore(db);
  });

  afterEach(() => {
    db.close();
    vi.restoreAllMocks();
  });

  function candidateService(t: CoreTrace, events: CoreTraceEvent[]) {
    return new CoreMemoryCandidateService(
      { findById: async () => t, listEvents: async () => events } as never,
      store as never,
      new CoreMemoryScopeResolver(),
    );
  }

  function countCandidates(): number {
    return (db.prepare("SELECT COUNT(*) AS n FROM core_memory_candidates").get() as { n: number })
      .n;
  }

  it("creates no candidates for cooldown, idle or no-evidence pulses", async () => {
    const pulse = trace({
      sourceSurface: "heartbeat",
      traceKind: "pulse_cycle",
      summary: "Dispatch cooldown active",
    });
    await candidateService(pulse, [
      event("heartbeat.idle", "decision", "Dispatch cooldown active"),
    ]).extractFromTrace("trace-1");
    await candidateService(
      trace({
        sourceSurface: "heartbeat",
        traceKind: "pulse_cycle",
        summary: "Outside active hours.",
      }),
      [event("heartbeat.gated", "gating")],
    ).extractFromTrace("trace-1");
    await candidateService(trace({ summary: "No fresh evidence was worth acting on right now." }), [
      event("subconscious.no_evidence", "evidence"),
    ]).extractFromTrace("trace-1");
    expect(countCandidates()).toBe(0);
  });

  it("does not turn a dispatching pulse's decision reason into an open loop", async () => {
    const pulse = trace({
      sourceSurface: "heartbeat",
      traceKind: "pulse_cycle",
      summary: "dispatch_task: Signal strength 0.91 crossed dispatch threshold",
    });
    await candidateService(pulse, [
      event("heartbeat.dispatch_completed", "dispatch"),
    ]).extractFromTrace("trace-1");
    expect(countCandidates()).toBe(0);
  });

  it("reinforces an existing candidate instead of inserting a duplicate", async () => {
    const first = await candidateService(trace({ id: "trace-1" }), []).extractFromTrace("trace-1");
    expect(first).toHaveLength(1);
    const second = await candidateService(trace({ id: "trace-2" }), []).extractFromTrace("trace-2");
    expect(countCandidates()).toBe(1);
    expect(second[0].id).toBe(first[0].id);
    expect(second[0].traceId).toBe("trace-2");
  });

  it("does not re-propose a candidate the user rejected", async () => {
    const [created] = await candidateService(trace(), []).extractFromTrace("trace-1");
    store.review({ id: created.id, status: "rejected" });
    const again = await candidateService(trace({ id: "trace-9" }), []).extractFromTrace("trace-9");
    expect(countCandidates()).toBe(1);
    expect(again[0].status).toBe("rejected");
    expect(store.findById(created.id)?.traceId).toBe("trace-1");
  });

  describe("CoreMemoryDistiller", () => {
    function seedAccepted(id: string, overrides: Record<string, unknown> = {}) {
      return store.create({
        id,
        traceId: "trace-1",
        profileId: "profile-1",
        workspaceId: "ws-1",
        scopeKind: "workspace",
        scopeRef: "ws-1",
        candidateType: "pattern",
        summary: "Code-change automation prefers worktree-isolated execution",
        details: "Observed in a worktree run.",
        confidence: 0.83,
        noveltyScore: 0.47,
        stabilityScore: 0.84,
        status: "accepted",
        ...overrides,
      } as never);
    }

    function distiller() {
      const run = { id: "run-1" } as Record<string, unknown>;
      return new CoreMemoryDistiller(
        { findById: async () => trace(), list: async () => [] } as never,
        store as never,
        {
          create: async (input: Record<string, unknown>) => ({ ...run, ...input }),
          update: async (_id: string, patch: Record<string, unknown>) => ({ ...run, ...patch }),
        } as never,
        { touchDistill: vi.fn(async () => undefined) } as never,
        { findById: async () => ({ id: "profile-1" }) } as never,
        {} as never,
        new CoreMemoryScopeResolver(),
      );
    }

    beforeEach(() => {
      vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
        autoPromoteToCuratedMemoryEnabled: false,
      } as never);
      vi.spyOn(CuratedMemoryService, "upsertDistilledEntry").mockResolvedValue(null);
    });

    it("writes accepted candidates exactly once and keeps the trace id out of the content", async () => {
      const capture = vi
        .spyOn(MemoryService, "captureCoreMemory")
        .mockResolvedValue({ id: "mem-1" } as never);
      seedAccepted("c-1");
      seedAccepted("c-2", { traceId: "trace-2", confidence: 0.6 });

      await distiller().runHotPath("trace-1");
      await distiller().runOffline({ profileId: "profile-1" });
      await distiller().runOffline({ profileId: "profile-1" });

      expect(capture).toHaveBeenCalledTimes(1);
      const [, , , content, , options] = capture.mock.calls[0];
      expect(content).not.toContain("core-trace");
      expect(content).not.toContain("[scope:");
      // Provenance is the candidate's applied note, not capture options nobody stores.
      expect(options).not.toHaveProperty("coreTraceId");
      expect(options).not.toHaveProperty("candidateId");
      expect(store.findById("c-1")?.status).toBe("applied");
      expect(store.findById("c-2")?.status).toBe("merged");
    });

    it("marks candidates without a workspace as skipped", async () => {
      const capture = vi.spyOn(MemoryService, "captureCoreMemory");
      seedAccepted("c-3", { workspaceId: undefined });
      await distiller().runOffline({ profileId: "profile-1" });
      expect(capture).not.toHaveBeenCalled();
      expect(store.findById("c-3")?.status).toBe("skipped");
    });

    it("keeps a candidate accepted for retry when the capture is declined", async () => {
      vi.spyOn(MemoryService, "captureCoreMemory").mockResolvedValue(null);
      seedAccepted("c-4");
      await distiller().runOffline({ profileId: "profile-1" });
      expect(store.findById("c-4")?.status).toBe("accepted");
    });
  });

  describe("CoreLearningsStore.appendIfNovel", () => {
    it("does not log the same learning twice within the window", () => {
      const learnings = new CoreLearningsStore(db);
      const entry = {
        profileId: "profile-1",
        kind: "eval_case" as const,
        summary: "Maintained living eval coverage for wake timing.",
        relatedClusterId: "cluster-1",
      };
      learnings.appendIfNovel({ ...entry, createdAt: 1_000 }, DAY);
      learnings.appendIfNovel({ ...entry, createdAt: 2_000 }, DAY);
      learnings.appendIfNovel({ ...entry, relatedClusterId: "cluster-2", createdAt: 3_000 }, DAY);
      expect(learnings.list({ profileId: "profile-1" })).toHaveLength(2);
      learnings.appendIfNovel({ ...entry, createdAt: 1_000 + DAY + 1 }, DAY);
      expect(learnings.list({ profileId: "profile-1" })).toHaveLength(3);
    });
  });

  describe("CoreMemoryCleanupStore", () => {
    const now = 100 * DAY;

    function insertCandidate(
      id: string,
      summary: string,
      status: string,
      createdAt: number,
      extra: { type?: string; workspaceId?: string | null } = {},
    ) {
      db.prepare(
        `INSERT INTO core_memory_candidates (id, trace_id, profile_id, workspace_id, scope_kind,
          scope_ref, candidate_type, summary, confidence, novelty_score, stability_score, status,
          created_at) VALUES (?, 't', 'p', ?, 'workspace', 'ws', ?, ?, 0.8, 0.5, 0.7, ?, ?)`,
      ).run(
        id,
        extra.workspaceId === undefined ? "ws" : extra.workspaceId,
        extra.type || "open_loop",
        summary,
        status,
        createdAt,
      );
    }

    function insertMemory(id: string, content: string, createdAt: number) {
      db.prepare(
        `INSERT INTO memories (id, workspace_id, type, content, created_at, updated_at)
         VALUES (?, 'ws', 'observation', ?, ?, ?)`,
      ).run(id, content, createdAt, createdAt);
      db.prepare(
        "INSERT INTO memory_embeddings (memory_id, workspace_id, embedding, updated_at) VALUES (?, 'ws', '[]', 0)",
      ).run(id);
      db.prepare(
        "INSERT INTO memory_observation_metadata (memory_id, workspace_id, content_hash) VALUES (?, 'ws', 'h')",
      ).run(id);
    }

    it("v2 dismisses retired-heuristic proposals once and keeps failure watch items", () => {
      insertCandidate(
        "p1",
        "Operator favors notification-only outcomes when direct action is unnecessary",
        "proposed",
        now - 200 * DAY,
        { type: "preference" },
      );
      insertCandidate("p2", "Core automation is tracking an active line of work", "proposed", now, {
        type: "project_state",
      });
      insertCandidate("p3", "Foreground work active; deferred 61 merged signals", "proposed", now);
      insertCandidate("w1", "Repeated autonomous failure path needs review", "proposed", now, {
        type: "watch_item",
      });
      insertCandidate("k1", "User keeps release notes in docs/releases", "proposed", now, {
        type: "project_state",
      });

      const cleanup = new CoreMemoryCleanupStore(db);
      expect(cleanup.run(now).retiredProposalsDismissed).toBe(3);
      const status = (id: string) =>
        (
          db.prepare("SELECT status FROM core_memory_candidates WHERE id = ?").get(id) as {
            status: string;
          }
        ).status;
      expect(["p1", "p2", "p3"].map(status)).toEqual(["dismissed", "dismissed", "dismissed"]);
      expect(status("w1")).toBe("proposed");
      expect(status("k1")).toBe("proposed");

      // Runs once: later proposals are left alone.
      insertCandidate("p4", "Foreground work active; deferred 3 merged signals", "proposed", now);
      expect(cleanup.run(now + DAY).retiredProposalsDismissed).toBe(0);
      expect(status("p4")).toBe("proposed");
    });

    it("removes duplicates, settles legacy rows and runs only once", () => {
      insertCandidate(
        "a1",
        "Workflow intelligence surfaced a reviewable next action",
        "accepted",
        now - DAY,
      );
      insertCandidate(
        "a2",
        "Workflow intelligence surfaced a reviewable next action",
        "proposed",
        now,
      );
      insertCandidate(
        "a3",
        "Workflow intelligence surfaced a reviewable next action.",
        "accepted",
        now - 2 * DAY,
      );
      insertCandidate("b1", "Old unreviewed loop", "proposed", now - 20 * DAY);
      insertCandidate("c1", "Recent unreviewed loop", "proposed", now - DAY);
      insertCandidate("d1", "Prefers worktrees", "accepted", now, {
        type: "pattern",
        workspaceId: null,
      });

      const learnings = new CoreLearningsStore(db);
      for (let i = 0; i < 5; i += 1) {
        learnings.append({ profileId: "p", kind: "eval_case", summary: "Same", createdAt: i });
      }
      learnings.append({ profileId: "p", kind: "eval_case", summary: "Other", createdAt: 9 });

      insertMemory(
        "m1",
        "[core-trace:t1] [scope:workspace:ws] Operator should respect dispatch timing constraints\nDispatch cooldown active",
        1,
      );
      insertMemory(
        "m2",
        "[core-trace:t2] [scope:workspace:ws] Operator should respect dispatch timing constraints\nOutside active hours.",
        2,
      );
      insertMemory("m3", "[core-trace:t3] [scope:workspace:ws] Prefers worktrees", 3);
      insertMemory("m4", "Unrelated memory", 4);

      const cleanup = new CoreMemoryCleanupStore(db);
      const result = cleanup.run(now);

      expect(result).toMatchObject({
        ran: true,
        duplicateCandidatesDeleted: 2,
        legacyAcceptedMarkedApplied: 1,
        workspacelessAcceptedMarkedSkipped: 1,
        staleOpenLoopsDismissed: 1,
        duplicateLearningsDeleted: 4,
        duplicateTraceMemoriesDeleted: 1,
        // v2 then dismisses the remaining unreviewed open loop.
        retiredProposalsDismissed: 1,
      });
      const statuses = Object.fromEntries(
        (
          db.prepare("SELECT id, status FROM core_memory_candidates").all() as Array<{
            id: string;
            status: string;
          }>
        ).map((row) => [row.id, row.status]),
      );
      expect(statuses).toEqual({ a1: "applied", b1: "dismissed", c1: "dismissed", d1: "skipped" });
      const memoryIds = (
        db.prepare("SELECT id FROM memories ORDER BY id").all() as Array<{ id: string }>
      ).map((row) => row.id);
      expect(memoryIds).toEqual(["m2", "m3", "m4"]);
      expect(
        db.prepare("SELECT memory_id FROM memory_embeddings WHERE memory_id = 'm1'").get(),
      ).toBeUndefined();
      expect(
        db
          .prepare("SELECT memory_id FROM memory_observation_metadata WHERE memory_id = 'm1'")
          .get(),
      ).toBeUndefined();
      expect(
        db
          .prepare("SELECT key FROM core_maintenance_markers WHERE key = ?")
          .get(CORE_MEMORY_CLEANUP_MARKER),
      ).toBeTruthy();

      insertCandidate(
        "a9",
        "Workflow intelligence surfaced a reviewable next action",
        "proposed",
        now,
      );
      expect(cleanup.run(now + DAY).ran).toBe(false);
      expect(store.findById("a9")?.status).toBe("proposed");
    });
  });
});
