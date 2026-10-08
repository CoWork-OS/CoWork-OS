/**
 * LIFE-5: one DailyBriefingService per process. The desktop entry point creates it and the
 * IPC handlers reuse it; none of them constructs its own. The entry points cannot be booted
 * in tests, so this checks the sources.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const count = (source: string, needle: string) => source.split(needle).length - 1;

describe("shared service instances", () => {
  it("the briefing IPC handler reuses the app's DailyBriefingService", () => {
    const handlers = read("src/electron/ipc/handlers.ts");
    expect(handlers).not.toContain("new DailyBriefingService(");
    expect(handlers).toContain("options?.getDailyBriefingService?.()");
    expect(count(read("src/electron/main.ts"), "new DailyBriefingService(")).toBe(1);
  });
});
