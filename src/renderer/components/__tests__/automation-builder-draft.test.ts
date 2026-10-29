import { describe, expect, it } from "vitest";
import type { RoutineWorkflowDefinition } from "../../../shared/routine-workflow";
import {
  builderFlowSignature,
  keepUnsavedBuilderDraft,
  takeUnsavedBuilderDraft,
} from "../automation-builder-draft";

const workflow = {
  nodes: [],
  edges: [],
  starterNodeId: "start",
} as unknown as RoutineWorkflowDefinition;

describe("unsaved Builder draft", () => {
  it("hands a kept flow back once", () => {
    const flow = {
      workflow,
      routineName: "Unsaved flow",
      routineDescription: "",
      selectedWorkspaceId: "ws-1",
      selectedRoutineId: null,
      selectedNodeId: "start",
      baseline: "before",
    };
    keepUnsavedBuilderDraft(flow);
    expect(takeUnsavedBuilderDraft()).toEqual(flow);
    expect(takeUnsavedBuilderDraft()).toBeNull();
  });

  it("treats a renamed flow as changed", () => {
    const base = {
      workflow,
      routineName: "Untitled flow",
      routineDescription: "",
      selectedWorkspaceId: "ws-1",
    };
    expect(builderFlowSignature(base)).toBe(builderFlowSignature({ ...base }));
    expect(builderFlowSignature({ ...base, routineName: "Weekly digest" })).not.toBe(
      builderFlowSignature(base),
    );
  });
});
