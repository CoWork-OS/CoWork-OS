import React, { useCallback, useEffect, useRef, useState } from "react";
import ReactDOM from "react-dom/client";
import {
  WEB_API_PATH,
  WEB_API_VERSION,
  type WebPublicBootstrap,
  type WebSessionBootstrap,
} from "../shared/host-api/contracts";
import { TaskStatusBadge } from "../renderer/host-shared/TaskStatusBadge";
import { BrowserHostTransport, type BrowserConnectionState, WebTransportError } from "./transport";
import { TaskTimeline } from "./TaskTimeline";
import { TaskGovernance } from "./TaskGovernance";
import { TaskCancellation } from "./TaskCancellation";
import { TaskFollowUp } from "./TaskFollowUp";
import { TaskArtifacts } from "./TaskArtifacts";
import { WorkspaceGit } from "./WorkspaceGit";
import "./web.css";

const WorkspaceTerminal = React.lazy(async () => {
  const module = await import("./WorkspaceTerminal");
  return { default: module.WorkspaceTerminal };
});

type State =
  | { kind: "loading" }
  | { kind: "login"; error?: string }
  | { kind: "ready"; session: WebSessionBootstrap }
  | { kind: "version_mismatch" }
  | { kind: "error"; message: string };

type WorkspaceSummary = {
  id: string;
  name: string;
};

type TaskSummary = {
  id: string;
  title: string;
  status: string;
  createdAt?: string | number;
  updatedAt?: string | number;
  completedAt?: string | number;
  agentType?: string;
  priority?: string | number;
  labels?: string[];
  dueDate?: string | number;
  boardColumn?: string;
};

type TaskDetail = TaskSummary & {
  parentTaskId?: string;
  assignedAgentRoleId?: string;
  workspaceId?: string;
};

type LoadState = "idle" | "loading" | "ready" | "error";

type WorkspaceFileEntry = {
  name: string;
  relativePath: string;
  type: "file" | "directory";
  size: number;
};

type PendingTaskCreate = {
  key: string;
  title: string;
  prompt: string;
  workspaceId: string;
};

type BrowserTaskDraft = { title: string; prompt: string; pending: PendingTaskCreate | null };

function endpoint(path: string): string {
  // document.baseURI retains a reverse-proxy prefix while moving from /app/
  // to the sibling /api/ route. The server validates that base independently.
  const appBase = new URL(document.baseURI);
  return new URL(`../${WEB_API_PATH.slice(1)}${path}`, appBase).toString();
}

async function readJson<T>(
  path: string,
  init?: RequestInit,
): Promise<{ response: Response; data: T }> {
  const response = await fetch(endpoint(path), {
    ...init,
    credentials: "same-origin",
    cache: "no-store",
  });
  const data = (await response.json()) as T;
  return { response, data };
}

function BrowserEntry() {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [code, setCode] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  const refreshSession = useCallback(async (isActive: () => boolean = () => true) => {
    const { response, data } = await readJson<WebSessionBootstrap>("/session/bootstrap");
    if (!isActive()) return false;
    if (response.status === 401) {
      setState({ kind: "login" });
      return false;
    }
    if (!isRecord(data) || data.apiVersion !== WEB_API_VERSION) {
      setState({ kind: "version_mismatch" });
      return false;
    }
    if (!response.ok) {
      throw new Error("This browser application cannot connect to the host version.");
    }
    setState({ kind: "ready", session: data });
    return true;
  }, []);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        const { response, data } = await readJson<WebPublicBootstrap>("/bootstrap");
        if (!isRecord(data) || data.apiVersion !== WEB_API_VERSION) {
          if (active) setState({ kind: "version_mismatch" });
          return;
        }
        if (!response.ok) {
          throw new Error("This browser application cannot connect to the host version.");
        }
        if (active) await refreshSession(() => active);
      } catch (error) {
        if (active) {
          setState({
            kind: "error",
            message: error instanceof Error ? error.message : "Could not reach the CoWork host.",
          });
        }
      }
    }
    void load();
    return () => {
      active = false;
    };
  }, [refreshSession]);

  async function pair(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!code.trim() || submitting) return;
    setSubmitting(true);
    try {
      const { response } = await readJson<unknown>("/session/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      if (!response.ok) {
        setState({ kind: "login", error: "The pairing code was not accepted." });
        return;
      }
      setCode("");
      await refreshSession();
    } catch {
      setState({ kind: "login", error: "Could not reach the CoWork host." });
    } finally {
      setSubmitting(false);
    }
  }

  const reauthenticate = useCallback(() => {
    setState({ kind: "loading" });
    void refreshSession().catch((error) => {
      setState({
        kind: "error",
        message: error instanceof Error ? error.message : "Could not reach the CoWork host.",
      });
    });
  }, [refreshSession]);

  const signOut = useCallback(
    async (session: WebSessionBootstrap) => {
      if (signingOut) return;
      setSigningOut(true);
      try {
        const response = await fetch(endpoint("/session/logout"), {
          method: "POST",
          credentials: "same-origin",
          cache: "no-store",
          headers: { "X-CoWork-CSRF": session.csrfToken },
        });
        if (!response.ok && response.status !== 401) {
          throw new Error("Could not sign out of this browser session.");
        }
        clearBrowserSessionState(session);
        setState({ kind: "login" });
      } catch (error) {
        setState({
          kind: "error",
          message: errorMessage(error, "Could not sign out of this browser session."),
        });
      } finally {
        setSigningOut(false);
      }
    },
    [signingOut],
  );

  return (
    <main className={`web-entry${state.kind === "ready" ? " web-entry-ready" : ""}`}>
      {state.kind === "ready" ? (
        <BrowserWorkspace
          session={state.session}
          onReauthenticate={reauthenticate}
          onSignOut={() => void signOut(state.session)}
          signingOut={signingOut}
        />
      ) : (
        <div className="web-entry-card">
          <img className="web-entry-logo" src="./cowork-os-app-logo-light.png" alt="CoWork OS" />
          {state.kind === "loading" && <p role="status">Connecting to your CoWork host…</p>}
          {state.kind === "error" && (
            <>
              <p role="alert">{state.message}</p>
              <button type="button" onClick={() => window.location.reload()}>
                Retry connection
              </button>
            </>
          )}
          {state.kind === "version_mismatch" && (
            <>
              <h1>Update required</h1>
              <p>The browser application and CoWork host use different API versions.</p>
              <button type="button" onClick={() => window.location.reload()}>
                Reload
              </button>
            </>
          )}
          {state.kind === "login" && (
            <>
              <h1>Open CoWork OS</h1>
              <p>Enter the pairing code shown by your CoWork host.</p>
              <form onSubmit={(event) => void pair(event)}>
                <label htmlFor="pairing-code">Pairing code</label>
                <input
                  id="pairing-code"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                />
                <button type="submit" disabled={submitting || !code.trim()}>
                  {submitting ? "Connecting…" : "Connect"}
                </button>
              </form>
              {state.error && <p role="alert">{state.error}</p>}
            </>
          )}
        </div>
      )}
    </main>
  );
}

function BrowserWorkspace({
  session,
  onReauthenticate,
  onSignOut,
  signingOut,
}: {
  session: WebSessionBootstrap;
  onReauthenticate: () => void;
  onSignOut: () => void;
  signingOut: boolean;
}) {
  const [transport, setTransport] = useState<BrowserHostTransport | null>(null);
  const [connection, setConnection] = useState<BrowserConnectionState>("connecting");
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [workspacesState, setWorkspacesState] = useState<LoadState>("idle");
  const [workspacesError, setWorkspacesError] = useState("");
  const [selectedWorkspaceId, setSelectedWorkspaceId] = useState(session.activeWorkspaceId ?? "");
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [taskOffset, setTaskOffset] = useState(0);
  const [taskHasMore, setTaskHasMore] = useState(false);
  const [loadingMoreTasks, setLoadingMoreTasks] = useState(false);
  const [taskListState, setTaskListState] = useState<LoadState>("idle");
  const [taskListError, setTaskListError] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const [selectedTask, setSelectedTask] = useState<TaskDetail | null>(null);
  const [taskDetailState, setTaskDetailState] = useState<LoadState>("idle");
  const [taskDetailError, setTaskDetailError] = useState("");
  const taskListEpoch = useRef(0);
  const desiredTaskId = useRef<string | null>(null);
  const [taskListRefresh, setTaskListRefresh] = useState(0);

  useEffect(() => {
    const nextTransport = new BrowserHostTransport(session);
    setTransport(nextTransport);
    setConnection("connecting");
    const unsubscribe = nextTransport.onState((nextState) => {
      setConnection(nextState);
      if (nextState === "reauth_required") onReauthenticate();
    });
    void nextTransport.start();
    return () => {
      unsubscribe();
      nextTransport.close();
    };
  }, [session, onReauthenticate]);

  useEffect(() => {
    if (!transport) return;
    if (connection !== "connected") {
      setWorkspacesState("idle");
      return;
    }
    let active = true;
    setWorkspacesState("loading");
    setWorkspacesError("");
    void transport
      .request<unknown>("workspace.list", {})
      .then((result) => {
        const nextWorkspaces = parseWorkspaces(result);
        if (!active) return;
        setWorkspaces(nextWorkspaces);
        setSelectedWorkspaceId((current) => {
          if (nextWorkspaces.some((workspace) => workspace.id === current)) return current;
          if (
            session.activeWorkspaceId &&
            nextWorkspaces.some((workspace) => workspace.id === session.activeWorkspaceId)
          ) {
            return session.activeWorkspaceId;
          }
          return nextWorkspaces[0]?.id ?? "";
        });
        setWorkspacesState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setWorkspacesError(errorMessage(error, "Could not load workspaces."));
        setWorkspacesState("error");
      });
    return () => {
      active = false;
    };
  }, [transport, connection, session.activeWorkspaceId]);

  useEffect(() => {
    taskListEpoch.current += 1;
    if (!transport || connection !== "connected" || workspacesState !== "ready") return;
    let active = true;
    setTaskListState("loading");
    setTaskListError("");
    setTaskOffset(0);
    setTaskHasMore(false);
    setLoadingMoreTasks(false);
    setSelectedTaskId(null);
    setSelectedTask(null);
    void transport
      .request<unknown>("task.list", {
        limit: 50,
        offset: 0,
        workspaceId: selectedWorkspaceId || null,
      })
      .then((result) => {
        const page = parseTaskPage(result);
        if (!active) return;
        setTasks(page.tasks);
        setTaskOffset(page.tasks.length);
        setTaskHasMore(page.hasMore);
        setSelectedTaskId(
          page.tasks.find((task) => task.id === desiredTaskId.current)?.id ??
            page.tasks[0]?.id ??
            null,
        );
        setTaskListState("ready");
      })
      .catch((error: unknown) => {
        if (!active) return;
        setTaskListError(errorMessage(error, "Could not load tasks."));
        setTaskListState("error");
      });
    return () => {
      active = false;
    };
  }, [transport, connection, workspacesState, selectedWorkspaceId, taskListRefresh]);

  useEffect(() => {
    if (!selectedTaskId || taskListState !== "ready") {
      setSelectedTask(null);
      setTaskDetailState("idle");
      setTaskDetailError("");
      return;
    }
    if (!transport || connection !== "connected") {
      setTaskDetailState("idle");
      return;
    }
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let hasLoaded = false;
    setTaskDetailState("loading");
    setTaskDetailError("");
    const load = async () => {
      try {
        const result = await transport.request<unknown>("task.get", { taskId: selectedTaskId });
        const task = parseTaskDetail(result);
        if (!active) return;
        setSelectedTask(task);
        if (task) {
          setTasks((current) =>
            current.map((row) =>
              row.id === task.id ? { ...row, status: task.status, updatedAt: task.updatedAt } : row,
            ),
          );
        }
        hasLoaded = true;
        setTaskDetailState("ready");
        setTaskDetailError("");
      } catch (error) {
        if (!active) return;
        setTaskDetailError(errorMessage(error, "Could not load task details."));
        if (!hasLoaded) setTaskDetailState("error");
      } finally {
        if (active) timer = setTimeout(() => void load(), 5_000);
      }
    };
    void load();
    return () => {
      active = false;
      if (timer) clearTimeout(timer);
    };
  }, [transport, connection, selectedTaskId, taskListState]);

  const chooseWorkspace = (workspaceId: string) => {
    taskListEpoch.current += 1;
    desiredTaskId.current = null;
    setSelectedWorkspaceId(workspaceId);
    setSelectedTaskId(null);
  };

  const onTaskCreated = useCallback((taskId: string) => {
    desiredTaskId.current = taskId;
    setTaskListRefresh((current) => current + 1);
  }, []);

  const loadMoreTasks = async () => {
    if (!transport || connection !== "connected" || loadingMoreTasks || !taskHasMore) return;
    const epoch = taskListEpoch.current;
    setLoadingMoreTasks(true);
    setTaskListError("");
    try {
      const result = await transport.request<unknown>("task.list", {
        limit: 50,
        offset: taskOffset,
        workspaceId: selectedWorkspaceId || null,
      });
      const page = parseTaskPage(result);
      if (epoch !== taskListEpoch.current) return;
      setTasks((current) => {
        const seen = new Set(current.map((task) => task.id));
        return [...current, ...page.tasks.filter((task) => !seen.has(task.id))];
      });
      setTaskOffset((current) => current + page.tasks.length);
      setTaskHasMore(page.hasMore);
    } catch (error) {
      if (epoch === taskListEpoch.current)
        setTaskListError(errorMessage(error, "Could not load more tasks."));
    } finally {
      if (epoch === taskListEpoch.current) setLoadingMoreTasks(false);
    }
  };

  return (
    <section className="web-dashboard" aria-label="CoWork workspace and tasks">
      <header className="web-header">
        <div className="web-brand">
          <img className="web-brand-logo" src="./cowork-os-app-logo-light.png" alt="" />
          <div>
            <p className="web-eyebrow">CoWork OS</p>
            <h1>Workspace</h1>
          </div>
        </div>
        <div className="web-header-actions">
          <div className={`web-connection web-connection-${connection}`} role="status">
            <span className="web-connection-dot" aria-hidden="true" />
            {connectionLabel(connection)}
          </div>
          <button className="web-sign-out" type="button" disabled={signingOut} onClick={onSignOut}>
            {signingOut ? "Signing out…" : "Sign out"}
          </button>
        </div>
      </header>

      {connection === "version_mismatch" && (
        <div className="web-notice web-notice-error" role="alert">
          <div>
            <strong>Browser and host versions do not match.</strong>
            <span>Reload after updating the browser app or CoWork host.</span>
          </div>
          <button type="button" onClick={() => window.location.reload()}>
            Reload
          </button>
        </div>
      )}
      {connection === "disconnected" && (
        <div className="web-notice" role="status">
          <div>
            <strong>Reconnecting to your host…</strong>
            <span>Your current summaries remain visible while the connection is restored.</span>
          </div>
          <button type="button" onClick={() => void transport?.retryNow()}>
            Retry now
          </button>
        </div>
      )}
      {connection === "connecting" && (
        <div className="web-notice" role="status">
          <strong>Opening a secure connection to your host…</strong>
        </div>
      )}
      {!session.providerReady && (
        <div className="web-notice" role="status">
          <div>
            <strong>No model provider is configured on this host.</strong>
            <span>Configure a provider in the host settings before starting browser tasks.</span>
          </div>
        </div>
      )}

      <div className="web-workspace-bar">
        <label htmlFor="workspace-select">Workspace</label>
        <select
          id="workspace-select"
          value={selectedWorkspaceId}
          onChange={(event) => chooseWorkspace(event.target.value)}
          disabled={connection !== "connected" || workspacesState !== "ready"}
        >
          <option value="">All workspaces</option>
          {workspaces.map((workspace) => (
            <option key={workspace.id} value={workspace.id}>
              {workspace.name}
            </option>
          ))}
        </select>
        {workspacesState === "loading" && <span className="web-muted">Loading workspaces…</span>}
        {workspacesState === "error" && <span className="web-inline-error">{workspacesError}</span>}
      </div>

      {selectedWorkspaceId && session.capabilities["tasks.create"]?.available && (
        <BrowserTaskComposer
          workspaceId={selectedWorkspaceId}
          session={session}
          transport={transport}
          connected={connection === "connected"}
          onCreated={onTaskCreated}
        />
      )}

      <div className="web-content-grid">
        <section className="web-panel web-task-panel" aria-labelledby="task-list-title">
          <div className="web-panel-heading">
            <div>
              <p className="web-eyebrow">Recent activity</p>
              <h2 id="task-list-title">Tasks</h2>
            </div>
            {taskListState === "ready" && <span className="web-count">{tasks.length}</span>}
          </div>
          {taskListState === "loading" && (
            <p className="web-muted" role="status">
              Loading tasks…
            </p>
          )}
          {taskListState === "error" && (
            <p className="web-inline-error" role="alert">
              {taskListError}
            </p>
          )}
          {taskListState === "ready" && tasks.length === 0 && (
            <p className="web-empty">No tasks in this workspace yet.</p>
          )}
          <ul className="web-task-list">
            {tasks.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className={`web-task-row${selectedTaskId === task.id ? " is-selected" : ""}`}
                  aria-pressed={selectedTaskId === task.id}
                  disabled={connection !== "connected"}
                  onClick={() => {
                    desiredTaskId.current = task.id;
                    setSelectedTaskId(task.id);
                  }}
                >
                  <span className="web-task-row-copy">
                    <strong>{task.title}</strong>
                    <span>{formatDate(task.updatedAt)}</span>
                  </span>
                  <TaskStatusBadge
                    className="web-status"
                    statusClassPrefix="web-status-"
                    status={task.status}
                    label={humanize(task.status)}
                  />
                </button>
              </li>
            ))}
          </ul>
          {taskListState === "ready" && tasks.length > 0 && (
            <p className="web-list-footnote">Showing {tasks.length} recent tasks.</p>
          )}
          {taskListState === "ready" && taskHasMore && (
            <button
              type="button"
              className="web-load-more"
              onClick={() => void loadMoreTasks()}
              disabled={connection !== "connected" || loadingMoreTasks}
            >
              {loadingMoreTasks ? "Loading…" : "Load more tasks"}
            </button>
          )}
        </section>

        <section className="web-panel web-detail-panel" aria-labelledby="task-detail-title">
          {selectedTaskId && taskDetailState === "loading" && (
            <p className="web-muted" role="status">
              Loading task details…
            </p>
          )}
          {taskDetailState === "error" && (
            <p className="web-inline-error" role="alert">
              {taskDetailError}
            </p>
          )}
          {selectedTask && taskDetailState === "ready" ? (
            <>
              <TaskDetails task={selectedTask} />
              {selectedTask.workspaceId && session.capabilities["tasks.cancel"]?.available && (
                <TaskCancellation
                  key={`${selectedTask.id}:cancellation`}
                  task={selectedTask}
                  workspaceId={selectedTask.workspaceId}
                  session={session}
                  transport={transport}
                  connected={connection === "connected"}
                  onTaskObserved={(result) => {
                    setSelectedTask((current) =>
                      current?.id === result.taskId
                        ? { ...current, status: result.status, updatedAt: result.updatedAt }
                        : current,
                    );
                    setTasks((current) =>
                      current.map((row) =>
                        row.id === result.taskId
                          ? { ...row, status: result.status, updatedAt: result.updatedAt }
                          : row,
                      ),
                    );
                  }}
                />
              )}
              {selectedTask.workspaceId && session.capabilities["tasks.events"]?.available && (
                <TaskTimeline
                  key={selectedTask.id}
                  taskId={selectedTask.id}
                  workspaceId={selectedTask.workspaceId}
                  transport={transport}
                  connected={connection === "connected"}
                />
              )}
              {selectedTask.workspaceId && (
                <TaskGovernance
                  key={`${selectedTask.id}:governance`}
                  taskId={selectedTask.id}
                  workspaceId={selectedTask.workspaceId}
                  transport={transport}
                  connected={connection === "connected"}
                  approvalsEnabled={session.capabilities["tasks.approvals"]?.available === true}
                  inputsEnabled={session.capabilities["tasks.inputRequests"]?.available === true}
                  storageKey={`cowork:web:pending-decision:${session.host.installationId}:${session.host.profileId}:${selectedTask.workspaceId}:${selectedTask.id}`}
                />
              )}
              {selectedTask.workspaceId && session.capabilities["terminal.attach"]?.available && (
                <React.Suspense fallback={<p className="web-inline-loading">Loading terminal…</p>}>
                  <WorkspaceTerminal
                    key={`${selectedTask.id}:terminal`}
                    taskId={selectedTask.id}
                    workspaceId={selectedTask.workspaceId}
                    session={session}
                    transport={transport}
                    connected={connection === "connected"}
                  />
                </React.Suspense>
              )}
              {selectedTask.workspaceId && session.capabilities["tasks.followUp"]?.available && (
                <TaskFollowUp
                  taskId={selectedTask.id}
                  workspaceId={selectedTask.workspaceId}
                  session={session}
                  transport={transport}
                  connected={connection === "connected"}
                />
              )}
              {selectedTask.workspaceId && session.capabilities["artifacts.read"]?.available && (
                <TaskArtifacts
                  key={`${selectedTask.id}:artifacts`}
                  taskId={selectedTask.id}
                  workspaceId={selectedTask.workspaceId}
                  transport={transport}
                  connected={connection === "connected"}
                  csrfToken={session.csrfToken}
                />
              )}
            </>
          ) : taskDetailState === "ready" && selectedTaskId ? (
            <div className="web-detail-empty">
              <h2 id="task-detail-title">Task unavailable</h2>
              <p>This task may have been removed.</p>
            </div>
          ) : taskListState === "ready" && tasks.length === 0 ? (
            <div className="web-detail-empty">
              <span className="web-empty-icon" aria-hidden="true">
                ◌
              </span>
              <h2 id="task-detail-title">No task selected</h2>
              <p>Select a task to see its summary.</p>
            </div>
          ) : null}
        </section>
      </div>

      {selectedWorkspaceId && session.capabilities["files.read"]?.available && (
        <BrowserWorkspaceFilesPanel
          key={selectedWorkspaceId}
          workspaceId={selectedWorkspaceId}
          transport={transport}
          connected={connection === "connected"}
          csrfToken={session.csrfToken}
          uploadEnabled={session.capabilities["files.upload"]?.available === true}
        />
      )}
      {selectedWorkspaceId && session.capabilities["git.read"]?.available && (
        <WorkspaceGit
          key={selectedWorkspaceId}
          workspaceId={selectedWorkspaceId}
          transport={transport}
          connected={connection === "connected"}
        />
      )}

      <footer className="web-footer">
        <span>{session.host.runtime === "electron" ? "Desktop host" : "Node host"}</span>
        <span>Version {session.host.appVersion}</span>
        {session.providerReady && <span className="web-ready-mark">Provider ready</span>}
      </footer>
    </section>
  );
}

function BrowserTaskComposer({
  workspaceId,
  session,
  transport,
  connected,
  onCreated,
}: {
  workspaceId: string;
  session: WebSessionBootstrap;
  transport: BrowserHostTransport | null;
  connected: boolean;
  onCreated: (taskId: string) => void;
}) {
  const storageKey = `cowork:web:task-draft:${session.host.installationId}:${session.host.profileId}:${workspaceId}`;
  const [draftWorkspaceId, setDraftWorkspaceId] = useState(workspaceId);
  const activeWorkspaceId = useRef(workspaceId);
  const [draft, setDraft] = useState(() => readTaskDraft(storageKey, workspaceId));
  const [submitting, setSubmitting] = useState(false);
  const [notice, setNotice] = useState("");

  activeWorkspaceId.current = workspaceId;
  if (draftWorkspaceId !== workspaceId) {
    // Reset before committing a render so an old workspace draft is never
    // saved under the new workspace key or briefly shown in its composer.
    setDraftWorkspaceId(workspaceId);
    setDraft(readTaskDraft(storageKey, workspaceId));
    setSubmitting(false);
    setNotice("");
  }

  useEffect(() => {
    saveTaskDraft(storageKey, draft);
  }, [storageKey, draft]);

  useEffect(() => {
    if (!connected || !transport || !draft.pending) return;
    let active = true;
    void transport
      .request<unknown>("task.admission.get", { operationKey: draft.pending.key })
      .then((result) => {
        if (!active || !isRecord(result)) return;
        if (result.found === true && typeof result.taskId === "string") {
          setDraft({ title: "", prompt: "", pending: null });
          setNotice("The host confirmed this task. Open it from the task list.");
          onCreated(result.taskId);
        } else {
          setNotice("The host has not confirmed this task. Retry with the same request key.");
        }
      })
      .catch(() => {
        if (active) setNotice("Task status is unavailable. Keep this request key for retry.");
      });
    return () => {
      active = false;
    };
  }, [transport, connected, draft.pending, onCreated]);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!transport || !connected || submitting) return;
    const request: PendingTaskCreate = draft.pending ?? {
      key: crypto.randomUUID(),
      title: draft.title.trim(),
      prompt: draft.prompt.trim(),
      workspaceId,
    };
    if (!request.title || !request.prompt) return;
    const pendingDraft = { ...draft, pending: request };
    saveTaskDraft(storageKey, pendingDraft);
    setDraft(pendingDraft);
    setSubmitting(true);
    setNotice("");
    try {
      const result = await transport.request<unknown>(
        "task.create",
        { title: request.title, prompt: request.prompt, workspaceId: request.workspaceId },
        { operationKey: request.key, mutation: true, timeoutMs: 120_000 },
      );
      if (!isRecord(result) || typeof result.taskId !== "string") {
        throw new Error("The host returned an invalid task admission.");
      }
      if (activeWorkspaceId.current !== request.workspaceId) return;
      const clearDraft = { title: "", prompt: "", pending: null };
      saveTaskDraft(storageKey, clearDraft);
      setDraft(clearDraft);
      setNotice("Task started on your CoWork host.");
      onCreated(result.taskId);
    } catch (error) {
      if (activeWorkspaceId.current !== request.workspaceId) return;
      setNotice(
        errorMessage(error, "The task outcome is unknown. Retry with the same request key."),
      );
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <section className="web-panel web-compose-panel" aria-labelledby="new-task-title">
      <div className="web-panel-heading">
        <div>
          <p className="web-eyebrow">Run on your host</p>
          <h2 id="new-task-title">New task</h2>
        </div>
      </div>
      <form onSubmit={(event) => void submit(event)}>
        <label htmlFor="web-task-title">Title</label>
        <input
          id="web-task-title"
          value={draft.title}
          maxLength={200}
          disabled={Boolean(draft.pending) || submitting}
          onChange={(event) => setDraft((current) => ({ ...current, title: event.target.value }))}
          required
        />
        <label htmlFor="web-task-prompt">Instructions</label>
        <textarea
          id="web-task-prompt"
          value={draft.prompt}
          maxLength={64_000}
          disabled={Boolean(draft.pending) || submitting}
          onChange={(event) => setDraft((current) => ({ ...current, prompt: event.target.value }))}
          required
        />
        <button
          type="submit"
          disabled={
            !connected ||
            !session.providerReady ||
            submitting ||
            !draft.title.trim() ||
            !draft.prompt.trim()
          }
        >
          {submitting ? "Sending…" : draft.pending ? "Retry same task request" : "Start task"}
        </button>
      </form>
      {notice && (
        <p className="web-compose-notice" role="status">
          {notice}
        </p>
      )}
    </section>
  );
}

function BrowserWorkspaceFilesPanel({
  workspaceId,
  transport,
  connected,
  csrfToken,
  uploadEnabled,
}: {
  workspaceId: string;
  transport: BrowserHostTransport | null;
  connected: boolean;
  csrfToken: string;
  uploadEnabled: boolean;
}) {
  const [relativePath, setRelativePath] = useState("");
  const [entries, setEntries] = useState<WorkspaceFileEntry[]>([]);
  const [truncated, setTruncated] = useState(false);
  const [state, setState] = useState<LoadState>("idle");
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState<string | null>(null);
  const [uploadFile, setUploadFile] = useState<File | null>(null);
  const [uploading, setUploading] = useState(false);
  const [refresh, setRefresh] = useState(0);

  useEffect(() => {
    if (!transport || !connected) return;
    let active = true;
    setState("loading");
    setError("");
    void transport
      .request<unknown>("workspace.files.list", { workspaceId, relativePath })
      .then((result) => {
        const listing = parseWorkspaceFileListing(result, workspaceId, relativePath);
        if (!active) return;
        setEntries(listing.entries);
        setTruncated(listing.truncated);
        setState("ready");
      })
      .catch((cause) => {
        if (!active) return;
        setError(errorMessage(cause, "Could not list workspace files."));
        setState("error");
      });
    return () => {
      active = false;
    };
  }, [transport, connected, workspaceId, relativePath, refresh]);

  const upload = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!uploadEnabled || !connected || !uploadFile || uploading) return;
    if (uploadFile.size > 64 * 1024 * 1024) {
      setError("This file exceeds the 64 MiB browser upload limit.");
      return;
    }
    const target = relativePath ? `${relativePath}/${uploadFile.name}` : uploadFile.name;
    setUploading(true);
    setError("");
    try {
      const response = await fetch(endpoint("/workspace-files/upload"), {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: {
          "Content-Type": "application/octet-stream",
          "X-CoWork-CSRF": csrfToken,
          "X-CoWork-Workspace-Id": workspaceId,
          "X-CoWork-Relative-Path": encodeURIComponent(target),
          "If-None-Match": "*",
        },
        body: uploadFile,
      });
      if (response.status === 409) throw new Error("A file with this name already exists here.");
      if (!response.ok) throw new Error("The host could not save this file.");
      setUploadFile(null);
      setRefresh((current) => current + 1);
    } catch (cause) {
      setError(errorMessage(cause, "Could not upload this file."));
    } finally {
      setUploading(false);
    }
  };

  const download = async (entry: WorkspaceFileEntry) => {
    if (!connected || downloading) return;
    setDownloading(entry.relativePath);
    setError("");
    try {
      const response = await fetch(endpoint("/workspace-files/download"), {
        method: "POST",
        credentials: "same-origin",
        cache: "no-store",
        headers: { "Content-Type": "application/json", "x-cowork-csrf": csrfToken },
        body: JSON.stringify({ workspaceId, relativePath: entry.relativePath }),
      });
      if (!response.ok) throw new Error("This workspace file could not be downloaded.");
      const url = URL.createObjectURL(await response.blob());
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = entry.name;
      anchor.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (cause) {
      setError(errorMessage(cause, "Could not download this file."));
    } finally {
      setDownloading(null);
    }
  };

  const parent = relativePath.split("/").slice(0, -1).join("/");
  return (
    <section className="web-panel web-files-panel" aria-labelledby="workspace-files-title">
      <div className="web-panel-heading">
        <div>
          <p className="web-eyebrow">On your host</p>
          <h2 id="workspace-files-title">Workspace files</h2>
        </div>
        <span className="web-file-path">/{relativePath}</span>
      </div>
      {relativePath && (
        <button
          type="button"
          className="web-file-up"
          disabled={!connected}
          onClick={() => setRelativePath(parent)}
        >
          Up one folder
        </button>
      )}
      {uploadEnabled && (
        <form className="web-upload-form" onSubmit={(event) => void upload(event)}>
          <label htmlFor="web-upload-file">Add a file to this folder</label>
          <input
            key={refresh}
            id="web-upload-file"
            type="file"
            disabled={!connected || uploading}
            onChange={(event) => setUploadFile(event.target.files?.[0] ?? null)}
          />
          <button type="submit" disabled={!connected || uploading || !uploadFile}>
            {uploading ? "Uploading…" : "Upload file"}
          </button>
          <span className="web-muted">Up to 64 MiB. Existing files are never replaced.</span>
        </form>
      )}
      {state === "loading" && <p className="web-muted">Loading files…</p>}
      {state === "error" && (
        <p className="web-inline-error" role="alert">
          {error}
        </p>
      )}
      {state === "ready" && entries.length === 0 && (
        <p className="web-empty">No readable files here.</p>
      )}
      {state === "ready" && entries.length > 0 && (
        <ul className="web-files-list">
          {entries.map((entry) => (
            <li key={entry.relativePath}>
              <span className="web-file-name">{entry.name}</span>
              <span className="web-muted">
                {entry.type === "directory" ? "Folder" : formatBytes(entry.size)}
              </span>
              <button
                type="button"
                disabled={!connected || downloading !== null}
                onClick={() =>
                  entry.type === "directory"
                    ? setRelativePath(entry.relativePath)
                    : void download(entry)
                }
              >
                {entry.type === "directory"
                  ? "Open"
                  : downloading === entry.relativePath
                    ? "Downloading…"
                    : "Download"}
              </button>
            </li>
          ))}
        </ul>
      )}
      {truncated && <p className="web-muted">Showing the first readable entries in this folder.</p>}
      {state !== "error" && error && (
        <p className="web-inline-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function TaskDetails({ task }: { task: TaskDetail }) {
  return (
    <>
      <div className="web-panel-heading web-detail-heading">
        <div>
          <p className="web-eyebrow">Task summary</p>
          <h2 id="task-detail-title">{task.title}</h2>
        </div>
        <TaskStatusBadge
          className="web-status"
          statusClassPrefix="web-status-"
          status={task.status}
          label={humanize(task.status)}
        />
      </div>
      <dl className="web-task-facts">
        <div>
          <dt>Updated</dt>
          <dd>{formatDate(task.updatedAt) || "—"}</dd>
        </div>
        <div>
          <dt>Created</dt>
          <dd>{formatDate(task.createdAt) || "—"}</dd>
        </div>
        <div>
          <dt>Agent</dt>
          <dd>{task.agentType ? humanize(task.agentType) : "—"}</dd>
        </div>
        <div>
          <dt>Priority</dt>
          <dd>{task.priority === undefined ? "—" : String(task.priority)}</dd>
        </div>
        {task.dueDate !== undefined && (
          <div>
            <dt>Due</dt>
            <dd>{formatDate(task.dueDate) || String(task.dueDate)}</dd>
          </div>
        )}
        {task.boardColumn && (
          <div>
            <dt>Board</dt>
            <dd>{humanize(task.boardColumn)}</dd>
          </div>
        )}
      </dl>
      {task.labels && task.labels.length > 0 && (
        <div className="web-labels" aria-label="Task labels">
          {task.labels.map((label) => (
            <span key={label}>{label}</span>
          ))}
        </div>
      )}
    </>
  );
}

function parseWorkspaces(value: unknown): WorkspaceSummary[] {
  if (!isRecord(value) || !Array.isArray(value.workspaces)) {
    throw new Error("The host returned invalid workspace data.");
  }
  return value.workspaces.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.id !== "string" ||
      typeof candidate.name !== "string"
    ) {
      return [];
    }
    return [{ id: candidate.id, name: candidate.name }];
  });
}

function parseTaskPage(value: unknown): { tasks: TaskSummary[]; hasMore: boolean } {
  if (!isRecord(value) || !Array.isArray(value.tasks) || typeof value.hasMore !== "boolean") {
    throw new Error("The host returned invalid task data.");
  }
  return {
    tasks: value.tasks.flatMap((candidate) => parseTask(candidate) ?? []),
    hasMore: value.hasMore,
  };
}

function parseWorkspaceFileListing(
  value: unknown,
  workspaceId: string,
  relativePath: string,
): { entries: WorkspaceFileEntry[]; truncated: boolean } {
  if (
    !isRecord(value) ||
    value.workspaceId !== workspaceId ||
    value.relativePath !== relativePath ||
    !Array.isArray(value.entries) ||
    typeof value.truncated !== "boolean"
  ) {
    throw new Error("The host returned invalid workspace files.");
  }
  const entries = value.entries.flatMap((candidate) => {
    if (
      !isRecord(candidate) ||
      typeof candidate.name !== "string" ||
      typeof candidate.relativePath !== "string" ||
      (candidate.type !== "file" && candidate.type !== "directory") ||
      typeof candidate.size !== "number" ||
      !Number.isFinite(candidate.size)
    ) {
      return [];
    }
    return [candidate as WorkspaceFileEntry];
  });
  return { entries, truncated: value.truncated };
}

function parseTaskDetail(value: unknown): TaskDetail | null {
  if (!isRecord(value) || !("task" in value))
    throw new Error("The host returned invalid task details.");
  const task = value.task === null ? null : parseTask(value.task);
  if (value.task !== null && !task) throw new Error("The host returned invalid task details.");
  return task as TaskDetail | null;
}

function parseTask(value: unknown): TaskDetail | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.title !== "string" ||
    typeof value.status !== "string"
  ) {
    return null;
  }
  return {
    id: value.id,
    title: value.title,
    status: value.status,
    workspaceId: typeof value.workspaceId === "string" ? value.workspaceId : undefined,
    createdAt: dateValue(value.createdAt),
    updatedAt: dateValue(value.updatedAt),
    completedAt: dateValue(value.completedAt),
    agentType: typeof value.agentType === "string" ? value.agentType : undefined,
    priority:
      typeof value.priority === "string" || typeof value.priority === "number"
        ? value.priority
        : undefined,
    labels: Array.isArray(value.labels)
      ? value.labels.filter((label): label is string => typeof label === "string")
      : undefined,
    dueDate: dateValue(value.dueDate),
    parentTaskId: typeof value.parentTaskId === "string" ? value.parentTaskId : undefined,
    assignedAgentRoleId:
      typeof value.assignedAgentRoleId === "string" ? value.assignedAgentRoleId : undefined,
    boardColumn: typeof value.boardColumn === "string" ? value.boardColumn : undefined,
  };
}

function dateValue(value: unknown): string | number | undefined {
  return typeof value === "string" || typeof value === "number" ? value : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function errorMessage(error: unknown, fallback: string): string {
  if (error instanceof WebTransportError) return error.message;
  return error instanceof Error ? error.message : fallback;
}

function connectionLabel(connection: BrowserConnectionState): string {
  switch (connection) {
    case "connected":
      return "Connected";
    case "connecting":
      return "Connecting";
    case "disconnected":
      return "Reconnecting";
    case "reauth_required":
      return "Sign in again";
    case "version_mismatch":
      return "Update required";
    case "closed":
      return "Disconnected";
  }
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatDate(value: string | number | undefined): string {
  if (value === undefined || value === "") return "";
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString(undefined, { dateStyle: "medium" });
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${Math.round(size / 1024)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function readTaskDraft(storageKey: string, workspaceId: string): BrowserTaskDraft {
  try {
    const stored = window.sessionStorage.getItem(storageKey);
    if (!stored) return { title: "", prompt: "", pending: null };
    const value: unknown = JSON.parse(stored);
    if (!isRecord(value)) throw new Error("Invalid draft");
    const title = typeof value.title === "string" ? value.title.slice(0, 200) : "";
    const prompt = typeof value.prompt === "string" ? value.prompt.slice(0, 64_000) : "";
    const pending = isRecord(value.pending) ? value.pending : null;
    if (
      pending &&
      pending.workspaceId === workspaceId &&
      typeof pending.key === "string" &&
      /^[A-Za-z0-9._:-]{8,128}$/.test(pending.key) &&
      typeof pending.title === "string" &&
      typeof pending.prompt === "string"
    ) {
      return {
        title: pending.title.slice(0, 200),
        prompt: pending.prompt.slice(0, 64_000),
        pending: {
          key: pending.key,
          title: pending.title.slice(0, 200),
          prompt: pending.prompt.slice(0, 64_000),
          workspaceId,
        },
      };
    }
    return { title, prompt, pending: null };
  } catch {
    return { title: "", prompt: "", pending: null };
  }
}

function saveTaskDraft(storageKey: string, draft: BrowserTaskDraft): void {
  try {
    if (!draft.title && !draft.prompt && !draft.pending) {
      window.sessionStorage.removeItem(storageKey);
    } else {
      window.sessionStorage.setItem(storageKey, JSON.stringify(draft));
    }
  } catch {
    // In-memory draft still works when browser storage is unavailable.
  }
}

function clearBrowserSessionState(session: WebSessionBootstrap): void {
  const prefixes = [
    `cowork:web:task-draft:${session.host.installationId}:${session.host.profileId}:`,
    `cowork:web:task-cancel:${session.host.installationId}:${session.host.profileId}:`,
    `cowork:web:pending-decision:${session.host.installationId}:${session.host.profileId}:`,
    `cowork:web:follow-up:${session.host.installationId}:${session.host.profileId}:`,
    "cowork.web.terminal.pending-open.v1.",
  ];
  try {
    for (let index = window.sessionStorage.length - 1; index >= 0; index -= 1) {
      const key = window.sessionStorage.key(index);
      if (key && prefixes.some((prefix) => key.startsWith(prefix))) {
        window.sessionStorage.removeItem(key);
      }
    }
  } catch {
    // A disabled storage backend has no drafts to clear.
  }
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <BrowserEntry />
  </React.StrictMode>,
);
