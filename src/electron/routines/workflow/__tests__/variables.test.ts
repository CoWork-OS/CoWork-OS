import { describe, expect, it } from "vitest";
import { evaluateWorkflowComparison, resolveWorkflowInputs } from "../variables";

const context = {
  trigger: { subject: "Invoice 784", customer: { name: "Northwind Harbor" } },
  nodes: { summary: { text: "Review the invoice", items: ["review", "reply"] } },
  item: { score: 7 },
  index: 2,
};

describe("workflow variables", () => {
  it("resolves references, nested arrays, and templates", () => {
    const result = resolveWorkflowInputs(
      {
        subject: { $ref: "trigger.subject" },
        body: { $template: "{{trigger.customer.name}}: {{summary.text}}" },
        list: [{ $ref: "summary.items.0" }, { $ref: "index" }],
      },
      context,
    );

    expect(result).toEqual({
      subject: "Invoice 784",
      body: "Northwind Harbor: Review the invoice",
      list: ["review", 2],
    });
  });

  it("uses reference defaults for missing paths", () => {
    const result = resolveWorkflowInputs(
      { owner: { $ref: "trigger.owner", default: "Unassigned" } },
      context,
    );

    expect(result.owner).toBe("Unassigned");
  });

  it("evaluates list, numeric, empty, and regex comparisons", () => {
    expect(evaluateWorkflowComparison(["alpha", "beta"], "contains", "beta")).toBe(true);
    expect(evaluateWorkflowComparison(8, "gt", 7)).toBe(true);
    expect(evaluateWorkflowComparison([], "is_empty")).toBe(true);
    expect(evaluateWorkflowComparison("INV-784", "matches", "^inv-\\d+$")).toBe(true);
  });
});
