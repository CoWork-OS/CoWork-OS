import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { getUserDataDir } from "./user-data-dir";
import {
  extractPptxStructuredContentFromFile,
  type PptxExtractedSlide,
  type PptxStructuredExtract,
} from "./pptx-extractor";

const execFileAsync = promisify(execFile);
const DEFAULT_RENDER_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RENDERED_SLIDES = 80;

export type PptxPreviewRenderStatus = "rendered" | "text_only" | "failed";

export interface PptxPreviewSlide {
  index: number;
  title?: string;
  text: string;
  notes?: string;
  imageDataUrl?: string;
}

export interface PptxPresentationPreview {
  slideCount: number;
  title?: string;
  slides: PptxPreviewSlide[];
  renderStatus: PptxPreviewRenderStatus;
  renderMessage?: string;
}

type CommandRunner = (
  command: string,
  args: string[],
  options: { timeout: number; maxBuffer?: number },
) => Promise<unknown>;

interface PptxPreviewServiceOptions {
  cacheRoot?: string;
  commandRunner?: CommandRunner;
  renderTimeoutMs?: number;
  maxRenderedSlides?: number;
}

interface CachedRenderManifest {
  sourcePath: string;
  sourceSize: number;
  sourceMtimeMs: number;
  imageFiles: Array<{ index: number; fileName: string }>;
}

export class PptxPreviewService {
  private readonly cacheRoot: string;
  private readonly commandRunner: CommandRunner;
  private readonly renderTimeoutMs: number;
  private readonly maxRenderedSlides: number;

  constructor(options: PptxPreviewServiceOptions = {}) {
    this.cacheRoot =
      options.cacheRoot ?? path.join(getUserDataDir(), "cache", "pptx-previews");
    this.commandRunner =
      options.commandRunner ??
      ((command, args, execOptions) =>
        execFileAsync(command, args, execOptions));
    this.renderTimeoutMs = options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
    this.maxRenderedSlides =
      options.maxRenderedSlides ?? DEFAULT_MAX_RENDERED_SLIDES;
  }

  async buildPreview(input: {
    filePath: string;
    workspaceRoot?: string;
  }): Promise<PptxPresentationPreview> {
    const resolvedPath = path.resolve(input.filePath);
    if (input.workspaceRoot && !isPathInside(resolvedPath, input.workspaceRoot)) {
      throw new Error("Access denied: PPTX preview path is outside the workspace");
    }

    const stats = await fs.stat(resolvedPath);
    const structured = await extractPptxStructuredContentFromFile(resolvedPath);
    const cacheDir = this.getCacheDir(resolvedPath, stats);
    const cachedImages = await this.readCachedImages(cacheDir, resolvedPath, stats);
    if (cachedImages.size > 0) {
      return this.toPreview(structured, cachedImages, "rendered");
    }

    const renderResult = await this.renderSlideImages(resolvedPath, stats, cacheDir);
    return this.toPreview(
      structured,
      renderResult.images,
      renderResult.images.size > 0 ? "rendered" : "text_only",
      renderResult.message,
    );
  }

  private toPreview(
    structured: PptxStructuredExtract,
    images: Map<number, string>,
    renderStatus: PptxPreviewRenderStatus,
    renderMessage?: string,
  ): PptxPresentationPreview {
    const slides: PptxExtractedSlide[] =
      structured.slides.length > 0
        ? structured.slides
        : Array.from({ length: structured.slideCount }, (_, index) => ({
            index: index + 1,
            text: "",
          }));

    return {
      slideCount: structured.slideCount,
      title: structured.title,
      slides: slides.map((slide) => ({
        index: slide.index,
        title: slide.title,
        text: slide.text,
        notes: slide.notes,
        imageDataUrl: images.get(slide.index),
      })),
      renderStatus,
      renderMessage,
    };
  }

  private getCacheDir(resolvedPath: string, stats: { size: number; mtimeMs: number }): string {
    const key = createHash("sha256")
      .update(`${resolvedPath}\n${stats.size}\n${Math.floor(stats.mtimeMs)}`)
      .digest("hex")
      .slice(0, 24);
    return path.join(this.cacheRoot, key);
  }

  private async readCachedImages(
    cacheDir: string,
    resolvedPath: string,
    stats: { size: number; mtimeMs: number },
  ): Promise<Map<number, string>> {
    try {
      const manifestRaw = await fs.readFile(path.join(cacheDir, "manifest.json"), "utf-8");
      const manifest = JSON.parse(manifestRaw) as CachedRenderManifest;
      if (
        manifest.sourcePath !== resolvedPath ||
        manifest.sourceSize !== stats.size ||
        Math.floor(manifest.sourceMtimeMs) !== Math.floor(stats.mtimeMs)
      ) {
        return new Map();
      }

      const images = new Map<number, string>();
      for (const image of manifest.imageFiles) {
        if (!Number.isFinite(image.index) || !image.fileName) continue;
        const imagePath = path.join(cacheDir, image.fileName);
        const dataUrl = await readPngDataUrl(imagePath);
        if (dataUrl) images.set(image.index, dataUrl);
      }
      return images;
    } catch {
      return new Map();
    }
  }

  private async renderSlideImages(
    resolvedPath: string,
    stats: { size: number; mtimeMs: number },
    cacheDir: string,
  ): Promise<{ images: Map<number, string>; message?: string }> {
    let tempDir: string | undefined;
    try {
      await fs.mkdir(this.cacheRoot, { recursive: true });
      tempDir = await fs.mkdtemp(path.join(this.cacheRoot, "convert-"));
      await fs.mkdir(cacheDir, { recursive: true });

      await this.commandRunner(
        "soffice",
        [
          "--headless",
          "--convert-to",
          "pdf",
          "--outdir",
          tempDir,
          resolvedPath,
        ],
        { timeout: this.renderTimeoutMs, maxBuffer: 8 * 1024 * 1024 },
      );

      const pdfPath = await findConvertedPdf(tempDir, resolvedPath);
      if (!pdfPath) {
        return {
          images: new Map(),
          message: "LibreOffice did not produce a PDF preview.",
        };
      }

      const outputPrefix = path.join(cacheDir, "slide");
      await this.commandRunner(
        "pdftoppm",
        [
          "-png",
          "-scale-to-x",
          "1280",
          "-scale-to-y",
          "-1",
          pdfPath,
          outputPrefix,
        ],
        { timeout: this.renderTimeoutMs, maxBuffer: 8 * 1024 * 1024 },
      );

      const imageFiles = await listRenderedSlideFiles(cacheDir, this.maxRenderedSlides);
      const manifest: CachedRenderManifest = {
        sourcePath: resolvedPath,
        sourceSize: stats.size,
        sourceMtimeMs: stats.mtimeMs,
        imageFiles: imageFiles.map((image) => ({
          index: image.index,
          fileName: path.basename(image.path),
        })),
      };
      await fs.writeFile(path.join(cacheDir, "manifest.json"), JSON.stringify(manifest), "utf-8");

      const images = new Map<number, string>();
      for (const image of imageFiles) {
        const dataUrl = await readPngDataUrl(image.path);
        if (dataUrl) images.set(image.index, dataUrl);
      }
      return { images };
    } catch (error) {
      return {
        images: new Map(),
        message:
          error instanceof Error
            ? error.message
            : "Presentation image preview could not be rendered.",
      };
    } finally {
      if (tempDir) {
        await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {
          // Best-effort cleanup.
        });
      }
    }
  }
}

function isPathInside(targetPath: string, rootPath: string): boolean {
  const normalizedRoot = path.resolve(rootPath);
  const relative = path.relative(normalizedRoot, targetPath);
  return relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative));
}

async function findConvertedPdf(tempDir: string, sourcePath: string): Promise<string | null> {
  const expected = path.join(tempDir, `${path.basename(sourcePath, path.extname(sourcePath))}.pdf`);
  try {
    await fs.access(expected);
    return expected;
  } catch {
    const entries = await fs.readdir(tempDir);
    const pdf = entries.find((entry) => entry.toLowerCase().endsWith(".pdf"));
    return pdf ? path.join(tempDir, pdf) : null;
  }
}

async function listRenderedSlideFiles(
  cacheDir: string,
  maxRenderedSlides: number,
): Promise<Array<{ index: number; path: string }>> {
  const entries = await fs.readdir(cacheDir);
  return entries
    .map((entry) => {
      const match = entry.match(/^slide-(\d+)\.png$/i) || entry.match(/^slide\.png$/i);
      if (!match) return null;
      return {
        index: match[1] ? Number(match[1]) : 1,
        path: path.join(cacheDir, entry),
      };
    })
    .filter((entry): entry is { index: number; path: string } => !!entry && entry.index > 0)
    .sort((a, b) => a.index - b.index)
    .slice(0, maxRenderedSlides);
}

async function readPngDataUrl(imagePath: string): Promise<string | null> {
  try {
    const bytes = await fs.readFile(imagePath);
    return `data:image/png;base64,${bytes.toString("base64")}`;
  } catch {
    return null;
  }
}
