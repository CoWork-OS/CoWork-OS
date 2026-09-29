import { describe, expect, it } from "vitest";
import { mergeSettingsValues } from "../secure-settings-merge";

describe("mergeSettingsValues", () => {
  it("takes the other writer's value for fields this writer left alone", () => {
    expect(mergeSettingsValues({ a: 1, b: 1 }, { a: 2, b: 1 }, { a: 1, b: 3 })).toEqual({
      value: { a: 2, b: 3 },
      conflicts: [],
    });
  });

  it("merges nested objects field by field and reports real conflicts", () => {
    const result = mergeSettingsValues(
      { x: { p: 1, q: 1 }, list: [1] },
      { x: { p: 2, q: 1 }, list: [1, 2] },
      { x: { p: 1, q: 5 }, list: [1, 3] },
    );
    expect(result.value).toEqual({ x: { p: 2, q: 5 }, list: [1, 2] });
    expect(result.conflicts).toEqual(["list"]);
  });

  it("applies deletions from either side and additions from both", () => {
    expect(
      mergeSettingsValues(
        { keep: 1, gone: 1, theirsGone: 1 },
        { keep: 1, theirsGone: 1, mine: 1 },
        {
          keep: 1,
          gone: 1,
          theirs: 1,
        },
      ),
    ).toEqual({ value: { keep: 1, mine: 1, theirs: 1 }, conflicts: [] });
  });

  it("treats non-object values as one value", () => {
    expect(mergeSettingsValues("a", "b", "c")).toEqual({ value: "b", conflicts: ["(value)"] });
    expect(mergeSettingsValues(undefined, { a: 1 }, { b: 2 })).toEqual({
      value: { a: 1, b: 2 },
      conflicts: [],
    });
  });
});
