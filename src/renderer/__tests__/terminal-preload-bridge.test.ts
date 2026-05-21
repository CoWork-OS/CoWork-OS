import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const preloadPath = fileURLToPath(new URL("../../electron/preload.ts", import.meta.url));

describe("terminal preload bridge", () => {
  it("exposes the terminal tab APIs used by TerminalTabsDock", () => {
    const source = readFileSync(preloadPath, "utf8");
    const bridgeStart = source.indexOf('contextBridge.exposeInMainWorld("electronAPI"');
    const bridgeSource = source.slice(bridgeStart);

    expect(bridgeSource).toContain("listTerminalTabs:");
    expect(bridgeSource).toContain("createTerminalTab:");
    expect(bridgeSource).toContain("runTerminalTabCommand:");
    expect(bridgeSource).toContain("writeTerminalTabInput:");
    expect(bridgeSource).toContain("resizeTerminalTab:");
    expect(bridgeSource).toContain("stopTerminalTab:");
    expect(bridgeSource).toContain("closeTerminalTab:");
    expect(bridgeSource).toContain("onTerminalTabOutput:");
    expect(bridgeSource).toContain("IPC_CHANNELS.TERMINAL_TAB_OUTPUT");
  });
});
