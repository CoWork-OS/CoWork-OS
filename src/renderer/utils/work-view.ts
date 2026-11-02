import {
  attentionActorForTask,
  attentionOriginForTask,
  attentionPlaceForTask,
  classifyTaskActivity,
  type AttentionActor,
  type AttentionItem,
  type AttentionOrigin,
  type AttentionPlace,
  type AttentionTaskContext,
} from "../../shared/attention";
import { deriveCanonicalTaskStatus } from "../../shared/task-status";
import type { Task, Workspace } from "../../shared/types";
import { getSidebarSessionTitle, isSidebarRecentWorkspace } from "../components/Sidebar";

/**
 * The Work view: every root session, whoever started it, grouped by project, with repeated
 * runs of the same work collapsed into one row. Status and "next decision" come from the
 * same rules and queue as the Today stack and the sidebar, so the three agree.
 */

export type WorkStatus = "needs" | "running" | "done" | "partial" | "cancelled" | "failed";
export type WorkStatusFilter = "all" | WorkStatus;
export type WorkOriginFilter = "any" | AttentionOrigin["kind"];

export interface WorkFilters {
  status: WorkStatusFilter;
  origin: WorkOriginFilter;
  /** An actor name, or "anyone". */
  actor: string;
  query: string;
}

export const DEFAULT_WORK_FILTERS: WorkFilters = {
  status: "all",
  origin: "any",
  actor: "anyone",
  query: "",
};

export interface WorkRun {
  task: Task;
  status: WorkStatus;
  statusLabel: string;
  at: number;
}

export interface WorkRow {
  /** Stable while the runs change: the project and the normalized title. */
  id: string;
  title: string;
  status: WorkStatus;
  statusLabel: string;
  /** The run the row stands for: the one waiting on the user, else running, else the latest. */
  task: Task;
  /** All runs of this work, newest first. More than one when repeated runs were collapsed. */
  runs: WorkRun[];
  /** The queue item waiting on the user for this work, when there is one. */
  decision?: AttentionItem;
  actor: AttentionActor;
  origin: AttentionOrigin;
  place: AttentionPlace;
  at: number;
}

export interface WorkGroup {
  /** The workspace id, or "none" for sessions outside a project. */
  id: string;
  label: string;
  rows: WorkRow[];
  needs: number;
  running: number;
}

export interface WorkModel {
  groups: WorkGroup[];
  /** Rows per status after the search, origin and actor filters, before the status filter. */
  counts: Record<WorkStatusFilter, number>;
  /** Actor names present, "You" first, for the actor filter. */
  actors: string[];
}

const NO_PROJECT = "none";

/** Sessions that belong to another surface: sub-agents, side chats and agent panel turns. */
function isWorkSession(task: Task): boolean {
  if (task.parentTaskId) return false;
  return task.source !== "managed_agent_panel" && task.source !== "side_chat";
}

function statusOf(task: Task, decision: AttentionItem | undefined): Omit<WorkRun, "task" | "at"> {
  if (decision) return { status: "needs", statusLabel: decision.state };
  const activity = classifyTaskActivity(task);
  if (activity?.category === "needs-you") return { status: "needs", statusLabel: activity.label };
  if (activity?.category === "running") return { status: "running", statusLabel: activity.label };
  if (activity?.label === "Queued") return { status: "running", statusLabel: "Queued" };
  const canonical = deriveCanonicalTaskStatus(task);
  if (canonical === "failed") return { status: "failed", statusLabel: "Failed" };
  if (canonical === "cancelled") return { status: "cancelled", statusLabel: "Cancelled" };
  if (task.terminalStatus === "partial_success") {
    return { status: "partial", statusLabel: "Partly done" };
  }
  return { status: "done", statusLabel: "Done" };
}

const STATUS_ORDER: Record<WorkStatus, number> = {
  needs: 0,
  running: 1,
  failed: 2,
  done: 3,
  partial: 3,
  cancelled: 3,
};

function normalizeTitle(title: string): string {
  return title.trim().replace(/\s+/g, " ").toLocaleLowerCase();
}

function runAt(task: Task): number {
  return task.updatedAt || task.completedAt || task.createdAt;
}

/** The first queue item per task: approvals and questions outrank a plain waiting session. */
function decisionsByTask(attention: readonly AttentionItem[]): Map<string, AttentionItem> {
  const byTask = new Map<string, AttentionItem>();
  for (const item of attention) {
    if (!item.taskId) continue;
    if (item.kind !== "approval" && item.kind !== "question" && item.kind !== "session") continue;
    const existing = byTask.get(item.taskId);
    if (!existing || (existing.kind === "session" && item.kind !== "session")) {
      byTask.set(item.taskId, item);
    }
  }
  return byTask;
}

function matches(row: WorkRow, filters: WorkFilters): boolean {
  const query = filters.query.trim().toLocaleLowerCase();
  if (query && !row.title.toLocaleLowerCase().includes(query)) return false;
  if (filters.origin !== "any" && row.origin.kind !== filters.origin) return false;
  if (filters.actor !== "anyone" && row.actor.name !== filters.actor) return false;
  return true;
}

export function buildWorkModel(input: {
  tasks: readonly Task[];
  workspaces: readonly Workspace[];
  attention: readonly AttentionItem[];
  context: AttentionTaskContext;
  filters: WorkFilters;
}): WorkModel {
  const { context, filters } = input;
  const projects = new Map(
    input.workspaces
      .filter((workspace) => !isSidebarRecentWorkspace(workspace))
      .map((workspace) => [workspace.id, workspace.name || "Untitled project"]),
  );
  const decisions = decisionsByTask(input.attention);

  // Collapse repeated runs: same project, same title.
  const runsByKey = new Map<string, { projectId: string; title: string; runs: WorkRun[] }>();
  for (const task of input.tasks) {
    if (!isWorkSession(task)) continue;
    const projectId = projects.has(task.workspaceId) ? task.workspaceId : NO_PROJECT;
    const title = getSidebarSessionTitle({ task, displayTitle: undefined });
    const key = `${projectId}:${normalizeTitle(title)}`;
    const run: WorkRun = { task, at: runAt(task), ...statusOf(task, decisions.get(task.id)) };
    const entry = runsByKey.get(key);
    if (entry) entry.runs.push(run);
    else runsByKey.set(key, { projectId, title, runs: [run] });
  }

  const rows: Array<WorkRow & { projectId: string }> = [];
  for (const [key, entry] of runsByKey) {
    const runs = entry.runs.sort((a, b) => b.at - a.at);
    const lead =
      runs.find((run) => run.status === "needs") ??
      runs.find((run) => run.status === "running") ??
      runs[0];
    rows.push({
      id: key,
      projectId: entry.projectId,
      title: entry.title,
      status: lead.status,
      statusLabel: lead.statusLabel,
      task: lead.task,
      runs,
      decision: decisions.get(lead.task.id),
      actor: attentionActorForTask(lead.task, context),
      origin: attentionOriginForTask(lead.task),
      place: attentionPlaceForTask(lead.task, context),
      at: runs[0].at,
    });
  }

  const visible = rows.filter((row) => matches(row, filters));
  const counts: Record<WorkStatusFilter, number> = {
    all: visible.length,
    needs: 0,
    running: 0,
    done: 0,
    partial: 0,
    cancelled: 0,
    failed: 0,
  };
  for (const row of visible) counts[row.status] += 1;

  const actors = [...new Set(rows.map((row) => row.actor.name))].sort((a, b) =>
    a === "You" ? -1 : b === "You" ? 1 : a.localeCompare(b),
  );

  const groupsById = new Map<string, WorkGroup & { latest: number }>();
  for (const row of visible) {
    if (filters.status !== "all" && row.status !== filters.status) continue;
    let group = groupsById.get(row.projectId);
    if (!group) {
      group = {
        id: row.projectId,
        label: projects.get(row.projectId) ?? "No project",
        rows: [],
        needs: 0,
        running: 0,
        latest: 0,
      };
      groupsById.set(row.projectId, group);
    }
    const { projectId: _projectId, ...plain } = row;
    group.rows.push(plain);
    if (row.status === "needs") group.needs += 1;
    if (row.status === "running") group.running += 1;
    group.latest = Math.max(group.latest, row.at);
  }

  const groups = [...groupsById.values()]
    .map(({ latest, ...group }) => ({
      ...group,
      latest,
      rows: group.rows.sort(
        (a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || b.at - a.at,
      ),
    }))
    .sort((a, b) => {
      if ((a.id === NO_PROJECT) !== (b.id === NO_PROJECT)) return a.id === NO_PROJECT ? 1 : -1;
      return b.latest - a.latest;
    })
    .map(({ latest: _latest, ...group }) => group);

  return { groups, counts, actors };
}

/** "3 need you · 1 running", or the row count when nothing is active. */
export function workGroupSummary(group: WorkGroup): string {
  const parts: string[] = [];
  if (group.needs) parts.push(`${group.needs} ${group.needs === 1 ? "needs" : "need"} you`);
  if (group.running) parts.push(`${group.running} running`);
  if (parts.length === 0) {
    parts.push(`${group.rows.length} ${group.rows.length === 1 ? "session" : "sessions"}`);
  }
  return parts.join(" · ");
}

/** What started the work, as the value of a "Started by" field: "A schedule", "You". */
export function originFactLabel(origin: AttentionOrigin): string {
  switch (origin.kind) {
    case "you":
      return "You";
    case "schedule":
      return "A schedule";
    case "event":
      return "An event";
    case "api":
      return "The API";
    case "agent":
      return "Another agent";
    case "flow":
      return "An automation";
    case "memory":
      return "Your notes";
    case "background":
      return /heartbeat/i.test(origin.label) ? "Heartbeat" : "Background work";
  }
}

/** Short initials for an actor's avatar: "Ops bot" → "OB", "You" → "Y". */
export function actorInitials(name: string): string {
  const words = name.split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const letters = words.length === 1 ? words[0][0] : words[0][0] + words[1][0];
  return letters.toLocaleUpperCase();
}
