import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import {
  getAgentLifecycleRecapLine,
  renderEventDetails,
  renderEventTitle,
} from "../MainContent/timeline-event-rendering";

function makeMessageEvent(payload: Record<string, unknown>): TaskEvent {
  return {
    id: "agent-message-1",
    taskId: "parent-task",
    type: "agent_message",
    timestamp: 1,
    payload,
  } as TaskEvent;
}

describe("agent message timeline rows", () => {
  it("renders the recipient and queued delivery state", () => {
    const event = makeMessageEvent({
      messageId: "message-1",
      targetTaskId: "child-task",
      recipientLabel: "Backend",
      senderType: "agent",
      senderLabel: "Main agent",
      message: "Please run the migration checks.",
      status: "queued",
    });

    const title = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventTitle(event)),
    );
    const details = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventDetails(event, false, {})),
    );

    expect(title).toContain("Messaged an agent");
    expect(getAgentLifecycleRecapLine(event)).toBe(
      "Messaged Backend: Please run the migration checks.",
    );
    expect(details).toContain("Please run the migration checks.");
    expect(details).toContain("Queued for the next turn");
  });

  it("renders accepted delivery explicitly and uses it as the fallback state", () => {
    const explicitAccepted = makeMessageEvent({
      recipientLabel: "Backend",
      message: "The request was accepted.",
      status: "accepted",
    });
    const defaultAccepted = makeMessageEvent({
      recipientLabel: "Backend",
      message: "The legacy receipt has no status.",
    });

    const explicitDetails = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventDetails(explicitAccepted, false, {})),
    );
    const defaultDetails = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventDetails(defaultAccepted, false, {})),
    );

    expect(explicitDetails).toContain("Accepted");
    expect(explicitDetails).not.toContain("Delivered");
    expect(defaultDetails).toContain("Accepted");
    expect(defaultDetails).not.toContain("Delivered");
  });

  it("adds stable delivery attributes and omits absent identifiers", () => {
    const event = makeMessageEvent({
      messageId: "message-1",
      senderTaskId: "sender-task",
      targetTaskId: "target-task",
      message: "Inspect the delivery receipt.",
      status: "delivered",
    });
    const details = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventDetails(event, false, {})),
    );

    expect(details).toContain('data-message-id="message-1"');
    expect(details).toContain('data-delivery-state="delivered"');
    expect(details).toContain('data-sender-task-id="sender-task"');
    expect(details).toContain('data-target-task-id="target-task"');

    const withoutIdentifiers = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        renderEventDetails(makeMessageEvent({ message: "No identifiers." }), false, {}),
      ),
    );
    expect(withoutIdentifiers).not.toContain("data-message-id=");
    expect(withoutIdentifiers).not.toContain("data-sender-task-id=");
    expect(withoutIdentifiers).not.toContain("data-target-task-id=");
  });

  it("renders a failed delivery as an actionable error", () => {
    const event = makeMessageEvent({
      recipientLabel: "Backend",
      senderType: "agent",
      message: "Stop and summarize.",
      status: "failed",
      error: "Target task is no longer available",
    });

    const title = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventTitle(event)),
    );
    const details = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventDetails(event, false, {})),
    );

    expect(title).toContain("Couldn&#x27;t message an agent");
    expect(getAgentLifecycleRecapLine(event)).toBe(
      "Couldn't message Backend: Target task is no longer available",
    );
    expect(details).toContain("Target task is no longer available");
    expect(details).toContain("Delivery failed");
  });

  it("offers a direct child-sidebar action when the recipient is available", () => {
    const event = makeMessageEvent({
      targetTaskId: "child-task",
      recipientLabel: "Backend",
      senderType: "agent",
      message: "Please report the verification result.",
      status: "delivered",
    });
    const childTask = { id: "child-task", title: "Backend" } as any;
    const details = renderToStaticMarkup(
      React.createElement(
        React.Fragment,
        null,
        renderEventDetails(
          event,
          false,
          {},
          {
            childTasks: [childTask],
            onOpenAgent: () => undefined,
          },
        ),
      ),
    );

    expect(details).toContain("Open agent");
  });
});
