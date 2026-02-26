import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { pruneTempSandboxProfiles } from "../temp-sandbox-profiles";

describe("pruneTempSandboxProfiles", () => {
  const cleanupDirs: string[] = [];

  afterEach(() => {
    for (const dir of cleanupDirs) {
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch {
        // Best-effort cleanup.
      }
    }
    cleanupDirs.length = 0;
  });

  const createTempDir = (): string => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-sandbox-prune-test-"));
    cleanupDirs.push(dir);
    return dir;
  };

  it("removes stale sandbox profile files and keeps fresh/unrelated files", () => {
    const dir = createTempDir();
    const nowMs = Date.now();
    const oldDate = new Date(nowMs - 2 * 60 * 60 * 1000);
    const freshDate = new Date(nowMs - 5 * 60 * 1000);

    const staleLegacy = path.join(dir, "cowork_sandbox_123456789.sb");
    const staleSecure = path.join(dir, "cowork_0123456789abcdef0123456789abcdef.sb");
    const freshLegacy = path.join(dir, "cowork_sandbox_555555.sb");
    const unrelated = path.join(dir, "cowork_script_123.py");

    fs.writeFileSync(staleLegacy, "(version 1)");
    fs.writeFileSync(staleSecure, "(version 1)");
    fs.writeFileSync(freshLegacy, "(version 1)");
    fs.writeFileSync(unrelated, "print('ok')");

    fs.utimesSync(staleLegacy, oldDate, oldDate);
    fs.utimesSync(staleSecure, oldDate, oldDate);
    fs.utimesSync(freshLegacy, freshDate, freshDate);

    const result = pruneTempSandboxProfiles({
      tmpDir: dir,
      nowMs,
      maxAgeMs: 60 * 60 * 1000,
    });

    expect(result.scanned).toBe(3);
    expect(result.removed).toBe(2);
    expect(result.kept).toBe(1);
    expect(fs.existsSync(staleLegacy)).toBe(false);
    expect(fs.existsSync(staleSecure)).toBe(false);
    expect(fs.existsSync(freshLegacy)).toBe(true);
    expect(fs.existsSync(unrelated)).toBe(true);
  });

  it("returns zero counts when temp directory is missing", () => {
    const base = createTempDir();
    const missing = path.join(base, "missing");

    const result = pruneTempSandboxProfiles({ tmpDir: missing });
    expect(result).toEqual({ scanned: 0, removed: 0, kept: 0 });
  });
});
