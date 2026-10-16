import type {
  PlanStep,
  SessionChecklistState,
  TaskEvent,
  TaskStatusStripState,
} from "../../shared/types";
import { generatedPlanStepLabel } from "../../shared/generated-plan-steps";
import { getEffectiveTaskEventType } from "./task-event-compat";

/**
 * The live plan is the ordered list a running task works through, shown above the
 * composer while the task runs and folded away once it ends. It reads either the
 * agent's own session checklist (`task_list_*`) or the planner's steps.
 */
export type LivePlanItemStatus = "pending" | "active" | "done" | "skipped" | "blocked" | "failed";

export interface LivePlanItem {
  id: string;
  label: string;
  status: LivePlanItemStatus;
  /** Planner step id, so a row can jump to that step's activity group. */
  planStepId?: string;
}

export interface LivePlanModel {
  source: "checklist" | "plan";
  items: LivePlanItem[];
  doneCount: number;
  activeId?: string;
}

/** A one-item list says nothing the status strip doesn't already say. */
const MIN_LIVE_PLAN_ITEMS = 2;

const LIVE_STATES = new Set<TaskStatusStripState>([
  "working",
  "paused",
  "blocked",
  "waiting_for_approval",
  "waiting_for_input",
]);

const CHECKLIST_EVENT_TYPES = new Set<string>([
  "task_list_created",
  "task_list_updated",
  "task_list_verification_nudged",
]);

const PLAN_EVENT_TYPES = new Set<string>([
  "plan_created",
  "plan_revised",
  "step_started",
  "step_completed",
  "step_failed",
]);

function checklistItemStatus(
  status: SessionChecklistState["items"][number]["status"],
): LivePlanItemStatus {
  if (status === "completed") return "done";
  if (status === "in_progress") return "active";
  if (status === "blocked") return "blocked";
  return "pending";
}

function planStepStatus(status: PlanStep["status"]): LivePlanItemStatus {
  if (status === "completed") return "done";
  if (status === "in_progress") return "active";
  if (status === "failed") return "failed";
  if (status === "skipped") return "skipped";
  return "pending";
}

/**
 * When each plan source was last touched, relative to the latest user message.
 * A follow-up turn keeps the previous turn's checklist and plan in the event log;
 * only a source written during the current turn describes the work in progress.
 */
function sourceFreshness(events: TaskEvent[]): { checklist: boolean; plan: boolean } {
  let latestUserAt = -Infinity;
  let latestChecklistAt = -Infinity;
  let latestPlanAt = -Infinity;
  for (const event of events) {
    const type = getEffectiveTaskEventType(event);
    const at = event.timestamp || 0;
    if (type === "user_message") latestUserAt = Math.max(latestUserAt, at);
    else if (CHECKLIST_EVENT_TYPES.has(type)) latestChecklistAt = Math.max(latestChecklistAt, at);
    else if (PLAN_EVENT_TYPES.has(type)) latestPlanAt = Math.max(latestPlanAt, at);
  }
  return {
    checklist: latestChecklistAt >= latestUserAt,
    plan: latestPlanAt >= latestUserAt,
  };
}

function finalize(source: LivePlanModel["source"], items: LivePlanItem[]): LivePlanModel | null {
  if (items.length < MIN_LIVE_PLAN_ITEMS) return null;
  const active =
    items.find((item) => item.status === "active") ??
    items.find((item) => item.status === "blocked" || item.status === "failed");
  return {
    source,
    items,
    doneCount: items.filter((item) => item.status === "done" || item.status === "skipped").length,
    ...(active ? { activeId: active.id } : {}),
  };
}

export function deriveLivePlan(args: {
  state: TaskStatusStripState;
  planSteps: PlanStep[];
  checklistState: SessionChecklistState | null;
  events: TaskEvent[];
}): LivePlanModel | null {
  if (!LIVE_STATES.has(args.state)) return null;
  const fresh = sourceFreshness(args.events);

  // The agent keeps its checklist current as it works, so it wins over the planner.
  if (fresh.checklist && args.checklistState) {
    const fromChecklist = finalize(
      "checklist",
      args.checklistState.items.map((item) => ({
        id: item.id,
        label: item.title,
        status: checklistItemStatus(item.status),
      })),
    );
    if (fromChecklist) return fromChecklist;
  }

  if (fresh.plan) {
    return finalize(
      "plan",
      args.planSteps
        .filter((step) => step.description.trim().length > 0)
        .map((step) => ({
          id: step.id,
          label: generatedPlanStepLabel(step.description) ?? step.description,
          status: planStepStatus(step.status),
          planStepId: step.id,
        })),
    );
  }
  return null;
}

export const LIVE_PLAN_MAX_ROWS = 6;

export type LivePlanRow =
  | { kind: "item"; item: LivePlanItem; index: number }
  | { kind: "more-before"; count: number }
  | { kind: "more-after"; count: number };

/**
 * Long plans show a window around the current item: one finished item for context,
 * the current one, and what comes next. The hidden ends fold into "N done" and
 * "N more" rows that expand the full list.
 */
export function windowLivePlanRows(
  plan: LivePlanModel,
  expanded: boolean,
  maxRows = LIVE_PLAN_MAX_ROWS,
): LivePlanRow[] {
  const all: LivePlanRow[] = plan.items.map((item, index) => ({ kind: "item", item, index }));
  const total = plan.items.length;
  if (expanded || total <= maxRows) return all;

  const focusIndex = Math.max(
    0,
    plan.activeId
      ? plan.items.findIndex((item) => item.id === plan.activeId)
      : plan.items.findIndex((item) => item.status === "pending"),
  );
  // Each fold row takes one of the `maxRows` slots.
  let start = Math.max(0, focusIndex - 1);
  // Near the end, pull the window back so it stays full instead of leaving slots empty.
  if (start > 0 && total - start < maxRows - 1) start = total - (maxRows - 1);
  const itemSlots = maxRows - (start > 0 ? 1 : 0);
  const end = total - start <= itemSlots ? total : start + itemSlots - 1;

  const rows: LivePlanRow[] = [];
  if (start > 0) rows.push({ kind: "more-before", count: start });
  rows.push(...all.slice(start, end));
  if (end < total) rows.push({ kind: "more-after", count: total - end });
  return rows;
}
