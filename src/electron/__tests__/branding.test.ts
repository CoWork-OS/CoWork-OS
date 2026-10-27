import fs from "fs";
import path from "path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const appMocks = vi.hoisted(() => ({
  setName: vi.fn(),
  setAppUserModelId: vi.fn(),
  createFromPath: vi.fn(),
  createEmpty: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    setName: appMocks.setName,
    setAppUserModelId: appMocks.setAppUserModelId,
    getAppPath: () => process.cwd(),
  },
  nativeImage: { createFromPath: appMocks.createFromPath, createEmpty: appMocks.createEmpty },
}));

import {
  APP_BUNDLE_ID,
  APP_DISPLAY_NAME,
  applyApplicationIdentity,
  getApplicationInternalName,
  getTrayIconImage,
} from "../branding";

describe("applyApplicationIdentity", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("uses the packaged product name in development for shared macOS safeStorage", () => {
    applyApplicationIdentity();

    expect(appMocks.setName).toHaveBeenCalledWith(APP_DISPLAY_NAME);
  });

  it("uses the legacy macOS Keychain name only in the isolated migration worker", () => {
    expect(
      getApplicationInternalName(["electron", ".", "--cowork-safe-storage-migration-worker"]),
    ).toBe("cowork-os");
    expect(
      getApplicationInternalName([
        "electron",
        ".",
        "--cowork-safe-storage-migration-worker",
        "Electron",
      ]),
    ).toBe("Electron");
    expect(getApplicationInternalName(["electron", "."])).toBe(APP_DISPLAY_NAME);
  });

  it("keeps the Windows app user model id aligned with the product bundle id", () => {
    if (process.platform !== "win32") return;

    applyApplicationIdentity();

    expect(appMocks.setAppUserModelId).toHaveBeenCalledWith(APP_BUNDLE_ID);
  });
});

function pngSize(file: string): { width: number; height: number } {
  const header = fs.readFileSync(file);
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
}

describe("getTrayIconImage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("ships the leopard menu bar template at 1x and 2x", () => {
    const dir = path.join(process.cwd(), "assets", "tray");
    expect(pngSize(path.join(dir, "trayTemplate.png"))).toEqual({ width: 18, height: 18 });
    expect(pngSize(path.join(dir, "trayTemplate@2x.png"))).toEqual({ width: 36, height: 36 });
  });

  it("uses the leopard template image on macOS", () => {
    const template = { isEmpty: () => false, setTemplateImage: vi.fn() };
    appMocks.createFromPath.mockReturnValue(template);

    expect(getTrayIconImage("darwin")).toBe(template);
    expect(appMocks.createFromPath).toHaveBeenCalledWith(
      path.join(process.cwd(), "assets", "tray", "trayTemplate.png"),
    );
    expect(template.setTemplateImage).toHaveBeenCalledWith(true);
  });

  it("uses the color app icon at tray size on Windows", () => {
    const appIcon = {
      isEmpty: () => false,
      resize: vi.fn(({ width }: { width: number }) => ({
        toPNG: () => Buffer.from(`png-${width}`),
      })),
    };
    const tray = { addRepresentation: vi.fn() };
    appMocks.createFromPath.mockReturnValue(appIcon);
    appMocks.createEmpty.mockReturnValue(tray);

    expect(getTrayIconImage("win32")).toBe(tray);
    expect(appMocks.createFromPath.mock.calls[0]?.[0]).not.toContain("trayTemplate");
    expect(tray.addRepresentation.mock.calls.map(([rep]) => rep.scaleFactor)).toEqual([1, 2]);
    expect(appIcon.resize.mock.calls.map(([size]) => size.width)).toEqual([16, 32]);
  });
});
