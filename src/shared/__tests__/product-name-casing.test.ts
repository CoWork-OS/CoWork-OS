import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const SRC_ROOT = path.resolve(__dirname, "../..");
const SCANNED = ["renderer", "electron", "shared"];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) {
      return name === "__tests__" || name === "node_modules" ? [] : sourceFiles(full);
    }
    return /\.(ts|tsx)$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : [];
  });
}

describe("product name casing", () => {
  // The product is "CoWork OS" and the assistant defaults to "CoWork". "Cowork" in shown text
  // (the composer disclaimer, Mission Control, Inbox) read as a different product. Comments may
  // still name Anthropic's "Claude Cowork".
  it("never shows the product name as Cowork", () => {
    const offenders: string[] = [];
    for (const file of SCANNED.flatMap((dir) => sourceFiles(path.join(SRC_ROOT, dir)))) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, index) => {
          const code = line.trim();
          if (code.startsWith("//") || code.startsWith("*") || code.startsWith("/*")) return;
          if (/\bCowork\b/.test(code.replace(/Claude Cowork/g, ""))) {
            offenders.push(`${path.relative(SRC_ROOT, file)}:${index + 1}`);
          }
        });
    }
    expect(offenders).toEqual([]);
  });
});
