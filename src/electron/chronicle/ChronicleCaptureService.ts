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
import { ChronicleSettingsManager } from "./ChronicleSettingsManager";
import { ChronicleSourceResolver, type ChronicleFrontmostContext } from "./ChronicleSourceResolver";
import type {
  ChronicleBufferedFrame,
  ChronicleCaptureStatus,
  ChronicleQueryOptions,
  ChronicleResolvedContext,
  ChronicleSettings,
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
};

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

  constructor(private readonly deps: ChronicleCaptureDeps = defaultDeps()) {}

  static getInstance(): ChronicleCaptureService {
    if (!this.instance) {
      this.instance = new ChronicleCaptureService();
    }
    return this.instance;
  }

  async applySettings(next: ChronicleSettings): Promise<void> {
    const previous = this.settings;
    this.settings = { ...next };
    const shouldClearBuffer =
      previous.enabled &&
      (!next.enabled || !next.consentAcceptedAt || this.deps.getScreenCaptureStatus() === "denied");
    if (!this.canRun()) {
      await this.stop({ clearRawBuffer: shouldClearBuffer });
      return;
    }
    this.start();
  }

  start(): void {
    if (!this.canRun()) return;
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
      lastGeneratedAt: ChronicleMemoryService.getInstance().getLastGeneratedAt(),
      consentRequired,
      accessibilityTrusted,
      ocrAvailable,
      screenCaptureStatus,
      reason,
    };
  }

  async queryRecentContext(options: ChronicleQueryOptions): Promise<ChronicleResolvedContext[]> {
    if (!this.settings.enabled || !this.settings.consentAcceptedAt) {
      return [];
    }
    const frames = await this.loadFrames();
    const recent = frames.sort((a, b) => b.capturedAt - a.capturedAt).slice(0, this.settings.maxFrames);
    const enriched = await this.enrichFramesForQuery(recent);
    const ranked = ChronicleSelector.rank(enriched, options.query, options.limit || 5);
    if (options.useFallback && ChronicleSelector.shouldFallback(ranked, options.query)) {
      const fallback = await this.captureFallbackFrame();
      if (fallback) {
        const fallbackRanked = ChronicleSelector.rank([fallback, ...enriched], options.query, options.limit || 5);
        if (fallbackRanked[0]) {
          fallbackRanked[0].usedFallback = true;
        }
        return fallbackRanked;
      }
    }
    return ranked;
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
    const frames = await this.captureFrames({ usedFallback: true });
    return frames[0] || null;
  }

  private async captureFrames(options: { usedFallback: boolean }): Promise<ChronicleBufferedFrame[]> {
    const desktopCapturer = this.deps.getDesktopCapturer();
    const electronScreen = this.deps.getScreen();
    if (!desktopCapturer || !electronScreen) return [];
    const status = this.deps.getScreenCaptureStatus();
    if (status === "denied") return [];

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
        : sources.filter((entry: Any) => displayIds.has(String(entry.display_id || ""))).slice(0, 1);
    const selectedSources = filteredSources.length > 0 ? filteredSources : [sources[0]];
    const frontmostContext = await this.deps.detectFrontmostContext().catch(() => ({
      appName: "Desktop",
      bundleId: "",
      windowTitle: "Screen",
      sourceRef: { kind: "app" as const, value: "Desktop", label: "Desktop" },
    }));

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
          windowTitle: frontmostContext.windowTitle || String(source.name || "Screen"),
          imagePath,
          sourceRef: frontmostContext.sourceRef || null,
          width: source.thumbnail.getSize().width,
          height: source.thumbnail.getSize().height,
        };
        await fs.writeFile(this.metaPathForImage(imagePath), `${JSON.stringify(meta, null, 2)}\n`, "utf8");
        return meta;
      }),
    );
    return frames.filter((frame): frame is ChronicleBufferedFrame => frame !== null);
  }

  private async enrichFramesForQuery(frames: ChronicleBufferedFrame[]): Promise<ChronicleBufferedFrame[]> {
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
          await fs.writeFile(this.metaPathForImage(frame.imagePath), `${JSON.stringify(next, null, 2)}\n`, "utf8");
        } catch {
          // best-effort cache
        }
        return next;
      }),
    );
    const byId = new Map(enriched.map((frame) => [frame.id, frame]));
    return frames.map((frame) => byId.get(frame.id) || frame);
  }

  private async loadFrames(): Promise<ChronicleBufferedFrame[]> {
    const dirs = [path.join(this.getChronicleRoot(), "buffer"), path.join(this.getChronicleRoot(), "fallback")];
    const frames: ChronicleBufferedFrame[] = [];
    for (const dir of dirs) {
      try {
        const entries = await fs.readdir(dir);
        for (const entry of entries) {
          if (!entry.endsWith(".json")) continue;
          try {
            const raw = await fs.readFile(path.join(dir, entry), "utf8");
            const frame = JSON.parse(raw) as ChronicleBufferedFrame;
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

  private async pruneBuffer(): Promise<void> {
    const cutoff = this.deps.now() - this.settings.retentionMinutes * 60_000;
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
