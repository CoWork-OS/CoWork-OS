import { useCallback, useEffect, useRef, useState } from "react";
import type {
  MemoryObservationBackfillStatus,
  MemoryObservationMetadata,
  MemoryObservationPrivacyState,
  MemoryObservationSearchResult,
  MemoryObservationTimelineEntry,
} from "../../../shared/types";
import { hasHostMethod } from "../../host/browser-capabilities";
import { SettingsBadge, SettingsRow } from "./SettingsRow";

function formatTimestamp(timestamp?: number): string | null {
  if (!timestamp) return null;
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return null;
  }
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/** The observation metadata status: processed, failed and pending counts. */
export function backfillStatusLine(status: MemoryObservationBackfillStatus | null): string {
  if (!status) return "Metadata status unavailable.";
  return `${status.processed}/${status.total} processed • ${status.failed} failed • ${status.pending} pending`;
}

/**
 * Advanced → Inspector: search the structured observations of the workspace's memories,
 * inspect their provenance and timeline, and edit, hide, redact, delete or promote them.
 */
export function MemoryInspectorPanel({
  workspaceId,
  canDelete,
  onError,
  onNotice,
  onPromoted,
}: {
  workspaceId: string;
  canDelete: boolean;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
  /** A memory was promoted to workspace knowledge (the prompt preview changed). */
  onPromoted?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [privacy, setPrivacy] = useState<"all" | MemoryObservationPrivacyState>("all");
  const [results, setResults] = useState<MemoryObservationSearchResult[]>([]);
  const [timeline, setTimeline] = useState<MemoryObservationTimelineEntry[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [selected, setSelected] = useState<MemoryObservationMetadata | null>(null);
  const [editTitle, setEditTitle] = useState("");
  const [editNarrative, setEditNarrative] = useState("");
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [backfill, setBackfill] = useState<MemoryObservationBackfillStatus | null>(null);
  const alive = useRef(true);
  const searchGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const selectedIdRef = useRef("");
  selectedIdRef.current = selectedId;
  const canPromote = hasHostMethod("promoteMemoryObservation");
  const callbacks = useRef({ onError, onNotice, onPromoted });
  callbacks.current = { onError, onNotice, onPromoted };

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const fail = useCallback((error: unknown, fallback: string) => {
    if (alive.current) callbacks.current.onError(errorText(error, fallback));
  }, []);

  const refreshBackfill = useCallback(async () => {
    try {
      const status = await window.electronAPI.getMemoryObservationBackfillStatus();
      if (alive.current) setBackfill(status);
    } catch {
      // The status line says it is unavailable.
    }
  }, []);

  const loadObservation = useCallback(
    async (memoryId: string) => {
      if (!memoryId) return;
      const current = ++detailGeneration.current;
      const isCurrent = () => alive.current && current === detailGeneration.current;
      try {
        setSelectedId(memoryId);
        const [details, entries] = await Promise.all([
          window.electronAPI.getMemoryObservationDetails({ workspaceId, ids: [memoryId] }),
          window.electronAPI.getMemoryObservationTimeline({ workspaceId, memoryId, windowSize: 4 }),
        ]);
        if (!isCurrent()) return;
        setSelected(details[0] || null);
        setEditTitle(details[0]?.title || "");
        setEditNarrative(details[0]?.narrative || "");
        setTimeline(entries);
      } catch (error) {
        if (isCurrent()) fail(error, "Failed to load memory observation.");
      }
    },
    [workspaceId, fail],
  );

  const search = useCallback(
    async (searchQuery: string, privacyState: "all" | MemoryObservationPrivacyState) => {
      const current = ++searchGeneration.current;
      const isCurrent = () => alive.current && current === searchGeneration.current;
      try {
        setLoading(true);
        const found = await window.electronAPI.searchMemoryObservations({
          workspaceId,
          query: searchQuery.trim(),
          limit: 30,
          privacyStates: privacyState === "all" ? undefined : [privacyState],
        });
        if (!isCurrent()) return;
        setResults(found);
        const nextId = found.some((result) => result.memoryId === selectedIdRef.current)
          ? selectedIdRef.current
          : found[0]?.memoryId || "";
        if (nextId) {
          await loadObservation(nextId);
        } else {
          setSelected(null);
          setTimeline([]);
        }
      } catch (error) {
        if (isCurrent()) fail(error, "Failed to search memory observations.");
      } finally {
        if (isCurrent()) setLoading(false);
      }
    },
    [workspaceId, loadObservation, fail],
  );

  // Loaded once per workspace (the panel is keyed by it); later searches are explicit.
  useEffect(() => {
    void refreshBackfill();
    void search("", "all");
  }, [refreshBackfill, search]);

  const runBusy = async (action: () => Promise<void>, fallback: string) => {
    try {
      setBusy(true);
      await action();
    } catch (error) {
      fail(error, fallback);
    } finally {
      if (alive.current) setBusy(false);
    }
  };

  const reloadSelected = async (memoryId: string) => {
    await loadObservation(memoryId);
    await search(query, privacy);
  };

  const updatePrivacy = (privacyState: MemoryObservationPrivacyState) => {
    if (!selected) return;
    void runBusy(async () => {
      await window.electronAPI.updateMemoryObservation({
        workspaceId,
        memoryId: selected.memoryId,
        patch: { privacyState },
      });
      await reloadSelected(selected.memoryId);
    }, "Failed to update memory observation.");
  };

  const saveMetadata = () => {
    if (!selected) return;
    void runBusy(async () => {
      await window.electronAPI.updateMemoryObservation({
        workspaceId,
        memoryId: selected.memoryId,
        patch: {
          title: editTitle.trim() || selected.title,
          narrative: editNarrative.trim() || selected.narrative,
        },
      });
      await reloadSelected(selected.memoryId);
    }, "Failed to save memory observation metadata.");
  };

  const redact = () => {
    if (!selected) return;
    void runBusy(async () => {
      await window.electronAPI.redactMemoryObservation({
        workspaceId,
        memoryId: selected.memoryId,
      });
      await reloadSelected(selected.memoryId);
    }, "Failed to redact memory observation.");
  };

  const remove = () => {
    if (!selected) return;
    if (
      !window.confirm(
        "Hide this memory from recall? The record will be kept as suppressed metadata.",
      )
    )
      return;
    void runBusy(async () => {
      await window.electronAPI.deleteMemoryObservation({
        workspaceId,
        memoryId: selected.memoryId,
      });
      if (!alive.current) return;
      setSelectedId("");
      setSelected(null);
      setTimeline([]);
      await search(query, privacy);
    }, "Failed to delete memory observation.");
  };

  const promote = () => {
    if (!selected) return;
    void runBusy(async () => {
      const result = await window.electronAPI.promoteMemoryObservation({
        workspaceId,
        memoryId: selected.memoryId,
        target: "workspace",
        kind: "project_fact",
      });
      if (!result.success)
        throw new Error(result.error || "Memory promotion could not be applied.");
      if (!alive.current) return;
      callbacks.current.onNotice(
        result.staged
          ? "Memory promotion was staged for review."
          : "Memory promoted to workspace knowledge.",
      );
      callbacks.current.onPromoted?.();
    }, "Failed to promote memory observation.");
  };

  const rebuild = () =>
    void runBusy(async () => {
      const status = await window.electronAPI.rebuildMemoryObservationMetadata({ force: true });
      if (alive.current) setBackfill(status);
      await search(query, privacy);
    }, "Failed to rebuild memory observation metadata.");

  return (
    <div className="memory-inspector-panel">
      <SettingsRow
        label={
          <>
            Observation metadata{" "}
            <SettingsBadge tone={backfill?.running ? "warning" : "success"}>
              {backfill?.running ? "Backfilling" : "Ready"}
            </SettingsBadge>
          </>
        }
        hint={backfillStatusLine(backfill)}
      >
        <button
          type="button"
          className="settings-button"
          disabled={busy}
          onClick={() => void refreshBackfill()}
        >
          Refresh status
        </button>
        <button type="button" className="settings-button" disabled={busy} onClick={rebuild}>
          Rebuild metadata (all workspaces)
        </button>
      </SettingsRow>

      <div className="memory-inspector-shell">
        <div className="memory-inspector-search">
          <input
            className="settings-input"
            aria-label="Search observations"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void search(query, privacy);
            }}
            placeholder="Search memories, files, tools, concepts"
          />
          <select
            className="settings-select"
            aria-label="Privacy"
            value={privacy}
            onChange={(event) =>
              setPrivacy(event.target.value as "all" | MemoryObservationPrivacyState)
            }
          >
            <option value="all">All privacy</option>
            <option value="normal">Normal</option>
            <option value="private">Private</option>
            <option value="redacted">Redacted</option>
            <option value="suppressed">Suppressed</option>
          </select>
          <button
            type="button"
            className="settings-button"
            disabled={loading}
            onClick={() => void search(query, privacy)}
          >
            {loading ? "Searching..." : "Search"}
          </button>
        </div>

        <div className="memory-inspector-layout">
          <div className="memory-hub-column memory-inspector-results">
            {results.length === 0 ? (
              <div className="settings-empty">No memory observations found.</div>
            ) : (
              results.map((result) => (
                <button
                  type="button"
                  key={result.memoryId}
                  className={`settings-card memory-observation-result${
                    selectedId === result.memoryId ? " is-selected" : ""
                  }`}
                  onClick={() => void loadObservation(result.memoryId)}
                >
                  <div className="memory-hub-row memory-inspector-item-header">
                    <div className="memory-hub-primary-label memory-inspector-title">
                      {result.title}
                    </div>
                    <SettingsBadge tone={result.privacyState === "normal" ? "neutral" : "warning"}>
                      {result.privacyState}
                    </SettingsBadge>
                  </div>
                  <div className="memory-hub-caption">
                    {result.sourceLabel} • {result.observationType} •{" "}
                    {formatTimestamp(result.createdAt) || "unknown date"} •{" "}
                    {result.estimatedDetailTokens} tokens
                  </div>
                  <div className="memory-hub-text-block-primary memory-inspector-snippet">
                    {result.snippet}
                  </div>
                  {result.concepts.length > 0 && (
                    <div className="memory-hub-chip-row memory-inspector-chip-row">
                      {result.concepts.slice(0, 4).map((concept) => (
                        <SettingsBadge key={concept} tone="neutral">
                          {concept}
                        </SettingsBadge>
                      ))}
                    </div>
                  )}
                </button>
              ))
            )}
          </div>

          <div className="memory-observation-detail">
            {selected ? (
              <>
                <div className="memory-hub-row memory-inspector-item-header">
                  <div className="memory-inspector-detail-heading">
                    <div className="memory-hub-section-title memory-inspector-detail-title">
                      {selected.title}
                    </div>
                    <div className="memory-hub-caption">
                      {selected.origin} • {selected.observationType} •{" "}
                      {formatTimestamp(selected.memoryCreatedAt) || "unknown date"}
                    </div>
                  </div>
                  <SettingsBadge tone={selected.privacyState === "normal" ? "success" : "warning"}>
                    {selected.privacyState}
                  </SettingsBadge>
                </div>
                <div className="memory-hub-top-gap">
                  <input
                    className="settings-input"
                    aria-label="Observation title"
                    value={editTitle}
                    onChange={(event) => setEditTitle(event.target.value)}
                    placeholder="Observation title"
                  />
                  <textarea
                    className="settings-textarea memory-hub-top-gap memory-inspector-textarea"
                    aria-label="Observation narrative"
                    rows={4}
                    value={editNarrative}
                    onChange={(event) => setEditNarrative(event.target.value)}
                    placeholder="Observation narrative"
                  />
                  <div className="memory-hub-chip-row">
                    <button
                      type="button"
                      className="settings-button"
                      disabled={busy}
                      onClick={saveMetadata}
                    >
                      Save metadata
                    </button>
                  </div>
                </div>
                {selected.facts.length > 0 && (
                  <div className="memory-hub-top-gap">
                    <div className="memory-hub-primary-label">Facts</div>
                    <ul className="memory-hub-text-block-primary memory-inspector-facts">
                      {selected.facts.map((fact) => (
                        <li key={fact}>{fact}</li>
                      ))}
                    </ul>
                  </div>
                )}
                <div className="memory-hub-chip-row">
                  <button
                    type="button"
                    className="settings-button"
                    disabled={busy || !canPromote}
                    title={
                      !canPromote
                        ? "Memory promotion is not connected to this browser host yet."
                        : undefined
                    }
                    onClick={promote}
                  >
                    Promote
                  </button>
                  <button
                    type="button"
                    className="settings-button"
                    disabled={busy}
                    onClick={() => updatePrivacy("private")}
                  >
                    Mark private
                  </button>
                  <button
                    type="button"
                    className="settings-button"
                    disabled={busy}
                    onClick={() => updatePrivacy("suppressed")}
                  >
                    Suppress recall
                  </button>
                  <button
                    type="button"
                    className="settings-button"
                    disabled={busy}
                    onClick={redact}
                  >
                    Redact
                  </button>
                  <button
                    type="button"
                    className="settings-button settings-button-danger"
                    disabled={busy || !canDelete}
                    title={
                      !canDelete ? "This workspace does not permit memory deletion." : undefined
                    }
                    onClick={remove}
                  >
                    Delete
                  </button>
                </div>

                <div className="memory-hub-top-gap">
                  <div className="memory-hub-primary-label">Timeline</div>
                  <div className="memory-hub-column">
                    {timeline.map((entry) => (
                      <div key={entry.memoryId} className="memory-inspector-timeline-card">
                        <div className="memory-hub-row memory-inspector-item-header">
                          <span className="memory-inspector-title">{entry.title}</span>
                          {entry.isAnchor && <SettingsBadge tone="success">Anchor</SettingsBadge>}
                        </div>
                        <div className="memory-hub-caption">
                          {formatTimestamp(entry.createdAt) || "unknown date"} • {entry.sourceLabel}
                        </div>
                        <div className="memory-hub-text-block-primary memory-inspector-snippet">
                          {entry.snippet}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              </>
            ) : (
              <div className="settings-empty">Select a memory observation to inspect.</div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
