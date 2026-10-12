import { mkdirSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { areSidebarPropsEqual } from "../Sidebar";
import type { Task } from "../../../shared/types";

const task = (id: string, status = "completed") => ({ id, status, updatedAt: 1 }) as Task;
function props(tasks: Task[]) {
  return {
    workspace: null,
    tasks,
    selectedTaskId: null,
    onSelectTask: () => {},
    onTasksChanged: () => {},
  };
}

describe("sidebar comparator", () => {
  it("detects changes to status, attention and bot projections in replacement collections", () => {
    const previous = props([task("a")]);
    expect(areSidebarPropsEqual(previous, { ...previous, tasks: [task("a", "running")] })).toBe(
      false,
    );
    expect(areSidebarPropsEqual(previous, { ...previous, completionAttentionTaskIds: ["a"] })).toBe(
      false,
    );
    expect(
      areSidebarPropsEqual(previous, {
        ...previous,
        botConversationProjections: {
          bot: { state: "running", activityLabel: "Reading", lastActivityAt: 1 },
        } as Any,
      }),
    ).toBe(false);
  });
  it("does not inspect task fields when both props share the same collection", () => {
    const same = props([
      {
        ...task("a"),
        get id(): string {
          throw new Error("Unchanged list should not be scanned");
        },
      },
    ]);
    expect(areSidebarPropsEqual(same, { ...same })).toBe(true);
  });
  it("accepts equivalent replacement task lists", () => {
    const previous = props([task("a")]);
    expect(areSidebarPropsEqual(previous, { ...previous, tasks: [task("a")] })).toBe(true);
  });
  it("measures unchanged collection comparisons", () => {
    const previous = props(Array.from({ length: 500 }, (_, i) => task(String(i))));
    const next = { ...previous };
    for (let i = 0; i < 100; i++) areSidebarPropsEqual(previous, next);
    const start = performance.now();
    for (let i = 0; i < 1000; i++) areSidebarPropsEqual(previous, next);
    const result = {
      unchangedSidebarComparisons: 1000,
      tasks: 500,
      elapsedMs: performance.now() - start,
    };
    if (process.env.COWORK_UI_PROFILE) {
      mkdirSync("logs", { recursive: true });
      writeFileSync(
        `logs/sidebar-comparator-${process.env.COWORK_UI_PROFILE}.json`,
        JSON.stringify(result),
      );
    }
    expect(areSidebarPropsEqual(previous, next)).toBe(true);
  });
});
