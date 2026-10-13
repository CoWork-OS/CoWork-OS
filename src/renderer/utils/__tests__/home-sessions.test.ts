import { describe, expect, it } from "vitest";
import type { Task } from "../../../shared/types";
import {
  EMPTY_HOME_SESSIONS,
  buildHomeSessions,
  formatHomeSessionTime,
  sameHomeSessions,
} from "../home-sessions";

function task(id: string, updatedAt: number, overrides: Partial<Task> = {}): Task {
  return {
    id,
    title: `Session ${id}`,
    prompt: `Session ${id}`,
    status: "completed",
    workspaceId: "ws",
    createdAt: updatedAt - 1000,
    updatedAt,
    ...overrides,
  } as Task;
}

describe("buildHomeSessions", () => {
  it("returns the shared empty value when there is nothing to show", () => {
    expect(buildHomeSessions([])).toBe(EMPTY_HOME_SESSIONS);
  });

  it("lists sessions waiting on the user first, newest first, with the reason", () => {
    const result = buildHomeSessions([
      task("old", 100),
      task("waiting", 200, { status: "paused", terminalStatus: "needs_user_action" }),
      task("new", 300),
    ]);
    expect(result.needsYou).toEqual([
      { id: "waiting", title: "Session waiting", updatedAt: 200, attention: "Response needed" },
    ]);
  });

  it("leaves out sub-agents and caps the waiting list", () => {
    const tasks = [
      task("child", 900, {
        parentTaskId: "p",
        status: "paused",
        terminalStatus: "needs_user_action",
      }),
      ...Array.from({ length: 8 }, (_, i) =>
        task(`n${i}`, 600 - i, { status: "blocked", terminalStatus: "awaiting_approval" }),
      ),
    ];
    const result = buildHomeSessions(tasks);
    expect(result.needsYou).toHaveLength(6);
    expect(result.needsYou.some((item) => item.id === "child")).toBe(false);
  });

  it("returns the shared empty value when only finished manual sessions exist", () => {
    expect(buildHomeSessions([task("a", 100), task("b", 200)])).toBe(EMPTY_HOME_SESSIONS);
  });

  it("lists automated sessions that finished cleanly in the last day as handled", () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    const hour = 60 * 60 * 1000;
    const result = buildHomeSessions(
      [
        task("cron-ok", now - hour, {
          source: "cron",
          completedAt: now - 2 * hour,
        } as Partial<Task>),
        task("cron-old", now - 30 * hour, { source: "cron" } as Partial<Task>),
        task("cron-failed", now - hour, { source: "cron", status: "failed" } as Partial<Task>),
        task("cron-waiting", now - hour, {
          source: "cron",
          status: "blocked",
          terminalStatus: "awaiting_approval",
        } as Partial<Task>),
        task("manual", now - hour),
      ],
      now,
    );
    expect(result.handled).toEqual([
      { id: "cron-ok", title: "Session cron-ok", updatedAt: now - 2 * hour },
    ]);
    expect(result.needsYou.map((item) => item.id)).toEqual(["cron-waiting"]);
  });
});

describe("sameHomeSessions", () => {
  it("compares by value", () => {
    const tasks = [
      task("a", 1),
      task("b", 2, { status: "paused", terminalStatus: "needs_user_action" }),
    ];
    expect(sameHomeSessions(buildHomeSessions(tasks), buildHomeSessions(tasks))).toBe(true);
    expect(
      sameHomeSessions(
        buildHomeSessions(tasks),
        buildHomeSessions([
          ...tasks,
          task("c", 3, { status: "blocked", terminalStatus: "awaiting_approval" }),
        ]),
      ),
    ).toBe(false);
    const handled = { ...EMPTY_HOME_SESSIONS, handled: [{ id: "h", title: "H", updatedAt: 1 }] };
    expect(sameHomeSessions(EMPTY_HOME_SESSIONS, handled)).toBe(false);
  });
});

describe("formatHomeSessionTime", () => {
  const now = new Date(2026, 9, 11, 12, 0).getTime();
  it("uses compact relative units within a day", () => {
    expect(formatHomeSessionTime(now - 20_000, now)).toBe("Now");
    expect(formatHomeSessionTime(now - 5 * 60_000, now)).toBe("5m");
    expect(formatHomeSessionTime(now - 3 * 3_600_000, now)).toBe("3h");
  });
  it("returns an empty label for missing timestamps", () => {
    expect(formatHomeSessionTime(0, now)).toBe("");
  });
});
