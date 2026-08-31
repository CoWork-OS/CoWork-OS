import type { PlanStep, QueueStatus, Task } from "../../shared/types";

export type ProgressDisplayStep = PlanStep & {
  isOverflow?: boolean;
  hiddenCount?: number;
  hiddenLabel?: string;
};

export function getQueueStatusSignature(queueStatus: QueueStatus | null | undefined): string {
  if (!queueStatus) return "none";
  return [
    queueStatus.runningCount,
    queueStatus.queuedCount,
    queueStatus.maxConcurrent,
    queueStatus.runningTaskIds.join(","),
    queueStatus.queuedTaskIds.join(","),
  ].join(":");
}

export function getPlanStepsSignature(planSteps: PlanStep[]): string {
  return planSteps
    .map((step) => `${step.id}:${step.status}:${step.error ?? ""}:${step.description}`)
    .join("|");
}

export function getTaskListSignature(tasks: Task[]): string {
  return tasks.map((task) => `${task.id}:${task.status}:${task.title || task.prompt}`).join("|");
}

export function getProgressSectionMaterialSignature(args: {
  expanded: boolean;
  planSteps: PlanStep[];
  taskStatus?: Task["status"];
  taskTerminalStatus?: Task["terminalStatus"];
  hasActiveChildren: boolean;
  emptyHintText: string;
}): string {
  return [
    args.expanded ? 1 : 0,
    getPlanStepsSignature(args.planSteps),
    args.taskStatus ?? "none",
    args.taskTerminalStatus ?? "none",
    args.hasActiveChildren ? 1 : 0,
    args.emptyHintText,
  ].join(":");
}

export function getQueueSectionMaterialSignature(args: {
  expanded: boolean;
  runningTasks: Task[];
  queuedTasks: Task[];
  activeLabel: string;
  nextLabel: string;
}): string {
  return [
    args.expanded ? 1 : 0,
    getTaskListSignature(args.runningTasks),
    getTaskListSignature(args.queuedTasks),
    args.activeLabel,
    args.nextLabel,
  ].join(":");
}

const MAX_VISIBLE_PROGRESS_STEPS = 5;

function makeProgressOverflowStep(
  startIndex: number,
  endIndex: number,
  hiddenSteps: PlanStep[],
): ProgressDisplayStep {
  const hiddenCount = Math.max(0, endIndex - startIndex + 1);
  const completedCount = hiddenSteps.filter((step) => step.status === "completed").length;
  const failedCount = hiddenSteps.filter((step) => step.status === "failed").length;
  const skippedCount = hiddenSteps.filter((step) => step.status === "skipped").length;
  const pendingCount = hiddenSteps.filter((step) => step.status === "pending").length;
  const status: PlanStep["status"] =
    failedCount > 0
      ? "failed"
      : hiddenCount > 0 && completedCount + skippedCount === hiddenCount
        ? "completed"
        : "pending";
  const descriptor =
    hiddenCount === 1
      ? completedCount === 1
        ? "1 completed step"
        : pendingCount === 1
          ? "1 planned step"
          : "1 step"
      : completedCount + skippedCount === hiddenCount
        ? `${hiddenCount} completed steps`
        : pendingCount === hiddenCount
          ? `${hiddenCount} planned steps`
          : `${hiddenCount} more steps`;
  return {
    id: `progress-overflow-${startIndex}-${endIndex}`,
    description: descriptor,
    status,
    isOverflow: true,
    hiddenCount,
    hiddenLabel: descriptor,
  };
}

export function getVisibleProgressSteps(planSteps: PlanStep[]): ProgressDisplayStep[] {
  if (planSteps.length <= MAX_VISIBLE_PROGRESS_STEPS) {
    return planSteps.map((step) => ({ ...step }));
  }

  const selected = new Set<number>();
  const activeIndex = planSteps.findIndex((step) => step.status === "in_progress");
  const firstPendingIndex = planSteps.findIndex((step) => step.status === "pending");
  const anchorIndex =
    activeIndex >= 0
      ? activeIndex
      : firstPendingIndex >= 0
        ? firstPendingIndex
        : planSteps.length - 1;

  planSteps.forEach((step, index) => {
    if (step.status === "failed") selected.add(index);
  });

  const completedBeforeAnchor = planSteps
    .map((step, index) => ({ step, index }))
    .filter(
      ({ step, index }) =>
        index < anchorIndex && (step.status === "completed" || step.status === "skipped"),
    )
    .slice(-2);
  completedBeforeAnchor.forEach(({ index }) => selected.add(index));

  selected.add(anchorIndex);

  const pendingAfterAnchor = planSteps
    .map((step, index) => ({ step, index }))
    .filter(({ step, index }) => index > anchorIndex && step.status === "pending")
    .slice(0, 2);
  pendingAfterAnchor.forEach(({ index }) => selected.add(index));

  if (selected.size < MAX_VISIBLE_PROGRESS_STEPS) {
    for (
      let index = 0;
      index < planSteps.length && selected.size < MAX_VISIBLE_PROGRESS_STEPS;
      index += 1
    ) {
      if (planSteps[index]?.status === "pending") selected.add(index);
    }
  }

  if (selected.size < MAX_VISIBLE_PROGRESS_STEPS) {
    for (
      let index = planSteps.length - 1;
      index >= 0 && selected.size < MAX_VISIBLE_PROGRESS_STEPS;
      index -= 1
    ) {
      selected.add(index);
    }
  }

  const selectedIndexes = Array.from(selected).sort((a, b) => a - b);
  const displaySteps: ProgressDisplayStep[] = [];
  let previousIndex = -1;

  for (const index of selectedIndexes) {
    if (index > previousIndex + 1) {
      displaySteps.push(
        makeProgressOverflowStep(
          previousIndex + 1,
          index - 1,
          planSteps.slice(previousIndex + 1, index),
        ),
      );
    }
    displaySteps.push({ ...planSteps[index] });
    previousIndex = index;
  }

  if (previousIndex < planSteps.length - 1) {
    displaySteps.push(
      makeProgressOverflowStep(
        previousIndex + 1,
        planSteps.length - 1,
        planSteps.slice(previousIndex + 1),
      ),
    );
  }

  return displaySteps;
}
