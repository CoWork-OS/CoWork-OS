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
  it("includes the company planner persona template in Electron resources", () => {
    const root = path.resolve(import.meta.dirname, "..");
    const packageJson = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const personaTemplates = packageJson.build?.extraResources?.find(
      (entry: { to?: string }) => entry.to === "persona-templates",
    );

    expect(personaTemplates).toMatchObject({
      from: "resources/persona-templates",
      to: "persona-templates",
    });
    expect(personaTemplates.filter).toContain("*.json");
    expect(
      fs
        .statSync(path.join(root, "resources", "persona-templates", "company-planner.json"))
        .isFile(),
    ).toBe(true);
  });

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
