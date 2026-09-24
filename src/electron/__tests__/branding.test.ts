import { beforeEach, describe, expect, it, vi } from "vitest";

const appMocks = vi.hoisted(() => ({
  setName: vi.fn(),
  setAppUserModelId: vi.fn(),
}));

vi.mock("electron", () => ({
  app: {
    setName: appMocks.setName,
    setAppUserModelId: appMocks.setAppUserModelId,
  },
  nativeImage: { createFromPath: vi.fn() },
}));

import {
  APP_BUNDLE_ID,
  APP_DISPLAY_NAME,
  applyApplicationIdentity,
  getApplicationInternalName,
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
