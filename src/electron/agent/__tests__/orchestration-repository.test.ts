import { describe, it, expect, beforeEach } from "vitest";
import { OrchestrationRepository } from "../orchestration-repository-facades";

// Minimal in-memory Database mock
function makeDb() {
  const store = new Map<string, unknown>();
  return {
    // Units run in a transaction (DB6); the mock runs the body directly.
    transaction: <T>(fn: T) => fn,
    prepare: (sql: string) => ({
      run: (...args: unknown[]) => {
        if (sql.includes("INSERT INTO orchestration_runs")) {
          const id = args[0] as string;
          store.set(id, {
            id,
            root_task_id: args[1],
            workspace_id: args[2],
            tasks: args[3],
            status: args[4],
            created_at: args[5],
            completed_at: args[6] ?? null,
          });
        } else if (sql.includes("UPDATE orchestration_runs")) {
          // Update fields in the store (simplified)
          for (const [k, v] of store.entries()) {
            const entry = v as Record<string, unknown>;
            store.set(k, { ...entry });
          }
        }
        return { changes: 1 };
      },
      get: (id: string) => store.get(id) ?? undefined,
      all: () => Array.from(store.values()),
    }),
  } as unknown as import("better-sqlite3").Database;
}

describe("OrchestrationRepository", () => {
  let db: import("better-sqlite3").Database;
  let repo: OrchestrationRepository;

  beforeEach(() => {
    db = makeDb();
    repo = new OrchestrationRepository(db);
  });

  it("creates a run and retrieves it by id", async () => {
    const run = await repo.create({
      rootTaskId: "root-1",
      workspaceId: "ws-1",
      tasks: [],
      status: "running",
    });

    expect(run.id).toBeTruthy();
    expect(run.rootTaskId).toBe("root-1");
    expect(run.status).toBe("running");

    const found = await repo.findById(run.id);
    expect(found?.id).toBe(run.id);
  });

  it("allows custom id", async () => {
    const run = await repo.create({
      id: "custom-id",
      rootTaskId: "root-2",
      workspaceId: "ws-1",
      tasks: [],
      status: "running",
    });
    expect(run.id).toBe("custom-id");
  });
});
