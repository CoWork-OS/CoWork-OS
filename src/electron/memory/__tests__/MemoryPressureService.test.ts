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

  it("does not inspect memory files outside the supplied read boundary", async () => {
    writeFile(path.join(tmpDir, ".cowork", "MEMORY.md"), "Private memory");
    const readGuard = (candidatePath: string) => candidatePath.endsWith("/USER.md");

    const report = await MemoryPressureService.analyze(tmpDir, readGuard);
    const memory = report.files.find((file) => file.file === "MEMORY.md");

    expect(memory).toMatchObject({ exists: false, charCount: 0, level: "ok" });
    expect(memory?.recommendations).toContain(
      "The active access profile does not allow reading this file.",
    );
  });

  it("re-triggers only when the pressure fingerprint changes", async () => {
    MemoryPressureService.resetHandledPressure();
    const memoryFile = path.join(tmpDir, ".cowork", "MEMORY.md");
    writeFile(memoryFile, "- Use deterministic prompts\n- Use deterministic prompts\n");
    const first = MemoryPressureService.fingerprint(await MemoryPressureService.analyze(tmpDir));
    expect(first).not.toBe("");
    expect(MemoryPressureService.hasPressureChanged("ws-1", first)).toBe(true);

    MemoryPressureService.markPressureHandled("ws-1", first);
    const again = MemoryPressureService.fingerprint(await MemoryPressureService.analyze(tmpDir));
    expect(again).toBe(first);
    expect(MemoryPressureService.hasPressureChanged("ws-1", again)).toBe(false);
    expect(MemoryPressureService.hasPressureChanged("ws-2", again)).toBe(true);

    writeFile(memoryFile, "- Use deterministic prompts\n- Use deterministic prompts\n- One more line here\n");
    const changed = MemoryPressureService.fingerprint(await MemoryPressureService.analyze(tmpDir));
    expect(MemoryPressureService.hasPressureChanged("ws-1", changed)).toBe(true);
  });

  it("has an empty fingerprint when nothing needs compaction", async () => {
    writeFile(path.join(tmpDir, ".cowork", "MEMORY.md"), "- A single small entry\n");
    const report = await MemoryPressureService.analyze(tmpDir);
    expect(MemoryPressureService.fingerprint(report)).toBe("");
    expect(MemoryPressureService.hasPressureChanged("ws-1", "")).toBe(false);
  });
});
