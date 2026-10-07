import { BotNotificationPanel } from "./BotNotificationPanel";
import { BotWorkResultCard } from "./BotWorkResultCard";
import { BotResponsibilityPanel } from "./BotResponsibilityPanel";
import { useEffect, useRef, useState, useMemo, useSyncExternalStore, useCallback } from "react";
import { createPortal } from "react-dom";
import {
  BookOpen,
  CalendarClock,
  ClipboardList,
  LoaderCircle,
  MoreHorizontal,
  Pause,
  Play,
  RefreshCw,
  X,
} from "lucide-react";
import type { BotWorkItem, BotWorkPage, BotWorkView, Workspace } from "../../shared/types";
import { isTempWorkspaceId } from "../../shared/types";
import { BotWorkLoader } from "../utils/bot-work-loader";
import {
  BotWorkControls,
  controlNeedsReconciliation,
  type BotWorkControlState,
} from "../utils/bot-work-controls";
import { hasHostMethods } from "../host/browser-capabilities";
import { resolveBotMascot } from "../../shared/bot-mascots";
import { BotMascot } from "./bot-mascot/BotMascot";
import type { MascotExpression } from "./bot-mascot/mascot-eyes";
import { formatNextRun } from "../utils/next-run";
import "./bot-work.css";

export type BotWorkDialogTab = BotWorkView | "setup";
type DialogTab = BotWorkDialogTab;
const views: Array<{ id: BotWorkView; label: string; empty: string }> = [
  { id: "needs_you", label: "Needs you", empty: "Nothing needs you right now." },
  { id: "working", label: "Working", empty: "Nothing is running." },
  { id: "scheduled", label: "Scheduled", empty: "Nothing is scheduled." },
  { id: "results", label: "Results", empty: "No finished work yet." },
];
const tabs: Array<{ id: DialogTab; label: string }> = [
  ...views.map(({ id, label }) => ({ id, label })),
  { id: "setup", label: "Setup" },
];

function ago(timestamp: number): string {
  const minutes = Math.round((Date.now() - timestamp) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function plural(count: number, one: string, many = `${one}s`): string {
  return `${count} ${count === 1 ? one : many}`;
}

/** The header character mirrors the bot's state. */
function headerExpression(
  paused: boolean,
  counts: Record<BotWorkView, number> | null,
): MascotExpression {
  if (paused) return "sleeping";
  if ((counts?.needs_you ?? 0) > 0) return "attention";
  if ((counts?.working ?? 0) > 0) return "working";
  return "idle";
}

/** One plain sentence for the latest bot control, instead of a receipt dump. */
function controlNotice(control: BotWorkControlState): string | null {
  const request = control.request;
  if (!request) return null;
  if (control.busy) {
    return request.action === "pause_bot"
      ? "Pausing…"
      : request.action === "resume_bot"
        ? "Resuming…"
        : request.action === "resume_turn"
          ? "Allowing a new follow-up…"
          : "Stopping…";
  }
  if (control.error) return "That didn't go through.";
  const receipt = control.receipt;
  if (!receipt) {
    return request.action === "resume_bot" && !controlNeedsReconciliation(control)
      ? "A newer pause or resume replaced this one."
      : "Not confirmed yet.";
  }
  const running = receipt.stillActiveTaskIds.length;
  if (receipt.action === "pause_bot")
    return `Paused. Scheduled and new work won't start${running ? `; ${plural(running, "running item")} keep going` : ""}.`;
  if (receipt.action === "resume_bot") return "Resumed. Scheduled work will run again.";
  if (receipt.action === "resume_turn") return "Ready for a new follow-up.";
  if (receipt.status === "pending") return "Stopping… finishing cleanup.";
  if (running) return `${plural(running, "item")} couldn't be confirmed stopped.`;
  const stopped = receipt.tasks.length;
  const suffix = receipt.action === "stop_and_pause" ? " Bot paused." : "";
  return stopped ? `Stopped ${plural(stopped, "item")}.${suffix}` : `Nothing was running.${suffix}`;
}

function itemState(item: BotWorkItem): string {
  if (item.schedulePaused === "bot") return "Paused with the bot — won't run until resumed";
  if (item.schedulePaused === "responsibility") return "Paused — won't run until resumed";
  if (item.waitingKind === "approval") return "Waiting for your approval";
  if (item.waitingKind === "input") return "Has a question for you";
  if (item.waitingReason) return item.waitingReason;
  if (item.waitingKind === "child") return "Waiting on a teammate";
  if (item.waitingKind === "external") return "Waiting on a dependency";
  if (item.waitingKind === "reconnect") return "Waiting to reconnect";
  if (item.status === "scheduled") return item.scheduleId ? "Scheduled" : "Queued";
  if (item.status === "paused") return "Paused — waiting for you";
  if (item.status === "interrupted") return "Interrupted — needs a decision to continue";
  if (item.status === "executing" || item.status === "planning") return "Running";
  return item.status.replaceAll("_", " ");
}

export function BotWorkDialog({
  workspaceId: initialWorkspaceId,
  botId,
  botName,
  botIcon,
  initialTab = "needs_you",
  onClose,
  onSelectTask,
  onOpenContext,
}: {
  workspaceId: string;
  botId: string;
  botName: string;
  /** The bot's icon value; the header shows its character. */
  botIcon?: string;
  initialTab?: DialogTab;
  onClose: () => void;
  onOpenContext?: (workspaceId: string) => void;
  onSelectTask: (id: string | null) => void;
}) {
  const [workspaceId, setWorkspaceId] = useState(initialWorkspaceId);
  const [workspaces, setWorkspaces] = useState<Array<{ id: string; name: string; count?: number }>>(
    [],
  );
  const [tab, setTab] = useState<DialogTab>(initialTab);
  const view: BotWorkView = tab === "setup" ? "needs_you" : tab;
  const [page, setPage] = useState<BotWorkPage | null>(null);
  const [counts, setCounts] = useState<Record<BotWorkView, number> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refresh, setRefresh] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  const dialogRef = useRef<HTMLDialogElement>(null);
  const loaderRef = useRef<BotWorkLoader | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  // Settled results of controls from an earlier session are not news; only show newer ones.
  const openedAt = useRef(Date.now());
  const controlAvailable =
    hasHostMethods("stopBotWork", "getBotWorkControl") &&
    typeof window.electronAPI.stopBotWork === "function" &&
    typeof window.electronAPI.getBotWorkControl === "function";
  const futureAvailable =
    controlAvailable &&
    hasHostMethods("getBotFutureControl") &&
    typeof window.electronAPI.getBotFutureControl === "function";
  const workChanged = useCallback(() => setRefresh((value) => value + 1), []);
  const controls = useMemo(
    () => new BotWorkControls(window.electronAPI, { workspaceId, agentRoleId: botId }, workChanged),
    [workspaceId, botId, workChanged],
  );
  const control = useSyncExternalStore(controls.subscribe, controls.getSnapshot);
  const controlLocked = control.busy || controlNeedsReconciliation(control);
  const paused = control.future?.futurePaused === true;
  useEffect(() => {
    if (controlAvailable) controls.activate();
    return () => controls.dispose();
  }, [controls, controlAvailable]);

  useEffect(() => {
    const previousFocus = document.activeElement;
    dialogRef.current?.showModal();
    return () => {
      if (previousFocus instanceof HTMLElement) previousFocus.focus();
    };
  }, []);

  // Workspaces where this bot has work. A chat started from a temporary workspace
  // should not hide the bot's real work, so prefer the busiest saved workspace.
  useEffect(() => {
    let disposed = false;
    if (typeof window.electronAPI.listWorkspaces !== "function") return;
    void window.electronAPI
      .listWorkspaces()
      .then(async (all: Workspace[]) => {
        const candidates = all
          .filter(
            (workspace) => !isTempWorkspaceId(workspace.id) || workspace.id === initialWorkspaceId,
          )
          .slice(0, 12);
        const probed = await Promise.all(
          candidates.map(async (workspace) => {
            try {
              const probe = await window.electronAPI.listBotWork({
                workspaceId: workspace.id,
                agentRoleId: botId,
                view: "needs_you",
                limit: 1,
              });
              const count = Object.values(probe.counts).reduce((sum, value) => sum + value, 0);
              return { id: workspace.id, name: workspace.name, count };
            } catch {
              return { id: workspace.id, name: workspace.name };
            }
          }),
        );
        if (disposed) return;
        setWorkspaces(probed);
        const current = probed.find((workspace) => workspace.id === initialWorkspaceId);
        if (!current?.count) {
          const busiest = [...probed].sort((a, b) => (b.count ?? 0) - (a.count ?? 0))[0];
          if (busiest?.count) setWorkspaceId(busiest.id);
        }
      })
      .catch(() => {});
    return () => {
      disposed = true;
    };
  }, [initialWorkspaceId, botId]);

  useEffect(() => {
    setPage(null);
    setError(null);
    setLoading(true);
    const loader = new BotWorkLoader(
      (query) => window.electronAPI.listBotWork(query),
      { workspaceId, agentRoleId: botId, view, limit: 25 },
      (state) => {
        setPage(state.page);
        setError(state.error);
        setLoading(state.loading);
        if (
          state.page &&
          state.page.workspaceId === workspaceId &&
          state.page.agentRoleId === botId
        )
          setCounts(state.page.counts);
      },
    );
    loaderRef.current = loader;
    void loader.load();
    return () => {
      loader.dispose();
      loaderRef.current = null;
    };
  }, [workspaceId, botId, view, refresh]);

  useEffect(() => {
    setCounts(null);
    setDismissed(null);
  }, [workspaceId]);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsubscribe = window.electronAPI.onTaskEvent?.(() => {
      // Coalesce event bursts while the summary view is open; do not load transcripts.
      if (timer) return;
      timer = setTimeout(() => {
        timer = undefined;
        setRefresh((value) => value + 1);
      }, 1000);
    });
    return () => {
      unsubscribe?.();
      if (timer) clearTimeout(timer);
    };
  }, []);

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  // A prop change must hide the previous bot/view synchronously, before effects run.
  const current =
    page?.workspaceId === workspaceId && page.agentRoleId === botId && page.view === view
      ? page
      : null;
  const notice = controlNotice(control);
  const noticeKey = control.request ? `${control.request.requestId}:${notice}` : null;
  const recent = !control.receipt || control.receipt.updatedAt >= openedAt.current - 1000;
  const showNotice =
    !!notice &&
    (controlLocked || control.busy || !!control.error || (recent && dismissed !== noticeKey));
  const openTask = (taskId?: string) => {
    onSelectTask(taskId ?? null);
    onClose();
  };
  const titleFor = (taskId: string) =>
    current?.items.find((item) => item.taskId === taskId)?.title ?? "Work item";
  const currentWorkspace = workspaces.find((workspace) => workspace.id === workspaceId);

  return createPortal(
    <dialog
      ref={dialogRef}
      className="bot-work-dialog"
      aria-labelledby="bot-work-title"
      onCancel={onClose}
    >
      <header className="bot-work-header">
        <div className="bot-work-identity">
          <BotMascot
            mascot={resolveBotMascot(botIcon)}
            size={40}
            expression={headerExpression(paused, counts)}
          />
          <h2 id="bot-work-title">{botName}</h2>
          {control.future && (
            <span className={`bot-work-status ${paused ? "paused" : "active"}`}>
              {paused ? "Paused" : "Active"}
            </span>
          )}
        </div>
        <div className="bot-work-header-actions">
          {futureAvailable && (
            <button
              type="button"
              disabled={controlLocked || !control.future || !!control.futureError}
              title={
                paused
                  ? "Let scheduled and new work start again"
                  : "Scheduled and new work won't start. Running work keeps going."
              }
              onClick={() =>
                void controls.start(
                  paused ? "resume_bot" : "pause_bot",
                  undefined,
                  undefined,
                  paused ? control.future?.futureControlVersion : undefined,
                )
              }
            >
              {paused ? <Play size={14} /> : <Pause size={14} />}
              {paused ? "Resume bot" : "Pause bot"}
            </button>
          )}
          <div className="bot-work-menu" ref={menuRef}>
            <button
              type="button"
              className="bot-work-icon"
              aria-label="More bot actions"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen((open) => !open)}
            >
              <MoreHorizontal size={18} />
            </button>
            {menuOpen && (
              <div role="menu" className="bot-work-menu-list">
                <button
                  type="button"
                  role="menuitem"
                  disabled={!controlAvailable || controlLocked}
                  onClick={() => {
                    setMenuOpen(false);
                    void controls.start("stop_bot");
                  }}
                >
                  Stop all running work
                  <small>Stops what this bot is doing in this workspace</small>
                </button>
                {futureAvailable && (
                  <button
                    type="button"
                    role="menuitem"
                    disabled={controlLocked}
                    onClick={() => {
                      setMenuOpen(false);
                      void controls.start("stop_and_pause");
                    }}
                  >
                    Stop all and pause
                    <small>Stops running work and keeps the bot paused</small>
                  </button>
                )}
                {onOpenContext && (
                  <button
                    type="button"
                    role="menuitem"
                    onClick={() => {
                      setMenuOpen(false);
                      onOpenContext(workspaceId);
                    }}
                  >
                    What this bot knows
                    <small>Open memory for this workspace</small>
                  </button>
                )}
              </div>
            )}
          </div>
          <button
            type="button"
            className="bot-work-icon"
            onClick={() => {
              setRefresh((value) => value + 1);
              void controls.refreshFuture();
            }}
            aria-label="Refresh bot work"
            disabled={loading}
          >
            <RefreshCw size={16} />
          </button>
          <button
            type="button"
            className="bot-work-icon"
            onClick={onClose}
            aria-label="Close bot work"
          >
            <X size={18} />
          </button>
        </div>
      </header>
      <div className="bot-work-subhead">
        {workspaces.length > 1 ? (
          <label className="bot-work-workspace">
            <span>Workspace</span>
            <select value={workspaceId} onChange={(event) => setWorkspaceId(event.target.value)}>
              {workspaces.map((workspace) => (
                <option key={workspace.id} value={workspace.id}>
                  {workspace.name}
                  {workspace.count ? ` · ${workspace.count}` : ""}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <span className="bot-work-workspace">{currentWorkspace?.name ?? "This workspace"}</span>
        )}
        {!controlAvailable && <span className="bot-work-muted">Controls unavailable here</span>}
        {control.futureError && <span className="bot-work-muted">{control.futureError}</span>}
      </div>
      {control.recoveryWarning && (
        <p className="bot-work-notice warning" role="alert">
          {control.recoveryWarning}
        </p>
      )}
      {showNotice && (
        <div className="bot-work-notice" role="status" aria-live="polite">
          <span>
            {control.busy && <LoaderCircle className="spinning" size={14} />}
            {notice}
            {control.error && <em> {control.error}</em>}
          </span>
          <span className="bot-work-notice-actions">
            {!!(control.receipt?.tasks.length || control.stopped.length) && (
              <button type="button" onClick={() => setShowDetails((open) => !open)}>
                {showDetails ? "Hide details" : "Details"}
              </button>
            )}
            {controlLocked && !control.busy && (
              <button
                type="button"
                disabled={!controlAvailable}
                onClick={() => void controls.retry()}
              >
                Try again
              </button>
            )}
            {control.request && !control.busy && controlLocked && (
              <button
                type="button"
                disabled={!controlAvailable}
                onClick={() => void controls.check()}
              >
                Check again
              </button>
            )}
            {!controlLocked && !control.busy && (
              <button
                type="button"
                aria-label="Dismiss"
                className="bot-work-icon"
                onClick={() => setDismissed(noticeKey)}
              >
                <X size={14} />
              </button>
            )}
          </span>
          {showDetails && (
            <ul className="bot-work-notice-details">
              {control.receipt?.tasks.map((task) => (
                <li key={task.taskId}>
                  {titleFor(task.taskId)} —{" "}
                  {task.status === "requested"
                    ? "stopping"
                    : task.status === "failed"
                      ? `not confirmed${task.error ? `: ${task.error}` : ""}`
                      : task.status === "released"
                        ? "follow-up allowed"
                        : "stopped"}
                </li>
              ))}
              {control.stopped.map((task) => (
                <li key={`release:${task.taskId}`}>
                  {titleFor(task.taskId)} is stopped.{" "}
                  <button
                    type="button"
                    disabled={!controlAvailable || controlLocked}
                    onClick={() =>
                      void controls.start("resume_turn", task.taskId, task.stopVersion)
                    }
                  >
                    Allow a new follow-up
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <div className="bot-work-tabs" role="tablist" aria-label="Bot work views">
        {tabs.map((entry) => {
          const count = entry.id === "setup" ? undefined : counts?.[entry.id];
          return (
            <button
              key={entry.id}
              id={`bot-work-tab-${entry.id}`}
              type="button"
              role="tab"
              aria-label={entry.label}
              aria-selected={tab === entry.id}
              aria-controls="bot-work-content"
              tabIndex={tab === entry.id ? 0 : -1}
              onKeyDown={(event) => {
                const index = tabs.findIndex((candidate) => candidate.id === tab);
                const next =
                  event.key === "ArrowRight"
                    ? (index + 1) % tabs.length
                    : event.key === "ArrowLeft"
                      ? (index + tabs.length - 1) % tabs.length
                      : event.key === "Home"
                        ? 0
                        : event.key === "End"
                          ? tabs.length - 1
                          : -1;
                if (next < 0) return;
                event.preventDefault();
                setTab(tabs[next].id);
                document.getElementById(`bot-work-tab-${tabs[next].id}`)?.focus();
              }}
              onClick={() => setTab(entry.id)}
            >
              {entry.label}
              {!!count && (
                <span
                  className={entry.id === "needs_you" ? "bot-work-badge urgent" : "bot-work-badge"}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>
      <section
        id="bot-work-content"
        role="tabpanel"
        aria-labelledby={`bot-work-tab-${tab}`}
        aria-busy={tab !== "setup" && loading}
      >
        {tab === "setup" ? (
          <div className="bot-work-setup">
            <BotResponsibilityPanel
              key={`${workspaceId}:${botId}`}
              workspaceId={workspaceId}
              botId={botId}
              reloadToken={`${refresh}:${paused}:${control.future?.futureControlVersion ?? 0}`}
            />
            <BotNotificationPanel
              key={`notifications:${workspaceId}:${botId}`}
              workspaceId={workspaceId}
              botId={botId}
            />
            {onOpenContext && (
              <div className="bot-work-card">
                <div>
                  <h3>Memory</h3>
                  <p className="bot-work-muted">
                    What this bot can recall in this workspace. Correct or remove anything.
                  </p>
                </div>
                <button type="button" onClick={() => onOpenContext(workspaceId)}>
                  <BookOpen size={14} /> Open memory
                </button>
              </div>
            )}
          </div>
        ) : (
          <>
            {error && (
              <div className="bot-work-empty" role="alert">
                <span>{error}</span>
                <button
                  type="button"
                  onClick={() => {
                    void loaderRef.current?.load(Boolean(current));
                  }}
                >
                  Retry
                </button>
              </div>
            )}
            {!error && !current && (
              <div className="bot-work-empty">
                <LoaderCircle className="spinning" size={22} />
                Loading…
              </div>
            )}
            {current && (
              <>
                {view === "scheduled" &&
                  (current.scheduleAvailability === "unavailable" ||
                    current.scheduleRuntime !== "running") && (
                    <p className="bot-work-notice subtle">
                      {current.scheduleAvailability === "unavailable"
                        ? "The scheduler isn't available in this runtime, so saved times won't run here."
                        : `The scheduler is ${current.scheduleRuntime === "disabled" ? "turned off" : "not running"}, so saved times won't run yet.`}
                    </p>
                  )}
                {current.items.length === 0 && (
                  <div className="bot-work-empty">
                    {view === "scheduled" ? (
                      <CalendarClock size={24} />
                    ) : (
                      <ClipboardList size={24} />
                    )}
                    {views.find((entry) => entry.id === view)?.empty}
                    {view === "scheduled" && (
                      <button type="button" onClick={() => setTab("setup")}>
                        Give this bot a responsibility
                      </button>
                    )}
                  </div>
                )}
                <ul className="bot-work-list">
                  {current.items.map((item) => {
                    const active =
                      !!item.taskId && !["completed", "failed", "cancelled"].includes(item.status);
                    return (
                      <li key={item.id} className={item.schedulePaused ? "is-paused" : undefined}>
                        <div className="bot-work-item-head">
                          <strong>{item.title}</strong>
                          <span className="bot-work-tags">
                            {item.ownership === "delegated" && <em>Delegated</em>}
                            {item.conversation && <em>Chat</em>}
                            {item.schedulePaused && <em className="paused">Paused</em>}
                            {!item.scheduleId && <time>{ago(item.updatedAt)}</time>}
                          </span>
                        </div>
                        {item.nextWakeAt !== undefined && !item.schedulePaused ? (
                          <p className="bot-work-state">
                            Next run {formatNextRun(item.nextWakeAt)}
                          </p>
                        ) : view !== "results" ? (
                          <p className="bot-work-state">{itemState(item)}</p>
                        ) : null}
                        {view === "results" && (
                          <BotWorkResultCard
                            item={item}
                            workspaceId={workspaceId}
                            botId={botId}
                            onOpenWork={() => openTask(item.taskId)}
                          />
                        )}
                        {view !== "results" && (
                          <div className="bot-work-item-actions">
                            {item.scheduleId && (
                              <button type="button" onClick={() => setTab("setup")}>
                                Manage
                              </button>
                            )}
                            {item.taskId && (
                              <button
                                type="button"
                                className={view === "needs_you" ? "bot-work-primary" : undefined}
                                onClick={() => openTask(item.taskId)}
                              >
                                {view === "needs_you" ? "Respond" : "Open"}
                              </button>
                            )}
                            {active && (
                              <button
                                type="button"
                                disabled={!controlAvailable || controlLocked}
                                title="Stop this item only"
                                onClick={() => void controls.start("stop_turn", item.taskId)}
                              >
                                Stop
                              </button>
                            )}
                          </div>
                        )}
                      </li>
                    );
                  })}
                </ul>
                {current.nextCursor && (
                  <button
                    type="button"
                    className="bot-work-more"
                    disabled={loading}
                    onClick={() => {
                      void loaderRef.current?.load(true);
                    }}
                  >
                    {loading ? "Loading…" : "Load more"}
                  </button>
                )}
              </>
            )}
          </>
        )}
      </section>
    </dialog>,
    document.body,
  );
}
