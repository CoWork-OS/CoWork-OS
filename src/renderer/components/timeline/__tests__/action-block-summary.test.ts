import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { TaskEvent } from "../../../../shared/types";
import { ActionBlock, buildActionBlockSummary } from "../ActionBlock";

function toolEvent(id: string, tool: string, timestamp: number): TaskEvent {
  return {
    id,
    taskId: "task-1",
    timestamp,
    type: "tool_call",
    payload: { tool },
    schemaVersion: 2,
  } as TaskEvent;
}

function toolOutcomeEvent(
  id: string,
  type: "tool_result" | "tool_error",
  tool: string,
  timestamp: number,
  result: Record<string, unknown> = { success: true },
): TaskEvent {
  return event(id, type, timestamp, {
    tool,
    ...(type === "tool_result" ? { result } : { error: "blocked by policy" }),
  });
}

function event(
  id: string,
  type: string,
  timestamp: number,
  payload: Record<string, unknown> = {},
): TaskEvent {
  return {
    id,
    taskId: "task-1",
    timestamp,
    type,
    payload,
    schemaVersion: 2,
  } as TaskEvent;
}

describe("buildActionBlockSummary", () => {
  it("uses a command icon for file reads with command activity", () => {
    const summary = buildActionBlockSummary([
      toolEvent("read", "read_file", 1000),
      toolEvent("command-1", "run_command", 1100),
      toolEvent("command-2", "run_command", 1200),
    ]);

    expect(summary.iconKind).toBe("command");
    expect(summary.summary).toBe("Explored 1 file, ran 2 commands");
  });

  it("uses a search icon for mixed file exploration and code searches", () => {
    const summary = buildActionBlockSummary([
      toolEvent("read-1", "read_file", 1000),
      toolEvent("read-2", "list_directory", 1100),
      toolEvent("search", "grep", 1200),
    ]);

    expect(summary.iconKind).toBe("search");
    expect(summary.summary).toBe("Explored 2 files, 1 search");
  });

  it("uses write wording and icon for created and edited files", () => {
    const summary = buildActionBlockSummary([
      toolEvent("create", "write_file", 1000),
      toolEvent("edit-1", "edit_file", 1100),
      toolEvent("edit-2", "edit_file", 1200),
    ]);

    expect(summary.iconKind).toBe("write");
    expect(summary.summary).toBe("Created 1 file, edited 2 files");
  });

  it("uses approval icon before command activity", () => {
    const summary = buildActionBlockSummary([
      event("approval-1", "approval_granted", 1000),
      event("approval-2", "approval_granted", 1100),
      toolEvent("command-1", "run_command", 1200),
      toolEvent("command-2", "run_command", 1300),
    ]);

    expect(summary.iconKind).toBe("approval");
    expect(summary.summary).toBe("Approved 2 requests, ran 2 commands");
  });

  it("describes the approved action instead of approval bookkeeping in compact mode", () => {
    const summary = buildActionBlockSummary(
      [
        event("approval-1", "approval_granted", 1000),
        toolEvent("command-1", "run_command", 1100),
        toolEvent("command-2", "run_command", 1200),
      ],
      undefined,
      { showApprovalNarration: false },
    );

    expect(summary.iconKind).toBe("command");
    expect(summary.summary).toBe("Ran 2 commands");
  });

  it("uses a connector action label instead of a generic action count", () => {
    const summary = buildActionBlockSummary([
      toolEvent("send", "gmail_send_email", 1000),
      toolOutcomeEvent("sent", "tool_result", "gmail_send_email", 1100),
    ]);

    expect(summary.summary).toBe("Sent email");
  });

  it("uses generation icon for plain generate steps", () => {
    const summary = buildActionBlockSummary([
      event("step-1", "timeline_step_started", 1000, {
        step: { description: "generate" },
      }),
    ]);

    expect(summary.iconKind).toBe("generate");
    expect(summary.summary).toBe("1 step");
  });

  it("counts browser tools as web activity", () => {
    const summary = buildActionBlockSummary([
      toolEvent("browser-1", "browser_navigate", 1000),
      toolEvent("browser-2", "browser_screenshot", 1100),
    ]);

    expect(summary.iconKind).toBe("web");
    expect(summary.summary).toBe("2 web lookups");
  });

  it("does not report blocked tool calls as completed work", () => {
    const summary = buildActionBlockSummary([
      toolEvent("write-call", "write_file", 1000),
      toolOutcomeEvent("write-error", "tool_error", "write_file", 1100),
      toolEvent("web-call", "web_fetch", 1200),
      toolOutcomeEvent("web-error", "tool_error", "web_fetch", 1300),
    ]);

    expect(summary.summary).toBe("2 actions");
    expect(summary.summary).not.toContain("Created");
    expect(summary.summary).not.toContain("web lookup");
    expect(summary.toolCallCount).toBe(2);
  });

  it("counts only successful outcomes when a tool is both retried and blocked", () => {
    const summary = buildActionBlockSummary([
      toolEvent("write-call-1", "write_file", 1000),
      toolOutcomeEvent("write-result-1", "tool_result", "write_file", 1100),
      toolEvent("write-call-2", "write_file", 1200),
      toolOutcomeEvent("write-error-2", "tool_error", "write_file", 1300),
    ]);

    expect(summary.summary).toBe("Created 1 file");
    expect(summary.toolCallCount).toBe(2);
  });

  it("treats timeline-v2 tool_error events as outcomes", () => {
    const summary = buildActionBlockSummary([
      toolEvent("write-call", "write_file", 1000),
      {
        ...event("write-error", "timeline_error", 1100, {
          tool: "write_file",
          error: "Path is outside workspace boundary",
          legacyType: "tool_error",
        }),
        legacyType: "tool_error",
        status: "failed",
      } as TaskEvent,
    ]);

    expect(summary.summary).toBe("1 action");
    expect(summary.summary).not.toContain("Created");
    expect(summary.toolCallCount).toBe(1);
  });

  it("renders generation blocks with a sparkles glyph instead of the generic work circle", () => {
    const html = renderToStaticMarkup(
      createElement(ActionBlock, {
        blockId: "generate-block",
        summary: "1 step",
        iconKind: "generate",
        stepCount: 1,
        toolCallCount: 0,
        durationMs: 0,
        outputTokens: 0,
        isActive: false,
        expanded: false,
        onToggle: () => {},
        children: createElement("span", null, "generate"),
      }),
    );

    expect(html).toContain("lucide-sparkles");
    expect(html).not.toContain("lucide-circle-dot");
  });

  it("renders generic work blocks with activity glyph instead of circle-dot", () => {
    const html = renderToStaticMarkup(
      createElement(ActionBlock, {
        blockId: "work-block",
        summary: "Working...",
        iconKind: "work",
        stepCount: 1,
        toolCallCount: 0,
        durationMs: 0,
        outputTokens: 0,
        isActive: true,
        expanded: true,
        onToggle: () => {},
        children: createElement("span", null, "Working..."),
      }),
    );

    expect(html).toContain("lucide-activity");
    expect(html).not.toContain("lucide-circle-dot");
  });
});
