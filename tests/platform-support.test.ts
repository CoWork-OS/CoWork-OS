import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  getUpdatePlatformCompatibility,
  PLATFORM_SUPPORT,
} from "../src/shared/platform-support";
import packageJson from "../package.json";

const require = createRequire(import.meta.url);
const launcherSupport = require("../scripts/platform-support.cjs") as {
  getLauncherPlatformCompatibility: (options: {
    platform: string;
    release: string;
    targetVersion: string;
  }) => { supported: boolean; message?: string };
};

describe("platform support policy", () => {
  it("records Ventura and Darwin 22 as the Electron 44 floors", () => {
    expect(PLATFORM_SUPPORT.macos.minimumProductVersion).toBe("13.0");
    expect(PLATFORM_SUPPORT.macos.minimumDarwinVersion).toBe("22.0.0");
    expect(PLATFORM_SUPPORT.macos.lastMontereyCompatibleVersion).toBe("0.5.51");
    expect(packageJson.dependencies.electron).toBe("44.0.0");
    expect(packageJson.dependencies["@electron/rebuild"]).toBe("4.2.0");
    expect(packageJson.build.mac.minimumSystemVersion).toBe("13.0");
    expect(packageJson.build.dmg.title).toContain("macOS 13+");
  });

  it("compares release versions without treating a v prefix or hyphen as significant", () => {
    expect(compareVersions("v0.5.52", "0.5.51")).toBe(1);
    expect(compareVersions("0.5.51", "0.5.51.0")).toBe(0);
    expect(compareVersions("0.5.51-1", "0.5.51")).toBe(1);
  });

  it("blocks post-0.5.51 updates on Monterey with recovery guidance", () => {
    expect(
      getUpdatePlatformCompatibility({
        platform: "darwin",
        release: "21.6.0",
        targetVersion: "0.5.52",
      }),
    ).toMatchObject({
      supported: false,
      minimumSystemLabel: "macOS 13 Ventura",
      lastCompatibleVersion: "0.5.51",
      recoveryCommand: "npm install -g cowork-os@0.5.51",
    });
  });

  it("allows Ventura, non-macOS systems, and the last Monterey-compatible release", () => {
    expect(
      getUpdatePlatformCompatibility({
        platform: "darwin",
        release: "22.0.0",
        targetVersion: "0.5.52",
      }).supported,
    ).toBe(true);
    expect(
      getUpdatePlatformCompatibility({
        platform: "win32",
        release: "10.0.0",
        targetVersion: "0.5.52",
      }).supported,
    ).toBe(true);
    expect(
      getUpdatePlatformCompatibility({
        platform: "darwin",
        release: "21.6.0",
        targetVersion: "0.5.51",
      }).supported,
    ).toBe(true);
  });

  it("uses the same block and rollback copy in the npm GUI launcher", () => {
    const result = launcherSupport.getLauncherPlatformCompatibility({
      platform: "darwin",
      release: "21.6.0",
      targetVersion: "0.5.52",
    });
    expect(result.supported).toBe(false);
    expect(result.message).toContain("macOS 13 Ventura");
    expect(result.message).toContain("npm install -g cowork-os@0.5.51");
    expect(result.message).toContain("data will not be removed");
  });
});
