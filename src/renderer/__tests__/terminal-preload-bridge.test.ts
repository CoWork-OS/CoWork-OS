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

  it("exposes read-only access to the agent's process tabs, with no way to write to them", () => {
    const source = readFileSync(preloadPath, "utf8");
    const bridgeSource = source.slice(
      source.indexOf('contextBridge.exposeInMainWorld("electronAPI"'),
    );

    for (const method of [
      "listAgentTerminalTabs:",
      "readAgentTerminalTab:",
      "stopAgentTerminalTab:",
      "closeAgentTerminalTab:",
      "onAgentTerminalEvent:",
    ]) {
      expect(bridgeSource).toContain(method);
    }
    expect(bridgeSource).toContain("IPC_CHANNELS.AGENT_TERMINAL_EVENT");
    expect(bridgeSource).not.toMatch(/writeAgentTerminal|runAgentTerminal|createAgentTerminal/);
  });
});
