import { describe, expect, it } from "vitest";
import { collectCrossStepEvidence, formatCrossStepEvidence } from "../cross-step-evidence";

describe("volatile cross-step evidence", () => {
  it("keeps separate agent prices, citations and failures after unrelated artifact calls", () => {
    const context = new Map<string, string>();
    for (const [key, value] of collectCrossStepEvidence("orchestrate_agents", {
      results: [
        {
          task_id: "notion",
          title: "Notion research",
          status: "completed",
          result_summary:
            "Plus USD 10 annually billed. https://www.notion.com/pricing. Guest limit unverified.",
        },
        {
          task_id: "linear",
          title: "Linear research",
          status: "failed",
          result_summary: "Pricing unresolved: full page unavailable.",
          error: "permission denied",
        },
      ],
    }))
      context.set(key, value);
    for (let i = 0; i < 12; i++)
      expect(collectCrossStepEvidence("get_file_info", { size: 10 })).toEqual([]);
    const result = formatCrossStepEvidence(context);
    expect(result).toContain("USD 10 annually billed");
    expect(result).toContain("https://www.notion.com/pricing");
    expect(result).toContain("Guest limit unverified");
    expect(result).toContain("Linear research (failed)");
    expect(result).toContain("permission denied");
  });

  it("retains source excerpts with their qualification and bounds large fetched pages", () => {
    const search = collectCrossStepEvidence("web_search", {
      results: [{ url: "https://example.com/pricing", snippet: "$12 monthly" }],
    });
    expect(search[0][1]).toContain("Search excerpt, not a full-page fetch");
    expect(search[0][1]).toContain("$12 monthly");
    const fetch = collectCrossStepEvidence("web_fetch", {
      success: true,
      url: "https://example.com",
      content: "x".repeat(20000),
    });
    expect(fetch[0][1].length).toBeLessThan(12500);
    expect(fetch[0][1]).toContain("Evidence clipped");
    expect(
      collectCrossStepEvidence("web_fetch", {
        success: false,
        url: "https://example.com",
        content: "denied",
      }),
    ).toEqual([]);
    expect(
      formatCrossStepEvidence(
        new Map(Array.from({ length: 20 }, (_, i) => [String(i), "x".repeat(8000)])),
      ).length,
    ).toBeLessThan(48200);
  });
});
