import { describe, expect, it } from "vitest";
import { frontmatterString, parseFrontmatterBlock } from "../skill-frontmatter";

describe("parseFrontmatterBlock", () => {
  it.each([
    [
      "folded block scalar",
      "description: >\n  First line of the\n  description.\n",
      "First line of the description.\n",
    ],
    [
      "folded block scalar with strip chomping",
      "description: >-\n  Folded and\n  stripped",
      "Folded and stripped",
    ],
    ["literal block scalar", "description: |\n  Line one\n  Line two\n", "Line one\nLine two\n"],
    [
      "single-quoted scalar with escaped quote",
      "description: 'Port a composition''s source: one-way.'",
      "Port a composition's source: one-way.",
    ],
    [
      "double-quoted scalar with escapes",
      'description: "Use for \\"quoted\\" input: PRs, URLs."',
      'Use for "quoted" input: PRs, URLs.',
    ],
    [
      "single-quoted scalar wrapping double quotes",
      "description: '\"Quoted on purpose\"'",
      '"Quoted on purpose"',
    ],
    ["plain scalar", "description: Plain description", "Plain description"],
  ])("reads a %s", (_label, block, expected) => {
    expect(parseFrontmatterBlock(block).description).toBe(expected);
  });

  it("falls back to the line parser for invalid YAML", () => {
    const frontmatter = parseFrontmatterBlock(
      "name: legacy\ndescription: Use when: (1) a command fails\ntags:\n  - one\n  - 'two'",
    );

    expect(frontmatter).toEqual({
      name: "legacy",
      description: "Use when: (1) a command fails",
      tags: ["one", "two"],
    });
  });

  it.each([
    ["block list", "tags:\n  - video\n  - 'motion'"],
    ["flow list", "tags: [video, motion]"],
  ])("reads tags from a %s", (_label, block) => {
    expect(parseFrontmatterBlock(block).tags).toEqual(["video", "motion"]);
  });

  it("keeps scalars as strings and maps true/false/null", () => {
    expect(
      parseFrontmatterBlock(
        "name: 2048\nversion: 1.10\ncreated: 2024-01-01\nenabled: true\nhidden: false\nicon: null",
      ),
    ).toEqual({
      name: "2048",
      version: "1.10",
      created: "2024-01-01",
      enabled: true,
      hidden: false,
      icon: null,
    });
  });

  it("handles CRLF line endings in both parsers", () => {
    expect(parseFrontmatterBlock("name: crlf\r\ndescription: >\r\n  Folded\r\n  text\r\n")).toEqual(
      {
        name: "crlf",
        description: "Folded text\n",
      },
    );
    expect(parseFrontmatterBlock("name: crlf\r\ndescription: Use when: x\r\n")).toEqual({
      name: "crlf",
      description: "Use when: x",
    });
  });

  it.each([
    ["YAML", "__proto__:\n  name: injected\ndescription: ok"],
    ["line parser", "__proto__: injected\ndescription: Use when: x"],
  ])("does not let a __proto__ key change the prototype (%s)", (_label, block) => {
    const frontmatter = parseFrontmatterBlock(block);

    expect(Object.getPrototypeOf(frontmatter)).toBe(Object.prototype);
    expect(frontmatterString(frontmatter, "name")).toBeUndefined();
  });

  it("returns an empty object for a non-mapping block", () => {
    expect(parseFrontmatterBlock("")).toEqual({});
  });
});

describe("frontmatterString", () => {
  it("returns trimmed non-empty strings only", () => {
    const frontmatter = parseFrontmatterBlock(
      "name: '  padded  '\nempty: ''\nflag: true\ntags: [a]\nnested:\n  key: value",
    );

    expect(frontmatterString(frontmatter, "name")).toBe("padded");
    expect(frontmatterString(frontmatter, "empty")).toBeUndefined();
    expect(frontmatterString(frontmatter, "flag")).toBeUndefined();
    expect(frontmatterString(frontmatter, "tags")).toBeUndefined();
    expect(frontmatterString(frontmatter, "nested")).toBeUndefined();
    expect(frontmatterString(frontmatter, "missing")).toBeUndefined();
    expect(frontmatterString(frontmatter, "toString")).toBeUndefined();
  });
});
