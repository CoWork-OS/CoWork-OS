import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const componentPath = fileURLToPath(new URL("../BrowserWorkbenchView.tsx", import.meta.url));
const tabViewPath = fileURLToPath(
  new URL("../BrowserWorkbench/BrowserTabView.tsx", import.meta.url),
);
const tabNoticePath = fileURLToPath(
  new URL("../BrowserWorkbench/BrowserTabNotice.tsx", import.meta.url),
);

describe("Browser workbench navigation controls", () => {
  it("keeps one registered webview per tab and loads it only after registration", () => {
    const source = readFileSync(componentPath, "utf8");
    const tabView = readFileSync(tabViewPath, "utf8");

    expect(source).toContain("<BrowserTabView");
    expect(source).toContain("key={`${tab.id}:${tab.generation}`}");
    expect(source).not.toContain('addEventListener("new-window"');
    expect(tabView).toContain("registerBrowserWorkbenchSession");
    expect(tabView).toContain("tabId: tab.id");
    expect(tabView).toContain('src={srcUrl || "about:blank"}');
    // Hidden tabs keep their guest attached.
    expect(tabView).toContain('"is-hidden"');
    expect(tabView).not.toContain("display: none");
  });

  it("reports status for the tab active now, not the one active when a tab mounted", () => {
    const source = readFileSync(componentPath, "utf8");
    const statusMatch = source.match(/const handleTabStatus = useCallback\([\s\S]*?\}, \[\]\);/);

    expect(statusMatch?.[0]).toContain("tabId !== activeTabIdRef.current");
    expect(source).toContain("activeTabIdRef.current = activeTabId;");
  });

  it("never lets an older navigation or the initial URL override a newer one", () => {
    const tabView = readFileSync(tabViewPath, "utf8");
    const registerMatch = tabView.match(/const register = async \(\) => \{[\s\S]*?\n    \};/);

    expect(tabView).toContain("const seq = ++navigationSeqRef.current;");
    expect(tabView).toContain("checkUserNavigation(tab.id, url, isCurrent)");
    expect(registerMatch?.[0]).toContain("if (seq > 0) return;");
    expect(registerMatch?.[0]).toContain("if (!isCurrent()) return;");
  });

  it("goes back from a blocked navigation to the page still loaded under it", () => {
    const tabView = readFileSync(tabViewPath, "utf8");

    expect(tabView).toContain(
      'const loadedUrl = tabRef.current.blocked ? getLoadedPageUrl() : "";',
    );
    expect(tabView).toContain("onUpdate(tab.id, { url: loadedUrl, blocked: undefined });");
  });

  it("does not require the dom-ready flag before invoking toolbar navigation commands", () => {
    const source = readFileSync(componentPath, "utf8");
    const commandMatch = source.match(/const runWebviewCommand = useCallback\([\s\S]*?\n  \);/);

    expect(commandMatch?.[0]).not.toContain("!webviewDomReadyRef.current");
  });

  it("blocks crash-only schemes and recovers a lost guest renderer", () => {
    const source = readFileSync(componentPath, "utf8");

    const tabView = readFileSync(tabViewPath, "utf8");
    const notice = readFileSync(tabNoticePath, "utf8");

    expect(source).toContain('new Set(["http:", "https:"])');
    expect(source).toContain('const initialNavigationUrl = normalizeUrl(initialUrl || "")');
    expect(tabView).toContain('webview.addEventListener("render-process-gone"');
    expect(tabView).toContain('webview.removeEventListener("render-process-gone"');
    expect(source).toContain('setToolbarNotice("Only http:// and https:// URLs are supported")');
    expect(notice).toContain("This page crashed");
    expect(source).toContain("reloadCrashedTab(tab.id)");
  });

  it("shows the connection only in the address bar, not as a separate pill", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).not.toContain('className="browser-workbench-profile"');
    expect(source).not.toContain('"workspace"');
    expect(source).not.toContain("Workspace browser");
  });

  it("listens for agent-driven viewport changes and exposes viewport presets", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("onBrowserWorkbenchViewport");
    expect(source).toContain("VIEWPORT_PRESETS");
    // Presets live in the toolbar's More menu; a forced size shows as a chip.
    expect(source).toContain("<ToolbarMenu");
    expect(source).toContain("viewports={VIEWPORT_PRESETS}");
    expect(source).toContain("browser-workbench-size-chip");
    expect(source).toContain("has-controlled-viewport");
  });

  it("exposes a toolbar action for opening the current page externally", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("openCurrentPageExternal");
    expect(source).toContain("window.electronAPI.openExternal(externalUrl)");
    expect(source).toContain("onOpenExternal={() => void openCurrentPageExternal()}");
    expect(source).toContain("getExternalBrowserUrl");
  });

  it("wires live page annotations through inspect, persistence, and follow-up send", () => {
    const source = readFileSync(componentPath, "utf8");

    expect(source).toContain("inspectBrowserWorkbenchPoint");
    expect(source).toContain("resolveBrowserWorkbenchAnnotationTargets");
    expect(source).toContain("createAnnotation");
    expect(source).toContain("listAnnotations");
    expect(source).toContain("getAnnotationUrlKey");
    expect(source).toContain("liveAnnotationInspectRequestIdRef");
    expect(source).toContain("browser-live-annotation-layer");
    expect(source).toContain("Address annotation ${created.id}: ${body}");
  });
});
