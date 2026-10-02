import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../../../shared/types";
import {
  isFileEventCoveredByToolCall,
  normalizeFileChangePath,
  summarizeFileChange,
} from "../file-change-row";

function event(
  id: string,
  type: string,
  timestamp: number,
  payload: Record<string, unknown>,
): TaskEvent {
  return { id, taskId: "task-1", type, timestamp, payload, schemaVersion: 2 } as TaskEvent;
}

const call = (id: string, tool: string, timestamp: number, input: Record<string, unknown>) =>
  event(id, "tool_call", timestamp, { tool, input });

describe("summarizeFileChange", () => {
  it("counts an edit's changed lines and multiplies them by its replacements", () => {
    const editCall = call("edit", "edit_file", 10, {
      file_path: "/ws/src/app.ts",
      old_string: "const a = 1;\nconst b = 2;",
      new_string: "const a = 1;\nconst b = 3;\nconst c = 4;",
    });
    const editResult = event("edit-result", "tool_result", 11, {
      tool: "edit_file",
      result: { replacements: 2 },
    });

    expect(summarizeFileChange(editCall, editResult, [], "/ws")).toEqual({
      kind: "edited",
      path: "src/app.ts",
      added: 4,
      removed: 2,
    });
  });

  it("uses write_file's reported stats to tell an overwrite from a new file", () => {
    const writeCall = call("write", "write_file", 10, { path: "./notes.md", content: "x\ny" });
    const fileEvent = event("file", "file_created", 11, {
      path: "notes.md",
      existed: true,
      linesAdded: 1,
      linesRemoved: 4,
    });

    expect(summarizeFileChange(writeCall, undefined, [writeCall, fileEvent])).toEqual({
      kind: "edited",
      path: "notes.md",
      added: 1,
      removed: 4,
    });
  });

  it("falls back to counting the written content for events without stats", () => {
    const writeCall = call("write", "write_file", 10, { path: "notes.md", content: "a\nb\nc" });
    const fileEvent = event("file", "file_created", 11, { path: "notes.md", lineCount: 3 });

    expect(summarizeFileChange(writeCall, undefined, [writeCall, fileEvent])).toEqual({
      kind: "created",
      path: "notes.md",
      added: 3,
      removed: 0,
    });
  });

  it("describes a delete without line counts", () => {
    const deleteCall = call("delete", "delete_file", 10, { path: "old.txt" });

    expect(summarizeFileChange(deleteCall, undefined, [])).toEqual({
      kind: "deleted",
      path: "old.txt",
      added: null,
      removed: null,
    });
  });

  it("ignores events that are not file-change tool calls", () => {
    expect(summarizeFileChange(call("read", "read_file", 1, { path: "a" }), undefined, [])).toBe(
      null,
    );
  });
});

describe("isFileEventCoveredByToolCall", () => {
  const writeCall = call("write", "write_file", 10, { path: "/ws/docs/plan.md", content: "x" });

  it("matches a file event to an earlier call on the same workspace path", () => {
    const fileEvent = event("file", "file_created", 11, { path: "docs/plan.md" });
    expect(isFileEventCoveredByToolCall(fileEvent, [writeCall, fileEvent], "/ws")).toBe(true);
  });

  it("keeps file events that no tool call produced", () => {
    const fileEvent = event("file", "file_created", 11, { path: "docs/other.md" });
    expect(isFileEventCoveredByToolCall(fileEvent, [writeCall, fileEvent], "/ws")).toBe(false);
  });

  it("normalizes separators, workspace prefixes and leading ./", () => {
    expect(normalizeFileChangePath("C:\\ws\\a\\b.ts", "C:\\ws")).toBe("a/b.ts");
    expect(normalizeFileChangePath("./a/b.ts")).toBe("a/b.ts");
  });
});
