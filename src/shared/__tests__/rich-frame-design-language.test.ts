import { describe, expect, it } from "vitest";

import {
  RICH_FRAME_DESIGN_STYLE_ID,
  applyRichFrameDesignLanguage,
} from "../rich-frame-design-language";

describe("rich frame design language", () => {
  it("injects the shared design style into document heads", () => {
    const html =
      '<!doctype html><html><head><title>Card</title></head><body><main class="rf-card">Hi</main></body></html>';
    const result = applyRichFrameDesignLanguage(html);

    expect(result).toContain(`id="${RICH_FRAME_DESIGN_STYLE_ID}"`);
    expect(result.indexOf(`id="${RICH_FRAME_DESIGN_STYLE_ID}"`)).toBeGreaterThan(
      result.indexOf("<title>Card</title>"),
    );
    expect(result.indexOf(`id="${RICH_FRAME_DESIGN_STYLE_ID}"`)).toBeLessThan(
      result.indexOf("</head>"),
    );
  });

  it("can inject dark frame tokens", () => {
    const html = '<html><head></head><body><main class="rf-card">Hi</main></body></html>';
    const result = applyRichFrameDesignLanguage(html, { theme: "dark" });

    expect(result).toContain("color-scheme: dark");
    expect(result).toContain("--rf-bg: #17191d");
    expect(result).toContain("--rf-host-bg: transparent");
    expect(result).toContain("background: var(--rf-bg) !important");
  });

  it("injects a sanitized host background for frame edges", () => {
    const html = '<html><head></head><body><main class="rf-card">Hi</main></body></html>';
    const result = applyRichFrameDesignLanguage(html, {
      theme: "dark",
      hostBackground: "rgba(31, 32, 36, 0.97)",
    });

    expect(result).toContain("--rf-host-bg: rgba(31, 32, 36, 0.97)");
    expect(result).toContain("background: var(--rf-host-bg) !important");
  });

  it("rejects unsafe host background values", () => {
    const html = '<html><head></head><body><main class="rf-card">Hi</main></body></html>';
    const result = applyRichFrameDesignLanguage(html, {
      theme: "dark",
      hostBackground: "red;body{display:none}",
    });

    expect(result).not.toContain("red;body{display:none}");
    expect(result).toContain("--rf-host-bg: transparent");
  });

  it("does not inject twice", () => {
    const html = "<html><head></head><body></body></html>";
    const once = applyRichFrameDesignLanguage(html);
    const twice = applyRichFrameDesignLanguage(once);

    expect(twice.match(new RegExp(RICH_FRAME_DESIGN_STYLE_ID, "g"))).toHaveLength(1);
  });

  it("respects explicit opt out", () => {
    const html = '<html data-cowork-rich-frame-design="off"><body>Custom</body></html>';
    expect(applyRichFrameDesignLanguage(html)).toBe(html);
  });
});
