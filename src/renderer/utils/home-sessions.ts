import type { Task } from "../../shared/types";
import { isAutomatedTaskLike } from "../../shared/automated-task-detection";
import { getSidebarSessionTitle } from "../components/Sidebar";
import { getSidebarSessionActivity } from "./sidebar-session-state";

export interface HomeSessionSummary {
  id: string;
  title: string;
  updatedAt: number;
  /** Why the session is waiting on the user, e.g. "Approval needed". */
  attention?: string;
}

export interface HomeSessions {
  needsYou: HomeSessionSummary[];
  /** Automated sessions that finished cleanly in the last day: work handled without the user. */
  handled: HomeSessionSummary[];
}

export const EMPTY_HOME_SESSIONS: HomeSessions = { needsYou: [], handled: [] };

const NEEDS_YOU_LIMIT = 6;
const HANDLED_LIMIT = 4;
const HANDLED_WINDOW_MS = 24 * 60 * 60 * 1000;

/** Finished with nothing left for the user: completed, not failed, not waiting on anything. */
function finishedCleanly(task: Task): boolean {
  if (task.status !== "completed") return false;
  return (
    task.terminalStatus === undefined ||
    task.terminalStatus === "ok" ||
    task.terminalStatus === "partial_success"
  );
}

function summarize(task: Task, attention?: string): HomeSessionSummary {
  return {
    id: task.id,
    title: getSidebarSessionTitle({ task, displayTitle: undefined }),
    updatedAt: task.updatedAt || task.createdAt,
    ...(attention ? { attention } : {}),
  };
}

/**
 * What the home screen lists under the composer: sessions waiting on the user
 * (including automated ones, which the sidebar tucks away), then automated
 * sessions that finished on their own in the last day. Sub-agents are left out;
 * their parent session already represents them.
 */
export function buildHomeSessions(tasks: readonly Task[], now = Date.now()): HomeSessions {
  const roots = tasks
    .filter((task) => !task.parentTaskId)
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt));

  const needsYou: HomeSessionSummary[] = [];
  const handled: HomeSessionSummary[] = [];
  for (const task of roots) {
    const activity = getSidebarSessionActivity(task);
    if (activity?.category === "needs-you") {
      if (needsYou.length < NEEDS_YOU_LIMIT) needsYou.push(summarize(task, activity.label));
      continue;
    }
    if (!isAutomatedTaskLike(task) || handled.length >= HANDLED_LIMIT) continue;
    const finishedAt = task.completedAt || task.updatedAt || task.createdAt;
    if (finishedCleanly(task) && now - finishedAt <= HANDLED_WINDOW_MS) {
      handled.push({ ...summarize(task), updatedAt: finishedAt });
    }
  }
  return needsYou.length === 0 && handled.length === 0
    ? EMPTY_HOME_SESSIONS
    : { needsYou, handled };
}

/** Value equality, so callers can keep a stable reference across task updates. */
export function sameHomeSessions(a: HomeSessions, b: HomeSessions): boolean {
  const sameList = (x: HomeSessionSummary[], y: HomeSessionSummary[]) =>
    x.length === y.length &&
    x.every(
      (item, index) =>
        item.id === y[index].id &&
        item.title === y[index].title &&
        item.updatedAt === y[index].updatedAt &&
        item.attention === y[index].attention,
    );
  return sameList(a.needsYou, b.needsYou) && sameList(a.handled, b.handled);
}

export function formatHomeSessionTime(timestamp: number, now: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return "";
  const diffMs = Math.max(0, now - timestamp);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "Now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const date = new Date(timestamp);
  const days = Math.floor(hours / 24);
  if (days < 7) return date.toLocaleDateString(undefined, { weekday: "short" });
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}
