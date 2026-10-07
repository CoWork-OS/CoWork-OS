import { describe, expect, it } from "vitest";
import {
  initialSurfaceState,
  mergeSurfaceState,
  parseAnswerSurfaceSource,
  type AnswerSurfaceSpec,
} from "../schema";
import { buildSurfaceScope, formatSurfaceValue } from "../runtime";

const ROAST = JSON.stringify({
  type: "card",
  title: "How much should you buy?",
  computed: { lamb: "max(1.5, people * 0.4)" },
  children: [
    {
      type: "stepper",
      id: "people",
      label: "Number of people",
      min: 2,
      max: 16,
      default: 5,
      unit: "people",
    },
    {
      type: "values",
      title: "Your shopping quantities",
      items: [
        { label: "Bone-in leg of lamb", value: { expr: "lamb", decimals: 1, unit: "kg" } },
        { label: "Potatoes", value: { expr: "people * 300", unit: "g" } },
        { label: "Carrots", value: { expr: "ceil(people * 1.5)" } },
        { label: "Serves", value: "{{people}} people" },
      ],
    },
    {
      type: "checklist",
      id: "steps",
      items: ["Take lamb out of the fridge", { text: "Roast", time: "2:00 pm" }],
    },
  ],
});

function parse(source: string): AnswerSurfaceSpec {
  const result = parseAnswerSurfaceSource(source);
  if (!result.ok) throw new Error(result.error);
  return result.spec;
}

describe("parseAnswerSurfaceSource", () => {
  it("accepts a valid surface and normalizes checklist items", () => {
    const spec = parse(ROAST);
    expect(spec.version).toBe(1);
    const checklist = spec.root.type === "card" ? spec.root.children[2] : null;
    expect(checklist).toMatchObject({
      type: "checklist",
      items: [
        { id: "item_1", text: "Take lamb out of the fridge" },
        { id: "item_2", text: "Roast", time: "2:00 pm" },
      ],
    });
  });

  it("computes values from control state", () => {
    const spec = parse(ROAST);
    const scope = buildSurfaceScope(spec, { ...initialSurfaceState(spec), people: 8 });
    const values =
      spec.root.type === "card" && spec.root.children[1].type === "values"
        ? spec.root.children[1].items
        : [];
    expect(values.map((item) => formatSurfaceValue(item.value, scope))).toEqual([
      "3.2 kg",
      "2,400 g",
      "12",
      "8 people",
    ]);
  });

  it("tolerates trailing commas, comments and a top-level array", () => {
    const result = parseAnswerSurfaceSource(`[
      // intro
      {"type": "text", "text": "Hello",},
    ]`);
    expect(result).toMatchObject({ ok: true, spec: { root: { type: "stack" } } });
  });

  it("turns a string image into a query", () => {
    const spec = parse('{"type":"gallery","images":["roast potatoes in a tray"]}');
    expect(spec.root).toMatchObject({
      type: "gallery",
      images: [{ query: "roast potatoes in a tray", alt: "roast potatoes in a tray" }],
    });
  });

  it.each([
    ['{"type":"script","code":"alert(1)"}', "type"],
    ['{"type":"image","image":{"src":"http://example.com/a.png"}}', "https"],
    ['{"type":"values","items":[{"label":"x","value":{"expr":"missing * 2"}}]}', "unknown value"],
    [
      '{"type":"stack","children":[{"type":"toggle","id":"a","label":"A","default":true},{"type":"toggle","id":"a","label":"B","default":false}]}',
      "Duplicate",
    ],
    ['{"type":"slider","id":"x","label":"X","min":10,"max":1,"default":5}', "min below max"],
    [
      '{"type":"select","id":"x","label":"X","options":[{"label":"A","value":"a"}],"default":"b"}',
      "default",
    ],
    ['{"v":2,"type":"divider"}', "newer version"],
    ["not json", "JSON"],
  ])("rejects %s", (source, message) => {
    const result = parseAnswerSurfaceSource(source);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain(message);
  });

  it("rejects surfaces that are too deep", () => {
    let node: Record<string, unknown> = { type: "divider" };
    for (let depth = 0; depth < 7; depth += 1) node = { type: "stack", children: [node] };
    const result = parseAnswerSurfaceSource(JSON.stringify(node));
    expect(result).toMatchObject({ ok: false, error: "Components are nested too deeply" });
  });
});

describe("mergeSurfaceState", () => {
  it("keeps saved values that still fit and drops the rest", () => {
    const spec = parse(ROAST);
    expect(mergeSurfaceState(spec, { people: 9, steps: ["item_2", "gone"], removed: 3 })).toEqual({
      people: 9,
      steps: ["item_2"],
    });
    expect(mergeSurfaceState(spec, { people: 99 })).toEqual({ people: 5, steps: [] });
  });
});
