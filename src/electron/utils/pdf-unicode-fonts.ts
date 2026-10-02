/**
 * Font selection for PDFs written with pdfkit.
 *
 * pdfkit's built-in fonts (Helvetica, Courier) encode text as WinAnsi, which
 * covers Latin-1 and a few symbols; any other character is written as the
 * wrong glyphs ("İstanbul" turns into "7F æ ul"). A document that needs more
 * embeds a TrueType font that covers its characters instead, chosen in a
 * fixed order:
 *
 * 1. Liberation Sans from the pdfjs-dist dependency (standard_fonts/, SIL Open
 *    Font License). It ships with the app and covers Latin, Greek, and
 *    Cyrillic, so most documents never depend on what is installed.
 * 2. Installed system fonts with wider coverage (CJK, Arabic, Hebrew, Indic,
 *    Thai), first match wins.
 *
 * Characters that no available font covers are reported, never silently
 * drawn as the wrong glyphs.
 */

import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";

export interface PdfFontFile {
  path: string;
  /** Face to use inside a .ttc collection. */
  postscriptName?: string;
}

export interface PdfFontCandidate {
  name: string;
  regular: PdfFontFile;
  bold?: PdfFontFile;
}

export interface PdfFontSelection {
  name: string;
  source: "bundled" | "system";
  regular: PdfFontFile;
  bold: PdfFontFile;
}

export interface PdfFontResolution {
  /** Font to embed; undefined when the built-in fonts draw every character. */
  font?: PdfFontSelection;
  /** Characters that no available font can draw. */
  missingCharacters: string[];
  warnings: string[];
}

export interface PdfFontResolveOptions {
  /** Directory holding LiberationSans-*.ttf; null disables the bundled font. */
  bundledFontDir?: string | null;
  systemCandidates?: PdfFontCandidate[];
}

interface FontkitFont {
  postscriptName?: string;
  hasGlyphForCodePoint(codePoint: number): boolean;
}

interface FontkitModule {
  openSync(filePath: string, postscriptName?: string): unknown;
}

/** Characters WinAnsi encodes beyond Latin-1 (the 0x80-0x9F block of cp1252). */
const WIN_ANSI_EXTRAS = new Set([
  0x20ac, 0x201a, 0x0192, 0x201e, 0x2026, 0x2020, 0x2021, 0x02c6, 0x2030, 0x0160, 0x2039, 0x0152,
  0x017d, 0x2018, 0x2019, 0x201c, 0x201d, 0x2022, 0x2013, 0x2014, 0x02dc, 0x2122, 0x0161, 0x203a,
  0x0153, 0x017e, 0x0178,
]);

function isWinAnsi(codePoint: number): boolean {
  return (
    (codePoint >= 0x20 && codePoint <= 0x7e) ||
    (codePoint >= 0xa0 && codePoint <= 0xff) ||
    WIN_ANSI_EXTRAS.has(codePoint)
  );
}

/** Distinct code points that get a glyph: no whitespace, controls, or format characters. */
function drawnCodePoints(text: string): number[] {
  const codePoints = new Set<number>();
  for (const char of text) {
    if (/[\s\p{Cc}\p{Cf}\uFE00-\uFE0F]/u.test(char)) continue;
    codePoints.add(char.codePointAt(0)!);
  }
  return [...codePoints];
}

/** True when pdfkit's built-in fonts cannot encode some character of `text`. */
export function needsUnicodeFont(text: string): boolean {
  return drawnCodePoints(text).some((codePoint) => !isWinAnsi(codePoint));
}

let cachedFontkit: FontkitModule | null | undefined;

function loadFontkit(): FontkitModule | null {
  if (cachedFontkit !== undefined) return cachedFontkit;
  try {
    // fontkit is pdfkit's font engine. Resolving it next to pdfkit uses the
    // copy pdfkit embeds fonts with, without a separate dependency.
    cachedFontkit = createRequire(require.resolve("pdfkit"))("fontkit") as FontkitModule;
  } catch {
    cachedFontkit = null;
  }
  return cachedFontkit;
}

function isFontkitFont(value: unknown): value is FontkitFont {
  return Boolean(value) && typeof (value as FontkitFont).hasGlyphForCodePoint === "function";
}

/** Opens a font file, settling on a face (and its name) for collections. */
function openFont(file: PdfFontFile): { font: FontkitFont; file: PdfFontFile } | null {
  const fontkit = loadFontkit();
  if (!fontkit || !fs.existsSync(file.path)) return null;
  try {
    const requested = fontkit.openSync(file.path, file.postscriptName);
    if (isFontkitFont(requested)) return { font: requested, file };
    // A collection whose named face is missing: use its first face.
    const collection = file.postscriptName ? fontkit.openSync(file.path) : requested;
    const first = (collection as { fonts?: unknown[] } | null)?.fonts?.[0];
    if (isFontkitFont(first) && first.postscriptName) {
      return { font: first, file: { path: file.path, postscriptName: first.postscriptName } };
    }
  } catch {
    // Unreadable or unsupported font file; try the next candidate.
  }
  return null;
}

function defaultBundledFontDir(): string | null {
  try {
    return path.join(path.dirname(require.resolve("pdfjs-dist/package.json")), "standard_fonts");
  } catch {
    return null;
  }
}

function bundledCandidate(dir: string | null): PdfFontCandidate[] {
  if (!dir) return [];
  return [
    {
      name: "Liberation Sans",
      regular: { path: path.join(dir, "LiberationSans-Regular.ttf") },
      bold: { path: path.join(dir, "LiberationSans-Bold.ttf") },
    },
  ];
}

/** Installed fonts with wide script coverage, in the order they are tried. */
export function systemFontCandidates(
  platform: NodeJS.Platform = process.platform,
): PdfFontCandidate[] {
  if (platform === "darwin") {
    return [
      {
        name: "Arial Unicode MS",
        regular: { path: "/System/Library/Fonts/Supplemental/Arial Unicode.ttf" },
      },
      { name: "Arial Unicode MS", regular: { path: "/Library/Fonts/Arial Unicode.ttf" } },
    ];
  }
  if (platform === "win32") {
    const fonts = path.win32.join(process.env.WINDIR || "C:\\Windows", "Fonts");
    const file = (name: string, postscriptName?: string): PdfFontFile => ({
      path: path.win32.join(fonts, name),
      postscriptName,
    });
    return [
      { name: "Arial Unicode MS", regular: file("arialuni.ttf") },
      { name: "Segoe UI", regular: file("segoeui.ttf"), bold: file("segoeuib.ttf") },
      {
        name: "Microsoft YaHei",
        regular: file("msyh.ttc", "MicrosoftYaHei"),
        bold: file("msyhbd.ttc", "MicrosoftYaHei-Bold"),
      },
      { name: "Yu Gothic", regular: file("YuGothR.ttc", "YuGothic-Regular") },
      { name: "Malgun Gothic", regular: file("malgun.ttf"), bold: file("malgunbd.ttf") },
      { name: "Nirmala UI", regular: file("Nirmala.ttf"), bold: file("NirmalaB.ttf") },
      { name: "Leelawadee UI", regular: file("LeelawUI.ttf"), bold: file("LeelaUIb.ttf") },
    ];
  }
  const linux = (name: string, regular: string, bold?: string, postscriptName?: string) => ({
    name,
    regular: { path: regular, postscriptName },
    ...(bold ? { bold: { path: bold } } : {}),
  });
  return [
    linux(
      "DejaVu Sans",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
      "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    ),
    linux(
      "DejaVu Sans",
      "/usr/share/fonts/dejavu/DejaVuSans.ttf",
      "/usr/share/fonts/dejavu/DejaVuSans-Bold.ttf",
    ),
    linux(
      "DejaVu Sans",
      "/usr/share/fonts/TTF/DejaVuSans.ttf",
      "/usr/share/fonts/TTF/DejaVuSans-Bold.ttf",
    ),
    linux(
      "Noto Sans",
      "/usr/share/fonts/truetype/noto/NotoSans-Regular.ttf",
      "/usr/share/fonts/truetype/noto/NotoSans-Bold.ttf",
    ),
    ...[
      "/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/noto-cjk/NotoSansCJK-Regular.ttc",
      "/usr/share/fonts/google-noto-cjk/NotoSansCJK-Regular.ttc",
    ].map((file) => linux("Noto Sans CJK", file, undefined, "NotoSansCJKsc-Regular")),
    linux("Droid Sans Fallback", "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf"),
    linux(
      "WenQuanYi Micro Hei",
      "/usr/share/fonts/truetype/wqy/wqy-microhei.ttc",
      undefined,
      "WenQuanYiMicroHei",
    ),
  ];
}

function describeCharacters(characters: string[]): string {
  const shown = characters.slice(0, 12).join(" ");
  return characters.length > 12 ? `${shown} …` : shown;
}

/**
 * Picks the font for a PDF that will contain `text`: none when the built-in
 * fonts can encode everything, otherwise the first candidate that covers
 * every character (or, failing that, the one that covers the most).
 */
export function resolvePdfFonts(
  text: string,
  options: PdfFontResolveOptions = {},
): PdfFontResolution {
  const codePoints = drawnCodePoints(text);
  const outsideWinAnsi = codePoints.filter((codePoint) => !isWinAnsi(codePoint));
  if (outsideWinAnsi.length === 0) return { missingCharacters: [], warnings: [] };

  const bundledDir =
    options.bundledFontDir === undefined ? defaultBundledFontDir() : options.bundledFontDir;
  const candidates = [
    ...bundledCandidate(bundledDir).map((candidate) => ({ candidate, source: "bundled" as const })),
    ...(options.systemCandidates ?? systemFontCandidates()).map((candidate) => ({
      candidate,
      source: "system" as const,
    })),
  ];

  let best: { selection: PdfFontSelection; missing: number[] } | undefined;
  for (const { candidate, source } of candidates) {
    const regular = openFont(candidate.regular);
    if (!regular) continue;
    const missing = codePoints.filter((codePoint) => !regular.font.hasGlyphForCodePoint(codePoint));
    if (!best || missing.length < best.missing.length) {
      const bold = candidate.bold ? openFont(candidate.bold) : null;
      best = {
        selection: {
          name: candidate.name,
          source,
          regular: regular.file,
          bold: bold?.file ?? regular.file,
        },
        missing,
      };
    }
    if (missing.length === 0) break;
  }

  if (!best) {
    const missingCharacters = outsideWinAnsi.map((codePoint) => String.fromCodePoint(codePoint));
    return {
      missingCharacters,
      warnings: [
        "No Unicode font was available to embed, so these characters cannot be shown correctly " +
          `in the PDF: ${describeCharacters(missingCharacters)}`,
      ],
    };
  }

  const missingCharacters = best.missing.map((codePoint) => String.fromCodePoint(codePoint));
  return {
    font: best.selection,
    missingCharacters,
    warnings:
      missingCharacters.length > 0
        ? [
            `No available font covers ${missingCharacters.length} character(s) in this PDF, so they ` +
              `are drawn as empty boxes: ${describeCharacters(missingCharacters)}. Installing a font ` +
              "such as Noto Sans for these scripts lets them render.",
          ]
        : [],
  };
}
