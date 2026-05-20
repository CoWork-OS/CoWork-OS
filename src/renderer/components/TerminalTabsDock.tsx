import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Play, Plus, SquareTerminal, X } from "lucide-react";
import type { ShellSessionInfo, Workspace } from "../../shared/types";
import "@xterm/xterm/css/xterm.css";
import "./terminal-tabs-dock.css";

type TerminalHandle = {
  terminal: Terminal;
  fitAddon: FitAddon;
  disposables: Array<{ dispose: () => void }>;
  opened: boolean;
};

function uniqueTabs(tabs: ShellSessionInfo[]): ShellSessionInfo[] {
  const byId = new Map<string, ShellSessionInfo>();
  for (const tab of tabs) {
    byId.set(tab.id, tab);
  }
  return Array.from(byId.values());
}

function getTabLabel(tab: ShellSessionInfo, workspace: Workspace): string {
  return tab.cwd.split(/[\\/]/).filter(Boolean).pop() || workspace.name || "terminal";
}

function readCssVar(name: string, fallback: string): string {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return value || fallback;
}

function buildTerminalTheme() {
  return {
    background: readCssVar("--color-bg-primary", "#ffffff"),
    foreground: readCssVar("--color-text-primary", "#242424"),
    cursor: readCssVar("--color-text-primary", "#242424"),
    selectionBackground: readCssVar("--color-selection-bg", "rgba(125, 94, 255, 0.28)"),
  };
}

export const TerminalTabsDock = memo(function TerminalTabsDock({
  workspace,
  taskId,
  onClose,
}: {
  workspace: Workspace | null;
  taskId?: string | null;
  onClose: () => void;
}) {
  const [tabs, setTabs] = useState<ShellSessionInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [tabsLoaded, setTabsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [commandDrafts, setCommandDrafts] = useState<Record<string, string>>({});
  const dockBodyRef = useRef<HTMLDivElement | null>(null);
  const terminalHandlesRef = useRef<Record<string, TerminalHandle>>({});
  const terminalContainersRef = useRef<Record<string, HTMLDivElement | null>>({});
  const createInFlightRef = useRef(false);
  const autoCreateAttemptedRef = useRef(false);
  const userClosedAllTabsRef = useRef(false);
  const attachedTabIdsRef = useRef<Set<string>>(new Set());
  const activeTab = tabs.find((tab) => tab.id === activeTabId) || tabs[0] || null;
  const activeTabRunning = Boolean(activeTab && activeTab.status === "running");
  const commandDraft = activeTab ? commandDrafts[activeTab.id] || "" : "";

  const refresh = useCallback(async () => {
    if (!workspace?.id) return;
    try {
      const nextTabs = await window.electronAPI.listTerminalTabs(workspace.id);
      const dedupedTabs = uniqueTabs(nextTabs);
      setTabs(dedupedTabs);
      setActiveTabId((current) => {
        if (current && dedupedTabs.some((tab) => tab.id === current)) return current;
        return dedupedTabs[0]?.id || null;
      });
      setError(null);
      setTabsLoaded(true);
    } catch (err) {
      setTabs([]);
      setActiveTabId(null);
      setTabsLoaded(true);
      setError(err instanceof Error ? err.message : "Failed to load terminal tabs.");
    }
  }, [workspace?.id]);

  const fitTerminal = useCallback((tabId: string) => {
    const handle = terminalHandlesRef.current[tabId];
    if (!handle?.opened) return;
    try {
      handle.fitAddon.fit();
    } catch {
      return;
    }
  }, []);

  const ensureTerminal = useCallback((tabId: string): TerminalHandle => {
    const existing = terminalHandlesRef.current[tabId];
    if (existing) return existing;
    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: false,
      cursorBlink: true,
      cursorStyle: "block",
      disableStdin: true,
      fontFamily: readCssVar("--font-mono", '"SF Mono", Menlo, Monaco, Consolas, monospace'),
      fontSize: 12,
      letterSpacing: 0,
      lineHeight: 1.35,
      scrollback: 10_000,
      theme: buildTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    const webLinksAddon = new WebLinksAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(webLinksAddon);
    const disposables = [
      terminal.onResize(({ cols, rows }) => {
        if (!workspace?.id) return;
        void window.electronAPI.resizeTerminalTab({
          tabId,
          workspaceId: workspace.id,
          cols,
          rows,
        }).then((updatedTab) => {
          setTabs((current) => current.map((tab) => (tab.id === updatedTab.id ? updatedTab : tab)));
        }).catch(() => {
          // Resize failures are non-fatal; the next fit will retry.
        });
      }),
    ];
    const handle: TerminalHandle = {
      terminal,
      fitAddon,
      disposables,
      opened: false,
    };
    terminalHandlesRef.current[tabId] = handle;
    return handle;
  }, [workspace?.id]);

  const runCommand = useCallback(async () => {
    if (!workspace?.id || !activeTab) return;
    const command = commandDraft.trim();
    if (!command) return;
    const activeTaskId = typeof taskId === "string" ? taskId.trim() : "";
    if (!activeTaskId) {
      setError("Select a task before running terminal commands.");
      return;
    }
    setError(null);
    try {
      const result = await window.electronAPI.runTerminalTabCommand({
        tabId: activeTab.id,
        workspaceId: workspace.id,
        taskId: activeTaskId,
        command,
        cwd: activeTab.cwd,
      });
      setTabs((current) => current.map((tab) => (tab.id === result.tab.id ? result.tab : tab)));
      setCommandDrafts((current) => ({ ...current, [activeTab.id]: "" }));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Terminal command failed.");
    }
  }, [activeTab, commandDraft, taskId, workspace?.id]);

  const openTerminalInContainer = useCallback((tabId: string, element: HTMLDivElement | null) => {
    terminalContainersRef.current[tabId] = element;
    if (!element) return;
    const handle = ensureTerminal(tabId);
    if (!handle.opened) {
      handle.terminal.open(element);
      handle.opened = true;
    }
    requestAnimationFrame(() => {
      if (tabId !== activeTabId) return;
      fitTerminal(tabId);
      handle.terminal.focus();
    });
  }, [activeTabId, ensureTerminal, fitTerminal]);

  const disposeTerminal = useCallback((tabId: string) => {
    const handle = terminalHandlesRef.current[tabId];
    if (!handle) return;
    for (const disposable of handle.disposables) {
      disposable.dispose();
    }
    handle.terminal.dispose();
    delete terminalHandlesRef.current[tabId];
    delete terminalContainersRef.current[tabId];
    attachedTabIdsRef.current.delete(tabId);
  }, []);

  const createTab = useCallback(async () => {
    if (!workspace?.id) return;
    if (createInFlightRef.current) return;
    createInFlightRef.current = true;
    userClosedAllTabsRef.current = false;
    setError(null);
    try {
      const tab = await window.electronAPI.createTerminalTab({
        workspaceId: workspace.id,
        title: workspace.name || "Terminal",
      });
      setTabs((current) => uniqueTabs([...current, tab]));
      setActiveTabId(tab.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create terminal tab.");
    } finally {
      createInFlightRef.current = false;
    }
  }, [workspace?.id, workspace?.name]);

  const stopTab = useCallback(async () => {
    if (!workspace?.id || !activeTab) return;
    try {
      const updatedTab = await window.electronAPI.stopTerminalTab({
        tabId: activeTab.id,
        workspaceId: workspace.id,
      });
      if (updatedTab) {
        setTabs((current) => current.map((tab) => (tab.id === updatedTab.id ? updatedTab : tab)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop terminal tab.");
    }
  }, [activeTab, workspace?.id]);

  const closeTab = useCallback(async (tabId: string) => {
    if (!workspace?.id) return;
    const closingIndex = tabs.findIndex((tab) => tab.id === tabId);
    setError(null);
    try {
      await window.electronAPI.closeTerminalTab({ tabId, workspaceId: workspace.id });
      disposeTerminal(tabId);
      setTabs((current) => {
        const next = uniqueTabs(current.filter((tab) => tab.id !== tabId));
        if (next.length === 0) {
          userClosedAllTabsRef.current = true;
          setActiveTabId(null);
          return next;
        }
        setActiveTabId((activeId) => {
          if (activeId && activeId !== tabId && next.some((tab) => tab.id === activeId)) return activeId;
          return next[Math.max(0, Math.min(closingIndex, next.length - 1))]?.id || next[0]?.id || null;
        });
        return next;
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to close terminal tab.");
    }
  }, [disposeTerminal, tabs, workspace?.id]);

  useEffect(() => {
    if (!workspace?.id) return;
    setTabsLoaded(false);
    autoCreateAttemptedRef.current = false;
    userClosedAllTabsRef.current = false;
    attachedTabIdsRef.current.clear();
    for (const tabId of Object.keys(terminalHandlesRef.current)) {
      disposeTerminal(tabId);
    }
    void refresh();
  }, [disposeTerminal, refresh, workspace?.id]);

  useEffect(() => {
    if (
      !tabsLoaded ||
      tabs.length > 0 ||
      error ||
      autoCreateAttemptedRef.current ||
      userClosedAllTabsRef.current
    ) {
      return;
    }
    autoCreateAttemptedRef.current = true;
    void createTab();
  }, [createTab, error, tabs.length, tabsLoaded]);

  useEffect(() => {
    if (!workspace?.id) return;
    for (const tab of tabs) {
      ensureTerminal(tab.id);
      if (attachedTabIdsRef.current.has(tab.id)) continue;
      attachedTabIdsRef.current.add(tab.id);
      void window.electronAPI.writeTerminalTabInput({
        tabId: tab.id,
        workspaceId: workspace.id,
        input: "",
      }).catch((err: unknown) => {
        setError(err instanceof Error ? err.message : "Failed to attach terminal tab.");
      });
    }
  }, [ensureTerminal, tabs, workspace?.id]);

  useEffect(() => {
    return window.electronAPI.onTerminalTabOutput((event) => {
      if (!workspace?.id || event.workspaceId !== workspace.id) return;
      const handle = ensureTerminal(event.tabId);
      handle.terminal.write(event.output);
      if (event.cwd || event.status) {
        setTabs((current) => current.map((tab) => (
          tab.id === event.tabId
            ? {
              ...tab,
              cwd: event.cwd || tab.cwd,
              status: event.status || tab.status,
              updatedAt: event.timestamp,
            }
            : tab
        )));
      }
    });
  }, [ensureTerminal, workspace?.id]);

  useEffect(() => {
    if (!activeTabId) return;
    requestAnimationFrame(() => {
      fitTerminal(activeTabId);
      terminalHandlesRef.current[activeTabId]?.terminal.focus();
    });
  }, [activeTabId, fitTerminal]);

  useEffect(() => {
    const element = dockBodyRef.current;
    if (!element || !activeTabId) return;
    const resizeObserver = new ResizeObserver(() => {
      fitTerminal(activeTabId);
    });
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [activeTabId, fitTerminal]);

  useEffect(() => {
    return () => {
      for (const tabId of Object.keys(terminalHandlesRef.current)) {
        disposeTerminal(tabId);
      }
    };
  }, [disposeTerminal]);

  if (!workspace) return null;

  return (
    <section className="terminal-dock" aria-label="Terminal tabs">
      <div className="terminal-dock-tabbar">
        {tabs.length > 0 ? (
          tabs.map((tab) => (
            <div key={tab.id} className={`terminal-dock-tab-wrap ${activeTab?.id === tab.id ? "active" : ""}`}>
              <button
                type="button"
                className={`terminal-dock-tab ${activeTab?.id === tab.id ? "active" : ""}`}
                onClick={() => setActiveTabId(tab.id)}
                title={tab.cwd}
              >
                <SquareTerminal size={13} />
                <span>{getTabLabel(tab, workspace)}</span>
                <span className={`terminal-dock-tab-status ${tab.status}`} />
              </button>
              <button
                type="button"
                className="terminal-dock-tab-close"
                onClick={(event) => {
                  event.stopPropagation();
                  void closeTab(tab.id);
                }}
                title="Close terminal tab"
                aria-label="Close terminal tab"
              >
                <X size={12} />
              </button>
            </div>
          ))
        ) : (
          <button type="button" className="terminal-dock-tab active" onClick={() => void createTab()}>
            <SquareTerminal size={13} />
            <span>{workspace.name || "terminal"}</span>
          </button>
        )}
        <button type="button" className="terminal-dock-icon-btn" onClick={() => void createTab()} title="New terminal tab">
          <Plus size={14} />
        </button>
        <div className="terminal-dock-spacer" />
        {activeTabRunning && (
          <button type="button" className="terminal-dock-action" onClick={() => void stopTab()}>
            Stop
          </button>
        )}
        <button
          type="button"
          className="terminal-dock-icon-btn"
          onClick={onClose}
          title="Close terminal"
        >
          <X size={14} />
        </button>
      </div>
      <div ref={dockBodyRef} className="terminal-dock-body">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            ref={(element) => openTerminalInContainer(tab.id, element)}
            className={`terminal-dock-xterm ${activeTab?.id === tab.id ? "active" : ""}`}
          />
        ))}
        {error && <div className="terminal-dock-error">{error}</div>}
      </div>
      <form
        className="terminal-dock-commandbar"
        onSubmit={(event) => {
          event.preventDefault();
          void runCommand();
        }}
      >
        <span className="terminal-dock-prompt">$</span>
        <input
          value={commandDraft}
          onChange={(event) => {
            const tabId = activeTab?.id;
            if (!tabId) return;
            setCommandDrafts((current) => ({
              ...current,
              [tabId]: event.target.value,
            }));
          }}
          disabled={!activeTab || activeTabRunning}
          spellCheck={false}
          aria-label="Terminal command"
        />
        <button
          type="submit"
          className="terminal-dock-icon-btn"
          disabled={!activeTab || activeTabRunning || !commandDraft.trim()}
          title="Run command"
        >
          <Play size={14} />
        </button>
      </form>
    </section>
  );
});
