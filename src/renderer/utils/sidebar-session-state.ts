import type { Task } from "../../shared/types";
import { classifyTaskActivity } from "../../shared/attention";

export type SidebarSessionFilter = "all" | "running" | "needs-you";

interface SidebarSessionActivity {
  category: Exclude<SidebarSessionFilter, "all"> | null;
  label: string;
}

/**
 * Keep the filter, row explanation, and automated activity summary in agreement. The rule
 * is shared with the attention queue, so the sidebar and Today count the same sessions.
 */
export function getSidebarSessionActivity(task: Task): SidebarSessionActivity | null {
  return classifyTaskActivity(task);
}

/** How a session's activity is decided: the plain task rule, or with the queue overlaid. */
export type SidebarSessionActivityResolver = (task: Task) => SidebarSessionActivity | null;

/**
 * The task rule plus the shared queue: a session the queue lists (a pending approval, an
 * agent's question, or the session itself waiting) needs you, with the queue's reason. This
 * catches sessions the task status alone shows as running while they wait on an approval.
 */
export function withAttentionOverlay(
  waiting: ReadonlyMap<string, string> | undefined,
): SidebarSessionActivityResolver {
  if (!waiting || waiting.size === 0) return getSidebarSessionActivity;
  return (task) => {
    const label = waiting.get(task.id);
    return label ? { category: "needs-you", label } : getSidebarSessionActivity(task);
  };
}

export function getSidebarSessionRowHeight(
  task: Task,
  activityOf: SidebarSessionActivityResolver = getSidebarSessionActivity,
): number {
  return activityOf(task) ? 46 : 32;
}

interface SessionTreeNode<T> {
  task: Task;
  children: T[];
  synthetic?: boolean;
}

function hasMatchingSession<T extends SessionTreeNode<T>>(
  node: T,
  filter: Exclude<SidebarSessionFilter, "all">,
  activityOf: SidebarSessionActivityResolver,
): boolean {
  return (
    (!node.synthetic && activityOf(node.task)?.category === filter) ||
    node.children.some((child) => hasMatchingSession(child, filter, activityOf))
  );
}

/** Counts are sessions (roots), including a session with an actionable child. */
export function countSidebarSessionStates<T extends SessionTreeNode<T>>(
  nodes: readonly T[],
  activityOf: SidebarSessionActivityResolver = getSidebarSessionActivity,
) {
  return {
    all: nodes.length,
    running: nodes.filter((node) => hasMatchingSession(node, "running", activityOf)).length,
    "needs-you": nodes.filter((node) => hasMatchingSession(node, "needs-you", activityOf)).length,
  };
}

/** Retain ancestors as context, but don't include unrelated child sessions. */
export function filterSidebarSessionsByState<T extends SessionTreeNode<T>>(
  nodes: T[],
  filter: SidebarSessionFilter,
  activityOf: SidebarSessionActivityResolver = getSidebarSessionActivity,
): T[] {
  if (filter === "all") return nodes;
  return nodes.flatMap((node) => {
    const children = filterSidebarSessionsByState(node.children, filter, activityOf);
    const matches = !node.synthetic && activityOf(node.task)?.category === filter;
    return matches || children.length > 0 ? [{ ...node, children }] : [];
  });
}
