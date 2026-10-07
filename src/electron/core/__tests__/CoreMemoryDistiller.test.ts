/**
 * Core memory candidates (docs/memory-repo-phase3-design.md §4): every candidate is an event
 * written to the archive through MemoryService.captureCoreMemory (mocked here); no fact is
 * written to `memory_items` any more (a real writer over in-memory SQLite proves it), and
 * runtime signals are not written at all.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CoreMemoryDistiller } from "../CoreMemoryDistiller";
import { MemoryService } from "../../memory/MemoryService";
import { MemoryWriter } from "../../memory/MemoryWriter";
import { MemoryItemsRepository } from "../../memory/MemoryItemsRepository";
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
  let captureSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    vi.restoreAllMocks();
    db = await createMemoryItemsTestDb(["ws-1"]);
    MemoryWriter.setInstance(
      new MemoryWriter({
        repository: new MemoryItemsRepository(db),
        bumpHotMemoryVersion: () => undefined,
      }),
    );
    captureSpy = vi
      .spyOn(MemoryService, "captureCoreMemory")
      .mockResolvedValue({ id: "mem-1" } as Any);
  });

  afterEach(() => {
    MemoryWriter.setInstance(null);
    db.close();
  });

  it("writes fact-like candidates to the archive, never as memory items", async () => {
    const lifecycle: Lifecycle[] = [];
    await createDistiller(
      [
        candidate({ id: "c-pref" }),
        candidate({
          id: "c-rule",
          candidateType: "constraint",
          summary: "Never deploy on Fridays",
        }),
        candidate({
          id: "c-global",
          candidateType: "correction",
          scopeKind: "global",
          summary: "Use metric units in every answer",
        }),
      ],
      lifecycle,
    ).runHotPath("trace-1");
    expect(rowsOf(db)).toHaveLength(0);
    expect(captureSpy).toHaveBeenCalledTimes(3);
    expect(captureSpy.mock.calls.map((call) => call[2])).toEqual([
      "preference",
      "constraint",
      "correction_rule",
    ]);
    expect(lifecycle).toEqual(
      expect.arrayContaining([
        { ids: ["c-pref"], status: "applied", resolution: "Written to memory mem-1." },
      ]),
    );
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

  it("retries a candidate the capture declined", async () => {
    captureSpy.mockResolvedValue(null);
    const lifecycle: Lifecycle[] = [];
    await createDistiller([candidate()], lifecycle).runHotPath("trace-1");
    expect(lifecycle).toEqual([]);
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
