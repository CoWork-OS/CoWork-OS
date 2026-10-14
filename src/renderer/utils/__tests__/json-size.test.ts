import { describe, expect, it } from "vitest";
import { estimateJsonBytes } from "../json-size";

const exact = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).byteLength;

describe("estimateJsonBytes", () => {
  it("matches the UTF-8 size of JSON.stringify", () => {
    const values: unknown[] = [
      null,
      true,
      false,
      0,
      -12.5,
      1e21,
      Number.NaN,
      "",
      "plain ascii",
      'quotes " and \\ backslashes',
      "line\nbreak\ttab\rreturn\u0001\u001f",
      "Türkçe, Кириллица, 中文, emoji 🚀👩‍💻",
      "lone \ud800 surrogate \udc00",
      [],
      [1, "two", null, undefined, () => 1, { three: 3 }],
      { a: 1, skipped: undefined, fn: () => 1, nested: { list: [1, 2, { deep: "ü" }] } },
      { when: new Date(0), message: "x".repeat(5000) },
    ];
    for (const value of values) {
      expect(estimateJsonBytes(value)).toBe(exact(value));
    }
  });

  it("measures shared objects once and reuses the result", () => {
    const payload = { message: "shared payload ".repeat(100) };
    const events = Array.from({ length: 50 }, (_, index) => ({ id: `e${index}`, payload }));
    expect(estimateJsonBytes(events)).toBe(exact(events));
    const grown = [...events, { id: "e50", payload: { message: "new" } }];
    expect(estimateJsonBytes(grown)).toBe(exact(grown));
  });

  it("reports cyclic values as Infinity, which JSON.stringify rejects", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    expect(estimateJsonBytes(cyclic)).toBe(Number.POSITIVE_INFINITY);
    expect(estimateJsonBytes({ value: 1n })).toBe(Number.POSITIVE_INFINITY);
  });
});
