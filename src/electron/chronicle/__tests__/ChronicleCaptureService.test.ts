import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../computer-use/computer-use-permissions", () => ({
  checkAccessibilityTrusted: () => false,
  getMacScreenCaptureAccessStatus: () => "granted",
}));
vi.mock("../../ipc/image-viewer-ocr", () => ({
  isTesseractInstalled: async () => false,
  resolveImageOcrChars: (value: number) => value,
  runOcrFromImagePath: async () => null,
}));

import { ChronicleCaptureService } from "../ChronicleCaptureService";
import type { ChronicleBufferedFrame, ChronicleSettings } from "../types";

const BASE_SETTINGS: ChronicleSettings = {
  enabled: true,
  mode: "hybrid",
  paused: false,
  captureIntervalSeconds: 300,
  retentionMinutes: 5,
  maxFrames: 60,
  captureScope: "frontmost_display",
  backgroundGenerationEnabled: true,
  respectWorkspaceMemory: true,
  consentAcceptedAt: 1,
};

describe("ChronicleCaptureService privacy", () => {
  const tempDirs: string[] = [];
  const services: ChronicleCaptureService[] = [];

  afterEach(async () => {
    for (const service of services) await service.stop();
    services.length = 0;
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  function setup(now = Date.now()) {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-userdata-"));
    tempDirs.push(userData);
    const getSources = vi.fn(async () => []);
    const service = new ChronicleCaptureService({
      now: () => now,
      userDataDir: () => userData,
      isHeadless: () => false,
      getDesktopCapturer: () => ({ getSources }),
      getScreen: () => ({ getAllDisplays: () => [], getPrimaryDisplay: () => ({ id: 1 }) }),
      getScreenCaptureStatus: () => "granted",
      isAccessibilityTrusted: () => false,
      runOcr: async () => "quarterly report draft",
      detectFrontmostContext: async () => ({
        appName: "Editor",
        bundleId: "",
        windowTitle: "Report",
        sourceRef: null,
      }),
      isOcrAvailable: async () => false,
    } as never);
    services.push(service);
    const bufferDir = path.join(userData, "chronicle", "buffer");
    fs.mkdirSync(bufferDir, { recursive: true });
    const writeFrame = (id: string, capturedAt: number) => {
      fs.mkdirSync(bufferDir, { recursive: true });
      const imagePath = path.join(bufferDir, `${id}.png`);
      fs.writeFileSync(imagePath, "png");
      const frame: ChronicleBufferedFrame = {
        id,
        capturedAt,
        displayId: "1",
        appName: "Editor",
        windowTitle: "Quarterly report",
        imagePath,
        localTextSnippet: "quarterly report draft",
        width: 10,
        height: 10,
      };
      fs.writeFileSync(path.join(bufferDir, `${id}.json`), JSON.stringify(frame));
      return imagePath;
    };
    return { service, getSources, bufferDir, writeFrame, now };
  }

  it("returns nothing and takes no fallback capture while paused", async () => {
    const { service, getSources, writeFrame, now } = setup();
    await service.applySettings(BASE_SETTINGS);
    await service.stop();
    getSources.mockClear();
    writeFrame("frame-1", now);
    await service.applySettings({ ...BASE_SETTINGS, paused: true });
    // A frame that appears on disk while paused must still not be returned.
    writeFrame("frame-2", now);

    const results = await service.queryRecentContext({
      query: "quarterly report",
      useFallback: true,
    });
    expect(results).toEqual([]);
    expect(getSources).not.toHaveBeenCalled();
  });

  it("clears the raw buffer when paused", async () => {
    const { service, writeFrame, bufferDir, now } = setup();
    await service.applySettings(BASE_SETTINGS);
    await service.stop();
    const imagePath = writeFrame("frame-1", now);
    await service.applySettings({ ...BASE_SETTINGS, paused: true });
    expect(fs.existsSync(imagePath)).toBe(false);
    expect(fs.existsSync(bufferDir)).toBe(false);
  });

  it("returns nothing when disabled", async () => {
    const { service, writeFrame, now } = setup();
    writeFrame("frame-1", now);
    await service.applySettings({ ...BASE_SETTINGS, enabled: false });
    expect(await service.queryRecentContext({ query: "quarterly" })).toEqual([]);
  });

  it("applies the retention cutoff and prunes expired frames before querying", async () => {
    const now = Date.now();
    const { service, writeFrame } = setup(now);
    await service.applySettings(BASE_SETTINGS);
    await service.stop();
    const expired = writeFrame("old-frame", now - 10 * 60_000);
    writeFrame("new-frame", now - 30_000);

    const results = await service.queryRecentContext({ query: "quarterly report" });
    expect(results.map((result) => result.observationId)).toEqual(["new-frame"]);
    expect(fs.existsSync(expired)).toBe(false);
  });

  it("ignores buffered frames whose imagePath points outside the buffer", async () => {
    const now = Date.now();
    const { service, bufferDir } = setup(now);
    await service.applySettings(BASE_SETTINGS);
    await service.stop();
    const outside = path.join(os.tmpdir(), `chronicle-outside-${process.pid}-${now}.png`);
    fs.writeFileSync(outside, "keep");
    try {
      fs.writeFileSync(
        path.join(bufferDir, "evil.json"),
        JSON.stringify({ id: "evil", capturedAt: now - 20 * 60_000, imagePath: outside }),
      );
      expect(await service.queryRecentContext({ query: "quarterly" })).toEqual([]);
      expect(fs.existsSync(outside)).toBe(true);
    } finally {
      fs.rmSync(outside, { force: true });
    }
  });
});
