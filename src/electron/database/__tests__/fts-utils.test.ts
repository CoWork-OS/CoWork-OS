import { describe, expect, it } from "vitest";
import {
  sanitizeFtsToken,
  isSafeFtsToken,
  buildMarkerFtsQuery,
  buildRelaxedTokenFtsQuery,
} from "../fts-utils";

describe("sanitizeFtsToken", () => {
  it("strips brackets and special characters", () => {
    expect(sanitizeFtsToken("[suggestion]")).toBe("suggestion");
    expect(sanitizeFtsToken('"quoted"')).toBe("quoted");
    expect(sanitizeFtsToken("hello*world")).toBe("helloworld");
  });

  it("preserves underscores and hyphens", () => {
    expect(sanitizeFtsToken("task-id_123")).toBe("task-id_123");
  });

  it("strips FTS5 operators embedded in text", () => {
    expect(sanitizeFtsToken("near/3")).toBe("near3");
    expect(sanitizeFtsToken("foo^bar")).toBe("foobar");
  });
});

describe("isSafeFtsToken", () => {
  it("rejects FTS5 keywords", () => {
    expect(isSafeFtsToken("and")).toBe(false);
    expect(isSafeFtsToken("or")).toBe(false);
    expect(isSafeFtsToken("not")).toBe(false);
    expect(isSafeFtsToken("near")).toBe(false);
  });

  it("rejects single-char tokens", () => {
    expect(isSafeFtsToken("a")).toBe(false);
  });

  it("accepts normal tokens", () => {
    expect(isSafeFtsToken("suggestion")).toBe(true);
    expect(isSafeFtsToken("task-123")).toBe(true);
  });
});

describe("buildMarkerFtsQuery", () => {
  it("builds a quoted phrase from a marker string", () => {
    expect(buildMarkerFtsQuery("[SUGGESTION]")).toBe('"suggestion"');
  });

  it("returns null for markers that reduce to a single char", () => {
    expect(buildMarkerFtsQuery("[a]")).toBeNull();
  });

  it("returns null for markers that reduce to FTS5 keywords", () => {
    expect(buildMarkerFtsQuery("[NOT]")).toBeNull();
    expect(buildMarkerFtsQuery("AND")).toBeNull();
  });

  it("handles markers with mixed special chars", () => {
    expect(buildMarkerFtsQuery("[suggestion-feedback:acted_on]")).toBe(
      '"suggestion-feedbackacted_on"',
    );
  });
});

describe("buildRelaxedTokenFtsQuery", () => {
  it("joins sanitized tokens with OR", () => {
    expect(buildRelaxedTokenFtsQuery(["hello", "world"])).toBe('"hello" OR "world"');
  });

  it("filters out FTS5 keywords", () => {
    expect(buildRelaxedTokenFtsQuery(["not", "hello", "and", "world"])).toBe('"hello" OR "world"');
  });

  it("filters out single-char tokens", () => {
    expect(buildRelaxedTokenFtsQuery(["a", "hello"])).toBe('"hello"');
  });

  it("strips special chars from tokens", () => {
    expect(buildRelaxedTokenFtsQuery(["hello*", "wor(ld)"])).toBe('"hello" OR "world"');
  });

  it("returns empty string when all tokens are invalid", () => {
    expect(buildRelaxedTokenFtsQuery(["a", "or", ""])).toBe("");
  });
});
