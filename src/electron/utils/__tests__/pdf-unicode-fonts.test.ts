import * as fs from "fs";
import * as path from "path";
import { describe, expect, it } from "vitest";
import { needsUnicodeFont, resolvePdfFonts } from "../pdf-unicode-fonts";

const bundledRegular = path.join(
  path.dirname(require.resolve("pdfjs-dist/package.json")),
  "standard_fonts",
  "LiberationSans-Regular.ttf",
);

describe("resolvePdfFonts", () => {
  it("keeps the built-in fonts when every character is Latin-1", () => {
    const text = "Café – “quotes” cost €5™";

    expect(needsUnicodeFont(text)).toBe(false);
    expect(resolvePdfFonts(text)).toEqual({ missingCharacters: [], warnings: [] });
  });

  it("embeds the Liberation Sans bundled with pdfjs-dist for Latin, Greek, and Cyrillic", () => {
    const result = resolvePdfFonts("İstanbul, Zażółć, Привет, Ελλάδα", { systemCandidates: [] });

    expect(result.font).toMatchObject({ name: "Liberation Sans", source: "bundled" });
    expect(fs.existsSync(result.font!.regular.path)).toBe(true);
    expect(fs.existsSync(result.font!.bold.path)).toBe(true);
    expect(result.missingCharacters).toEqual([]);
    expect(result.warnings).toEqual([]);
  });

  it("uses the first available system font when the bundled one is unavailable", () => {
    const result = resolvePdfFonts("İstanbul", {
      bundledFontDir: null,
      systemCandidates: [
        { name: "Not installed", regular: { path: "/nonexistent/font.ttf" } },
        { name: "Stand-in", regular: { path: bundledRegular } },
      ],
    });

    expect(result.font).toEqual({
      name: "Stand-in",
      source: "system",
      regular: { path: bundledRegular },
      bold: { path: bundledRegular },
    });
  });

  it("reports characters that no available font can draw", () => {
    const result = resolvePdfFonts("Rapor 季度报告", { systemCandidates: [] });

    expect(result.font?.name).toBe("Liberation Sans");
    expect(result.missingCharacters).toEqual(["季", "度", "报", "告"]);
    expect(result.warnings).toEqual([
      expect.stringMatching(/covers 4 character\(s\).*季 度 报 告/),
    ]);
  });

  it("warns instead of writing wrong glyphs silently when no Unicode font exists", () => {
    const result = resolvePdfFonts("İstanbul", { bundledFontDir: null, systemCandidates: [] });

    expect(result.font).toBeUndefined();
    expect(result.missingCharacters).toEqual(["İ"]);
    expect(result.warnings).toEqual([expect.stringMatching(/No Unicode font was available.*İ/)]);
  });
});
