import { describe, expect, it } from "vitest";
import type {
  RoutineWorkflowDefinition,
  WorkflowCapabilities,
  WorkflowOperationDefinition,
} from "../../../shared/routine-workflow";
import { buildVariableOptions } from "../AutomationStudioPanel";

const operation = (id: string, name: string): WorkflowOperationDefinition => ({
  id,
  kind: "ai",
  category: "AI",
  provider: "CoWork",
  name,
  description: name,
  risk: "read",
  fields: [],
  outputFields: ["text"],
  requiredScopes: [],
});

const capabilities = {
  operations: [operation("ai.summarize", "Summarize"), operation("ai.extract", "Extract")],
} as unknown as WorkflowCapabilities;

// starter → summarize → extract, and starter → side (a parallel branch).
const workflow: RoutineWorkflowDefinition = {
  version: 1,
  starterNodeId: "starter",
  nodes: [
    { id: "starter", kind: "starter", operation: "starter.manual", name: "Manual", config: {} },
    { id: "3f9c-summarize", kind: "ai", operation: "ai.summarize", name: "Summarize", config: {} },
    { id: "8a1d-extract", kind: "ai", operation: "ai.extract", name: "Extract", config: {} },
    { id: "77be-side", kind: "ai", operation: "ai.extract", name: "", config: {} },
  ],
  edges: [
    { id: "e1", sourceNodeId: "starter", targetNodeId: "3f9c-summarize" },
    { id: "e2", sourceNodeId: "3f9c-summarize", targetNodeId: "8a1d-extract" },
    { id: "e3", sourceNodeId: "starter", targetNodeId: "77be-side" },
  ],
};

describe("Automation Studio variables", () => {
  it("does not offer a step its own outputs", () => {
    expect(buildVariableOptions(workflow, capabilities, "3f9c-summarize")).toEqual([
      { path: "trigger.timestamp", label: "trigger.timestamp" },
      { path: "trigger.source", label: "trigger.source" },
    ]);
  });

  it("offers earlier steps by name and leaves out parallel ones", () => {
    expect(buildVariableOptions(workflow, capabilities, "8a1d-extract")).toEqual([
      { path: "trigger.timestamp", label: "trigger.timestamp" },
      { path: "trigger.source", label: "trigger.source" },
      { path: "3f9c-summarize.text", label: "Summarize.text" },
    ]);
  });

  it("falls back to the action name for an unnamed step", () => {
    const joined: RoutineWorkflowDefinition = {
      ...workflow,
      edges: [
        ...workflow.edges,
        { id: "e4", sourceNodeId: "77be-side", targetNodeId: "8a1d-extract" },
      ],
    };
    expect(
      buildVariableOptions(joined, capabilities, "8a1d-extract").map((option) => option.label),
    ).toEqual(["trigger.timestamp", "trigger.source", "Summarize.text", "Extract.text"]);
  });
});
