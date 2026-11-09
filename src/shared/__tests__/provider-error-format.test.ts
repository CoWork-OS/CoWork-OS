import { describe, it, expect } from "vitest";
import { formatProviderErrorForDisplay } from "../provider-error-format";
import type { Task } from "../types";

describe("formatProviderErrorForDisplay", () => {
  it("returns friendly message for free-models-per-min rate limit (manual task)", () => {
    const msg =
      "OpenRouter API error: 429 Too Many Requests - Rate limit exceeded: free-models-per-min.";
    expect(formatProviderErrorForDisplay(msg)).toContain("Rate limit exceeded");
    expect(formatProviderErrorForDisplay(msg)).toContain("OpenRouter API key");
    expect(formatProviderErrorForDisplay(msg)).toContain("Settings");
  });

  it("returns short message for rate limit when task is automated", () => {
    const msg = "429 Too Many Requests - Rate limit exceeded: free-models-per-min.";
    const cronTask = { source: "cron" } as Task;
    const improvementTask = { source: "improvement" } as Task;
    expect(formatProviderErrorForDisplay(msg, { task: cronTask })).toBe(
      "Rate limit exceeded. Will retry automatically.",
    );
    expect(formatProviderErrorForDisplay(msg, { task: improvementTask })).toBe(
      "Rate limit exceeded. Will retry automatically.",
    );
  });

  it("returns friendly message for generic 429 (manual)", () => {
    const msg = "429 Too Many Requests";
    expect(formatProviderErrorForDisplay(msg)).toContain("Rate limit exceeded");
    expect(formatProviderErrorForDisplay(msg)).toContain("try again");
  });

  it("does not tell someone with their own key to add one", () => {
    const msg = "OpenAI-Compatible API error: 429 Too Many Requests - Rate limit reached.";
    expect(formatProviderErrorForDisplay(msg)).toBe(
      "Rate limit exceeded. Wait a minute and try again, or switch to another model.",
    );
  });

  it("says an exhausted quota is a billing problem, not a wait", () => {
    const msg =
      "OpenAI-Compatible API error: 429 Too Many Requests - You exceeded your current quota, please check your plan and billing details.";
    const expected =
      "The model provider says this account is out of quota or credits. Check your plan and billing with the provider, or switch to another model.";
    expect(formatProviderErrorForDisplay(msg)).toBe(expected);
    expect(formatProviderErrorForDisplay(msg, { task: { source: "cron" } as Task })).toBe(expected);
  });

  it("passes through non-rate-limit errors", () => {
    const msg = "Invalid API key provided";
    expect(formatProviderErrorForDisplay(msg)).toBe(msg);
  });

  it("returns Provider error for empty input", () => {
    expect(formatProviderErrorForDisplay("")).toBe("Provider error");
    expect(formatProviderErrorForDisplay("   ")).toBe("Provider error");
  });
});
