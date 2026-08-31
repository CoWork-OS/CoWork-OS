import { describe, expect, it } from "vitest";
import { stripMailboxSummaryHtmlArtifacts } from "../mailbox";

describe("stripMailboxSummaryHtmlArtifacts", () => {
  it("removes leading repeated short digit tokens before prose on the same line", () => {
    expect(
      stripMailboxSummaryHtmlArtifacts(
        "96 96 Thanks for visiting Amazon! You have successfully set up your passkey.",
      ),
    ).toBe("Thanks for visiting Amazon! You have successfully set up your passkey.");
  });

  it("removes a line that is only repeated digit tokens", () => {
    expect(stripMailboxSummaryHtmlArtifacts("96 96")).toBe("");
  });

  it("leaves normal sentences unchanged", () => {
    expect(stripMailboxSummaryHtmlArtifacts("Thanks for your order.")).toBe(
      "Thanks for your order.",
    );
  });

  it("strips ZWNJ, soft hyphen entities and decoded zero-width characters", () => {
    expect(stripMailboxSummaryHtmlArtifacts("Deals &zwnj; &shy; &zwnj; are live today.")).toBe(
      "Deals are live today.",
    );
    expect(stripMailboxSummaryHtmlArtifacts("Hi&#8203;there")).toBe("Hithere");
    expect(stripMailboxSummaryHtmlArtifacts("a\u200Bb")).toBe("ab");
  });

  it("normalizes nbsp entities to a regular space", () => {
    expect(stripMailboxSummaryHtmlArtifacts("Hello&nbsp;world")).toBe("Hello world");
  });
});
