import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  MEMORY_HUB_ADDABLE_KINDS,
  type MemoryHubAddableKind,
  type MemoryHubItem,
  type MemoryHubKind,
  type MemoryHubSource,
  type MemoryHubWhy,
} from "../../../shared/memory-hub-types";
import type {
  MemoryRepoEntriesReport,
  MemoryRepoHubEntry,
  MemoryRepoKeepTarget,
} from "../../../shared/memory-repo-types";
import { hasHostMethod } from "../../host/browser-capabilities";
import { takeMemoryHubFocus } from "./memory-hub-focus";
import "./memory-knowledge.css";
import { MemoryFolderKnowledge, type MemoryFolderKnowledgeProps } from "./MemoryFolderKnowledge";
import {
  MEMORY_FOLDER_METHODS,
  countFolderEntries,
  deleteFolderEntry,
  editFolderEntry,
  filterFolderFiles,
  keepFolderEntry,
  pinFolderEntry,
  type FolderFlowResult,
  type MemoryFolderApi,
} from "./memory-folder-model";
import {
  KIND_LABELS,
  MEMORY_KNOWLEDGE_PAGE_SIZE,
  SOURCE_LABELS,
  addKnowledgeItem,
  clearGlobalKnowledge,
  deleteKnowledgeItem,
  editKnowledgeItem,
  formatPercent,
  formatRelative,
  groupKnowledge,
  scopeLabel,
  sourceTone,
  toggleKnowledgePin,
  type MemoryKnowledgeApi,
} from "./memory-knowledge-model";

export const SOURCE_FILTERS: Array<{ value: MemoryHubSource | ""; label: string }> = [
  { value: "", label: "Any source" },
  { value: "user_stated", label: "You said" },
  { value: "user_confirmed", label: "You confirmed" },
  { value: "curated", label: "Curated" },
  { value: "inferred", label: "Inferred" },
  { value: "import", label: "Imported" },
  { value: "third_party", label: "Third-party" },
];

const KIND_FILTERS: Array<{ value: MemoryHubKind | ""; label: string }> = [
  { value: "", label: "All kinds" },
  ...(Object.keys(KIND_LABELS) as MemoryHubKind[]).map((kind) => ({
    value: kind,
    label: KIND_LABELS[kind],
  })),
];

export interface KnowledgeWhyState {
  id: string;
  loading: boolean;
  data: MemoryHubWhy | null;
  error: string | null;
}

export interface MemoryKnowledgeViewProps {
  items: MemoryHubItem[];
  total: number;
  hasMore: boolean;
  loading: boolean;
  error: string | null;
  notice: string | null;
  query: string;
  kindFilter: MemoryHubKind | "";
  sourceFilter: MemoryHubSource | "";
  pinnedOnly: boolean;
  editing: { id: string; draft: string } | null;
  why: KnowledgeWhyState | null;
  busyId: string | null;
  addDraft: { content: string; kind: MemoryHubAddableKind; scope: "global" | "workspace" };
  canWrite: boolean;
  canDelete: boolean;
  onQueryChange: (value: string) => void;
  onKindFilterChange: (value: MemoryHubKind | "") => void;
  onSourceFilterChange: (value: MemoryHubSource | "") => void;
  onPinnedOnlyChange: (value: boolean) => void;
  onAddDraftChange: (draft: MemoryKnowledgeViewProps["addDraft"]) => void;
  onAdd: () => void;
  onStartEdit: (item: MemoryHubItem) => void;
  onEditDraftChange: (value: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  onTogglePin: (item: MemoryHubItem) => void;
  onDelete: (item: MemoryHubItem) => void;
  onToggleWhy: (item: MemoryHubItem) => void;
  onClearGlobal: () => void;
  onLoadMore: () => void;
  onDismissMessage: () => void;
  /**
   * The memory folder (docs/memory-repo-phase3-design.md §5). When it is available, facts
   * come from its files and `items` only supply commitments and "From other people".
   */
  folderView?: { report: MemoryRepoEntriesReport } & Omit<
    MemoryFolderKnowledgeProps,
    "files" | "inbox"
  >;
}

function WhyPanel({ why }: { why: KnowledgeWhyState }) {
  if (why.loading) return <div className="memory-knowledge-why">Loading provenance...</div>;
  if (why.error || !why.data) {
    return (
      <div className="memory-knowledge-why" role="alert">
        {why.error || "Provenance is unavailable."}
      </div>
    );
  }
  const data = why.data;
  const details = Object.entries(data.details).filter(([key]) => key !== "editedVia");
  return (
    <div className="memory-knowledge-why" role="note" aria-label="Why CoWork knows this">
      <div className="memory-knowledge-why-summary">{data.summary}</div>
      <dl>
        <dt>Source</dt>
        <dd>
          {SOURCE_LABELS[data.source]}
          {data.store ? ` (${data.store})` : ""}
        </dd>
        {data.task && (
          <>
            <dt>Learned in task</dt>
            <dd>
              {data.task.available && data.task.title
                ? data.task.title
                : "A task outside this workspace or one that was deleted"}
            </dd>
          </>
        )}
        {details.map(([key, value]) => (
          <div key={key} className="memory-knowledge-why-detail">
            <dt>{key}</dt>
            <dd>{String(value)}</dd>
          </div>
        ))}
        <dt>Trust / confidence</dt>
        <dd>
          {formatPercent(data.trust)} / {formatPercent(data.confidence)}
        </dd>
        <dt>Seen again</dt>
        <dd>
          {data.reinforcedCount} time{data.reinforcedCount === 1 ? "" : "s"}
          {data.mergedRecords > 0 ? `, merged from ${data.mergedRecords + 1} records` : ""}
        </dd>
        <dt>Earlier versions</dt>
        <dd>{data.revisionCount}</dd>
        <dt>First learned</dt>
        <dd>{new Date(data.createdAt).toLocaleString()}</dd>
      </dl>
    </div>
  );
}

function KnowledgeItemRow({
  item,
  props,
}: {
  item: MemoryHubItem;
  props: MemoryKnowledgeViewProps;
}) {
  const editing = props.editing?.id === item.id ? props.editing : null;
  const busy = props.busyId === item.id;
  const whyOpen = props.why?.id === item.id;
  return (
    <li className="memory-knowledge-item" data-item-id={item.id}>
      {editing ? (
        <div className="memory-knowledge-edit">
          <textarea
            className="settings-input"
            aria-label="Edit memory"
            value={editing.draft}
            maxLength={1000}
            onChange={(event) => props.onEditDraftChange(event.target.value)}
            disabled={busy}
          />
          <div className="memory-knowledge-actions">
            <button
              type="button"
              className="settings-button"
              onClick={props.onSaveEdit}
              disabled={busy || !editing.draft.trim()}
            >
              {busy ? "Saving..." : "Save"}
            </button>
            <button
              type="button"
              className="memory-inline-btn"
              onClick={props.onCancelEdit}
              disabled={busy}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : (
        <div className="memory-knowledge-content">{item.content}</div>
      )}
      <div className="memory-knowledge-meta">
        <span className={`settings-badge settings-badge--${sourceTone(item.source)}`}>
          {SOURCE_LABELS[item.source]}
        </span>
        <span className="settings-badge settings-badge--outline">{scopeLabel(item)}</span>
        {item.kind !== "identity" && item.kind !== "preference" && (
          <span className="memory-knowledge-kind">{KIND_LABELS[item.kind]}</span>
        )}
        {item.private && <span className="settings-badge settings-badge--neutral">Private</span>}
        <span>{formatPercent(item.confidence)} confidence</span>
        <span>Last used {formatRelative(item.lastUsedAt)}</span>
        <span title={item.originBotId ?? undefined}>
          {item.originBotId
            ? `Bot source: ${item.originBotName ?? item.originBotId}`
            : item.private
              ? "Private context"
              : "Shared workspace context"}
        </span>
        <span>Recorded {new Date(item.createdAt).toLocaleDateString()}</span>
      </div>
      {!editing && (
        <div className="memory-knowledge-actions">
          <button
            type="button"
            className={`memory-inline-btn${item.pinned ? " active" : ""}`}
            aria-pressed={item.pinned}
            onClick={() => props.onTogglePin(item)}
            disabled={busy || !props.canWrite}
          >
            {item.pinned ? "Pinned" : "Pin"}
          </button>
          <button
            type="button"
            className="memory-inline-btn"
            onClick={() => props.onStartEdit(item)}
            disabled={busy || !props.canWrite}
          >
            Edit
          </button>
          <button
            type="button"
            className="memory-inline-btn"
            aria-expanded={whyOpen}
            onClick={() => props.onToggleWhy(item)}
          >
            Why?
          </button>
          <button
            type="button"
            className="memory-inline-btn danger"
            onClick={() => props.onDelete(item)}
            disabled={busy || !props.canDelete}
          >
            Delete
          </button>
        </div>
      )}
      {whyOpen && props.why && <WhyPanel why={props.why} />}
    </li>
  );
}

/** Presentational view of the tab; MemoryKnowledgeTab owns the state and IPC. */
export function MemoryKnowledgeView(props: MemoryKnowledgeViewProps) {
  const folder = props.folderView?.report.available ? props.folderView : null;
  const { groups: allGroups, fromOthers } = useMemo(
    () => groupKnowledge(props.items),
    [props.items],
  );
  // With the memory folder, facts are its entries; memory_items keeps the commitments.
  const groups = folder ? allGroups.filter((group) => group.id === "commitments") : allGroups;
  const filters = {
    query: props.query,
    kind: props.kindFilter,
    source: props.sourceFilter,
    pinnedOnly: props.pinnedOnly,
  };
  const folderFiles = folder ? filterFolderFiles(folder.report.files, filters) : [];
  const folderInbox = folder?.report.inbox
    ? (filterFolderFiles([folder.report.inbox], filters)[0] ?? null)
    : null;
  const folderCount =
    folderFiles.reduce((total, file) => total + file.entries.length, 0) +
    (folderInbox?.entries.length ?? 0);
  const hasGlobal =
    props.items.some((item) => item.scope === "global") ||
    (folder ? countFolderEntries(folder.report) > 0 : false);
  const filtered =
    Boolean(props.query.trim()) || Boolean(props.kindFilter) || Boolean(props.sourceFilter);

  return (
    <div className="memory-knowledge">
      <p className="settings-form-hint">
        {folder
          ? "Facts CoWork uses about you and this workspace, from your memory folder. Edits and deletes take effect on the next reply."
          : "Facts CoWork uses about you and this workspace. Edits and deletes take effect on the next reply."}
      </p>
      {props.notice && (
        <div role="status" className="memory-knowledge-notice">
          {props.notice}
        </div>
      )}
      {props.error && (
        <div role="alert" className="memory-knowledge-error">
          {props.error}
          <button type="button" className="memory-inline-btn" onClick={props.onDismissMessage}>
            Dismiss
          </button>
        </div>
      )}

      <div className="memory-knowledge-filters">
        <input
          className="settings-input"
          type="search"
          aria-label="Search memories"
          placeholder="Search what CoWork knows"
          value={props.query}
          maxLength={500}
          onChange={(event) => props.onQueryChange(event.target.value)}
        />
        <select
          className="settings-select"
          aria-label="Filter by kind"
          value={props.kindFilter}
          onChange={(event) => props.onKindFilterChange(event.target.value as MemoryHubKind | "")}
        >
          {KIND_FILTERS.map((option) => (
            <option key={option.value || "all"} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <select
          className="settings-select"
          aria-label="Filter by source"
          value={props.sourceFilter}
          onChange={(event) =>
            props.onSourceFilterChange(event.target.value as MemoryHubSource | "")
          }
        >
          {SOURCE_FILTERS.map((option) => (
            <option key={option.value || "any"} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        <label className="memory-knowledge-checkbox">
          <input
            type="checkbox"
            checked={props.pinnedOnly}
            onChange={(event) => props.onPinnedOnlyChange(event.target.checked)}
          />
          Pinned only
        </label>
      </div>

      {props.canWrite && (
        <div className="memory-knowledge-add">
          <input
            className="settings-input"
            aria-label="New memory"
            placeholder="Tell CoWork something to remember"
            value={props.addDraft.content}
            maxLength={1000}
            onChange={(event) =>
              props.onAddDraftChange({ ...props.addDraft, content: event.target.value })
            }
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                props.onAdd();
              }
            }}
          />
          <select
            className="settings-select"
            aria-label="Kind of memory"
            value={props.addDraft.kind}
            onChange={(event) =>
              props.onAddDraftChange({
                ...props.addDraft,
                kind: event.target.value as MemoryHubAddableKind,
              })
            }
          >
            {MEMORY_HUB_ADDABLE_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {KIND_LABELS[kind]}
              </option>
            ))}
          </select>
          <select
            className="settings-select"
            aria-label="Where it applies"
            value={props.addDraft.scope}
            onChange={(event) =>
              props.onAddDraftChange({
                ...props.addDraft,
                scope: event.target.value === "global" ? "global" : "workspace",
              })
            }
          >
            <option value="global">Everywhere</option>
            <option value="workspace">This workspace</option>
          </select>
          <button
            type="button"
            className="settings-button"
            onClick={props.onAdd}
            disabled={!props.addDraft.content.trim() || props.busyId === "add"}
          >
            {props.busyId === "add" ? "Adding..." : "Add"}
          </button>
        </div>
      )}

      {folder && <MemoryFolderKnowledge {...folder} files={folderFiles} inbox={folderInbox} />}

      {props.loading && props.items.length === 0 && folderCount === 0 ? (
        <div className="settings-loading">Loading memories...</div>
      ) : groups.length === 0 && fromOthers.length === 0 && folderCount === 0 ? (
        <div className="settings-empty">
          {filtered
            ? "No memories match these filters."
            : "CoWork does not know anything yet. Add a fact above, or tell CoWork in a task."}
        </div>
      ) : null}

      {groups.map((group) => (
        <section
          key={group.id}
          className="memory-knowledge-group"
          aria-label={group.title}
          data-group={group.id}
        >
          <h4>
            {group.title} <span className="memory-knowledge-count">{group.items.length}</span>
          </h4>
          <ul className="memory-knowledge-list">
            {group.items.map((item) => (
              <KnowledgeItemRow key={item.id} item={item} props={props} />
            ))}
          </ul>
        </section>
      ))}

      {fromOthers.length > 0 && (
        <details className="memory-knowledge-group memory-knowledge-others" data-group="others">
          <summary>
            From other people <span className="memory-knowledge-count">{fromOthers.length}</span>
          </summary>
          <p className="settings-form-hint">
            Text from messages others sent you. It is kept per contact and never treated as a fact
            about you.
          </p>
          <ul className="memory-knowledge-list">
            {fromOthers.map((item) => (
              <KnowledgeItemRow key={item.id} item={item} props={props} />
            ))}
          </ul>
        </details>
      )}

      <div className="memory-knowledge-footer">
        <span className="settings-form-hint">
          {folder
            ? `${folderCount} in the memory folder, ${props.items.length} of ${props.total} commitments and messages`
            : `Showing ${props.items.length} of ${props.total}`}
        </span>
        {props.hasMore && (
          <button
            type="button"
            className="memory-inline-btn"
            onClick={props.onLoadMore}
            disabled={props.loading}
          >
            {props.loading ? "Loading..." : "Load more"}
          </button>
        )}
        {props.canDelete && (
          <button
            type="button"
            className="memory-inline-btn danger"
            onClick={props.onClearGlobal}
            disabled={!hasGlobal || props.busyId === "clear-global"}
            title={hasGlobal ? undefined : "No global memories to clear."}
          >
            {props.busyId === "clear-global" ? "Clearing..." : "Clear global memories"}
          </button>
        )}
      </div>
    </div>
  );
}

function knowledgeApi(): MemoryKnowledgeApi & Partial<MemoryFolderApi> {
  return window.electronAPI;
}

export const MEMORY_KNOWLEDGE_METHODS = [
  "listMemoryItems",
  "addMemoryItem",
  "updateMemoryItem",
  "setMemoryItemPinned",
  "deleteMemoryItem",
  "getMemoryItemWhy",
  "clearGlobalMemoryItems",
] as const;

export function MemoryKnowledgeTab({
  workspaceId,
  canWrite = true,
  canDelete = true,
  api = knowledgeApi,
  confirm = (message: string) => window.confirm(message),
  initialSourceFilter = "",
  onOpenTask,
}: {
  workspaceId: string;
  canWrite?: boolean;
  canDelete?: boolean;
  /** Source filter to start with ("Show" in the Sources tab). */
  initialSourceFilter?: MemoryHubSource | "";
  api?: () => MemoryKnowledgeApi & Partial<MemoryFolderApi>;
  confirm?: (message: string) => boolean;
  /** Open the task a memory folder entry was learned in. */
  onOpenTask?: (taskId: string) => void;
}) {
  const [items, setItems] = useState<MemoryHubItem[]>([]);
  const [total, setTotal] = useState(0);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  // "Open in Memory Hub" (per-reply Memory used) starts the tab filtered to that item.
  const [query, setQuery] = useState(() => takeMemoryHubFocus(workspaceId)?.query ?? "");
  const [kindFilter, setKindFilter] = useState<MemoryHubKind | "">("");
  const [sourceFilter, setSourceFilter] = useState<MemoryHubSource | "">(initialSourceFilter);
  const [pinnedOnly, setPinnedOnly] = useState(false);
  const [editing, setEditing] = useState<{ id: string; draft: string } | null>(null);
  const [why, setWhy] = useState<KnowledgeWhyState | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [addDraft, setAddDraft] = useState<MemoryKnowledgeViewProps["addDraft"]>({
    content: "",
    kind: "preference",
    scope: "global",
  });
  const generation = useRef(0);
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const available = MEMORY_KNOWLEDGE_METHODS.every((method) => hasHostMethod(method));
  const folderAvailable = MEMORY_FOLDER_METHODS.every(
    (method) => hasHostMethod(method) && typeof api()[method] === "function",
  );
  const canOpenFile =
    hasHostMethod("openMemoryRepoFile") && typeof api().openMemoryRepoFile === "function";
  const canKeep =
    hasHostMethod("keepMemoryRepoEntry") && typeof api().keepMemoryRepoEntry === "function";
  const [folderReport, setFolderReport] = useState<MemoryRepoEntriesReport | null>(null);
  const [folderEditing, setFolderEditing] = useState<{ ref: string; draft: string } | null>(null);
  const [folderBusyRef, setFolderBusyRef] = useState<string | null>(null);
  const folderRef = useRef(folderReport);
  folderRef.current = folderReport;
  const folderApi = api as () => MemoryFolderApi;

  const loadFolder = useCallback(async () => {
    if (!workspaceId || !folderAvailable) return;
    try {
      setFolderReport(await folderApi().getMemoryRepoEntries({ workspaceId }));
    } catch (folderError) {
      setFolderReport(null);
      setError(
        folderError instanceof Error ? folderError.message : "Failed to load the memory folder.",
      );
    }
  }, [folderApi, workspaceId, folderAvailable]);

  useEffect(() => {
    setFolderEditing(null);
    if (available) void loadFolder();
  }, [loadFolder, available]);

  const applyFolder = async (
    busy: string,
    run: (report: MemoryRepoEntriesReport) => Promise<FolderFlowResult>,
  ) => {
    const report = folderRef.current;
    if (!report) return null;
    setFolderBusyRef(busy);
    try {
      const result = await run(report);
      setFolderReport(result.report);
      if (!result.cancelled) {
        setError(result.error ?? null);
        setNotice(result.error ? null : (result.notice ?? null));
      }
      return result;
    } finally {
      setFolderBusyRef(null);
    }
  };

  const load = useCallback(
    async (offset: number) => {
      if (!workspaceId) return;
      const current = ++generation.current;
      setLoading(true);
      try {
        const page = await api().listMemoryItems({
          workspaceId,
          query: query.trim() || undefined,
          kinds: kindFilter ? [kindFilter] : undefined,
          sources: sourceFilter ? [sourceFilter] : undefined,
          pinnedOnly: pinnedOnly || undefined,
          limit: MEMORY_KNOWLEDGE_PAGE_SIZE,
          offset,
        });
        if (current !== generation.current) return;
        setItems((previous) => (offset === 0 ? page.items : [...previous, ...page.items]));
        setTotal(page.total);
        setHasMore(page.hasMore);
        setError(null);
      } catch (loadError) {
        if (current !== generation.current) return;
        setError(loadError instanceof Error ? loadError.message : "Failed to load memories.");
      } finally {
        if (current === generation.current) setLoading(false);
      }
    },
    [api, workspaceId, query, kindFilter, sourceFilter, pinnedOnly],
  );

  useEffect(() => {
    setEditing(null);
    setWhy(null);
    setNotice(null);
    if (!available) return;
    const timer = setTimeout(() => void load(0), query ? 250 : 0);
    return () => clearTimeout(timer);
  }, [load, available, query]);

  const apply = async (
    busy: string,
    run: () => Promise<{ items: MemoryHubItem[]; error?: string; notice?: string }>,
  ) => {
    setBusyId(busy);
    try {
      const result = await run();
      const delta = result.items.length - itemsRef.current.length;
      setItems(result.items);
      if (delta !== 0) setTotal((value) => Math.max(0, value + delta));
      setError(result.error ?? null);
      setNotice(result.error ? null : (result.notice ?? null));
      return result;
    } finally {
      setBusyId(null);
    }
  };

  if (!available) {
    return (
      <p className="settings-form-hint">
        What CoWork knows is not connected to this browser host yet.
      </p>
    );
  }

  return (
    <MemoryKnowledgeView
      items={items}
      total={total}
      hasMore={hasMore}
      loading={loading}
      error={error}
      notice={notice}
      query={query}
      kindFilter={kindFilter}
      sourceFilter={sourceFilter}
      pinnedOnly={pinnedOnly}
      editing={editing}
      why={why}
      busyId={busyId}
      addDraft={addDraft}
      canWrite={canWrite}
      canDelete={canDelete}
      onQueryChange={setQuery}
      onKindFilterChange={setKindFilter}
      onSourceFilterChange={setSourceFilter}
      onPinnedOnlyChange={setPinnedOnly}
      onAddDraftChange={setAddDraft}
      onAdd={() =>
        void apply("add", () =>
          addKnowledgeItem(api(), workspaceId, itemsRef.current, addDraft),
        ).then((result) => {
          if (result.error) return;
          setAddDraft((draft) => ({ ...draft, content: "" }));
          // A fact added while the folder runs is a line in it.
          void loadFolder();
        })
      }
      onStartEdit={(item) => {
        setWhy(null);
        setEditing({ id: item.id, draft: item.content });
      }}
      onEditDraftChange={(draft) => setEditing((value) => (value ? { ...value, draft } : value))}
      onSaveEdit={() => {
        const target = editing;
        if (!target) return;
        void apply(target.id, () =>
          editKnowledgeItem(api(), workspaceId, itemsRef.current, target.id, target.draft),
        ).then((result) => {
          if (!result.error) setEditing(null);
        });
      }}
      onCancelEdit={() => setEditing(null)}
      onTogglePin={(item) =>
        void apply(item.id, () => toggleKnowledgePin(api(), workspaceId, itemsRef.current, item))
      }
      onDelete={(item) =>
        void apply(item.id, () =>
          deleteKnowledgeItem(api(), workspaceId, itemsRef.current, item, confirm),
        )
      }
      onToggleWhy={(item) => {
        if (why?.id === item.id) {
          setWhy(null);
          return;
        }
        setWhy({ id: item.id, loading: true, data: null, error: null });
        api()
          .getMemoryItemWhy({ workspaceId, id: item.id })
          .then((data) =>
            setWhy((value) =>
              value?.id === item.id ? { id: item.id, loading: false, data, error: null } : value,
            ),
          )
          .catch((whyError: unknown) =>
            setWhy((value) =>
              value?.id === item.id
                ? {
                    id: item.id,
                    loading: false,
                    data: null,
                    error:
                      whyError instanceof Error ? whyError.message : "Provenance is unavailable.",
                  }
                : value,
            ),
          );
      }}
      onClearGlobal={() =>
        void apply("clear-global", () =>
          clearGlobalKnowledge(api(), workspaceId, itemsRef.current, confirm),
        ).then(() => void loadFolder())
      }
      onLoadMore={() => void load(items.length)}
      onDismissMessage={() => {
        setError(null);
        setNotice(null);
      }}
      folderView={
        folderReport
          ? {
              report: folderReport,
              editing: folderEditing,
              busyRef: folderBusyRef,
              canWrite: canWrite && folderReport.writable,
              canDelete: canDelete && folderReport.writable,
              canOpenFile,
              onOpenTask,
              onStartEdit: (entry: MemoryRepoHubEntry) =>
                setFolderEditing({ ref: entry.ref, draft: entry.text }),
              onEditDraftChange: (draft: string) =>
                setFolderEditing((value) => (value ? { ...value, draft } : value)),
              onCancelEdit: () => setFolderEditing(null),
              onSaveEdit: () => {
                const target = folderEditing;
                const entry = target ? findFolderEntry(folderReport, target.ref) : null;
                if (!target || !entry) return;
                void applyFolder(entry.ref, (report) =>
                  editFolderEntry(folderApi(), workspaceId, report, entry, target.draft),
                ).then((result) => {
                  if (result && !result.error) setFolderEditing(null);
                });
              },
              onPin: (entry: MemoryRepoHubEntry) =>
                void applyFolder(entry.ref, (report) =>
                  pinFolderEntry(folderApi(), workspaceId, report, entry),
                ),
              onDelete: (entry: MemoryRepoHubEntry) =>
                void applyFolder(entry.ref, (report) =>
                  deleteFolderEntry(folderApi(), workspaceId, report, entry, confirm),
                ),
              ...(canKeep
                ? {
                    onKeep: (entry: MemoryRepoHubEntry, target: MemoryRepoKeepTarget) =>
                      void applyFolder(entry.ref, (report) =>
                        keepFolderEntry(folderApi(), workspaceId, report, entry, target),
                      ),
                  }
                : {}),
              onOpenFile: (path: string) => {
                const open = api().openMemoryRepoFile;
                if (!open) return;
                open({ workspaceId, path }).catch((openError: unknown) =>
                  setError(
                    openError instanceof Error ? openError.message : "Could not open the file.",
                  ),
                );
              },
            }
          : undefined
      }
    />
  );
}

function findFolderEntry(report: MemoryRepoEntriesReport, ref: string): MemoryRepoHubEntry | null {
  for (const file of [...report.files, ...(report.inbox ? [report.inbox] : [])]) {
    const entry = file.entries.find((candidate) => candidate.ref === ref);
    if (entry) return entry;
  }
  return null;
}
