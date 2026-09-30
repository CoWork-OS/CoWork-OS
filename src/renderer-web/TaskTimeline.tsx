import { useEffect, useRef, useState } from "react";
import { BrowserHostTransport, WebTransportError } from "./transport";

type Cursor = { taskId: string; position: number };
type HistoryCursor = { order: number; timestamp: number; id: string };
type TimelineEvent = {
  id: string;
  type: string;
  timestamp: number;
  seq?: number;
  payload?: Record<string, unknown>;
};
type TimelineSnapshot = {
  events: TimelineEvent[];
  cursor: Cursor;
  hasMoreHistory: boolean;
  nextHistoryCursor: HistoryCursor | null;
};
type HistoryPage = {
  events: TimelineEvent[];
  hasMoreHistory: boolean;
  nextHistoryCursor: HistoryCursor | null;
};
type TimelineChange =
  | { operation: "upsert"; event: TimelineEvent }
  | { operation: "delete"; eventId: string };
type TimelinePage =
  | { outcome: "cursor_expired" }
  | {
      outcome: "no_changes" | "page" | "page_with_more";
      changes: TimelineChange[];
      nextCursor: Cursor;
      hasMore: boolean;
    };

export class TimelineHistoryRequestGuard {
  private generation = 0;
  private activeToken: number | null = null;

  begin(): number | null {
    if (this.activeToken !== null) return null;
    const token = ++this.generation;
    this.activeToken = token;
    return token;
  }

  isCurrent(token: number): boolean {
    return this.activeToken === token && this.generation === token;
  }

  invalidate(): void {
    this.generation += 1;
    this.activeToken = null;
  }

  finish(token: number): boolean {
    if (!this.isCurrent(token)) return false;
    this.activeToken = null;
    return true;
  }
}

const MAX_VISIBLE_EVENTS = 600;

export function TaskTimeline({
  taskId,
  workspaceId,
  transport,
  connected,
}: {
  taskId: string;
  workspaceId: string;
  transport: BrowserHostTransport | null;
  connected: boolean;
}) {
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [hasMoreHistory, setHasMoreHistory] = useState(false);
  const [historyCursor, setHistoryCursor] = useState<HistoryCursor | null>(null);
  const [showingOlder, setShowingOlder] = useState(false);
  const showingOlderRef = useRef(false);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const historyRequestGuardRef = useRef<TimelineHistoryRequestGuard | null>(null);
  if (!historyRequestGuardRef.current) {
    historyRequestGuardRef.current = new TimelineHistoryRequestGuard();
  }
  const historyRequestGuard = historyRequestGuardRef.current;
  const timelineScopeRef = useRef({ taskId, workspaceId, transport, connected });
  timelineScopeRef.current = { taskId, workspaceId, transport, connected };
  const [reloadToken, setReloadToken] = useState(0);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState("");

  useEffect(() => {
    if (!transport || !connected) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let cursor: Cursor | null = null;

    const schedule = (delay: number) => {
      if (active) timer = setTimeout(() => void sync(), delay);
    };

    const sync = async () => {
      if (!active) return;
      try {
        if (!cursor) {
          setState("loading");
          const result = await transport.request<unknown>("task.events.snapshot", {
            taskId,
            workspaceId,
          });
          const snapshot = parseSnapshot(result, taskId);
          if (!active) return;
          cursor = snapshot.cursor;
          setEvents(snapshot.events.slice(-MAX_VISIBLE_EVENTS));
          setHasMoreHistory(snapshot.hasMoreHistory);
          setHistoryCursor(snapshot.nextHistoryCursor);
          setState("ready");
          setError("");
        }

        for (let pageCount = 0; pageCount < 10 && active && cursor; pageCount += 1) {
          const result = await transport.request<unknown>("task.events.page", {
            taskId,
            workspaceId,
            afterCursor: cursor,
          });
          const page = parsePage(result, taskId);
          if (!active) return;
          if (page.outcome === "cursor_expired") {
            cursor = null;
            historyRequestGuard.invalidate();
            setLoadingOlder(false);
            showingOlderRef.current = false;
            setShowingOlder(false);
            setHistoryCursor(null);
            setError("History changed while you were away. Reloading the latest committed events.");
            schedule(0);
            return;
          }
          cursor = page.nextCursor;
          if (page.changes.length) {
            setEvents((current) => applyChanges(current, page.changes, showingOlderRef.current));
          }
          setState("ready");
          setError("");
          if (!page.hasMore) {
            schedule(2_500);
            return;
          }
        }
        schedule(0);
      } catch (cause) {
        if (!active) return;
        if (!(cause instanceof WebTransportError) || cause.code !== "HOST_UNAVAILABLE") {
          cursor = null;
        }
        setError(
          cause instanceof WebTransportError || cause instanceof Error
            ? cause.message
            : "Could not load this task's committed events.",
        );
        setState("error");
        schedule(5_000);
      }
    };

    void sync();
    return () => {
      active = false;
      historyRequestGuard.invalidate();
      setLoadingOlder(false);
      if (timer) clearTimeout(timer);
    };
  }, [taskId, workspaceId, transport, connected, reloadToken]);

  const loadOlder = async () => {
    if (!transport || !connected || !historyCursor) return;
    const requestToken = historyRequestGuard.begin();
    if (requestToken === null) return;
    const requestScope = { taskId, workspaceId, transport };
    const isCurrentScope = () => {
      const current = timelineScopeRef.current;
      return (
        current.taskId === requestScope.taskId &&
        current.workspaceId === requestScope.workspaceId &&
        current.transport === requestScope.transport &&
        current.connected
      );
    };
    setLoadingOlder(true);
    try {
      const result = await transport.request<unknown>("task.events.history", {
        taskId,
        workspaceId,
        beforeCursor: historyCursor,
      });
      if (!historyRequestGuard.isCurrent(requestToken) || !isCurrentScope()) return;
      const page = parseHistoryPage(result, taskId);
      showingOlderRef.current = true;
      setShowingOlder(true);
      setEvents((current) => mergeOlderEvents(current, page.events));
      setHasMoreHistory(page.hasMoreHistory);
      setHistoryCursor(page.nextHistoryCursor);
      setError("");
    } catch (cause) {
      if (historyRequestGuard.isCurrent(requestToken) && isCurrentScope()) {
        setError(cause instanceof Error ? cause.message : "Could not load older activity.");
      }
    } finally {
      if (historyRequestGuard.finish(requestToken)) setLoadingOlder(false);
    }
  };

  const backToLatest = () => {
    historyRequestGuard.invalidate();
    setLoadingOlder(false);
    showingOlderRef.current = false;
    setShowingOlder(false);
    setEvents([]);
    setState("loading");
    setReloadToken((current) => current + 1);
  };

  return (
    <section className="web-timeline" aria-label="Task history">
      <div className="web-timeline-heading">
        <h3>Committed activity</h3>
        {!connected && <span className="web-muted">Reconnecting…</span>}
      </div>
      {state === "loading" && <p className="web-muted">Loading recent activity…</p>}
      {error && (
        <p className="web-inline-error" role={state === "error" ? "alert" : "status"}>
          {error}
        </p>
      )}
      {showingOlder && (
        <button type="button" className="web-history-button" onClick={backToLatest}>
          Back to latest
        </button>
      )}
      {hasMoreHistory && historyCursor && (
        <button
          type="button"
          className="web-history-button"
          disabled={!connected || loadingOlder}
          onClick={() => void loadOlder()}
        >
          {loadingOlder ? "Loading older activity…" : "Load older activity"}
        </button>
      )}
      {state === "ready" && events.length === 0 && (
        <p className="web-muted">No committed activity yet.</p>
      )}
      {events.length > 0 && (
        <ol className="web-timeline-list">
          {events.map((event) => (
            <li key={event.id}>
              <span className="web-timeline-time">{formatTime(event.timestamp)}</span>
              <span className="web-timeline-type">{humanize(event.type)}</span>
              {eventMessage(event) && <p>{eventMessage(event)}</p>}
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}

export function parseSnapshot(value: unknown, taskId: string): TimelineSnapshot {
  if (!isRecord(value) || value.taskId !== taskId || !Array.isArray(value.events)) {
    throw new Error("The host returned an invalid task history.");
  }
  const cursor = parseCursor(value.cursor, taskId);
  const nextHistoryCursor = parseHistoryCursor(value.nextHistoryCursor);
  if (
    !cursor ||
    typeof value.hasMoreHistory !== "boolean" ||
    (value.hasMoreHistory && !nextHistoryCursor)
  ) {
    throw new Error("The host returned an invalid task history cursor.");
  }
  const events = value.events.map(parseEvent);
  if (events.some((event) => event === null)) {
    throw new Error("The host returned an invalid task history event.");
  }
  return {
    cursor,
    hasMoreHistory: value.hasMoreHistory,
    nextHistoryCursor,
    events: events as TimelineEvent[],
  };
}

export function parseHistoryPage(value: unknown, taskId: string): HistoryPage {
  if (
    !isRecord(value) ||
    (value.taskId !== undefined && value.taskId !== taskId) ||
    !Array.isArray(value.events)
  ) {
    throw new Error("The host returned an invalid older task history page.");
  }
  const events = value.events.map(parseEvent);
  const nextHistoryCursor = parseHistoryCursor(value.nextHistoryCursor);
  if (
    events.some((event) => event === null) ||
    typeof value.hasMoreHistory !== "boolean" ||
    (value.hasMoreHistory && !nextHistoryCursor)
  ) {
    throw new Error("The host returned an invalid older task history cursor.");
  }
  return {
    events: events as TimelineEvent[],
    hasMoreHistory: value.hasMoreHistory,
    nextHistoryCursor,
  };
}

function parseHistoryCursor(value: unknown): HistoryCursor | null {
  return isRecord(value) &&
    Number.isFinite(value.order) &&
    Number.isFinite(value.timestamp) &&
    typeof value.id === "string" &&
    value.id.length > 0
    ? { order: Number(value.order), timestamp: Number(value.timestamp), id: value.id }
    : null;
}

export function parsePage(value: unknown, taskId: string): TimelinePage {
  if (!isRecord(value) || value.taskId !== taskId) {
    throw new Error("The host returned an invalid task history page.");
  }
  if (value.outcome === "cursor_expired") return { outcome: "cursor_expired" };
  if (
    value.outcome !== "no_changes" &&
    value.outcome !== "page" &&
    value.outcome !== "page_with_more"
  ) {
    throw new Error("The host could not resume this task history.");
  }
  const nextCursor = parseCursor(value.nextCursor, taskId);
  if (!nextCursor || !Array.isArray(value.changes) || typeof value.hasMore !== "boolean") {
    throw new Error("The host returned an invalid task history page.");
  }
  const changes = value.changes.map(parseChange);
  if (changes.some((change) => change === null)) {
    throw new Error("The host returned an invalid task history change.");
  }
  return {
    outcome: value.outcome,
    nextCursor,
    hasMore: value.hasMore,
    changes: changes as TimelineChange[],
  };
}

function parseCursor(value: unknown, taskId: string): Cursor | null {
  return isRecord(value) &&
    value.taskId === taskId &&
    Number.isSafeInteger(value.position) &&
    Number(value.position) >= 0
    ? { taskId, position: Number(value.position) }
    : null;
}

function parseChange(value: unknown): TimelineChange | null {
  if (!isRecord(value)) return null;
  if (value.operation === "delete" && typeof value.eventId === "string") {
    return { operation: "delete", eventId: value.eventId };
  }
  const event = parseEvent(value.event);
  return value.operation === "upsert" && event ? { operation: "upsert", event } : null;
}

function parseEvent(value: unknown): TimelineEvent | null {
  if (
    !isRecord(value) ||
    typeof value.id !== "string" ||
    typeof value.type !== "string" ||
    typeof value.timestamp !== "number" ||
    !Number.isFinite(value.timestamp)
  )
    return null;
  return {
    id: value.id,
    type: value.type,
    timestamp: value.timestamp,
    seq: typeof value.seq === "number" ? value.seq : undefined,
    payload: isRecord(value.payload) ? value.payload : undefined,
  };
}

export function applyChanges(
  current: TimelineEvent[],
  changes: TimelineChange[],
  keepOldest = false,
): TimelineEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const change of changes) {
    if (change.operation === "delete") byId.delete(change.eventId);
    else byId.set(change.event.id, change.event);
  }
  const sorted = [...byId.values()].sort(
    (a, b) =>
      (a.seq ?? a.timestamp) - (b.seq ?? b.timestamp) ||
      a.timestamp - b.timestamp ||
      a.id.localeCompare(b.id),
  );
  return keepOldest ? sorted.slice(0, MAX_VISIBLE_EVENTS) : sorted.slice(-MAX_VISIBLE_EVENTS);
}

function mergeOlderEvents(current: TimelineEvent[], older: TimelineEvent[]): TimelineEvent[] {
  const byId = new Map(current.map((event) => [event.id, event]));
  for (const event of older) byId.set(event.id, event);
  return [...byId.values()]
    .sort(
      (a, b) =>
        (a.seq ?? a.timestamp) - (b.seq ?? b.timestamp) ||
        a.timestamp - b.timestamp ||
        a.id.localeCompare(b.id),
    )
    .slice(0, MAX_VISIBLE_EVENTS);
}

function eventMessage(event: TimelineEvent): string | null {
  const message = event.payload?.message ?? event.payload?.text;
  return typeof message === "string" && message.trim() ? message.slice(0, 2_000) : null;
}

function formatTime(value: number): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function humanize(value: string): string {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
