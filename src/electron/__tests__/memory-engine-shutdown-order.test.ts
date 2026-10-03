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
});
