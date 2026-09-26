import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { removeLegacyHealthBridgeTempDirs } from "../retired-feature-cleanup";

describe("removeLegacyHealthBridgeTempDirs", () => {
  let tempRoot: string;

  const makeDir = (name: string, files: string[]): string => {
    const dir = path.join(tempRoot, name);
    fs.mkdirSync(dir);
    for (const file of files) fs.writeFileSync(path.join(dir, file), "{}");
    return dir;
  };

  beforeEach(() => {
    tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-retired-cleanup-"));
  });

  afterEach(() => {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  });

  it("removes folders holding only bridge request/response files", () => {
    const both = makeDir("cowork-healthkit-Ab12Cd", ["request.json", "response.json"]);
    const requestOnly = makeDir("cowork-healthkit-XyZ789", ["request.json"]);
    const empty = makeDir("cowork-healthkit-000000", []);

    expect(removeLegacyHealthBridgeTempDirs(tempRoot, "darwin")).toBe(3);
    expect(fs.existsSync(both)).toBe(false);
    expect(fs.existsSync(requestOnly)).toBe(false);
    expect(fs.existsSync(empty)).toBe(false);
  });

  it("keeps folders that do not look like bridge leftovers", () => {
    const extraFile = makeDir("cowork-healthkit-Ab12Cd", ["request.json", "notes.txt"]);
    const nested = makeDir("cowork-healthkit-Nested", ["request.json"]);
    fs.mkdirSync(path.join(nested, "child"));
    const otherName = makeDir("cowork-healthkit-too-long", ["request.json"]);
    const unrelated = makeDir("some-other-app-Ab12Cd", ["request.json"]);

    expect(removeLegacyHealthBridgeTempDirs(tempRoot, "darwin")).toBe(0);
    for (const dir of [extraFile, nested, otherName, unrelated]) {
      expect(fs.existsSync(dir)).toBe(true);
    }
  });

  it("does nothing outside macOS", () => {
    const dir = makeDir("cowork-healthkit-Ab12Cd", ["request.json"]);

    expect(removeLegacyHealthBridgeTempDirs(tempRoot, "linux")).toBe(0);
    expect(fs.existsSync(dir)).toBe(true);
  });
});
