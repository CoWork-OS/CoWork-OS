import { describe, expect, it } from "vitest";

import { feedRowSignaturesChanged, pruneStaleMentionSpans } from "../effect-update-guards";

const span = (start: number, label: string) => ({
  start,
  end: start + label.length + 1,
  mention: { label },
});

describe("feedRowSignaturesChanged", () => {
  it("is false when the parent only handed over a new rows array", () => {
    // Typing into a running session re-renders the feed with equal rows on every key.
    const previous = new Map([
      ["a", "v1:1:80"],
      ["b", "v1:3:120"],
    ]);
    const active = new Map([
      ["a", "v1:1:80"],
      ["b", "v1:3:120"],
      ["c", "v1:1:60"],
    ]);
    expect(feedRowSignaturesChanged(previous, active)).toBe(false);
  });

  it("is true when a measured row changed revision or left the feed", () => {
    const previous = new Map([
      ["a", "v1:1:80"],
      ["b", "v1:3:120"],
    ]);
    expect(feedRowSignaturesChanged(previous, new Map([["a", "v1:1:80"]]))).toBe(true);
    expect(
      feedRowSignaturesChanged(
        previous,
        new Map([
          ["a", "v1:1:80"],
          ["b", "v1:4:120"],
        ]),
      ),
    ).toBe(true);
  });
});

describe("pruneStaleMentionSpans", () => {
  it("returns the same array while every chip still reads @label", () => {
    const spans = [span(0, "Gmail"), span(11, "Drive")];
    expect(pruneStaleMentionSpans("@Gmail and @Drive notes", spans)).toBe(spans);
    expect(pruneStaleMentionSpans("", [])).toEqual([]);
  });

  it("drops chips whose text was edited away", () => {
    const gmail = span(0, "Gmail");
    const drive = span(11, "Drive");
    expect(pruneStaleMentionSpans("@Gmail and @Drve", [gmail, drive])).toEqual([gmail]);
    expect(pruneStaleMentionSpans("@Gma", [gmail])).toEqual([]);
  });
});
