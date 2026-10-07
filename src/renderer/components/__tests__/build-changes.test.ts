import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../../shared/types";
import { deriveBuildChanges, diffLines, trimContext } from "../calm/build-changes";

const toolCall = (tool: string, input: Record<string, unknown>, timestamp: number) =>
  ({
    id: `e${timestamp}`,
    taskId: "t1",
    type: "tool_call",
    timestamp,
    payload: { tool, input, toolUseId: `e${timestamp}` },
  }) as unknown as TaskEvent;

function outcome(call: TaskEvent, success: boolean): TaskEvent {
  return {
    ...call,
    id: `${call.id}-result`,
    type: "tool_result",
    payload: {
      tool: call.payload.tool,
      toolUseId: call.payload.toolUseId,
      result: { success, ...(success ? {} : { error: "old_string not found" }) },
    },
  };
}

describe("diffLines", () => {
  it("marks added, removed and unchanged lines", () => {
    expect(diffLines("a\nb\nc\n", "a\nB\nc\nd\n")).toEqual([
      { kind: "context", text: "a" },
      { kind: "removed", text: "b" },
      { kind: "added", text: "B" },
      { kind: "context", text: "c" },
      { kind: "added", text: "d" },
    ]);
  });

  it("folds long unchanged runs", () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n");
    const after = before.replace("line 10", "changed");
    const trimmed = trimContext(diffLines(before, after) ?? []);
    expect(trimmed[0]).toEqual({ kind: "fold", text: "7 unchanged lines" });
    expect(trimmed.filter((line) => line.kind === "added")).toEqual([
      { kind: "added", text: "changed" },
    ]);
    expect(trimmed[trimmed.length - 1]).toEqual({ kind: "fold", text: "6 unchanged lines" });
  });
});

describe("deriveBuildChanges", () => {
  it("excludes failures and unfinished calls without corrupting the next rewrite's baseline", () => {
    const write = toolCall("write_file", { path: "index.html", content: "hello" }, 1);
    const failedEdit = toolCall(
      "edit_file",
      {
        file_path: "index.html",
        old_string: "missing",
        new_string: "fake edit",
      },
      2,
    );
    const failedWrite = toolCall("write_file", { path: "index.html", content: "fake rewrite" }, 3);
    const rewrite = toolCall("write_file", { path: "index.html", content: "world" }, 4);
    const pending = toolCall("write_file", { path: "index.html", content: "unfinished" }, 5);
    const changes = deriveBuildChanges(
      [
        write,
        outcome(write, true),
        failedEdit,
        outcome(failedEdit, false),
        failedWrite,
        outcome(failedWrite, false),
        rewrite,
        outcome(rewrite, true),
        pending,
      ],
      { changedPaths: new Map([["index.html", "created"]]) },
    );
    expect(changes[0].hunks).toHaveLength(2);
    expect(changes[0].hunks[1].lines).toEqual([
      { kind: "removed", text: "hello" },
      { kind: "added", text: "world" },
    ]);
    expect(changes[0]).toMatchObject({ added: 2, removed: 1 });
  });

  it("pairs concurrent results by ID instead of tool name or result order", () => {
    const a = toolCall("write_file", { path: "a.html", content: "failed" }, 1);
    const b = toolCall("write_file", { path: "b.html", content: "applied" }, 2);
    const changes = deriveBuildChanges([a, b, outcome(b, true), outcome(a, false)], {
      changedPaths: new Map([
        ["a.html", "modified"],
        ["b.html", "created"],
      ]),
    });
    expect(changes.find((change) => change.path === "a.html")?.hunks).toEqual([]);
    expect(changes.find((change) => change.path === "b.html")?.added).toBe(1);
  });

  it("supports legacy calls while rejecting thrown errors", () => {
    const a = toolCall("write_file", { path: "index.html", content: "hello" }, 1);
    const b = toolCall(
      "edit_file",
      {
        path: "index.html",
        old_string: "hello",
        new_string: "wrong",
      },
      2,
    );
    delete a.payload.toolUseId;
    delete b.payload.toolUseId;
    const error = {
      ...b,
      id: "error",
      type: "tool_error",
      payload: {
        tool: "edit_file",
        error: "cancelled",
        cancelled: true,
      },
    } as TaskEvent;
    const changes = deriveBuildChanges([a, outcome(a, true), b, error], {
      changedPaths: new Map([["index.html", "created"]]),
    });
    expect(changes[0].hunks).toHaveLength(1);
    expect(changes[0].hunks[0].lines).toEqual([{ kind: "added", text: "hello" }]);
  });
  it("diffs rewrites against the build's earlier content and counts lines", () => {
    const events = [
      toolCall("write_file", { path: "/w/index.html", content: "<h1>Hi</h1>\n<p>x</p>\n" }, 1),
      toolCall("write_file", { path: "index.html", content: "<h1>Hello</h1>\n<p>x</p>\n" }, 2),
      toolCall(
        "edit_file",
        { file_path: "app.js", old_string: "let a = 1;", new_string: "let a = 2;" },
        3,
      ),
      toolCall("write_file", { path: "/w/notes.txt", content: "not counted" }, 4),
    ].flatMap((event) => [event, outcome(event, true)]);
    const changes = deriveBuildChanges(events, {
      workspacePath: "/w",
      changedPaths: new Map([
        ["index.html", "created"],
        ["app.js", "modified"],
        ["old.css", "deleted"],
      ]),
    });

    expect(changes.map((change) => change.path)).toEqual(["app.js", "index.html", "old.css"]);
    const index = changes.find((change) => change.path === "index.html");
    expect(index?.hunks).toHaveLength(2);
    expect(index?.hunks[1].lines).toEqual([
      { kind: "removed", text: "<h1>Hi</h1>" },
      { kind: "added", text: "<h1>Hello</h1>" },
      { kind: "context", text: "<p>x</p>" },
    ]);
    expect(index).toMatchObject({ added: 3, removed: 1 });
    expect(changes.find((change) => change.path === "app.js")).toMatchObject({
      added: 1,
      removed: 1,
    });
    expect(changes.find((change) => change.path === "old.css")?.hunks).toEqual([]);
  });
});
