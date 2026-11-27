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
import {
  DEFAULT_CHRONICLE_EXCLUDED_APPS,
  isChronicleExcludedApp,
  normalizeExcludedApps,
} from "../ChronicleSettingsManager";
import type { ChronicleBufferedFrame, ChronicleSettings } from "../types";

const SETTINGS: ChronicleSettings = {
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
  excludedApps: [{ bundleId: "com.1password.1password", name: "1Password" }],
};

describe("excluded apps settings", () => {
  it("defaults to password managers, keeps an emptied list, and drops bad entries", () => {
    expect(normalizeExcludedApps(undefined)).toEqual(DEFAULT_CHRONICLE_EXCLUDED_APPS);
    expect(normalizeExcludedApps([])).toEqual([]);
    expect(
      normalizeExcludedApps([
        { bundleId: "com.apple.Notes", name: "Notes\u0007" },
        { bundleId: "COM.APPLE.NOTES", name: "dupe" },
        { bundleId: "../etc", name: "bad" },
        "nope",
      ]),
    ).toEqual([{ bundleId: "com.apple.Notes", name: "Notes" }]);
  });

  it("matches bundle ids without regard to case", () => {
    expect(isChronicleExcludedApp(SETTINGS, "COM.1PASSWORD.1PASSWORD")).toBe(true);
    expect(isChronicleExcludedApp(SETTINGS, "com.apple.Notes")).toBe(false);
    expect(isChronicleExcludedApp(SETTINGS, "")).toBe(false);
  });
});

describe("ChronicleCaptureService with excluded apps", () => {
  const tempDirs: string[] = [];
  const services: ChronicleCaptureService[] = [];

  afterEach(async () => {
    for (const service of services) await service.stop();
    services.length = 0;
    for (const dir of tempDirs) fs.rmSync(dir, { recursive: true, force: true });
    tempDirs.length = 0;
  });

  function setup(front: { appName: string; bundleId: string }) {
    const userData = fs.mkdtempSync(path.join(os.tmpdir(), "chronicle-exclusions-"));
    tempDirs.push(userData);
    let now = 1_000_000;
    const thumbnail = {
      isEmpty: () => false,
      toPNG: () => Buffer.from("png-bytes"),
      getSize: () => ({ width: 100, height: 60 }),
    };
    const getSources = vi.fn(async () => [{ display_id: "1", name: "Screen", thumbnail }]);
    const context = { ...front, windowTitle: `${front.appName} window`, sourceRef: null };
    const service = new ChronicleCaptureService({
      now: () => now,
      userDataDir: () => userData,
      isHeadless: () => false,
      getDesktopCapturer: () => ({ getSources }),
      getScreen: () => ({
        getAllDisplays: () => [{ id: 1, size: { width: 100, height: 60 }, scaleFactor: 1 }],
        getPrimaryDisplay: () => ({ id: 1, size: { width: 100, height: 60 }, scaleFactor: 1 }),
      }),
      getScreenCaptureStatus: () => "granted",
      isAccessibilityTrusted: () => false,
      runOcr: async () => null,
      detectFrontmostContext: async () => context,
      isOcrAvailable: async () => false,
      makeThumbnail: async (imagePath: string) => `thumb:${path.basename(imagePath)}`,
    } as never);
    services.push(service);
    const bufferDir = path.join(userData, "chronicle", "buffer");
    const writeFrame = (id: string, capturedAt: number, bundleId?: string, dir = bufferDir) => {
      fs.mkdirSync(dir, { recursive: true });
      const imagePath = path.join(dir, `${id}.png`);
      fs.writeFileSync(imagePath, "png");
      const frame: ChronicleBufferedFrame = {
        id,
        capturedAt,
        displayId: "1",
        appName: bundleId ? "App" : "Desktop",
        ...(bundleId ? { bundleId } : {}),
        windowTitle: "Report",
        imagePath,
        localTextSnippet: "quarterly report",
        width: 10,
        height: 10,
      };
      fs.writeFileSync(path.join(dir, `${id}.json`), JSON.stringify(frame));
    };
    return {
      service,
      getSources,
      bufferDir,
      writeFrame,
      setNow: (value: number) => (now = value),
      userData,
    };
  }

  it("takes no picture while an excluded app is in front, and says when it skipped", async () => {
    const { service, getSources, bufferDir } = setup({
      appName: "1Password",
      bundleId: "com.1password.1password",
    });
    await service.applySettings(SETTINGS);
    expect(await service.captureOnce()).toBeNull();
    expect(getSources).not.toHaveBeenCalled();
    expect(fs.existsSync(bufferDir) ? fs.readdirSync(bufferDir) : []).toEqual([]);
    expect((await service.getStatus()).lastExclusionSkipAt).toBe(1_000_000);
  });

  it("applies a new exclusion to the next capture without restarting or clearing", async () => {
    const { service, getSources, writeFrame } = setup({
      appName: "Notes",
      bundleId: "com.apple.Notes",
    });
    await service.applySettings({ ...SETTINGS, enabled: false });
    writeFrame("a1111111-1111-1111-1111-111111111111", 999_000, "com.apple.Mail");
    service.setExcludedApps([{ bundleId: "com.apple.Notes", name: "Notes" }]);
    expect((await service.listTimeline(10)).map((frame) => frame.bundleId)).toEqual([
      "com.apple.Mail",
    ]);
    await service.applySettings({
      ...SETTINGS,
      excludedApps: [{ bundleId: "com.apple.Notes", name: "Notes" }],
    });
    getSources.mockClear();
    expect(await service.captureOnce()).toBeNull();
    expect(getSources).not.toHaveBeenCalled();
  });

  it("keeps the app's bundle id on frames it takes", async () => {
    const { service } = setup({ appName: "Notes", bundleId: "com.apple.Notes" });
    await service.applySettings(SETTINGS);
    const frame = await service.captureOnce();
    expect(frame).toMatchObject({ appName: "Notes", bundleId: "com.apple.Notes" });
  });

  it("lists the buffer newest first with thumbnails, without on-demand frames", async () => {
    const { service, writeFrame, userData } = setup({ appName: "Notes", bundleId: "x.y" });
    await service.applySettings({ ...SETTINGS, enabled: false });
    writeFrame("a1111111-1111-1111-1111-111111111111", 999_000, "com.apple.Notes");
    writeFrame("b2222222-2222-2222-2222-222222222222", 999_500);
    writeFrame(
      "c3333333-3333-3333-3333-333333333333",
      999_900,
      "com.apple.Notes",
      path.join(userData, "chronicle", "fallback"),
    );
    const timeline = await service.listTimeline(10);
    expect(timeline.map((frame) => [frame.id.slice(0, 1), frame.thumbnailDataUrl])).toEqual([
      ["b", "thumb:b2222222-2222-2222-2222-222222222222.png"],
      ["a", "thumb:a1111111-1111-1111-1111-111111111111.png"],
    ]);
    expect(timeline[1].bundleId).toBe("com.apple.Notes");
  });

  it("deletes one frame, or every frame of an app", async () => {
    const { service, writeFrame, bufferDir } = setup({ appName: "Notes", bundleId: "x.y" });
    await service.applySettings({ ...SETTINGS, enabled: false });
    writeFrame("a1111111-1111-1111-1111-111111111111", 999_000, "com.apple.Notes");
    writeFrame("b2222222-2222-2222-2222-222222222222", 999_100, "COM.APPLE.NOTES");
    writeFrame("c3333333-3333-3333-3333-333333333333", 999_200, "com.apple.Mail");
    expect(await service.deleteFrame("c3333333-3333-3333-3333-333333333333")).toBe(true);
    expect(await service.deleteFrame("c3333333-3333-3333-3333-333333333333")).toBe(false);
    expect(await service.deleteFramesForApp("com.apple.notes")).toBe(2);
    expect(fs.readdirSync(bufferDir)).toEqual([]);
  });

  it("never gives a task context from a frame of an excluded app", async () => {
    const { service, writeFrame } = setup({ appName: "Notes", bundleId: "com.apple.Notes" });
    writeFrame("a1111111-1111-1111-1111-111111111111", 999_000, "com.1password.1password");
    writeFrame("b2222222-2222-2222-2222-222222222222", 999_100, "com.apple.Notes");
    await service.applySettings({ ...SETTINGS, captureIntervalSeconds: 300 });
    await service.stop();
    const results = await service.queryRecentContext({ query: "quarterly report", limit: 5 });
    expect(results.map((result) => result.observationId ?? (result as Any).id)).not.toContain(
      "a1111111-1111-1111-1111-111111111111",
    );
    expect(results.length).toBeGreaterThan(0);
  });
});
