#!/usr/bin/env node
/**
 * Runs `npm run build` then `electron-builder --mac` after loading optional
 * `.env.mac` from the repo root (gitignored).
 *
 * By default this creates the unsigned DMG/ZIP used for public fallback builds.
 * It disables certificate auto-discovery so a local personal Developer ID is not
 * picked up accidentally. To produce a signed + notarized build, configure
 * CSC_NAME or CSC_LINK in `.env.mac`.
 *
 * Copy `scripts/mac-notarize.env.example` → `.env.mac` and fill in secrets.
 *
 * Signing: install "Developer ID Application" in Keychain; optionally set
 * CSC_NAME to the exact certificate name.
 *
 * Notarization (pick one):
 *   - APPLE_ID + APPLE_APP_SPECIFIC_PASSWORD + APPLE_TEAM_ID
 *   - APPLE_API_KEY (path to .p8) + APPLE_API_KEY_ID + APPLE_API_ISSUER
 *   - APPLE_KEYCHAIN_PROFILE (+ optional APPLE_KEYCHAIN)
 */

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const ENV_MAC = path.join(ROOT, ".env.mac");

function log(msg) {
  process.stdout.write(`[package:mac] ${msg}\n`);
}

function isTrueEnv(value) {
  return ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}

function hasExplicitSigningIdentity() {
  return Boolean(process.env.CSC_NAME || process.env.CSC_LINK);
}

function configureSigningMode() {
  if (isTrueEnv(process.env.COWORK_MAC_UNSIGNED) || !hasExplicitSigningIdentity()) {
    process.env.COWORK_MAC_UNSIGNED = "1";
    process.env.CSC_IDENTITY_AUTO_DISCOVERY = "false";
    log("Unsigned macOS packaging enabled; Developer ID auto-discovery is disabled.");
    return;
  }

  log("Signed macOS packaging enabled from explicit signing identity.");
}

function loadDotEnvMac() {
  if (!existsSync(ENV_MAC)) {
    log("No .env.mac found — using unsigned macOS packaging.");
    return;
  }
  const text = readFileSync(ENV_MAC, "utf8");
  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let val = line.slice(eq + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    process.env[key] = val;
  }
  log(`Loaded environment from ${ENV_MAC}`);
}

function run(cmd, args) {
  const r = spawnSync(cmd, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: process.env,
    shell: false,
  });
  if (r.error) {
    process.stderr.write(`[package:mac] ${r.error.message}\n`);
    process.exit(1);
  }
  return r.status ?? 1;
}

loadDotEnvMac();
configureSigningMode();
log("Running npm run build …");
const build = spawnSync("npm", ["run", "build"], {
  cwd: ROOT,
  stdio: "inherit",
  env: process.env,
});
if (build.status !== 0) {
  process.exit(build.status ?? 1);
}

log("Running electron-builder --mac --publish never …");
const packageStatus = run(process.execPath, ["scripts/run_electron_builder.mjs", "--mac", "--publish", "never"]);
if (packageStatus !== 0) {
  process.exit(packageStatus);
}

log("Aligning updater artifact names …");
const alignStatus = run(process.execPath, ["scripts/release-artifact-names.mjs"]);
if (alignStatus !== 0) {
  process.exit(alignStatus);
}

const verifyStatus = run(process.execPath, ["scripts/release-artifact-names.mjs", "--check"]);
process.exit(verifyStatus);
