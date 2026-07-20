import { describe, expect, it } from "vitest";
import type {
  RoutineWorkflowDefinition,
  WorkflowOperationDefinition,
} from "../../../shared/routine-workflow";
import { appendWorkflowOperation } from "../AutomationStudioPanel";

describe("Automation Studio conditional authoring", () => {
  it("connects a new action to the selected false branch", () => {
    const workflow: RoutineWorkflowDefinition = {
      version: 1,
      starterNodeId: "starter",
      nodes: [
        { id: "starter", kind: "starter", operation: "starter.manual", name: "Manual", config: {} },
        {
          id: "condition",
          kind: "condition",
          operation: "control.condition",
          name: "Check",
          config: { left: "yes", operator: "equals", right: "yes" },
        },
      ],
      edges: [{ id: "starter:condition", sourceNodeId: "starter", targetNodeId: "condition" }],
    };
    const operation: WorkflowOperationDefinition = {
      id: "ai.summarize",
      kind: "ai",
      category: "AI",
      provider: "CoWork",
      name: "Summarize",
      description: "Summarize input",
      risk: "read",
      fields: [],
      outputFields: ["text"],
      requiredScopes: [],
    };

    const result = appendWorkflowOperation(
      workflow,
      operation,
      { sourceNodeId: "condition", sourcePort: "false" },
      "false-action",
    );

    expect(result.workflow.edges.at(-1)).toMatchObject({
      sourceNodeId: "condition",
      targetNodeId: "false-action",
      sourcePort: "false",
    });
  });
});
