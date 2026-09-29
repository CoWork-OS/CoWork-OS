import { afterEach, describe, expect, it, vi } from "vitest";
import { TimelineProjectionQueue } from "../TimelineProjectionQueue";

// Backpressure of the timeline projection queue, with a fake worker client whose drains
// are released explicitly.
describe("TimelineProjectionQueue backpressure", () => {
  const queues: TimelineProjectionQueue[] = [];

  afterEach(async () => {
    await Promise.all(queues.splice(0).map((queue) => queue.stop(10)));
    vi.restoreAllMocks();
  });

  const createQueue = () => {
    const pending: Array<{ eventId: string; taskId: string }> = [];
    let release: (() => void) | null = null;
    const gate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
      });
    let blocked = gate();
    const client = {
      execute: vi.fn(async (command: string) => {
        if (command !== "timeline.drainProjectionOutbox") return { ok: true };
        await blocked;
        const processed = pending.splice(0);
        return { processed, failures: [], exhausted: true };
      }),
    };
    const queue = new TimelineProjectionQueue(client as never, {
      leaseMaintenanceIntervalMs: 60_000,
    });
    queues.push(queue);
    const enqueue = (count: number) => {
      for (let index = 0; index < count; index += 1) {
        const entry = { eventId: `event-${pending.length}-${index}`, taskId: "task-1" };
        pending.push(entry);
        queue.notifyEnqueued(entry.taskId, entry.eventId);
      }
    };
    return {
      queue,
      enqueue,
      releaseDrain: () => {
        release?.();
        blocked = gate();
      },
    };
  };

  it("does not wait while the backlog is under the high-water mark", async () => {
    const { queue, enqueue } = createQueue();
    enqueue(10);
    await expect(queue.waitForCapacity({ highWater: 100 })).resolves.toBeUndefined();
  });

  it("waits over the high-water mark and resumes once projections catch up", async () => {
    const { queue, enqueue, releaseDrain } = createQueue();
    enqueue(20);
    let resumed = false;
    const waiting = queue.waitForCapacity({ highWater: 10, lowWater: 5 }).then(() => {
      resumed = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(resumed).toBe(false);

    releaseDrain();
    await waiting;
    expect(resumed).toBe(true);
    expect(queue.pendingCount()).toBe(0);
  });

  it("stops waiting after the maximum wait when the worker makes no progress", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const { queue, enqueue } = createQueue();
    enqueue(20);
    const startedAt = Date.now();
    await queue.waitForCapacity({ highWater: 10, lowWater: 5, maxWaitMs: 50 });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(45);
    expect(queue.pendingCount()).toBe(20);
  });
});
