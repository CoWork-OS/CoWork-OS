import * as fs from "fs/promises";
import * as path from "path";
import { createHash } from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { resolveCodexArtifactToolRuntime } from "./codex-artifact-tool-runtime";
import { getUserDataDir } from "./user-data-dir";
import {
  extractPptxStructuredContentFromFile,
  type PptxExtractedSlide,
  type PptxStructuredExtract,
} from "./pptx-extractor";

const execFileAsync = promisify(execFile);
const DEFAULT_RENDER_TIMEOUT_MS = 45_000;
const DEFAULT_MAX_RENDERED_SLIDES = 80;

export type PptxPreviewRenderMode = "fast" | "full";
export type PptxPreviewRenderStatus = "cached" | "rendering" | "rendered" | "text_only" | "failed";

export interface PptxPreviewSlide {
  index: number;
  title?: string;
  text: string;
  notes?: string;
  imageUrl?: string;
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
  options: { timeout: number; maxBuffer?: number; cwd?: string },
) => Promise<unknown>;

type ArtifactToolRunner = (
  input: {
    sourcePath: string;
    outputDir: string;
    maxSlides: number;
  },
  options: { timeout: number },
) => Promise<void>;

interface PptxPreviewServiceOptions {
  cacheRoot?: string;
  commandRunner?: CommandRunner;
  artifactToolRunner?: ArtifactToolRunner | null;
  renderTimeoutMs?: number;
  maxRenderedSlides?: number;
  imageUrlFactory?: (imagePath: string) => string | Promise<string>;
}

interface CachedRenderManifest {
  sourcePath: string;
  sourceSize: number;
  sourceMtimeMs: number;
  renderer?: "artifact_tool" | "libreoffice";
  imageFiles: Array<{ index: number; fileName: string }>;
}

type PreviewImage = {
  imageUrl?: string;
  imageDataUrl?: string;
};

export class PptxPreviewService {
  private readonly cacheRoot: string;
  private readonly commandRunner: CommandRunner;
  private readonly artifactToolRunner: ArtifactToolRunner | null;
  private readonly renderTimeoutMs: number;
  private readonly maxRenderedSlides: number;
  private readonly imageUrlFactory?: (imagePath: string) => string | Promise<string>;
  private readonly inFlightRenders = new Map<
    string,
    Promise<{ images: Map<number, PreviewImage>; message?: string }>
  >();

  constructor(options: PptxPreviewServiceOptions = {}) {
    this.cacheRoot = options.cacheRoot ?? path.join(getUserDataDir(), "cache", "pptx-previews");
    this.commandRunner =
      options.commandRunner ??
      ((command, args, execOptions) => execFileAsync(command, args, execOptions));
    this.artifactToolRunner =
      options.artifactToolRunner === undefined
        ? (input, runnerOptions) =>
            runArtifactToolPptxRenderer(this.commandRunner, input, runnerOptions)
        : options.artifactToolRunner;
    this.renderTimeoutMs = options.renderTimeoutMs ?? DEFAULT_RENDER_TIMEOUT_MS;
    this.maxRenderedSlides = options.maxRenderedSlides ?? DEFAULT_MAX_RENDERED_SLIDES;
    this.imageUrlFactory = options.imageUrlFactory;
  }

  async buildPreview(input: {
    filePath: string;
    workspaceRoot?: string;
    renderMode?: PptxPreviewRenderMode;
  }): Promise<PptxPresentationPreview> {
    const resolvedPath = await fs.realpath(path.resolve(input.filePath));
    if (input.workspaceRoot) {
      const resolvedWorkspaceRoot = await fs.realpath(path.resolve(input.workspaceRoot));
      if (!isPathInside(resolvedPath, resolvedWorkspaceRoot)) {
        throw new Error("Access denied: PPTX preview path is outside the workspace");
      }
    }

    const stats = await fs.stat(resolvedPath);
    const cacheDir = this.getCacheDir(resolvedPath, stats);
    const cachedImages = await this.readCachedImages(cacheDir, resolvedPath, stats);
    let structured = await this.extractStructuredContent(resolvedPath, cachedImages.size);
    if (cachedImages.size > 0) {
      return this.toPreview(
        structured,
        cachedImages,
        input.renderMode === "fast" ? "cached" : "rendered",
      );
    }

    if (input.renderMode === "fast") {
      return this.toPreview(structured, new Map(), "rendering", "Rendering slide previews...");
    }

    const renderResult = await this.renderSlideImages(resolvedPath, stats, cacheDir);
    if (structured.slideCount <= 1 && !structured.slides.some((slide) => slide.text.trim())) {
      structured = await this.extractStructuredContent(resolvedPath, renderResult.images.size);
    }
    return this.toPreview(
      structured,
      renderResult.images,
      renderResult.images.size > 0 ? "rendered" : "text_only",
      renderResult.message,
    );
  }

  private async extractStructuredContent(
    resolvedPath: string,
    renderedSlideCount: number,
  ): Promise<PptxStructuredExtract> {
    try {
      return await extractPptxStructuredContentFromFile(resolvedPath);
    } catch {
      const slideCount = Math.max(1, renderedSlideCount);
      return {
        slideCount,
        processedSlideCount: slideCount,
        title: path.basename(resolvedPath),
        slides: Array.from({ length: slideCount }, (_, index) => ({
          index: index + 1,
          text: "",
        })),
        metadata: [],
        truncationNotices: [],
      };
    }
  }

  private toPreview(
    structured: PptxStructuredExtract,
    images: Map<number, PreviewImage>,
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
        imageUrl: images.get(slide.index)?.imageUrl,
        imageDataUrl: images.get(slide.index)?.imageDataUrl,
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
  ): Promise<Map<number, PreviewImage>> {
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

      const images = new Map<number, PreviewImage>();
      for (const image of manifest.imageFiles) {
        if (!Number.isFinite(image.index) || !image.fileName) continue;
        const imagePath = path.join(cacheDir, image.fileName);
        const previewImage = await this.readPreviewImage(imagePath);
        if (previewImage) images.set(image.index, previewImage);
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
  ): Promise<{ images: Map<number, PreviewImage>; message?: string }> {
    const cacheKey = this.getCacheDir(resolvedPath, stats);
    const inFlight = this.inFlightRenders.get(cacheKey);
    if (inFlight) return inFlight;

    const renderPromise = this.renderSlideImagesUncached(resolvedPath, stats, cacheDir).finally(
      () => {
        this.inFlightRenders.delete(cacheKey);
      },
    );
    this.inFlightRenders.set(cacheKey, renderPromise);
    return renderPromise;
  }

  private async renderSlideImagesUncached(
    resolvedPath: string,
    stats: { size: number; mtimeMs: number },
    cacheDir: string,
  ): Promise<{ images: Map<number, PreviewImage>; message?: string }> {
    const artifactResult = await this.renderSlideImagesWithArtifactTool(
      resolvedPath,
      stats,
      cacheDir,
    );
    if (artifactResult.images.size > 0) {
      return artifactResult;
    }

    const libreOfficeResult = await this.renderSlideImagesWithLibreOffice(
      resolvedPath,
      stats,
      cacheDir,
    );
    if (libreOfficeResult.images.size > 0 || !artifactResult.message) {
      return libreOfficeResult;
    }

    return {
      images: new Map(),
      message: libreOfficeResult.message
        ? `${artifactResult.message} ${libreOfficeResult.message}`
        : artifactResult.message,
    };
  }

  private async renderSlideImagesWithArtifactTool(
    resolvedPath: string,
    stats: { size: number; mtimeMs: number },
    cacheDir: string,
  ): Promise<{ images: Map<number, PreviewImage>; message?: string }> {
    if (!this.artifactToolRunner) {
      return {
        images: new Map(),
        message: "Codex presentation renderer is disabled.",
      };
    }

    try {
      await fs.mkdir(this.cacheRoot, { recursive: true });
      await fs.mkdir(cacheDir, { recursive: true });

      await this.artifactToolRunner(
        {
          sourcePath: resolvedPath,
          outputDir: cacheDir,
          maxSlides: this.maxRenderedSlides,
        },
        { timeout: this.renderTimeoutMs },
      );

      const imageFiles = await listRenderedSlideFiles(cacheDir, this.maxRenderedSlides);
      if (imageFiles.length === 0) {
        return {
          images: new Map(),
          message: "Codex presentation renderer did not produce slide images.",
        };
      }

      await this.writeRenderManifest(cacheDir, resolvedPath, stats, imageFiles, "artifact_tool");
      return {
        images: await this.readRenderedImages(imageFiles),
      };
    } catch (error) {
      return {
        images: new Map(),
        message:
          error instanceof Error
            ? `Codex presentation renderer failed: ${error.message}`
            : "Codex presentation renderer failed.",
      };
    }
  }

  private async renderSlideImagesWithLibreOffice(
    resolvedPath: string,
    stats: { size: number; mtimeMs: number },
    cacheDir: string,
  ): Promise<{ images: Map<number, PreviewImage>; message?: string }> {
    let tempDir: string | undefined;
    try {
      await fs.mkdir(this.cacheRoot, { recursive: true });
      tempDir = await fs.mkdtemp(path.join(this.cacheRoot, "convert-"));
      await fs.mkdir(cacheDir, { recursive: true });

      await this.commandRunner(
        "soffice",
        ["--headless", "--convert-to", "pdf", "--outdir", tempDir, resolvedPath],
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
        ["-png", "-scale-to-x", "1280", "-scale-to-y", "-1", pdfPath, outputPrefix],
        { timeout: this.renderTimeoutMs, maxBuffer: 8 * 1024 * 1024 },
      );

      const imageFiles = await listRenderedSlideFiles(cacheDir, this.maxRenderedSlides);
      await this.writeRenderManifest(cacheDir, resolvedPath, stats, imageFiles, "libreoffice");
      return {
        images: await this.readRenderedImages(imageFiles),
      };
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

  private async writeRenderManifest(
    cacheDir: string,
    resolvedPath: string,
    stats: { size: number; mtimeMs: number },
    imageFiles: Array<{ index: number; path: string }>,
    renderer: CachedRenderManifest["renderer"],
  ): Promise<void> {
    const manifest: CachedRenderManifest = {
      sourcePath: resolvedPath,
      sourceSize: stats.size,
      sourceMtimeMs: stats.mtimeMs,
      renderer,
      imageFiles: imageFiles.map((image) => ({
        index: image.index,
        fileName: path.basename(image.path),
      })),
    };
    await fs.writeFile(path.join(cacheDir, "manifest.json"), JSON.stringify(manifest), "utf-8");
  }

  private async readRenderedImages(
    imageFiles: Array<{ index: number; path: string }>,
  ): Promise<Map<number, PreviewImage>> {
    const images = new Map<number, PreviewImage>();
    for (const image of imageFiles) {
      const previewImage = await this.readPreviewImage(image.path);
      if (previewImage) images.set(image.index, previewImage);
    }
    return images;
  }

  private async readPreviewImage(imagePath: string): Promise<PreviewImage | null> {
    if (this.imageUrlFactory) {
      try {
        const imageUrl = await this.imageUrlFactory(imagePath);
        if (imageUrl) return { imageUrl };
      } catch {
        // Fall through to a data URL when tokenized preview URLs are unavailable.
      }
    }

    const imageDataUrl = await readPngDataUrl(imagePath);
    return imageDataUrl ? { imageDataUrl } : null;
  }
}

async function runArtifactToolPptxRenderer(
  commandRunner: CommandRunner,
  input: {
    sourcePath: string;
    outputDir: string;
    maxSlides: number;
  },
  options: { timeout: number },
): Promise<void> {
  const runtime = await resolveCodexArtifactToolRuntime();
  if (!runtime) {
    throw new Error("bundled @oai/artifact-tool runtime is not available");
  }

  const script = `
const fs = await import("node:fs/promises");
const path = await import("node:path");
const { FileBlob, PresentationFile } = await import("@oai/artifact-tool");

const sourcePath = ${JSON.stringify(input.sourcePath)};
const outputDir = ${JSON.stringify(input.outputDir)};
const maxSlides = ${JSON.stringify(input.maxSlides)};

await fs.mkdir(outputDir, { recursive: true });
const pptx = await FileBlob.load(sourcePath);
const presentation = await PresentationFile.importPptx(pptx);
const slideCount = Math.min(Number(presentation.slides.count || 0), maxSlides);

for (let index = 0; index < slideCount; index += 1) {
  const slide = presentation.slides.getItem(index);
  const png = await presentation.export({ slide, format: "png", scale: 1 });
  const bytes = Buffer.from(await png.arrayBuffer());
  await fs.writeFile(path.join(outputDir, \`slide-\${index + 1}.png\`), bytes);
}
`;

  await commandRunner(runtime.nodeBinary, ["--input-type=module", "--eval", script], {
    timeout: options.timeout,
    maxBuffer: 8 * 1024 * 1024,
    cwd: runtime.nodeRoot,
  });
}

function isPathInside(targetPath: string, rootPath: string): boolean {
  const normalizedRoot = path.resolve(rootPath);
  const relative = path.relative(normalizedRoot, targetPath);
  return (
    relative === "" || (!!relative && !relative.startsWith("..") && !path.isAbsolute(relative))
  );
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
