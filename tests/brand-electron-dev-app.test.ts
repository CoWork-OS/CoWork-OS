import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  brandElectronApp,
  DEFAULT_DEV_BUNDLE_ID,
  resolveDevBundleId,
} from "../scripts/brand_electron_dev_app.mjs";

describe("brand_electron_dev_app", () => {
  it("gives the dev Electron.app its own bundle id instead of com.github.Electron", () => {
    expect(resolveDevBundleId({})).toBe(DEFAULT_DEV_BUNDLE_ID);
    expect(DEFAULT_DEV_BUNDLE_ID).toBe("com.cowork-os.app.dev");
  });

  it("lets COWORK_DEV_BUNDLE_ID choose another identifier", () => {
    expect(resolveDevBundleId({ COWORK_DEV_BUNDLE_ID: " com.example.cowork " })).toBe(
      "com.example.cowork",
    );
  });

  it("rejects values that are not bundle identifiers", () => {
    expect(() => resolveDevBundleId({ COWORK_DEV_BUNDLE_ID: "bad id; rm -rf" })).toThrow(
      /not a bundle identifier/,
    );
    expect(() => resolveDevBundleId({ COWORK_DEV_BUNDLE_ID: "nodots" })).toThrow();
  });
});

describe.runIf(process.platform === "darwin")("brandElectronApp", () => {
  function makeStockApp() {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-brand-"));
    const app = path.join(root, "Electron.app");
    fs.mkdirSync(path.join(app, "Contents", "Resources"), { recursive: true });
    fs.writeFileSync(
      path.join(app, "Contents", "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>com.github.Electron</string>
<key>CFBundleIconFile</key><string>electron.icns</string>
</dict></plist>`,
    );
    const icon = path.join(root, "icon.icns");
    fs.writeFileSync(icon, "cowork-icon");
    return { app, icon };
  }

  function plistValue(app: string, key: string) {
    return execFileSync("/usr/libexec/PlistBuddy", [
      "-c",
      `Print :${key}`,
      path.join(app, "Contents", "Info.plist"),
    ])
      .toString()
      .trim();
  }

  it("replaces the stock Electron icon and identifier, then reports no change on a rerun", () => {
    const { app, icon } = makeStockApp();

    expect(brandElectronApp({ electronApp: app, iconPath: icon, env: {} }).changed).toBe(true);
    expect(plistValue(app, "CFBundleIconFile")).toBe("cowork-os.icns");
    expect(plistValue(app, "CFBundleIdentifier")).toBe(DEFAULT_DEV_BUNDLE_ID);
    expect(plistValue(app, "CFBundleDisplayName")).toBe("CoWork OS");
    expect(fs.readFileSync(path.join(app, "Contents", "Resources", "cowork-os.icns"), "utf8")).toBe(
      "cowork-icon",
    );

    expect(brandElectronApp({ electronApp: app, iconPath: icon, env: {} }).changed).toBe(false);
  });

  it("copies the icon again when build/icon.icns changes", () => {
    const { app, icon } = makeStockApp();
    brandElectronApp({ electronApp: app, iconPath: icon, env: {} });
    fs.writeFileSync(icon, "new-cowork-icon");

    expect(brandElectronApp({ electronApp: app, iconPath: icon, env: {} }).changed).toBe(true);
    expect(fs.readFileSync(path.join(app, "Contents", "Resources", "cowork-os.icns"), "utf8")).toBe(
      "new-cowork-icon",
    );
  });
});
