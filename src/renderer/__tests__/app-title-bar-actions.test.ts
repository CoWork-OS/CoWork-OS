import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const appPath = fileURLToPath(new URL("../App.tsx", import.meta.url));
const stylesPath = fileURLToPath(new URL("../styles/index.css", import.meta.url));

describe("App title bar actions", () => {
  it("groups browser, terminal, theme and density in the More menu, before the panel toggle", () => {
    const source = readFileSync(appPath, "utf8");

    const actionsIndex = source.indexOf('<div className="title-bar-actions">');
    const menuIndex = source.indexOf("<TitleBarMoreMenu", actionsIndex);
    const browserIndex = source.indexOf('id: "browser"', menuIndex);
    const terminalIndex = source.indexOf('id: "terminal"', menuIndex);
    const themeIndex = source.indexOf('id: "theme"', menuIndex);
    const densityIndex = source.indexOf('id: "density"', menuIndex);
    const panelIndex = source.indexOf("title-bar-panel-toggle", actionsIndex);

    expect(menuIndex).toBeGreaterThan(actionsIndex);
    expect(terminalIndex).toBeGreaterThan(browserIndex);
    expect(themeIndex).toBeGreaterThan(terminalIndex);
    expect(densityIndex).toBeGreaterThan(themeIndex);
    // The panel toggle stays a separate title bar button after the menu.
    expect(panelIndex).toBeGreaterThan(densityIndex);
    expect(source).not.toContain("title-bar-theme-toggle");
    expect(source).toContain("showTitleBarTerminalToggle");
    expect(source).toContain("titleBarBrowserTaskId");
  });

  it("renders the terminal tabs dock from the selected task workspace", () => {
    const source = readFileSync(appPath, "utf8");

    expect(source).toContain("const TerminalTabsDock = lazy");
    expect(source).toContain("terminalTabsOpen");
    expect(source).toContain("<TerminalTabsDock");
    expect(source).toContain("onClose={onCloseTerminalTabs}");
  });

  it("keeps right panel close work bounded and observable", () => {
    const source = readFileSync(appPath, "utf8");

    expect(source).toContain("const EMPTY_RIGHT_PANEL_INPUT");
    expect(source).toContain("const handleRightSidebarToggle = useCallback");
    expect(source).toContain("setTerminalTabsOpen(false);");
    expect(source).toContain('"App.right_sidebar_toggle_to_paint"');
    expect(source).toContain("rightPanelInput={visibleRightPanelInput}");
  });

  it("renders the right task inspector as a detached floating surface", () => {
    const styles = readFileSync(stylesPath, "utf8");

    expect(styles).toContain("FLOATING RIGHT INSPECTOR");
    expect(styles).toContain("height: fit-content !important;");
    // Clears the title bar only where it overlays the row; the shell layout sets it to 0.
    expect(styles).toContain("max-height: calc(100% - var(--title-bar-height) - 28px);");
    expect(styles).toContain("margin: calc(var(--title-bar-height) + 16px) 12px 12px 0;");
    expect(styles).toContain("background: var(--color-bg-primary) !important;");
    expect(styles).toContain("border-radius: var(--app-shell-panel-radius);");
    expect(styles).toContain(".theme-light .app-layout,");
    expect(styles).toContain(".theme-light .selected-workspace-main-row {");
    expect(styles).toContain("html:not(.theme-light) .app-layout,");
    expect(styles).toContain("html:not(.theme-light) .selected-workspace-main-row {");
    expect(styles).toContain("background: var(--color-bg-primary) !important;");
  });
});
