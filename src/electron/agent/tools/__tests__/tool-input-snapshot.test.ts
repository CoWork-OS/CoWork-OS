import { describe, expect, it } from "vitest";
import { snapshotToolInput } from "../tool-input-snapshot";

describe("tool input snapshot", () => {
  it("owns nested values and arrays while preserving optional JSON fields", () => {
    const source = {
      params: { destination: "reviewed", body: "approved bytes" },
      files: ["draft.md"],
      absent: undefined,
    };
    const sealed = snapshotToolInput(source);
    source.params.body = "changed bytes";
    source.files.push("other.md");
    expect(sealed.params.body).toBe("approved bytes");
    expect(sealed.files).toEqual(["draft.md"]);
    expect(sealed.absent).toBeUndefined();
    expect(() => {
      sealed.params.destination = "other";
    }).toThrow();
    expect(() => sealed.files.push("other.md")).toThrow();
    expect(source.params.body).toBe("changed bytes");
  });
  it("permits shared plain values and no-argument tools", () => {
    const shared = { value: "same" };
    const result = snapshotToolInput({ first: shared, second: shared });
    expect(result.first).toEqual(result.second);
    expect(Object.isFrozen(result.first)).toBe(true);
    expect(snapshotToolInput(undefined)).toBeUndefined();
  });
  it.each([new Map([["key", "value"]]), new Date(), new Uint8Array([1]), Infinity, NaN, () => 1])(
    "rejects non-JSON values before dispatch (%s)",
    (value) => {
      expect(() => snapshotToolInput({ value })).toThrow(
        "Tool arguments must be plain JSON values",
      );
    },
  );
  it("rejects cyclic values before dispatch", () => {
    const value: { self?: unknown } = {};
    value.self = value;
    expect(() => snapshotToolInput(value)).toThrow("cannot contain cycles");
  });
});
