import React from "react";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MCOverviewTab } from "../MCOverviewTab";
import type { MissionControlData } from "../useMissionControlData";

const stylesPath = fileURLToPath(new URL("../mission-control.css", import.meta.url));

function renderOverview(overrides: Partial<MissionControlData> = {}): string {
  const data = {
    missionControlBrief: null,
    missionControlItems: [],
    activeAgentsCount: 2,
    totalTasksInQueue: 0,
    pendingMentionsCount: 0,
    queueStatusState: "ready",
    runtimeRunningCount: 0,
    runtimeQueuedCount: 4,
    runtimeQueueTotal: 4,
    runtimeMaxConcurrent: 8,
    runtimeRunningTaskIds: [],
    runtimeQueuedTaskIds: ["task-1", "task-2", "task-3", "task-4"],
    runtimeRunningTasks: [],
    runtimeQueuedTasks: [
      {
        id: "task-1",
        title: "Queued runtime task",
        status: "queued",
        createdAt: Date.UTC(2026, 4, 26, 10, 0, 0),
        updatedAt: Date.UTC(2026, 4, 26, 10, 5, 0),
        workspaceId: "ws-1",
      },
    ],
    commandCenterReviewQueue: [],
    formatRelativeTime: () => "just now",
    setActiveTab: vi.fn(),
    setDetailPanel: vi.fn(),
    loadMissionControlIntelligence: vi.fn(),
    selectedWorkspaceId: "ws-1",
    ...overrides,
  } as unknown as MissionControlData;

  return renderToStaticMarkup(React.createElement(MCOverviewTab, { data }));
}

describe("MCOverviewTab", () => {
  it("separates runtime queue counts from open board work", () => {
    const markup = renderOverview();

    expect(markup).toContain("global runtime queue");
    expect(markup).toContain("0/8 running · 4 waiting");
    expect(markup).toContain("open board work");
    expect(markup).toContain("No open board work.");
    expect(markup).toContain("Queued runtime task");
  });

  it("explains enabled idle heartbeat agents when no work is queued", () => {
    const markup = renderOverview({
      runtimeQueuedCount: 0,
      runtimeQueueTotal: 0,
      runtimeQueuedTaskIds: [],
      runtimeQueuedTasks: [],
    });

    expect(markup).toContain("2 Heartbeat agents are enabled and idle.");
    expect(markup).toContain("All clear");
  });

  it("does not render unavailable runtime queue state as all clear", () => {
    const markup = renderOverview({
      queueStatusState: "error",
      runtimeQueuedCount: 0,
      runtimeQueueTotal: 0,
      runtimeQueuedTaskIds: [],
      runtimeQueuedTasks: [],
    });

    expect(markup).toContain("Runtime queue status is unavailable");
    expect(markup).toContain("Unavailable");
    expect(markup).not.toContain("All clear");
    expect(markup).not.toContain("Heartbeat agents are enabled and idle.");
  });

  it("preserves a brief active work count of zero", () => {
    const markup = renderOverview({
      totalTasksInQueue: 3,
      missionControlBrief: {
        generatedAt: Date.UTC(2026, 4, 26, 10, 0, 0),
        attentionCount: 0,
        activeWorkCount: 0,
        reviewCount: 0,
        learningCount: 0,
        awarenessCount: 0,
        evidenceCount: 0,
        sections: [],
        latestDecisions: [],
        learningChanges: [],
        awarenessClusters: [],
        activeWork: [],
        upcomingReviews: [],
      },
    });

    expect(markup).toContain("<strong>0</strong><span>open board work</span>");
  });

  it("stacks metric values and labels despite the shared button flex rule", () => {
    const styles = readFileSync(stylesPath, "utf8");
    const metricRule = styles.match(/\.mc-v2-brief-metric\s*\{([^}]*)\}/s)?.[1] || "";

    expect(metricRule).toMatch(/display:\s*flex/);
    expect(metricRule).toMatch(/flex-direction:\s*column/);
    expect(metricRule).toMatch(/align-items:\s*flex-start/);
  });
});
