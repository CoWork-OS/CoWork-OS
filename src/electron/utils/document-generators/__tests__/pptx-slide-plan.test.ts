import { describe, expect, it } from "vitest";
import { expectedSlideText, planPresentationSlides } from "../pptx-slide-plan";

describe("planPresentationSlides", () => {
  it("keeps explicit slide types, including runs of the same type", () => {
    const plan = planPresentationSlides([
      { title: "Deck", slideType: "cover" },
      { title: "One", slideType: "content", bullets: ["a"] },
      { title: "Two", slideType: "content", bullets: ["b"] },
      { title: "Three", slideType: "content", bullets: ["c"] },
      { title: "T1", slideType: "table", data: { rows: [["x"]] } },
      { title: "T2", slideType: "table", data: { rows: [["y"]] } },
      { title: "T3", slideType: "table", data: { rows: [["z"]] } },
    ]);

    expect(plan.slides.map((slide) => slide.type)).toEqual([
      "cover",
      "content",
      "content",
      "content",
      "table",
      "table",
      "table",
    ]);
    expect(plan.warnings).toEqual([]);
  });

  it("lays out untyped text slides as content instead of rotating them into other layouts", () => {
    const plan = planPresentationSlides([
      { title: "Deck" },
      ...Array.from({ length: 8 }, (_, index) => ({
        title: `Topic ${index + 1}`,
        bullets: [`Point ${index + 1}: closed 3 deals`, "Second point"],
      })),
    ]);

    expect(plan.slides.map((slide) => slide.type)).toEqual(["cover", ...Array(8).fill("content")]);
    expect(plan.slides.slice(1).every((slide) => slide.metrics.length === 0)).toBe(true);
  });

  it("does not invent chart values when a chart has no series data", () => {
    const plan = planPresentationSlides([
      { title: "Deck" },
      { title: "Growth", slideType: "chart", data: { categories: ["Q1", "Q2", "Q3"] } },
    ]);

    const [, growth] = plan.slides;
    expect(growth.type).toBe("content");
    expect(growth.chart).toBeUndefined();
    expect(growth.bullets).toEqual(["Q1", "Q2", "Q3"]);
    expect(plan.warnings.join("\n")).toMatch(/Slide 2 "Growth": the chart has no numeric series/);
  });

  it("shows gaps in chart data as gaps, never as made-up values", () => {
    const plan = planPresentationSlides([
      { title: "Deck" },
      {
        title: "Sales",
        slideType: "chart",
        data: { categories: ["A", "B", "C"], series: [{ name: "2025", values: [4, "n/a"] }] },
      },
    ]);

    expect(plan.slides[1].chart?.series[0].values).toEqual([4, null, null]);
    expect(plan.warnings.join("\n")).toMatch(/2 value\(s\) are missing or not numeric/);
  });

  it("only draws KPI numbers that the slide actually states", () => {
    const plan = planPresentationSlides([
      { title: "Deck" },
      {
        title: "Words",
        slideType: "metric",
        bullets: ["Customers are happier", "Shipping is faster"],
      },
      {
        title: "Numbers",
        slideType: "metric",
        bullets: ["Faster onboarding", "42% churn reduction"],
      },
    ]);

    expect(plan.slides[1].type).toBe("content");
    expect(plan.slides[1].bullets).toEqual(["Customers are happier", "Shipping is faster"]);
    expect(plan.warnings.join("\n")).toMatch(
      /Slide 2 "Words": the metric slide has no numeric values/,
    );
    expect(plan.slides[2].type).toBe("metric");
    expect(plan.slides[2].metrics).toEqual([
      { value: "42%", label: "churn reduction", detail: "" },
      { value: "", label: "Faster onboarding", detail: "" },
    ]);
  });

  it("continues overflowing lists and tables on extra slides instead of truncating", () => {
    const bullets = Array.from({ length: 12 }, (_, index) => `Item ${index + 1}`);
    const rows = Array.from({ length: 13 }, (_, index) => [`Row ${index + 1}`, index]);
    const steps = Array.from({ length: 7 }, (_, index) => `Step ${index + 1}`);
    const plan = planPresentationSlides([
      { title: "Deck" },
      { title: "List", bullets },
      { title: "Data", slideType: "table", data: { headers: ["Name", "Value"], rows } },
      { title: "Flow", slideType: "process", bullets: steps },
    ]);

    const list = plan.slides.filter((slide) => slide.source === 2);
    expect(list.map((slide) => slide.title)).toEqual(["List", "List (cont.)"]);
    expect(list.flatMap((slide) => slide.bullets)).toEqual(bullets);

    const tables = plan.slides.filter((slide) => slide.source === 3);
    expect(tables.every((slide) => slide.table!.rows.length <= 6)).toBe(true);
    expect(tables.every((slide) => slide.table!.headers.join() === "Name,Value")).toBe(true);
    expect(tables.flatMap((slide) => slide.table!.rows)).toEqual(
      rows.map(([name, value]) => [name, String(value)]),
    );

    const flow = plan.slides.filter((slide) => slide.source === 4);
    expect(flow.map((slide) => slide.offset)).toEqual([0, flow[0].bullets.length]);
    expect(flow.flatMap((slide) => slide.bullets)).toEqual(steps);
    expect(plan.warnings.join("\n")).toMatch(/Slide 2 "List" needed 2 slides/);
  });

  it("moves content a layout cannot show onto a continuation slide", () => {
    const plan = planPresentationSlides([
      { title: "Launch", subtitle: "Q3", bullets: ["Kickoff agenda", "Owners"] },
      {
        title: "Voice",
        slideType: "quote",
        quote: "It just works.",
        bullets: ["Survey of 40 teams"],
      },
    ]);

    expect(plan.slides.map((slide) => [slide.type, slide.title])).toEqual([
      ["cover", "Launch"],
      ["content", "Launch (cont.)"],
      ["quote", "Voice"],
      ["content", "Voice (cont.)"],
    ]);
    expect(plan.slides[1].bullets).toEqual(["Kickoff agenda", "Owners"]);
    expect(plan.slides[3].bullets).toEqual(["Survey of 40 teams"]);
  });

  it("does not add placeholder headers, labels, or attributions", () => {
    const plan = planPresentationSlides([
      { title: "Deck" },
      { title: "Plain table", slideType: "table", data: { rows: [["a", "b", "c", "d"]] } },
      { title: "Sides", slideType: "comparison", bullets: ["left", "right"] },
      { title: "Said", slideType: "quote", quote: "Ship it." },
    ]);

    expect(plan.slides[1].table).toEqual({ headers: [], rows: [["a", "b", "c", "d"]] });
    expect(plan.slides[2].columns).toEqual([
      { title: "", items: ["left"] },
      { title: "", items: ["right"] },
    ]);
    expect(plan.slides[3].attribution).toBe("");
  });

  it("lists every planned text for verification", () => {
    const plan = planPresentationSlides([
      { title: "Deck" },
      {
        title: "Mix",
        slideType: "chart",
        data: { categories: ["A"], series: [{ name: "S", values: [0] }] },
      },
    ]);

    expect(expectedSlideText(plan.slides[1])).toEqual(["Mix", "A", "S", "0"]);
  });
});
