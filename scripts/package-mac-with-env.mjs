#!/usr/bin/env node
/**
 * Runs `npm run build` then `electron-builder --mac` after loading optional
 * `.env.mac` from the repo root (gitignored). Use this for signed + notarized
 * DMG/ZIP so Gatekeeper accepts downloads.
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

function loadDotEnvMac() {
  if (!existsSync(ENV_MAC)) {
    log("No .env.mac found — using current shell env only (see scripts/mac-notarize.env.example).");
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
  process.exit(r.status ?? 1);
}

loadDotEnvMac();
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
run("npx", ["electron-builder", "--mac", "--publish", "never"]);
