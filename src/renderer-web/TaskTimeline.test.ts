import { describe, expect, it } from "vitest";
import {
  applyChanges,
  parseHistoryPage,
  parsePage,
  parseSnapshot,
  TimelineHistoryRequestGuard,
} from "./TaskTimeline";

const taskId = "task-1";
const cursor = { taskId, position: 3 };

describe("browser task timeline reconciliation", () => {
  it("accepts a bounded committed snapshot and rejects a mismatched task cursor", () => {
    const snapshot = parseSnapshot(
      {
        taskId,
        events: [{ id: "event-1", type: "task_created", timestamp: 1_000 }],
        cursor,
        hasMoreHistory: true,
        nextHistoryCursor: { order: 1, timestamp: 1_000, id: "event-1" },
      },
      taskId,
    );
    expect(snapshot.events).toHaveLength(1);
    expect(snapshot.hasMoreHistory).toBe(true);
    expect(() =>
      parseSnapshot(
        { taskId, events: [], cursor: { taskId: "other", position: 3 }, hasMoreHistory: false },
        taskId,
      ),
    ).toThrow(/cursor/);
  });

  it("accepts an older page only with a complete continuation cursor", () => {
    const page = parseHistoryPage(
      {
        events: [{ id: "event-0", type: "task_created", timestamp: 900 }],
        hasMoreHistory: true,
        nextHistoryCursor: { order: 0, timestamp: 900, id: "event-0" },
      },
      taskId,
    );
    expect(page.events[0]?.id).toBe("event-0");
    expect(page.nextHistoryCursor?.id).toBe("event-0");
    expect(() =>
      parseHistoryPage(
        {
          taskId: "another-task",
          events: [],
          hasMoreHistory: false,
          nextHistoryCursor: null,
        },
        taskId,
      ),
    ).toThrow(/page/);
    expect(() =>
      parseHistoryPage(
        { events: [], hasMoreHistory: true, nextHistoryCursor: { order: 0 } },
        taskId,
      ),
    ).toThrow(/cursor/);
  });

  it("invalidates an in-flight older page before a resnapshot and blocks concurrent loads", () => {
    const guard = new TimelineHistoryRequestGuard();
    const first = guard.begin();

    expect(first).not.toBeNull();
    expect(guard.begin()).toBeNull();
    guard.invalidate();
    expect(guard.isCurrent(first!)).toBe(false);

    const afterResnapshot = guard.begin();
    expect(afterResnapshot).not.toBeNull();
    expect(afterResnapshot).not.toBe(first);
    expect(guard.finish(first!)).toBe(false);
    expect(guard.isCurrent(afterResnapshot!)).toBe(true);
    expect(guard.finish(afterResnapshot!)).toBe(true);
    expect(guard.begin()).not.toBeNull();
  });

  it("applies update and delete changes by event ID without keeping stale rows", () => {
    const page = parsePage(
      {
        taskId,
        outcome: "page",
        changes: [
          { operation: "upsert", event: { id: "event-1", type: "task_updated", timestamp: 1_100 } },
          { operation: "delete", eventId: "event-2" },
        ],
        nextCursor: { taskId, position: 5 },
        hasMore: false,
      },
      taskId,
    );
    expect(page.outcome).toBe("page");
    if (page.outcome === "cursor_expired") throw new Error("Unexpected cursor expiry");
    expect(
      applyChanges(
        [
          { id: "event-1", type: "task_created", timestamp: 1_000 },
          { id: "event-2", type: "task_progress", timestamp: 1_050 },
        ],
        page.changes,
      ),
    ).toEqual([
      { id: "event-1", type: "task_updated", timestamp: 1_100, seq: undefined, payload: undefined },
    ]);
  });

  it("keeps both latest and older browsing windows bounded", () => {
    const events = Array.from({ length: 650 }, (_, index) => ({
      id: `event-${index}`,
      type: "task_progress",
      timestamp: index,
    }));

    const latestWindow = applyChanges(events, []);
    const olderWindow = applyChanges(events, [], true);

    expect(latestWindow).toHaveLength(600);
    expect(latestWindow[0]?.id).toBe("event-50");
    expect(latestWindow.at(-1)?.id).toBe("event-649");
    expect(olderWindow).toHaveLength(600);
    expect(olderWindow[0]?.id).toBe("event-0");
    expect(olderWindow.at(-1)?.id).toBe("event-599");
  });

  it("requires an explicit resnapshot when the committed cursor expires", () => {
    expect(
      parsePage(
        {
          taskId,
          outcome: "cursor_expired",
          afterCursor: cursor,
          resyncCursor: { taskId, position: 9 },
        },
        taskId,
      ),
    ).toEqual({ outcome: "cursor_expired" });
  });
});
