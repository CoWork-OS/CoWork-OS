import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { TaskStatusBadge } from "./TaskStatusBadge";

describe("TaskStatusBadge", () => {
  it("keeps a renderer-specific class while sharing safe status markup", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskStatusBadge, {
        className: "web-status",
        statusClassPrefix: "web-status-",
        status: "in_progress",
        label: "In Progress",
      }),
    );

    expect(markup).toBe(
      '<span class="web-status web-status-in_progress" data-task-status="in_progress">In Progress</span>',
    );
  });

  it("normalizes untrusted status text before using it in a class name", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskStatusBadge, { status: "waiting / for approval!" }),
    );

    expect(markup).toBe(
      '<span class="status-waiting-for-approval-" data-task-status="waiting / for approval!">waiting / for approval!</span>',
    );
  });
});
