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
      task("waiting", 200, { terminalStatus: "needs_user_action" }),
      task("new", 300),
    ]);
    expect(result.needsYou).toEqual([
      { id: "waiting", title: "Session waiting", updatedAt: 200, attention: "Response needed" },
    ]);
    expect(result.recent.map((item) => item.id)).toEqual(["new", "old"]);
  });

  it("leaves out sub-agents and automated sessions from recent, and caps both lists", () => {
    const tasks = [
      task("child", 900, { parentTaskId: "p" }),
      task("auto", 800, { source: "cron" } as Partial<Task>),
      ...Array.from({ length: 6 }, (_, i) => task(`r${i}`, 700 - i)),
      ...Array.from({ length: 8 }, (_, i) =>
        task(`n${i}`, 600 - i, { terminalStatus: "awaiting_approval" }),
      ),
    ];
    const result = buildHomeSessions(tasks);
    expect(result.recent.map((item) => item.id)).toEqual(["r0", "r1", "r2", "r3"]);
    expect(result.needsYou).toHaveLength(6);
    expect(result.recent.some((item) => item.id === "child")).toBe(false);
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
    expect(result.recent.map((item) => item.id)).toEqual(["manual"]);
  });
});

describe("sameHomeSessions", () => {
  it("compares by value", () => {
    const tasks = [task("a", 1), task("b", 2, { terminalStatus: "needs_user_action" })];
    expect(sameHomeSessions(buildHomeSessions(tasks), buildHomeSessions(tasks))).toBe(true);
    expect(
      sameHomeSessions(buildHomeSessions(tasks), buildHomeSessions([...tasks, task("c", 3)])),
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
