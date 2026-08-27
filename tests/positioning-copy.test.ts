import { execFileSync } from "node:child_process";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("public positioning copy", () => {
  it("avoids unsupported universal claims and stale product language", () => {
    const output = execFileSync(
      process.execPath,
      [path.resolve(process.cwd(), "scripts/qa/validate-positioning-copy.mjs")],
      { cwd: process.cwd(), encoding: "utf8" },
    );

    expect(output).toContain("Positioning copy validation passed");
  });
});
