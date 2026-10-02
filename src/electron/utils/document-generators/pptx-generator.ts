/**
 * PPTX Generator — creates PowerPoint presentations from structured slide data.
 *
 * Uses Codex's bundled @oai/artifact-tool presentation runtime when available.
 * Falls back to pptxgenjs only when the bundled runtime cannot be loaded.
 * Both renderers draw the same slide plan (see pptx-slide-plan.ts), and the
 * written file is read back to confirm every planned text made it in.
 */

import { execFile } from "child_process";
import { promisify } from "util";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";
import { pathToFileURL } from "url";
import JSZip from "jszip";
import { resolveCodexArtifactToolRuntime } from "../codex-artifact-tool-runtime";
import { createLogger } from "../logger";
import {
  SLIDE_CAPACITY,
  expectedSlideText,
  formatChartValue,
  planPresentationSlides,
  type PlannedSlide,
  type PresentationSlideType,
} from "./pptx-slide-plan";

const execFileAsync = promisify(execFile);
const ARTIFACT_TOOL_GENERATION_TIMEOUT_MS = 90_000;
const logger = createLogger("pptx-generator");

type PresentationVisualMode = "work" | "editorial" | "playful" | "premium" | "technical";
type SlideType = PresentationSlideType;

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
  image?: {
    id?: string;
    path?: string;
    url?: string;
    width?: number;
    height?: number;
    alt?: string;
  };
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

export interface PptxGenerationResult {
  success: boolean;
  path: string;
  size: number;
  /** Slides written to the file, including continuation slides. */
  slideCount: number;
  /** Slides in the request. */
  requestedSlideCount: number;
  renderer: "artifact-tool" | "pptxgenjs";
  /** Adaptations and problems to report to the user; empty when the deck matches the request. */
  warnings: string[];
}

export async function generatePPTX(
  outputPath: string,
  options: PptxOptions,
): Promise<PptxGenerationResult> {
  const plan = planPresentationSlides(options.slides, {
    title: options.title,
    subject: options.subject,
    assets: options.assets,
  });
  const warnings = [...plan.warnings];
  let renderer: PptxGenerationResult["renderer"] = "artifact-tool";
  try {
    warnings.push(...(await generatePPTXWithArtifactTool(outputPath, options, plan.slides)));
  } catch (error) {
    logger.warn(
      "Codex artifact-tool generation failed; using pptxgenjs fallback:",
      error instanceof Error ? error.message : error,
    );
    renderer = "pptxgenjs";
    warnings.push(...(await generatePPTXWithPptxGenJs(outputPath, options, plan.slides)));
  }

  const verification = await verifyWrittenSlides(outputPath, plan.slides);
  warnings.push(...verification.warnings);
  const stat = fs.statSync(outputPath);
  return {
    success: true,
    path: outputPath,
    size: stat.size,
    slideCount: verification.slideCount ?? plan.slides.length,
    requestedSlideCount: plan.requestedSlideCount,
    renderer,
    warnings,
  };
}

function decodeSlideXmlText(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-fA-F]+);/g, (_match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_match, dec) => String.fromCodePoint(Number(dec)))
    .replace(/&amp;/g, "&");
}

function normalizeVerifiedText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/**
 * Reads the written deck back and reports planned text that is not in it, so
 * a renderer that loses content can never do so silently.
 */
async function verifyWrittenSlides(
  outputPath: string,
  slides: PlannedSlide[],
): Promise<{ slideCount?: number; warnings: string[] }> {
  try {
    const zip = await JSZip.loadAsync(await fsp.readFile(outputPath));
    const entries = Object.keys(zip.files)
      .map((name) => ({ name, number: Number(name.match(/^ppt\/slides\/slide(\d+)\.xml$/)?.[1]) }))
      .filter((entry) => Number.isInteger(entry.number))
      .sort((a, b) => a.number - b.number);
    const texts = await Promise.all(
      entries.map(async (entry) => {
        const xml = (await zip.file(entry.name)?.async("string")) ?? "";
        const runs = Array.from(xml.matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>/g), (match) =>
          decodeSlideXmlText(match[1]),
        );
        return normalizeVerifiedText(runs.join(""));
      }),
    );

    const warnings: string[] = [];
    if (texts.length !== slides.length) {
      warnings.push(
        `The written deck has ${texts.length} slide(s), but ${slides.length} were planned.`,
      );
    }
    slides.forEach((slide, index) => {
      const text = texts[index];
      if (text === undefined) return;
      const missing = expectedSlideText(slide).filter(
        (expected) => !text.includes(normalizeVerifiedText(expected)),
      );
      if (missing.length > 0) {
        const shown = missing.slice(0, 5).map((value) => JSON.stringify(value));
        const more =
          missing.length > shown.length ? ` and ${missing.length - shown.length} more` : "";
        warnings.push(
          `Slide ${index + 1} of the written deck is missing planned text: ${shown.join(", ")}${more}.`,
        );
      }
    });
    return { slideCount: texts.length, warnings };
  } catch (error) {
    return {
      warnings: [
        `The written deck could not be read back to verify its content: ${
          error instanceof Error ? error.message : String(error)
        }`,
      ],
    };
  }
}

async function readRuntimeWarnings(warningsPath: string): Promise<string[]> {
  try {
    const parsed: unknown = JSON.parse(await fsp.readFile(warningsPath, "utf-8"));
    return Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === "string")
      : [];
  } catch {
    return [];
  }
}

async function generatePPTXWithArtifactTool(
  outputPath: string,
  options: PptxOptions,
  slides: PlannedSlide[],
): Promise<string[]> {
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
    const warningsPath = path.join(tempDir, "warnings.json");

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
      JSON.stringify({
        outputPath,
        options: { ...options, slides },
        artifactToolUrl,
        warningsPath,
      }),
      "utf-8",
    );
    await fsp.writeFile(scriptPath, ARTIFACT_TOOL_PPTX_BUILDER, "utf-8");

    await execFileAsync(runtime.nodeBinary, [scriptPath, inputPath], {
      cwd: runtime.nodeRoot,
      timeout: ARTIFACT_TOOL_GENERATION_TIMEOUT_MS,
      maxBuffer: 16 * 1024 * 1024,
    });
    return await readRuntimeWarnings(warningsPath);
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
const { outputPath, options, artifactToolUrl, warningsPath } = JSON.parse(await fs.readFile(inputPath, "utf-8"));
const { Presentation, PresentationFile } = await import(artifactToolUrl);

const WIDTH = 1280;
const HEIGHT = 720;
const SAFE = 64;
// Slides arrive planned (layout, motif, and content already sized to fit),
// so renderers draw everything they receive and never pick their own layout.
const runtimeWarnings = [];

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

function joinParts(parts) {
  return parts.filter(Boolean).join(" — ");
}

function formatChartValue(value) {
  return value === null || value === undefined ? "–" : String(value);
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
  } catch (error) {
    runtimeWarnings.push(
      "Slide " + slideDef.source + ": the image could not be placed (" +
        (error instanceof Error ? error.message : String(error)) + "), so a placeholder was drawn.",
    );
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
  const motif = slideDef.motif || 0;
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
  const context = slideDef.subtitle || slideDef.intent;
  if (context) addText(slide, context, { left: 332, top: 320, width: 710, height: 78 }, { fontSize: 23, color: palette.body });
  setSpeakerNotes(slide, slideDef.notes);
}

async function renderImageStatement(presentation, slideDef, index) {
  const slide = presentation.slides.add();
  slide.background.fill = palette.paper;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.paper);
  const imageFrame = slideDef.motif % 2 === 0
    ? { left: 690, top: 0, width: 590, height: HEIGHT }
    : { left: 0, top: 0, width: 560, height: HEIGHT };
  const added = await addOptionalImage(slide, slideDef, imageFrame, "rect");
  if (!added) drawFallbackVisual(slide, slideDef.motif, imageFrame, slideDef.visualBrief || slideDef.title);
  const textLeft = imageFrame.left === 0 ? 630 : 76;
  addText(slide, slideDef.title || "Visual story", { left: textLeft, top: 132, width: 520, height: 150 }, { typeface: FONT.title, fontSize: 50, bold: true, color: palette.ink });
  if (slideDef.subtitle) addText(slide, slideDef.subtitle, { left: textLeft + 2, top: 304, width: 500, height: 116 }, { fontSize: 24, color: palette.body });
  slideDef.bullets.forEach((item, itemIndex) => {
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
  if (slideDef.title) addText(slide, slideDef.title, { left: 96, top: 38, width: 900, height: 40 }, { fontSize: 20, bold: true, color: "#FFFFFFB8" });
  addText(slide, "“", { left: 94, top: 84, width: 130, height: 130 }, { typeface: FONT.title, fontSize: 120, color: palette.accent, bold: true });
  if (slideDef.quote) addText(slide, slideDef.quote, { left: 170, top: 168, width: 850, height: 250 }, { typeface: FONT.title, fontSize: 45, color: palette.inverse, bold: true });
  if (slideDef.attribution) addText(slide, slideDef.attribution, { left: 178, top: 470, width: 620, height: 42 }, { fontSize: 20, color: "#FFFFFFB8" });
  addSlideNumber(slide, index, true);
  setSpeakerNotes(slide, slideDef.notes);
}

function renderMetric(presentation, slideDef, index) {
  const slide = presentation.slides.add();
  slide.background.fill = palette.bg;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.bg);
  // Metrics come from data.items or from bullets that start with a number;
  // a metric without a value is shown as text, never given a made-up number.
  const metrics = slideDef.metrics || [];
  const hero = metrics[0] || { value: "", label: "", detail: "" };
  addText(slide, slideDef.title || "Key signal", { left: SAFE, top: 64, width: 760, height: 70 }, { typeface: FONT.title, fontSize: 36, bold: true, color: palette.ink });
  if (slideDef.subtitle) addText(slide, slideDef.subtitle, { left: SAFE, top: 132, width: 760, height: 32 }, { fontSize: 18, color: palette.body });
  if (hero.value) addText(slide, hero.value, { left: SAFE, top: 172, width: 610, height: 150 }, { typeface: FONT.title, fontSize: 104, bold: true, color: palette.primary });
  const heroLabel = joinParts([hero.label, hero.detail]);
  if (heroLabel) addText(slide, heroLabel, { left: SAFE + 6, top: hero.value ? 330 : 172, width: 650, height: 88 }, { fontSize: 25, color: palette.body });
  metrics.slice(1).forEach((item, itemIndex) => {
    const x = 726;
    const y = 168 + itemIndex * 128;
    addRule(slide, x, y, 320, itemIndex === 0 ? palette.accent : palette.rule, 5);
    if (item.value) addText(slide, item.value, { left: x, top: y + 20, width: 300, height: 48 }, { fontSize: 34, bold: true, color: palette.ink });
    const label = joinParts([item.label, item.detail]);
    if (label) addText(slide, label, { left: x, top: item.value ? y + 72 : y + 20, width: 360, height: item.value ? 40 : 92 }, { fontSize: item.value ? 17 : 20, color: palette.body });
  });
  addSlideNumber(slide, index);
  setSpeakerNotes(slide, slideDef.notes);
}

function renderProcess(presentation, slideDef, index) {
  const slide = presentation.slides.add();
  slide.background.fill = palette.paper;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.paper);
  addTitleBlock(slide, slideDef, false, 66, 920);
  const items = slideDef.bullets;
  const count = items.length;
  const startX = 96;
  const gap = 28;
  const cardW = (1088 - gap * (Math.max(count, 1) - 1)) / Math.max(count, 1);
  for (let i = 0; i < count; i += 1) {
    const x = startX + i * (cardW + gap);
    const y = 318 + (i % 2) * 38;
    addRoundRect(slide, { left: x, top: y, width: cardW, height: 170 }, i === 0 ? palette.secondary : palette.bg, 9000, { width: 1, fill: i === 0 ? palette.secondary : palette.rule });
    addText(slide, String(i + 1 + (slideDef.offset || 0)).padStart(2, "0"), { left: x + 22, top: y + 22, width: 58, height: 30 }, { fontSize: 18, bold: true, color: i === 0 ? palette.accent : palette.primary });
    addText(slide, items[i], { left: x + 22, top: y + 62, width: cardW - 44, height: 78 }, { fontSize: 20, bold: i === 0, color: i === 0 ? palette.inverse : palette.ink });
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
  const planned = slideDef.columns || [];
  const columns = [
    { x: 82, title: planned[0]?.title || "", color: palette.primary, items: planned[0]?.items || [] },
    { x: 676, title: planned[1]?.title || "", color: palette.accent, items: planned[1]?.items || [] },
  ];
  columns.forEach((column) => {
    if (column.title) addText(slide, column.title, { left: column.x, top: 226, width: 450, height: 44 }, { fontSize: 28, bold: true, color: column.color });
    addRule(slide, column.x, 282, 460, column.color, 5);
    column.items.forEach((item, itemIndex) => {
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
  const visible = slideDef.milestones || [];
  const y = 392;
  addRule(slide, 106, y, 1040, palette.rule, 4);
  visible.forEach((item, itemIndex) => {
    const x = 112 + itemIndex * (1040 / Math.max(visible.length - 1, 1));
    addRoundRect(slide, { left: x - 18, top: y - 18, width: 36, height: 36 }, itemIndex === 0 ? palette.primary : palette.paper, 12000, { width: 3, fill: itemIndex === 0 ? palette.primary : palette.primary });
    if (item.label) addText(slide, item.label, { left: x - 82, top: y + 42, width: 164, height: 36 }, { fontSize: 18, bold: true, color: palette.ink, align: "center" });
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
  // Only planned values are drawn: a missing value shows as a dash, never as a made-up bar.
  const data = slideDef.chart || { categories: [], series: [], max: 1 };
  const categories = data.categories;
  const series = data.series;
  const max = data.max || 1;
  const seriesColors = [palette.primary, palette.accent, palette.secondary, palette.muted];
  const chart = { left: 132, top: 248, width: 940, height: 330 };
  addRule(slide, chart.left, chart.top + chart.height, chart.width, palette.rule, 3);
  const slot = chart.width / Math.max(categories.length, 1);
  const barW = Math.max(14, Math.min(slot * 0.48, (slot * 0.84) / Math.max(series.length, 1)));
  categories.forEach((category, categoryIndex) => {
    const groupLeft = chart.left + categoryIndex * slot + (slot - barW * series.length) / 2;
    series.forEach((entry, seriesIndex) => {
      const value = entry.values[categoryIndex];
      const x = groupLeft + seriesIndex * barW;
      const color = series.length > 1 ? seriesColors[seriesIndex % seriesColors.length] : categoryIndex === 0 ? palette.primary : palette.accent;
      if (typeof value === "number") {
        const barH = Math.max(12, Math.abs(value) / max * (chart.height - 52));
        const y = chart.top + chart.height - barH;
        addRect(slide, { left: x, top: y, width: series.length > 1 ? barW - 4 : barW, height: barH }, color);
        addText(slide, formatChartValue(value), { left: x - 10, top: y - 32, width: barW + 20, height: 24 }, { fontSize: series.length > 1 ? 12 : 15, bold: true, color: palette.ink, align: "center" });
      } else {
        addText(slide, formatChartValue(value), { left: x - 10, top: chart.top + chart.height - 34, width: barW + 20, height: 24 }, { fontSize: 14, color: palette.muted, align: "center" });
      }
    });
    if (category) addText(slide, category, { left: chart.left + categoryIndex * slot + 4, top: chart.top + chart.height + 18, width: slot - 8, height: 42 }, { fontSize: 13, color: palette.body, align: "center" });
  });
  series.forEach((entry, seriesIndex) => {
    if (!entry.name) return;
    const x = 132 + seriesIndex * 230;
    if (series.length > 1) addRect(slide, { left: x, top: 655, width: 14, height: 14 }, seriesColors[seriesIndex % seriesColors.length]);
    addText(slide, entry.name, { left: series.length > 1 ? x + 22 : x, top: 648, width: 200, height: 28 }, { fontSize: 15, color: palette.muted });
  });
  addSlideNumber(slide, index);
  setSpeakerNotes(slide, slideDef.notes);
}

function renderTable(presentation, slideDef, index) {
  const slide = presentation.slides.add();
  slide.background.fill = palette.paper;
  addRect(slide, { left: 0, top: 0, width: WIDTH, height: HEIGHT }, palette.paper);
  addTitleBlock(slide, slideDef, false, 58, 940);
  const table = slideDef.table || { headers: [], rows: [] };
  const headers = table.headers;
  const rows = table.rows;
  const left = 82;
  const top = 228;
  const tableW = 1116;
  const rowH = 52;
  // Every column of every row is drawn, even when the header row is shorter.
  const columnCount = Math.max(headers.length, ...rows.map((row) => row.length), 1);
  const colW = tableW / columnCount;
  const headerH = headers.length > 0 ? rowH : 0;
  if (headers.length > 0) {
    addRect(slide, { left, top, width: tableW, height: rowH }, palette.secondary);
    headers.forEach((header, columnIndex) => {
      if (header) addText(slide, header, { left: left + columnIndex * colW + 16, top: top + 15, width: colW - 32, height: 24 }, { fontSize: 16, bold: true, color: palette.inverse });
    });
  }
  rows.forEach((row, rowIndex) => {
    const y = top + headerH + rowH * rowIndex;
    addRect(slide, { left, top: y, width: tableW, height: rowH }, rowIndex % 2 === 0 ? palette.bg : palette.paper, { width: 1, fill: palette.rule });
    row.forEach((cell, columnIndex) => {
      if (cell) addText(slide, cell, { left: left + columnIndex * colW + 16, top: y + 14, width: colW - 32, height: 28 }, { fontSize: 15, bold: columnIndex === 0, color: palette.body });
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
  const items = slideDef.bullets;
  const motif = slideDef.motif || 0;
  if (motif % 2 === 0) {
    items.forEach((item, itemIndex) => {
      const y = 228 + itemIndex * 78;
      addRule(slide, 86, y + 15, 42, itemIndex === 0 ? palette.primary : palette.accent, 5);
      addText(slide, item, { left: 152, top: y, width: 880, height: 54 }, { fontSize: itemIndex === 0 ? 25 : 21, bold: itemIndex === 0, color: palette.body });
    });
  } else {
    const leftItems = items.slice(0, Math.ceil(items.length / 2));
    const rightItems = items.slice(Math.ceil(items.length / 2));
    [
      { x: 86, items: leftItems },
      { x: 646, items: rightItems },
    ].forEach((column, columnIndex) => {
      column.items.forEach((item, itemIndex) => {
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
  if (slideDef.subtitle) addText(slide, slideDef.subtitle, { left: 100, top: 310, width: 660, height: 82 }, { fontSize: 24, color: "#FFFFFFC9" });
  slideDef.bullets.forEach((item, itemIndex) => {
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
const slides = Array.isArray(options.slides) ? options.slides : [];

for (let index = 0; index < slides.length; index += 1) {
  const slideDef = slides[index];
  const renderer = renderers[slideDef.type] || renderContent;
  await renderer(presentation, slideDef, index);
}

const pptx = await PresentationFile.exportPptx(presentation);
await fs.mkdir(path.dirname(outputPath), { recursive: true });
await pptx.save(outputPath);
if (warningsPath) await fs.writeFile(warningsPath, JSON.stringify(runtimeWarnings), "utf-8");
`;

async function generatePPTXWithPptxGenJs(
  outputPath: string,
  options: PptxOptions,
  slides: PlannedSlide[],
): Promise<string[]> {
  const PptxGenJS = (await import("pptxgenjs")).default;
  const pptx = new PptxGenJS();
  const warnings: string[] = [];

  const primaryColor = (options.theme?.primaryColor || "#2563eb").replace("#", "");
  const secondaryColor = (
    options.theme?.secondaryColor ||
    options.brand?.secondaryColor ||
    "#0f172a"
  ).replace("#", "");
  const accentColor = (
    options.theme?.accentColor ||
    options.brand?.accentColor ||
    "#f97316"
  ).replace("#", "");
  const fontFace = options.theme?.fontFace || "Helvetica Neue";
  const seriesColors = [primaryColor, accentColor, secondaryColor, "64748B"];

  if (options.title) pptx.title = options.title;
  if (options.author) pptx.author = options.author;
  if (options.subject) pptx.subject = options.subject;
  pptx.layout = "LAYOUT_WIDE";

  const addRect = (slide: Any, x: number, y: number, w: number, h: number, color: string): void => {
    slide.addShape(pptx.ShapeType.rect, {
      x,
      y,
      w,
      h,
      fill: { color },
      line: { color, transparency: 100 },
    });
  };

  const addHeader = (slide: Any, slideDef: PlannedSlide, index: number): void => {
    addRect(slide, 0.55, 0.45, 0.9, 0.06, primaryColor);
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
    if (slideDef.subtitle) {
      slide.addText(slideDef.subtitle, {
        x: 0.55,
        y: 1.38,
        w: 9.2,
        h: 0.4,
        fontSize: 14,
        fontFace,
        color: "475569",
        fit: "shrink",
      });
    }
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

  /** Draws every item it is given; the plan already sized the list to fit. */
  const addItems = (
    slide: Any,
    items: string[],
    x: number,
    w: number,
    stepOffset?: number,
  ): void => {
    items.forEach((item, itemIndex) => {
      const y = 2.08 + itemIndex * 0.68;
      if (stepOffset === undefined) {
        addRect(slide, x, y + 0.15, 0.34, 0.04, itemIndex === 0 ? primaryColor : accentColor);
      } else {
        slide.addText(String(stepOffset + itemIndex + 1).padStart(2, "0"), {
          x,
          y,
          w: 0.5,
          h: 0.45,
          fontSize: 12,
          fontFace,
          color: primaryColor,
          bold: true,
        });
      }
      slide.addText(item, {
        x: x + 0.55,
        y,
        w,
        h: 0.45,
        fontSize: itemIndex === 0 ? 17 : 14,
        fontFace,
        color: "334155",
        bold: itemIndex === 0,
        fit: "shrink",
      });
    });
  };

  const addSlideImage = (slide: Any, slideDef: PlannedSlide): void => {
    const asset = slideDef.image?.id
      ? options.assets?.find((candidate) => candidate?.id === slideDef.image?.id)
      : undefined;
    const imagePath = slideDef.image?.path || asset?.path;
    const imageUrl = slideDef.image?.url || asset?.url;
    if (imagePath) {
      const resolved = path.isAbsolute(imagePath)
        ? imagePath
        : path.resolve(path.dirname(outputPath), imagePath);
      if (fs.existsSync(resolved)) {
        slide.addImage({
          path: resolved,
          x: 7.1,
          y: 1.65,
          w: slideDef.image?.width || 4.9,
          h: slideDef.image?.height || 3.65,
        });
      } else {
        warnings.push(
          `Slide ${slideDef.source}: image file ${imagePath} was not found, so no picture was placed.`,
        );
      }
    } else if (imageUrl) {
      warnings.push(
        `Slide ${slideDef.source}: the remote image ${imageUrl} cannot be embedded without the ` +
          "artifact-tool runtime, so no picture was placed.",
      );
    }
  };

  for (let index = 0; index < slides.length; index += 1) {
    const slideDef = slides[index];
    const slide = pptx.addSlide();

    if (slideDef.type === "cover") {
      slide.background = { color: secondaryColor };
      addRect(slide, 0, 0, 4.7, 7.5, primaryColor);
      addRect(slide, 4.7, 0, 0.12, 7.5, accentColor);

      const title = slideDef.title || options.title;
      if (title) {
        slide.addText(title, {
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
    } else if (slideDef.type === "section") {
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
      addRect(slide, 0.82, 2.45, 1.85, 0.08, accentColor);
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
      if (slideDef.subtitle) {
        slide.addText(slideDef.subtitle, {
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
    } else if (slideDef.type === "table") {
      addHeader(slide, slideDef, index);
      const table = slideDef.table ?? { headers: [], rows: [] };
      // Every column of every row is kept, even when the header row is shorter.
      const columnCount = Math.max(table.headers.length, ...table.rows.map((row) => row.length), 1);
      const tableRows = [...(table.headers.length > 0 ? [table.headers] : []), ...table.rows].map(
        (row) => Array.from({ length: columnCount }, (_, column) => ({ text: row[column] ?? "" })),
      );
      if (tableRows.length > 0) {
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
      }
    } else if (slideDef.type === "chart") {
      addHeader(slide, slideDef, index);
      // Only planned values are drawn: a missing value shows as a dash, never as a made-up bar.
      const chart = slideDef.chart ?? { categories: [], series: [], max: 1 };
      const seriesCount = Math.max(chart.series.length, 1);
      const slot = 10.2 / Math.max(chart.categories.length, 1);
      const barW = Math.max(0.16, Math.min(slot * 0.5, (slot * 0.84) / seriesCount));
      chart.categories.forEach((category, categoryIndex) => {
        const groupLeft = 1.05 + categoryIndex * slot + (slot - barW * seriesCount) / 2;
        chart.series.forEach((series, seriesIndex) => {
          const value = series.values[categoryIndex];
          const x = groupLeft + seriesIndex * barW;
          const color =
            chart.series.length > 1
              ? seriesColors[seriesIndex % seriesColors.length]
              : categoryIndex === 0
                ? primaryColor
                : accentColor;
          if (value === null) {
            slide.addText(formatChartValue(value), {
              x: x - 0.1,
              y: 5.5,
              w: barW + 0.2,
              h: 0.22,
              fontSize: 9,
              align: "center",
              color: "64748B",
            });
            return;
          }
          const h = Math.max(0.18, (Math.abs(value) / chart.max) * 3.2);
          addRect(slide, x, 5.8 - h, chart.series.length > 1 ? barW - 0.04 : barW, h, color);
          slide.addText(formatChartValue(value), {
            x: x - 0.1,
            y: 5.48 - h,
            w: barW + 0.2,
            h: 0.22,
            fontSize: chart.series.length > 1 ? 8 : 10,
            bold: true,
            align: "center",
            color: "111827",
          });
        });
        if (category) {
          slide.addText(category, {
            x: 1.05 + categoryIndex * slot,
            y: 5.95,
            w: slot,
            h: 0.38,
            fontSize: 8,
            align: "center",
            color: "334155",
            fit: "shrink",
          });
        }
      });
      chart.series.forEach((series, seriesIndex) => {
        if (!series.name) return;
        const x = 1.05 + seriesIndex * 2.6;
        if (chart.series.length > 1) {
          addRect(slide, x, 6.55, 0.16, 0.16, seriesColors[seriesIndex % seriesColors.length]);
        }
        slide.addText(series.name, {
          x: chart.series.length > 1 ? x + 0.24 : x,
          y: 6.47,
          w: 2.3,
          h: 0.3,
          fontSize: 10,
          color: "64748B",
          fit: "shrink",
        });
      });
    } else if (slideDef.type === "metric") {
      addHeader(slide, slideDef, index);
      // A metric without a value is shown as text, never given a made-up number.
      const [hero, ...others] = slideDef.metrics;
      if (hero?.value) {
        slide.addText(hero.value, {
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
      }
      const heroLabel = [hero?.label, hero?.detail].filter(Boolean).join(" — ");
      if (heroLabel) {
        slide.addText(heroLabel, {
          x: 0.78,
          y: hero?.value ? 3.25 : 1.95,
          w: 6.1,
          h: 0.85,
          fontSize: 18,
          color: "334155",
          fit: "shrink",
        });
      }
      others.forEach((item, itemIndex) => {
        addRect(
          slide,
          7.1,
          1.85 + itemIndex * 1.1,
          3.2,
          0.05,
          itemIndex === 0 ? accentColor : "D7DEE8",
        );
        const label = [item.label, item.detail].filter(Boolean).join(" — ");
        slide.addText([item.value, label].filter(Boolean).join("  "), {
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
      addRect(slide, index % 2 === 0 ? 0 : 12.95, 0, 0.38, 7.5, primaryColor);
      addHeader(slide, slideDef, index);
      const withImage = slideDef.type === "image" || slideDef.type === "product";
      if (withImage) addSlideImage(slide, slideDef);

      const textX = withImage ? 0.72 : 0.9;
      const textW = withImage ? 5.7 : 10.8;
      if (slideDef.type === "quote") {
        if (slideDef.quote) {
          slide.addText(`“${slideDef.quote}”`, {
            x: 0.9,
            y: 2.0,
            w: 11.2,
            h: 2.6,
            fontSize: 28,
            fontFace,
            color: "111827",
            bold: true,
            fit: "shrink",
          });
        }
        if (slideDef.attribution) {
          slide.addText(slideDef.attribution, {
            x: 0.95,
            y: 4.8,
            w: 8,
            h: 0.5,
            fontSize: 16,
            fontFace,
            color: "475569",
            fit: "shrink",
          });
        }
      } else if (slideDef.type === "timeline") {
        slideDef.milestones.forEach((milestone, itemIndex) => {
          const y = 2.08 + itemIndex * 0.68;
          addRect(slide, textX, y + 0.15, 0.34, 0.04, itemIndex === 0 ? primaryColor : accentColor);
          if (milestone.label) {
            slide.addText(milestone.label, {
              x: textX + 0.55,
              y,
              w: 2.6,
              h: 0.45,
              fontSize: 15,
              fontFace,
              color: "111827",
              bold: true,
              fit: "shrink",
            });
          }
          if (milestone.detail) {
            slide.addText(milestone.detail, {
              x: textX + 3.3,
              y,
              w: 8,
              h: 0.45,
              fontSize: 14,
              fontFace,
              color: "334155",
              fit: "shrink",
            });
          }
        });
      } else if (slideDef.type === "comparison") {
        slideDef.columns.forEach((column, columnIndex) => {
          const x = columnIndex === 0 ? 0.9 : 6.9;
          if (column.title) {
            slide.addText(column.title, {
              x,
              y: 1.95,
              w: 5.4,
              h: 0.45,
              fontSize: 18,
              fontFace,
              color: columnIndex === 0 ? primaryColor : accentColor,
              bold: true,
              fit: "shrink",
            });
          }
          column.items.forEach((item, itemIndex) => {
            slide.addText(item, {
              x,
              y: 2.55 + itemIndex * 0.62,
              w: 5.4,
              h: 0.5,
              fontSize: 14,
              fontFace,
              color: "334155",
              fit: "shrink",
            });
          });
        });
      } else if (
        slideDef.type === "content" &&
        slideDef.bullets.length > SLIDE_CAPACITY.contentList
      ) {
        const half = Math.ceil(slideDef.bullets.length / 2);
        addItems(slide, slideDef.bullets.slice(0, half), 0.9, 5.0);
        addItems(slide, slideDef.bullets.slice(half), 6.9, 5.0);
      } else {
        addItems(
          slide,
          slideDef.bullets,
          textX,
          textW,
          slideDef.type === "process" ? slideDef.offset : undefined,
        );
      }
    }

    if (slideDef.notes) {
      slide.addNotes(slideDef.notes);
    }
  }

  await pptx.writeFile({ fileName: outputPath });
  return warnings;
}
