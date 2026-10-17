import { describe, expect, it } from "vitest";
import { extractJsonValues, stableJsonStringify } from "../json-utils";

describe("stableJsonStringify", () => {
  it("always returns a string for values JSON cannot represent", () => {
    expect(stableJsonStringify(undefined)).toBe("null");
    expect(stableJsonStringify(() => 1)).toBe("null");
    expect(stableJsonStringify(Symbol("s"))).toBe("null");
  });

  it("keeps ordinary values JSON-shaped", () => {
    expect(stableJsonStringify({ a: 1, b: "x" })).toBe('{"a":1,"b":"x"}');
    expect(stableJsonStringify(null)).toBe("null");
    expect(stableJsonStringify(0)).toBe("0");
    expect(stableJsonStringify(false)).toBe("false");
    expect(stableJsonStringify("")).toBe('""');
  });

  it("sorts keys at every level when asked", () => {
    const value = { z: 1, a: { n: 2, b: [3, { y: 4, c: 5 }] } };
    expect(stableJsonStringify(value, { sortKeys: true })).toBe(
      '{"a":{"b":[3,{"c":5,"y":4}],"n":2},"z":1}',
    );
  });

  it("clamps indent to the supported range", () => {
    expect(stableJsonStringify({ a: 1 }, { indent: 2 })).toBe('{\n  "a": 1\n}');
    // Above 8 is 8, below 0 is 0 rather than an invalid JSON.stringify space.
    expect(stableJsonStringify({ a: 1 }, { indent: 20 })).toBe(
      `{\n${" ".repeat(8)}"a": 1\n}`,
    );
    expect(stableJsonStringify({ a: 1 }, { indent: -5 })).toBe('{"a":1}');
  });

  it("marks output that exceeds maxOutputChars", () => {
    const long = "x".repeat(100);
    const out = stableJsonStringify(long, { maxOutputChars: 10 });
    expect(out).toBe(`"xxxxxxxxx\n[... truncated ...]`);
    expect(out.endsWith("\n[... truncated ...]")).toBe(true);
    expect(out.startsWith('"xxxxxxxxx')).toBe(true);
    // Under the limit nothing is appended.
    expect(stableJsonStringify("short", { maxOutputChars: 100 })).toBe('"short"');
  });

  it("does not throw on a circular object", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    expect(() => stableJsonStringify(circular)).not.toThrow();
    expect(stableJsonStringify(circular)).toBe("null");
  });

  it("does not throw on values JSON refuses to serialize", () => {
    // Both throw inside JSON.stringify; neither may escape the helper.
    expect(() => stableJsonStringify(10n)).not.toThrow();
    expect(stableJsonStringify(10n)).toBe("null");

    const exploding = {
      toJSON() {
        throw new Error("nope");
      },
    };
    expect(() => stableJsonStringify(exploding)).not.toThrow();
    expect(stableJsonStringify(exploding)).toBe("null");
  });

  it("still serializes a null-prototype object", () => {
    // JSON.stringify handles these; only String() would have thrown.
    const bare = Object.create(null) as Record<string, unknown>;
    bare.a = 1;
    expect(stableJsonStringify(bare)).toBe('{"a":1}');
  });
});

describe("extractJsonValues", () => {
  it("reads a fenced json block", () => {
    expect(extractJsonValues('before\n```json\n{"a":1}\n```\nafter')).toEqual([{ a: 1 }]);
  });

  it("reads an object embedded in prose", () => {
    expect(extractJsonValues('Sure, here it is: {"b":[1,2]} done')).toEqual([{ b: [1, 2] }]);
  });

  it("honours maxResults", () => {
    const text = '```json\n{"i":1}\n```\n```json\n{"i":2}\n```\n```json\n{"i":3}\n```';
    expect(extractJsonValues(text, { maxResults: 2 })).toEqual([{ i: 1 }, { i: 2 }]);
  });

  it("returns an empty array when there is no JSON", () => {
    expect(extractJsonValues("nothing to see here")).toEqual([]);
  });
});
