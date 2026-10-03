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

  it("keeps non-ASCII letters and dots in file names", () => {
    expect(sanitizeFtsToken("größe")).toBe("größe");
    expect(sanitizeFtsToken("şehir!")).toBe("şehir");
    expect(sanitizeFtsToken("café,")).toBe("café");
    expect(sanitizeFtsToken("executor.ts")).toBe("executor.ts");
    expect(sanitizeFtsToken("(executor.ts).")).toBe("executor.ts");
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

  it("keeps a marker with mixed special chars as one phrase", () => {
    // The tokenizer splits the phrase into adjacent tokens, matching the stored marker;
    // the old sanitizer glued `feedbackacted_on` together, which never matched.
    expect(buildMarkerFtsQuery("[suggestion-feedback:acted_on]")).toBe(
      '"suggestion-feedback:acted_on"',
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

  it("keeps Turkish, German and accented tokens and file names", () => {
    expect(buildRelaxedTokenFtsQuery(["İstanbul", "größe", "naïve", "executor.ts"])).toBe(
      '"İstanbul" OR "größe" OR "naïve" OR "executor.ts"',
    );
  });

  it("drops uppercase operators and de-duplicates case-insensitively", () => {
    expect(buildRelaxedTokenFtsQuery(["cats", "AND", "dogs", "NEAR", "Cats"])).toBe(
      '"cats" OR "dogs"',
    );
  });

  it("returns empty string when all tokens are invalid", () => {
    expect(buildRelaxedTokenFtsQuery(["a", "or", ""])).toBe("");
  });
});
