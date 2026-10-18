import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { posix } from "node:path";
import { describe, expect, it } from "vitest";
import config from "../vitest.config.mts";

const scripts = JSON.parse(readFileSync("package.json", "utf8")).scripts as Record<string, string>;
// These are quoted in package.json so Node 24 expands the same globs on every shell.
const nodePatterns = scripts["test:node"].match(/(?:scripts|tests)\/[^\s"']+/g) ?? [];
const vitestPatterns = config.test?.include ?? [];

describe("maintained test discovery", () => {
  it("assigns every JavaScript and TypeScript test to a default test runner", () => {
    // Git includes new local tests while excluding ignored/generated fixture files.
    const files = execFileSync(
      "git",
      ["ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { encoding: "utf8" },
    )
      .split("\0")
      .filter((file) => /\.(?:test|spec)\.(?:[cm]?[jt]sx?)$/.test(file) && existsSync(file))
      .map((file) => file.replaceAll("\\", "/"));
    expect(files).toContain("tests/test-discovery.test.ts");
    const uncovered = files.filter(
      (file) =>
        ![...vitestPatterns, ...nodePatterns].some((pattern) => posix.matchesGlob(file, pattern)),
    );
    expect(uncovered).toEqual([]);
  });

  it.each(["test", "test:coverage"])("runs the Node suites before Vitest in %s", (entrypoint) => {
    expect(scripts["test:node"]).toMatch(/^node --test\b/);
    expect(nodePatterns.length).toBeGreaterThan(0);
    const commands = scripts[entrypoint].split(/\s*&&\s*/);
    const nodeIndex = commands.indexOf("npm run test:node");
    const vitestIndex = commands.findIndex((command) => command.startsWith("vitest run"));
    expect(nodeIndex).toBeGreaterThanOrEqual(0);
    expect(vitestIndex).toBeGreaterThan(nodeIndex);
  });
});
