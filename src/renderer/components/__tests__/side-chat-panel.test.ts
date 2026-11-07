import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { Task, TaskEvent } from "../../../shared/types";
import { SideChatPanel } from "../SideChatPanel";

const baseTask = {
  id: "side-task",
  title: "Side chat",
  prompt: "",
  workspaceId: "workspace-1",
  status: "completed",
  createdAt: 1,
  updatedAt: 1,
} as Task;

function taskEvent(overrides: Partial<TaskEvent>): TaskEvent {
  return {
    id: overrides.id || "event",
    taskId: "side-task",
    timestamp: overrides.timestamp || 1,
    type: overrides.type || "assistant_message",
    payload: overrides.payload || {},
    ...overrides,
  } as TaskEvent;
}

describe("SideChatPanel", () => {
  it("hides forked parent transcript events from the visible sidechat conversation", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SideChatPanel, {
        parentTask: { ...baseTask, id: "parent-task", title: "make my internet faster" },
        sideTask: baseTask,
        events: [
          taskEvent({
            id: "parent-question",
            type: "user_message",
            payload: {
              message: "make my internet faster",
              forkedFromTaskId: "parent-task",
              forkedFromEventId: "parent-question",
            },
          }),
          taskEvent({
            id: "parent-answer",
            type: "assistant_message",
            payload: {
              message: "Speed test completed.",
              forkedFromTaskId: "parent-task",
              forkedFromEventId: "parent-answer",
            },
          }),
          taskEvent({
            id: "side-question",
            type: "user_message",
            payload: { message: "how is it going?" },
          }),
          taskEvent({
            id: "side-answer",
            type: "assistant_message",
            payload: { message: "The side answer only." },
          }),
        ],
        onSendMessage: () => undefined,
        onClose: () => undefined,
      }),
    );

    expect(markup).toContain("how is it going?");
    expect(markup).toContain("The side answer only.");
    expect(markup).not.toContain("make my internet faster</div>");
    expect(markup).not.toContain("Speed test completed.");
  });

  it("shows a side chat waiting for the next question as ready, not queued", () => {
    const render = (sideTask: Task) =>
      renderToStaticMarkup(
        React.createElement(SideChatPanel, {
          parentTask: { ...baseTask, id: "parent-task", title: "Parent" },
          sideTask,
          events: [],
          onSendMessage: () => undefined,
          onClose: () => undefined,
        }),
      );
    const idle = render({ ...baseTask, status: "pending", branchFromTaskId: "parent-task" });
    expect(idle).toContain("side-chat-status-ready");
    expect(idle).toContain(">Ready<");
    expect(idle).not.toContain(">Queued<");

    const queued = render({ ...baseTask, status: "queued" });
    expect(queued).toContain(">Queued<");
  });

  it("renders sidechat message markdown instead of literal markdown syntax", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SideChatPanel, {
        parentTask: { ...baseTask, id: "parent-task", title: "Parent" },
        sideTask: baseTask,
        events: [
          taskEvent({
            id: "side-answer",
            type: "assistant_message",
            payload: {
              message: [
                "Use `git log` safely:",
                "",
                "- Disable the pager",
                "",
                "```bash",
                "GIT_PAGER=cat git log --oneline -n 10",
                "```",
              ].join("\n"),
            },
          }),
        ],
        onSendMessage: () => undefined,
        onClose: () => undefined,
      }),
    );

    expect(markup).toContain("<code>git log</code>");
    expect(markup).toContain("<li>Disable the pager</li>");
    expect(markup).toContain("<pre>");
    expect(markup).not.toContain("```bash");
  });
});
