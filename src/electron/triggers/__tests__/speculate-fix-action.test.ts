import { describe, expect, it, vi } from "vitest";
import { EventTriggerService } from "../EventTriggerService";
import type { EventTriggerServiceDeps, TriggerEvent } from "../types";

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

function makeDeps(overrides: Partial<EventTriggerServiceDeps> = {}): EventTriggerServiceDeps {
  return {
    createTask: vi.fn().mockResolvedValue({ id: "new-task-1" }),
    getDefaultWorkspaceId: () => "ws-default",
    log: vi.fn(),
    getActiveTaskCount: () => 0,
    ...overrides,
  };
}

const bugReport: TriggerEvent = {
  source: "channel_message",
  eventId: "gateway:slack:chan-1:C1:m-1",
  timestamp: 1710000000300,
  fields: { channelType: "slack", chatId: "C1", text: "The export button crashes" },
};

const speculateTrigger = {
  name: "Speculate on bug reports",
  enabled: true,
  source: "channel_message" as const,
  conditions: [{ field: "text", operator: "contains" as const, value: "crash" }],
  action: {
    type: "speculate_fix" as const,
    config: { speculateFix: { maxMinutes: 10, delivery: "draft_only" as const } },
  },
  workspaceId: "ws-1",
  cooldownMs: 0,
};

describe("speculate_fix trigger action", () => {
  it("hands the matched event to the speculative runtime instead of creating a task", async () => {
    const speculateFix = vi
      .fn()
      .mockResolvedValue({ started: true, runId: "run-1", taskId: "spec-task-1" });
    const deps = makeDeps({ speculateFix });
    const service = new EventTriggerService(deps);
    await service.start();
    const trigger = await service.addTrigger(speculateTrigger);

    await service.evaluateEvent(bugReport);

    expect(deps.createTask).not.toHaveBeenCalled();
    expect(speculateFix).toHaveBeenCalledWith(
      expect.objectContaining({
        trigger: expect.objectContaining({ id: trigger.id }),
        event: bugReport,
        idempotencyKey: expect.any(String),
      }),
    );
    expect(service.getHistory(trigger.id)[0]).toMatchObject({
      actionResult: "speculation_started",
      taskId: "spec-task-1",
    });
    await service.stop();
  });

  it("records a skipped run without failing the trigger", async () => {
    const speculateFix = vi.fn().mockResolvedValue({ started: false, reason: "busy" });
    const service = new EventTriggerService(makeDeps({ speculateFix }));
    await service.start();
    const trigger = await service.addTrigger(speculateTrigger);

    await service.evaluateEvent(bugReport);

    expect(service.getHistory(trigger.id)[0].actionResult).toBe("speculation_skipped: busy");
    await service.stop();
  });

  (nativeSqliteAvailable ? it : it.skip)(
    "persists a speculative-run receipt and never replays the occurrence",
    async () => {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(":memory:");
      const speculateFix = vi
        .fn()
        .mockResolvedValue({ started: true, runId: "run-7", taskId: "spec-task-7" });
      const deps = makeDeps({ speculateFix });
      const service = new EventTriggerService(deps, db);
      try {
        await service.start();
        const trigger = await service.addTrigger(speculateTrigger);
        await service.evaluateEvent(bugReport);
        await service.drainPendingEvents();

        expect(speculateFix).toHaveBeenCalledTimes(1);
        const [request] = speculateFix.mock.calls[0] as [{ idempotencyKey: string }];
        const row = db
          .prepare(
            "SELECT id, status, receipt_json FROM event_trigger_occurrences WHERE trigger_id = ?",
          )
          .get(trigger.id) as { id: string; status: string; receipt_json: string };
        expect(request.idempotencyKey).toBe(row.id);
        expect(row.status).toBe("completed");
        expect(JSON.parse(row.receipt_json)).toEqual({
          kind: "speculative_run",
          started: true,
          runId: "run-7",
          taskId: "spec-task-7",
        });

        await service.evaluateEvent(bugReport);
        await service.drainPendingEvents();
        expect(speculateFix).toHaveBeenCalledTimes(1);
      } finally {
        await service.stop();
        db.close();
      }
    },
  );

  (nativeSqliteAvailable ? it : it.skip)(
    "fails the occurrence when the runtime has no speculative runner",
    async () => {
      const Database = (await import("better-sqlite3")).default;
      const db = new Database(":memory:");
      const service = new EventTriggerService(makeDeps(), db);
      try {
        await service.start();
        const trigger = await service.addTrigger(speculateTrigger);
        await service.evaluateEvent(bugReport);
        await service.drainPendingEvents();

        const row = db
          .prepare("SELECT status, error FROM event_trigger_occurrences WHERE trigger_id = ?")
          .get(trigger.id) as { status: string; error: string };
        expect(row.status).toBe("outcome_unknown");
        expect(row.error).toMatch(/Speculative fix is not available/);
      } finally {
        await service.stop();
        db.close();
      }
    },
  );
});
