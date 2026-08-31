import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TaskPauseBanner, TaskPauseBannerDetailsContent } from "../TaskPauseBanner";

describe("TaskPauseBanner", () => {
  it("renders profile-first actions for command-tool pauses", () => {
    const markup = renderToStaticMarkup(
      React.createElement(TaskPauseBanner, {
        message: "Shell access is currently disabled for this workspace.",
        reasonCode: "shell_permission_required",
        onOpenAccessProfilePicker: vi.fn(),
        onContinueWithoutCommands: vi.fn(),
      }),
    );

    expect(markup).toContain("Switch access profile");
    expect(markup).toContain("Continue without commands");
    expect(markup).toContain("This task needs command tools to continue.");
  });

  it("explains explicit required decisions as answerable choices", () => {
    const markup = renderToStaticMarkup(
      React.createElement(TaskPauseBanner, {
        message: "Need your confirmation before changing the rollout scope.",
        reasonCode: "required_decision",
      }),
    );

    expect(markup).not.toContain("Switch access profile");
    expect(markup).not.toContain("Continue without commands");
    expect(markup).toContain("Decision needed to continue.");
    expect(markup).toContain("Reply with your choice or answer");
  });

  it("says when a required-decision pause has no concrete question", () => {
    const markup = renderToStaticMarkup(
      React.createElement(TaskPauseBanner, {
        message:
          "Almarion, executed. I tightened the article so it is explicitly about CoWork OS as a local-first desktop AI coworker runtime.",
        reasonCode: "required_decision",
      }),
    );

    expect(markup).toContain("Paused after an update.");
    expect(markup).toContain("I don&#x27;t see a specific decision request here");
    expect(markup).toContain("type continue to let it proceed");
  });

  it("renders markdown emphasis in the inline pause summary", () => {
    const markup = renderToStaticMarkup(
      React.createElement(TaskPauseBanner, {
        message:
          "Almarion, assuming this Friday is **May 1** and you're going **by car**, these are the strongest options.",
        reasonCode: "required_decision",
      }),
    );

    expect(markup).toContain("<strong>May 1</strong>");
    expect(markup).toContain("<strong>by car</strong>");
    expect(markup).not.toContain("**May 1**");
    expect(markup).not.toContain("**by car**");
  });

  it("repairs truncated bold markers in the inline pause summary", () => {
    const markup = renderToStaticMarkup(
      React.createElement(TaskPauseBanner, {
        message:
          "I need confirmation on **a very long route preference that should remain readable when summarized without leaking raw markdown syntax into the banner display because the pause prompt is meant to be a compact human-readable question for the user before the task continues.",
        reasonCode: "required_decision",
      }),
    );

    expect(markup).toContain("<strong>");
    expect(markup).not.toContain("**");
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

  it("does not frame unknown pauses as decision check-ins", () => {
    const markup = renderToStaticMarkup(
      React.createElement(TaskPauseBanner, {
        message: "Paused - awaiting user input",
      }),
    );

    expect(markup).toContain("Task paused.");
    expect(markup).not.toContain("Quick check-in");
    expect(markup).not.toContain("decision point");
  });

  it("renders markdown formatting in the details content", () => {
    const markup = renderToStaticMarkup(
      React.createElement(TaskPauseBannerDetailsContent, {
        message:
          "Need your confirmation.\n\n## Recommended next step\n\n- Ship the fix\n- Re-test the modal",
        markdownComponents: {},
      }),
    );

    expect(markup).toContain("<h2>Recommended next step</h2>");
    expect(markup).toContain("<li>Ship the fix</li>");
    expect(markup).not.toContain("## Recommended next step");
  });
});
