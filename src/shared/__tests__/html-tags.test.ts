import { describe, expect, it } from "vitest";
import { asciiLowerCase, findOpeningTag, findOpeningTags, insertAfterTag } from "../html-tags";

describe("html tag scanning", () => {
  it("finds tags case-insensitively without matching longer names", () => {
    const html = '<HEADER>x</HEADER><Head lang="en"><title>T</title></Head>';
    expect(findOpeningTag(html, "head")).toEqual({
      start: 18,
      end: 34,
      text: '<Head lang="en">',
    });
    expect(findOpeningTag("<header>", "head")).toBeNull();
    expect(findOpeningTag("<head", "head")).toBeNull();
  });

  it("lists every tag and continues past each closing bracket", () => {
    const html = '<link rel="a"><p><link rel=b><link';
    expect(findOpeningTags(html, "link").map((tag) => tag.text)).toEqual([
      '<link rel="a">',
      "<link rel=b>",
    ]);
  });

  it("keeps indexes aligned for non-ASCII text", () => {
    const html = "İstanbul <HTML>";
    expect(asciiLowerCase(html)).toHaveLength(html.length);
    expect(insertAfterTag(html, "html", "!")).toBe("İstanbul <HTML>!");
  });
});
