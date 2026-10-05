import { describe, expect, it } from "vitest";
import { compressionCostNotice } from "../MemorySettings";

// The AI memory compression is on by default; the switch says it costs tokens (DATA-7).
describe("compressionCostNotice", () => {
  it("names the provider cost and the daily budget", () => {
    expect(compressionCostNotice(20000)).toBe(
      "AI memory compression uses your model provider and costs tokens (up to 20,000 tokens/day across all workspaces). Private memories are never sent. Turn it off to keep only local summaries.",
    );
  });

  it("falls back to the default budget", () => {
    expect(compressionCostNotice(null)).toContain("up to 20,000 tokens/day");
    expect(compressionCostNotice(50000)).toContain("up to 50,000 tokens/day");
  });
});
