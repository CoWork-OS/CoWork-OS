import { useCallback, useEffect, useRef, useState } from "react";
import { hasHostMethod, hasHostMethods } from "../../host/browser-capabilities";
import { SettingsBadge } from "./SettingsRow";
import "../memory-hub-settings.css";

/**
 * The Sources tab's lists of what came from outside: imported memories (from another
 * assistant, a ChatGPT export) and Chronicle screen-context observations.
 */

export interface ImportedMemoryItem {
  id: string;
  content: string;
  tokens: number;
  createdAt: number;
  type?: string;
}

export interface ChronicleObservationItem {
  id: string;
  appName: string;
  windowTitle: string;
  localTextSnippet?: string;
  capturedAt: number;
  destinationHints?: string[];
  memoryId?: string;
}

const PAGE_SIZE = 20;
const NO_DELETE = "This workspace does not permit memory deletion.";
const CHRONICLE_DELETE_UNAVAILABLE =
  "Chronicle deletion is not connected to this browser host yet.";

/** The title, preview and prompt-recall flag of an imported memory's content. */
export function parseImportTag(content: string): {
  title: string;
  preview: string;
  ignoredForPromptRecall: boolean;
  isImported: boolean;
} {
  const ignoredForPromptRecall = /^\s*\[cowork:prompt_recall=ignore\]/.test(content);
  const normalizedContent = content.replace(/^\s*\[cowork:prompt_recall=ignore\]\s*(?:\r?\n)?/, "");

  const match = normalizedContent.match(
    /^\[Imported from\s+(.+?)\s*[-—]\s*"(.+?)"\s*(?:\([^)]+\))?\]\n?([\s\S]*)/,
  );
  if (match) {
    return {
      title: `${match[1]}: ${match[2]}`,
      preview: match[3].slice(0, 200),
      ignoredForPromptRecall,
      isImported: true,
    };
  }
  const fallback = normalizedContent.match(/^\[Imported from\s+([^\]]+)\]\n?([\s\S]*)/);
  if (fallback) {
    return {
      title: `Imported from ${fallback[1]}`,
      preview: (fallback[2] || "").slice(0, 200),
      ignoredForPromptRecall,
      isImported: true,
    };
  }
  return {
    title: "Memory",
    preview: normalizedContent.slice(0, 200),
    ignoredForPromptRecall,
    isImported: false,
  };
}

function errorText(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

export interface ImportedMemoriesViewProps {
  stats: { count: number; totalTokens: number } | null;
  expanded: boolean;
  items: ImportedMemoryItem[];
  hasMore: boolean;
  loading: boolean;
  canDelete: boolean;
  /** The entry being deleted or updated. */
  busyId: string | null;
  updatingId: string | null;
  deletingAll: boolean;
  onToggleExpanded: () => void;
  onToggleIgnored: (item: ImportedMemoryItem, ignored: boolean) => void;
  onDelete: (item: ImportedMemoryItem) => void;
  onLoadMore: () => void;
  onDeleteAll: () => void;
}

/** "Imported memories": counts, then the list with its actions once opened. */
export function ImportedMemoriesView(props: ImportedMemoriesViewProps) {
  const count = props.stats?.count ?? 0;
  return (
    <section className="memory-knowledge-group" data-group="imported-memories">
      <div className="memory-sources-list-head">
        <h4>
          Imported memories <span className="memory-knowledge-count">{count.toLocaleString()}</span>
        </h4>
        {count > 0 && (
          <button
            type="button"
            className="settings-button small"
            aria-expanded={props.expanded}
            onClick={props.onToggleExpanded}
          >
            {props.expanded ? "Hide" : "View"}
          </button>
        )}
      </div>
      <p className="settings-form-hint">
        {count > 0
          ? `From other assistants and ChatGPT exports: ${count.toLocaleString()} conversations, ${(props.stats?.totalTokens ?? 0).toLocaleString()} tokens.`
          : "Nothing imported yet. Import from Settings → Import."}
      </p>
      {props.expanded && (
        <>
          <ul className="memory-sources-list">
            {props.items.map((item) => {
              const { title, preview, ignoredForPromptRecall } = parseImportTag(item.content);
              const busy = props.busyId === item.id || props.updatingId === item.id;
              return (
                <li key={item.id} className="memory-sources-item" data-item-id={item.id}>
                  <div className="memory-sources-item-text">
                    <div className="memory-sources-item-title">
                      {title}{" "}
                      {ignoredForPromptRecall && (
                        <SettingsBadge tone="warning">ignored in prompts</SettingsBadge>
                      )}
                    </div>
                    <div className="memory-sources-item-preview">{preview}</div>
                    <div className="memory-sources-item-meta">
                      {new Date(item.createdAt).toLocaleDateString()} · {item.tokens} tokens
                    </div>
                  </div>
                  <div className="memory-sources-item-actions">
                    <button
                      type="button"
                      className="settings-button small"
                      disabled={busy}
                      onClick={() => props.onToggleIgnored(item, ignoredForPromptRecall)}
                    >
                      {props.updatingId === item.id
                        ? "Saving..."
                        : ignoredForPromptRecall
                          ? "Use in prompts"
                          : "Ignore in prompts"}
                    </button>
                    <button
                      type="button"
                      className="settings-button small settings-button-danger"
                      disabled={busy || !props.canDelete}
                      title={!props.canDelete ? NO_DELETE : undefined}
                      onClick={() => props.onDelete(item)}
                    >
                      {props.busyId === item.id ? "Deleting..." : "Delete"}
                    </button>
                  </div>
                </li>
              );
            })}
            {props.items.length === 0 && !props.loading && (
              <li className="settings-empty">No imported memories found.</li>
            )}
            {props.loading && <li className="settings-empty">Loading...</li>}
          </ul>
          <div className="memory-sources-list-actions">
            {props.hasMore && !props.loading && (
              <button type="button" className="settings-button small" onClick={props.onLoadMore}>
                Load more
              </button>
            )}
            <button
              type="button"
              className="settings-button small settings-button-danger"
              disabled={props.deletingAll || !props.canDelete}
              title={!props.canDelete ? NO_DELETE : undefined}
              onClick={props.onDeleteAll}
            >
              {props.deletingAll ? "Deleting..." : "Delete all imported memories"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

/** Imported memories of one workspace (view, ignore in prompts, delete). */
export function ImportedMemoriesList({
  workspaceId,
  canDelete,
  onError,
}: {
  workspaceId: string;
  canDelete: boolean;
  onError: (message: string) => void;
}) {
  const [stats, setStats] = useState<{ count: number; totalTokens: number } | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [items, setItems] = useState<ImportedMemoryItem[]>([]);
  const [offset, setOffset] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [updatingId, setUpdatingId] = useState<string | null>(null);
  const [deletingAll, setDeletingAll] = useState(false);
  const alive = useRef(true);
  const pageGeneration = useRef(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const report = (error: unknown) => {
    if (alive.current) onError(errorText(error, "The imported memory action failed."));
  };

  const loadStats = useCallback(async () => {
    try {
      const next = await window.electronAPI.getImportedMemoryStats(workspaceId);
      if (alive.current) setStats(next);
    } catch (error) {
      if (alive.current) onError(errorText(error, "Failed to load imported memories."));
    }
  }, [workspaceId, onError]);

  useEffect(() => {
    void loadStats();
  }, [loadStats]);

  const loadPage = async (from: number) => {
    const current = ++pageGeneration.current;
    try {
      setLoading(true);
      const page = await window.electronAPI.findImportedMemories({
        workspaceId,
        limit: PAGE_SIZE,
        offset: from,
      });
      if (!alive.current || current !== pageGeneration.current) return;
      setItems((prev) => (from === 0 ? page : [...prev, ...page]));
      setOffset(from + page.length);
      setHasMore(page.length === PAGE_SIZE);
    } catch (error) {
      report(error);
    } finally {
      if (alive.current && current === pageGeneration.current) setLoading(false);
    }
  };

  const toggleIgnored = async (item: ImportedMemoryItem, currentlyIgnored: boolean) => {
    try {
      setUpdatingId(item.id);
      const result = await window.electronAPI.setImportedMemoryPromptRecallIgnored({
        workspaceId,
        memoryId: item.id,
        ignored: !currentlyIgnored,
      });
      if (!alive.current) return;
      const memory = result?.memory;
      if (memory) {
        setItems((prev) =>
          prev.map((entry) =>
            entry.id === item.id
              ? {
                  ...entry,
                  content: memory.content ?? entry.content,
                  tokens: memory.tokens ?? entry.tokens,
                  createdAt: memory.createdAt ?? entry.createdAt,
                  type: memory.type ?? entry.type,
                }
              : entry,
          ),
        );
      } else {
        await loadPage(0);
      }
      await loadStats();
    } catch (error) {
      report(error);
    } finally {
      if (alive.current) setUpdatingId(null);
    }
  };

  const deleteItem = async (item: ImportedMemoryItem) => {
    if (!window.confirm("Delete this imported memory entry? This cannot be undone.")) return;
    try {
      setBusyId(item.id);
      await window.electronAPI.deleteImportedMemoryEntry({ workspaceId, memoryId: item.id });
      await loadPage(0);
      await loadStats();
    } catch (error) {
      report(error);
    } finally {
      if (alive.current) setBusyId(null);
    }
  };

  const deleteAll = async () => {
    if (
      !window.confirm(
        "Are you sure you want to delete all imported memories? Native memories will not be affected. This cannot be undone.",
      )
    )
      return;
    try {
      setDeletingAll(true);
      await window.electronAPI.deleteImportedMemories(workspaceId);
      if (!alive.current) return;
      setItems([]);
      setOffset(0);
      setHasMore(false);
      setExpanded(false);
      await loadStats();
    } catch (error) {
      report(error);
    } finally {
      if (alive.current) setDeletingAll(false);
    }
  };

  return (
    <ImportedMemoriesView
      stats={stats}
      expanded={expanded}
      items={items}
      hasMore={hasMore}
      loading={loading}
      canDelete={canDelete}
      busyId={busyId}
      updatingId={updatingId}
      deletingAll={deletingAll}
      onToggleExpanded={() => {
        if (!expanded) void loadPage(0);
        setExpanded(!expanded);
      }}
      onToggleIgnored={(item, ignored) => void toggleIgnored(item, ignored)}
      onDelete={(item) => void deleteItem(item)}
      onLoadMore={() => void loadPage(offset)}
      onDeleteAll={() => void deleteAll()}
    />
  );
}

export interface ChronicleObservationsViewProps {
  items: ChronicleObservationItem[];
  loaded: boolean;
  canDelete: boolean;
  clearing: boolean;
  deletingId: string | null;
  onClear: () => void;
  onDelete: (item: ChronicleObservationItem) => void;
}

/** "Chronicle observations": screen context that tasks used, with Delete and Clear. */
export function ChronicleObservationsView(props: ChronicleObservationsViewProps) {
  return (
    <section className="memory-knowledge-group" data-group="chronicle-observations">
      <div className="memory-sources-list-head">
        <h4>
          Chronicle observations{" "}
          <span className="memory-knowledge-count">{props.items.length}</span>
        </h4>
        <button
          type="button"
          className="settings-button small settings-button-danger"
          disabled={props.clearing || props.items.length === 0 || !props.canDelete}
          title={!props.canDelete ? CHRONICLE_DELETE_UNAVAILABLE : undefined}
          onClick={props.onClear}
        >
          {props.clearing ? "Clearing..." : "Clear all"}
        </button>
      </div>
      <p className="settings-form-hint">
        Screen context from Chronicle that tasks actually used. Chronicle itself is set up in
        Settings → Tools.
      </p>
      <ul className="memory-sources-list">
        {props.items.map((item) => (
          <li key={item.id} className="memory-sources-item" data-item-id={item.id}>
            <div className="memory-sources-item-text">
              <div className="memory-sources-item-title">
                {item.windowTitle || item.appName || "Screen context"}
              </div>
              <div className="memory-sources-item-preview">
                {[item.appName, item.localTextSnippet].filter(Boolean).join(" • ").slice(0, 220) ||
                  "No OCR text cached yet."}
              </div>
              <div className="memory-sources-item-meta">
                {new Date(item.capturedAt).toLocaleString()}
                {item.destinationHints?.length ? ` • ${item.destinationHints.join(", ")}` : ""}
                {item.memoryId ? " • memory linked" : ""}
              </div>
            </div>
            <div className="memory-sources-item-actions">
              <button
                type="button"
                className="settings-button small settings-button-danger"
                disabled={props.deletingId === item.id || !props.canDelete}
                title={!props.canDelete ? CHRONICLE_DELETE_UNAVAILABLE : undefined}
                onClick={() => props.onDelete(item)}
              >
                {props.deletingId === item.id ? "Deleting..." : "Delete"}
              </button>
            </div>
          </li>
        ))}
        {props.items.length === 0 && (
          <li className="settings-empty">
            {props.loaded ? "No Chronicle observations stored yet." : "Loading..."}
          </li>
        )}
      </ul>
    </section>
  );
}

/** Chronicle observations of one workspace. */
export function ChronicleObservationsList({
  workspaceId,
  onError,
}: {
  workspaceId: string;
  onError: (message: string) => void;
}) {
  const [items, setItems] = useState<ChronicleObservationItem[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [clearing, setClearing] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const alive = useRef(true);
  const canDelete = hasHostMethods("deleteChronicleObservation", "clearChronicleObservations");

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const load = useCallback(async () => {
    try {
      const next = await window.electronAPI.listChronicleObservations({ workspaceId, limit: 50 });
      if (!alive.current) return;
      setItems(Array.isArray(next) ? next : []);
      setLoaded(true);
    } catch (error) {
      if (alive.current) onError(errorText(error, "Failed to load Chronicle observations."));
    }
  }, [workspaceId, onError]);

  useEffect(() => {
    void load();
  }, [load]);

  const remove = async (item: ChronicleObservationItem) => {
    try {
      setDeletingId(item.id);
      await window.electronAPI.deleteChronicleObservation({ workspaceId, observationId: item.id });
      await load();
    } catch (error) {
      if (alive.current) onError(errorText(error, "Failed to delete the observation."));
    } finally {
      if (alive.current) setDeletingId(null);
    }
  };

  const clear = async () => {
    if (!window.confirm("Delete all Chronicle observations of this workspace?")) return;
    try {
      setClearing(true);
      await window.electronAPI.clearChronicleObservations({ workspaceId });
      await load();
    } catch (error) {
      if (alive.current) onError(errorText(error, "Failed to clear Chronicle observations."));
    } finally {
      if (alive.current) setClearing(false);
    }
  };

  return (
    <ChronicleObservationsView
      items={items}
      loaded={loaded}
      canDelete={canDelete}
      clearing={clearing}
      deletingId={deletingId}
      onClear={() => void clear()}
      onDelete={(item) => void remove(item)}
    />
  );
}

/** The two lists, each shown where the host has its methods. */
export function MemorySourcesLists({
  workspaceId,
  canDelete,
}: {
  workspaceId: string;
  canDelete: boolean;
}) {
  const [error, setError] = useState<string | null>(null);
  const showImported = hasHostMethods("getImportedMemoryStats", "findImportedMemories");
  const showChronicle = hasHostMethod("listChronicleObservations");
  if (!showImported && !showChronicle) return null;
  return (
    <div className="memory-knowledge memory-sources-lists">
      {error && (
        <div role="alert" className="memory-knowledge-error">
          {error}
        </div>
      )}
      {showImported && (
        <ImportedMemoriesList workspaceId={workspaceId} canDelete={canDelete} onError={setError} />
      )}
      {showChronicle && <ChronicleObservationsList workspaceId={workspaceId} onError={setError} />}
    </div>
  );
}
