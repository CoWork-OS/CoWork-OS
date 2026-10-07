import type { Task } from "../../shared/types";
import { deriveCanonicalTaskStatus } from "../../shared/task-status";

export type SidebarSessionFilter = "all" | "running" | "needs-you";

interface SidebarSessionActivity {
  category: Exclude<SidebarSessionFilter, "all"> | null;
  label: string;
}

/** Keep the filter, row explanation, and automated activity summary in agreement. */
export function getSidebarSessionActivity(task: Task): SidebarSessionActivity | null {
  const status = deriveCanonicalTaskStatus(task);
  if (status === "failed" || status === "cancelled") return null;

  if (task.terminalStatus === "awaiting_approval") {
    return { category: "needs-you", label: "Approval needed" };
  }
  if (task.terminalStatus === "awaiting_verification") {
    return { category: "running", label: "Verifying" };
  }
  if (task.terminalStatus === "needs_user_action") {
    return { category: "needs-you", label: "Response needed" };
  }
  if (status === "interrupted" || task.terminalStatus === "resume_available") {
    return { category: "needs-you", label: "Resume available" };
  }
  if (status === "blocked") return { category: "needs-you", label: "Action needed" };
  if (status === "paused") {
    const waitingForInput =
      task.stopReasons?.includes("awaiting_user_input") || task.awaitingUserInputReasonCode;
    return { category: "needs-you", label: waitingForInput ? "Response needed" : "Paused" };
  }
  if (status === "planning") return { category: "running", label: "Planning" };
  if (status === "executing") return { category: "running", label: "Running" };
  if (status === "pending" || status === "queued") return { category: null, label: "Queued" };
  return null;
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
