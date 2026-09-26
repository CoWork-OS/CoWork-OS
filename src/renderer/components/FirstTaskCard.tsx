import { useCallback, useEffect, useRef, useState } from "react";
import type { Task, Workspace } from "../../shared/types";
import type { ReleaseBriefCheck } from "../../electron/first-task/verify-release-brief";
import { getFirstRunReadiness } from "../../shared/first-run-readiness";
import type { FirstTaskModelPreflight } from "../../electron/first-task/model-preflight";
import { firstTaskRecovery } from "../../shared/first-task-recovery";

type Attempt = {
  attemptId: string;
  task: Task;
  workspace: Workspace;
  check: ReleaseBriefCheck | null;
  inspectedAt: number | null;
  revisionRequestedAt: number | null;
  revisionInspectedAt: number | null;
};

interface Props {
  taskId?: string;
  onTaskReady: (task: Task, workspace: Workspace) => void;
  onOpenBrief: (path: string) => void;
  onOpenSettings: () => void;
  onRevise?: (prompt: string) => void | boolean | Promise<void | boolean>;
  onUseOwnFiles?: () => void;
}

const REVISION_PROMPT =
  "Make outputs/release-brief.html suitable for a nontechnical release manager. Keep the issue IDs and numbers unchanged. Do not alter the sample input files or use tools outside this workspace.";

const preflightHelp: Record<NonNullable<FirstTaskModelPreflight["reason"]>, string> = {
  authentication: "Reconnect this provider in AI settings, then check again.",
  endpoint: "Check the provider endpoint or local runtime, then check again.",
  model: "Choose an available model in AI settings, then check again.",
  tool_support: "Choose a model that supports tool calls, then check again.",
  timeout:
    "The route did not answer in time. Check connectivity or local runtime status, then retry.",
};

export function FirstTaskCard({
  taskId,
  onTaskReady,
  onOpenBrief,
  onOpenSettings,
  onRevise,
  onUseOwnFiles,
}: Props) {
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showBoundaries, setShowBoundaries] = useState(false);
  const [modelRoute, setModelRoute] = useState<string | null>(null);
  const [preflight, setPreflight] = useState<
    (FirstTaskModelPreflight & { workspace: "pass" | "fail"; workspaceDetail?: string; token: string | null }) | null
  >(null);
  const attemptIdRef = useRef<string | null>(null);

  const refresh = useCallback(async () => {
    const current = await window.electronAPI.getFirstTask(undefined, taskId);
    if (current && (!taskId || current.task.id === taskId)) setAttempt(current as Attempt);
  }, [taskId]);

  useEffect(() => {
    void refresh().catch(() => undefined);
  }, [refresh]);

  useEffect(() => {
    if (!showBoundaries) return;
    void window.electronAPI
      .getLLMSettings()
      .then((settings) => {
        const readiness = getFirstRunReadiness(settings);
        setModelRoute(
          readiness.modelReady
            ? `${readiness.providerType ?? "Selected route"} · ${settings.modelKey || "model not selected"}`
            : null,
        );
      })
      .catch(() => setModelRoute(null));
  }, [showBoundaries]);

  useEffect(() => {
    if (!attempt) return;
    const running = ["pending", "queued", "planning", "executing", "interrupted"].includes(
      attempt.task.status,
    );
    const revisionPending = Boolean(attempt.revisionRequestedAt && !attempt.revisionInspectedAt);
    if (running || revisionPending) {
      const timer = window.setInterval(() => void refresh().catch(() => undefined), 2000);
      return () => window.clearInterval(timer);
    }
    if (!attempt.check?.passed) return;
    // A passed check is revalidated (outputs re-hashed) by the main process on each
    // read, so do it when the user returns to the window rather than on a timer.
    const onFocus = () => void refresh().catch(() => undefined);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [attempt, refresh]);

  const checkRoute = async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await window.electronAPI.preflightFirstTask();
      setPreflight(result);
      setModelRoute(`${result.providerType} · ${result.modelId}`);
      return result;
    } catch (cause) {
      setPreflight(null);
      setError(cause instanceof Error ? cause.message : "The selected model could not be checked.");
      return null;
    } finally {
      setBusy(false);
    }
  };

  const start = async (probeToken?: string) => {
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const token = probeToken ?? preflight?.token;
      if (!token) throw new Error("Check the selected model route before running the sample.");
      const id = attemptIdRef.current ?? crypto.randomUUID();
      attemptIdRef.current = id;
      const created = await window.electronAPI.startFirstTask(id, token);
      if (!created) throw new Error("The sample task could not be created.");
      setAttempt(created as Attempt);
      setPreflight(null);
      onTaskReady(created.task, created.workspace);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The sample task could not start.");
    } finally {
      setBusy(false);
    }
  };

  const retry = async () => {
    attemptIdRef.current = null;
    const result = await checkRoute();
    if (result?.token) await start(result.token);
  };

  const verify = async () => {
    if (!attempt || busy) return;
    setBusy(true);
    setError(null);
    try {
      const check = await window.electronAPI.verifyFirstTask(attempt.attemptId);
      setAttempt((current) => (current ? { ...current, check } : current));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Checks could not run.");
    } finally {
      setBusy(false);
    }
  };

  const openBrief = async () => {
    if (!attempt) return;
    setError(null);
    try {
      await window.electronAPI.inspectFirstTask(attempt.attemptId);
      onOpenBrief(`${attempt.workspace.path}/outputs/release-brief.html`);
      await refresh();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "The checked result changed. Run checks again.",
      );
      await refresh();
    }
  };

  const revise = async () => {
    if (!attempt || !onRevise || busy) return;
    setBusy(true);
    setError(null);
    try {
      await window.electronAPI.requestFirstTaskRevision(attempt.attemptId);
      const accepted = await onRevise(REVISION_PROMPT);
      if (accepted === false) {
        await window.electronAPI.cancelFirstTaskRevision(attempt.attemptId);
        throw new Error("The revision request was not accepted. Try again from this card.");
      }
      await refresh();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The revision could not start.");
    } finally {
      setBusy(false);
    }
  };

  if (taskId && attempt?.task.id !== taskId) return null;
  return (
    <section className="first-task-card" aria-label="First sample task">
      <h2>Turn a messy release folder into a launch brief</h2>
      <p>
        CoWork reads three included fictional files and creates a cleaned issue list, structured
        summary, and HTML brief.
      </p>
      {!attempt && !showBoundaries && (
        <button type="button" onClick={() => setShowBoundaries(true)}>
          Try the sample task
        </button>
      )}
      {!attempt && showBoundaries && (
        <>
          <p>
            Model: {modelRoute ?? "No configured route detected"}. The application will create a new
            private sample workspace when you start.
          </p>
          <p>
            The sample runs in a new private workspace. Only sample file tools are available; shell,
            browser, connected services, and task-tool network access are disabled. A cloud model
            still receives the sample content and may charge for inference.
          </p>
          <p>
            The route check makes a small inference request and may incur a provider charge. It
            tests this model's access and ability to request a harmless tool; it does not run the
            sample.
          </p>
          <button type="button" disabled={busy} onClick={() => void checkRoute()}>
            Check model route
          </button>
          {preflight && (
            <>
              <p role="status">
                Workspace and packaged inputs: {preflight.workspace}; endpoint: {preflight.endpoint};
                model: {preflight.model}; tool calls: {preflight.toolCalls}.
              </p>
              {preflight.workspaceDetail && <p role="alert">{preflight.workspaceDetail}. Check local storage and retry.</p>}
              {preflight.reason && <p role="alert">{preflightHelp[preflight.reason]}</p>}
            </>
          )}
          <button type="button" disabled={busy || !preflight?.token} onClick={() => void start()}>
            Run sample task
          </button>
          <button type="button" onClick={onOpenSettings}>
            Choose a model route
          </button>
        </>
      )}
      {attempt && (
        <>
          <p role="status">
            Task: {attempt.task.status}.{" "}
            {attempt.check?.passed
              ? "Checks passed. Open your release brief."
              : "A task response alone does not count as a checked result."}
          </p>
          {firstTaskRecovery(attempt.task) && <p role="alert">{firstTaskRecovery(attempt.task)}</p>}
          {attempt.task.status === "completed" && (
            <button type="button" disabled={busy} onClick={() => void verify()}>
              Run checks
            </button>
          )}
          {["failed", "cancelled"].includes(attempt.task.status) && (
            <>
              <button type="button" disabled={busy} onClick={() => void retry()}>
                Start a fresh sample
              </button>
              <button type="button" onClick={onOpenSettings}>
                Choose a model route
              </button>
            </>
          )}
          {attempt.check?.passed && (
            <button type="button" onClick={() => void openBrief()}>
              Open release brief
            </button>
          )}
          {attempt.inspectedAt &&
            attempt.check?.passed &&
            !attempt.revisionRequestedAt &&
            taskId &&
            onRevise && (
              <button type="button" disabled={busy} onClick={() => void revise()}>
                Revise for a release manager
              </button>
            )}
          {attempt.revisionRequestedAt && !attempt.revisionInspectedAt && (
            <p>
              Revision requested. Run checks after the task finishes, then open the revised brief.
            </p>
          )}
          {attempt.revisionInspectedAt && attempt.check?.passed && taskId && onUseOwnFiles && (
            <button type="button" onClick={onUseOwnFiles}>
              Try with my files
            </button>
          )}
          {!taskId && (
            <button type="button" onClick={() => onTaskReady(attempt.task, attempt.workspace)}>
              Return to sample task
            </button>
          )}
          {attempt.check?.errors?.length ? (
            <ul>
              {attempt.check.errors.map((message) => (
                <li key={message}>{message}</li>
              ))}
            </ul>
          ) : null}
          {attempt.check?.passed && (
            <small>
              Checks validate specified facts and structure, not every sentence or recommendation.
              Editing an output requires another check.
            </small>
          )}
        </>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
