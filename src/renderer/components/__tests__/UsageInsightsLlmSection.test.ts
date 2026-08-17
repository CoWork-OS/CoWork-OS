import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { UsageInsightsLlmSection } from "../UsageInsightsLlmSection";

describe("UsageInsightsLlmSection with Recharts 3", () => {
  it("renders usage charts with representative data", () => {
    const markup = renderToStaticMarkup(
      React.createElement(UsageInsightsLlmSection, {
        llmSummary: {
          totalLlmCalls: 3,
          totalCost: 0.25,
          chargeableCallRate: 100,
          avgTokensPerCall: 200,
          totalInputTokens: 400,
          totalOutputTokens: 200,
          totalCachedTokens: 50,
          cacheReadRate: 12.5,
          distinctTaskCount: 2,
        },
        llmSuccessRate: 100,
        requestsByDay: [
          {
            dateKey: "2026-08-17",
            llmCalls: 3,
            cost: 0.25,
            inputTokens: 400,
            outputTokens: 200,
            cachedTokens: 50,
          },
        ],
        providerBreakdown: [
          {
            provider: "openai",
            calls: 3,
            distinctTasks: 2,
            cost: 0.25,
            inputTokens: 400,
            outputTokens: 200,
            cachedTokens: 50,
            percent: 100,
          },
        ],
        costByModel: [
          {
            model: "gpt-5",
            cost: 0.25,
            calls: 3,
            inputTokens: 400,
            outputTokens: 200,
            cachedTokens: 50,
            distinctTasks: 2,
          },
        ],
      }),
    );

    expect(markup).toContain("LLM usage");
    expect(markup).toContain("LLM calls by day");
    expect(markup).toContain("Cost trend");
    expect(markup).toContain("Provider share");
  });
});
