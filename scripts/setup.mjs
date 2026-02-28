#!/usr/bin/env node
/**
 * Cross-platform setup entry point.
 *
 * Replaces the POSIX shell-based "setup" npm script with a Node.js equivalent
 * that works on macOS, Linux, and Windows.
 *
 * Steps:
 * 1. If Electron is not in node_modules, run `npm install --ignore-scripts`.
 * 2. Run native setup with outer retry loop (resilient to SIGKILL / OOM).
 */

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const NPM_CMD = process.platform === "win32" ? "npm.cmd" : "npm";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isKilled(res) {
  return res.signal === "SIGKILL" || res.status === 137 || res.status === 9;
}

function electronPresent() {
  const local = path.join(process.cwd(), "node_modules", "electron", "package.json");
  const parent = path.join(process.cwd(), "..", "electron", "package.json");
  return fs.existsSync(local) || fs.existsSync(parent);
}

function installGitHooks() {
  const res = spawnSync(process.execPath, ["scripts/install_git_hooks.mjs"], {
    stdio: "inherit",
    env: process.env,
  });
  if (res.status !== 0) {
    console.warn("[cowork] setup:hooks install failed. You can retry with `npm run hooks:install`.");
  }
}

async function main() {
  // 1. Bootstrap: install deps if electron is missing
  if (!electronPresent()) {
    console.log(
      "[cowork] setup:bootstrap electron not found in local or parent node_modules; running fallback install."
    );
    const installRes = spawnSync(NPM_CMD, ["install", "--ignore-scripts", "--no-audit", "--no-fund"], {
      stdio: "inherit",
      env: process.env,
    });
    if (installRes.status !== 0) {
      console.error("[cowork] npm install failed.");
      process.exit(installRes.status ?? 1);
    }
  }

  // 2. Run native setup with outer retry loop
  const maxAttemptsRaw = process.env.COWORK_SETUP_NATIVE_OUTER_ATTEMPTS || "6";
  const maxAttempts = Math.max(1, Number.parseInt(maxAttemptsRaw, 10) || 6);
  let delay = 2000;
  let lastStatus = 1;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      console.log(`[cowork] setup:native was killed; retrying in ${Math.round(delay / 1000)}s...`);
      await sleep(delay);
      delay = Math.min(20000, delay * 2);
    }

    console.log(`[cowork] setup:native (outer attempt ${attempt}/${maxAttempts})`);

    const res = spawnSync(process.execPath, ["scripts/setup_native.mjs"], {
      stdio: "inherit",
      env: process.env,
    });

    lastStatus = res.status ?? 1;

    if (lastStatus === 0) {
      installGitHooks();
      process.exit(0);
    }

    if (!isKilled(res)) {
      process.exit(lastStatus);
    }
  }

  process.exit(lastStatus);
}

main().catch((err) => {
  console.error("[cowork] setup failed:", err);
  process.exit(1);
});
