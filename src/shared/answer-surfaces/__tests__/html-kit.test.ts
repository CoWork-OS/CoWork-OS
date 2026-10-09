import { describe, expect, it } from "vitest";
import { HTML_KIT_CSS, HTML_KIT_THEMES } from "../html-kit";
import { HTML_KIT_ICONS } from "../html-kit-icons";
import { HTML_KIT_SCRIPT } from "../html-kit-script";
import {
  RICH_FRAME_DESIGN_LANGUAGE_PROMPT,
  buildRichFrameDesignCss,
} from "../../rich-frame-design-language";

describe("HTML surface design kit", () => {
  it("defines every theme palette and the component classes the prompt names", () => {
    for (const theme of HTML_KIT_THEMES.filter((name) => name !== "accent")) {
      expect(HTML_KIT_CSS).toContain(`[data-theme="${theme}"]`);
      expect(RICH_FRAME_DESIGN_LANGUAGE_PROMPT).toContain(theme);
    }
    const named = RICH_FRAME_DESIGN_LANGUAGE_PROMPT.match(/\bcw-[a-z0-9-]+/g) ?? [];
    for (const name of new Set(named)) {
      if (
        /^cw-tone-|^cw-card-|^cw-hero-|^cw-metrics-|^cw-grid-|^cw-span-|^cw-btn-/.test(name) &&
        HTML_KIT_CSS.includes(`.${name}`)
      )
        continue;
      expect(HTML_KIT_CSS, name).toContain(`.${name}`);
    }
  });

  it("ships with both light and dark design CSS", () => {
    expect(buildRichFrameDesignCss("light")).toContain(".cw-hero");
    expect(buildRichFrameDesignCss("dark")).toContain("--rf-bg: #1c1d21");
  });

  it("compiles its script and only embeds drawing markup for icons", () => {
    expect(() => new Function(HTML_KIT_SCRIPT)).not.toThrow();
    expect(HTML_KIT_SCRIPT).not.toMatch(/<\/script/i);
    const tags = new Set(
      Object.values(HTML_KIT_ICONS).flatMap((nodes) => nodes.map(([tag]) => tag)),
    );
    for (const tag of tags)
      expect(["path", "circle", "rect", "line", "polyline", "polygon", "ellipse"]).toContain(tag);
    expect(Object.keys(HTML_KIT_ICONS)).toContain("piggy-bank");
  });
});
