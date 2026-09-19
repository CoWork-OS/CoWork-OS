import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TaskEvent } from "../../../shared/types";
import {
  getAgentLifecycleRecapLine,
  renderEventDetails,
  renderEventTitle,
} from "../MainContent/timeline-event-rendering";

function makeAgentEvent(type: string, payload: Record<string, unknown>): TaskEvent {
  return {
    id: `${type}-1`,
    taskId: "parent-task",
    type,
    timestamp: 1,
    payload,
  } as TaskEvent;
}

describe("agent lifecycle timeline rows", () => {
  it("keeps the headline generic and moves the name into the recap line", () => {
    const event = makeAgentEvent("agent_spawned", {
      childTaskId: "child-task",
      childTaskTitle: "Map model routing",
      childAgentLabel: "Map model routing (explorer)",
      instructionsPreview: "Objective: map the exact insertion points for routing",
      workerRole: "researcher",
    });

    const title = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventTitle(event)),
    );

    expect(title).toContain("Created an agent");
    expect(getAgentLifecycleRecapLine(event)).toBe(
      "Created Map model routing (explorer) with the instructions: Objective: map the exact insertion points for routing",
    );
  });

  it("uses the pending wording before dispatch is confirmed", () => {
    const event = makeAgentEvent("agent_spawn_requested", {
      childTaskTitle: "Anansi (explorer)",
      instructionsPreview: "Objective: sweep the security boundaries",
    });

    const title = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventTitle(event)),
    );

    expect(title).toContain("Creating an agent");
    expect(getAgentLifecycleRecapLine(event)).toBe(
      "Creating Anansi (explorer) with the instructions: Objective: sweep the security boundaries",
    );
  });

  it("derives the call-sign when the payload predates the stamped label", () => {
    const event = makeAgentEvent("agent_spawned", {
      childTaskTitle: "Verify the migration",
      workerRole: "verifier",
    });

    expect(getAgentLifecycleRecapLine(event)).toBe("Created Verify the migration (inspector)");
  });

  it("shows the full brief once the row is expanded", () => {
    const event = makeAgentEvent("agent_spawned", {
      childTaskTitle: "Map model routing",
      childAgentLabel: "Map model routing (explorer)",
      instructionsPreview: "Objective: map the exact insertion points for routing",
    });

    const details = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventDetails(event, false, {})),
    );

    expect(details).toContain("Map model routing (explorer)");
    expect(details).toContain("Objective: map the exact insertion points for routing");
  });

  it("labels a dispatch failure as a failed creation", () => {
    const event = makeAgentEvent("agent_failed", {
      childTaskTitle: "Map model routing",
      childAgentLabel: "Map model routing (explorer)",
      error: "DISPATCH_FAILED",
      phase: "dispatch",
    });

    const title = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventTitle(event)),
    );

    expect(title).toContain("Failed to create an agent");
    expect(getAgentLifecycleRecapLine(event)).toBe(
      "Could not create Map model routing (explorer): DISPATCH_FAILED",
    );
  });

  it("separates a mid-run failure from a failed creation", () => {
    const event = makeAgentEvent("agent_failed", {
      childTaskId: "child-task",
      childAgentLabel: "Anansi (explorer)",
      error: "Timed out after 300s",
    });

    const title = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventTitle(event)),
    );

    expect(title).toContain("An agent failed");
    expect(getAgentLifecycleRecapLine(event)).toBe(
      "Anansi (explorer) failed: Timed out after 300s",
    );
  });

  it("reports a finished agent with its result summary", () => {
    const event = makeAgentEvent("agent_completed", {
      childTaskId: "child-task",
      childAgentLabel: "Anansi (explorer)",
      resultSummary: "Mapped 4 insertion points across the executor loop.",
    });

    const title = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventTitle(event)),
    );
    const details = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventDetails(event, false, {})),
    );

    expect(title).toContain("Closed an agent");
    expect(getAgentLifecycleRecapLine(event)).toBe(
      "Anansi (explorer) finished: Mapped 4 insertion points across the executor loop.",
    );
    expect(details).toContain("Mapped 4 insertion points across the executor loop.");
  });

  it("keeps the messaged headline generic and names the recipient in the recap", () => {
    const event = makeAgentEvent("agent_message", {
      recipientLabel: "Backend",
      message: "Please run the migration checks.",
    });

    const title = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventTitle(event)),
    );

    expect(title).toContain("Messaged an agent");
    expect(getAgentLifecycleRecapLine(event)).toBe(
      "Messaged Backend: Please run the migration checks.",
    );
  });

  it("surfaces the delivery error when a message fails", () => {
    const event = makeAgentEvent("agent_message", {
      recipientLabel: "Backend",
      status: "failed",
      error: "Agent is no longer running",
    });

    const title = renderToStaticMarkup(
      React.createElement(React.Fragment, null, renderEventTitle(event)),
    );

    // renderToStaticMarkup escapes the apostrophe.
    expect(title).toContain("Couldn&#x27;t message an agent");
    expect(getAgentLifecycleRecapLine(event)).toBe(
      "Couldn't message Backend: Agent is no longer running",
    );
  });

  it("drops the recap when it would only repeat the headline", () => {
    expect(getAgentLifecycleRecapLine(makeAgentEvent("agent_completed", {}))).toBeNull();
    expect(getAgentLifecycleRecapLine(makeAgentEvent("agent_failed", {}))).toBeNull();
  });

  it("returns no recap line for unrelated events", () => {
    expect(
      getAgentLifecycleRecapLine(makeAgentEvent("tool_call", { tool: "read_file" })),
    ).toBeNull();
  });
});
