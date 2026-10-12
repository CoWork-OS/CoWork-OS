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

export function getSidebarSessionRowHeight(task: Task): number {
  return getSidebarSessionActivity(task) ? 46 : 32;
}

interface SessionTreeNode<T> {
  task: Task;
  children: T[];
  synthetic?: boolean;
}

function hasMatchingSession<T extends SessionTreeNode<T>>(
  node: T,
  filter: Exclude<SidebarSessionFilter, "all">,
): boolean {
  return (
    (!node.synthetic && getSidebarSessionActivity(node.task)?.category === filter) ||
    node.children.some((child) => hasMatchingSession(child, filter))
  );
}

/** Counts are sessions (roots), including a session with an actionable child. */
export function countSidebarSessionStates<T extends SessionTreeNode<T>>(nodes: readonly T[]) {
  return {
    all: nodes.length,
    running: nodes.filter((node) => hasMatchingSession(node, "running")).length,
    "needs-you": nodes.filter((node) => hasMatchingSession(node, "needs-you")).length,
  };
}

/** Retain ancestors as context, but don't include unrelated child sessions. */
export function filterSidebarSessionsByState<T extends SessionTreeNode<T>>(
  nodes: T[],
  filter: SidebarSessionFilter,
): T[] {
  if (filter === "all") return nodes;
  return nodes.flatMap((node) => {
    const children = filterSidebarSessionsByState(node.children, filter);
    const matches = !node.synthetic && getSidebarSessionActivity(node.task)?.category === filter;
    return matches || children.length > 0 ? [{ ...node, children }] : [];
  });
}
