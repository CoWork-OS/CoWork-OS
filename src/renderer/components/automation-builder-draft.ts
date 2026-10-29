import type { RoutineWorkflowDefinition } from "../../shared/routine-workflow";

/** The Builder flow the user was editing, kept while they visit other pages. */
export interface UnsavedBuilderDraft {
  workflow: RoutineWorkflowDefinition;
  routineName: string;
  routineDescription: string;
  selectedWorkspaceId: string;
  selectedRoutineId: string | null;
  selectedNodeId: string | null;
  /** Signature of the flow as last loaded or saved, so the restored flow stays unsaved. */
  baseline: string;
}

// Leaving Automations unmounts the Builder. Without this, an unsaved flow was dropped
// without a word. Memory only: it lasts until the app quits.
let keptDraft: UnsavedBuilderDraft | null = null;

export function keepUnsavedBuilderDraft(draft: UnsavedBuilderDraft): void {
  keptDraft = draft;
}

/** Returns the kept draft once and forgets it. */
export function takeUnsavedBuilderDraft(): UnsavedBuilderDraft | null {
  const draft = keptDraft;
  keptDraft = null;
  return draft;
}

/** What makes two Builder states the same flow for "has unsaved changes". */
export function builderFlowSignature(flow: {
  workflow: RoutineWorkflowDefinition;
  routineName: string;
  routineDescription: string;
  selectedWorkspaceId: string;
}): string {
  return JSON.stringify([
    flow.workflow,
    flow.routineName,
    flow.routineDescription,
    flow.selectedWorkspaceId,
  ]);
}
