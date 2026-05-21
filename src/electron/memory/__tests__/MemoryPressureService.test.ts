import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryPressureService } from "../MemoryPressureService";

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

describe("MemoryPressureService", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-memory-pressure-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("flags hot memory files that exceed the compaction threshold", async () => {
    writeFile(path.join(tmpDir, ".cowork", "USER.md"), `${"A".repeat(1700)}\n`);
    writeFile(
      path.join(tmpDir, ".cowork", "MEMORY.md"),
      "- Use deterministic prompts\n- Use deterministic prompts\n",
    );

    const report = await MemoryPressureService.analyze(tmpDir);
    const user = report.files.find((file) => file.file === "USER.md");
    const memory = report.files.find((file) => file.file === "MEMORY.md");

    expect(user?.level).toBe("compact");
    expect(memory?.duplicateLineCount).toBe(1);
    expect(MemoryPressureService.buildCompactionInstructions(report)).toContain(".cowork/USER.md");
  });
});
