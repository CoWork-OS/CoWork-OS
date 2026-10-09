import { useCallback, useEffect, useMemo, useState } from "react";
import { Download, RefreshCw, Send, Trash2 } from "lucide-react";

type DiagnosticsKind = "console" | "network" | "downloads" | "storage" | "trace";

type DiagnosticsEntry = {
  level?: string;
  text?: string;
  source?: string;
  method?: string;
  url?: string;
  status?: number;
  resourceType?: string;
  failed?: boolean;
  errorText?: string;
  timestamp: number;
};

type DiagnosticsDrawerProps = {
  taskId: string;
  sessionId: string;
  tabId: string;
  onSendToAgent?: (message: string) => void;
};

const KINDS: Array<{ id: DiagnosticsKind; label: string }> = [
  { id: "console", label: "Console" },
  { id: "network", label: "Network" },
  { id: "downloads", label: "Downloads" },
  { id: "storage", label: "Storage" },
  { id: "trace", label: "Trace" },
];

const POLL_MS = 1500;

function formatTime(timestamp: number): string {
  return new Date(timestamp).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function isErrorEntry(entry: DiagnosticsEntry): boolean {
  return entry.level === "error" || entry.level === "assert";
}

/**
 * Developer diagnostics for the visible tab, read from the main process's
 * (already redacted) buffers: console, network, downloads, storage, trace.
 */
export function DiagnosticsDrawer({
  taskId,
  sessionId,
  tabId,
  onSendToAgent,
}: DiagnosticsDrawerProps) {
  const [kind, setKind] = useState<DiagnosticsKind>("console");
  const [entries, setEntries] = useState<DiagnosticsEntry[]>([]);
  const [storage, setStorage] = useState<unknown>(null);
  const [error, setError] = useState("");
  const [filter, setFilter] = useState("");
  const [level, setLevel] = useState<"all" | "errors">("all");
  const [failedOnly, setFailedOnly] = useState(false);
  const [traceActive, setTraceActive] = useState(false);
  const [traceMessage, setTraceMessage] = useState("");

  const load = useCallback(
    async (clear = false) => {
      const getDiagnostics = window.electronAPI.getBrowserWorkbenchDiagnostics;
      if (!getDiagnostics || kind === "trace") return;
      try {
        const result = await getDiagnostics({ taskId, sessionId, tabId, kind, clear });
        if (!result?.success) {
          setError(result?.error || "Diagnostics are unavailable for this tab.");
          return;
        }
        setError("");
        setTraceActive(result.traceActive === true);
        if (kind === "storage") setStorage(result.storage ?? null);
        else setEntries(result.entries || []);
      } catch (loadError) {
        setError(loadError instanceof Error ? loadError.message : "Diagnostics failed.");
      }
    },
    [kind, sessionId, tabId, taskId],
  );

  useEffect(() => {
    setEntries([]);
    setStorage(null);
    void load();
    if (kind === "storage" || kind === "trace") return;
    const timer = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(timer);
  }, [kind, load]);

  const visible = useMemo(() => {
    const query = filter.trim().toLowerCase();
    return entries
      .filter((entry) => kind !== "console" || level === "all" || isErrorEntry(entry))
      .filter(
        (entry) =>
          kind !== "network" ||
          !failedOnly ||
          entry.failed === true ||
          (typeof entry.status === "number" && entry.status >= 400),
      )
      .filter(
        (entry) =>
          !query ||
          [entry.text, entry.url, entry.method, entry.errorText, entry.source]
            .filter(Boolean)
            .some((value) => String(value).toLowerCase().includes(query)),
      )
      .slice(-200)
      .reverse();
  }, [entries, failedOnly, filter, kind, level]);

  const errors = entries.filter(isErrorEntry);

  const toggleTrace = async () => {
    const trace = window.electronAPI.browserWorkbenchTrace;
    if (!trace) return;
    const result = await trace({
      taskId,
      sessionId,
      tabId,
      action: traceActive ? "stop" : "start",
    });
    if (!result?.success) {
      setTraceMessage(result?.error || "Trace failed.");
      return;
    }
    setTraceActive(!traceActive);
    setTraceMessage(result.message || (traceActive ? "Trace stopped." : "Recording a trace…"));
  };

  return (
    <div className="browser-workbench-diagnostics">
      <div className="browser-workbench-diagnostics-tabs" role="tablist">
        {KINDS.map((entry) => (
          <button
            key={entry.id}
            type="button"
            role="tab"
            aria-selected={kind === entry.id}
            className={kind === entry.id ? "is-active" : ""}
            onClick={() => setKind(entry.id)}
          >
            {entry.id === "downloads" && <Download size={13} aria-hidden="true" />}
            {entry.label}
          </button>
        ))}
        <span className="browser-workbench-diagnostics-spacer" />
        {(kind === "console" || kind === "network") && (
          <>
            <input
              className="browser-workbench-diagnostics-filter"
              value={filter}
              placeholder="Filter"
              aria-label="Filter diagnostics"
              onChange={(event) => setFilter(event.target.value)}
            />
            {kind === "console" ? (
              <select
                value={level}
                aria-label="Console level"
                onChange={(event) => setLevel(event.target.value === "errors" ? "errors" : "all")}
              >
                <option value="all">All levels</option>
                <option value="errors">Errors</option>
              </select>
            ) : (
              <label className="browser-workbench-diagnostics-check">
                <input
                  type="checkbox"
                  checked={failedOnly}
                  onChange={(event) => setFailedOnly(event.target.checked)}
                />
                Failed only
              </label>
            )}
            <button type="button" title="Clear" onClick={() => void load(true)}>
              <Trash2 size={13} aria-hidden="true" />
            </button>
          </>
        )}
        {kind === "storage" && (
          <button type="button" title="Refresh" onClick={() => void load()}>
            <RefreshCw size={13} aria-hidden="true" />
          </button>
        )}
        {kind === "console" && errors.length > 0 && onSendToAgent && (
          <button
            type="button"
            title="Send console errors to CoWork"
            onClick={() =>
              onSendToAgent(
                `The page in the browser logged these console errors. Please look into them:\n\n${errors
                  .slice(-20)
                  .map((entry) => `- ${entry.text || ""}`)
                  .join("\n")}`,
              )
            }
          >
            <Send size={13} aria-hidden="true" />
            Send errors
          </button>
        )}
      </div>
      <div className="browser-workbench-diagnostics-body">
        {error ? (
          <div className="browser-workbench-diagnostics-empty">{error}</div>
        ) : kind === "trace" ? (
          <div className="browser-workbench-diagnostics-trace">
            <button type="button" onClick={() => void toggleTrace()}>
              {traceActive ? "Stop trace" : "Start trace"}
            </button>
            {traceMessage && <span>{traceMessage}</span>}
          </div>
        ) : kind === "storage" ? (
          <pre className="browser-workbench-diagnostics-storage">
            {storage ? JSON.stringify(storage, null, 2) : "Loading…"}
          </pre>
        ) : visible.length === 0 ? (
          <div className="browser-workbench-diagnostics-empty">
            {kind === "downloads" ? "No downloads in this tab." : "Nothing recorded yet."}
          </div>
        ) : (
          <ul className={`browser-workbench-diagnostics-list kind-${kind}`}>
            {visible.map((entry, index) => (
              <li
                key={`${entry.timestamp}-${index}`}
                className={`${isErrorEntry(entry) || entry.failed ? "is-error" : ""} ${
                  entry.level === "warning" || entry.level === "warn" ? "is-warning" : ""
                }`}
              >
                <span className="browser-workbench-diagnostics-time">
                  {formatTime(entry.timestamp)}
                </span>
                {kind === "console" ? (
                  <>
                    <span className="browser-workbench-diagnostics-level">{entry.level}</span>
                    <span className="browser-workbench-diagnostics-text">{entry.text}</span>
                  </>
                ) : (
                  <>
                    <span className="browser-workbench-diagnostics-level">
                      {entry.failed ? "failed" : entry.status || entry.method || ""}
                    </span>
                    <span className="browser-workbench-diagnostics-text" title={entry.url}>
                      {entry.resourceType ? `[${entry.resourceType}] ` : ""}
                      {entry.url}
                      {entry.errorText ? ` — ${entry.errorText}` : ""}
                    </span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
