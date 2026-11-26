import { describe, expect, it } from "vitest";
import {
  nextAttentionSessionId,
  sessionOrderFromSidebarRows,
  sessionIdAtPosition,
} from "../session-navigation";

function taskRow(id: string, depth = 0, section: "user" | "automated" = "user", synthetic = false) {
  return { kind: "task", section, row: { depth, node: { synthetic, task: { id } } } };
}

describe("sessionOrderFromSidebarRows", () => {
  it("lists top-level sessions in row order, skipping other rows, sub-agents and repeats", () => {
    expect(
      sessionOrderFromSidebarRows([
        { kind: "date-header" },
        taskRow("a"),
        taskRow("child", 1),
        taskRow("b"),
        taskRow("group", 0, "user", true),
        { kind: "workspace-header" },
        taskRow("a"),
        taskRow("c"),
        taskRow("cron", 0, "automated"),
        { kind: "load-more" },
      ]),
    ).toEqual(["a", "b", "c"]);
  });
});

describe("nextAttentionSessionId", () => {
  const order = ["a", "b", "c", "d", "e"];

  it("returns null when nothing waits", () => {
    expect(nextAttentionSessionId(order, [], "a")).toBeNull();
  });

  it("goes to the next waiting session below the current one and wraps", () => {
    expect(nextAttentionSessionId(order, ["b", "d"], "b")).toBe("d");
    expect(nextAttentionSessionId(order, ["b", "d"], "d")).toBe("b");
  });

  it("follows sidebar order, not the order the queue gives", () => {
    expect(nextAttentionSessionId(order, ["d", "b"], "b")).toBe("d");
  });

  it("from a session that is not waiting, takes the first waiting one below it", () => {
    expect(nextAttentionSessionId(order, ["b", "d"], "c")).toBe("d");
    expect(nextAttentionSessionId(order, ["b", "d"], "e")).toBe("b");
  });

  it("with no session open, takes the first waiting one", () => {
    expect(nextAttentionSessionId(order, ["d", "b"], null)).toBe("b");
  });

  it("returns null when the only waiting session is the open one", () => {
    expect(nextAttentionSessionId(order, ["c"], "c")).toBeNull();
  });

  it("reaches waiting sessions the sidebar does not show, after the shown ones", () => {
    expect(nextAttentionSessionId(order, ["hidden", "d"], "d")).toBe("hidden");
    expect(nextAttentionSessionId(order, ["hidden", "d"], "hidden")).toBe("d");
    expect(nextAttentionSessionId([], ["hidden"], null)).toBe("hidden");
  });
});

describe("sessionIdAtPosition", () => {
  it("counts from 1 and stops at the end of the list", () => {
    expect(sessionIdAtPosition(["a", "b"], 1)).toBe("a");
    expect(sessionIdAtPosition(["a", "b"], 2)).toBe("b");
    expect(sessionIdAtPosition(["a", "b"], 3)).toBeNull();
    expect(sessionIdAtPosition(["a", "b"], 0)).toBeNull();
  });
});
