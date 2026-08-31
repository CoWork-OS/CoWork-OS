import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function writeFile(filePath: string, content: string | Buffer): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, content);
}

function scriptPath(name: string): string {
  return path.join(process.cwd(), "resources/skills/llm-wiki/scripts", name);
}

function runJsonScript(name: string, args: string[]): any {
  const output = execFileSync("node", [scriptPath(name), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
  return JSON.parse(output);
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe("llm-wiki workbench scripts", () => {
  it("imports repo directories and images into deterministic raw locations", () => {
    const workspace = makeTempDir("cowork-llm-wiki-workspace-");
    const vault = path.join(workspace, "research/wiki");
    const repoDir = makeTempDir("cowork-llm-wiki-repo-");
    const imagePath = path.join(workspace, "source.png");

    writeFile(path.join(repoDir, "README.md"), "# Demo repo\n");
    writeFile(path.join(repoDir, "src/index.ts"), "export const value = 42;\n");
    writeFile(imagePath, Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const repoResult = runJsonScript("wiki-import.mjs", [
      "--vault",
      vault,
      "--source",
      repoDir,
      "--kind",
      "repo",
      "--title",
      "Demo Repo",
    ]);
    const imageResult = runJsonScript("wiki-import.mjs", [
      "--vault",
      vault,
      "--source",
      imagePath,
      "--kind",
      "image",
      "--title",
      "Demo Diagram",
    ]);

    expect(repoResult.kind).toBe("repo");
    expect(fs.existsSync(path.join(vault, "raw/repos/demo-repo/tree.txt"))).toBe(true);
    expect(fs.existsSync(path.join(vault, "raw/repos/demo-repo/README.snapshot.md"))).toBe(true);

    expect(imageResult.kind).toBe("image");
    expect(fs.existsSync(path.join(vault, "raw/assets/demo-diagram.png"))).toBe(true);
    expect(fs.existsSync(path.join(vault, "raw/assets/demo-diagram.png.source.json"))).toBe(true);
  });

  it("searches wiki pages, raw captures, and rendered slide decks", () => {
    const workspace = makeTempDir("cowork-llm-wiki-search-");
    const vault = path.join(workspace, "research/wiki");
    const slideBodyPath = path.join(workspace, "slides-body.md");

    writeFile(
      path.join(vault, "concepts/grpo.md"),
      `---
title: GRPO
created: 2026-04-07
updated: 2026-04-07
type: concept
tags: [rl, grpo]
status: active
sources: [raw/articles/grpo/capture.txt]
---
GRPO is a policy optimization method with variance reduction benefits.
`,
    );
    writeFile(
      path.join(vault, "raw/articles/grpo/capture.txt"),
      "GRPO notes and variance reduction observations.\n",
    );
    writeFile(
      slideBodyPath,
      "## Why it matters\n\n- Variance reduction\n- Better sampling discipline\n",
    );

    runJsonScript("wiki-render.mjs", [
      "--vault",
      vault,
      "--kind",
      "marp",
      "--title",
      "GRPO deck",
      "--body-file",
      slideBodyPath,
    ]);

    const wikiSearch = runJsonScript("wiki-search.mjs", [
      "--vault",
      vault,
      "--query",
      "grpo",
      "--scope",
      "wiki",
      "--format",
      "json",
    ]);
    const rawSearch = runJsonScript("wiki-search.mjs", [
      "--vault",
      vault,
      "--query",
      "variance reduction",
      "--scope",
      "raw",
      "--format",
      "json",
    ]);
    const outputSearch = runJsonScript("wiki-search.mjs", [
      "--vault",
      vault,
      "--query",
      "deck",
      "--scope",
      "all",
      "--format",
      "json",
    ]);

    expect(wikiSearch.results[0]).toEqual(
      expect.objectContaining({
        path: "concepts/grpo.md",
        sourceType: "wiki",
      }),
    );
    expect(rawSearch.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "raw/articles/grpo/capture.txt",
          sourceType: "raw",
        }),
      ]),
    );
    expect(outputSearch.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "outputs/slides/grpo-deck.md",
          sourceType: "wiki",
        }),
      ]),
    );
  });

  it("renders Marp decks and SVG charts back into the vault", () => {
    const workspace = makeTempDir("cowork-llm-wiki-render-");
    const vault = path.join(workspace, "research/wiki");
    const slideBodyPath = path.join(workspace, "deck.md");
    const chartSpecPath = path.join(workspace, "chart.json");

    writeFile(slideBodyPath, "## Signals\n\n- Connected work\n- Open questions\n");
    writeFile(
      chartSpecPath,
      JSON.stringify({
        title: "GRPO signal spread",
        subtitle: "Positive and negative deltas",
        series: [
          { label: "Papers", value: 12 },
          { label: "Repos", value: -3 },
          { label: "Slides", value: 5 },
        ],
      }),
    );

    const marpResult = runJsonScript("wiki-render.mjs", [
      "--vault",
      vault,
      "--kind",
      "marp",
      "--title",
      "GRPO overview",
      "--body-file",
      slideBodyPath,
      "--theme",
      "gaia",
    ]);
    const chartResult = runJsonScript("wiki-render.mjs", [
      "--vault",
      vault,
      "--kind",
      "chart",
      "--title",
      "GRPO signal spread",
      "--spec-file",
      chartSpecPath,
    ]);

    const marpText = fs.readFileSync(marpResult.outputPath, "utf8");
    const chartSvg = fs.readFileSync(chartResult.outputPath, "utf8");

    expect(marpText).toContain("marp: true");
    expect(marpText).toContain("theme: gaia");
    expect(marpText).toContain("# GRPO overview");

    expect(chartSvg).toContain("GRPO signal spread");
    expect(chartSvg).toContain("Positive and negative deltas");
    expect(fs.existsSync(chartResult.specOutputPath)).toBe(true);
    expect(fs.existsSync(chartResult.metadataPath)).toBe(true);
  });
});
