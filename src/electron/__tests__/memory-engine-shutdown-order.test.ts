/**
 * The desktop app and the node daemon both stop the memory engine (retention, deferred
 * jobs) and flush queued MemoryWriter writes before the database closes. The shutdown
 * steps live in the entry points, which tests cannot boot, so this checks their order.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");

function stepIndex(source: string, name: string): number {
  const index = source.indexOf(`name: "${name}"`);
  expect(index, `shutdown step "${name}"`).toBeGreaterThan(-1);
  return index;
}

describe.each([["src/electron/main.ts"], ["src/daemon/main.ts"]])("%s shutdown", (file) => {
  const source = readFileSync(path.join(ROOT, file), "utf8");

  it("flushes the memory engine before the conversation index and the database close", () => {
    const engine = stepIndex(source, "memory engine");
    expect(engine).toBeLessThan(stepIndex(source, "conversation index"));
    expect(engine).toBeLessThan(stepIndex(source, "database"));
    const step = source.slice(engine, engine + 600);
    expect(step).toContain("memoryRetentionService?.stop()");
    expect(step).toContain("stopMemoryEngine?.()");
    expect(step).toContain("await MemoryWriter.get()?.flush()");
  });

  it("drains the memory service before shutting it down (LOOP-14)", () => {
    const memory = stepIndex(source, "memory");
    expect(memory).toBeLessThan(stepIndex(source, "database"));
    const step = source.slice(memory, memory + 400);
    expect(step).toContain("await MemoryService.drain()");
    expect(step.indexOf("MemoryService.drain()")).toBeLessThan(
      step.indexOf("MemoryService.shutdown()"),
    );
  });

  it("stops the kit writers and releases their lease while the database is open", () => {
    const kit = stepIndex(source, "kit writers");
    expect(kit).toBeLessThan(stepIndex(source, "database worker"));
    expect(kit).toBeLessThan(stepIndex(source, "database"));
    expect(source.slice(kit, kit + 300)).toContain("await kitWriterOwnership?.stop()");
    // The writers are only started through the lease, never directly.
    expect(source).not.toMatch(/new (CrossSignalService|FeedbackService|LoreService)\(/);
  });
});

describe("desktop quiet mode (LOOP-14)", () => {
  const source = readFileSync(path.join(ROOT, "src/electron/main.ts"), "utf8");

  it("starts no memory cleanup jobs and no kit writers", () => {
    expect(source).toContain(
      "MemoryService.initialize(dbManager, { backgroundJobs: !startupQuietMode })",
    );
    const kit = source.indexOf("kitWriterOwnership = createKitWriterOwnership(");
    expect(kit).toBeGreaterThan(-1);
    const guard = source.lastIndexOf("if (startupQuietMode) {", kit);
    expect(source.slice(guard, kit)).toContain("Kit writers not started (quiet mode)");
  });
});
