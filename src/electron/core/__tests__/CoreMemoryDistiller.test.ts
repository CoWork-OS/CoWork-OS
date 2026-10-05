/**
 * Core memory candidates through the shared memory hygiene (docs/memory-engine.md §1):
 * fact candidates become `inferred` memory_items through MemoryWriter (a real writer over
 * in-memory SQLite); events (open loops, watch items) go to the archive through
 * MemoryService.capture (mocked here); runtime signals are not written.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CORE_CANDIDATE_STORE, CoreMemoryDistiller } from "../CoreMemoryDistiller";
import { AUTO_ACCEPT_RESOLUTION } from "../CoreMemoryCandidateService";
import { MemoryService } from "../../memory/MemoryService";
import { MemoryWriteGate } from "../../memory/MemoryWriteGate";
import { MemoryWriter, type MemoryWorkspacePolicy } from "../../memory/MemoryWriter";
import { MemoryItemsRepository } from "../../memory/MemoryItemsRepository";
import { MemoryFeaturesManager } from "../../settings/memory-features-manager";
import {
  createMemoryItemsTestDb,
  nativeSqliteAvailable,
  rowsOf,
} from "../../memory/__tests__/memory-items-test-db";

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

type Lifecycle = { ids: string[]; status: string; resolution?: string };

function candidate(overrides: Record<string, unknown> = {}) {
  return {
    id: "candidate-1",
    traceId: "trace-1",
    profileId: "profile-1",
    workspaceId: "ws-1",
    scopeKind: "workspace",
    scopeRef: "ws-1",
    candidateType: "preference",
    summary: "Prefer deterministic prompts",
    details: "Observed repeatedly across successful runs.",
    confidence: 0.92,
    noveltyScore: 0.5,
    stabilityScore: 0.7,
    status: "accepted",
    resolution: "Accepted in review.",
    createdAt: 1,
    ...overrides,
  } as Any;
}

function createDistiller(candidates: Any[], lifecycle: Lifecycle[]) {
  const run = { id: "run-1", status: "running" } as Any;
  return new CoreMemoryDistiller(
    { findById: () => ({ id: "trace-1", profileId: "profile-1", workspaceId: "ws-1" }) } as Any,
    {
      listForTrace: () => candidates,
      findAppliedDuplicate: () => undefined,
      markLifecycle: vi.fn((ids: string[], status: string, resolution?: string) => {
        lifecycle.push({ ids, status, resolution });
      }),
    } as Any,
    {
      create: () => run,
      update: (_id: string, patch: Any) => ({ ...run, ...patch }),
    } as Any,
    { touchDistill: vi.fn() } as Any,
    {} as Any,
    {} as Any,
    {} as Any,
  );
}

describeWithSqlite("CoreMemoryDistiller", () => {
  let db: Database.Database;
  let policy: MemoryWorkspacePolicy | null;
  let captureSpy: ReturnType<typeof vi.spyOn>;
  let autoPromote: boolean;

  beforeEach(async () => {
    vi.restoreAllMocks();
    db = await createMemoryItemsTestDb(["ws-1"]);
    policy = { enabled: true, privacyMode: "normal" };
    autoPromote = false;
    MemoryWriter.setInstance(
      new MemoryWriter({
        repository: new MemoryItemsRepository(db),
        getWorkspacePolicy: async () => policy,
        bumpHotMemoryVersion: () => undefined,
      }),
    );
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockImplementation(
      () => ({ autoPromoteToCuratedMemoryEnabled: autoPromote }) as Any,
    );
    captureSpy = vi
      .spyOn(MemoryService, "captureCoreMemory")
      .mockResolvedValue({ id: "mem-1" } as Any);
  });

  afterEach(() => {
    MemoryWriter.setInstance(null);
    db.close();
  });

  it("writes a fact candidate as an inferred memory item and marks it applied", async () => {
    const lifecycle: Lifecycle[] = [];
    const run = await createDistiller([candidate()], lifecycle).runHotPath("trace-1");

    const rows = rowsOf(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "preference",
      scope: "workspace",
      workspace_id: "ws-1",
      source: "inferred",
      content: "Prefer deterministic prompts Observed repeatedly across successful runs.",
    });
    expect(JSON.parse(String(rows[0].source_ref))).toMatchObject({
      store: CORE_CANDIDATE_STORE,
      id: "candidate-1",
      traceId: "trace-1",
      candidateType: "preference",
    });
    expect(captureSpy).not.toHaveBeenCalled();
    expect(lifecycle).toEqual([
      {
        ids: ["candidate-1"],
        status: "applied",
        resolution: `Written to memory item ${rows[0].id}.`,
      },
    ]);
    expect(run).toMatchObject({ status: "completed", acceptedCount: 1 });
  });

  it("stages a fact for review when a memory-write approval mode applies", async () => {
    const evaluate = vi.spyOn(MemoryWriteGate, "evaluate").mockResolvedValue({
      allowed: false,
      staged: true,
      pendingId: "pending-1",
      summary: "Remember preference",
    });
    const lifecycle: Lifecycle[] = [];
    await createDistiller(
      [candidate(), candidate({ id: "candidate-2", confidence: 0.8 })],
      lifecycle,
    ).runHotPath("trace-1");

    expect(rowsOf(db)).toHaveLength(0);
    expect(evaluate).toHaveBeenCalledTimes(1);
    expect(evaluate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        target: "curated",
        action: "remember",
        origin: "distill",
        payload: expect.objectContaining({
          kind: "preference",
          scope: "workspace",
          source: "inferred",
          sourceRef: expect.objectContaining({ store: CORE_CANDIDATE_STORE, id: "candidate-1" }),
        }),
      }),
    );
    expect(lifecycle).toEqual([
      {
        ids: ["candidate-1"],
        status: "applied",
        resolution: "Staged for review as pending memory write pending-1.",
      },
      { ids: ["candidate-2"], status: "merged", resolution: "Merged into candidate candidate-1." },
    ]);
  });

  it("maps fact types to kinds and global scope to global items", async () => {
    const lifecycle: Lifecycle[] = [];
    await createDistiller(
      [
        candidate({ id: "c-corr", candidateType: "correction", summary: "Use pnpm, not npm" }),
        candidate({
          id: "c-state",
          candidateType: "project_state",
          summary: "Release 2.1 is frozen",
        }),
        candidate({
          id: "c-global",
          candidateType: "pattern",
          scopeKind: "global",
          scopeRef: "global",
          summary: "Reviews code in the morning",
        }),
      ],
      lifecycle,
    ).runHotPath("trace-1");
    const byKind = Object.fromEntries(rowsOf(db).map((row) => [row.kind, row]));
    expect(byKind.correction).toMatchObject({ scope: "workspace" });
    expect(byKind.project_fact).toMatchObject({ scope: "workspace" });
    expect(byKind.insight).toMatchObject({ scope: "global", workspace_id: null });
  });

  it("redacts secrets and skips facts that are only a secret or opt out of memory", async () => {
    const token = "ghp_" + "a1B2c3D4e5F6g7H8i9J0k1L2m3N4o5P6q7R8";
    const lifecycle: Lifecycle[] = [];
    await createDistiller(
      [
        candidate({ id: "c-redact", summary: `Deploy bot uses ${token}`, details: undefined }),
        candidate({
          id: "c-secret",
          candidateType: "correction",
          summary: token,
          details: undefined,
        }),
        candidate({
          id: "c-nomem",
          candidateType: "project_state",
          summary: "Client codename is Falcon",
          details: "<no-memory>",
        }),
      ],
      lifecycle,
    ).runHotPath("trace-1");
    const rows = rowsOf(db);
    expect(rows).toHaveLength(1);
    expect(String(rows[0].content)).not.toContain(token);
    expect(String(rows[0].content)).toContain("[REDACTED_SECRET]");
    expect(lifecycle).toEqual(
      expect.arrayContaining([
        { ids: ["c-secret"], status: "skipped", resolution: "Not written to memory: secret only." },
        { ids: ["c-nomem"], status: "skipped", resolution: "Not written to memory: no memory." },
      ]),
    );
  });

  it("leaves candidates accepted while workspace memory is off, and writes them later", async () => {
    policy = { enabled: false };
    const lifecycle: Lifecycle[] = [];
    await createDistiller([candidate()], lifecycle).runHotPath("trace-1");
    expect(rowsOf(db)).toHaveLength(0);
    expect(lifecycle).toEqual([]);

    policy = { enabled: true, privacyMode: "strict" };
    await createDistiller([candidate()], lifecycle).runHotPath("trace-1");
    expect(rowsOf(db)).toEqual([expect.objectContaining({ privacy: "private" })]);
    expect(lifecycle.map((entry) => entry.status)).toEqual(["applied"]);
  });

  it("reinforces a fact that is already stored instead of duplicating it", async () => {
    const lifecycle: Lifecycle[] = [];
    await createDistiller([candidate()], lifecycle).runHotPath("trace-1");
    await createDistiller([candidate({ id: "candidate-2" })], lifecycle).runHotPath("trace-1");
    const rows = rowsOf(db);
    expect(rows).toHaveLength(1);
    expect(rows[0].reinforced_count).toBe(1);
    expect(lifecycle.map((entry) => entry.status)).toEqual(["applied", "applied"]);
  });

  it("keeps events in the archive and does not write runtime signals", async () => {
    const lifecycle: Lifecycle[] = [];
    await createDistiller(
      [
        candidate({ id: "c-loop", candidateType: "open_loop", summary: "Ship the migration" }),
        candidate({
          id: "c-noise",
          candidateType: "ignored_noise",
          summary: "Workflow intelligence should ignore low-signal context like this",
        }),
      ],
      lifecycle,
    ).runHotPath("trace-1");
    expect(rowsOf(db)).toHaveLength(0);
    expect(captureSpy).toHaveBeenCalledOnce();
    expect(captureSpy.mock.calls[0]?.[3]).toBe(
      "Ship the migration\nObserved repeatedly across successful runs.",
    );
    expect(lifecycle).toEqual(
      expect.arrayContaining([
        { ids: ["c-loop"], status: "applied", resolution: "Written to memory mem-1." },
        {
          ids: ["c-noise"],
          status: "skipped",
          resolution: "Not written to memory: a runtime signal, not a memory.",
        },
      ]),
    );
  });

  it("retries an archive event the capture declined", async () => {
    captureSpy.mockResolvedValue(null);
    const lifecycle: Lifecycle[] = [];
    await createDistiller([candidate({ candidateType: "open_loop" })], lifecycle).runHotPath(
      "trace-1",
    );
    expect(lifecycle).toEqual([]);
  });

  it("makes an auto-accepted constraint an L0 rule only with auto-promotion on", async () => {
    const autoAccepted = candidate({
      candidateType: "constraint",
      summary: "Never deploy on Fridays",
      resolution: AUTO_ACCEPT_RESOLUTION,
    });
    const lifecycle: Lifecycle[] = [];
    await createDistiller([autoAccepted], lifecycle).runHotPath("trace-1");
    expect(rowsOf(db)).toHaveLength(0);
    expect(captureSpy).toHaveBeenCalledOnce();

    autoPromote = true;
    await createDistiller([autoAccepted], lifecycle).runHotPath("trace-1");
    expect(rowsOf(db)).toEqual([expect.objectContaining({ kind: "rule", source: "inferred" })]);
  });

  it("makes a user-accepted constraint a rule", async () => {
    const lifecycle: Lifecycle[] = [];
    await createDistiller(
      [candidate({ candidateType: "constraint", summary: "Never deploy on Fridays" })],
      lifecycle,
    ).runHotPath("trace-1");
    expect(rowsOf(db)).toEqual([expect.objectContaining({ kind: "rule" })]);
    expect(captureSpy).not.toHaveBeenCalled();
  });

  it("falls back to the archive when the fact store is not running", async () => {
    MemoryWriter.setInstance(null);
    const lifecycle: Lifecycle[] = [];
    await createDistiller([candidate()], lifecycle).runHotPath("trace-1");
    expect(captureSpy).toHaveBeenCalledOnce();
    expect(captureSpy.mock.calls[0]?.[2]).toBe("preference");
  });

  it("skips candidates without a workspace", async () => {
    const lifecycle: Lifecycle[] = [];
    await createDistiller([candidate({ workspaceId: undefined })], lifecycle).runHotPath("trace-1");
    expect(lifecycle).toEqual([
      {
        ids: ["candidate-1"],
        status: "skipped",
        resolution: "Not written to memory: candidate has no workspace.",
      },
    ]);
  });
});
