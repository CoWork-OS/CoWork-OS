import { describe, expect, it } from "vitest";
import {
  DEFAULT_BROWSER_SETTINGS,
  normalizeBrowserSettings,
  resolveBrowserColorScheme,
} from "../browser-settings";

describe("browser settings", () => {
  it.each(["light", "dark"] as const)("accepts the explicit %s appearance", (colorScheme) => {
    expect(normalizeBrowserSettings({ colorScheme }).colorScheme).toBe(colorScheme);
  });

  it.each([undefined, null, "system", "auto", "DARK", true, 1])(
    "leaves the browser appearance unset for an unset or invalid choice (%s)",
    (colorScheme) => {
      expect(DEFAULT_BROWSER_SETTINGS.colorScheme).toBeNull();
      expect(normalizeBrowserSettings({ colorScheme }).colorScheme).toBeNull();
    },
  );

  it.each(["light", "dark"] as const)(
    "follows the app's %s theme without a browser choice",
    (theme) => {
      expect(resolveBrowserColorScheme(null, theme)).toBe(theme);
    },
  );

  it("leaves pages on the OS appearance when the app follows the system", () => {
    expect(resolveBrowserColorScheme(null, "system")).toBeNull();
  });

  it.each([
    ["light", "dark"],
    ["dark", "light"],
    ["light", "system"],
    ["dark", "system"],
  ] as const)("keeps the explicit %s browser choice over the app's %s theme", (choice, theme) => {
    expect(resolveBrowserColorScheme(choice, theme)).toBe(choice);
  });

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
