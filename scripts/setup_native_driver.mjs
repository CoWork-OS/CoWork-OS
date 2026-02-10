#!/usr/bin/env node
/**
 * Resilient wrapper around `setup_native.mjs`.
 *
 * Why:
 * - On some macOS machines (especially under memory pressure), the first native
 *   setup attempt may get SIGKILL'd by the OS ("Killed: 9").
 * - A second attempt typically succeeds once the system settles.
 *
 * This driver retries on SIGKILL / exit 137 with a short backoff.
 */

import { spawnSync } from "node:child_process";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function wasKilled(res) {
  return res.signal === "SIGKILL" || res.status === 137;
}

async function main() {
  const maxAttemptsRaw = process.env.COWORK_SETUP_NATIVE_ATTEMPTS || "3";
  const maxAttempts = Math.max(1, Number.parseInt(maxAttemptsRaw, 10) || 3);

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (attempt > 1) {
      const delayMs = Math.min(10_000, 1_000 * Math.pow(2, attempt - 1));
      console.log(
        `\n[cowork] Native setup was killed; retrying (attempt ${attempt}/${maxAttempts}) in ${Math.round(
          delayMs / 1000
        )}s...`
      );
      await sleep(delayMs);
    }

    const res = spawnSync(process.execPath, ["scripts/setup_native.mjs"], {
      stdio: "inherit",
      env: process.env,
    });

    if (res.status === 0) {
      process.exit(0);
    }

    if (!wasKilled(res) || attempt === maxAttempts) {
      // status can be null if terminated by a signal.
      process.exit(res.status ?? 1);
    }
  }
}

main().catch((err) => {
  console.error("[cowork] setup:native driver failed:", err);
  process.exit(1);
});

