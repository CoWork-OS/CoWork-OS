import { useEffect, useRef, useState } from "react";
import type { TaskStatus } from "../shared/types";
import { isTerminalTaskStatus } from "../shared/task-status";
import type { WebSessionBootstrap } from "../shared/host-api/contracts";
import { BrowserHostTransport, WebTransportError } from "./transport";
import "./TaskCancellation.css";

type TaskVersion = {
  id: string;
  status: string;
  updatedAt?: string | number;
};
type Version = { status: TaskStatus; updatedAt: number };

type PendingCancellation = {
  key: string;
  expectedStatus: TaskStatus;
  expectedUpdatedAt: number;
  /** False means the user staged this request but has not sent it yet. */
  submitted: boolean;
};

type ObservedCancellation = {
  taskId: string;
  workspaceId: string;
  operationKey: string;
  outcome: "observed_terminal" | "pending";
  status: TaskStatus;
  updatedAt: number;
};

const TASK_STATUSES = new Set<TaskStatus>([
  "pending",
  "queued",
  "planning",
  "executing",
  "paused",
  "blocked",
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);
const OPERATION_KEY_RE = /^[A-Za-z0-9._:-]{8,128}$/;

export function TaskCancellation({
  task,
  workspaceId,
  session,
  transport,
  connected,
  onTaskObserved,
}: {
  task: TaskVersion;
  workspaceId: string;
  session: WebSessionBootstrap;
  transport: BrowserHostTransport | null;
  connected: boolean;
  onTaskObserved?: (result: ObservedCancellation) => void;
}) {
  const storageKey = `cowork:web:task-cancel:${session.host.installationId}:${session.host.profileId}:${workspaceId}:${task.id}`;
  const [pending, setPending] = useState<PendingCancellation | null>(() =>
    readPendingCancellation(storageKey),
  );
  const pendingRef = useRef(pending);
  const [latestVersion, setLatestVersion] = useState(() => taskVersion(task));
  const latestVersionRef = useRef(latestVersion);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState(() =>
    pending
      ? pending.submitted
        ? "A previous cancellation request is unconfirmed. Check it again to reconcile the same request key."
        : "A cancellation request is saved for this task version and is ready to send."
      : "",
  );
  const [error, setError] = useState("");
  const [staleRequest, setStaleRequest] = useState(false);
  const [freshStateLoaded, setFreshStateLoaded] = useState(false);

  const setAttempt = (next: PendingCancellation | null) => {
    pendingRef.current = next;
    setPending(next);
  };

  useEffect(() => {
    const next = taskVersion(task);
    latestVersionRef.current = next;
    setLatestVersion(next);
    const attempt = pendingRef.current;
    if (attempt && !attempt.submitted && next) {
      if (isTerminalTaskStatus(next.status)) {
        setAttempt(null);
        writePendingCancellation(storageKey, null);
        setStaleRequest(false);
        setFreshStateLoaded(false);
        setError("");
        setNotice(
          `The current task state is ${humanize(next.status)}. No cancellation request is needed.`,
        );
      } else if (
        next.status !== attempt.expectedStatus ||
        next.updatedAt !== attempt.expectedUpdatedAt
      ) {
        setStaleRequest(true);
        setFreshStateLoaded(true);
        setNotice(
          "The task changed before this saved request was sent. Start a new request from its current state if you still want to stop it.",
        );
      }
    }
  }, [task.id, task.status, task.updatedAt, storageKey]);

  const version = latestVersion;
  const cancellable = version !== null && !isTerminalTaskStatus(version.status);
  const canStartFreshRequest =
    staleRequest &&
    freshStateLoaded &&
    pending !== null &&
    version !== null &&
    !isTerminalTaskStatus(version.status) &&
    (version.status !== pending.expectedStatus || version.updatedAt !== pending.expectedUpdatedAt);
  const canSubmit =
    connected &&
    transport !== null &&
    !busy &&
    (pending?.submitted === true ||
      (cancellable &&
        version !== null &&
        (pending === null ||
          (pending.expectedStatus === version.status &&
            pending.expectedUpdatedAt === version.updatedAt))));

  const cancelOrReconcile = async () => {
    if (!transport || !connected || busyRef.current) return;

    let attempt = pendingRef.current;
    if (!attempt) {
      const current = latestVersionRef.current;
      if (!current || isTerminalTaskStatus(current.status)) return;
      attempt = {
        key: createOperationKey(),
        expectedStatus: current.status,
        expectedUpdatedAt: current.updatedAt,
        submitted: true,
      };
      if (!writePendingCancellation(storageKey, attempt)) {
        setError(
          "This tab could not save the request key. The host was not sent a cancellation request.",
        );
        return;
      }
      setAttempt(attempt);
    } else if (!attempt.submitted) {
      attempt = { ...attempt, submitted: true };
      if (!writePendingCancellation(storageKey, attempt)) {
        setError(
          "This tab could not save the request state. The host was not sent a cancellation request.",
        );
        return;
      }
      setAttempt(attempt);
    }

    busyRef.current = true;
    setBusy(true);
    setError("");
    setStaleRequest(false);
    setFreshStateLoaded(false);
    setNotice("Checking the task with the saved cancellation request key…");
    try {
      const result = await requestTaskCancellation(transport, task.id, workspaceId, attempt);
      const resultVersion = { status: result.status, updatedAt: result.updatedAt };
      latestVersionRef.current = resultVersion;
      setLatestVersion(resultVersion);
      onTaskObserved?.(result);
      if (result.outcome === "observed_terminal") {
        setAttempt(null);
        writePendingCancellation(storageKey, null);
        setNotice(
          `The host reports this task is ${humanize(result.status)}. This is the current observed state.`,
        );
      } else {
        setNotice(
          `The host currently reports ${humanize(result.status)}. Cancellation is not confirmed; check again with the same request key.`,
        );
      }
    } catch (cause) {
      if (cause instanceof WebTransportError && cause.code === "STALE_STATE") {
        setStaleRequest(true);
        setError(
          "The host rejected this request because the task version changed. Loading its current version before offering another request.",
        );
        await refreshTaskVersion(attempt);
      } else if (cause instanceof WebTransportError && cause.code === "CONFLICT") {
        setError(
          "The host found a different request using this key. The saved key is retained; review the task before continuing.",
        );
      } else {
        setError(
          cause instanceof WebTransportError && cause.code === "OUTCOME_UNKNOWN"
            ? "The host has not confirmed the outcome. The request key is saved; check or retry with that same key."
            : cause instanceof Error
              ? cause.message
              : "The cancellation outcome is unknown. Check again with the same request key.",
        );
      }
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };

  const refreshTaskVersion = async (attempt: PendingCancellation) => {
    if (!transport || !connected) {
      setFreshStateLoaded(false);
      setError(
        "The task changed, but its current version could not be loaded. Reconnect to check its state; the saved request key is retained.",
      );
      return;
    }
    try {
      const raw = await transport.request<unknown>("task.get", { taskId: task.id });
      const observed = parseCurrentTaskVersion(raw, task.id, workspaceId);
      if (!observed) throw new Error("The host returned invalid task details.");
      const observedVersion = { status: observed.status, updatedAt: observed.updatedAt };
      latestVersionRef.current = observedVersion;
      setLatestVersion(observedVersion);
      onTaskObserved?.({
        taskId: task.id,
        workspaceId,
        operationKey: attempt.key,
        outcome: isTerminalTaskStatus(observed.status) ? "observed_terminal" : "pending",
        status: observed.status,
        updatedAt: observed.updatedAt,
      });
      setFreshStateLoaded(true);
      if (isTerminalTaskStatus(observed.status)) {
        setAttempt(null);
        writePendingCancellation(storageKey, null);
        setStaleRequest(false);
        setError("");
        setNotice(
          `The current task state is ${humanize(observed.status)}. No cancellation request is needed.`,
        );
      } else {
        setError(
          "The original task version is stale. The current version is loaded; start a new request only if you still want the host to stop this task.",
        );
      }
    } catch (cause) {
      setFreshStateLoaded(false);
      setError(
        cause instanceof Error
          ? `${cause.message} The original request key is retained.`
          : "Could not load the current task version. The original request key is retained.",
      );
    }
  };

  const startFromCurrentState = () => {
    if (!canStartFreshRequest || !version || busyRef.current) return;
    const next: PendingCancellation = {
      key: createOperationKey(),
      expectedStatus: version.status,
      expectedUpdatedAt: version.updatedAt,
      submitted: false,
    };
    if (!writePendingCancellation(storageKey, next)) {
      setError("This tab could not save a new request key. No new cancellation request was sent.");
      return;
    }
    setAttempt(next);
    setStaleRequest(false);
    setFreshStateLoaded(false);
    setError("");
    setNotice(
      "A new request key is saved for the current task version. Select Send cancellation request to send it.",
    );
  };

  return (
    <section className="web-task-cancellation" aria-label="Cancel task">
      <div className="web-task-cancellation-copy">
        <h3>Stop task</h3>
        <p>
          {pending
            ? pending.submitted
              ? "Check or retry the last request. The browser will reuse its original key and task version."
              : "A new cancellation request is staged with a saved key for the current task version."
            : cancellable
              ? "Ask the host to stop this active task."
              : `This task is already ${humanize(task.status)}.`}
        </p>
      </div>
      <div className="web-task-cancellation-actions">
        <button
          className="web-task-cancel-button"
          type="button"
          disabled={!canSubmit}
          onClick={() => void cancelOrReconcile()}
        >
          {busy
            ? "Checking…"
            : pending?.submitted
              ? "Check / retry same request"
              : pending
                ? "Send cancellation request"
                : "Cancel task"}
        </button>
        {canStartFreshRequest && (
          <button
            className="web-task-cancel-restart"
            type="button"
            disabled={busy}
            onClick={startFromCurrentState}
          >
            Start a new request from current state
          </button>
        )}
      </div>
      {notice && (
        <p className="web-task-cancel-notice" role="status">
          {notice}
        </p>
      )}
      {error && (
        <p className="web-task-cancel-error" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}

function taskVersion(task: TaskVersion): Version | null {
  if (
    !TASK_STATUSES.has(task.status as TaskStatus) ||
    typeof task.updatedAt !== "number" ||
    !Number.isSafeInteger(task.updatedAt) ||
    task.updatedAt < 0
  ) {
    return null;
  }
  return { status: task.status as TaskStatus, updatedAt: task.updatedAt };
}

export async function requestTaskCancellation(
  transport: BrowserHostTransport,
  taskId: string,
  workspaceId: string,
  attempt: PendingCancellation,
): Promise<ObservedCancellation> {
  const raw = await transport.request<unknown>(
    "task.cancel",
    {
      taskId,
      workspaceId,
      expectedStatus: attempt.expectedStatus,
      expectedUpdatedAt: attempt.expectedUpdatedAt,
    },
    { operationKey: attempt.key, mutation: true, timeoutMs: 120_000 },
  );
  return parseCancellationResult(raw, taskId, workspaceId, attempt.key);
}

function parseCancellationResult(
  value: unknown,
  taskId: string,
  workspaceId: string,
  operationKey: string,
): ObservedCancellation {
  if (
    !isRecord(value) ||
    value.taskId !== taskId ||
    value.workspaceId !== workspaceId ||
    value.operationKey !== operationKey ||
    (value.outcome !== "observed_terminal" && value.outcome !== "pending") ||
    typeof value.status !== "string" ||
    !TASK_STATUSES.has(value.status as TaskStatus) ||
    !Number.isSafeInteger(value.updatedAt) ||
    Number(value.updatedAt) < 0 ||
    (value.outcome === "observed_terminal" && !isTerminalTaskStatus(value.status as TaskStatus)) ||
    (value.outcome === "pending" && isTerminalTaskStatus(value.status as TaskStatus))
  ) {
    throw new Error("The host returned an invalid cancellation outcome.");
  }
  return {
    taskId,
    workspaceId,
    operationKey,
    outcome: value.outcome,
    status: value.status as TaskStatus,
    updatedAt: Number(value.updatedAt),
  };
}

function parseCurrentTaskVersion(
  value: unknown,
  taskId: string,
  workspaceId: string,
): { status: TaskStatus; updatedAt: number } | null {
  if (!isRecord(value) || !isRecord(value.task)) return null;
  const task = value.task;
  if (task.id !== taskId || task.workspaceId !== workspaceId) return null;
  return taskVersion({
    id: task.id,
    status: typeof task.status === "string" ? task.status : "",
    updatedAt: task.updatedAt as string | number | undefined,
  });
}

export function readPendingCancellation(storageKey: string): PendingCancellation | null {
  try {
    const raw = window.sessionStorage.getItem(storageKey);
    if (!raw) return null;
    const value: unknown = JSON.parse(raw);
    if (
      !isRecord(value) ||
      typeof value.key !== "string" ||
      !OPERATION_KEY_RE.test(value.key) ||
      typeof value.expectedStatus !== "string" ||
      !TASK_STATUSES.has(value.expectedStatus as TaskStatus) ||
      !Number.isSafeInteger(value.expectedUpdatedAt) ||
      Number(value.expectedUpdatedAt) < 0
    ) {
      return null;
    }
    return {
      key: value.key,
      expectedStatus: value.expectedStatus as TaskStatus,
      expectedUpdatedAt: Number(value.expectedUpdatedAt),
      // Existing saved attempts were submitted before the page was interrupted.
      submitted: value.submitted !== false,
    };
  } catch {
    return null;
  }
}

function writePendingCancellation(
  storageKey: string,
  pending: PendingCancellation | null,
): boolean {
  try {
    if (pending) window.sessionStorage.setItem(storageKey, JSON.stringify(pending));
    else window.sessionStorage.removeItem(storageKey);
    return true;
  } catch {
    return false;
  }
}

function createOperationKey(): string {
  const webCrypto = globalThis.crypto;
  const key =
    typeof webCrypto?.randomUUID === "function"
      ? webCrypto.randomUUID()
      : `cancel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${Math.random().toString(36).slice(2)}`;
  if (!OPERATION_KEY_RE.test(key))
    throw new Error("Could not create a valid cancellation request key.");
  return key;
}

function humanize(value: string): string {
  return value.replace(/_/g, " ");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
