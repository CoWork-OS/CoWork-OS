import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const RENDERER_ROOT = path.resolve(__dirname, "../..");

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) return name === "__tests__" ? [] : sourceFiles(full);
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("renderer text prompts", () => {
  // Electron does not implement window.prompt: it throws "prompt() is not supported.", so a
  // rename or form that relied on it silently did nothing. Use promptForText (TextPromptDialog).
  it("never calls window.prompt", () => {
    const offenders = sourceFiles(RENDERER_ROOT)
      .filter((file) => /\bwindow\.prompt\s*\(/.test(readFileSync(file, "utf8")))
      .map((file) => path.relative(RENDERER_ROOT, file));
    expect(offenders).toEqual([]);
  });
});
