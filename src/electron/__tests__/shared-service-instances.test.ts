/**
 * LIFE-5: one DailyBriefingService and one EverydayAgentService per process. The desktop
 * entry point creates them and injects them into the IPC handlers, the control plane and
 * the browser host; none of those constructs its own. The entry points cannot be booted in
 * tests, so this checks the sources.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "../../..");
const read = (file: string) => readFileSync(path.join(ROOT, file), "utf8");
const count = (source: string, needle: string) => source.split(needle).length - 1;

describe("shared service instances", () => {
  it.each([
    "src/electron/ipc/handlers.ts",
    "src/electron/control-plane/handlers.ts",
    "src/host/services/browser-navigation-methods.ts",
    "src/host/services/browser-host-application.ts",
  ])("%s uses the injected EverydayAgentService", (file) => {
    expect(read(file)).not.toContain("new EverydayAgentService(");
  });

  it("the desktop app creates one EverydayAgentService and injects it everywhere", () => {
    const main = read("src/electron/main.ts");
    expect(count(main, "new EverydayAgentService(")).toBe(1);
    // IPC handlers, the control plane (handlers and both starts) and the browser host.
    expect(count(main, "everydayAgentService: getEverydayAgentService()")).toBe(5);
  });

  it("the briefing IPC handler reuses the app's DailyBriefingService", () => {
    const handlers = read("src/electron/ipc/handlers.ts");
    expect(handlers).not.toContain("new DailyBriefingService(");
    expect(handlers).toContain("options?.getDailyBriefingService?.()");
    expect(count(read("src/electron/main.ts"), "new DailyBriefingService(")).toBe(1);
  });
});
