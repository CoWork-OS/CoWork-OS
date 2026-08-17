import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const {
  getNpmInstallModeArgs,
  getRuntimeDependencyRepairArgs,
  isSourceCheckout,
} = require(
  "../scripts/npm_install_mode.cjs",
) as {
  getNpmInstallModeArgs: (rootDir: string) => string[];
  getRuntimeDependencyRepairArgs: (
    rootDir: string,
    missingSpecs: string[],
  ) => string[];
  isSourceCheckout: (rootDir: string) => boolean;
};

const tempDirs: string[] = [];

function createTempRoot(): string {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-install-mode-"));
  tempDirs.push(rootDir);
  return rootDir;
}

afterEach(() => {
  for (const tempDir of tempDirs.splice(0)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

describe("npm dependency repair mode", () => {
  it("preserves development dependencies in a normal source checkout", () => {
    const rootDir = createTempRoot();
    fs.mkdirSync(path.join(rootDir, ".git"));

    expect(isSourceCheckout(rootDir)).toBe(true);
    expect(getNpmInstallModeArgs(rootDir)).toEqual(["--include=dev"]);
    expect(
      getRuntimeDependencyRepairArgs(rootDir, ["electron@^40.4.1"]),
    ).toEqual(["--include=dev"]);
  });

  it("preserves development dependencies in a git worktree", () => {
    const rootDir = createTempRoot();
    fs.writeFileSync(path.join(rootDir, ".git"), "gitdir: /tmp/example\n");

    expect(isSourceCheckout(rootDir)).toBe(true);
    expect(getNpmInstallModeArgs(rootDir)).toEqual(["--include=dev"]);
  });

  it("keeps production installs limited to runtime dependencies", () => {
    const rootDir = createTempRoot();

    expect(isSourceCheckout(rootDir)).toBe(false);
    expect(getNpmInstallModeArgs(rootDir)).toEqual([
      "--omit=dev",
      "--package-lock=false",
    ]);
    expect(
      getRuntimeDependencyRepairArgs(rootDir, ["electron@^40.4.1"]),
    ).toEqual([
      "--omit=dev",
      "--package-lock=false",
      "electron@^40.4.1",
    ]);
  });
});
