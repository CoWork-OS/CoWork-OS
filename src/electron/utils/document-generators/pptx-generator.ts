/**
 * PPTX Generator — creates PowerPoint presentations from structured slide data.
 *
 * Uses Codex's bundled @oai/artifact-tool presentation runtime when available.
 * Falls back to pptxgenjs only when the bundled runtime cannot be loaded.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import { resolveCodexArtifactToolRuntime } from "../codex-artifact-tool-runtime";

const execFileAsync = promisify(execFile);
const ARTIFACT_TOOL_GENERATION_TIMEOUT_MS = 90_000;

type PresentationVisualMode = "work" | "editorial" | "playful" | "premium" | "technical";
type SlideType =
  | "cover"
  | "content"
  | "image"
  | "quote"
  | "timeline"
  | "comparison"
  | "process"
  | "chart"
  | "table"
  | "section"
  | "product"
  | "metric"
  | "closing"
  | "blank";

interface PresentationAsset {
  id?: string;
  path?: string;
  url?: string;
  alt?: string;
}

interface SlideDataDefinition {
  categories?: string[];
  series?: Array<{ name?: string; values?: number[] }>;
  headers?: string[];
  rows?: Array<Array<string | number | boolean | null>>;
  items?: Array<{ label?: string; value?: string | number; detail?: string }>;
}

interface SlideDefinition {
  title?: string;
  subtitle?: string;
  bullets?: string[];
  content?: string;
  notes?: string;
  intent?: string;
  visualBrief?: string;
  slideType?: SlideType;
  layout?: "title" | "content" | "section" | "blank" | SlideType;
  layoutHint?: string;
  quote?: string;
  attribution?: string;
  data?: SlideDataDefinition;
  image?: { id?: string; path?: string; url?: string; width?: number; height?: number; alt?: string };
}

interface PptxOptions {
  title?: string;
  author?: string;
  subject?: string;
  slides: SlideDefinition[];
  audience?: string;
  tone?: string;
  visualMode?: PresentationVisualMode;
  styleBrief?: string;
  brand?: {
    name?: string;
    primaryColor?: string;
    secondaryColor?: string;
    accentColor?: string;
    fontFace?: string;
  };
  template?: {
    id?: string;
    name?: string;
    description?: string;
  };
  assets?: PresentationAsset[];
  theme?: {
    primaryColor?: string;
    secondaryColor?: string;
    accentColor?: string;
    fontFace?: string;
  };
}

export async function generatePPTX(
  outputPath: string,
  options: PptxOptions,
): Promise<{ success: boolean; path: string; size: number; slideCount: number }> {
  try {
    await generatePPTXWithArtifactTool(outputPath, options);
  } catch (error) {
    console.warn(
      "[pptx-generator] Codex artifact-tool generation failed; using pptxgenjs fallback:",
      error instanceof Error ? error.message : error,
    );
    await generatePPTXWithPptxGenJs(outputPath, options);
  }

  const stat = fs.statSync(outputPath);
  return {
    success: true,
    path: outputPath,
    size: stat.size,
    slideCount: options.slides.length,
  };
}

async function generatePPTXWithArtifactTool(
  outputPath: string,
  options: PptxOptions,
): Promise<void> {
  const runtime = await resolveCodexArtifactToolRuntime();
  if (!runtime) {
    throw new Error("bundled @oai/artifact-tool runtime is not available");
  }

  let tempDir: string | undefined;
  try {
    await fsp.mkdir(path.dirname(outputPath), { recursive: true });
    tempDir = await fsp.mkdtemp(path.join(os.tmpdir(), "cowork-pptx-generate-"));
    const inputPath = path.join(tempDir, "input.json");
    const scriptPath = path.join(tempDir, "build-presentation.mjs");

    const artifactToolUrl = pathToFileURL(
      path.join(
        runtime.nodeRoot,
        "node_modules",
        "@oai",
        "artifact-tool",
        "dist",
        "artifact_tool.mjs",
      ),
    ).href;

    await fsp.writeFile(
      inputPath,
      JSON.stringify({ outputPath, options, artifactToolUrl }),
      "utf-8",
    );
    await fsp.writeFile(scriptPath, ARTIFACT_TOOL_PPTX_BUILDER, "utf-8");

    await execFileAsync(runtime.nodeBinary, [scriptPath, inputPath], {
      cwd: runtime.nodeRoot,
      timeout: ARTIFACT_TOOL_GENERATION_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
  } finally {
    if (tempDir) {
      await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {
        // Best-effort cleanup.
      });
    }
  }
}

const ARTIFACT_TOOL_PPTX_BUILDER = String.raw`
const fs = await import("node:fs/promises");
const path = await import("node:path");

const inputPath = process.argv[2];
const { outputPath, options, artifactToolUrl } = JSON.parse(await fs.readFile(inputPath, "utf-8"));
const { Presentation, PresentationFile } = await import(artifactToolUrl);

const WIDTH = 1280;
const HEIGHT = 720;
const SAFE = 64;
const LAYOUT_ROTATION = ["content", "image", "metric", "process", "comparison", "quote", "chart", "timeline"];

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function cleanHex(value, fallback) {
  if (typeof value !== "string") return fallback;
  const raw = value.trim().replace(/^#/, "");
  if (/^[0-9a-fA-F]{6}$/.test(raw)) return "#" + raw.toUpperCase();
  if (/^[0-9a-fA-F]{3}$/.test(raw)) {
    return "#" + raw.split("").map((c) => c + c).join("").toUpperCase();
  }
  return fallback;
}

function pickVisualMode() {
  const raw = cleanText(options.visualMode || options.tone || options.styleBrief).toLowerCase();
  if (/play|fun|bold|bright|casual|social|party/.test(raw)) return "playful";
  if (/premium|luxury|brand|cinematic|editorial/.test(raw)) return "premium";
  if (/technical|science|engineering|educational/.test(raw)) return "technical";
  if (/creative|story|pitch|visual|image/.test(raw)) return "editorial";
  return "work";
}

const visualMode = pickVisualMode();
const brand = options.brand || {};
const basePrimary = options.theme?.primaryColor || brand.primaryColor;
const baseSecondary = options.theme?.secondaryColor || brand.secondaryColor;
const baseAccent = options.theme?.accentColor || brand.accentColor;
const PALETTES = {
  work: {
    primary: cleanHex(basePrimary, "#2563EB"),
    secondary: cleanHex(baseSecondary, "#0F172A"),
    accent: cleanHex(baseAccent, "#F97316"),
    ink: "#101827",
    body: "#334155",
    muted: "#64748B",
    bg: "#F8FAFC",
    paper: "#FFFFFF",
    soft: "#E8F0FF",
    rule: "#D7DEE8",
    inverse: "#FFFFFF",
  },
  editorial: {
    primary: cleanHex(basePrimary, "#0E7490"),
    secondary: cleanHex(baseSecondary, "#111827"),
    accent: cleanHex(baseAccent, "#E11D48"),
    ink: "#111827",
    body: "#374151",
    muted: "#6B7280",
    bg: "#FBF7EF",
    paper: "#FFFFFF",
    soft: "#DFF6F8",
    rule: "#DED6C9",
    inverse: "#FFFFFF",
  },
  playful: {
    primary: cleanHex(basePrimary, "#7C3AED"),
    secondary: cleanHex(baseSecondary, "#172554"),
    accent: cleanHex(baseAccent, "#F59E0B"),
    ink: "#18181B",
    body: "#3F3F46",
    muted: "#71717A",
    bg: "#FFF7ED",
    paper: "#FFFFFF",
    soft: "#FDE68A",
    rule: "#E7D9C7",
    inverse: "#FFFFFF",
  },
  premium: {
    primary: cleanHex(basePrimary, "#B45309"),
    secondary: cleanHex(baseSecondary, "#111111"),
    accent: cleanHex(baseAccent, "#14B8A6"),
    ink: "#171717",
    body: "#3D3D3D",
    muted: "#737373",
    bg: "#F5F2EA",
    paper: "#FFFFFF",
    soft: "#EDE6D6",
    rule: "#D9D0BE",
    inverse: "#FFFFFF",
  },
  technical: {
    primary: cleanHex(basePrimary, "#0891B2"),
    secondary: cleanHex(baseSecondary, "#111827"),
    accent: cleanHex(baseAccent, "#65A30D"),
    ink: "#0F172A",
    body: "#334155",
    muted: "#64748B",
    bg: "#F1F5F9",
    paper: "#FFFFFF",
    soft: "#CCFBF1",
    rule: "#CBD5E1",
    inverse: "#FFFFFF",
  },
};
const palette = PALETTES[visualMode];
const FONT = {
  title: options.theme?.fontFace || brand.fontFace || (visualMode === "premium" ? "Georgia" : visualMode === "editorial" ? "Aptos Display" : "Aptos Display"),
  body: options.theme?.fontFace || brand.fontFace || "Aptos",
};

function normalizeSlides(slides) {
  if (Array.isArray(slides) && slides.length > 0) return slides;
  return [{ title: options.title || "Presentation", subtitle: options.subject || "", layout: "title" }];
}

function bulletItems(slide) {
  const bullets = Array.isArray(slide.bullets) ? slide.bullets : [];
  const content = typeof slide.content === "string" && slide.content.trim() ? [slide.content.trim()] : [];
  return [...content, ...bullets].map(cleanText).filter(Boolean);
}

function hasDataRows(slide) {
  return Array.isArray(slide.data?.rows) && slide.data.rows.length > 0;
}

function hasChartData(slide) {
  return Array.isArray(slide.data?.series) && slide.data.series.some((series) => Array.isArray(series.values) && series.values.length > 0);
}

function hasImage(slide) {
  return Boolean(slide.image?.path || slide.image?.url || slide.image?.id);
}

function inferSlideType(slide, index, count) {
  const explicit = cleanText(slide.slideType || slide.layout).toLowerCase();
  if (explicit === "title") return "cover";
  if (explicit === "blank") return "blank";
  if (explicit === "section") return "section";
  if (["cover", "content", "image", "quote", "timeline", "comparison", "process", "chart", "table", "product", "metric", "closing"].includes(explicit)) {
    return explicit;
  }
  const title = cleanText(slide.title).toLowerCase();
  const hint = cleanText(slide.layoutHint || slide.intent || slide.visualBrief).toLowerCase();
  if (index === 0) return "cover";
  if (count > 2 && index === count - 1 && /next|close|thank|question|appendix|wrap|landing/.test(title + " " + hint)) return "closing";
  if (hasDataRows(slide)) return "table";
  if (hasChartData(slide)) return "chart";
  if (hasImage(slide) && /product|screen|demo|app|mock|shot/.test(title + " " + hint)) return "product";
  if (hasImage(slide)) return "image";
  if (slide.quote || /quote|voice|testimonial/.test(title + " " + hint)) return "quote";
  if (/timeline|roadmap|milestone|schedule|phase/.test(title + " " + hint)) return "timeline";
  if (/compare|versus| vs |tradeoff|option/.test(title + " " + hint)) return "comparison";
  if (/process|workflow|steps|how it works|flow/.test(title + " " + hint)) return "process";
  if (/metric|kpi|number|growth|revenue|users|cost|rate|score/.test(title + " " + hint)) return "metric";
  return LAYOUT_ROTATION[(index - 1) % LAYOUT_ROTATION.length];
}

function enrichSlides(rawSlides) {
  const count = rawSlides.length;
  const enriched = rawSlides.map((slide, index) => ({
    ...slide,
    _type: inferSlideType(slide || {}, index, count),
    _motif: index % 5,
  }));
  for (let index = 2; index < enriched.length; index += 1) {
    if (enriched[index]._type === enriched[index - 1]._type && enriched[index]._type === enriched[index - 2]._type) {
      const replacement = LAYOUT_ROTATION.find((candidate) => candidate !== enriched[index - 1]._type && candidate !== enriched[index - 2]._type);
      enriched[index]._type = replacement || "content";
    }
  }
  return enriched;
}

function transparentTextBox(slide, position) {
  return slide.shapes.add({
    geometry: "rect",
    position,
    fill: "#FFFFFF00",
    line: { width: 0, fill: "#FFFFFF00" },
  });
}

function addText(slide, textValue, position, style = {}) {
  const shape = transparentTextBox(slide, position);
  shape.text = String(textValue || "");
  shape.text.typeface = style.typeface || FONT.body;
  shape.text.fontSize = style.fontSize || 24;
  shape.text.color = style.color || palette.ink;
  shape.text.bold = Boolean(style.bold);
  shape.text.italic = Boolean(style.italic);
  shape.text.alignment = style.align || "left";
  shape.text.verticalAlignment = style.valign || "top";
  shape.text.insets = style.insets || { left: 0, right: 0, top: 0, bottom: 0 };
  if (style.autoFit !== false) shape.text.autoFit = "shrinkText";
  return shape;
}

function addRect(slide, position, fill, line = { width: 0, fill }) {
  return slide.shapes.add({ geometry: "rect", position, fill, line });
}

function addRoundRect(slide, position, fill, radius = 7000, line = { width: 0, fill }) {
  return slide.shapes.add({
    geometry: "roundRect",
    position,
    fill,
    line,
    adjustmentList: [{ name: "adj", formula: "val " + radius }],
  });
}

function addRule(slide, left, top, width, color = palette.primary, weight = 4) {
  addRect(slide, { left, top, width, height: weight }, color);
}

function addSlideNumber(slide, index, inverse = false) {
  addText(slide, String(index + 1).padStart(2, "0"), { left: 1150, top: 42, width: 66, height: 30 }, {
    fontSize: 16,
    color: inverse ? "#FFFFFFB8" : palette.muted,
    bold: true,
    align: "right",
  });
}

async function readImageBlob(imagePath) {
  const bytes = await fs.readFile(imagePath);
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
}

function resolveAssetById(id) {
  if (!id || !Array.isArray(options.assets)) return undefined;
  return options.assets.find((asset) => asset && asset.id === id);
}

function imageForSlide(slideDef) {
  const direct = slideDef.image || {};
  const asset = resolveAssetById(direct.id);
  return { ...asset, ...direct };
}

async function addOptionalImage(slide, slideDef, frame, geometry = "roundRect") {
  const image = imageForSlide(slideDef);
  try {
    if (image.path) {
      const imagePath = path.isAbsolute(image.path) ? image.path : path.resolve(path.dirname(outputPath), image.path);
      const placed = slide.images.add({
        blob: await readImageBlob(imagePath),
        fit: "cover",
        alt: image.alt || slideDef.title || "Slide image",
      });
      placed.position = frame;
      placed.geometry = geometry;
      return true;
    }
    if (image.url) {
      const placed = slide.images.add({ uri: image.url, alt: image.alt || slideDef.title || "Slide image" });
      placed.position = frame;
      placed.geometry = geometry;
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

function setSpeakerNotes(slide, notes) {
  if (typeof notes === "string" && notes.trim()) {
    slide.speakerNotes.setText(notes.trim());
  }
}

function drawFallbackVisual(slide, motif, frame, label) {
  const colors = [palette.primary, palette.accent, palette.secondary, palette.soft];
  if (motif === 0) {
    addRect(slide, frame, palette.soft);
    addRect(slide, { left: frame.left, top: frame.top, width: frame.width, height: 18 }, colors[0]);
    addText(slide, label || "Visual focus", { left: frame.left + 38, top: frame.top + 50, width: frame.width - 76, height: 80 }, { fontSize: 30, bold: true, color: palette.ink });
  } else if (motif === 1) {
    addRoundRect(slide, frame, palette.secondary, 12000);
    addRect(slide, { left: frame.left + 42, top: frame.top + 58, width: frame.width - 84, height: 8 }, palette.accent);
    addText(slide, label || "Evidence object", { left: frame.left + 42, top: frame.top + 96, width: frame.width - 84, height: 86 }, { fontSize: 30, bold: true, color: palette.inverse });
  } else if (motif === 2) {
    addRect(slide, frame, palette.paper, { width: 2, fill: palette.rule });
    addRect(slide, { left: frame.left + frame.width - 160, top: frame.top, width: 160, height: frame.height }, palette.primary);
    addText(slide, label || "Asset", { left: frame.left + 38, top: frame.top + 52, width: frame.width - 230, height: 80 }, { fontSize: 32, bold: true, color: palette.ink });
  } else {
    addRect(slide, { left: frame.left, top: frame.top, width: frame.width, height: frame.height }, palette.bg, { width: 0, fill: palette.bg });
    addRoundRect(slide, { left: frame.left + 24, top: frame.top + 24, width: frame.width - 72, height: frame.height - 80, rotation: -4 }, "#FFFFFF", 9000, { width: 1, fill: palette.rule });
    addRoundRect(slide, { left: frame.left + 92, top: frame.top + 86, width: frame.width - 120, height: frame.height - 112, rotation: 5 }, palette.soft, 9000);
    addText(slide, label || "Image slot", { left: frame.left + 72, top: frame.top + 64, width: frame.width - 144, height: 56 }, { fontSize: 28, bold: true, color: palette.ink });
  }
}

function addTitleBlock(slide, slideDef, inverse = false, y = 62, w = 840) {
  addRule(slide, SAFE, y - 18, 88, inverse ? palette.accent : palette.primary, 6);
  addText(slide, slideDef.title || "Untitled slide", { left: SAFE, top: y, width: w, height: 86 }, {
    typeface: FONT.title,
    fontSize: 39,
    bold: true,
    color: inverse ? palette.inverse : palette.ink,
  });
  if (slideDef.subtitle) {
    addText(slide, slideDef.subtitle, { left: SAFE, top: y + 92, width: Math.min(w, 760), height: 52 }, {
      fontSize: 20,
      color: inverse ? "#FFFFFFC9" : palette.body,
    });
  }
}

function renderCover(presentation, slideDef, index) {
  const slide = presentation.slides.add();
  const motif = slideDef._motif || 0;
  const title = slideDef.title || options.title || "Presentation";
  slide.background.fill = motif % 2 === 0 ? palette.secondary : palette.bg;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, motif % 2 === 0 ? palette.secondary : palette.bg);
  if (motif % 3 === 0) {
    addRect(slide, { left: 0, top: 0, width: 470, height: HEIGHT }, palette.primary);
    addRect(slide, { left: 470, top: 0, width: 16, height: HEIGHT }, palette.accent);
    addText(slide, title, { left: 540, top: 158, width: 620, height: 180 }, { typeface: FONT.title, fontSize: 60, bold: true, color: palette.inverse });
    if (slideDef.subtitle) addText(slide, slideDef.subtitle, { left: 544, top: 358, width: 560, height: 74 }, { fontSize: 25, color: "#FFFFFFC9" });
  } else if (motif % 3 === 1) {
    addText(slide, title, { left: 86, top: 96, width: 920, height: 190 }, { typeface: FONT.title, fontSize: 70, bold: true, color: palette.ink });
    if (slideDef.subtitle) addText(slide, slideDef.subtitle, { left: 92, top: 318, width: 760, height: 78 }, { fontSize: 25, color: palette.body });
    addRect(slide, { left: 940, top: 0, width: 340, height: HEIGHT }, palette.secondary);
    drawFallbackVisual(slide, 2, { left: 786, top: 122, width: 374, height: 420 }, cleanText(options.audience || options.subject || brand.name || "Deck"));
  } else {
    addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.secondary);
    addText(slide, title, { left: 76, top: 260, width: 830, height: 150 }, { typeface: FONT.title, fontSize: 64, bold: true, color: palette.inverse });
    if (slideDef.subtitle) addText(slide, slideDef.subtitle, { left: 80, top: 430, width: 720, height: 72 }, { fontSize: 24, color: "#FFFFFFC9" });
    addRect(slide, { left: 0, top: 0, width: WIDTH, height: 18 }, palette.accent);
    addRoundRect(slide, { left: 902, top: 134, width: 244, height: 452, rotation: 9 }, "#FFFFFF20", 12000);
  }
  const footer = cleanText(brand.name || options.author || options.styleBrief || "");
  if (footer) addText(slide, footer, { left: 84, top: 644, width: 520, height: 26 }, { fontSize: 14, color: motif % 2 === 0 ? "#FFFFFF99" : palette.muted });
  setSpeakerNotes(slide, slideDef.notes);
}

function renderSection(presentation, slideDef, index) {
  const slide = presentation.slides.add();
  slide.background.fill = palette.bg;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.bg);
  addText(slide, String(index + 1).padStart(2, "0"), { left: 82, top: 90, width: 220, height: 118 }, { typeface: FONT.title, fontSize: 86, bold: true, color: palette.primary });
  addRule(slide, 88, 244, 180, palette.accent, 7);
  addText(slide, slideDef.title || "Section", { left: 330, top: 136, width: 760, height: 150 }, { typeface: FONT.title, fontSize: 54, bold: true, color: palette.ink });
  const context = slideDef.subtitle || slideDef.content || slideDef.intent;
  if (context) addText(slide, context, { left: 332, top: 320, width: 710, height: 78 }, { fontSize: 23, color: palette.body });
  setSpeakerNotes(slide, slideDef.notes);
}

async function renderImageStatement(presentation, slideDef, index) {
  const slide = presentation.slides.add();
  slide.background.fill = palette.paper;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.paper);
  const imageFrame = slideDef._motif % 2 === 0
    ? { left: 690, top: 0, width: 590, height: HEIGHT }
    : { left: 0, top: 0, width: 560, height: HEIGHT };
  const added = await addOptionalImage(slide, slideDef, imageFrame, "rect");
  if (!added) drawFallbackVisual(slide, slideDef._motif, imageFrame, slideDef.visualBrief || slideDef.title);
  const textLeft = imageFrame.left === 0 ? 630 : 76;
  addText(slide, slideDef.title || "Visual story", { left: textLeft, top: 132, width: 520, height: 150 }, { typeface: FONT.title, fontSize: 50, bold: true, color: palette.ink });
  if (slideDef.subtitle || slideDef.content) addText(slide, slideDef.subtitle || slideDef.content, { left: textLeft + 2, top: 304, width: 500, height: 116 }, { fontSize: 24, color: palette.body });
  bulletItems(slideDef).slice(0, 2).forEach((item, itemIndex) => {
    const y = 482 + itemIndex * 54;
    addRule(slide, textLeft + 2, y + 12, 34, itemIndex === 0 ? palette.primary : palette.accent, 5);
    addText(slide, item, { left: textLeft + 56, top: y, width: 460, height: 42 }, { fontSize: 19, color: palette.body, bold: itemIndex === 0 });
  });
  addSlideNumber(slide, index);
  setSpeakerNotes(slide, slideDef.notes);
}

function renderQuote(presentation, slideDef, index) {
  const slide = presentation.slides.add();
  slide.background.fill = palette.secondary;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.secondary);
  addRect(slide, { left: 0, top: 0, width: 26, height: HEIGHT }, palette.accent);
  addText(slide, "“", { left: 94, top: 84, width: 130, height: 130 }, { typeface: FONT.title, fontSize: 120, color: palette.accent, bold: true });
  const quote = slideDef.quote || slideDef.content || bulletItems(slideDef)[0] || slideDef.title || "A clear point of view belongs on its own slide.";
  addText(slide, quote, { left: 170, top: 168, width: 850, height: 250 }, { typeface: FONT.title, fontSize: 45, color: palette.inverse, bold: true });
  const attribution = slideDef.attribution || slideDef.subtitle || options.audience || "";
  if (attribution) addText(slide, attribution, { left: 178, top: 470, width: 620, height: 42 }, { fontSize: 20, color: "#FFFFFFB8" });
  addSlideNumber(slide, index, true);
  setSpeakerNotes(slide, slideDef.notes);
}

function renderMetric(presentation, slideDef, index) {
  const slide = presentation.slides.add();
  slide.background.fill = palette.bg;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.bg);
  const items = slideDef.data?.items || bulletItems(slideDef).map((item) => {
    const match = item.match(/([+-]?\d+(?:\.\d+)?%?|[$€£]?\d+(?:\.\d+)?[KMB]?)\s*(.*)/i);
    return match ? { value: match[1], label: match[2] || item } : { value: item, label: "" };
  });
  const hero = items[0] || { value: slideDef.title || "1", label: slideDef.subtitle || "Core signal" };
  addText(slide, slideDef.title || "Key signal", { left: SAFE, top: 64, width: 760, height: 70 }, { typeface: FONT.title, fontSize: 36, bold: true, color: palette.ink });
  addText(slide, String(hero.value || ""), { left: SAFE, top: 172, width: 610, height: 150 }, { typeface: FONT.title, fontSize: 104, bold: true, color: palette.primary });
  addText(slide, hero.label || slideDef.subtitle || slideDef.content || "", { left: SAFE + 6, top: 330, width: 650, height: 88 }, { fontSize: 25, color: palette.body });
  items.slice(1, 4).forEach((item, itemIndex) => {
    const x = 726;
    const y = 168 + itemIndex * 128;
    addRule(slide, x, y, 320, itemIndex === 0 ? palette.accent : palette.rule, 5);
    addText(slide, String(item.value || ""), { left: x, top: y + 20, width: 300, height: 48 }, { fontSize: 34, bold: true, color: palette.ink });
    addText(slide, item.label || item.detail || "", { left: x, top: y + 72, width: 360, height: 40 }, { fontSize: 17, color: palette.body });
  });
  addSlideNumber(slide, index);
  setSpeakerNotes(slide, slideDef.notes);
}

function renderProcess(presentation, slideDef, index) {
  const slide = presentation.slides.add();
  slide.background.fill = palette.paper;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.paper);
  addTitleBlock(slide, slideDef, false, 66, 920);
  const items = bulletItems(slideDef).slice(0, 5);
  const count = Math.max(items.length, 3);
  const startX = 96;
  const gap = 28;
  const cardW = (1088 - gap * (count - 1)) / count;
  for (let i = 0; i < count; i += 1) {
    const x = startX + i * (cardW + gap);
    const y = 318 + (i % 2) * 38;
    addRoundRect(slide, { left: x, top: y, width: cardW, height: 170 }, i === 0 ? palette.secondary : palette.bg, 9000, { width: 1, fill: i === 0 ? palette.secondary : palette.rule });
    addText(slide, String(i + 1).padStart(2, "0"), { left: x + 22, top: y + 22, width: 58, height: 30 }, { fontSize: 18, bold: true, color: i === 0 ? palette.accent : palette.primary });
    addText(slide, items[i] || "Step " + (i + 1), { left: x + 22, top: y + 62, width: cardW - 44, height: 78 }, { fontSize: 20, bold: i === 0, color: i === 0 ? palette.inverse : palette.ink });
    if (i < count - 1) addRule(slide, x + cardW + 6, y + 84, gap - 12, palette.accent, 4);
  }
  addSlideNumber(slide, index);
  setSpeakerNotes(slide, slideDef.notes);
}

function renderComparison(presentation, slideDef, index) {
  const slide = presentation.slides.add();
  slide.background.fill = palette.bg;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.bg);
  addTitleBlock(slide, slideDef, false, 62, 980);
  const items = bulletItems(slideDef);
  const midpoint = Math.ceil(items.length / 2);
  const leftItems = items.slice(0, midpoint);
  const rightItems = items.slice(midpoint);
  const columns = [
    { x: 82, title: slideDef.data?.headers?.[0] || "Option A", color: palette.primary, items: leftItems },
    { x: 676, title: slideDef.data?.headers?.[1] || "Option B", color: palette.accent, items: rightItems.length ? rightItems : leftItems.slice(0, 3), },
  ];
  columns.forEach((column) => {
    addText(slide, column.title, { left: column.x, top: 226, width: 450, height: 44 }, { fontSize: 28, bold: true, color: column.color });
    addRule(slide, column.x, 282, 460, column.color, 5);
    column.items.slice(0, 5).forEach((item, itemIndex) => {
      const y = 322 + itemIndex * 54;
      addText(slide, item, { left: column.x, top: y, width: 470, height: 38 }, { fontSize: 19, color: palette.body, bold: itemIndex === 0 });
      addRect(slide, { left: column.x, top: y + 42, width: 420, height: 1 }, palette.rule);
    });
  });
  addSlideNumber(slide, index);
  setSpeakerNotes(slide, slideDef.notes);
}

function renderTimeline(presentation, slideDef, index) {
  const slide = presentation.slides.add();
  slide.background.fill = palette.paper;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.paper);
  addTitleBlock(slide, slideDef, false, 68, 920);
  const items = slideDef.data?.items || bulletItems(slideDef).map((item) => ({ label: item }));
  const visible = items.slice(0, 5);
  const y = 392;
  addRule(slide, 106, y, 1040, palette.rule, 4);
  visible.forEach((item, itemIndex) => {
    const x = 112 + itemIndex * (1040 / Math.max(visible.length - 1, 1));
    addRoundRect(slide, { left: x - 18, top: y - 18, width: 36, height: 36 }, itemIndex === 0 ? palette.primary : palette.paper, 12000, { width: 3, fill: itemIndex === 0 ? palette.primary : palette.primary });
    addText(slide, item.value || item.label || "Milestone", { left: x - 82, top: y + 42, width: 164, height: 36 }, { fontSize: 18, bold: true, color: palette.ink, align: "center" });
    if (item.detail) addText(slide, item.detail, { left: x - 100, top: y + 82, width: 200, height: 44 }, { fontSize: 14, color: palette.body, align: "center" });
  });
  addSlideNumber(slide, index);
  setSpeakerNotes(slide, slideDef.notes);
}

function renderChart(presentation, slideDef, index) {
  const slide = presentation.slides.add();
  slide.background.fill = palette.bg;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.bg);
  addTitleBlock(slide, slideDef, false, 58, 940);
  const categories = slideDef.data?.categories || bulletItems(slideDef).slice(0, 5);
  const firstSeries = slideDef.data?.series?.[0] || { values: categories.map((_, itemIndex) => itemIndex + 1), name: "Value" };
  const values = Array.isArray(firstSeries.values) && firstSeries.values.length ? firstSeries.values : categories.map((_, itemIndex) => itemIndex + 1);
  const max = Math.max(...values.map((value) => Math.abs(Number(value) || 0)), 1);
  const chart = { left: 132, top: 248, width: 940, height: 330 };
  addRule(slide, chart.left, chart.top + chart.height, chart.width, palette.rule, 3);
  values.slice(0, 7).forEach((value, itemIndex) => {
    const numeric = Number(value) || 0;
    const slot = chart.width / Math.min(values.length, 7);
    const barW = Math.max(34, slot * 0.48);
    const barH = Math.max(12, Math.abs(numeric) / max * (chart.height - 52));
    const x = chart.left + itemIndex * slot + slot * 0.22;
    const y = chart.top + chart.height - barH;
    addRect(slide, { left: x, top: y, width: barW, height: barH }, itemIndex === 0 ? palette.primary : palette.accent);
    addText(slide, String(value), { left: x - 10, top: y - 32, width: barW + 20, height: 24 }, { fontSize: 15, bold: true, color: palette.ink, align: "center" });
    addText(slide, categories[itemIndex] || "", { left: x - 28, top: chart.top + chart.height + 18, width: barW + 56, height: 42 }, { fontSize: 13, color: palette.body, align: "center" });
  });
  if (firstSeries.name) addText(slide, firstSeries.name, { left: 132, top: 602, width: 420, height: 28 }, { fontSize: 15, color: palette.muted });
  addSlideNumber(slide, index);
  setSpeakerNotes(slide, slideDef.notes);
}

function renderTable(presentation, slideDef, index) {
  const slide = presentation.slides.add();
  slide.background.fill = palette.paper;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.paper);
  addTitleBlock(slide, slideDef, false, 58, 940);
  const headers = slideDef.data?.headers || ["Item", "Value", "Notes"];
  const rows = slideDef.data?.rows || bulletItems(slideDef).map((item) => [item, "", ""]);
  const left = 82;
  const top = 228;
  const tableW = 1116;
  const rowH = 52;
  const colW = tableW / Math.max(headers.length, 1);
  addRect(slide, { left, top, width: tableW, height: rowH }, palette.secondary);
  headers.forEach((header, columnIndex) => {
    addText(slide, header, { left: left + columnIndex * colW + 16, top: top + 15, width: colW - 32, height: 24 }, { fontSize: 16, bold: true, color: palette.inverse });
  });
  rows.slice(0, 6).forEach((row, rowIndex) => {
    const y = top + rowH * (rowIndex + 1);
    addRect(slide, { left, top: y, width: tableW, height: rowH }, rowIndex % 2 === 0 ? palette.bg : palette.paper, { width: 1, fill: palette.rule });
    headers.forEach((_, columnIndex) => {
      addText(slide, cleanText(row[columnIndex]), { left: left + columnIndex * colW + 16, top: y + 14, width: colW - 32, height: 28 }, { fontSize: 15, bold: columnIndex === 0, color: palette.body });
    });
  });
  addSlideNumber(slide, index);
  setSpeakerNotes(slide, slideDef.notes);
}

async function renderProduct(presentation, slideDef, index) {
  const slide = presentation.slides.add();
  slide.background.fill = palette.secondary;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.secondary);
  addTitleBlock(slide, slideDef, true, 58, 980);
  const frame = { left: 160, top: 226, width: 960, height: 388 };
  addRoundRect(slide, { left: frame.left - 18, top: frame.top - 18, width: frame.width + 36, height: frame.height + 36 }, "#FFFFFF18", 8000);
  const added = await addOptionalImage(slide, slideDef, frame, "roundRect");
  if (!added) drawFallbackVisual(slide, 1, frame, slideDef.visualBrief || "Product view");
  addSlideNumber(slide, index, true);
  setSpeakerNotes(slide, slideDef.notes);
}

function renderContent(presentation, slideDef, index) {
  const slide = presentation.slides.add();
  slide.background.fill = palette.bg;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.bg);
  addTitleBlock(slide, slideDef, false, 62, 920);
  const items = bulletItems(slideDef);
  const motif = slideDef._motif || 0;
  if (items.length === 0 && slideDef.content) items.push(cleanText(slideDef.content));
  if (motif % 2 === 0) {
    items.slice(0, 5).forEach((item, itemIndex) => {
      const y = 228 + itemIndex * 78;
      addRule(slide, 86, y + 15, 42, itemIndex === 0 ? palette.primary : palette.accent, 5);
      addText(slide, item, { left: 152, top: y, width: 880, height: 54 }, { fontSize: itemIndex === 0 ? 25 : 21, bold: itemIndex === 0, color: palette.body });
    });
  } else {
    const leftItems = items.slice(0, Math.ceil(items.length / 2));
    const rightItems = items.slice(Math.ceil(items.length / 2));
    [
      { x: 86, items: leftItems },
      { x: 646, items: rightItems.length ? rightItems : leftItems.slice(0, 2) },
    ].forEach((column, columnIndex) => {
      column.items.slice(0, 4).forEach((item, itemIndex) => {
        const y = 238 + itemIndex * 86;
        addText(slide, item, { left: column.x, top: y, width: 470, height: 58 }, { fontSize: columnIndex === 0 && itemIndex === 0 ? 24 : 20, bold: columnIndex === 0 && itemIndex === 0, color: palette.body });
        addRect(slide, { left: column.x, top: y + 66, width: 390, height: 1 }, palette.rule);
      });
    });
  }
  addSlideNumber(slide, index);
  setSpeakerNotes(slide, slideDef.notes);
}

function renderClosing(presentation, slideDef, index) {
  const slide = presentation.slides.add();
  slide.background.fill = palette.secondary;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.secondary);
  addRect(slide, { left: 0, top: HEIGHT - 24, width: WIDTH, height: 24 }, palette.accent);
  addText(slide, slideDef.title || "Next steps", { left: 96, top: 160, width: 760, height: 130 }, { typeface: FONT.title, fontSize: 58, bold: true, color: palette.inverse });
  if (slideDef.subtitle || slideDef.content) addText(slide, slideDef.subtitle || slideDef.content, { left: 100, top: 310, width: 660, height: 82 }, { fontSize: 24, color: "#FFFFFFC9" });
  bulletItems(slideDef).slice(0, 3).forEach((item, itemIndex) => {
    const y = 470 + itemIndex * 48;
    addText(slide, item, { left: 104, top: y, width: 680, height: 34 }, { fontSize: 20, color: palette.inverse, bold: itemIndex === 0 });
  });
  addSlideNumber(slide, index, true);
  setSpeakerNotes(slide, slideDef.notes);
}

function renderBlank(presentation, slideDef) {
  const slide = presentation.slides.add();
  slide.background.fill = palette.paper;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.paper);
  if (slideDef.title) {
    addText(slide, slideDef.title, { left: 72, top: 72, width: 920, height: 76 }, { typeface: FONT.title, fontSize: 40, bold: true, color: palette.ink });
  }
  setSpeakerNotes(slide, slideDef.notes);
}

const renderers = {
  cover: renderCover,
  section: renderSection,
  image: renderImageStatement,
  quote: renderQuote,
  metric: renderMetric,
  process: renderProcess,
  comparison: renderComparison,
  timeline: renderTimeline,
  chart: renderChart,
  table: renderTable,
  product: renderProduct,
  content: renderContent,
  closing: renderClosing,
  blank: renderBlank,
};

const presentation = Presentation.create({ slideSize: { width: WIDTH, height: HEIGHT } });
const slides = enrichSlides(normalizeSlides(options.slides));

for (let index = 0; index < slides.length; index += 1) {
  const slideDef = slides[index] || {};
  const renderer = renderers[slideDef._type] || renderContent;
  await renderer(presentation, slideDef, index);
}

const pptx = await PresentationFile.exportPptx(presentation);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await pptx.save(outputPath);
`;

async function generatePPTXWithPptxGenJs(
  outputPath: string,
  options: PptxOptions,
): Promise<void> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();

  const primaryColor = (options.theme?.primaryColor || "#2563eb").replace("#", "");
  const secondaryColor = (
    options.theme?.secondaryColor ||
    options.brand?.secondaryColor ||
    "#0f172a"
  ).replace("#", "");
  const accentColor = (options.theme?.accentColor || options.brand?.accentColor || "#f97316").replace(
    "#",
    "",
  );
  const fontFace = options.theme?.fontFace || "Helvetica Neue";

  if (options.title) pptx.title = options.title;
  if (options.author) pptx.author = options.author;
  if (options.subject) pptx.subject = options.subject;
  pptx.layout = "LAYOUT_WIDE";

  const slides = options.slides.length
    ? options.slides
    : [{ title: options.title || "Presentation", subtitle: options.subject, layout: "title" as const }];

  const getItems = (slideDef: SlideDefinition): string[] => {
    const content = slideDef.content ? [slideDef.content] : [];
    return [...content, ...(slideDef.bullets || [])]
      .map((item) => String(item || "").replace(/\s+/g, " ").trim())
      .filter(Boolean);
  };

  const getSlideType = (slideDef: SlideDefinition, index: number): SlideType => {
    if (slideDef.slideType) return slideDef.slideType;
    if (slideDef.layout === "title") return "cover";
    if (slideDef.layout === "section") return "section";
    if (slideDef.layout === "blank") return "blank";
    if (slideDef.layout && slideDef.layout !== "content") return slideDef.layout as SlideType;
    if (index === 0) return "cover";
    if (slideDef.data?.rows?.length) return "table";
    if (slideDef.data?.series?.length) return "chart";
    if (slideDef.image) return "image";
    return (["content", "metric", "process", "comparison", "quote"] as SlideType[])[
      (index - 1) % 5
    ];
  };

  const addHeader = (slide: Any, slideDef: SlideDefinition, index: number): void => {
    slide.addShape(pptx.ShapeType.rect, {
      x: 0.55,
      y: 0.45,
      w: 0.9,
      h: 0.06,
      fill: { color: primaryColor },
      line: { color: primaryColor, transparency: 100 },
    });
    slide.addText(slideDef.title || "Untitled slide", {
      x: 0.55,
      y: 0.68,
      w: 9.2,
      h: 0.72,
      fontSize: 26,
      fontFace,
      color: "111827",
      bold: true,
      fit: "shrink",
    });
    slide.addText(String(index + 1).padStart(2, "0"), {
      x: 12,
      y: 0.38,
      w: 0.7,
      h: 0.25,
      fontSize: 10,
      color: "64748B",
      align: "right",
      bold: true,
    });
  };

  for (let index = 0; index < slides.length; index += 1) {
    const slideDef = slides[index];
    const slide = pptx.addSlide();
    const slideType = getSlideType(slideDef, index);
    const items = getItems(slideDef);

    if (slideType === "cover") {
      slide.background = { color: secondaryColor };
      slide.addShape(pptx.ShapeType.rect, {
        x: 0,
        y: 0,
        w: 4.7,
        h: 7.5,
        fill: { color: primaryColor },
        line: { color: primaryColor, transparency: 100 },
      });
      slide.addShape(pptx.ShapeType.rect, {
        x: 4.7,
        y: 0,
        w: 0.12,
        h: 7.5,
        fill: { color: accentColor },
        line: { color: accentColor, transparency: 100 },
      });

      if (slideDef.title) {
        slide.addText(slideDef.title, {
          x: 5.35,
          y: 1.55,
          w: 6.2,
          h: 1.55,
          fontSize: 42,
          fontFace,
          color: "FFFFFF",
          bold: true,
          fit: "shrink",
        });
      }

      if (slideDef.subtitle) {
        slide.addText(slideDef.subtitle, {
          x: 5.38,
          y: 3.35,
          w: 5.6,
          h: 0.7,
          fontSize: 19,
          fontFace,
          color: "E0E7FF",
          fit: "shrink",
        });
      }
    } else if (slideType === "section") {
      slide.background = { color: "F8FAFC" };
      slide.addText(String(index + 1).padStart(2, "0"), {
        x: 0.75,
        y: 0.9,
        w: 2.1,
        h: 1.2,
        fontSize: 56,
        fontFace,
        color: primaryColor,
        bold: true,
      });
      slide.addShape(pptx.ShapeType.rect, {
        x: 0.82,
        y: 2.45,
        w: 1.85,
        h: 0.08,
        fill: { color: accentColor },
        line: { color: accentColor, transparency: 100 },
      });
      slide.addText(slideDef.title || "Section", {
        x: 3.25,
        y: 1.35,
        w: 7.4,
        h: 1.35,
        fontSize: 36,
        fontFace,
        color: "111827",
        bold: true,
        fit: "shrink",
      });
      if (slideDef.subtitle || slideDef.content) {
        slide.addText(slideDef.subtitle || slideDef.content || "", {
          x: 3.28,
          y: 3.15,
          w: 6.7,
          h: 0.72,
          fontSize: 17,
          fontFace,
          color: "334155",
          fit: "shrink",
        });
      }
    } else if (slideType === "table") {
      addHeader(slide, slideDef, index);
      const headers = slideDef.data?.headers || ["Item", "Value", "Notes"];
      const rows = slideDef.data?.rows || items.map((item) => [item, "", ""]);
      const tableRows = [headers, ...rows.slice(0, 6)].map((row) =>
        row.map((cell) => ({
          text: String(cell ?? ""),
        })),
      );
      slide.addTable(tableRows, {
        x: 0.65,
        y: 2.0,
        w: 11.8,
        h: 3.8,
        border: { type: "solid", color: "D7DEE8", pt: 1 },
        fontFace,
        fontSize: 10,
        color: "334155",
        fill: { color: "FFFFFF" },
      });
    } else if (slideType === "chart") {
      addHeader(slide, slideDef, index);
      const values = slideDef.data?.series?.[0]?.values || [3, 5, 4, 7];
      const categories = slideDef.data?.categories || values.map((_, itemIndex) => `Item ${itemIndex + 1}`);
      const max = Math.max(...values.map((value) => Math.abs(value)), 1);
      values.slice(0, 7).forEach((value, itemIndex) => {
        const h = Math.max(0.18, (Math.abs(value) / max) * 3.2);
        const x = 1.05 + itemIndex * 1.45;
        slide.addShape(pptx.ShapeType.rect, {
          x,
          y: 5.8 - h,
          w: 0.72,
          h,
          fill: { color: itemIndex === 0 ? primaryColor : accentColor },
          line: { color: itemIndex === 0 ? primaryColor : accentColor, transparency: 100 },
        });
        slide.addText(String(value), {
          x: x - 0.1,
          y: 5.48 - h,
          w: 0.92,
          h: 0.22,
          fontSize: 10,
          bold: true,
          align: "center",
          color: "111827",
        });
        slide.addText(categories[itemIndex] || "", {
          x: x - 0.35,
          y: 5.95,
          w: 1.25,
          h: 0.38,
          fontSize: 8,
          align: "center",
          color: "334155",
          fit: "shrink",
        });
      });
    } else if (slideType === "metric") {
      addHeader(slide, slideDef, index);
      const hero = items[0] || slideDef.subtitle || slideDef.content || "1 key signal";
      const match = hero.match(/([+-]?\d+(?:\.\d+)?%?|[$€£]?\d+(?:\.\d+)?[KMB]?)/i);
      slide.addText(match?.[1] || hero, {
        x: 0.72,
        y: 1.95,
        w: 5.4,
        h: 1.35,
        fontSize: 62,
        fontFace,
        color: primaryColor,
        bold: true,
        fit: "shrink",
      });
      slide.addText(match ? hero.replace(match[1], "").trim() : slideDef.subtitle || "", {
        x: 0.78,
        y: 3.25,
        w: 6.1,
        h: 0.85,
        fontSize: 18,
        color: "334155",
        fit: "shrink",
      });
      items.slice(1, 4).forEach((item, itemIndex) => {
        slide.addShape(pptx.ShapeType.rect, {
          x: 7.1,
          y: 1.85 + itemIndex * 1.1,
          w: 3.2,
          h: 0.05,
          fill: { color: itemIndex === 0 ? accentColor : "D7DEE8" },
          line: { color: itemIndex === 0 ? accentColor : "D7DEE8", transparency: 100 },
        });
        slide.addText(item, {
          x: 7.1,
          y: 2.06 + itemIndex * 1.1,
          w: 4.2,
          h: 0.5,
          fontSize: 14,
          color: "334155",
          fit: "shrink",
        });
      });
    } else {
      slide.addShape(pptx.ShapeType.rect, {
        x: index % 2 === 0 ? 0 : 12.95,
        y: 0,
        w: 0.38,
        h: 7.5,
        fill: { color: primaryColor },
        line: { color: primaryColor, transparency: 100 },
      });

      addHeader(slide, slideDef, index);
      if ((slideType === "image" || slideType === "product") && slideDef.image) {
        const imgOpts: {
          x: number;
          y: number;
          w: number;
          h: number;
          path?: string;
        } = {
          x: 7.1,
          y: 1.65,
          w: slideDef.image.width || 4.9,
          h: slideDef.image.height || 3.65,
        };
        if (slideDef.image.path && fs.existsSync(slideDef.image.path)) {
          imgOpts.path = slideDef.image.path;
          slide.addImage(imgOpts);
        }
      }

      const textX = slideType === "image" || slideType === "product" ? 0.72 : 0.9;
      const textW = slideType === "image" || slideType === "product" ? 5.7 : 10.8;
      items.slice(0, 5).forEach((item, itemIndex) => {
        const y = 2.08 + itemIndex * 0.68;
        slide.addShape(pptx.ShapeType.rect, {
          x: textX,
          y: y + 0.15,
          w: 0.34,
          h: 0.04,
          fill: { color: itemIndex === 0 ? primaryColor : accentColor },
          line: { color: itemIndex === 0 ? primaryColor : accentColor, transparency: 100 },
        });
        slide.addText(item, {
          x: textX + 0.55,
          y,
          w: textW,
          h: 0.45,
          fontSize: itemIndex === 0 ? 17 : 14,
          fontFace,
          color: "334155",
          bold: itemIndex === 0,
          fit: "shrink",
        });
      });
    }

    if (slideDef.notes) {
      slide.addNotes(slideDef.notes);
    }
  }

  await pptx.writeFile({ fileName: outputPath });
}
