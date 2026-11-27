import { isAutomatedTaskLike, isSpeculativeTask } from "../../shared/automated-task-detection";
import type { Task } from "../../shared/types";
import {
  USAGE_TOP_SESSIONS_LIMIT,
  type UsageSessionBreakdown,
  type UsageSessionCategory,
  type UsageSessionCategoryRow,
  type UsageTopSessionRow,
} from "../../shared/usageSessionBreakdown";

/** Successful model calls in the period, grouped by task (null: no task). */
export interface SessionUsageCallGroup {
  taskId: string | null;
  calls: number;
  cost: number;
  tokens: number;
}

/** The task columns the breakdown reads. */
export interface SessionUsageTaskRow {
  id: string;
  title: string | null;
  status: string | null;
  source: string | null;
  parentTaskId: string | null;
  agentConfig: Record<string, unknown> | null;
  assignedAgentRoleId: string | null;
  companyId: string | null;
  goalId: string | null;
  projectId: string | null;
  issueId: string | null;
  heartbeatRunId: string | null;
}

/** Stops a parent loop in damaged data from hanging the report. */
const MAX_PARENT_HOPS = 32;

function asTaskLike(row: SessionUsageTaskRow): Task {
  return {
    source: row.source ?? undefined,
    title: row.title ?? "",
    agentConfig: row.agentConfig ?? undefined,
    companyId: row.companyId ?? undefined,
    goalId: row.goalId ?? undefined,
    projectId: row.projectId ?? undefined,
    issueId: row.issueId ?? undefined,
    heartbeatRunId: row.heartbeatRunId ?? undefined,
  } as Task;
}

/**
 * The kind of work a task is. Order matters: a sub-agent counts as a sub-agent whatever started
 * it, and a scheduled or heartbeat run counts as automated even when a bot does it.
 */
export function classifyUsageTask(row: SessionUsageTaskRow): UsageSessionCategory {
  if (row.parentTaskId) return "subagents";
  const task = asTaskLike(row);
  if (isSpeculativeTask(task) || isAutomatedTaskLike(task)) return "automated";
  if (row.agentConfig?.botConversation === true || row.assignedAgentRoleId) return "bots";
  if (row.source === "api" || row.source === "hook") return "integrations";
  return "yours";
}

function rootOf(row: SessionUsageTaskRow, tasks: ReadonlyMap<string, SessionUsageTaskRow>) {
  let current = row;
  for (let hop = 0; hop < MAX_PARENT_HOPS && current.parentTaskId; hop += 1) {
    const parent = tasks.get(current.parentTaskId);
    if (!parent) break;
    current = parent;
  }
  return current;
}

function byCostThenTokens<T extends { cost: number; tokens: number }>(a: T, b: T): number {
  return b.cost - a.cost || b.tokens - a.tokens;
}

/**
 * Split the period's usage by kind of work and pick the top sessions. A sub-agent's usage counts
 * under Sub-agents in the split, and toward its top-level session in the list.
 */
export function buildSessionUsageBreakdown(
  groups: readonly SessionUsageCallGroup[],
  tasks: ReadonlyMap<string, SessionUsageTaskRow>,
  limit = USAGE_TOP_SESSIONS_LIMIT,
): UsageSessionBreakdown {
  const categories = new Map<UsageSessionCategory, UsageSessionCategoryRow>();
  const roots = new Map<string, UsageTopSessionRow & { subagents: Set<string> }>();

  const addToCategory = (category: UsageSessionCategory, group: SessionUsageCallGroup) => {
    const row = categories.get(category) ?? {
      category,
      cost: 0,
      tokens: 0,
      calls: 0,
      sessions: 0,
    };
    row.cost += group.cost;
    row.tokens += group.tokens;
    row.calls += group.calls;
    if (group.taskId) row.sessions += 1;
    categories.set(category, row);
  };

  for (const group of groups) {
    if (group.calls <= 0) continue;
    if (!group.taskId) {
      addToCategory("background", group);
      continue;
    }
    const task = tasks.get(group.taskId);
    if (!task) {
      addToCategory("deleted", group);
      continue;
    }
    addToCategory(classifyUsageTask(task), group);

    const root = rootOf(task, tasks);
    const entry = roots.get(root.id) ?? {
      taskId: root.id,
      title: root.title?.trim() || "Untitled session",
      status: root.status,
      category: classifyUsageTask(root),
      cost: 0,
      tokens: 0,
      calls: 0,
      subagentCount: 0,
      subagents: new Set<string>(),
    };
    entry.cost += group.cost;
    entry.tokens += group.tokens;
    entry.calls += group.calls;
    if (task.id !== root.id) entry.subagents.add(task.id);
    roots.set(root.id, entry);
  }

  const topSessions = [...roots.values()]
    .filter((entry) => entry.cost > 0 || entry.tokens > 0)
    .sort(byCostThenTokens)
    .slice(0, Math.max(0, limit))
    .map(({ subagents, ...entry }) => ({ ...entry, subagentCount: subagents.size }));

  return {
    byCategory: [...categories.values()].sort(byCostThenTokens),
    topSessions,
  };
}
