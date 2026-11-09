import { describe, expect, it } from "vitest";
import { createMatchTimeBudget, MatchTimeBudgetError } from "../../../utils/bounded-regex";
import {
  evaluateWorkflowComparison,
  evaluateWorkflowComparisonEach,
  resolveWorkflowInputs,
} from "../variables";

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

  it("a slow matches comparison finishes fast as no match, whichever side is crafted", () => {
    const crafted = `${"a".repeat(40)}!`;
    const started = performance.now();
    // Unguarded, each of these backtracks about 2^40 times.
    expect(evaluateWorkflowComparison(crafted, "matches", "(a+)+$")).toBe(false);
    expect(evaluateWorkflowComparison(crafted, "matches", "(a|a)*$")).toBe(false);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(evaluateWorkflowComparison("aaa", "matches", "(a+)+$")).toBe(true);
  });

  it("compares a list in one pass and stops at the run's match budget", () => {
    const crafted = `${"a".repeat(40)}!`;
    expect(
      evaluateWorkflowComparisonEach(["INV-1", crafted, "inv-22", null], "matches", "^inv-\\d+$"),
    ).toEqual([true, false, true, false]);
    expect(evaluateWorkflowComparisonEach(["aaa", crafted, "a"], "matches", "(a+)+$")).toEqual([
      true,
      false,
      true,
    ]);
    expect(evaluateWorkflowComparisonEach([3, 9], "gt", 5)).toEqual([false, true]);

    const budget = createMatchTimeBudget(100);
    expect(() =>
      evaluateWorkflowComparisonEach(
        Array.from({ length: 10 }, () => crafted),
        "matches",
        "(a+)+$",
        budget,
      ),
    ).toThrow(MatchTimeBudgetError);
    expect(() => evaluateWorkflowComparison("aaa", "matches", "a", budget)).toThrow(
      "took more than 100 ms in total",
    );
  });
});
