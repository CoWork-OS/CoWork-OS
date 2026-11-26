#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, utimesSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const APP_DISPLAY_NAME = "CoWork OS";
const ICON_FILE = "cowork-os.icns";
const LSREGISTER =
  "/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister";

/**
 * The stock com.github.Electron identifier is shared by every Electron app built from
 * node_modules, and macOS 26 can block the menu bar icon for that whole identifier, so
 * dev runs get their own. Set COWORK_DEV_BUNDLE_ID to use another one.
 */
export const DEFAULT_DEV_BUNDLE_ID = "com.cowork-os.app.dev";

const BUNDLE_ID_PATTERN = /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)+$/;

export function resolveDevBundleId(env = process.env) {
  const requested = String(env.COWORK_DEV_BUNDLE_ID || "").trim();
  if (!requested) return DEFAULT_DEV_BUNDLE_ID;
  if (!BUNDLE_ID_PATTERN.test(requested)) {
    throw new Error(`COWORK_DEV_BUNDLE_ID is not a bundle identifier: ${requested}`);
  }
  return requested;
}

function log(message) {
  process.stdout.write(`[brand-dev] ${message}\n`);
}

function readPlistValue(plistPath, key) {
  const result = spawnSync("/usr/libexec/PlistBuddy", ["-c", `Print :${key}`, plistPath], {
    encoding: "utf8",
  });
  return (result.status ?? 1) === 0 ? String(result.stdout || "").trim() : null;
}

function setPlistValue(plistPath, key, type, value) {
  const setResult = spawnSync(
    "/usr/libexec/PlistBuddy",
    ["-c", `Set :${key} ${value}`, plistPath],
    {
      encoding: "utf8",
    },
  );
  if ((setResult.status ?? 1) === 0) {
    return;
  }

  execFileSync("/usr/libexec/PlistBuddy", ["-c", `Add :${key} ${type} ${value}`, plistPath], {
    stdio: "pipe",
  });
}

function sameFileContents(a, b) {
  return existsSync(a) && existsSync(b) && readFileSync(a).equals(readFileSync(b));
}

/**
 * Gives node_modules' Electron.app the CoWork OS name, icon and bundle id. macOS takes the
 * notification and Dock icon from the bundle, so an unbranded Electron.app shows the Electron
 * logo on every CoWork notification. Returns whether anything changed; a change breaks the
 * bundle's code signature, so callers must sign again afterwards.
 */
export function brandElectronApp({ electronApp, iconPath, env = process.env }) {
  const bundleId = resolveDevBundleId(env);
  const contentsDir = path.join(electronApp, "Contents");
  const plistPath = path.join(contentsDir, "Info.plist");
  const resourcesDir = path.join(contentsDir, "Resources");
  const targetIcon = path.join(resourcesDir, ICON_FILE);

  if (!existsSync(plistPath)) {
    throw new Error(`Missing Info.plist at ${plistPath}`);
  }
  if (!existsSync(iconPath)) {
    throw new Error(`Missing app icon at ${iconPath}`);
  }

  const wanted = [
    ["CFBundleDisplayName", "string", APP_DISPLAY_NAME],
    ["CFBundleIconFile", "string", ICON_FILE],
    ["LSApplicationCategoryType", "string", "public.app-category.productivity"],
    // The Keychain service comes from the app name CoWork sets at startup, not from the
    // identifier, so safeStorage keeps the "CoWork OS Safe Storage" item. macOS asks once
    // to let the new identifier read it (choose Always Allow).
    ["CFBundleIdentifier", "string", bundleId],
  ];
  const staleKeys = wanted.filter(([key, , value]) => readPlistValue(plistPath, key) !== value);
  const iconCurrent = sameFileContents(iconPath, targetIcon);
  if (staleKeys.length === 0 && iconCurrent) {
    return { changed: false, bundleId };
  }

  if (!iconCurrent) {
    mkdirSync(resourcesDir, { recursive: true });
    copyFileSync(iconPath, targetIcon);
  }
  for (const [key, type, value] of staleKeys) {
    setPlistValue(plistPath, key, type, value);
  }

  const now = new Date();
  utimesSync(electronApp, now, now);
  utimesSync(plistPath, now, now);
  return { changed: true, bundleId };
}

/** Re-registers the bundle so Launch Services drops the cached Electron icon. */
export function refreshLaunchServices(electronApp) {
  spawnSync(LSREGISTER, ["-f", electronApp], { stdio: "ignore", timeout: 30_000 });
}

export function resolveElectronAppFromBinary(electronBinary) {
  let cursor = path.resolve(electronBinary);
  while (cursor !== path.dirname(cursor)) {
    if (cursor.endsWith(".app")) {
      return cursor;
    }
    cursor = path.dirname(cursor);
  }
  return null;
}

function fail(message) {
  process.stderr.write(`[brand-dev] ${message}\n`);
  process.exit(1);
}

function main(env = process.env) {
  if (process.platform !== "darwin") {
    log("Skipping on non-macOS platform.");
    return;
  }

  const requireFromCwd = createRequire(path.join(process.cwd(), "package.json"));
  let electronBinary;
  try {
    electronBinary = requireFromCwd("electron");
  } catch (error) {
    fail(`Unable to resolve Electron: ${error instanceof Error ? error.message : String(error)}`);
  }

  if (typeof electronBinary !== "string" || !electronBinary) {
    fail("Electron did not resolve to a binary path.");
  }

  const electronApp = resolveElectronAppFromBinary(electronBinary);
  if (!electronApp) {
    fail(`Unable to locate Electron.app from ${electronBinary}`);
  }

  let result;
  try {
    result = brandElectronApp({ electronApp, iconPath: path.resolve("build/icon.icns"), env });
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  if (!result.changed) {
    log(`${electronApp} is already branded as ${APP_DISPLAY_NAME} (${result.bundleId}).`);
    return;
  }
  refreshLaunchServices(electronApp);
  log(
    `Branded ${electronApp} display name/icon as ${APP_DISPLAY_NAME} with bundle id ${result.bundleId}; kept the bundle name for safeStorage.`,
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}
