import { describe, expect, it } from "vitest";
import {
  NEXT_ACTION_MAX_CHARS,
  normalizeNextAction,
  splitNextAction,
  withoutNextAction,
} from "../next-action";
import { toPlainAnswerText, withoutAnswerSurfaceBlocks } from "../blocks";

const fence = (text: string) => ["```cowork-next", text, "```"].join("\n");

describe("splitNextAction", () => {
  it("takes the block at the end as the next step and removes it from the body", () => {
    const message = `Sophie is free Tuesday at 9:30.\n\n${fence("Find 20 minutes with Sophie this week")}\n`;
    expect(splitNextAction(message)).toEqual({
      body: "Sophie is free Tuesday at 9:30.",
      next: "Find 20 minutes with Sophie this week",
    });
  });

  it("leaves messages without a block untouched", () => {
    const message = "Plain answer.\n\n```ts\nconst a = 1;\n```";
    expect(splitNextAction(message)).toEqual({ body: message, next: null });
  });

  it("drops a block that is not last, but never shows it as text", () => {
    const message = `${fence("Book it")}\n\nMore prose after it.`;
    expect(splitNextAction(message)).toEqual({ body: "More prose after it.", next: null });
  });

  it("uses only the last of several blocks", () => {
    const message = `${fence("First idea")}\nAnswer.\n${fence("Second idea")}`;
    expect(splitNextAction(message)).toEqual({ body: "Answer.", next: "Second idea" });
  });

  it("hides an unfinished block while the answer streams", () => {
    expect(splitNextAction("Answer.\n```cowork-next\nFind ti")).toEqual({
      body: "Answer.",
      next: null,
    });
  });

  it("refuses empty or overlong text", () => {
    expect(splitNextAction(`Answer.\n${fence("   ")}`).next).toBeNull();
    expect(splitNextAction(`Answer.\n${fence("x".repeat(NEXT_ACTION_MAX_CHARS + 1))}`).next).toBe(
      null,
    );
    expect(
      splitNextAction(`Answer.\n${fence("x".repeat(NEXT_ACTION_MAX_CHARS))}`).next,
    ).toHaveLength(NEXT_ACTION_MAX_CHARS);
  });
});

describe("normalizeNextAction", () => {
  it("joins lines and drops characters the button would not show", () => {
    const zeroWidth = String.fromCharCode(0x200b);
    const tag = String.fromCodePoint(0xe0041);
    expect(normalizeNextAction(`Draft the\n  reply${zeroWidth} to Sam${tag}`)).toBe(
      "Draft the reply to Sam",
    );
  });
});

describe("text-only views", () => {
  const message = `**Bottom line:** two deals slip.\n\n${fence("Draft the follow-up emails")}`;

  it("drop the next step from plain text and previews", () => {
    expect(toPlainAnswerText(message)).toBe("**Bottom line:** two deals slip.");
    expect(withoutAnswerSurfaceBlocks(message)).toBe("**Bottom line:** two deals slip.");
    expect(withoutNextAction(message)).toBe("**Bottom line:** two deals slip.");
  });

  it("drops it beside an interactive answer too", () => {
    const withSurface = [
      "Totals:",
      "```cowork-ui",
      JSON.stringify({ type: "text", text: "42 orders" }),
      "```",
      fence("Break the orders down by region"),
    ].join("\n");
    const plain = toPlainAnswerText(withSurface);
    expect(plain).toContain("42 orders");
    expect(plain).not.toContain("cowork-next");
    expect(plain).not.toContain("Break the orders down");
  });
});
