export function isTaskCreationAccepted(result: void | boolean): boolean {
  // Older embedding surfaces returned void. Only an explicit false means the
  // task was not accepted; this keeps those callers source-compatible while
  // making failed/cancelled desktop creates observable.
  return result !== false;
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
