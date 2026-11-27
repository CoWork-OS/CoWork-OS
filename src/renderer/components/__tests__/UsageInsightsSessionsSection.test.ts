import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type { UsageSessionBreakdown } from "../../../shared/usageSessionBreakdown";
import { UsageInsightsSessionsSection } from "../UsageInsightsSessionsSection";

function render(sessionUsage: UsageSessionBreakdown | undefined, onOpenTask?: () => void) {
  return renderToStaticMarkup(
    React.createElement(UsageInsightsSessionsSection, { sessionUsage, onOpenTask }),
  );
}

const priced: UsageSessionBreakdown = {
  byCategory: [
    { category: "yours", cost: 3, tokens: 9000, calls: 10, sessions: 2 },
    { category: "subagents", cost: 0.995, tokens: 2000, calls: 4, sessions: 1 },
    { category: "background", cost: 0.005, tokens: 400, calls: 30, sessions: 0 },
  ],
  topSessions: [
    {
      taskId: "t1",
      title: "Ship the report",
      status: "completed",
      category: "yours",
      cost: 3.5,
      tokens: 10_500,
      calls: 12,
      subagentCount: 1,
    },
  ],
};

describe("UsageInsightsSessionsSection", () => {
  it("renders nothing without usage", () => {
    expect(render(undefined)).toBe("");
    expect(render({ byCategory: [], topSessions: [] })).toBe("");
  });

  it("shows each kind of work with its cost and share, and the top sessions", () => {
    const markup = render(priced, () => {});
    expect(markup).toContain("Where usage went");
    expect(markup).toContain("by cost");
    expect(markup).toContain("Your sessions");
    expect(markup).toContain("$3.00");
    expect(markup).toContain("75%");
    expect(markup).toContain("Background work");
    expect(markup).toContain("&lt;1%");
    expect(markup).toContain("Top sessions");
    expect(markup).toContain("Ship the report");
    expect(markup).toContain("Your sessions · 10.5K tokens · 1 sub-agent");
    expect(markup).toContain("<button");
  });

  it("uses tokens when nothing had a price, and plain rows without an opener", () => {
    const markup = render({
      byCategory: priced.byCategory.map((row) => ({ ...row, cost: 0 })),
      topSessions: priced.topSessions.map((row) => ({ ...row, cost: 0, subagentCount: 0 })),
    });
    expect(markup).toContain("by tokens");
    expect(markup).toContain("9.0K tokens");
    expect(markup).toContain("10.5K tokens");
    expect(markup).not.toContain("<button");
    expect(markup).not.toContain("sub-agent ");
  });
});
