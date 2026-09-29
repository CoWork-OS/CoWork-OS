import { describe, it, expect, vi, beforeEach } from "vitest";
import { OrchestrationRepository } from "../orchestration-repository-facades";
import type { OrchestrationTask } from "../OrchestrationRepository";
import { SubAgentOrchestrator } from "../SubAgentOrchestrator";

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

describe("SubAgentOrchestrator.getReadyTasks", () => {
  function makeOrchestrator() {
    const db = makeDb();
    const deps = {
      daemon: {} as unknown as import("../daemon").AgentDaemon,
      workspaceId: "ws-1",
      parentTaskId: "parent-1",
    };
    return new SubAgentOrchestrator(db, deps);
  }

  const tasks: OrchestrationTask[] = [
    { id: "A", title: "A", prompt: "Do A", dependsOn: [], status: "completed" },
    { id: "B", title: "B", prompt: "Do B", dependsOn: ["A"], status: "pending" },
    { id: "C", title: "C", prompt: "Do C", dependsOn: ["B"], status: "pending" },
    { id: "D", title: "D", prompt: "Do D", dependsOn: [], status: "pending" },
  ];

  it("returns tasks whose all dependencies are completed", () => {
    const orch = makeOrchestrator();
    const run = {
      id: "r1",
      rootTaskId: "parent-1",
      workspaceId: "ws-1",
      tasks,
      status: "running" as const,
      createdAt: Date.now(),
    };
    const ready = orch.getReadyTasks(run);
    const readyIds = ready.map((t) => t.id).sort();
    // B is ready (A completed), D is ready (no deps), C is not (B pending)
    expect(readyIds).toEqual(["B", "D"]);
  });

  it("returns no tasks if all are completed", () => {
    const orch = makeOrchestrator();
    const allDone = tasks.map((t) => ({ ...t, status: "completed" as const }));
    const run = {
      id: "r2",
      rootTaskId: "parent-1",
      workspaceId: "ws-1",
      tasks: allDone,
      status: "running" as const,
      createdAt: Date.now(),
    };
    const ready = orch.getReadyTasks(run);
    expect(ready).toHaveLength(0);
  });

  it("returns no tasks if all pending have incomplete deps", () => {
    const orch = makeOrchestrator();
    const noDone = tasks.map((t) => ({
      ...t,
      status: t.id === "A" ? ("running" as const) : ("pending" as const),
    }));
    const run = {
      id: "r3",
      rootTaskId: "parent-1",
      workspaceId: "ws-1",
      tasks: noDone,
      status: "running" as const,
      createdAt: Date.now(),
    };
    const ready = orch.getReadyTasks(run);
    // Only D has no deps and is pending
    expect(ready.map((t) => t.id)).toEqual(["D"]);
  });
});
