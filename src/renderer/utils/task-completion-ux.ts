import type { TaskOutputSummary, ToastNotification } from "../../shared/types";
import { getPrimaryOutputFileName, hasTaskOutputs } from "./task-outputs";

/** Normalize path for consistent comparison */
function normalizePathForCompare(raw: string): string {
  return raw.trim().replace(/\\/g, "/");
}

/** Get all output paths from a summary (created + modifiedFallback) */
export function getAllOutputPathsFromSummary(
  summary: TaskOutputSummary | null | undefined,
): string[] {
  if (!summary) return [];
  const created = Array.isArray(summary.created) ? summary.created : [];
  const modified = Array.isArray(summary.modifiedFallback) ? summary.modifiedFallback : [];
  const effective = created.length > 0 ? created : modified;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of effective) {
    const n = normalizePathForCompare(String(p));
    if (n && !seen.has(n)) {
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

export interface CompletionToastDecision {
  show: boolean;
  /** Paths to add to notified set after showing (for output case) */
  pathsToRecord: string[];
}

export function shouldShowPersistentNeedsUserActionBanner(
  payload:
    | {
        terminalStatus?: string;
        pendingChecklist?: unknown;
        verificationMessage?: unknown;
        verificationOutcome?: unknown;
      }
    | null
    | undefined,
): boolean {
  if (payload?.terminalStatus !== "needs_user_action") return false;
  if (
    Array.isArray(payload.pendingChecklist) &&
    payload.pendingChecklist.some((item) => typeof item === "string")
  ) {
    return true;
  }
  if (
    typeof payload.verificationMessage === "string" &&
    payload.verificationMessage.trim().length > 0
  ) {
    return true;
  }
  return payload.verificationOutcome === "pending_user_action";
}

/**
 * Decide whether to show the completion toast.
 * Show on first completion, or when new files are created in a follow-up.
 * Suppress repeated toasts for the same outputs in the same session.
 */
export function shouldShowCompletionToast(
  taskId: string,
  outputSummary: TaskOutputSummary | null | undefined,
  notifiedPathsByTask: Map<string, Set<string>>,
): CompletionToastDecision {
  const hasOutputs = hasTaskOutputs(outputSummary);
  const notified = notifiedPathsByTask.get(taskId);

  if (hasOutputs) {
    const currentPaths = getAllOutputPathsFromSummary(outputSummary);
    const notifiedSet = notified ?? new Set<string>();
    const newPaths = currentPaths.filter((p) => !notifiedSet.has(p));
    const isFirstCompletion = !notifiedPathsByTask.has(taskId);
    const show = isFirstCompletion || newPaths.length > 0;
    return {
      show,
      pathsToRecord: show ? [...new Set([...notifiedSet, ...currentPaths])] : [],
    };
  }

  // No outputs: show only on first completion for this task
  const show = !notifiedPathsByTask.has(taskId);
  return {
    show,
    pathsToRecord: [],
  };
}

/** Record that we showed the completion toast (call after showing) */
export function recordCompletionToastShown(
  taskId: string,
  pathsToRecord: string[],
  notifiedPathsByTask: Map<string, Set<string>>,
  hadOutputs: boolean,
): void {
  if (hadOutputs && pathsToRecord.length > 0) {
    notifiedPathsByTask.set(taskId, new Set(pathsToRecord));
  } else {
    // No outputs: use empty set as sentinel so we know we've shown
    notifiedPathsByTask.set(taskId, new Set());
  }
}

export interface CompletionViewContext {
  isMainView: boolean;
  isSelectedTask: boolean;
  panelCollapsed: boolean;
}

export interface CompletionPanelDecision {
  autoOpenPanel: boolean;
  markUnseenOutput: boolean;
}

export interface CompletionToastActionDependencies {
  resolveWorkspacePath: () => Promise<string | undefined>;
  openFile: (path: string, workspacePath?: string) => Promise<string | undefined | null>;
  showInFinder: (path: string, workspacePath?: string) => Promise<void>;
  onViewInFiles: () => void;
  onOpenFileError?: (error: unknown) => void;
  onShowInFinderError?: (error: unknown) => void;
}

export function buildCompletionOutputMessage(summary: TaskOutputSummary): string {
  const primaryOutputName = getPrimaryOutputFileName(summary);
  if (summary.outputCount === 1) {
    return primaryOutputName || "1 file created";
  }
  if (primaryOutputName) {
    const more = summary.outputCount - 1;
    return more === 1 ? `${primaryOutputName} + 1 more` : `${primaryOutputName} + ${more} more`;
  }
  return `${summary.outputCount} files created`;
}

export function shouldTrackUnseenCompletion(
  context: Pick<CompletionViewContext, "isMainView" | "isSelectedTask">,
): boolean {
  return !(context.isMainView && context.isSelectedTask);
}

export function decideCompletionPanelBehavior(
  context: CompletionViewContext,
): CompletionPanelDecision {
  if (context.isMainView && context.isSelectedTask && context.panelCollapsed) {
    return { autoOpenPanel: true, markUnseenOutput: false };
  }
  if (!context.isMainView || context.panelCollapsed || !context.isSelectedTask) {
    return { autoOpenPanel: false, markUnseenOutput: true };
  }
  return { autoOpenPanel: false, markUnseenOutput: false };
}

export function addUniqueTaskId(taskIds: string[], taskId: string): string[] {
  return taskIds.includes(taskId) ? taskIds : [...taskIds, taskId];
}

export function removeTaskId(taskIds: string[], taskId: string): string[] {
  return taskIds.filter((id) => id !== taskId);
}

export function shouldClearUnseenOutputBadges(
  isMainView: boolean,
  rightPanelCollapsed: boolean,
): boolean {
  return isMainView && !rightPanelCollapsed;
}

export function shouldNotifyForTaskCompletionTerminalStatus(terminalStatus?: string): boolean {
  return typeof terminalStatus === "string" && terminalStatus !== "ok";
}

export function createCompletionOutputToastActions(
  primaryOutputPath: string | undefined,
  dependencies: CompletionToastActionDependencies,
): NonNullable<ToastNotification["actions"]> {
  return [
    {
      label: "Open file",
      callback: async () => {
        if (!primaryOutputPath) return;
        const workspacePath = await dependencies.resolveWorkspacePath();
        const openError = await dependencies.openFile(primaryOutputPath, workspacePath);
        if (openError) {
          dependencies.onOpenFileError?.(openError);
        }
      },
    },
    {
      label: "Show in Finder",
      variant: "secondary",
      callback: async () => {
        if (!primaryOutputPath) return;
        try {
          const workspacePath = await dependencies.resolveWorkspacePath();
          await dependencies.showInFinder(primaryOutputPath, workspacePath);
        } catch (error) {
          dependencies.onShowInFinderError?.(error);
        }
      },
    },
    {
      label: "View in Files",
      variant: "secondary",
      callback: () => {
        dependencies.onViewInFiles();
      },
    },
  ];
}

export function buildTaskCompletionToast(options: {
  taskId: string;
  taskTitle?: string;
  outputSummary?: TaskOutputSummary | null;
  actionDependencies?: CompletionToastActionDependencies;
  terminalStatus?:
    | "ok"
    | "partial_success"
    | "needs_user_action"
    | "awaiting_approval"
    | "resume_available"
    | "failed"
    | string;
}): Omit<ToastNotification, "id"> {
  const { taskId, taskTitle, outputSummary, actionDependencies, terminalStatus } = options;
  const isNeedsUserAction =
    terminalStatus === "needs_user_action" || terminalStatus === "awaiting_approval";
  const isWarningCompletion =
    isNeedsUserAction ||
    terminalStatus === "partial_success" ||
    terminalStatus === "resume_available";
  const title =
    terminalStatus === "awaiting_approval"
      ? "Task waiting for approval"
      : terminalStatus === "resume_available"
        ? "Task paused - resume available"
        : isNeedsUserAction
          ? "Task complete - action required"
          : isWarningCompletion
            ? "Task complete (warnings)"
            : "Task complete";
  const toastType: ToastNotification["type"] = isWarningCompletion ? "warning" : "success";

  if (hasTaskOutputs(outputSummary)) {
    const actions = actionDependencies
      ? createCompletionOutputToastActions(outputSummary.primaryOutputPath, actionDependencies)
      : undefined;
    return {
      type: toastType,
      title,
      message: buildCompletionOutputMessage(outputSummary),
      taskId,
      ...(actions && actions.length > 0 ? { actions } : {}),
    };
  }

  return {
    type: toastType,
    title,
    message: taskTitle || "Task finished successfully",
    taskId,
  };
}
