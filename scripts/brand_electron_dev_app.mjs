#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, utimesSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

const APP_DISPLAY_NAME = "CoWork OS";
const ICON_FILE = "cowork-os.icns";

function log(message) {
  process.stdout.write(`[brand-dev] ${message}\n`);
}

function fail(message) {
  process.stderr.write(`[brand-dev] ${message}\n`);
  process.exit(1);
}

if (process.platform !== "darwin") {
  log("Skipping on non-macOS platform.");
  process.exit(0);
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

let cursor = path.resolve(electronBinary);
let electronApp = null;
while (cursor !== path.dirname(cursor)) {
  if (cursor.endsWith(".app")) {
    electronApp = cursor;
    break;
  }
  cursor = path.dirname(cursor);
}

if (!electronApp) {
  fail(`Unable to locate Electron.app from ${electronBinary}`);
}

const contentsDir = path.join(electronApp, "Contents");
const plistPath = path.join(contentsDir, "Info.plist");
const resourcesDir = path.join(contentsDir, "Resources");
const sourceIcon = path.resolve("build/icon.icns");
const targetIcon = path.join(resourcesDir, ICON_FILE);

if (!existsSync(plistPath)) {
  fail(`Missing Info.plist at ${plistPath}`);
}
if (!existsSync(sourceIcon)) {
  fail(`Missing app icon at ${sourceIcon}`);
}

function setPlistValue(key, type, value) {
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

mkdirSync(resourcesDir, { recursive: true });
copyFileSync(sourceIcon, targetIcon);

setPlistValue("CFBundleDisplayName", "string", APP_DISPLAY_NAME);
setPlistValue("CFBundleIconFile", "string", ICON_FILE);
setPlistValue("LSApplicationCategoryType", "string", "public.app-category.productivity");

const now = new Date();
utimesSync(electronApp, now, now);
utimesSync(plistPath, now, now);

log(
  `Branded ${electronApp} display name/icon as ${APP_DISPLAY_NAME}; preserved bundle name and identifier for safeStorage.`,
);
