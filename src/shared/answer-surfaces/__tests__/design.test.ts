import { describe, expect, it } from "vitest";
import { answerSurfaceToPlainText, summarizeSurfaceChanges } from "../blocks";
import { normalizeSurfaceIcon } from "../icons";
import { runLogicForTest } from "./logic-helpers";
import { ANSWER_SURFACE_EXAMPLES, ANSWER_SURFACE_PROMPT } from "../prompt";
import {
  buildSurfaceScope,
  formatChartNumber,
  formatSurfaceValue,
  lintAnswerSurface,
  resolveSurfaceNumber,
} from "../runtime";
import {
  initialSurfaceState,
  mergeSurfaceState,
  parseAnswerSurfaceSource,
  type AnswerSurfaceSpec,
} from "../schema";

function parse(source: unknown): AnswerSurfaceSpec {
  const result = parseAnswerSurfaceSource(
    typeof source === "string" ? source : JSON.stringify(source),
  );
  if (!result.ok) throw new Error(result.error);
  return result.spec;
}

describe("prompt examples", () => {
  for (const [name, example] of Object.entries(ANSWER_SURFACE_EXAMPLES)) {
    it(`${name} parses and every formula has a value at its defaults`, () => {
      const spec = parse(example);
      const outputs = runLogicForTest(spec, initialSurfaceState(spec));
      expect(lintAnswerSurface(spec, outputs.scope)).toEqual([]);
      expect(ANSWER_SURFACE_PROMPT).toContain(JSON.stringify(example));
    });
  }

  it("the savings calculator gives the right monthly amount, including at 0%", () => {
    const spec = parse(ANSWER_SURFACE_EXAMPLES.calculator);
    const hero = spec.root.type === "card" ? spec.root.children[0] : null;
    if (hero?.type !== "hero" || hero.value === undefined) throw new Error("expected a hero");
    const at = (state: Record<string, number>) =>
      formatSurfaceValue(hero.value!, buildSurfaceScope(spec, mergeSurfaceState(spec, state)));
    expect(at({ rate: 0 })).toBe("$833");
    // 50,000 over 60 months at 4% a year compounded monthly.
    expect(at({})).toBe("$754");
    expect(at({ start: 60000 })).toBe("$0");
  });
});

describe("design components", () => {
  it("drops unknown decorative values instead of rejecting the surface", () => {
    const spec = parse({
      type: "card",
      theme: "neon",
      style: "sparkly",
      icon: "unicorn-horn",
      children: [
        {
          type: "metrics",
          style: "loud",
          items: [{ label: "A", value: 1, tone: "magenta", icon: "Piggy Bank" }],
        },
      ],
    });
    expect(spec.root).toMatchObject({ type: "card", theme: undefined, style: undefined });
    expect(spec.root.type === "card" && spec.root.icon).toBeFalsy();
    const metrics = spec.root.type === "card" ? spec.root.children[0] : null;
    expect(metrics).toMatchObject({
      style: undefined,
      items: [{ tone: undefined, icon: "piggy-bank" }],
    });
  });

  it("keeps emoji icons and normalizes icon names", () => {
    expect(normalizeSurfaceIcon("🍕")).toBe("🍕");
    expect(normalizeSurfaceIcon("chart_line")).toBe("chart-line");
    expect(normalizeSurfaceIcon("not-an-icon")).toBeUndefined();
  });

  it("wraps a themed lone component in a themed stack", () => {
    const spec = parse({ type: "hero", theme: "sunset", title: "Total", value: 12 });
    expect(spec.root).toMatchObject({
      type: "stack",
      theme: "sunset",
      children: [{ type: "hero", title: "Total" }],
    });
  });

  it("walks tab panels for controls and formulas", () => {
    const spec = parse({
      type: "tabs",
      tabs: [
        {
          label: "Inputs",
          children: [{ type: "number", id: "price", label: "Price", default: 20 }],
        },
        {
          label: "Result",
          children: [{ type: "hero", title: "Total", value: { expr: "price * 2" } }],
        },
      ],
    });
    expect(initialSurfaceState(spec)).toEqual({ price: 20 });
    expect(answerSurfaceToPlainText(spec)).toContain("**Total: 40**");
    expect(
      parseAnswerSurfaceSource(
        JSON.stringify({
          type: "tabs",
          tabs: [
            { label: "A", children: [] },
            { label: "B", children: [{ type: "text", text: "{{missing}}" }] },
          ],
        }),
      ),
    ).toMatchObject({ ok: false, error: expect.stringContaining("missing") });
  });

  it("validates number inputs and keeps saved values only within range", () => {
    const bad = parseAnswerSurfaceSource(
      JSON.stringify({ type: "number", id: "goal", label: "Goal", default: 5, min: 10 }),
    );
    expect(bad).toMatchObject({ ok: false });
    const spec = parse({
      type: "number",
      id: "goal",
      label: "Goal",
      default: 50,
      min: 0,
      prefix: "$",
    });
    expect(mergeSurfaceState(spec, { goal: 75000 })).toEqual({ goal: 75000 });
    expect(mergeSurfaceState(spec, { goal: -1 })).toEqual({ goal: 50 });
    expect(summarizeSurfaceChanges(spec, { goal: 75000 })).toEqual(["Goal: $75,000"]);
  });

  it("gives progress, timeline, tags and metric deltas a text version", () => {
    const spec = parse({
      type: "stack",
      children: [
        { type: "progress", title: "Goals", items: [{ label: "Steps", value: 7200, max: 10000 }] },
        {
          type: "timeline",
          items: [{ time: "9:00", title: "Tram 28", status: "done" }, { title: "Lunch" }],
        },
        { type: "tags", items: ["Walkable", { label: "Hilly", tone: "orange" }] },
        { type: "metrics", items: [{ label: "Revenue", value: 120, delta: "+12%" }] },
      ],
    });
    const text = answerSurfaceToPlainText(spec);
    expect(text).toContain("- Steps: 7,200 of 10000");
    expect(text).toContain("- 9:00 — Tram 28 ✓");
    expect(text).toContain("Walkable · Hilly");
    expect(text).toContain("- Revenue: 120 (+12%)");
  });

  it("lints formulas that have no value at the defaults", () => {
    const spec = parse({
      type: "card",
      children: [
        { type: "slider", id: "rate", label: "Rate", min: 0, max: 10, default: 0 },
        {
          type: "hero",
          title: "Monthly",
          value: { expr: "1000 * rate / (pow(1 + rate, 12) - 1)" },
        },
      ],
    });
    expect(lintAnswerSurface(spec)).toHaveLength(1);
  });
});

describe("number formatting", () => {
  it("formats chart axes compactly with prefixes", () => {
    expect(formatChartNumber(80000, { prefix: "$" })).toBe("$80K");
    expect(formatChartNumber(1250, { prefix: "$" })).toBe("$1,250");
    expect(formatChartNumber(12.5, { format: "percent" })).toBe("12.5%");
    expect(formatChartNumber(3, { unit: "kg" })).toBe("3 kg");
  });

  it("resolves values to numbers with a formatter for animation", () => {
    const resolved = resolveSurfaceNumber({ expr: "2 * 3", prefix: "$", decimals: 2 }, {});
    expect(resolved?.number).toBe(6);
    expect(resolved?.format(4.5)).toBe("$4.50");
    expect(resolveSurfaceNumber("{{1}} items", {})).toBeNull();
  });
});
