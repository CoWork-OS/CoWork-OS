import { describe, expect, it } from "vitest";
import { DEFAULT_BROWSER_SETTINGS, normalizeBrowserSettings } from "../browser-settings";

describe("browser settings", () => {
  it("fills defaults and drops invalid values", () => {
    expect(normalizeBrowserSettings(undefined)).toEqual(DEFAULT_BROWSER_SETTINGS);
    expect(
      normalizeBrowserSettings({
        searchEngine: "duckduckgo",
        downloadLocation: "anywhere",
        agentUploads: "block",
        developerMode: "yes",
        extra: true,
      }),
    ).toEqual({
      ...DEFAULT_BROWSER_SETTINGS,
      searchEngine: "duckduckgo",
      agentUploads: "block",
    });
  });
});
