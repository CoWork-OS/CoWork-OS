import { memo, useCallback, useEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Plus, SquareTerminal, X } from "lucide-react";
import type { AgentTerminalTab, ShellSessionInfo, Workspace } from "../../shared/types";
import "@xterm/xterm/css/xterm.css";
import "./terminal-tabs-dock.css";

type TerminalHandle = {
  terminal: Terminal;
  fitAddon: FitAddon;
  disposables: Array<{ dispose: () => void }>;
  opened: boolean;
  /** Agent tabs: live output is ignored until the buffered output has been written. */
  replaying?: boolean;
};

const DIM = "\u001b[2m";
const RESET = "\u001b[0m";
const HIDE_CURSOR = "\u001b[?25l";

function agentTabsSupported(): boolean {
  return (
    window.coworkBrowserHost !== true &&
    typeof window.electronAPI?.listAgentTerminalTabs === "function"
  );
}

function describeAgentTabEnd(tab: AgentTerminalTab): string {
  if (tab.status === "running") return "";
  const text =
    tab.status === "stopped"
      ? "Stopped"
      : `Exited${tab.exitCode === null ? "" : ` with code ${tab.exitCode}`}`;
  return `\r\n${DIM}[${text}]${RESET}\r\n`;
}

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

/** Asks the dock to show a tab; a new requestId repeats the ask for the same tab. */
export type TerminalTabFocusRequest = { tabId: string; requestId: number };

export const TerminalTabsDock = memo(function TerminalTabsDock({
  workspace,
  taskId,
  focusRequest,
  onClose,
}: {
  workspace: Workspace | null;
  taskId?: string | null;
  focusRequest?: TerminalTabFocusRequest | null;
  onClose: () => void;
}) {
  const [tabs, setTabs] = useState<ShellSessionInfo[]>([]);
  const [agentTabs, setAgentTabs] = useState<AgentTerminalTab[]>([]);
  const [agentTabsLoaded, setAgentTabsLoaded] = useState(false);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [tabsLoaded, setTabsLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const agentTabIdsRef = useRef<Set<string>>(new Set());
  const agentTabsRef = useRef<AgentTerminalTab[]>([]);
  const dockBodyRef = useRef<HTMLDivElement | null>(null);
  const terminalHandlesRef = useRef<Record<string, TerminalHandle>>({});
  const terminalContainersRef = useRef<Record<string, HTMLDivElement | null>>({});
  const createInFlightRef = useRef(false);
  const autoCreateAttemptedRef = useRef(false);
  const userClosedAllTabsRef = useRef(false);
  const attachedTabIdsRef = useRef<Set<string>>(new Set());
  const selectedAgentTab = agentTabs.find((tab) => tab.id === activeTabId) || null;
  const activeTab = selectedAgentTab
    ? null
    : tabs.find((tab) => tab.id === activeTabId) || tabs[0] || null;
  const activeAgentTab = selectedAgentTab || (activeTab ? null : agentTabs[0] || null);
  const shownTabId = activeAgentTab?.id || activeTab?.id || null;
  const activeTabRunning = Boolean(
    activeAgentTab
      ? activeAgentTab.status === "running"
      : activeTab &&
          (activeTab.status === "running" ||
            (window.coworkBrowserHost === true && activeTab.status === "active")),
  );
  const activeTabIdRef = useRef<string | null>(null);

  useEffect(() => {
    activeTabIdRef.current = shownTabId;
  }, [shownTabId]);

  useEffect(() => {
    agentTabsRef.current = agentTabs;
    agentTabIdsRef.current = new Set(agentTabs.map((tab) => tab.id));
  }, [agentTabs]);

  const sendTerminalInput = useCallback(
    (tabId: string, input: string) => {
      if (!workspace?.id) return;
      void window.electronAPI
        .writeTerminalTabInput({
          tabId,
          workspaceId: workspace.id,
          ...(taskId ? { taskId } : {}),
          input,
        })
        .then(() => {
          setError(null);
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "Failed to send input.");
        });
    },
    [taskId, workspace?.id],
  );

  const refresh = useCallback(async (): Promise<ShellSessionInfo[]> => {
    if (!workspace?.id) return [];
    try {
      const nextTabs = await window.electronAPI.listTerminalTabs(workspace.id, taskId || undefined);
      const dedupedTabs = uniqueTabs(nextTabs);
      setTabs(dedupedTabs);
      setActiveTabId((current) => {
        if (current && dedupedTabs.some((tab) => tab.id === current)) return current;
        if (current && agentTabIdsRef.current.has(current)) return current;
        return dedupedTabs[0]?.id || null;
      });
      setError(null);
      setTabsLoaded(true);
      return dedupedTabs;
    } catch (err) {
      setTabs([]);
      setActiveTabId(null);
      setTabsLoaded(true);
      setError(err instanceof Error ? err.message : "Failed to load terminal tabs.");
      return [];
    }
  }, [taskId, workspace?.id]);

  const refreshAgentTabs = useCallback(async (): Promise<AgentTerminalTab[]> => {
    if (!taskId || !agentTabsSupported()) {
      setAgentTabs([]);
      setAgentTabsLoaded(true);
      return [];
    }
    try {
      const nextTabs = await window.electronAPI.listAgentTerminalTabs(taskId);
      agentTabIdsRef.current = new Set(nextTabs.map((tab) => tab.id));
      setAgentTabs(nextTabs);
      return nextTabs;
    } catch {
      // A task the window may not view has no agent tabs to show.
      setAgentTabs([]);
      return [];
    } finally {
      setAgentTabsLoaded(true);
    }
  }, [taskId]);

  const fitTerminal = useCallback((tabId: string) => {
    const handle = terminalHandlesRef.current[tabId];
    if (!handle?.opened) return;
    try {
      handle.fitAddon.fit();
    } catch {
      return;
    }
  }, []);

  const focusActiveTerminal = useCallback(() => {
    const tabId = activeTabIdRef.current;
    if (!tabId) return;
    requestAnimationFrame(() => {
      const handle = terminalHandlesRef.current[tabId];
      if (!handle?.opened) return;
      handle.terminal.focus();
    });
  }, []);

  const ensureTerminal = useCallback(
    (tabId: string): TerminalHandle => {
      const existing = terminalHandlesRef.current[tabId];
      if (existing) return existing;
      const terminal = new Terminal({
        allowProposedApi: false,
        convertEol: false,
        cursorBlink: true,
        cursorStyle: "block",
        disableStdin: false,
        fontFamily: readCssVar("--font-mono", '"SF Mono", Menlo, Monaco, Consolas, monospace'),
        fontSize: 12,
        letterSpacing: 0,
        lineHeight: 1.35,
        scrollback: 10_000,
        theme: buildTerminalTheme(),
      });
      const fitAddon = new FitAddon();
      const webLinksAddon = new WebLinksAddon((_event, uri) => {
        void window.electronAPI.openExternal(uri).catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "Failed to open link.");
        });
      });
      terminal.loadAddon(fitAddon);
      terminal.loadAddon(webLinksAddon);
      const disposables = [
        terminal.onResize(({ cols, rows }) => {
          if (!workspace?.id) return;
          void window.electronAPI
            .resizeTerminalTab({
              tabId,
              workspaceId: workspace.id,
              ...(taskId ? { taskId } : {}),
              cols,
              rows,
            })
            .then((updatedTab) => {
              setTabs((current) =>
                current.map((tab) => (tab.id === updatedTab.id ? updatedTab : tab)),
              );
            })
            .catch(() => {
              // Resize failures are non-fatal; the next fit will retry.
            });
        }),
        terminal.onData((data) => {
          if (activeTabIdRef.current !== tabId) return;
          sendTerminalInput(tabId, data);
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
    },
    [sendTerminalInput, taskId, workspace?.id],
  );

  /** A read-only terminal for an agent tab, filled with the process output buffered so far. */
  const ensureAgentTerminal = useCallback((tab: AgentTerminalTab): TerminalHandle => {
    const existing = terminalHandlesRef.current[tab.id];
    if (existing) return existing;
    const terminal = new Terminal({
      allowProposedApi: false,
      // Process output is plain text with bare newlines.
      convertEol: true,
      cursorBlink: false,
      disableStdin: true,
      fontFamily: readCssVar("--font-mono", '"SF Mono", Menlo, Monaco, Consolas, monospace'),
      fontSize: 12,
      letterSpacing: 0,
      lineHeight: 1.35,
      scrollback: 10_000,
      theme: buildTerminalTheme(),
    });
    const fitAddon = new FitAddon();
    terminal.loadAddon(fitAddon);
    terminal.loadAddon(
      new WebLinksAddon((_event, uri) => {
        void window.electronAPI.openExternal(uri).catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "Failed to open link.");
        });
      }),
    );
    const handle: TerminalHandle = {
      terminal,
      fitAddon,
      disposables: [],
      opened: false,
      replaying: true,
    };
    terminalHandlesRef.current[tab.id] = handle;
    terminal.write(HIDE_CURSOR);
    void window.electronAPI
      .readAgentTerminalTab({ taskId: tab.taskId, tabId: tab.id })
      .then((buffered) => {
        if (terminalHandlesRef.current[tab.id] !== handle) return;
        if (buffered.truncated) terminal.write(`${DIM}[earlier output not kept]${RESET}\r\n`);
        terminal.write(buffered.output);
        const latest = agentTabsRef.current.find((entry) => entry.id === tab.id) || tab;
        terminal.write(describeAgentTabEnd(latest));
      })
      .catch(() => {
        // The process is gone; its removal event drops the tab.
      })
      .finally(() => {
        handle.replaying = false;
      });
    return handle;
  }, []);

  const openTerminalInContainer = useCallback(
    (tabId: string, element: HTMLDivElement | null, agentTab?: AgentTerminalTab) => {
      terminalContainersRef.current[tabId] = element;
      if (!element) return;
      const handle = agentTab ? ensureAgentTerminal(agentTab) : ensureTerminal(tabId);
      if (!handle.opened) {
        handle.terminal.open(element);
        handle.opened = true;
      }
      requestAnimationFrame(() => {
        if (tabId !== activeTabIdRef.current) return;
        fitTerminal(tabId);
        if (!agentTab) handle.terminal.focus();
      });
    },
    [ensureAgentTerminal, ensureTerminal, fitTerminal],
  );

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
        ...(taskId ? { taskId } : {}),
        title: workspace.name || "Terminal",
      });
      setTabs((current) => uniqueTabs([...current, tab]));
      setActiveTabId(tab.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to create terminal tab.");
    } finally {
      createInFlightRef.current = false;
    }
  }, [taskId, workspace?.id, workspace?.name]);

  const stopTab = useCallback(async () => {
    if (activeAgentTab) {
      try {
        const stopped = await window.electronAPI.stopAgentTerminalTab({
          taskId: activeAgentTab.taskId,
          tabId: activeAgentTab.id,
        });
        setAgentTabs((current) => current.map((tab) => (tab.id === stopped.id ? stopped : tab)));
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to stop the process.");
      }
      return;
    }
    if (!workspace?.id || !activeTab) return;
    try {
      const updatedTab = await window.electronAPI.stopTerminalTab({
        tabId: activeTab.id,
        workspaceId: workspace.id,
        ...(taskId ? { taskId } : {}),
      });
      if (updatedTab) {
        setTabs((current) => current.map((tab) => (tab.id === updatedTab.id ? updatedTab : tab)));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to stop terminal tab.");
    }
  }, [activeAgentTab, activeTab, taskId, workspace?.id]);

  const closeAgentTab = useCallback(
    async (tab: AgentTerminalTab) => {
      setError(null);
      try {
        await window.electronAPI.closeAgentTerminalTab({ taskId: tab.taskId, tabId: tab.id });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to close the process tab.");
        return;
      }
      disposeTerminal(tab.id);
      // Closing the last tab leaves the panel empty, as closing the last shell tab does.
      if (tabs.length === 0 && agentTabsRef.current.every((entry) => entry.id === tab.id)) {
        userClosedAllTabsRef.current = true;
      }
      setAgentTabs((current) => current.filter((entry) => entry.id !== tab.id));
      setActiveTabId((activeId) => (activeId === tab.id ? null : activeId));
    },
    [disposeTerminal, tabs.length],
  );

  const closeTab = useCallback(
    async (tabId: string) => {
      if (!workspace?.id) return;
      const closingIndex = tabs.findIndex((tab) => tab.id === tabId);
      setError(null);
      try {
        await window.electronAPI.closeTerminalTab({
          tabId,
          workspaceId: workspace.id,
          ...(taskId ? { taskId } : {}),
        });
        disposeTerminal(tabId);
        setTabs((current) => {
          const next = uniqueTabs(current.filter((tab) => tab.id !== tabId));
          if (next.length === 0) {
            userClosedAllTabsRef.current = true;
            setActiveTabId(null);
            return next;
          }
          setActiveTabId((activeId) => {
            if (activeId && activeId !== tabId && next.some((tab) => tab.id === activeId))
              return activeId;
            return (
              next[Math.max(0, Math.min(closingIndex, next.length - 1))]?.id || next[0]?.id || null
            );
          });
          return next;
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to close terminal tab.");
      }
    },
    [disposeTerminal, tabs, taskId, workspace?.id],
  );

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

  // The agent's processes of this task, kept current by their start, exit and removal events.
  useEffect(() => {
    setAgentTabsLoaded(false);
    for (const tab of agentTabsRef.current) disposeTerminal(tab.id);
    setAgentTabs([]);
    void refreshAgentTabs();
    if (!taskId || !agentTabsSupported()) return;
    return window.electronAPI.onAgentTerminalEvent((event) => {
      if (event.taskId !== taskId) return;
      if (event.kind === "output") {
        const handle = terminalHandlesRef.current[event.tabId];
        if (handle && !handle.replaying && agentTabIdsRef.current.has(event.tabId)) {
          handle.terminal.write(event.output);
        }
        return;
      }
      if (event.kind === "removed") {
        disposeTerminal(event.tabId);
        agentTabIdsRef.current.delete(event.tabId);
        setAgentTabs((current) => current.filter((tab) => tab.id !== event.tabId));
        return;
      }
      const previous = agentTabsRef.current.find((tab) => tab.id === event.tab.id);
      const handle = terminalHandlesRef.current[event.tab.id];
      if (previous?.status === "running" && event.tab.status !== "running" && handle) {
        if (!handle.replaying) handle.terminal.write(describeAgentTabEnd(event.tab));
      }
      agentTabIdsRef.current.add(event.tab.id);
      // Updated now, not after the render, so a replay that finishes first sees the exit.
      agentTabsRef.current = previous
        ? agentTabsRef.current.map((tab) => (tab.id === event.tab.id ? event.tab : tab))
        : [...agentTabsRef.current, event.tab];
      setAgentTabs((current) =>
        current.some((tab) => tab.id === event.tab.id)
          ? current.map((tab) => (tab.id === event.tab.id ? event.tab : tab))
          : [...current, event.tab],
      );
    });
  }, [disposeTerminal, refreshAgentTabs, taskId]);

  // A code block ran in a tab, or an answer linked one, that the dock may not list yet:
  // reload, then show that tab.
  const handledFocusRequestRef = useRef<number | null>(null);
  useEffect(() => {
    if (!focusRequest || !workspace?.id) return;
    if (handledFocusRequestRef.current === focusRequest.requestId) return;
    handledFocusRequestRef.current = focusRequest.requestId;
    void Promise.all([refresh(), refreshAgentTabs()]).then(([nextTabs, nextAgentTabs]) => {
      const exists = [...nextTabs, ...nextAgentTabs].some((tab) => tab.id === focusRequest.tabId);
      setNotice(exists ? null : "That terminal tab is closed.");
      if (exists) setActiveTabId(focusRequest.tabId);
    });
  }, [focusRequest, refresh, refreshAgentTabs, workspace?.id]);

  // Open a shell when the panel would be empty; the agent's process tabs count as content.
  useEffect(() => {
    if (
      !tabsLoaded ||
      !agentTabsLoaded ||
      tabs.length > 0 ||
      agentTabs.length > 0 ||
      error ||
      autoCreateAttemptedRef.current ||
      userClosedAllTabsRef.current
    ) {
      return;
    }
    autoCreateAttemptedRef.current = true;
    void createTab();
  }, [agentTabs.length, agentTabsLoaded, createTab, error, tabs.length, tabsLoaded]);

  useEffect(() => {
    if (!workspace?.id) return;
    for (const tab of tabs) {
      ensureTerminal(tab.id);
      if (attachedTabIdsRef.current.has(tab.id)) continue;
      attachedTabIdsRef.current.add(tab.id);
      void window.electronAPI
        .writeTerminalTabInput({
          tabId: tab.id,
          workspaceId: workspace.id,
          ...(taskId ? { taskId } : {}),
          input: "",
        })
        .catch((err: unknown) => {
          setError(err instanceof Error ? err.message : "Failed to attach terminal tab.");
        });
    }
  }, [ensureTerminal, tabs, taskId, workspace?.id]);

  useEffect(() => {
    return window.electronAPI.onTerminalTabOutput((event) => {
      if (!workspace?.id || event.workspaceId !== workspace.id) return;
      const handle = ensureTerminal(event.tabId);
      handle.terminal.write(event.output);
      if (event.cwd || event.status) {
        setTabs((current) =>
          current.map((tab) =>
            tab.id === event.tabId
              ? {
                  ...tab,
                  cwd: event.cwd || tab.cwd,
                  status: event.status || tab.status,
                  updatedAt: event.timestamp,
                }
              : tab,
          ),
        );
      }
    });
  }, [ensureTerminal, workspace?.id]);

  useEffect(() => {
    if (!shownTabId) return;
    const agentTab = agentTabIdsRef.current.has(shownTabId);
    requestAnimationFrame(() => {
      fitTerminal(shownTabId);
      if (!agentTab) terminalHandlesRef.current[shownTabId]?.terminal.focus();
    });
  }, [fitTerminal, shownTabId]);

  useEffect(() => {
    window.addEventListener("focus", focusActiveTerminal);
    return () => window.removeEventListener("focus", focusActiveTerminal);
  }, [focusActiveTerminal]);

  useEffect(() => {
    const element = dockBodyRef.current;
    if (!element || !shownTabId) return;
    const resizeObserver = new ResizeObserver(() => {
      fitTerminal(shownTabId);
    });
    resizeObserver.observe(element);
    return () => resizeObserver.disconnect();
  }, [fitTerminal, shownTabId]);

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
            <div
              key={tab.id}
              className={`terminal-dock-tab-wrap ${activeTab?.id === tab.id ? "active" : ""}`}
            >
              <button
                type="button"
                className={`terminal-dock-tab ${activeTab?.id === tab.id ? "active" : ""}`}
                onClick={() => {
                  setNotice(null);
                  setActiveTabId(tab.id);
                }}
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
        ) : agentTabs.length === 0 ? (
          <button
            type="button"
            className="terminal-dock-tab active"
            onClick={() => void createTab()}
          >
            <SquareTerminal size={13} />
            <span>{workspace.name || "terminal"}</span>
          </button>
        ) : null}
        {agentTabs.map((tab) => (
          <div
            key={tab.id}
            className={`terminal-dock-tab-wrap ${activeAgentTab?.id === tab.id ? "active" : ""}`}
          >
            <button
              type="button"
              className={`terminal-dock-tab ${activeAgentTab?.id === tab.id ? "active" : ""}`}
              onClick={() => {
                setNotice(null);
                setActiveTabId(tab.id);
              }}
              title={`Started by the agent: ${tab.command}`}
            >
              <SquareTerminal size={13} />
              <span>{tab.title}</span>
              <span className={`terminal-dock-tab-status ${tab.status}`} />
            </button>
            <button
              type="button"
              className="terminal-dock-tab-close"
              onClick={(event) => {
                event.stopPropagation();
                void closeAgentTab(tab);
              }}
              title={tab.status === "running" ? "Stop and close" : "Close"}
              aria-label={tab.status === "running" ? "Stop process and close tab" : "Close tab"}
            >
              <X size={12} />
            </button>
          </div>
        ))}
        <button
          type="button"
          className="terminal-dock-icon-btn"
          onClick={() => void createTab()}
          title="New terminal tab"
        >
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
      <div ref={dockBodyRef} className="terminal-dock-body" onMouseDown={focusActiveTerminal}>
        {tabs.map((tab) => (
          <div
            key={tab.id}
            ref={(element) => openTerminalInContainer(tab.id, element)}
            className={`terminal-dock-xterm ${activeTab?.id === tab.id ? "active" : ""}`}
          />
        ))}
        {agentTabs.map((tab) => (
          <div
            key={tab.id}
            ref={(element) => openTerminalInContainer(tab.id, element, tab)}
            className={`terminal-dock-xterm ${activeAgentTab?.id === tab.id ? "active" : ""}`}
          />
        ))}
        {error ? (
          <div className="terminal-dock-error">{error}</div>
        ) : notice ? (
          <div className="terminal-dock-notice" role="status">
            {notice}
          </div>
        ) : null}
      </div>
    </section>
  );
});
