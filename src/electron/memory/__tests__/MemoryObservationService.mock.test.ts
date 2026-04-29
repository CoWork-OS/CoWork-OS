import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryService } from "../MemoryService";
import { MemoryObservationService } from "../MemoryObservationService";

type MockStatement = {
  all: (...args: unknown[]) => unknown[];
  get: (...args: unknown[]) => unknown;
  run: (...args: unknown[]) => { changes: number };
};

function createMockDb(prepare: (sql: string) => Partial<MockStatement>) {
  return {
    prepare(sql: string): MockStatement {
      const statement = prepare(sql);
      return {
        all: statement.all || (() => []),
        get: statement.get || (() => undefined),
        run: statement.run || (() => ({ changes: 0 })),
      };
    },
  } as unknown as import("better-sqlite3").Database;
}

function metadataRow(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    memory_id: "mem-1",
    workspace_id: "ws-1",
    task_id: null,
    origin: "task",
    observation_type: "decision",
    title: "Existing memory",
    subtitle: "Memory",
    narrative: "Existing memory narrative",
    facts: "[]",
    concepts: "[]",
    files_read: "[]",
    files_modified: "[]",
    tools: "[]",
    source_event_ids: "[]",
    content_hash: "hash",
    capture_reason: "memory_capture",
    privacy_state: "normal",
    generated_by: "capture",
    migration_status: "current",
    created_at: 100,
    updated_at: 100,
    memory_created_at: 100,
    summary: null,
    content: "Existing memory content",
    tokens: 10,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  (MemoryObservationService as Any).db = null;
  (MemoryObservationService as Any).status = {
    total: 0,
    processed: 0,
    failed: 0,
    pending: 0,
    running: false,
  };
  (MemoryService as Any).initialized = false;
  (MemoryService as Any).memoryRepo = undefined;
});

describe("MemoryObservationService without native sqlite", () => {
  it("does not run a write backfill during initialize", () => {
    const preparedSql: string[] = [];
    const db = createMockDb((sql) => {
      preparedSql.push(sql);
      if (sql.includes("COUNT(*) AS total")) {
        return { get: () => ({ total: 3, pending: 2 }) };
      }
      return {};
    });

    MemoryObservationService.initialize(db);

    expect(preparedSql).toHaveLength(0);
    const status = MemoryObservationService.getBackfillStatus();

    expect(preparedSql.some((sql) => sql.includes("SELECT m.*"))).toBe(false);
    expect(preparedSql.some((sql) => sql.includes("INSERT OR REPLACE INTO memory_observation_metadata"))).toBe(false);
    expect(status).toMatchObject({
      total: 3,
      processed: 1,
      pending: 2,
      running: false,
    });
  });

  it("counts failed backfill rows when metadata creation returns null", () => {
    const db = createMockDb((sql) => {
      if (sql.includes("SELECT m.*")) {
        return {
          all: () => [
            {
              id: "mem-1",
              workspace_id: "ws-1",
              task_id: "task-1",
              type: "decision",
              content: "Backfill should report failed insert.",
              summary: null,
              tokens: 10,
              is_compressed: 0,
              is_private: 0,
              created_at: 100,
              updated_at: 100,
            },
          ],
        };
      }
      if (sql.includes("SELECT memory_id FROM memory_observation_metadata")) {
        return { get: () => undefined };
      }
      if (sql.includes("INSERT OR REPLACE INTO memory_observation_metadata")) {
        return {
          run: () => {
            throw new Error("insert failed");
          },
        };
      }
      if (sql.includes("COUNT(*) AS total")) {
        return { get: () => ({ total: 1, pending: 1 }) };
      }
      return {};
    });

    MemoryObservationService.initialize(db);
    const status = MemoryObservationService.startBackfill();

    expect(status.processed).toBe(0);
    expect(status.failed).toBe(1);
    expect(status.pending).toBe(0);
    expect(status.lastError).toContain("mem-1");
  });

  it("soft-deletes only observations owned by the requested workspace", () => {
    let privacyState = "normal";
    const preparedSql: string[] = [];
    const db = createMockDb((sql) => {
      preparedSql.push(sql);
      if (sql.includes("COUNT(*) AS total")) {
        return { get: () => ({ total: 1, pending: 0 }) };
      }
      if (sql.includes("SELECT om.*")) {
        return {
          get: (memoryId: unknown, workspaceId: unknown) =>
            memoryId === "mem-1" && workspaceId === "ws-1"
              ? metadataRow({ privacy_state: privacyState })
              : undefined,
        };
      }
      if (sql.includes("UPDATE memory_observation_metadata")) {
        return {
          run: (...args: unknown[]) => {
            privacyState = String(args[9] || privacyState);
            return { changes: 1 };
          },
        };
      }
      if (sql.includes("UPDATE memories SET is_private")) {
        return { run: () => ({ changes: 1 }) };
      }
      return {};
    });

    MemoryObservationService.initialize(db);

    expect(MemoryObservationService.delete("ws-2", "mem-1")).toBe(false);
    expect(privacyState).toBe("normal");

    expect(MemoryObservationService.delete("ws-1", "mem-1")).toBe(true);
    expect(privacyState).toBe("suppressed");
    expect(preparedSql.some((sql) => sql.includes("DELETE FROM memories"))).toBe(false);
  });

  it("filters suppressed observations from recent prompt recall", () => {
    (MemoryService as Any).initialized = true;
    (MemoryService as Any).memoryRepo = {
      getRecentForWorkspace: vi.fn(() => [
        {
          id: "mem-visible",
          workspaceId: "ws-1",
          type: "observation",
          content: "Visible prompt recall memory",
          tokens: 8,
          isCompressed: false,
          isPrivate: false,
          createdAt: 100,
          updatedAt: 100,
        },
        {
          id: "mem-suppressed",
          workspaceId: "ws-1",
          type: "observation",
          content: "Suppressed prompt recall memory",
          tokens: 8,
          isCompressed: false,
          isPrivate: false,
          createdAt: 101,
          updatedAt: 101,
        },
      ]),
    };
    vi.spyOn(MemoryObservationService, "isPromptSuppressed").mockImplementation(
      (memoryId) => memoryId === "mem-suppressed",
    );

    const recent = MemoryService.getRecentForPromptRecall("ws-1", 10);

    expect(recent.map((memory) => memory.id)).toEqual(["mem-visible"]);
  });
});
