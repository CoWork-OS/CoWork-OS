import { describe, expect, it } from "vitest";
import { countLineChanges } from "../line-change-stats";

describe("countLineChanges", () => {
  it("counts every line of new content as added", () => {
    expect(countLineChanges("", "a\nb\nc\n")).toEqual({ added: 3, removed: 0 });
  });

  it("counts replaced lines on both sides", () => {
    expect(countLineChanges("a\nb\nc", "a\nB\nc\nd")).toEqual({ added: 2, removed: 1 });
  });

  it("treats a moved line as unchanged", () => {
    expect(countLineChanges("a\nb\nc", "c\na\nb")).toEqual({ added: 0, removed: 0 });
  });

  it("matches repeated lines one for one", () => {
    expect(countLineChanges("x\nx\nx", "x")).toEqual({ added: 0, removed: 2 });
  });

  it("ignores Windows line endings and a trailing newline", () => {
    expect(countLineChanges("a\r\nb\r\n", "a\nb")).toEqual({ added: 0, removed: 0 });
  });
});
