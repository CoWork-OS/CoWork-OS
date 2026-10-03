import { describe, expect, it } from "vitest";
import {
  findExcludedPatternRisk,
  isSafeExcludedPattern,
  MAX_EXCLUDED_PATTERNS,
  validateExcludedPatterns,
} from "../excluded-patterns";

describe("excluded pattern screening (SEC-11)", () => {
  it.each([
    "password",
    "api[_-]?key",
    "secret.*token",
    "\\d{16}",
    "(foo|bar)",
    "(?:ab)+",
    "(abc)?def",
    "[(+*)]+x",
    "\\(a+\\)+",
  ])("accepts the simple pattern %s", (pattern) => {
    expect(findExcludedPatternRisk(pattern)).toBeNull();
    expect(isSafeExcludedPattern(pattern)).toBe(true);
  });

  it.each([
    "(a+)+$",
    "(a*)*b",
    "(a|aa)+",
    "(\\w+\\s?)*$",
    "((ab)*)+",
    "(x+){10}",
    "(?:a|b)*c",
    ".*a.*b.*c",
    "(a)\\1",
    "(?=a)a",
  ])("rejects the ReDoS-prone pattern %s", (pattern) => {
    expect(findExcludedPatternRisk(pattern)).not.toBeNull();
    expect(isSafeExcludedPattern(pattern)).toBe(false);
  });

  it("validates list shape, count, length and compilability", () => {
    expect(validateExcludedPatterns([" token ", "ssn"])).toEqual(["token", "ssn"]);
    expect(() => validateExcludedPatterns("token")).toThrow(/array/);
    expect(() => validateExcludedPatterns([42])).toThrow(/array of strings/);
    expect(() => validateExcludedPatterns(["("])).toThrow(/not a valid regular expression/);
    expect(() => validateExcludedPatterns(["a".repeat(201)])).toThrow(/exceeds/);
    expect(() => validateExcludedPatterns([""])).toThrow(/empty/);
    expect(() =>
      validateExcludedPatterns(Array.from({ length: MAX_EXCLUDED_PATTERNS + 1 }, () => "x")),
    ).toThrow(/At most/);
  });
});
