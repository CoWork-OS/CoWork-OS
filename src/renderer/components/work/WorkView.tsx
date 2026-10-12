import { useEffect, useMemo, useState } from "react";
import { FileText, Repeat, Search } from "lucide-react";
import type { AttentionTaskContext } from "../../../shared/attention";
import type { Task, Workspace } from "../../../shared/types";
import { useAttentionSnapshot } from "../../hooks/useAttentionSnapshot";
import { formatHomeSessionTime } from "../../utils/home-sessions";
import { getFileName, resolveTaskOutputSummaryFromTask } from "../../utils/task-outputs";
import {
  DEFAULT_WORK_FILTERS,
  actorInitials,
  buildWorkModel,
  originFactLabel,
  workGroupSummary,
  type WorkFilters,
  type WorkOriginFilter,
  type WorkRow,
  type WorkStatusFilter,
} from "../../utils/work-view";
import "./work-view.css";

/** Rows shown per project before "Show all". */
const GROUP_PREVIEW_ROWS = 8;
const MAX_OUTPUTS = 6;
const LOCAL_LABEL = navigator.userAgent.includes("Mac") ? "This Mac" : "This computer";

const STATUS_TABS: Array<{ id: WorkStatusFilter; label: string }> = [
  { id: "all", label: "All" },
  { id: "needs", label: "Needs you" },
  { id: "running", label: "Running" },
  { id: "done", label: "Done" },
  { id: "failed", label: "Failed" },
];

const ORIGIN_OPTIONS: Array<{ id: WorkOriginFilter; label: string }> = [
  { id: "any", label: "Anyone" },
  { id: "you", label: "You" },
  { id: "schedule", label: "A schedule" },
  { id: "event", label: "An event" },
  { id: "agent", label: "Another agent" },
  { id: "background", label: "Background work" },
  { id: "api", label: "The API" },
];

interface WorkViewProps {
  tasks: Task[];
  onOpenTask: (taskId: string) => void;
  /** Reloads the app's task lists after sessions were archived here. */
  onTasksChanged: () => void;
  hasMoreTasks?: boolean;
  onLoadMoreTasks?: () => void;
}

function formatDateTime(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  return new Date(timestamp).toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Names the queue items use for agents and remote devices, loaded once per visit. */
function useWorkContext(): { context: AttentionTaskContext; workspaces: Workspace[] } {
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [agentNames, setAgentNames] = useState<ReadonlyMap<string, string>>(new Map());
  const [deviceNames, setDeviceNames] = useState<ReadonlyMap<string, string>>(new Map());

  useEffect(() => {
    let cancelled = false;
    const api = window.electronAPI;
    void api
      .listWorkspaces()
      .then((list) => !cancelled && setWorkspaces(Array.isArray(list) ? list : []))
      .catch(() => undefined);
    void api
      .getAgentRoles(true)
      .then(
        (roles) =>
          !cancelled &&
          setAgentNames(
            new Map(
              (Array.isArray(roles) ? roles : []).map((role) => [
                role.id,
                role.displayName || role.name,
              ]),
            ),
          ),
      )
      .catch(() => undefined);
    if (typeof api.listManagedDevices === "function") {
      void api
        .listManagedDevices()
        .then(
          (result) =>
            !cancelled &&
            setDeviceNames(
              new Map((result?.devices ?? []).map((device) => [device.id, device.name])),
            ),
        )
        .catch(() => undefined);
    }
    return () => {
      cancelled = true;
    };
  }, []);

  const context = useMemo(
    () => ({ agentNames, deviceNames, localLabel: LOCAL_LABEL }),
    [agentNames, deviceNames],
  );
  return { context, workspaces };
}

/**
 * Work: every session you or your agents started, grouped by project, with repeated runs
 * collapsed. Pick a row to see who owns it, what started it, where it runs, its next
 * decision, outputs and runs.
 */
export function WorkView({
  tasks,
  onOpenTask,
  onTasksChanged,
  hasMoreTasks,
  onLoadMoreTasks,
}: WorkViewProps) {
  const [filters, setFilters] = useState<WorkFilters>(DEFAULT_WORK_FILTERS);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [expandedGroups, setExpandedGroups] = useState<ReadonlySet<string>>(() => new Set());
  const [confirmArchive, setConfirmArchive] = useState(false);
  const [archiveError, setArchiveError] = useState<string | null>(null);
  const attention = useAttentionSnapshot(true);
  const { context, workspaces } = useWorkContext();
  const now = Date.now();

  const model = useMemo(
    () =>
      buildWorkModel({
        tasks,
        workspaces,
        attention: attention.items,
        context,
        filters,
      }),
    [tasks, workspaces, attention.items, context, filters],
  );

  const allRows = useMemo(() => model.groups.flatMap((group) => group.rows), [model]);
  const selected = allRows.find((row) => row.id === selectedId) ?? allRows[0] ?? null;

  useEffect(() => {
    setConfirmArchive(false);
    setArchiveError(null);
  }, [selected?.id]);

  const setFilter = <K extends keyof WorkFilters>(key: K, value: WorkFilters[K]) =>
    setFilters((current) => ({ ...current, [key]: value }));

  const archiveOlderRuns = async (row: WorkRow) => {
    const older = row.runs.filter((run) => run.task.id !== row.task.id);
    if (older.length === 0) return;
    setArchiveError(null);
    const results = await Promise.allSettled(
      older.map((run) => window.electronAPI.archiveTask(run.task.id)),
    );
    setConfirmArchive(false);
    if (results.some((result) => result.status === "rejected")) {
      setArchiveError("Some runs could not be archived.");
    }
    onTasksChanged();
  };

  const isFiltered =
    filters.query.trim() !== "" ||
    filters.origin !== "any" ||
    filters.actor !== "anyone" ||
    filters.status !== "all";

  return (
    <main className="main-content calm-view work-view">
      <div className="calm-view-inner work-view-inner">
        <header className="calm-view-header">
          <h1 className="calm-view-title">Work</h1>
          <p className="calm-view-subtitle">
            Everything you and your agents are doing, grouped by project.
          </p>
        </header>

        <div className="work-view-toolbar">
          <div className="work-view-tabs" role="group" aria-label="Status">
            {STATUS_TABS.map((tab) => (
              <button
                key={tab.id}
                type="button"
                className={`work-view-tab${filters.status === tab.id ? " active" : ""}`}
                aria-pressed={filters.status === tab.id}
                onClick={() => setFilter("status", tab.id)}
              >
                {tab.label}
                <span className="work-view-tab-count">{model.counts[tab.id]}</span>
              </button>
            ))}
          </div>
          <div className="work-view-filters">
            <label className="work-view-search">
              <Search size={15} aria-hidden="true" />
              <input
                type="search"
                placeholder="Search work"
                aria-label="Search work"
                value={filters.query}
                onChange={(event) => setFilter("query", event.target.value)}
              />
            </label>
            <label className="work-view-select">
              <span>Started by</span>
              <select
                value={filters.origin}
                onChange={(event) => setFilter("origin", event.target.value as WorkOriginFilter)}
              >
                {ORIGIN_OPTIONS.map((option) => (
                  <option key={option.id} value={option.id}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="work-view-select">
              <span>Owner</span>
              <select
                value={filters.actor}
                onChange={(event) => setFilter("actor", event.target.value)}
              >
                <option value="anyone">Everyone</option>
                {model.actors.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            </label>
          </div>
        </div>

        <div className="work-view-body">
          <div className="work-view-list">
            {model.groups.length === 0 && (
              <p className="work-view-empty">
                {isFiltered
                  ? "No work matches these filters."
                  : "Nothing here yet. Sessions you or your agents start show up here."}
              </p>
            )}
            {model.groups.map((group) => {
              const expanded = expandedGroups.has(group.id);
              const rows = expanded ? group.rows : group.rows.slice(0, GROUP_PREVIEW_ROWS);
              const hidden = group.rows.length - rows.length;
              return (
                <section key={group.id} className="work-view-group" aria-label={group.label}>
                  <div className="work-view-group-header">
                    <h2>{group.label}</h2>
                    <span>{workGroupSummary(group)}</span>
                  </div>
                  <ul className="work-view-rows">
                    {rows.map((row) => (
                      <li key={row.id}>
                        <button
                          type="button"
                          className={`work-view-row${selected?.id === row.id ? " selected" : ""}`}
                          aria-pressed={selected?.id === row.id}
                          onClick={() => setSelectedId(row.id)}
                        >
                          <span className={`work-view-status status-${row.status}`}>
                            {row.statusLabel}
                          </span>
                          <span className="work-view-row-title">
                            <span>{row.title}</span>
                            {row.runs.length > 1 && (
                              <span className="work-view-runs" title="Repeated runs of this work">
                                <Repeat size={11} aria-hidden="true" />
                                {row.runs.length} runs
                              </span>
                            )}
                          </span>
                          <span className="work-view-actor">
                            <span
                              className={`work-view-avatar actor-${row.actor.kind}`}
                              aria-hidden="true"
                            >
                              {actorInitials(row.actor.name)}
                            </span>
                            {row.actor.name}
                          </span>
                          {row.origin.kind !== "you" && (
                            <span className="work-view-chip">{row.origin.label}</span>
                          )}
                          {row.place.kind === "remote" && (
                            <span className="work-view-chip">{row.place.label}</span>
                          )}
                          <span className="work-view-time">
                            {formatHomeSessionTime(row.at, now)}
                          </span>
                        </button>
                      </li>
                    ))}
                  </ul>
                  {hidden > 0 && (
                    <button
                      type="button"
                      className="work-view-more"
                      onClick={() => setExpandedGroups((current) => new Set(current).add(group.id))}
                    >
                      Show all {group.rows.length}
                    </button>
                  )}
                </section>
              );
            })}
            {hasMoreTasks && onLoadMoreTasks && (
              <button type="button" className="work-view-more" onClick={onLoadMoreTasks}>
                Load older sessions
              </button>
            )}
          </div>

          {selected && (
            <WorkDetail
              row={selected}
              projectLabel={
                model.groups.find((group) => group.rows.some((row) => row.id === selected.id))
                  ?.label ?? "No project"
              }
              now={now}
              confirmArchive={confirmArchive}
              archiveError={archiveError}
              onOpenTask={onOpenTask}
              onAskArchive={() => setConfirmArchive(true)}
              onCancelArchive={() => setConfirmArchive(false)}
              onArchive={() => void archiveOlderRuns(selected)}
            />
          )}
        </div>
      </div>
    </main>
  );
}

interface WorkDetailProps {
  row: WorkRow;
  projectLabel: string;
  now: number;
  confirmArchive: boolean;
  archiveError: string | null;
  onOpenTask: (taskId: string) => void;
  onAskArchive: () => void;
  onCancelArchive: () => void;
  onArchive: () => void;
}

function WorkDetail({
  row,
  projectLabel,
  now,
  confirmArchive,
  archiveError,
  onOpenTask,
  onAskArchive,
  onCancelArchive,
  onArchive,
}: WorkDetailProps) {
  const task = row.task;
  const outputs = resolveTaskOutputSummaryFromTask(task);
  const outputPaths = outputs ? [...new Set(outputs.created)].slice(0, MAX_OUTPUTS) : [];
  const result = (task.resultSummary || task.semanticSummary || "").trim();
  const olderRuns = row.runs.length - 1;

  return (
    <aside className="work-view-detail" aria-label="Selected work">
      <div className="work-view-detail-head">
        <span className={`work-view-status status-${row.status}`}>{row.statusLabel}</span>
        <h2>{row.title}</h2>
        <span className="work-view-detail-project">{projectLabel}</span>
      </div>

      {row.decision && (
        <div className="work-view-decision">
          <span className="work-view-decision-label">Next decision</span>
          <p>{row.decision.title}</p>
          <button type="button" onClick={() => onOpenTask(task.id)}>
            Decide in the session
          </button>
        </div>
      )}

      <dl className="work-view-facts">
        <div>
          <dt>Owner</dt>
          <dd>{row.actor.name}</dd>
        </div>
        <div>
          <dt>Started by</dt>
          <dd>{originFactLabel(row.origin)}</dd>
        </div>
        <div>
          <dt>Runs on</dt>
          <dd>{row.place.label}</dd>
        </div>
        <div>
          <dt>Last activity</dt>
          <dd>{formatDateTime(row.at)}</dd>
        </div>
      </dl>

      {result && (
        <section className="work-view-section">
          <h3>Result</h3>
          <p className="work-view-result">{result}</p>
        </section>
      )}

      {outputPaths.length > 0 && (
        <section className="work-view-section">
          <h3>Outputs</h3>
          <ul className="work-view-outputs">
            {outputPaths.map((path) => (
              <li key={path} title={path}>
                <FileText size={14} aria-hidden="true" />
                {getFileName(path)}
              </li>
            ))}
          </ul>
          {outputs && outputs.outputCount > outputPaths.length && (
            <span className="work-view-note">{outputs.outputCount - outputPaths.length} more</span>
          )}
        </section>
      )}

      {row.runs.length > 1 && (
        <section className="work-view-section">
          <h3>{row.runs.length} runs</h3>
          <ul className="work-view-run-list">
            {row.runs.map((run) => (
              <li key={run.task.id}>
                <button type="button" onClick={() => onOpenTask(run.task.id)}>
                  <span className={`work-view-status status-${run.status}`}>{run.statusLabel}</span>
                  <span className="work-view-run-time">{formatHomeSessionTime(run.at, now)}</span>
                  {run.task.id === task.id && <span className="work-view-note">Shown</span>}
                </button>
              </li>
            ))}
          </ul>
        </section>
      )}

      {archiveError && (
        <p className="work-view-error" role="alert">
          {archiveError}
        </p>
      )}
      <div className="work-view-actions">
        <button type="button" className="primary" onClick={() => onOpenTask(task.id)}>
          Open session
        </button>
        {olderRuns > 0 && !confirmArchive && (
          <button type="button" onClick={onAskArchive}>
            Archive {olderRuns} older {olderRuns === 1 ? "run" : "runs"}
          </button>
        )}
        {olderRuns > 0 && confirmArchive && (
          <span className="work-view-confirm">
            <span>Keep the shown run and archive the other {olderRuns}?</span>
            <button type="button" className="danger" onClick={onArchive}>
              Archive
            </button>
            <button type="button" onClick={onCancelArchive}>
              Cancel
            </button>
          </span>
        )}
      </div>
    </aside>
  );
}
