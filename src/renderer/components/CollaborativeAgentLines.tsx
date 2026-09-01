/**
 * CollaborativeAgentLines
 *
 * Compact agent status lines shown above the message input when a collaborative
 * run is active. Each line shows agent name, latest status, and an Open button.
 * Matches the UX of "agents as lines over the input" with latest updates per agent.
 */

import { useEffect, useState } from "react";
import type { Task, AgentTeamRun, AgentThought, TaskEvent } from "../../shared/types";
import { isSynthesisChildTask } from "../../shared/synthesis-agent-detection";
import { getEmojiIcon } from "../utils/emoji-icon-map";
import { stripLeadingEmoji } from "../utils/emoji-replacer";
import { getEffectiveTaskEventType } from "../utils/task-event-compat";
import { sanitizeToolCallTextFromAssistant } from "../../shared/tool-call-text-sanitizer";

interface CollaborativeAgentLinesProps {
  collaborativeRun: AgentTeamRun;
  childTasks: Task[];
  childEvents?: TaskEvent[];
  onOpenAgent: (taskId: string) => void;
  onWrapUp?: () => void;
  isWrappingUp?: boolean;
  /** When true, main task is done — hide Wrap Up */
  mainTaskCompleted?: boolean;
}

interface AgentLine {
  id: string;
  title: string;
  status: string;
  statusKind: AgentLineStatusKind;
  statusLabel: string;
  isStreaming: boolean;
  taskId: string | null; // null when not yet spawned
  icon?: string;
  task?: Task | null;
}

type AgentLineStatusKind = "completed" | "failed" | "warning" | "running" | "pending";

const STEP_EVENT_TYPES = new Set([
  "step_started",
  "step_completed",
  "step_failed",
  "progress_update",
]);

const FAILURE_EVENT_TYPES = new Set([
  "step_failed",
  "timeline_error",
  "agent_failed",
  "workflow_phase_failed",
  "orchestration_node_failed",
]);

const STAGE_NAMES = new Set(["DISCOVER", "BUILD", "VERIFY", "FIX", "DELIVER"]);

/** Exclude tool-batch summary events; prefer granular tool steps (grep done, Running glob, etc.) */
function isToolBatchSummaryEvent(event: TaskEvent): boolean {
  if (event.type === "timeline_group_finished") return true;
  const p = (event.payload || {}) as Record<string, unknown>;
  const msg = String(p?.message || "").trim();
  return /^Tool batch:\s*\d+\s+succeeded/i.test(msg);
}

function isStageBoundaryEvent(event: TaskEvent): boolean {
  if (event.type !== "timeline_group_started" && event.type !== "timeline_group_finished") {
    return false;
  }
  const p = (event.payload || {}) as Record<string, unknown>;
  const stage = String(p?.stage || "").toUpperCase();
  if (!STAGE_NAMES.has(stage)) return false;
  const groupId = String(event.groupId || p?.groupId || "").toLowerCase();
  const message = String(p?.message || p?.groupLabel || "")
    .trim()
    .toUpperCase();
  return (
    groupId === `stage:${stage.toLowerCase()}` ||
    message === `STARTING ${stage}` ||
    message === stage
  );
}

/** Format tool/step labels for compact display (e.g. "grep done", "web search started") */
function formatStepLabel(type: string, desc: string): string {
  const d = desc.trim();
  if (!d) return type === "step_failed" ? "Step failed" : "Working on your request";
  const running = /^Running\s+(.+)$/i.exec(d);
  const completed = /^(.+?)\s+completed$/i.exec(d);
  const failed = /^(.+?)\s+finished with issues$/i.exec(d);
  const humanize = (s: string) => s.trim().replace(/_/g, " ");
  if (running) return `${humanize(running[1])} started`;
  if (completed) return `${humanize(completed[1])} done`;
  if (failed) return `${humanize(failed[1])} failed`;
  if (type === "step_completed" && /^[a-z0-9_]+$/i.test(d)) return `${humanize(d)} done`;
  if (type === "step_started" && /^[a-z0-9_]+$/i.test(d)) return `${humanize(d)} started`;
  return humanize(d);
}

function getStepLabelFromEvent(event: TaskEvent): string {
  const type = getEffectiveTaskEventType(event);
  const p = (event.payload || {}) as Record<string, unknown>;
  const step = p?.step as Record<string, unknown> | undefined;
  const sanitize = (v: unknown) => sanitizeToolCallTextFromAssistant(String(v || "")).text;
  const desc = sanitize(step?.description || p?.description || p?.message || "").trim();
  switch (type) {
    case "step_started":
      return formatStepLabel(type, desc) || "Working on your request";
    case "step_completed":
      return formatStepLabel(type, desc) || "Step completed";
    case "step_failed": {
      if (!desc) return "Step failed";
      const label = formatStepLabel(type, desc);
      return /\b(failed|error|issues|stopped)\b/i.test(label) ? label : `Failed: ${label}`;
    }
    case "timeline_error":
    case "agent_failed":
    case "workflow_phase_failed":
    case "orchestration_node_failed":
      return desc ? `Failed: ${desc}` : "Failed";
    case "progress_update":
      return desc || "Working on your request";
    default:
      return "";
  }
}

function getFailureLabel(taskId: string, childEvents: TaskEvent[]): string | null {
  const failure = childEvents
    .filter((e) => e.taskId === taskId && FAILURE_EVENT_TYPES.has(getEffectiveTaskEventType(e)))
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0];
  if (!failure) return null;
  return getStepLabelFromEvent(failure) || "Failed";
}

function getTerminalTaskLabel(taskId: string, childEvents: TaskEvent[], task: Task): string | null {
  switch (task.terminalStatus) {
    case "partial_success":
      return "Completed with warnings";
    case "needs_user_action":
      return "Needs user action";
    case "awaiting_approval":
      return "Awaiting approval";
    case "awaiting_verification":
      return "Verifying before completion";
    case "resume_available":
      return "Paused";
    case "failed":
      return getFailureLabel(taskId, childEvents) || task.error || "Failed";
    default:
      break;
  }

  switch (task.status) {
    case "completed":
      return "Completed";
    case "failed":
      return getFailureLabel(taskId, childEvents) || task.error || "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return null;
  }
}

function getLatestStepLabel(
  taskId: string,
  childEvents: TaskEvent[],
  task: Task | null,
  isStreaming: boolean,
): string {
  if (isStreaming) return "Working on your request";
  if (!task) return "Awaiting instruction";
  const terminalLabel = getTerminalTaskLabel(taskId, childEvents, task);
  if (terminalLabel) return terminalLabel;
  const taskEvents = childEvents
    .filter(
      (e) =>
        e.taskId === taskId &&
        STEP_EVENT_TYPES.has(getEffectiveTaskEventType(e)) &&
        !isToolBatchSummaryEvent(e) &&
        !isStageBoundaryEvent(e),
    )
    .sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
  const latest = taskEvents[0];
  if (latest) {
    const label = getStepLabelFromEvent(latest);
    if (label) return label;
  }
  switch (task.status) {
    case "executing":
    case "planning":
      return "Working on your request";
    case "completed":
      return "Completed";
    case "failed":
    case "cancelled":
      return "Stopped";
    default:
      return "Awaiting instruction";
  }
}

function getAgentLineStatusKind(
  task: Task | null,
  status: string,
  isStreaming: boolean,
): AgentLineStatusKind {
  if (
    task?.terminalStatus === "failed" ||
    task?.status === "failed" ||
    task?.status === "cancelled"
  )
    return "failed";
  if (
    task?.terminalStatus === "partial_success" ||
    task?.terminalStatus === "needs_user_action" ||
    task?.terminalStatus === "awaiting_approval" ||
    task?.terminalStatus === "awaiting_verification" ||
    task?.terminalStatus === "resume_available"
  )
    return "warning";
  if (task?.status === "completed") return "completed";
  if (status.startsWith("Step failed") || status.startsWith("Failed")) return "failed";
  if (isStreaming || task?.status === "executing" || task?.status === "planning") return "running";
  return "pending";
}

function getAgentLineStatusLabel(kind: AgentLineStatusKind, task: Task | null): string {
  if (kind === "completed") return "Done";
  if (kind === "failed") return task?.status === "cancelled" ? "Cancelled" : "Failed";
  if (kind === "warning") return "Needs review";
  if (kind === "running") return "Running";
  return "Pending";
}

function getSummaryPart(count: number, label: string): string | null {
  return count > 0 ? `${count} ${label}` : null;
}

function formatAgentSummary(counts: Record<AgentLineStatusKind, number>): string {
  return [
    getSummaryPart(counts.completed, "done"),
    getSummaryPart(counts.failed, "failed"),
    getSummaryPart(counts.warning, "warning"),
    getSummaryPart(counts.running, "running"),
    getSummaryPart(counts.pending, "pending"),
  ]
    .filter(Boolean)
    .join(" · ");
}

export function CollaborativeAgentLines({
  collaborativeRun,
  childTasks,
  childEvents = [],
  onOpenAgent,
  onWrapUp,
  isWrappingUp,
  mainTaskCompleted = false,
}: CollaborativeAgentLinesProps) {
  const [streamingByAgent, setStreamingByAgent] = useState<Map<string, AgentThought>>(new Map());
  const isMultiLlm = collaborativeRun.multiLlmMode === true;

  // Subscribe to streaming thoughts for "is thinking" indicator (maps agentRoleId -> thought)
  // Team items link child tasks to agent roles; we match via listTeamItems when needed
  const [teamItems, setTeamItems] = useState<
    Array<{
      id: string;
      title: string;
      sourceTaskId?: string;
      ownerAgentRoleId?: string;
      sortOrder?: number;
      icon?: string;
    }>
  >([]);
  const [agentRoles, setAgentRoles] = useState<Map<string, { icon?: string }>>(new Map());
  useEffect(() => {
    window.electronAPI
      .listTeamItems(collaborativeRun.id)
      .then((items: Any[]) => setTeamItems(items))
      .catch(() => {});
  }, [collaborativeRun.id]);

  // Subscribe to team item events so sourceTaskId is updated as soon as tasks are spawned.
  // Without this, teamItems holds stale null sourceTaskIds, defeating the deduplication
  // check at render time and causing "ghost" agent lines alongside the real child task lines.
  useEffect(() => {
    const unsub = window.electronAPI.onTeamRunEvent(
      (event: { runId?: string; type?: string; item?: Any }) => {
        if (event.runId !== collaborativeRun.id) return;
        if (
          (event.type === "team_item_spawned" || event.type === "team_item_updated") &&
          event.item
        ) {
          setTeamItems((prev) => {
            const idx = prev.findIndex((i) => i.id === event.item!.id);
            if (idx === -1) return [...prev, event.item!];
            const next = [...prev];
            next[idx] = event.item!;
            return next;
          });
        }
      },
    );
    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, [collaborativeRun.id]);
  useEffect(() => {
    window.electronAPI
      .getAgentRoles(false)
      .then((roles: Array<{ id: string; icon?: string }>) => {
        const map = new Map<string, { icon?: string }>();
        for (const r of roles) map.set(r.id, { icon: r.icon });
        setAgentRoles(map);
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    const unsub = window.electronAPI.onTeamThoughtEvent((event: Any) => {
      if (event.runId !== collaborativeRun.id) return;
      if (event.type === "team_thought_streaming" && event.thought) {
        const t = event.thought as AgentThought;
        setStreamingByAgent((prev) => {
          const next = new Map(prev);
          next.set(t.agentRoleId, t);
          return next;
        });
      } else if (
        (event.type === "team_thought_added" || event.type === "team_thought_updated") &&
        event.thought
      ) {
        const t = event.thought as AgentThought;
        setStreamingByAgent((prev) => {
          if (!prev.has(t.agentRoleId)) return prev;
          const next = new Map(prev);
          next.delete(t.agentRoleId);
          return next;
        });
      }
    });
    return () => {
      if (typeof unsub === "function") unsub();
    };
  }, [collaborativeRun.id]);

  // Map taskId -> agentRoleId for streaming check
  const taskToRole = new Map<string, string>();
  for (const item of teamItems) {
    if (item.sourceTaskId && item.ownerAgentRoleId) {
      taskToRole.set(item.sourceTaskId, item.ownerAgentRoleId);
    }
  }

  // Build agent lines: prefer child tasks, fall back to team items (before spawn)
  const childByTaskId = new Map(childTasks.map((t) => [t.id, t]));
  const agentLines: AgentLine[] = [];

  // From child tasks (spawned agents)
  for (const t of childTasks.slice().sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))) {
    const roleId = t.assignedAgentRoleId ?? taskToRole.get(t.id);
    const isStreaming = !!roleId && streamingByAgent.has(roleId);
    const role = roleId ? agentRoles.get(roleId) : undefined;
    const status = getLatestStepLabel(t.id, childEvents, t, isStreaming);
    const statusKind = getAgentLineStatusKind(t, status, isStreaming);
    agentLines.push({
      id: t.id,
      title: t.title,
      status,
      statusKind,
      statusLabel: getAgentLineStatusLabel(statusKind, t),
      isStreaming,
      taskId: t.id,
      icon: role?.icon,
      task: t,
    });
  }

  // From team items not yet spawned (show as "awaiting instruction")
  for (const item of teamItems) {
    if (item.sourceTaskId && childByTaskId.has(item.sourceTaskId)) continue;
    const roleId = item.ownerAgentRoleId;
    const isStreaming = !!roleId && streamingByAgent.has(roleId);
    const role = roleId ? agentRoles.get(roleId) : undefined;
    const status = getLatestStepLabel("", childEvents, null, isStreaming);
    const statusKind = getAgentLineStatusKind(null, status, isStreaming);
    agentLines.push({
      id: item.id,
      title: item.title,
      status,
      statusKind,
      statusLabel: getAgentLineStatusLabel(statusKind, null),
      isStreaming,
      taskId: item.sourceTaskId || null,
      icon: role?.icon ?? item.icon,
      task: null,
    });
  }

  // Sort: spawned first (by createdAt), then unspawned (by sortOrder)
  agentLines.sort((a, b) => {
    const taskA = a.taskId ? childByTaskId.get(a.taskId) : null;
    const taskB = b.taskId ? childByTaskId.get(b.taskId) : null;
    if (taskA && taskB) return (taskA.createdAt ?? 0) - (taskB.createdAt ?? 0);
    if (taskA) return -1;
    if (taskB) return 1;
    return 0;
  });

  if (agentLines.length === 0) return null;

  const statusCounts = agentLines.reduce<Record<AgentLineStatusKind, number>>(
    (acc, line) => {
      acc[line.statusKind] += 1;
      return acc;
    },
    { completed: 0, failed: 0, warning: 0, running: 0, pending: 0 },
  );

  return (
    <div className="collaborative-agent-lines">
      <div className="collab-lines-header">
        <span className="collab-lines-title">
          {agentLines.length} {isMultiLlm ? "models" : "background agents"}
        </span>
        <span className="collab-lines-summary">{formatAgentSummary(statusCounts)}</span>
        <span className="collab-lines-hint">@ to tag agents</span>
      </div>
      <div className="collab-lines-list">
        {agentLines.map(({ id, title, status, statusKind, statusLabel, taskId, icon }) => (
          <div key={id} className={`collab-agent-line collab-agent-line-${statusKind}`}>
            <span className="collab-agent-status-text">
              <span className="collab-agent-icon">
                {(() => {
                  const Icon = getEmojiIcon(icon || "🤖");
                  return <Icon size={14} strokeWidth={1.5} />;
                })()}
              </span>
              <span className="collab-agent-name">{stripLeadingEmoji(title)}</span>
            </span>
            <span
              className={`collab-agent-state collab-agent-state-${statusKind}`}
              title={status}
              aria-label={status}
            >
              {statusLabel}
            </span>
            {taskId ? (
              (() => {
                const t = childByTaskId.get(taskId);
                return t && isSynthesisChildTask(t);
              })() ? (
                <span
                  className="collab-agent-open-empty"
                  title="Synthesis output is shown in main view"
                />
              ) : (
                <button
                  type="button"
                  className="collab-agent-open-btn"
                  onClick={() => onOpenAgent(taskId)}
                  title="Open in main view"
                >
                  Open
                </button>
              )
            ) : (
              <span className="collab-agent-open-disabled">—</span>
            )}
          </div>
        ))}
      </div>
      {!mainTaskCompleted && onWrapUp && (
        <div className="collab-lines-actions">
          <span className="collab-lines-status">
            {isWrappingUp
              ? "Wrapping up..."
              : isMultiLlm
                ? "Models are working..."
                : "Agents are working..."}
          </span>
          <button
            type="button"
            className={`collab-wrap-up-inline-btn${isWrappingUp ? " active" : ""}`}
            onClick={onWrapUp}
            disabled={isWrappingUp}
          >
            Wrap Up
          </button>
        </div>
      )}
    </div>
  );
}
