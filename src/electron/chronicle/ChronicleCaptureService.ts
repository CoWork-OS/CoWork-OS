import * as crypto from "crypto";
import * as fs from "fs/promises";
import * as path from "path";
import { createLogger } from "../utils/logger";
import { getUserDataDir } from "../utils/user-data-dir";
import { isHeadlessMode } from "../utils/runtime-mode";
import {
  checkAccessibilityTrusted,
  getMacScreenCaptureAccessStatus,
} from "../computer-use/computer-use-permissions";
import {
  isTesseractInstalled,
  resolveImageOcrChars,
  runOcrFromImagePath,
} from "../ipc/image-viewer-ocr";
import { ChronicleMemoryService } from "./ChronicleMemoryService";
import { ChronicleSelector } from "./ChronicleSelector";
import { ChronicleSettingsManager, isChronicleExcludedApp } from "./ChronicleSettingsManager";
import { ChronicleSourceResolver, type ChronicleFrontmostContext } from "./ChronicleSourceResolver";
import type {
  ChronicleBufferedFrame,
  ChronicleCaptureStatus,
  ChronicleQueryOptions,
  ChronicleResolvedContext,
  ChronicleSettings,
  ChronicleTimelineFrame,
} from "./types";

type Any = any; // oxlint-disable-line typescript-eslint/no-explicit-any

type ChronicleCaptureDeps = {
  now: () => number;
  userDataDir: () => string;
  isHeadless: () => boolean;
  getDesktopCapturer: () => Any;
  getScreen: () => Any;
  getScreenCaptureStatus: () => ChronicleCaptureStatus["screenCaptureStatus"];
  isAccessibilityTrusted: () => boolean;
  runOcr: (imagePath: string, maxChars: number) => Promise<string | null>;
  detectFrontmostContext: () => Promise<ChronicleFrontmostContext>;
  isOcrAvailable: () => Promise<boolean>;
  /** A small JPEG data URL of an image file, for the timeline; null when it can't be read. */
  makeThumbnail: (imagePath: string) => Promise<string | null>;
};

/** Timeline thumbnails: wide enough to recognise a window, small enough to list dozens. */
const THUMBNAIL_WIDTH = 320;
const MAX_TIMELINE_FRAMES = 240;

const logger = createLogger("ChronicleCaptureService");
const OCR_CHARS = resolveImageOcrChars(600);

function defaultDeps(): ChronicleCaptureDeps {
  return {
    now: () => Date.now(),
    userDataDir: () => getUserDataDir(),
    isHeadless: () => isHeadlessMode(),
    getDesktopCapturer: () => {
      try {
        // oxlint-disable-next-line typescript-eslint/no-require-imports
        const electron = require("electron") as Any;
        return electron?.desktopCapturer;
      } catch {
        return null;
      }
    },
    getScreen: () => {
      try {
        // oxlint-disable-next-line typescript-eslint/no-require-imports
        const electron = require("electron") as Any;
        return electron?.screen;
      } catch {
        return null;
      }
    },
    getScreenCaptureStatus: () =>
      process.platform === "darwin" ? getMacScreenCaptureAccessStatus() : "unknown",
    isAccessibilityTrusted: () =>
      process.platform === "darwin" ? checkAccessibilityTrusted(false) : false,
    runOcr: (imagePath: string, maxChars: number) => runOcrFromImagePath(imagePath, maxChars),
    detectFrontmostContext: () => ChronicleSourceResolver.resolveFrontmostContext(),
    isOcrAvailable: () => isTesseractInstalled(),
    makeThumbnail: async (imagePath: string) => {
      try {
        // oxlint-disable-next-line typescript-eslint/no-require-imports
        const { nativeImage } = require("electron") as Any;
        const image = nativeImage?.createFromPath?.(imagePath);
        if (!image || image.isEmpty()) return null;
        const jpeg = image.resize({ width: THUMBNAIL_WIDTH }).toJPEG(70) as Buffer;
        return `data:image/jpeg;base64,${jpeg.toString("base64")}`;
      } catch {
        return null;
      }
    },
  };
}

async function fileExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath);
    return true;
  } catch {
    return false;
  }
}

async function fileSize(targetPath: string): Promise<number> {
  try {
    const stat = await fs.stat(targetPath);
    return stat.size;
  } catch {
    return 0;
  }
}

export class ChronicleCaptureService {
  private static instance: ChronicleCaptureService | null = null;
  private timer: NodeJS.Timeout | null = null;
  private settings = ChronicleSettingsManager.loadSettings();
  private lastCaptureAt: number | null = null;
  private lastSkippedForExclusionAt: number | null = null;

  constructor(private readonly deps: ChronicleCaptureDeps = defaultDeps()) {}

  static getInstance(): ChronicleCaptureService {
    if (!this.instance) {
      this.instance = new ChronicleCaptureService();
    }
    return this.instance;
  }

  async applySettings(next: ChronicleSettings): Promise<void> {
    this.settings = { ...next };
    if (!this.canRun()) {
      // Disabled, paused, consent withdrawn or unsupported: drop the raw
      // buffer so nothing captured before the stop stays queryable on disk.
      await this.stop({ clearRawBuffer: true });
      return;
    }
    this.start();
  }

  start(): void {
    if (!this.canRun()) return;
    void this.pruneBuffer().catch(() => undefined);
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.timer = setInterval(() => {
      void this.captureOnce().catch((error) => {
        logger.debug("Passive Chronicle capture failed:", error);
      });
    }, this.settings.captureIntervalSeconds * 1000);
    this.timer.unref?.();
    void this.captureOnce().catch((error) => {
      logger.debug("Initial Chronicle capture failed:", error);
    });
  }

  async stop(options: { clearRawBuffer?: boolean } = {}): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (options.clearRawBuffer) {
      await this.clearRawBuffer();
    }
  }

  canExposeTool(): boolean {
    return this.canRun() && this.deps.getScreenCaptureStatus() !== "denied";
  }

  async getStatus(): Promise<ChronicleCaptureStatus> {
    const frames = await this.loadFrames();
    const supported = this.isSupportedRuntime();
    const screenCaptureStatus = this.deps.getScreenCaptureStatus();
    const bufferBytes = (
      await Promise.all(frames.map((frame) => fileSize(frame.imagePath)))
    ).reduce((total, size) => total + size, 0);
    const consentRequired = !this.settings.consentAcceptedAt;
    const paused = this.settings.paused;
    const ocrAvailable = await this.deps.isOcrAvailable().catch(() => false);
    const accessibilityTrusted = this.deps.isAccessibilityTrusted();
    let reason: string | undefined;
    if (!supported) {
      reason = "Chronicle is desktop-only and unavailable in headless or channel runtimes.";
    } else if (consentRequired && this.settings.enabled) {
      reason = "Chronicle requires explicit consent before passive capture starts.";
    } else if (paused) {
      reason = "Chronicle is paused. Resume it to collect fresh screen context.";
    } else if (screenCaptureStatus === "denied") {
      reason = "Screen Recording permission is denied.";
    }
    return {
      supported,
      enabled: this.settings.enabled,
      active: Boolean(this.timer) && screenCaptureStatus !== "denied",
      mode: this.settings.mode,
      paused,
      captureIntervalSeconds: this.settings.captureIntervalSeconds,
      retentionMinutes: this.settings.retentionMinutes,
      maxFrames: this.settings.maxFrames,
      captureScope: this.settings.captureScope,
      frameCount: frames.length,
      bufferBytes,
      lastCaptureAt: this.lastCaptureAt,
      lastExclusionSkipAt: this.lastSkippedForExclusionAt,
      lastGeneratedAt: ChronicleMemoryService.getInstance().getLastGeneratedAt(),
      consentRequired,
      accessibilityTrusted,
      ocrAvailable,
      screenCaptureStatus,
      reason,
    };
  }

  async queryRecentContext(options: ChronicleQueryOptions): Promise<ChronicleResolvedContext[]> {
    if (!this.settings.enabled || this.settings.paused || !this.settings.consentAcceptedAt) {
      return [];
    }
    await this.pruneBuffer();
    const cutoff = this.retentionCutoff();
    const frames = (await this.loadFrames()).filter(
      (frame) =>
        frame.capturedAt >= cutoff && !isChronicleExcludedApp(this.settings, frame.bundleId),
    );
    const recent = frames
      .sort((a, b) => b.capturedAt - a.capturedAt)
      .slice(0, this.settings.maxFrames);
    const enriched = await this.enrichFramesForQuery(recent);
    const ranked = ChronicleSelector.rank(enriched, options.query, options.limit || 5);
    if (options.useFallback && ChronicleSelector.shouldFallback(ranked, options.query)) {
      const fallback = await this.captureFallbackFrame();
      if (fallback) {
        const fallbackRanked = ChronicleSelector.rank(
          [fallback, ...enriched],
          options.query,
          options.limit || 5,
        );
        if (fallbackRanked[0]) {
          fallbackRanked[0].usedFallback = true;
        }
        return fallbackRanked;
      }
    }
    return ranked;
  }

  /** The recent-screen buffer, newest first, with small thumbnails (Settings > Chronicle). */
  async listTimeline(limit = 60): Promise<ChronicleTimelineFrame[]> {
    await this.pruneBuffer();
    const frames = (await this.loadBufferFrames())
      .sort((a, b) => b.capturedAt - a.capturedAt)
      .slice(0, Math.max(1, Math.min(MAX_TIMELINE_FRAMES, Math.round(limit))));
    return Promise.all(
      frames.map(async (frame) => ({
        id: frame.id,
        capturedAt: frame.capturedAt,
        appName: frame.appName,
        ...(frame.bundleId ? { bundleId: frame.bundleId } : {}),
        windowTitle: frame.windowTitle,
        thumbnailDataUrl: await this.deps.makeThumbnail(frame.imagePath).catch(() => null),
      })),
    );
  }

  /**
   * Take a new excluded-apps list without restarting capture (applySettings would capture at
   * once, or clear the whole buffer while Chronicle is off or paused).
   */
  setExcludedApps(excludedApps: ChronicleSettings["excludedApps"]): void {
    this.settings = { ...this.settings, excludedApps: [...excludedApps] };
  }

  /** Delete one frame of the buffer. Returns whether it was there. */
  async deleteFrame(frameId: string): Promise<boolean> {
    const frame = (await this.loadFrames()).find((entry) => entry.id === frameId);
    if (!frame) return false;
    await this.removeFrameFiles(frame);
    return true;
  }

  /** Delete every buffered frame taken while this app was in front. Returns how many. */
  async deleteFramesForApp(bundleId: string): Promise<number> {
    const key = bundleId.toLowerCase();
    const frames = (await this.loadFrames()).filter(
      (frame) => frame.bundleId?.toLowerCase() === key,
    );
    await Promise.all(frames.map((frame) => this.removeFrameFiles(frame)));
    return frames.length;
  }

  /** Delete the whole recent-screen buffer; capture goes on as set. */
  async clearTimeline(): Promise<void> {
    await this.clearRawBuffer();
  }

  private async removeFrameFiles(frame: ChronicleBufferedFrame): Promise<void> {
    await Promise.all([
      fs.rm(frame.imagePath, { force: true }),
      fs.rm(this.metaPathForImage(frame.imagePath), { force: true }),
    ]);
  }

  async captureOnce(): Promise<ChronicleBufferedFrame | null> {
    if (!this.canRun()) return null;
    const frames = await this.captureFrames({ usedFallback: false });
    const frame = frames[0] || null;
    if (!frame) return null;
    this.lastCaptureAt = frame.capturedAt;
    await this.pruneBuffer();
    return frame;
  }

  private async captureFallbackFrame(): Promise<ChronicleBufferedFrame | null> {
    if (!this.canRun()) return null;
    const frames = await this.captureFrames({ usedFallback: true });
    return frames[0] || null;
  }

  private async captureFrames(options: {
    usedFallback: boolean;
  }): Promise<ChronicleBufferedFrame[]> {
    const desktopCapturer = this.deps.getDesktopCapturer();
    const electronScreen = this.deps.getScreen();
    if (!desktopCapturer || !electronScreen) return [];
    const status = this.deps.getScreenCaptureStatus();
    if (status === "denied") return [];

    // The app in front decides whether this capture may happen at all: nothing is taken, not
    // even an in-memory picture, while an excluded app is in front.
    const frontmostContext = await this.deps.detectFrontmostContext().catch(() => ({
      appName: "Desktop",
      bundleId: "",
      windowTitle: "Screen",
      sourceRef: { kind: "app" as const, value: "Desktop", label: "Desktop" },
    }));
    if (isChronicleExcludedApp(this.settings, frontmostContext.bundleId)) {
      this.lastSkippedForExclusionAt = this.deps.now();
      return [];
    }

    const targetDisplays = this.resolveTargetDisplays(electronScreen);
    const largestDisplay = targetDisplays.reduce<Any | null>((best, display) => {
      if (!display) return best;
      if (!best) return display;
      const displayArea = (display.size?.width || 0) * (display.size?.height || 0);
      const bestArea = (best.size?.width || 0) * (best.size?.height || 0);
      return displayArea > bestArea ? display : best;
    }, null);
    const scaleFactor = largestDisplay?.scaleFactor ?? 2;
    const size = largestDisplay?.size ?? { width: 1440, height: 900 };
    const captureWidth = Math.min(size.width * scaleFactor, 2200);
    const captureHeight = Math.min(size.height * scaleFactor, 2200);
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: { width: captureWidth, height: captureHeight },
    });
    if (!Array.isArray(sources) || sources.length === 0) {
      return [];
    }

    const displayIds = new Set(targetDisplays.map((display: Any) => String(display?.id || "")));
    const filteredSources =
      this.settings.captureScope === "all_displays"
        ? sources.filter((entry: Any) => displayIds.has(String(entry.display_id || "")))
        : sources
            .filter((entry: Any) => displayIds.has(String(entry.display_id || "")))
            .slice(0, 1);
    const selectedSources = filteredSources.length > 0 ? filteredSources : [sources[0]];

    const frames = await Promise.all(
      selectedSources.map(async (source: Any) => {
        if (!source?.thumbnail || source.thumbnail.isEmpty()) {
          return null;
        }
        const frameId = crypto.randomUUID();
        const bufferDir = options.usedFallback ? "fallback" : "buffer";
        const dir = path.join(this.getChronicleRoot(), bufferDir);
        await fs.mkdir(dir, { recursive: true });
        const imagePath = path.join(dir, `${frameId}.png`);
        const png = source.thumbnail.toPNG();
        await fs.writeFile(imagePath, png, { mode: 0o600 });
        const meta: ChronicleBufferedFrame = {
          id: frameId,
          capturedAt: this.deps.now(),
          displayId: String(source.display_id || targetDisplays[0]?.id || "primary"),
          appName: frontmostContext.appName || "Desktop",
          ...(frontmostContext.bundleId ? { bundleId: frontmostContext.bundleId } : {}),
          windowTitle: frontmostContext.windowTitle || String(source.name || "Screen"),
          imagePath,
          sourceRef: frontmostContext.sourceRef || null,
          width: source.thumbnail.getSize().width,
          height: source.thumbnail.getSize().height,
        };
        await fs.writeFile(
          this.metaPathForImage(imagePath),
          `${JSON.stringify(meta, null, 2)}\n`,
          "utf8",
        );
        return meta;
      }),
    );
    return frames.filter((frame): frame is ChronicleBufferedFrame => frame !== null);
  }

  private async enrichFramesForQuery(
    frames: ChronicleBufferedFrame[],
  ): Promise<ChronicleBufferedFrame[]> {
    const topCandidates = frames.slice(0, 6);
    const enriched = await Promise.all(
      topCandidates.map(async (frame) => {
        if (frame.localTextSnippet !== undefined) return frame;
        const ocr = await this.deps.runOcr(frame.imagePath, OCR_CHARS).catch(() => null);
        const next: ChronicleBufferedFrame = {
          ...frame,
          localTextSnippet: ocr || "",
        };
        try {
          await fs.writeFile(
            this.metaPathForImage(frame.imagePath),
            `${JSON.stringify(next, null, 2)}\n`,
            "utf8",
          );
        } catch {
          // best-effort cache
        }
        return next;
      }),
    );
    const byId = new Map(enriched.map((frame) => [frame.id, frame]));
    return frames.map((frame) => byId.get(frame.id) || frame);
  }

  /** Passive frames only (not the ones taken on demand for a query). */
  private async loadBufferFrames(): Promise<ChronicleBufferedFrame[]> {
    return this.loadFrames([path.join(this.getChronicleRoot(), "buffer")]);
  }

  private async loadFrames(
    dirs: string[] = [
      path.join(this.getChronicleRoot(), "buffer"),
      path.join(this.getChronicleRoot(), "fallback"),
    ],
  ): Promise<ChronicleBufferedFrame[]> {
    const frames: ChronicleBufferedFrame[] = [];
    for (const dir of dirs) {
      try {
        const entries = await fs.readdir(dir);
        for (const entry of entries) {
          if (!entry.endsWith(".json")) continue;
          try {
            const raw = await fs.readFile(path.join(dir, entry), "utf8");
            const frame = JSON.parse(raw) as ChronicleBufferedFrame;
            // Only trust image paths that live in this buffer directory; the
            // path is later read (OCR, promotion) and deleted (pruning).
            if (
              typeof frame?.imagePath !== "string" ||
              typeof frame.capturedAt !== "number" ||
              path.dirname(path.resolve(frame.imagePath)) !== path.resolve(dir)
            ) {
              continue;
            }
            if (await fileExists(frame.imagePath)) {
              frames.push(frame);
            }
          } catch {
            // ignore corrupt frame
          }
        }
      } catch {
        // directory missing is fine
      }
    }
    return frames;
  }

  private retentionCutoff(): number {
    return this.deps.now() - this.settings.retentionMinutes * 60_000;
  }

  private async pruneBuffer(): Promise<void> {
    const cutoff = this.retentionCutoff();
    const frames = await this.loadFrames();
    const sorted = [...frames].sort((a, b) => b.capturedAt - a.capturedAt);
    const keepIds = new Set(
      sorted
        .filter((frame, index) => frame.capturedAt >= cutoff && index < this.settings.maxFrames)
        .map((frame) => frame.id),
    );
    await Promise.all(
      sorted
        .filter((frame) => !keepIds.has(frame.id))
        .flatMap((frame) => [
          fs.rm(frame.imagePath, { force: true }),
          fs.rm(this.metaPathForImage(frame.imagePath), { force: true }),
        ]),
    ).catch(() => {
      // best-effort pruning
    });
  }

  private async clearRawBuffer(): Promise<void> {
    await Promise.all(
      ["buffer", "fallback"].map((dir) =>
        fs.rm(path.join(this.getChronicleRoot(), dir), { recursive: true, force: true }),
      ),
    ).catch(() => {
      // best-effort cleanup
    });
  }

  private resolveTargetDisplays(electronScreen: Any): Any[] {
    const allDisplays = Array.isArray(electronScreen?.getAllDisplays?.())
      ? electronScreen.getAllDisplays()
      : [];
    if (this.settings.captureScope === "all_displays" && allDisplays.length > 0) {
      return allDisplays;
    }
    const cursorPoint = electronScreen?.getCursorScreenPoint?.();
    const nearest = cursorPoint ? electronScreen?.getDisplayNearestPoint?.(cursorPoint) : null;
    return [nearest || electronScreen?.getPrimaryDisplay?.()].filter(Boolean);
  }

  private metaPathForImage(imagePath: string): string {
    return imagePath.replace(/\.[^.]+$/, ".json");
  }

  private getChronicleRoot(): string {
    return path.join(this.deps.userDataDir(), "chronicle");
  }

  private canRun(): boolean {
    return (
      this.settings.enabled &&
      !this.settings.paused &&
      Boolean(this.settings.consentAcceptedAt) &&
      this.isSupportedRuntime()
    );
  }

  private isSupportedRuntime(): boolean {
    return Boolean(
      !this.deps.isHeadless() && this.deps.getDesktopCapturer() && this.deps.getScreen(),
    );
  }
}
