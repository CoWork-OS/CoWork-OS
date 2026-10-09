import { describe, expect, it } from "vitest";
import { answerSurfaceToPlainText } from "../blocks";
import { LOGIC_RUNNER_HTML, readLogicOutputs, readLogicResultJson } from "../logic";
import { ANSWER_SURFACE_EXAMPLES } from "../prompt";
import { buildSurfaceScope, formatSurfaceValue, resolveSurfaceRows } from "../runtime";
import { initialSurfaceState, mergeSurfaceState, parseAnswerSurfaceSource } from "../schema";
import { runLogicForTest } from "./logic-helpers";

const parse = (value: unknown) => {
  const result = parseAnswerSurfaceSource(JSON.stringify(value));
  if (!result.ok) throw new Error(result.error);
  return result.spec;
};

describe("surface logic contract", () => {
  it("lets formulas read declared outputs and rejects undeclared binds", () => {
    const spec = parse({
      type: "stack",
      logic: { outputs: ["total", "rows"], code: "function compute(s) { return {}; }" },
      children: [
        { type: "hero", title: "Total", value: { expr: "total * 2" } },
        { type: "table", columns: ["A"], rows: { bind: "rows" } },
      ],
    });
    expect(spec.logic?.outputs).toEqual(["total", "rows"]);
    const unknownBind = parseAnswerSurfaceSource(
      JSON.stringify({
        type: "chart",
        kind: "line",
        labels: { bind: "years" },
        series: [{ name: "A", values: [1] }],
      }),
    );
    expect(unknownBind).toMatchObject({ ok: false, error: expect.stringContaining("years") });
    const badLogic = parseAnswerSurfaceSource(
      JSON.stringify({ type: "text", text: "x", logic: { outputs: ["bad name"], code: "x" } }),
    );
    expect(badLogic).toMatchObject({ ok: false, error: expect.stringContaining("logic") });
  });

  it("rejects reserved output names and shows bound strings literally", () => {
    for (const name of ["__proto__", "constructor", "toString"]) {
      const result = parseAnswerSurfaceSource(
        JSON.stringify({ type: "text", text: "x", logic: { outputs: [name], code: "x" } }),
      );
      expect(result, name).toMatchObject({ ok: false });
    }
    const outputs = readLogicResultJson('{"rows":[["{{1+1}}", 2]]}', ["rows"]);
    const rows = resolveSurfaceRows({ bind: "rows" }, outputs.data);
    expect(rows.map((row) => row.map((cell) => formatSurfaceValue(cell, {})))).toEqual([
      ["{{1+1}}", "2"],
    ]);
    expect(readLogicResultJson("not json", ["rows"]).data).toEqual({});
  });

  it("keeps only declared, well-formed outputs", () => {
    const outputs = readLogicOutputs(
      {
        total: 12,
        label: "ok",
        years: ["1", "2"],
        rows: [["Year 1", 5, null]],
        nan: Number.NaN,
        nested: { a: 1 },
        secret: "not declared",
        long: Array.from({ length: 501 }, () => 1),
      },
      ["total", "label", "years", "rows", "nan", "nested", "long"],
    );
    expect(outputs.scope).toEqual({ total: 12, label: "ok" });
    expect(outputs.data).toEqual({ years: ["1", "2"], rows: [["Year 1", 5, null]] });
  });

  it("computes the mortgage example correctly", () => {
    const spec = parse(ANSWER_SURFACE_EXAMPLES.mortgage);
    const state = mergeSurfaceState(spec, { principal: 300000, rate: 5.5, years: 25 });
    const outputs = runLogicForTest(spec, state);
    const scope = buildSurfaceScope(spec, state, outputs.scope);
    // Standard annuity: 300,000 over 300 months at 5.5% a year.
    expect(formatSurfaceValue({ expr: "payment", decimals: 2, prefix: "$" }, scope)).toBe(
      "$1,842.26",
    );
    expect(outputs.data.balances).toHaveLength(26);
    expect((outputs.data.balances as number[]).at(-1)).toBe(0);
    const table = spec.root.type === "card" ? spec.root.children.at(-1) : null;
    if (table?.type !== "table") throw new Error("expected a table");
    expect(
      resolveSurfaceRows(table.rows, outputs.data).map((row) => formatSurfaceValue(row[0], {})),
    ).toEqual(["Year 5", "Year 10", "Year 15", "Year 20", "Year 25"]);
    const zeroRate = runLogicForTest(spec, { ...initialSurfaceState(spec), rate: 0 });
    expect(zeroRate.scope.payment).toBe(1000);
  });

  it("leaves bound data out of the plain-text fallback", () => {
    const text = answerSurfaceToPlainText(parse(ANSWER_SURFACE_EXAMPLES.mortgage));
    expect(text).toContain("Your repayment plan");
    expect(text).not.toContain("| Year |");
  });

  it("ships a runner page whose script compiles", () => {
    const script = LOGIC_RUNNER_HTML.match(/<script>([\s\S]*)<\/script>/)?.[1] ?? "";
    expect(script.length).toBeGreaterThan(500);
    expect(() => new Function(script)).not.toThrow();
  });
});
