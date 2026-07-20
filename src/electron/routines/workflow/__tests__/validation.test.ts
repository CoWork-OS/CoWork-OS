import { describe, expect, it } from "vitest";
import type { RoutineWorkflowDefinition } from "../../../../shared/routine-workflow";
import { validateRoutineWorkflow } from "../validation";

function workflow(overrides: Partial<RoutineWorkflowDefinition> = {}): RoutineWorkflowDefinition {
  return {
    version: 1,
    starterNodeId: "starter",
    nodes: [
      { id: "starter", kind: "starter", operation: "starter.manual", name: "Manual", config: {} },
      {
        id: "sheet",
        kind: "action",
        operation: "sheets.add_row",
        name: "Add row",
        config: { spreadsheetId: "sheet-1", range: "Sheet1!A1", values: ["one"] },
      },
    ],
    edges: [
      {
        id: "starter:sheet",
        sourceNodeId: "starter",
        targetNodeId: "sheet",
        sourcePort: "success",
      },
    ],
    ...overrides,
  };
}

describe("validateRoutineWorkflow", () => {
  it("accepts a connected workflow and reports scopes and risk", () => {
    const result = validateRoutineWorkflow(workflow());

    expect(result.valid).toBe(true);
    expect(result.requiredScopes).toContain("https://www.googleapis.com/auth/spreadsheets");
    expect(result.riskLevels).toContain("external_write");
  });

  it("rejects multiple starters", () => {
    const definition = workflow();
    definition.nodes.push({
      id: "other",
      kind: "starter",
      operation: "starter.manual",
      name: "Other",
      config: {},
    });

    const result = validateRoutineWorkflow(definition);

    expect(
      result.issues.some((issue) => issue.code === "starter_count" && issue.severity === "error"),
    ).toBe(true);
  });

  it("rejects graph cycles", () => {
    const definition = workflow();
    definition.edges.push({ id: "sheet:starter", sourceNodeId: "sheet", targetNodeId: "starter" });

    const result = validateRoutineWorkflow(definition);

    expect(result.issues.some((issue) => issue.code === "cycle")).toBe(true);
  });

  it("treats incomplete template fields as warnings in draft mode", () => {
    const definition = workflow();
    definition.nodes[1].config.spreadsheetId = "";

    const draft = validateRoutineWorkflow(definition, { allowIncomplete: true });
    const active = validateRoutineWorkflow(definition);

    expect(draft.valid).toBe(true);
    expect(active.valid).toBe(false);
  });

  it("rejects unsafe signed webhook configuration", () => {
    const definition = workflow({
      nodes: [
        { id: "starter", kind: "starter", operation: "starter.manual", name: "Manual", config: {} },
        {
          id: "webhook",
          kind: "custom",
          operation: "custom.webhook",
          name: "Webhook",
          config: {
            url: "http://user:pass@example.com/hook",
            method: "POST",
            secretRef: { $ref: "trigger.secret" },
          },
        },
      ],
      edges: [{ id: "starter:webhook", sourceNodeId: "starter", targetNodeId: "webhook" }],
    });

    const result = validateRoutineWorkflow(definition);

    expect(result.issues.some((issue) => issue.code === "invalid_webhook_url")).toBe(true);
    expect(result.issues.some((issue) => issue.code === "variables_not_allowed")).toBe(true);
  });

  it("allows preview operations in drafts but blocks activation", () => {
    const definition = workflow({
      nodes: [
        { id: "starter", kind: "starter", operation: "starter.manual", name: "Manual", config: {} },
        {
          id: "notebook",
          kind: "ai",
          operation: "notebooklm.ask",
          name: "Ask NotebookLM",
          config: { notebookId: "notebook-1", question: "What changed?" },
        },
      ],
      edges: [{ id: "starter:notebook", sourceNodeId: "starter", targetNodeId: "notebook" }],
    });

    expect(validateRoutineWorkflow(definition, { allowIncomplete: true }).valid).toBe(true);
    expect(validateRoutineWorkflow(definition).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "preview_operation", severity: "error" }),
      ]),
    );
  });

  it("rejects workflow limits above the runtime safety bounds", () => {
    const result = validateRoutineWorkflow(
      workflow({ settings: { maxStepCount: 10_000, maxForEachItems: 10_000 } }),
    );

    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "invalid_workflow_limit", severity: "error" }),
      ]),
    );
  });

  it("counts nested actions toward the configured step limit", () => {
    const definition = workflow({ settings: { maxStepCount: 2 } });
    definition.nodes[1].kind = "foreach";
    definition.nodes[1].operation = "control.foreach";
    definition.nodes[1].config = { items: [1] };
    definition.nodes[1].children = [
      {
        id: "child",
        kind: "ai",
        operation: "ai.summarize",
        name: "Child",
        config: { input: "value" },
      },
    ];

    const result = validateRoutineWorkflow(definition);

    expect(result.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: "step_limit", severity: "error" })]),
    );
  });
});
