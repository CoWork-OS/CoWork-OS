#!/usr/bin/env node

import { chmodSync, existsSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";

function runGit(args) {
  return spawnSync("git", args, {
    cwd: process.cwd(),
    stdio: "pipe",
    encoding: "utf8",
  });
}

function isGitRepo() {
  const res = runGit(["rev-parse", "--is-inside-work-tree"]);
  return res.status === 0 && res.stdout.trim() === "true";
}

function main() {
  if (!isGitRepo()) {
    console.log("[cowork] setup:hooks skipped (not a git repository).");
    return;
  }

  const hookPath = path.join(process.cwd(), ".githooks", "pre-commit");
  if (!existsSync(hookPath)) {
    console.error(`[cowork] setup:hooks missing hook file: ${hookPath}`);
    process.exit(1);
  }

  const setHooksPath = runGit(["config", "--local", "core.hooksPath", ".githooks"]);
  if (setHooksPath.status !== 0) {
    const details = setHooksPath.stderr?.trim() || "unknown error";
    console.error(`[cowork] setup:hooks failed to set core.hooksPath: ${details}`);
    process.exit(setHooksPath.status ?? 1);
  }

  try {
    chmodSync(hookPath, 0o755);
  } catch (error) {
    console.warn(`[cowork] setup:hooks could not chmod pre-commit: ${String(error)}`);
  }

  console.log("[cowork] setup:hooks installed (.githooks/pre-commit).");
}

main();
