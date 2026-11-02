import { useContext, useEffect, useMemo, useRef, useState } from "react";
import { X } from "lucide-react";
import type { Task, TaskStatus } from "../../../shared/types";
import type { TaskProposal, TaskProposalStartOptions } from "../../../shared/task-proposals";
import type { TaskProposalAction } from "../../hooks/useTaskProposals";
import { SuggestedTasksContext } from "./suggested-tasks-context";
import {
  SuggestedTaskOptionsPopover,
  type SuggestedTaskOptionsContext,
} from "./SuggestedTaskOptionsPopover";
import "./suggested-tasks.css";

const STATUS_EVENT_TYPES = new Set([
  "task_status",
  "task_started",
  "task_completed",
  "task_failed",
  "task_cancelled",
  "task_paused",
  "task_resumed",
  "task_interrupted",
  "follow_up_completed",
]);

/** Live status of the tasks started from this card, kept current from task events. */
function useStartedTaskStatuses(taskIds: string[]): Record<string, TaskStatus | undefined> {
  const [statuses, setStatuses] = useState<Record<string, TaskStatus | undefined>>({});
  const idsKey = taskIds.join(",");
  useEffect(() => {
    const ids = idsKey ? idsKey.split(",") : [];
    if (ids.length === 0 || typeof window.electronAPI?.getTask !== "function") return;
    let current = true;
    const refresh = (id: string) => {
      void window.electronAPI
        .getTask(id)
        .then((task: Task | null | undefined) => {
          if (current && task?.status) setStatuses((prev) => ({ ...prev, [id]: task.status }));
        })
        .catch(() => undefined);
    };
    ids.forEach(refresh);
    const unsubscribe =
      typeof window.electronAPI.onTaskEvent === "function"
        ? window.electronAPI.onTaskEvent((event: { taskId?: string; type?: string }) => {
            if (
              event?.taskId &&
              ids.includes(event.taskId) &&
              STATUS_EVENT_TYPES.has(String(event.type))
            ) {
              refresh(event.taskId);
            }
          })
        : undefined;
    return () => {
      current = false;
      unsubscribe?.();
    };
  }, [idsKey]);
  return statuses;
}

function describeStartedStatus(status: TaskStatus | undefined): { label: string; tone: string } {
  switch (status) {
    case "completed":
      return { label: "Done", tone: "done" };
    case "failed":
      return { label: "Failed", tone: "failed" };
    case "cancelled":
      return { label: "Stopped", tone: "muted" };
    case "paused":
    case "blocked":
      return { label: "Needs you", tone: "attention" };
    case "pending":
    case "queued":
      return { label: "Queued", tone: "muted" };
    case undefined:
      return { label: "Started", tone: "muted" };
    default:
      return { label: "Running", tone: "running" };
  }
}

/** One turn's card, fed from SuggestedTasksContext. */
export function ConnectedSuggestedTasksCard({ proposalIds }: { proposalIds: string[] }) {
  const context = useContext(SuggestedTasksContext);
  if (!context || !context.state.available) return null;
  const { state, optionsContext, onOpenTask } = context;
  const proposals = proposalIds
    .map((id) => state.proposals.get(id))
    .filter((proposal): proposal is TaskProposal => Boolean(proposal));
  return (
    <SuggestedTasksCard
      proposals={proposals}
      busy={state.busy}
      errors={state.errors}
      optionsContext={optionsContext}
      onStart={(id, options) => void state.start(id, options)}
      onStartAll={(ids) => void state.startAll(ids)}
      onDoHere={(id) => void state.doHere(id)}
      onDismiss={(id) => void state.dismiss(id)}
      onOpenTask={onOpenTask}
    />
  );
}

interface SuggestedTasksCardProps {
  proposals: TaskProposal[];
  busy: Record<string, TaskProposalAction | undefined>;
  errors: Record<string, string | undefined>;
  optionsContext: SuggestedTaskOptionsContext;
  onStart: (proposalId: string, options?: TaskProposalStartOptions) => void;
  onStartAll: (proposalIds: string[]) => void;
  onDoHere: (proposalId: string) => void;
  onDismiss: (proposalId: string) => void;
  onOpenTask?: (taskId: string) => void;
}

/**
 * The tasks the agent suggested in one turn: "N suggested tasks" with Start all, and per
 * task Options, Do it here and Start. Started tasks stay as a status row that opens them;
 * dismissed, withdrawn, expired and done-here suggestions leave the card.
 */
export function SuggestedTasksCard({
  proposals,
  busy,
  errors,
  optionsContext,
  onStart,
  onStartAll,
  onDoHere,
  onDismiss,
  onOpenTask,
}: SuggestedTasksCardProps) {
  const visible = useMemo(
    () =>
      proposals.filter(
        (proposal) => proposal.status === "pending" || proposal.status === "started",
      ),
    [proposals],
  );
  const pending = visible.filter((proposal) => proposal.status === "pending");
  const startedIds = visible
    .map((proposal) => (proposal.status === "started" ? proposal.startedTaskId : undefined))
    .filter((id): id is string => Boolean(id));
  const startedStatuses = useStartedTaskStatuses(startedIds);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [optionsOpenFor, setOptionsOpenFor] = useState<string | null>(null);
  const [optionsById, setOptionsById] = useState<Record<string, TaskProposalStartOptions>>({});
  const anyBusy = pending.some((proposal) => busy[proposal.id]);

  if (visible.length === 0) return null;

  return (
    <section className="suggested-tasks" aria-label="Suggested tasks">
      <header className="suggested-tasks-header">
        <span className="suggested-tasks-heading">
          {visible.length === 1 ? "Suggested task" : `${visible.length} suggested tasks`}
        </span>
        {pending.length >= 2 && (
          <button
            type="button"
            className="suggested-tasks-start-all"
            disabled={anyBusy}
            onClick={() => onStartAll(pending.map((proposal) => proposal.id))}
          >
            Start all
          </button>
        )}
      </header>
      <ul className="suggested-tasks-list">
        {visible.map((proposal) =>
          proposal.status === "started" ? (
            <StartedRow
              key={proposal.id}
              proposal={proposal}
              status={proposal.startedTaskId ? startedStatuses[proposal.startedTaskId] : undefined}
              onOpenTask={onOpenTask}
            />
          ) : (
            <PendingRow
              key={proposal.id}
              proposal={proposal}
              busy={busy[proposal.id]}
              error={errors[proposal.id]}
              expanded={expandedId === proposal.id}
              onToggleExpanded={() =>
                setExpandedId((current) => (current === proposal.id ? null : proposal.id))
              }
              optionsOpen={optionsOpenFor === proposal.id}
              onToggleOptions={() =>
                setOptionsOpenFor((current) => (current === proposal.id ? null : proposal.id))
              }
              onCloseOptions={() => setOptionsOpenFor(null)}
              options={optionsById[proposal.id]}
              onOptionsChange={(options) =>
                setOptionsById((prev) => ({ ...prev, [proposal.id]: options }))
              }
              optionsContext={optionsContext}
              onStart={() => {
                setOptionsOpenFor(null);
                onStart(proposal.id, optionsById[proposal.id]);
              }}
              onDoHere={() => onDoHere(proposal.id)}
              onDismiss={() => onDismiss(proposal.id)}
            />
          ),
        )}
      </ul>
    </section>
  );
}

function PendingRow({
  proposal,
  busy,
  error,
  expanded,
  onToggleExpanded,
  optionsOpen,
  onToggleOptions,
  onCloseOptions,
  options,
  onOptionsChange,
  optionsContext,
  onStart,
  onDoHere,
  onDismiss,
}: {
  proposal: TaskProposal;
  busy: TaskProposalAction | undefined;
  error: string | undefined;
  expanded: boolean;
  onToggleExpanded: () => void;
  optionsOpen: boolean;
  onToggleOptions: () => void;
  onCloseOptions: () => void;
  options: TaskProposalStartOptions | undefined;
  onOptionsChange: (options: TaskProposalStartOptions) => void;
  optionsContext: SuggestedTaskOptionsContext;
  onStart: () => void;
  onDoHere: () => void;
  onDismiss: () => void;
}) {
  const optionsButtonRef = useRef<HTMLButtonElement>(null);
  const isBusy = Boolean(busy);
  return (
    <li className="suggested-task" aria-busy={isBusy}>
      <div className="suggested-task-title-row">
        <h4 className="suggested-task-title">{proposal.title}</h4>
        <button
          type="button"
          className="suggested-task-dismiss"
          aria-label={`Dismiss suggestion: ${proposal.title}`}
          title="Dismiss"
          disabled={isBusy}
          onClick={onDismiss}
        >
          <X size={15} strokeWidth={1.75} aria-hidden="true" />
        </button>
      </div>
      <button
        type="button"
        className={`suggested-task-summary ${expanded ? "expanded" : ""}`}
        aria-expanded={expanded}
        title={expanded ? "Hide the full task" : "Show the full task"}
        onClick={onToggleExpanded}
      >
        <span className="suggested-task-summary-text">{proposal.summary}</span>
      </button>
      {expanded && (
        <div className="suggested-task-brief" role="region" aria-label="Full task">
          {proposal.brief}
        </div>
      )}
      {error && (
        <p className="suggested-task-error" role="alert">
          {error}
        </p>
      )}
      <div className="suggested-task-actions">
        <div className="suggested-task-options-anchor">
          <button
            ref={optionsButtonRef}
            type="button"
            className={`suggested-task-options-button ${optionsOpen ? "open" : ""}`}
            aria-haspopup="dialog"
            aria-expanded={optionsOpen}
            disabled={isBusy}
            onClick={onToggleOptions}
          >
            Options
          </button>
          {optionsOpen && (
            <SuggestedTaskOptionsPopover
              proposal={proposal}
              context={optionsContext}
              value={options}
              onChange={onOptionsChange}
              onClose={onCloseOptions}
              anchorRef={optionsButtonRef}
            />
          )}
        </div>
        <div className="suggested-task-primary-actions">
          <button
            type="button"
            className="suggested-task-do-here"
            disabled={isBusy}
            onClick={onDoHere}
          >
            {busy === "here" ? "Sending…" : "Do it here"}
          </button>
          <button
            type="button"
            className="suggested-task-start"
            disabled={isBusy}
            onClick={onStart}
          >
            {busy === "start" ? "Starting…" : "Start"}
          </button>
        </div>
      </div>
    </li>
  );
}

function StartedRow({
  proposal,
  status,
  onOpenTask,
}: {
  proposal: TaskProposal;
  status: TaskStatus | undefined;
  onOpenTask?: (taskId: string) => void;
}) {
  const { label, tone } = describeStartedStatus(status);
  const taskId = proposal.startedTaskId;
  return (
    <li className="suggested-task suggested-task-started">
      <span className={`suggested-task-status-dot ${tone}`} aria-hidden="true" />
      <span className="suggested-task-started-title">{proposal.title}</span>
      <span className={`suggested-task-status ${tone}`}>{label}</span>
      {taskId && onOpenTask && (
        <button type="button" className="suggested-task-open" onClick={() => onOpenTask(taskId)}>
          Open
        </button>
      )}
    </li>
  );
}
