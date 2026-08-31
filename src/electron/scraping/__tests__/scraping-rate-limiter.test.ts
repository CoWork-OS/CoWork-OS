import { describe, expect, it, vi } from "vitest";
import {
  getScrapingRequestDelayMs,
  resetScrapingRateLimiterForTests,
  waitForScrapingSlot,
} from "../scraping-rate-limiter";

describe("scraping rate limiter", () => {
  it("calculates a bounded interval from requests per minute", () => {
    expect(getScrapingRequestDelayMs(30)).toBe(2000);
    expect(getScrapingRequestDelayMs(0)).toBe(60000);
    expect(getScrapingRequestDelayMs(999)).toBe(500);
    expect(getScrapingRequestDelayMs("invalid")).toBe(0);
  });

  it("queues requests per host while allowing different hosts independently", async () => {
    resetScrapingRateLimiterForTests();
    const sleep = vi.fn().mockResolvedValue(undefined);
    const settings = { enabled: true, requestsPerMinute: 30 };

    await Promise.all([
      waitForScrapingSlot("https://example.com/one", settings, sleep),
      waitForScrapingSlot("https://example.com/two", settings, sleep),
      waitForScrapingSlot("https://other.example/two", settings, sleep),
    ]);

    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(2000);
    resetScrapingRateLimiterForTests();
  });

  it("does not delay when rate limiting is disabled", async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    await waitForScrapingSlot(
      "https://example.com/one",
      { enabled: false, requestsPerMinute: 1 },
      sleep,
    );
    expect(sleep).not.toHaveBeenCalled();
  });
});
