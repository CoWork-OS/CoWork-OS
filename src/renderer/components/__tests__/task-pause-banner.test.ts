import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TaskPauseBanner, TaskPauseBannerDetailsContent } from "../TaskPauseBanner";

describe("TaskPauseBanner", () => {
  it("renders explicit shell action buttons for shell permission pauses", () => {
    const markup = renderToStaticMarkup(
      React.createElement(TaskPauseBanner, {
        message: "Shell access is currently disabled for this workspace.",
        reasonCode: "shell_permission_required",
        onEnableShell: vi.fn(),
        onContinueWithoutShell: vi.fn(),
      }),
    );

    expect(markup).toContain("Enable shell");
    expect(markup).toContain("Continue without shell");
    expect(markup).toContain("Shell access is needed to continue.");
  });

  it("keeps generic paused tasks on the normal free-text path", () => {
    const markup = renderToStaticMarkup(
      React.createElement(TaskPauseBanner, {
        message: "Need your confirmation before changing the rollout scope.",
        reasonCode: "required_decision",
      }),
    );

    expect(markup).not.toContain("Enable shell");
    expect(markup).not.toContain("Continue without shell");
    expect(markup).toContain("Type anything below to continue");
  });

  it("hides internal user-action reason codes and explains the decision needed", () => {
    const markup = renderToStaticMarkup(
      React.createElement(TaskPauseBanner, {
        message: "user_action_required_failure",
        reasonCode: "user_action_required_failure",
      }),
    );

    expect(markup).toContain("I need your decision to continue.");
    expect(markup).toContain("Reply with what you want me to do next");
    expect(markup).not.toContain("user_action_required_failure");
  });

  it("renders markdown formatting in the details content", () => {
    const markup = renderToStaticMarkup(
      React.createElement(TaskPauseBannerDetailsContent, {
        message: "Need your confirmation.\n\n## Recommended next step\n\n- Ship the fix\n- Re-test the modal",
        markdownComponents: {},
      }),
    );

    expect(markup).toContain("<h2>Recommended next step</h2>");
    expect(markup).toContain("<li>Ship the fix</li>");
    expect(markup).not.toContain("## Recommended next step");
  });
});
