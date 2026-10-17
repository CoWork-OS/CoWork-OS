import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  AgentImportDetection,
  AgentImportItemResult,
  AgentImportResult,
  AgentImportSource,
  Workspace,
} from "../../../shared/types";
import { isTempWorkspaceId } from "../../../shared/types";
import "./agent-import.css";

const SOURCE_NAMES: Record<AgentImportSource, string> = {
  hermes: "Hermes Agent",
  openclaw: "OpenClaw",
};

const STATUS_LABELS: Record<AgentImportItemResult["status"], string> = {
  imported: "Imported",
  ready: "",
  skipped: "Skipped",
  failed: "Failed",
};

export interface AgentImportPanelProps {
  /** Preselected workspace for scheduled tasks, instructions and agent notes. */
  workspaceId?: string;
  /** Onboarding: no heading, only the sources that were found. */
  compact?: boolean;
  /** Called after an import finishes (not after a preview). */
  onImported?: (result: AgentImportResult) => void;
}

function shortHome(home: string): string {
  return home.replace(/^\/Users\/[^/]+/, "~").replace(/^\/home\/[^/]+/, "~");
}

function ItemRow({
  item,
  checked,
  onToggle,
}: {
  item: AgentImportItemResult;
  checked?: boolean;
  onToggle?: () => void;
}) {
  const selectable = item.status === "ready" && onToggle;
  const note = item.reason || item.detail;
  return (
    <li className={`agent-import-item agent-import-item--${item.status}`}>
      {selectable ? (
        <input
          type="checkbox"
          className="agent-import-check"
          checked={checked}
          onChange={onToggle}
          aria-label={`Import ${item.label}`}
        />
      ) : (
        <span className="agent-import-status">{STATUS_LABELS[item.status]}</span>
      )}
      <span className="agent-import-label">{item.label}</span>
      {note && <span className="agent-import-note">{note}</span>}
    </li>
  );
}

export function AgentImportPanel({ workspaceId, compact, onImported }: AgentImportPanelProps) {
  const [detections, setDetections] = useState<AgentImportDetection[] | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [source, setSource] = useState<AgentImportSource | null>(null);
  const [withSecrets, setWithSecrets] = useState(false);
  const [targetWorkspaceId, setTargetWorkspaceId] = useState(
    workspaceId && !isTempWorkspaceId(workspaceId) ? workspaceId : "",
  );
  const [preview, setPreview] = useState<AgentImportResult | null>(null);
  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const [result, setResult] = useState<AgentImportResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const [found, list] = await Promise.all([
          window.electronAPI.detectAgentImports(),
          window.electronAPI.listWorkspaces().catch(() => [] as Workspace[]),
        ]);
        if (cancelled) return;
        setDetections(found);
        setWorkspaces(
          list.filter((workspace) => !workspace.isTemp && !isTempWorkspaceId(workspace.id)),
        );
      } catch (err) {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err));
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const runPreview = useCallback(
    async (next: { source: AgentImportSource; withSecrets: boolean; workspaceId: string }) => {
      setBusy(true);
      setError(null);
      setResult(null);
      try {
        const dryRun = await window.electronAPI.applyAgentImport({
          source: next.source,
          withSecrets: next.withSecrets,
          ...(next.workspaceId ? { workspaceId: next.workspaceId } : {}),
          dryRun: true,
        });
        setPreview(dryRun);
        setExcluded(new Set());
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  const choose = (next: AgentImportSource) => {
    setSource(next);
    void runPreview({ source: next, withSecrets, workspaceId: targetWorkspaceId });
  };

  const changeOptions = (change: { withSecrets?: boolean; workspaceId?: string }) => {
    const nextSecrets = change.withSecrets ?? withSecrets;
    const nextWorkspace = change.workspaceId ?? targetWorkspaceId;
    setWithSecrets(nextSecrets);
    setTargetWorkspaceId(nextWorkspace);
    if (source) void runPreview({ source, withSecrets: nextSecrets, workspaceId: nextWorkspace });
  };

  const ready = useMemo(
    () => preview?.items.filter((item) => item.status === "ready") ?? [],
    [preview],
  );
  const notReady = useMemo(
    () => preview?.items.filter((item) => item.status !== "ready") ?? [],
    [preview],
  );
  const selectedCount = ready.filter((item) => !excluded.has(item.id)).length;

  const toggle = (id: string) =>
    setExcluded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const runImport = async () => {
    if (!source) return;
    setBusy(true);
    setError(null);
    try {
      const applied = await window.electronAPI.applyAgentImport({
        source,
        withSecrets,
        ...(targetWorkspaceId ? { workspaceId: targetWorkspaceId } : {}),
        excludeItemIds: [...excluded],
      });
      setResult(applied);
      setPreview(null);
      onImported?.(applied);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };

  const found = detections?.filter((entry) => entry.found) ?? [];
  const listed = compact ? found : (detections ?? []);

  return (
    <div className={`agent-import${compact ? " agent-import--compact" : ""}`}>
      {!compact && (
        <div className="settings-section">
          <h3>Import</h3>
          <p className="settings-description">
            Bring your persona, memory, skills and settings over from Hermes Agent or OpenClaw. You
            see everything first; nothing is written until you import.
          </p>
        </div>
      )}

      {detections === null && !error && <div className="settings-loading">Looking for agents…</div>}

      {detections !== null && listed.length === 0 && (
        <p className="settings-description">
          No Hermes Agent or OpenClaw home was found on this Mac.
        </p>
      )}

      {listed.length > 0 && !result && (
        <ul className="agent-import-sources">
          {listed.map((entry) => (
            <li key={entry.source} className="agent-import-source">
              <span className="agent-import-source-name">{SOURCE_NAMES[entry.source]}</span>
              <span className="agent-import-source-home">
                {entry.found ? shortHome(entry.home) : "Not found"}
              </span>
              <button
                type="button"
                className={source === entry.source ? "button-primary" : "button-secondary"}
                disabled={!entry.found || busy}
                onClick={() => choose(entry.source)}
              >
                {source === entry.source ? "Previewing" : "Preview"}
              </button>
            </li>
          ))}
        </ul>
      )}

      {preview && source && (
        <div className="agent-import-preview">
          <div className="agent-import-options">
            <label className="agent-import-option">
              <input
                type="checkbox"
                checked={withSecrets}
                disabled={busy}
                onChange={(event) => changeOptions({ withSecrets: event.target.checked })}
              />
              <span>Include API keys and bot tokens</span>
            </label>
            <label className="agent-import-option">
              <span>Workspace</span>
              <select
                value={targetWorkspaceId}
                disabled={busy}
                onChange={(event) => changeOptions({ workspaceId: event.target.value })}
              >
                <option value="">None</option>
                {workspaces.map((workspace) => (
                  <option key={workspace.id} value={workspace.id}>
                    {workspace.name}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <p className="agent-import-hint">
            Keys are stored encrypted. Scheduled tasks and workspace instructions need a workspace;
            imported tasks start paused.
          </p>

          {ready.length > 0 ? (
            <ul className="agent-import-list agent-import-list--select">
              {ready.map((item) => (
                <ItemRow
                  key={item.id}
                  item={item}
                  checked={!excluded.has(item.id)}
                  onToggle={() => toggle(item.id)}
                />
              ))}
            </ul>
          ) : (
            <p className="settings-description">Nothing here can be imported yet.</p>
          )}

          {notReady.length > 0 && (
            <details className="agent-import-skipped">
              <summary>Not imported ({notReady.length})</summary>
              <ul className="agent-import-list">
                {notReady.map((item) => (
                  <ItemRow key={item.id} item={item} />
                ))}
              </ul>
            </details>
          )}

          <div className="update-actions">
            <button
              type="button"
              className="button-primary"
              disabled={busy || selectedCount === 0}
              onClick={() => void runImport()}
            >
              {busy
                ? "Working…"
                : `Import ${selectedCount} ${selectedCount === 1 ? "item" : "items"}`}
            </button>
            <button
              type="button"
              className="button-secondary"
              disabled={busy}
              onClick={() => {
                setPreview(null);
                setSource(null);
              }}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {result && (
        <div className="agent-import-result">
          <p className="settings-description">
            {result.imported} imported from {SOURCE_NAMES[result.source]}
            {result.failed > 0 ? `, ${result.failed} failed` : ""}.
          </p>
          <ul className="agent-import-list">
            {result.items
              .filter((item) => item.status !== "skipped" || item.reason !== "Left out.")
              .map((item) => (
                <ItemRow key={item.id} item={item} />
              ))}
          </ul>
          {!compact && (
            <div className="update-actions">
              <button
                type="button"
                className="button-secondary"
                onClick={() => {
                  setResult(null);
                  setSource(null);
                }}
              >
                Done
              </button>
            </div>
          )}
        </div>
      )}

      {error && <div className="settings-error">{error}</div>}
    </div>
  );
}

export default AgentImportPanel;
