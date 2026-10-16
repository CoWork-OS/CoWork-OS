import { describe, expect, it } from "vitest";
import {
  buildUpdateWindowHtml,
  formatUpdateBytes,
  parseUpdateWindowMessage,
  UPDATE_WINDOW_MESSAGE_PREFIX,
} from "../update-window-html";
import { normalizeUpdatePreferences } from "../update-preferences";

describe("update window page", () => {
  it("parses only its own actions and heights", () => {
    expect(parseUpdateWindowMessage(`${UPDATE_WINDOW_MESSAGE_PREFIX}install`)).toEqual({
      kind: "action",
      action: "install",
    });
    expect(parseUpdateWindowMessage(`${UPDATE_WINDOW_MESSAGE_PREFIX}height:171.4`)).toEqual({
      kind: "height",
      height: 172,
    });
    expect(parseUpdateWindowMessage(`${UPDATE_WINDOW_MESSAGE_PREFIX}rm -rf`)).toBeNull();
    expect(parseUpdateWindowMessage(`${UPDATE_WINDOW_MESSAGE_PREFIX}height:-1`)).toBeNull();
    expect(parseUpdateWindowMessage("install")).toBeNull();
  });

  it("formats download sizes in decimal megabytes", () => {
    expect(formatUpdateBytes(96_200_000, 100_400_000, "en-US")).toBe("96.2 MB of 100.4 MB");
    expect(formatUpdateBytes(96_200_000, 100_400_000, "de-DE")).toBe("96,2 MB of 100,4 MB");
    expect(formatUpdateBytes(512_000, 1_500_000_000, "en-US")).toBe("512.0 KB of 1.5 GB");
  });

  it("escapes the app name and refuses non-image icon URLs", () => {
    const html = buildUpdateWindowHtml({
      appName: '<img src=x onerror="alert(1)">',
      iconDataUrl: "javascript:alert(1)",
      drawsTitleBar: true,
    });
    expect(html).not.toContain('<img src=x onerror="alert(1)">');
    expect(html).not.toContain("javascript:alert(1)");
    expect(html).toContain("icon-fallback");
    expect(html).toContain("Content-Security-Policy");
  });
});

describe("update preferences", () => {
  it("keeps only well-formed fields", () => {
    expect(normalizeUpdatePreferences(undefined)).toEqual({ autoDownload: false });
    expect(
      normalizeUpdatePreferences({ autoDownload: true, skippedVersion: "0.5.61", extra: 1 }),
    ).toEqual({ autoDownload: true, skippedVersion: "0.5.61" });
    expect(
      normalizeUpdatePreferences({ autoDownload: "yes", skippedVersion: "../../etc" }),
    ).toEqual({ autoDownload: false });
  });
});
