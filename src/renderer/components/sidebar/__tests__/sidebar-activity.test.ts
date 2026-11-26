import { describe, expect, it } from "vitest";
import type { Task } from "../../../../shared/types";
import { getSidebarSessionRowHeight } from "../../../utils/sidebar-session-state";
import {
  ACTIVITY_NEEDS_YOU_GROUP,
  SIDEBAR_RESULT_SNIPPET_CHARS,
  groupSessionsByActivity,
  sidebarResultSnippet,
} from "../sidebar-activity";

const task = (id: string, extra: Partial<Task> = {}) => ({ task: { id, ...extra } as Task });

describe("groupSessionsByActivity", () => {
  const nodes = [task("a"), task("b"), task("c"), task("d"), task("e")];
  const day: Record<string, string> = {
    a: "Today",
    b: "Today",
    c: "Yesterday",
    d: "Earlier",
    e: "Today",
  };

  it("puts what needs you first, then day groups, keeping the order given", () => {
    const groups = groupSessionsByActivity(nodes, {
      needsYou: (node) => node.task.id === "b" || node.task.id === "d",
      dayBucket: (t) => day[t.id],
    });
    expect(groups.map((g) => [g.label, g.nodes.map((n) => n.task.id)])).toEqual([
      [ACTIVITY_NEEDS_YOU_GROUP, ["b", "d"]],
      ["Today", ["a", "e"]],
      ["Yesterday", ["c"]],
    ]);
  });

  it("leaves out empty groups", () => {
    expect(
      groupSessionsByActivity(nodes.slice(0, 1), {
        needsYou: () => false,
        dayBucket: () => "Today",
      }),
    ).toEqual([{ label: "Today", nodes: [nodes[0]] }]);
    expect(groupSessionsByActivity([], { needsYou: () => true, dayBucket: () => "Today" })).toEqual(
      [],
    );
  });
});

describe("sidebarResultSnippet", () => {
  it("shows the first plain line of a finished session's result", () => {
    expect(
      sidebarResultSnippet({
        status: "completed",
        resultSummary: "## Summary\n\n- **Booked** the [Lisbon flight](https://x.test) for `May 3`",
      }),
    ).toBe("Booked the Lisbon flight for May 3");
    expect(sidebarResultSnippet({ status: "completed", resultSummary: "# Done" })).toBe("Done");
    expect(
      sidebarResultSnippet({
        status: "failed",
        resultSummary: "\n\n> The *API key* was rejected\nmore",
      }),
    ).toBe("The API key was rejected");
  });

  it("skips code fences and falls back to other summaries", () => {
    expect(
      sidebarResultSnippet({
        status: "completed",
        resultSummary: "```bash\nnpm test\n```\nTests pass",
      }),
    ).toBe("Tests pass");
    expect(
      sidebarResultSnippet({
        status: "completed",
        resultSummary: "  ",
        bestKnownOutcome: { resultSummary: "Draft saved" } as Task["bestKnownOutcome"],
      }),
    ).toBe("Draft saved");
  });

  it("is empty for sessions that have not finished or have no result", () => {
    expect(sidebarResultSnippet({ status: "executing", resultSummary: "Halfway" })).toBeNull();
    expect(sidebarResultSnippet({ status: "completed" })).toBeNull();
  });

  it("cuts a long line at a word", () => {
    const snippet = sidebarResultSnippet({
      status: "completed",
      resultSummary: "word ".repeat(60),
    })!;
    expect(snippet.endsWith("…")).toBe(true);
    expect(snippet.length).toBeLessThanOrEqual(SIDEBAR_RESULT_SNIPPET_CHARS + 1);
    expect(snippet).not.toMatch(/wor…$/);
  });
});

describe("getSidebarSessionRowHeight", () => {
  it("gives a result line the same second line as an activity label", () => {
    const t = { id: "a", status: "completed" } as Task;
    expect(getSidebarSessionRowHeight(t, () => null)).toBe(32);
    expect(getSidebarSessionRowHeight(t, () => null, true)).toBe(46);
  });
});
