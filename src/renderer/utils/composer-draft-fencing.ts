export function isTaskCreationAccepted(result: void | boolean): boolean {
  // Older embedding surfaces returned void. Only an explicit false means the
  // task was not accepted; this keeps those callers source-compatible while
  // making failed/cancelled desktop creates observable.
  return result !== false;
}

/** Clear the accepted owner even when navigation has already replaced the editor. */
export async function clearAcceptedComposerDraft(options: {
  isCurrentSubmission: () => boolean;
  clearVisible: () => void;
  clearPersisted: () => void | boolean | Promise<void | boolean>;
  restoreVisible: () => void;
}): Promise<boolean> {
  const clearedVisible = options.isCurrentSubmission();
  if (clearedVisible) options.clearVisible();
  try {
    const accepted = await options.clearPersisted();
    if (accepted !== false) return true;
  } catch {
    // Keep a failed durable clear recoverable in the editor that submitted it.
  }
  if (clearedVisible) options.restoreVisible();
  return false;
}

export function isSameComposerDraftSubmission(input: {
  submittedDraftKey?: string;
  currentDraftKey?: string;
  submittedRevision: number;
  currentRevision: number;
  submittedText: string;
  currentText: string;
}): boolean {
  return (
    input.submittedDraftKey === input.currentDraftKey &&
    input.submittedRevision === input.currentRevision &&
    input.submittedText === input.currentText
  );
}

export function isSameAcceptedComposerDraftFence(input: {
  fenceDraftKey?: string;
  currentDraftKey?: string;
  fenceTaskId?: string;
  currentTaskId?: string;
  fenceRevision: number;
  currentRevision: number;
}): boolean {
  return (
    input.fenceDraftKey === input.currentDraftKey &&
    input.fenceTaskId === input.currentTaskId &&
    input.fenceRevision === input.currentRevision
  );
}

export function clearAcceptedComposerDraftFence<
  T extends { draftKey?: string; taskId?: string; revision: number },
>(
  current: T | null,
  submitted: { draftKey?: string; taskId?: string; revision: number },
): T | null {
  if (!current) return null;
  return isSameAcceptedComposerDraftFence({
    fenceDraftKey: current.draftKey,
    currentDraftKey: submitted.draftKey,
    fenceTaskId: current.taskId,
    currentTaskId: submitted.taskId,
    fenceRevision: current.revision,
    currentRevision: submitted.revision,
  })
    ? null
    : current;
}
