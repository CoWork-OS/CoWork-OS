import * as fs from "fs/promises";
import * as path from "path";
// pdf-lib and fontkit load on first use rather than at app start.
import type { PDFDocument, PDFFont } from "pdf-lib";

type FontStyle = "regular" | "italic" | "bold" | "bold-italic";

async function readBundledFont(fileName: string): Promise<Buffer> {
  const dirs: string[] = [];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, "fonts"));
  // Source, emitted Electron/daemon/CLI modules, and installed npm packages.
  let ancestor = __dirname;
  for (let depth = 0; depth < 6; depth += 1) {
    dirs.push(path.join(ancestor, "resources", "fonts"));
    ancestor = path.dirname(ancestor);
  }
  for (const dir of dirs) {
    try {
      return await fs.readFile(path.join(dir, fileName));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  throw new Error(`Bundled PDF font is missing: ${fileName}`);
}

export async function selectPdfEditFont(pdf: PDFDocument, text: string, style: FontStyle) {
  const { StandardFonts, degrees } = await import("pdf-lib");
  const glyphText = text.replace(/[\r\n\t]/g, "");
  const standard = {
    regular: StandardFonts.Helvetica,
    italic: StandardFonts.HelveticaOblique,
    bold: StandardFonts.HelveticaBold,
    "bold-italic": StandardFonts.HelveticaBoldOblique,
  }[style];
  const font = await pdf.embedFont(standard);
  try {
    font.encodeText(glyphText);
    return { font, xSkew: degrees(0), syntheticBold: false };
  } catch {
    // WinAnsi cannot represent Turkish, Cyrillic, or CJK. Embed an offline
    // Unicode subset instead of losing/replacing characters in the selection.
  }
  pdf.registerFontkit((await import("@pdf-lib/fontkit")).default);
  const suffix = {
    regular: "Regular",
    italic: "Italic",
    bold: "Bold",
    "bold-italic": "BoldItalic",
  }[style];
  for (const fileName of [`NotoSans-${suffix}.ttf`, "NotoSansCJKsc-Regular.otf"]) {
    const candidate: PDFFont = await pdf.embedFont(await readBundledFont(fileName), {
      subset: true,
    });
    const supported = new Set(candidate.getCharacterSet());
    if (Array.from(glyphText).every((character) => supported.has(character.codePointAt(0)!))) {
      const cjk = fileName.endsWith(".otf");
      return {
        font: candidate,
        xSkew: degrees(cjk && style.includes("italic") ? 12 : 0),
        syntheticBold: cjk && style.includes("bold"),
      };
    }
  }
  throw new Error("The selected text contains characters unsupported by the bundled PDF fonts.");
}
