import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentPath = fileURLToPath(new URL("../TerminalTabsDock.tsx", import.meta.url));
const stylesPath = fileURLToPath(new URL("../terminal-tabs-dock.css", import.meta.url));

describe("TerminalTabsDock", () => {
  it("captures command entry inside xterm instead of rendering a bottom command bar", () => {
    const source = readFileSync(componentPath, "utf8");
    const styles = readFileSync(stylesPath, "utf8");

    expect(source).toContain("terminal.onData");
    expect(source).toContain("disableStdin: false");
    expect(source).not.toContain("terminal-dock-commandbar");
    expect(source).not.toContain('aria-label="Terminal command"');
    expect(styles).not.toContain(".terminal-dock-commandbar");
    expect(styles).toMatch(/height:\s*calc\(100%\s*-\s*34px\);/);
  });

  it("opens terminal web links through Electron and passes xterm input directly to the PTY", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("new WebLinksAddon((_event, uri)");
    expect(source).toContain("window.electronAPI.openExternal(uri)");
    expect(source).toContain("sendTerminalInput(tabId, data)");
    expect(source).not.toContain("BROWSER_OPEN_PROMPT_PATTERN");
    expect(source).not.toContain("runTerminalTabCommand");
    expect(source).not.toContain("commandDraft");
    expect(source).toContain('window.addEventListener("focus", focusActiveTerminal)');
    expect(source).toContain("onMouseDown={focusActiveTerminal}");
    expect(source).toContain("setError(null)");
    expect(source).toContain("Failed to send input.");
  });

  it("shows the agent's background processes as read-only tabs that links can open", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("window.electronAPI.listAgentTerminalTabs(taskId)");
    expect(source).toContain("window.electronAPI.onAgentTerminalEvent(");
    expect(source).toContain("disableStdin: true");
    // Live output waits for the buffered output, so nothing is written twice.
    expect(source).toContain("!handle.replaying");
    expect(source).toContain("That terminal tab is closed.");
    expect(source).toContain("window.electronAPI.closeAgentTerminalTab(");
    expect(source).not.toMatch(/writeAgentTerminal/);
  });
});
