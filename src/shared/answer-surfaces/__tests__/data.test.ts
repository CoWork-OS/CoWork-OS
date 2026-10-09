import { describe, expect, it } from "vitest";
import { AnswerSurfaceDataSchema, describeAnswerData, hasHiddenSegment } from "../data";
import { ANSWER_SURFACE_EXAMPLES } from "../prompt";
import { buildSurfaceScope, formatSurfaceValue, resolveSurfaceLabels } from "../runtime";
import { initialSurfaceState, parseAnswerSurfaceSource } from "../schema";
import { SAMPLE_SALES, runLogicForTest } from "./logic-helpers";

describe("answer data sources", () => {
  it("accepts workspace data files and refuses anything else", () => {
    expect(AnswerSurfaceDataSchema.safeParse({ sales: "uploads/sales.csv" }).success).toBe(true);
    for (const bad of [
      { sales: "https://example.com/sales.csv" },
      { sales: "file:///etc/passwd.csv" },
      { sales: ".cowork/policy/rules.json" },
      { sales: "data/.secret/keys.csv" },
      { sales: "notes.txt" },
      { sales: "/Users/me/sales.csv" },
      { sales: "../other/sales.csv" },
      { sales: "C:\\data\\sales.csv" },
      { "bad id": "a.csv" },
      { a: "a.csv", b: "b.csv", c: "c.csv", d: "d.csv", e: "e.csv" },
      {},
    ]) {
      expect(AnswerSurfaceDataSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
    expect(AnswerSurfaceDataSchema.safeParse({ hits: { tool: "r3f9a2c41" } }).success).toBe(true);
    expect(AnswerSurfaceDataSchema.safeParse({ hits: { tool: "../x" } }).success).toBe(false);
    expect(
      AnswerSurfaceDataSchema.safeParse({ hits: { tool: "r3f9a2c41", path: "x" } }).success,
    ).toBe(false);
    expect(hasHiddenSegment("a/.git/x.csv")).toBe(true);
    expect(hasHiddenSegment("../reports/x.csv")).toBe(false);
  });

  it("needs logic to compute from the data", () => {
    const result = parseAnswerSurfaceSource(
      JSON.stringify({ type: "text", text: "x", data: { sales: "uploads/sales.csv" } }),
    );
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining("logic") });
  });

  it("describes where the numbers come from, including cut files", () => {
    expect(describeAnswerData(SAMPLE_SALES)).toBe("uploads/sales.csv (5 rows)");
    expect(describeAnswerData({ ...SAMPLE_SALES, totalRows: 52113, truncated: true })).toBe(
      "uploads/sales.csv (first 5 of 52,113 rows)",
    );
  });

  it("computes the sales example from the rows, skipping blanks", () => {
    const result = parseAnswerSurfaceSource(JSON.stringify(ANSWER_SURFACE_EXAMPLES.sales));
    if (!result.ok) throw new Error(result.error);
    const spec = result.spec;
    expect(spec.data).toEqual({ sales: "uploads/sales.csv" });
    const outputs = runLogicForTest(spec, initialSurfaceState(spec), { sales: SAMPLE_SALES });
    const scope = buildSurfaceScope(spec, initialSurfaceState(spec), outputs.scope);
    expect(formatSurfaceValue({ expr: "total", decimals: 0, prefix: "$" }, scope)).toBe("$436");
    expect(outputs.scope.top).toBe("North");
    expect(resolveSurfaceLabels({ bind: "regions" }, outputs.data)).toEqual([
      "North",
      "South",
      "West",
    ]);
    expect(outputs.data.revenue).toEqual([215.5, 80, 140]);
  });
});
