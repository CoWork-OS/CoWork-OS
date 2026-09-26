import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("release updater platform metadata", () => {
  it("adds and validates the Darwin 22 minimum in latest-mac.yml", () => {
    const releaseDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-release-metadata-"));
    tempDirs.push(releaseDir);
    fs.writeFileSync(path.join(releaseDir, "CoWork-OS-0.5.52-mac.zip"), "artifact");
    fs.writeFileSync(
      path.join(releaseDir, "latest-mac.yml"),
      [
        "version: 0.5.52",
        "files:",
        "  - url: CoWork-OS-0.5.52-mac.zip",
        "    size: 8",
        "path: CoWork-OS-0.5.52-mac.zip",
        "sha512: placeholder",
        "",
      ].join("\n"),
    );

    execFileSync(process.execPath, ["scripts/release-artifact-names.mjs", "--dir", releaseDir], {
      cwd: path.resolve(import.meta.dirname, ".."),
    });
    execFileSync(
      process.execPath,
      ["scripts/release-artifact-names.mjs", "--check", "--dir", releaseDir],
      { cwd: path.resolve(import.meta.dirname, "..") },
    );

    expect(fs.readFileSync(path.join(releaseDir, "latest-mac.yml"), "utf8")).toContain(
      "minimumSystemVersion: 22.0.0",
    );
  });
});
