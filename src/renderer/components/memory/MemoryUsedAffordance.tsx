import { useEffect, useState, useSyncExternalStore } from "react";
import type { MemoryHubItemDetail, MemoryHubSource } from "../../../shared/memory-hub-types";
import {
  parseMemoryUsedRef,
  type MemoryUsedLane,
  type MemoryUsedReply,
} from "../../../shared/memory-used";
import { MEMORY_REPO_READ_LINES_MAX, type MemoryRepoLine } from "../../../shared/memory-repo-types";
import { SOURCE_LABELS, sourceTone, type SourceTone } from "./memory-knowledge-model";
import { requestMemoryHubFocus } from "./memory-hub-focus";
import { getMemoryUsedStore, type MemoryUsedStore } from "./memory-used-store";
import "./memory-used.css";

/** One remembered thing a reply used, resolved for display. */
export interface MemoryUsedEntry {
  ref: string;
  lane: MemoryUsedLane;
  /** The memory item id, for "Open in Memory Hub" (memory lane only). */
  itemId?: string;
  text: string;
  badge: { label: string; tone: SourceTone };
  /** The fact was deleted or is not visible from this workspace any more. */
  unavailable?: boolean;
}

export interface MemoryUsedApi {
  getMemoryItem: (data: { workspaceId: string; id: string }) => Promise<MemoryHubItemDetail>;
  getMemoryDetails?: (data: {
    workspaceId: string;
    ids: string[];
  }) => Promise<Array<{ id: string; content?: string; summary?: string }>>;
  /** Memory folder line text for `repo:` refs (`memoryRepo:readLines`). */
  readMemoryRepoLines?: (refs: string[]) => Promise<MemoryRepoLine[]>;
}

const LANE_BADGES: Record<
  Exclude<MemoryUsedLane, "memory">,
  { label: string; tone: SourceTone }
> = {
  archive: { label: "Task history", tone: "neutral" },
  repo: { label: "Memory folder", tone: "success" },
};

/** `repo:workspaces/x.md#L4` → `workspaces/x.md, line 4` (when the line text is unavailable). */
function repoRefLabel(id: string): string {
  const match = /^(.*)#L(\d+)$/.exec(id);
  return match ? `${match[1]}, line ${match[2]}` : id;
}

function snippet(text: string, max = 280): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Resolve a reply's refs to displayable entries (facts through the Memory Hub's `get`). */
export async function resolveMemoryUsedEntries(
  refs: string[],
  workspaceId: string,
  api: MemoryUsedApi,
): Promise<MemoryUsedEntry[]> {
  const parsed = refs
    .map(parseMemoryUsedRef)
    .filter((ref): ref is NonNullable<typeof ref> => ref !== null);
  const archiveIds = parsed.filter((ref) => ref.lane === "archive").map((ref) => ref.id);
  const archive = new Map<string, string>();
  if (archiveIds.length > 0 && api.getMemoryDetails) {
    try {
      for (const row of await api.getMemoryDetails({
        workspaceId,
        ids: archiveIds.slice(0, 50),
      })) {
        archive.set(row.id, String(row.summary || row.content || ""));
      }
    } catch {
      // Shown as unavailable below.
    }
  }
  const repoRefs = parsed.filter((ref) => ref.lane === "repo").map((ref) => ref.ref);
  const repoLines = new Map<string, MemoryRepoLine>();
  if (repoRefs.length > 0 && typeof api.readMemoryRepoLines === "function") {
    try {
      const rows = await api.readMemoryRepoLines(repoRefs.slice(0, MEMORY_REPO_READ_LINES_MAX));
      for (const row of Array.isArray(rows) ? rows : []) {
        if (row && typeof row.ref === "string") repoLines.set(row.ref, row);
      }
    } catch {
      // Falls back to the file and line below.
    }
  }
  return Promise.all(
    parsed.map(async (ref): Promise<MemoryUsedEntry> => {
      if (ref.lane === "memory") {
        try {
          const detail = await api.getMemoryItem({ workspaceId, id: ref.id });
          const item = detail.item;
          const source = item.source as MemoryHubSource;
          const unavailable = item.status === "deleted";
          return {
            ref: ref.ref,
            lane: "memory",
            itemId: item.id,
            text: unavailable ? "This memory was deleted." : snippet(item.content),
            badge: { label: SOURCE_LABELS[source] ?? source, tone: sourceTone(source) },
            ...(unavailable ? { unavailable } : {}),
          };
        } catch {
          return {
            ref: ref.ref,
            lane: "memory",
            text: "This memory is no longer available.",
            badge: { label: "Memory", tone: "neutral" },
            unavailable: true,
          };
        }
      }
      if (ref.lane === "archive") {
        const text = archive.get(ref.id);
        return {
          ref: ref.ref,
          lane: "archive",
          text: text ? snippet(text) : "An earlier task note that is no longer available.",
          badge: LANE_BADGES.archive,
          ...(text ? {} : { unavailable: true }),
        };
      }
      const line = repoLines.get(ref.ref);
      const text = line?.text ? snippet(line.text) : "";
      return {
        ref: ref.ref,
        lane: "repo",
        text: text
          ? `${text}${line?.by === "agent" ? " (saved by the agent)" : ""}`
          : `${repoRefLabel(ref.id)} in your memory folder.`,
        badge: LANE_BADGES.repo,
      };
    }),
  );
}

export interface MemoryUsedViewProps {
  count: number;
  expanded: boolean;
  loading: boolean;
  entries: MemoryUsedEntry[] | null;
  error: string | null;
  canOpenHub: boolean;
  onToggle: () => void;
  onOpen: (entry: MemoryUsedEntry) => void;
}

/** "Memory used (N)" and, expanded, the list of what the reply used. */
export function MemoryUsedView(props: MemoryUsedViewProps) {
  return (
    <div className="memory-used">
      <button
        type="button"
        className="memory-used-toggle"
        aria-expanded={props.expanded}
        title="Memories CoWork used for this reply"
        onClick={props.onToggle}
      >
        Memory used ({props.count})
      </button>
      {props.expanded && (
        <div className="memory-used-panel" aria-label="Memory used for this reply">
          {props.loading && <div className="memory-used-hint">Loading…</div>}
          {props.error && (
            <div className="memory-used-hint" role="alert">
              {props.error}
            </div>
          )}
          {props.entries && (
            <ul className="memory-used-list">
              {props.entries.map((entry) => (
                <li
                  key={entry.ref}
                  className={`memory-used-item${entry.unavailable ? " memory-used-item--gone" : ""}`}
                >
                  <span className={`settings-badge settings-badge--${entry.badge.tone}`}>
                    {entry.badge.label}
                  </span>
                  <span className="memory-used-text">{entry.text}</span>
                  {entry.lane === "memory" &&
                    entry.itemId &&
                    !entry.unavailable &&
                    props.canOpenHub && (
                      <button
                        type="button"
                        className="memory-used-open"
                        onClick={() => props.onOpen(entry)}
                      >
                        Open in Memory Hub
                      </button>
                    )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}

function useMemoryUsedReply(
  store: MemoryUsedStore | null,
  taskId: string | undefined,
  workspaceId: string | undefined,
  eventId: string | undefined,
): MemoryUsedReply | null {
  const snapshot = () => (store && taskId && eventId ? store.getReply(taskId, eventId) : null);
  const reply = useSyncExternalStore(
    (listener) => (store ? store.subscribe(listener) : () => undefined),
    snapshot,
    snapshot,
  );
  useEffect(() => {
    if (store && taskId && workspaceId && eventId) store.request(taskId, workspaceId, eventId);
  }, [store, taskId, workspaceId, eventId]);
  return reply;
}

export interface MemoryUsedAffordanceProps {
  taskId?: string;
  workspaceId?: string;
  /** The reply's event id. */
  eventId?: string;
  /** Opens Settings > Memory; without it the list has no "Open in Memory Hub" links. */
  onOpenMemoryHub?: () => void;
  /** Injected in tests. */
  store?: MemoryUsedStore | null;
  api?: MemoryUsedApi;
}

/**
 * The per-reply "Memory used" affordance: nothing when the reply used no memory; else a
 * small toggle that lists the facts, history notes and external context it used.
 */
export function MemoryUsedAffordance({
  taskId,
  workspaceId,
  eventId,
  onOpenMemoryHub,
  store = getMemoryUsedStore(),
  api,
}: MemoryUsedAffordanceProps) {
  const reply = useMemoryUsedReply(store, taskId, workspaceId, eventId);
  const [expanded, setExpanded] = useState(false);
  const [entries, setEntries] = useState<MemoryUsedEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refsKey = reply?.refs.join("\n") ?? "";

  useEffect(() => {
    setEntries(null);
  }, [refsKey]);

  useEffect(() => {
    if (!expanded || entries || !reply || !workspaceId) return;
    const resolvedApi = api ?? (window.electronAPI as unknown as MemoryUsedApi);
    let cancelled = false;
    setLoading(true);
    setError(null);
    resolveMemoryUsedEntries(reply.refs, workspaceId, resolvedApi)
      .then((resolved) => {
        if (!cancelled) setEntries(resolved);
      })
      .catch(() => {
        if (!cancelled) setError("Could not load the memories used.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [expanded, entries, reply, workspaceId, api]);

  if (!reply || reply.refs.length === 0) return null;
  return (
    <MemoryUsedView
      count={reply.refs.length}
      expanded={expanded}
      loading={loading}
      entries={entries}
      error={error}
      canOpenHub={Boolean(onOpenMemoryHub)}
      onToggle={() => setExpanded((value) => !value)}
      onOpen={(entry) => {
        if (!entry.itemId) return;
        requestMemoryHubFocus({ itemId: entry.itemId, query: entry.text, workspaceId });
        onOpenMemoryHub?.();
      }}
    />
  );
}
