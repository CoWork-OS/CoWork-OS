/**
 * Sub-agent lifecycle rows for the parent transcript.
 *
 * Instead of one large panel, a run with sub-agents reads like a conversation:
 * "Anansi, Ares and 2 more started working" where a burst of agents was
 * spawned, and "Ares finished" / "Athena failed" where they ended, each at its
 * own point in time so the parent's own narration and activity interleave
 * between them.
 */

import type { Task, TaskEvent } from "../../shared/types";
import type { BaseTimelineItem } from "./task-event-derived";
import { getEffectiveTaskEventType } from "./task-event-compat";
import { stripAgentRoleSuffix, type AgentRosterState } from "../../shared/subagent-presentation";

/** Agents spawned or ending within this gap of each other share one row. */
export const AGENT_LIFECYCLE_BURST_WINDOW_MS = 15_000;

export interface AgentLifecycleRow {
  /** Stable across re-renders: keyed by the first agent of the burst. */
  id: string;
  state: AgentRosterState;
  timestamp: number;
  taskIds: string[];
}

/** Roster names stay short so a burst line fits on one row. */
const MAX_AGENT_NAME_LENGTH = 28;

const LEADING_EMOJI_REGEX = /^[\p{Extended_Pictographic}\uFE0F\u200D\s]+/u;

/**
 * "@builder: Fix the parser (builder)" → "Fix the parser". Drops the mention
 * prefix, a leading emoji and the call-sign, then clips long titles.
 */
export function resolveAgentDisplayName(title: string, fallback = "Agent"): string {
  const withoutMention = title.replace(/^@[^:]+:\s*/, "").replace(LEADING_EMOJI_REGEX, "");
  const name = stripAgentRoleSuffix(withoutMention).trim() || fallback;
  if (name.length <= MAX_AGENT_NAME_LENGTH) return name;
  return `${name.slice(0, MAX_AGENT_NAME_LENGTH).trimEnd()}…`;
}

type LifecycleTask = Pick<Task, "id" | "status" | "createdAt" | "updatedAt" | "completedAt">;

const TERMINAL_STATE: Partial<Record<Task["status"], AgentRosterState>> = {
  completed: "finished",
  failed: "failed",
  cancelled: "stopped",
};

export function getAgentTerminalRosterState(status: Task["status"]): AgentRosterState | null {
  return TERMINAL_STATE[status] ?? null;
}

function groupBursts<T extends { id: string; ts: number; state: AgentRosterState }>(
  entries: T[],
  windowMs: number,
  idPrefix: string,
): AgentLifecycleRow[] {
  const rows: AgentLifecycleRow[] = [];
  let current: AgentLifecycleRow | null = null;
  let lastTs = 0;
  for (const entry of entries) {
    if (current && current.state === entry.state && entry.ts - lastTs <= windowMs) {
      current.taskIds.push(entry.id);
    } else {
      current = {
        id: `${idPrefix}:${entry.state}:${entry.id}`,
        state: entry.state,
        timestamp: entry.ts,
        taskIds: [entry.id],
      };
      rows.push(current);
    }
    lastTs = entry.ts;
  }
  return rows;
}

const byTimeThenId = (a: { ts: number; id: string }, b: { ts: number; id: string }) =>
  a.ts !== b.ts ? a.ts - b.ts : a.id.localeCompare(b.id);

/**
 * Build the start and end rows for a run's sub-agents, sorted by time. Start
 * rows stay "started working" after the agents end — they record when the
 * burst began; the matching end rows record how it ended.
 */
export function buildAgentLifecycleRows(
  tasks: readonly LifecycleTask[],
  windowMs: number = AGENT_LIFECYCLE_BURST_WINDOW_MS,
): AgentLifecycleRow[] {
  const starts = tasks
    .map((task) => ({ id: task.id, ts: task.createdAt, state: "working" as const }))
    .sort(byTimeThenId);

  const ends = tasks
    .flatMap((task) => {
      const state = getAgentTerminalRosterState(task.status);
      if (!state) return [];
      // An end row never sits above its own start row, even with skewed clocks.
      const endedAt = Math.max(
        task.completedAt ?? task.updatedAt ?? task.createdAt,
        task.createdAt,
      );
      return [{ id: task.id, ts: endedAt, state }];
    })
    .sort(byTimeThenId);

  const phaseRank = (row: AgentLifecycleRow) => (row.state === "working" ? 0 : 1);
  return [...groupBursts(starts, windowMs, "start"), ...groupBursts(ends, windowMs, "end")].sort(
    (a, b) => a.timestamp - b.timestamp || phaseRank(a) - phaseRank(b) || a.id.localeCompare(b.id),
  );
}

export type AgentStatusTone = "running" | "queued" | "paused" | "done" | "failed";

const RUNNING_STATUSES = new Set<Task["status"]>(["planning", "executing", "interrupted"]);

export function isAgentTaskRunning(status: Task["status"]): boolean {
  return RUNNING_STATUSES.has(status);
}

/** Short status chip for one agent: tone drives color, label is the text. */
export function describeAgentStatus(status: Task["status"]): {
  tone: AgentStatusTone;
  label: string;
} {
  switch (status) {
    case "planning":
    case "executing":
    case "interrupted":
      return { tone: "running", label: "Working" };
    case "pending":
    case "queued":
      return { tone: "queued", label: "Queued" };
    case "paused":
      return { tone: "paused", label: "Paused" };
    case "blocked":
      return { tone: "paused", label: "Blocked" };
    case "completed":
      return { tone: "done", label: "Done" };
    case "cancelled":
      return { tone: "failed", label: "Stopped" };
    case "failed":
    default:
      return { tone: "failed", label: "Failed" };
  }
}

/** Parent events that a lifecycle row already says, per child agent. */
const LIFECYCLE_ROW_EVENT_TYPES = new Set([
  "agent_spawn_requested",
  "agent_spawned",
  "agent_completed",
  "agent_failed",
]);

function isCoveredLifecycleEvent(event: TaskEvent, coveredTaskIds: ReadonlySet<string>): boolean {
  if (!LIFECYCLE_ROW_EVENT_TYPES.has(getEffectiveTaskEventType(event))) return false;
  const payload = (event.payload || {}) as Record<string, unknown>;
  const childTaskId = payload.childTaskId;
  return typeof childTaskId === "string" && coveredTaskIds.has(childTaskId);
}

/**
 * Drop the parent's spawn/finish events for agents that lifecycle rows already
 * cover, so a burst is announced once. Events naming no known child (a spawn
 * that never produced a task, a dispatch failure) stay in the feed.
 */
export function withoutCoveredAgentLifecycleEvents(
  items: BaseTimelineItem[],
  coveredTaskIds: ReadonlySet<string>,
): BaseTimelineItem[] {
  if (coveredTaskIds.size === 0) return items;
  let changed = false;
  const next: BaseTimelineItem[] = [];
  for (const item of items) {
    if (item.kind === "event") {
      if (isCoveredLifecycleEvent(item.event, coveredTaskIds)) {
        changed = true;
        continue;
      }
      next.push(item);
      continue;
    }
    const keep = item.events.map((event) => !isCoveredLifecycleEvent(event, coveredTaskIds));
    if (keep.every(Boolean)) {
      next.push(item);
      continue;
    }
    changed = true;
    const events = item.events.filter((_, index) => keep[index]);
    if (events.length === 0) continue;
    next.push({
      ...item,
      events,
      eventIndices: item.eventIndices.filter((_, index) => keep[index]),
    });
  }
  return changed ? next : items;
}
