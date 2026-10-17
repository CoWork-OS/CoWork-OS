import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import type { TaskStatusStripViewModel } from "../../../shared/types";
import type { LivePlanModel } from "../../utils/live-plan";
import { LivePlan } from "../LivePlan";
import { TaskStatusStrip } from "../TaskStatusStrip";

const css = readFileSync(
  fileURLToPath(new URL("../MainContent/main-content.css", import.meta.url)),
  "utf8",
);

const plan: LivePlanModel = {
  source: "plan",
  items: [
    { id: "a", label: "Extract frames", status: "done", planStepId: "a" },
    { id: "b", label: "Map **behavior**", status: "active", planStepId: "b" },
    { id: "c", label: "Run tests", status: "pending", planStepId: "c" },
  ],
  doneCount: 1,
  activeId: "b",
};

function stripModel(): TaskStatusStripViewModel {
  return {
    visible: true,
    state: "working",
    tone: "active",
    primaryLabel: "Step 2 / 3",
    compactMetricSlots: [],
    planSteps: [
      { id: "a", description: "Extract frames", status: "completed" },
      { id: "b", description: "Map behavior", status: "in_progress" },
      { id: "c", description: "Run tests", status: "pending" },
    ],
    activeStepOrdinal: 2,
    totalPlanSteps: 3,
    outputs: null,
    updatedAt: 1,
  };
}

describe("LivePlan", () => {
  it("lists each step with its state and marks the current one", () => {
    const markup = renderToStaticMarkup(createElement(LivePlan, { plan, scopeKey: "task-1" }));

    expect(markup).toContain('aria-label="Plan, 1 of 3 done"');
    expect(markup).toMatch(/class="live-plan-item is-done"[\s\S]*Extract frames[\s\S]*Done/);
    expect(markup).toMatch(
      /class="live-plan-item is-active" aria-current="step"[\s\S]*<strong>behavior<\/strong>[\s\S]*In progress/,
    );
    expect(markup).toMatch(/class="live-plan-item is-pending"[\s\S]*Run tests[\s\S]*Not started/);
    // Nothing has changed status yet, so no row plays its change animation.
    expect(markup).not.toContain("just-changed");
  });

  it("renders nothing without a plan", () => {
    expect(renderToStaticMarkup(createElement(LivePlan, { plan: null, scopeKey: "task-1" }))).toBe(
      "",
    );
  });

  it("folds long plans around the current step", () => {
    const long: LivePlanModel = {
      source: "checklist",
      items: Array.from({ length: 10 }, (_, index) => ({
        id: `i${index}`,
        label: `Item ${index}`,
        status: index < 5 ? "done" : index === 5 ? "active" : "pending",
      })),
      doneCount: 5,
      activeId: "i5",
    };
    const markup = renderToStaticMarkup(createElement(LivePlan, { plan: long, scopeKey: "t" }));
    expect(markup).toContain("4 done");
    expect(markup).toContain("2 more");
    expect(markup).not.toContain("Item 0");
    expect(markup).toContain('aria-label="Show all 10 steps"');
  });

  it("makes a row a button only when it has activity to jump to", () => {
    const markup = renderToStaticMarkup(
      createElement(LivePlan, {
        plan,
        scopeKey: "task-1",
        getItemTarget: (item) => (item.id === "a" ? "group-a" : undefined),
        onSelectTarget: () => undefined,
      }),
    );
    expect(markup.match(/<button type="button" class="live-plan-item-body"/g)).toHaveLength(1);
    expect(markup).toMatch(/<button type="button" class="live-plan-item-body"[^>]*>[\s\S]*Extract/);
  });

  it("offers a toggle that folds the list to the current step", () => {
    const markup = renderToStaticMarkup(createElement(LivePlan, { plan, scopeKey: "task-1" }));
    expect(markup).toMatch(
      /class="live-plan-toggle" aria-expanded="true" aria-controls="live-plan-list-[\w-]+" aria-label="Show only the current step"/,
    );
  });

  it("shows only the current step while collapsed", () => {
    const stored = new Map([["cowork:live-plan:collapsed", "1"]]);
    vi.stubGlobal("window", {
      localStorage: { getItem: (key: string) => stored.get(key) ?? null },
    });
    try {
      const markup = renderToStaticMarkup(createElement(LivePlan, { plan, scopeKey: "task-1" }));
      expect(markup).toContain('class="live-plan is-collapsed"');
      expect(markup).toMatch(/aria-expanded="false"[^>]*aria-label="Show all 3 steps"/);
      expect(markup).toContain("<strong>behavior</strong>");
      expect(markup).not.toContain("Extract frames");
      expect(markup).not.toContain("Run tests");
      expect(markup).not.toContain("live-plan-fold");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("has no toggle for a single-step plan", () => {
    const single: LivePlanModel = { ...plan, items: [plan.items[1]], doneCount: 0 };
    const markup = renderToStaticMarkup(createElement(LivePlan, { plan: single, scopeKey: "t" }));
    expect(markup).not.toContain("live-plan-toggle");
  });
});

describe("TaskStatusStrip live plan", () => {
  it("renders the live plan above the strip inside the same shell", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskStatusStrip, {
        model: stripModel(),
        activityGroups: [],
        outcomeMetrics: [],
        livePlan: plan,
        livePlanScopeKey: "task-1",
      }),
    );
    expect(markup).toMatch(
      /task-status-strip-shell[\s\S]*class="live-plan"[\s\S]*task-status-strip"/,
    );
  });

  it("omits the live plan when there is none", () => {
    const markup = renderToStaticMarkup(
      createElement(TaskStatusStrip, {
        model: stripModel(),
        activityGroups: [],
        outcomeMetrics: [],
      }),
    );
    expect(markup).not.toContain("live-plan");
  });
});

describe("LivePlan styles", () => {
  it("folds away after a hold that matches the component's timer", () => {
    expect(css).toMatch(
      /\.live-plan\.is-leaving\s*\{[\s\S]*grid-template-rows:\s*0fr[\s\S]*420ms cubic-bezier\(0\.16, 1, 0\.3, 1\) 420ms/,
    );
  });

  it("drops motion for reduced-motion users", () => {
    expect(css).toMatch(
      /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.live-plan-glyph-ring\.is-turning[\s\S]*animation:\s*none[\s\S]*\.live-plan\.is-leaving\s*\{\s*display:\s*none/,
    );
  });
});
