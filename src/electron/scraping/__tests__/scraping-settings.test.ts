import { describe, expect, it, vi } from "vitest";

vi.mock("../../utils/user-data-dir", () => ({ getUserDataDir: () => "/tmp/cowork-test" }));

import { SCRAPING_FETCHERS, normalizeScrapingFetcher } from "../scraping-settings";

describe("normalizeScrapingFetcher", () => {
  it("does not offer a stealth (anti-bot bypass) fetcher", () => {
    expect(SCRAPING_FETCHERS).toEqual(["default", "playwright"]);
  });

  it("maps legacy stealth settings to the regular Playwright browser", () => {
    expect(normalizeScrapingFetcher("stealth")).toBe("playwright");
  });

  it("keeps supported fetchers and falls back to default for anything else", () => {
    expect(normalizeScrapingFetcher("playwright")).toBe("playwright");
    expect(normalizeScrapingFetcher("default")).toBe("default");
    expect(normalizeScrapingFetcher("camoufox")).toBe("default");
    expect(normalizeScrapingFetcher(undefined)).toBe("default");
  });
});
