import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { TaskEvent } from "../../../shared/types";
import { renderEventDetails } from "../MainContent/timeline-event-rendering";

describe("historical plan details", () => {
  const event: TaskEvent = {
    id: "historical-plan",
    taskId: "task-1",
    schemaVersion: 2,
    type: "plan_created",
    timestamp: 1,
    payload: {
      plan: {
        description: "Prepare the report",
        steps: [null, { description: "Write the report" }, { description: "Verify the report" }],
      },
    },
  };

  it.each([true, false])(
    "renders valid steps alongside null legacy entries (hide verification=%s)",
    (hideVerificationSteps) => {
      const html = renderToStaticMarkup(
        React.createElement(
          React.Fragment,
          null,
          renderEventDetails(event, false, {}, { hideVerificationSteps }),
        ),
      );
      expect(html).toContain("Write the report");
      if (hideVerificationSteps) expect(html).not.toContain("Verify the report");
      else expect(html).toContain("Verify the report");
    },
  );
});
