import { beforeEach, describe, expect, it } from "vitest";
import type { RoutineWorkflowDefinition } from "../../../../shared/routine-workflow";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const probe = new module.default(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("RoutineWorkflowRepository", () => {
  let db: import("better-sqlite3").Database;
  let Repository: typeof import("../repository").RoutineWorkflowStore;

  beforeEach(async () => {
    const Database = (await import("better-sqlite3")).default;
    db = new Database(":memory:");
    ({ RoutineWorkflowStore: Repository } = await import("../repository"));
  });

  it("keeps one active immutable version", () => {
    const repository = new Repository(db, () => 100);
    const first = repository.createVersion("routine", definition("one"), "active");
    const second = repository.createVersion("routine", definition("two"), "draft");

    repository.activateVersion("routine", second.id);

    expect(repository.getVersion(first.id)?.status).toBe("archived");
    expect(repository.getActiveVersion("routine")?.id).toBe(second.id);
  });

  it("adds the action review digest to an existing workflow-step table", () => {
    db.exec(`
      CREATE TABLE routine_run_steps (
        id TEXT PRIMARY KEY,
        run_id TEXT NOT NULL,
        routine_id TEXT NOT NULL,
        node_id TEXT NOT NULL,
        operation TEXT NOT NULL,
        status TEXT NOT NULL,
        attempt_count INTEGER NOT NULL DEFAULT 0,
        input_json TEXT,
        output_json TEXT,
        error TEXT,
        approval_id TEXT,
        started_at INTEGER,
        finished_at INTEGER,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(run_id, node_id)
      );
    `);

    const repository = new Repository(db, () => 100);
    const run = repository.createRun({
      routineId: "routine",
      workflowVersionId: "version",
      triggerNodeId: "starter",
      context: {},
    });
    repository.initializeSteps(run.id, "routine", definition("old").nodes);
    const step = repository.findStep(run.id, "starter")!;
    repository.updateStep(step.id, { reviewDigest: "a".repeat(64) });

    expect(repository.getStep(step.id)?.reviewDigest).toBe("a".repeat(64));
    expect(
      (db.prepare("PRAGMA table_info(routine_run_steps)").all() as Array<{ name: string }>).some(
        (column) => column.name === "review_digest",
      ),
    ).toBe(true);
  });

  it("deduplicates inbox events and workflow runs", () => {
    const repository = new Repository(db, () => 100);
    const eventOne = repository.enqueueEvent({
      routineId: "routine",
      triggerNodeId: "starter",
      source: "gmail",
      idempotencyKey: "message-1",
      payload: { id: "message-1" },
    });
    const eventTwo = repository.enqueueEvent({
      routineId: "routine",
      triggerNodeId: "starter",
      source: "gmail",
      idempotencyKey: "message-1",
      payload: { id: "message-1" },
    });
    const runOne = repository.createRun({
      routineId: "routine",
      workflowVersionId: "version",
      triggerNodeId: "starter",
      idempotencyKey: "message-1",
      context: {},
    });
    const runTwo = repository.createRun({
      routineId: "routine",
      workflowVersionId: "version",
      triggerNodeId: "starter",
      idempotencyKey: "message-1",
      context: {},
    });

    expect(eventTwo.id).toBe(eventOne.id);
    expect(runTwo.id).toBe(runOne.id);
  });

  it("claims queued events once", () => {
    const repository = new Repository(db, () => 100);
    repository.enqueueEvent({
      routineId: "routine",
      triggerNodeId: "starter",
      source: "drive",
      idempotencyKey: "change-1",
      payload: {},
    });

    const claimed = repository.claimNextEvent();
    const none = repository.claimNextEvent();

    expect(claimed?.status).toBe("processing");
    expect(none).toBeNull();
  });

  it("requeues events that were processing during a restart", () => {
    const repository = new Repository(db, () => 100);
    repository.enqueueEvent({
      routineId: "routine",
      triggerNodeId: "starter",
      source: "gmail",
      idempotencyKey: "message-restart",
      payload: {},
    });
    repository.claimNextEvent();

    const recovered = repository.requeueProcessingEvents();

    expect(recovered).toBe(1);
    expect(repository.claimNextEvent()?.idempotencyKey).toBe("message-restart");
  });

  it("removes expired step payloads while retaining run metadata", () => {
    let now = 100;
    const repository = new Repository(db, () => now);
    const version = repository.createVersion("routine", definition("retained"), "active");
    const run = repository.createRun({
      routineId: "routine",
      workflowVersionId: version.id,
      triggerNodeId: "starter",
      context: { trigger: { body: "sensitive" } },
    });
    repository.initializeSteps(run.id, "routine", definition("retained").nodes);
    repository.updateRun(run.id, {
      status: "completed",
      output: { apiKey: "sensitive" },
      finishedAt: now,
    });
    now += 2 * 86_400_000;

    const result = repository.pruneExpiredData(() => 1);

    expect(result.runsSanitized).toBe(1);
    expect(repository.getRun(run.id)?.context).toEqual({});
    expect(repository.listSteps(run.id)).toEqual([]);
  });
});

function definition(label: string): RoutineWorkflowDefinition {
  return {
    version: 1,
    starterNodeId: "starter",
    nodes: [
      { id: "starter", kind: "starter", operation: "starter.manual", name: label, config: {} },
    ],
    edges: [],
  };
}
