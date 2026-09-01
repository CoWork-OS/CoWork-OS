import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { TaskStatusStripViewModel } from "../../../shared/types";
import { TaskStatusStrip } from "../TaskStatusStrip";

function model(overrides: Partial<TaskStatusStripViewModel> = {}): TaskStatusStripViewModel {
  return {
    visible: true,
    state: "working",
    tone: "active",
    primaryLabel: "Step 2 / 5",
    phaseLabel: "Reviewing findings",
    compactMetricSlots: [
      {
        id: "sources_collected",
        label: "18 sources",
        metricIds: ["sources"],
        responsivePriority: 100,
        status: "active",
      },
    ],
    planSteps: [],
    activeStepOrdinal: 2,
    totalPlanSteps: 5,
    outputs: null,
    updatedAt: 1,
    ...overrides,
  };
}

describe("TaskStatusStrip", () => {
  it("renders an accessible compact control without a prose-derived metric", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskStatusStrip, {
        model: model(),
        activityGroups: [],
        outcomeMetrics: [],
      }),
    );

    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain('aria-controls="task-status-drawer"');
    expect(markup).toContain("Step 2 / 5");
    expect(markup).toContain("18 sources");
    expect(markup).toContain("Reviewing findings");
    expect(markup).not.toContain("500 files");
  });

  it("omits itself when the projection is not meaningful", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskStatusStrip, {
        model: model({ visible: false, state: "idle", primaryLabel: "Working" }),
        activityGroups: [],
        outcomeMetrics: [],
      }),
    );
    expect(markup).toBe("");
  });
});
