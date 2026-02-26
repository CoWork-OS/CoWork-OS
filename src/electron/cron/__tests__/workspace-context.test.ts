import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildManagedScheduledWorkspacePath,
  createScheduledRunDirectory,
  isManagedScheduledWorkspacePath,
  pruneScheduledRunDirectories,
} from "../workspace-context";

describe("cron workspace context helpers", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-cron-workspace-context-"));
  });

  afterEach(() => {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup.
    }
  });

  it("builds a deterministic managed workspace path under user data", () => {
    const managedPath = buildManagedScheduledWorkspacePath(tmpDir, "Daily Briefing", "job-123");
    expect(managedPath).toBe(
      path.join(tmpDir, "scheduled-workspaces", "daily-briefing-job-123"),
    );
    expect(isManagedScheduledWorkspacePath(managedPath, tmpDir)).toBe(true);
    expect(isManagedScheduledWorkspacePath(path.join(tmpDir, "other", "workspace"), tmpDir)).toBe(
      false,
    );
  });

  it("creates run directories and prunes stale ones", () => {
    const workspacePath = path.join(tmpDir, "scheduled-workspaces", "daily-briefing-job-123");
    const nowMs = Date.UTC(2026, 1, 26, 10, 0, 0);

    const first = createScheduledRunDirectory(workspacePath, {
      nowMs,
      keepRecent: 0,
      maxAgeMs: Number.MAX_SAFE_INTEGER,
      hardLimit: 100,
      targetAfterPrune: 50,
    });
    expect(fs.existsSync(first.path)).toBe(true);
    expect(first.relativePath.startsWith(".cowork/scheduled-runs/run-")).toBe(true);

    const staleDir = path.join(first.runsRoot, "run-old-stale");
    fs.mkdirSync(staleDir, { recursive: true });
    const staleAt = new Date(nowMs - 10 * 24 * 60 * 60 * 1000);
    fs.utimesSync(staleDir, staleAt, staleAt);

    const freshDir = path.join(first.runsRoot, "run-fresh");
    fs.mkdirSync(freshDir, { recursive: true });
    const freshAt = new Date(nowMs - 60 * 1000);
    fs.utimesSync(freshDir, freshAt, freshAt);

    const pruneResult = pruneScheduledRunDirectories(first.runsRoot, {
      nowMs,
      keepRecent: 1,
      maxAgeMs: 3 * 24 * 60 * 60 * 1000,
      hardLimit: 100,
      targetAfterPrune: 50,
      minAgeForHardPruneMs: 0,
    });

    expect(pruneResult.removed).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(staleDir)).toBe(false);
    expect(fs.existsSync(freshDir)).toBe(true);
  });
});
