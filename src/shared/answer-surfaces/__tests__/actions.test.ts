import { describe, expect, it } from "vitest";
import {
  SURFACE_ACTION_MAX_PROMPT_CHARS,
  normalizeSurfaceActionUrl,
  toSurfaceActionRequest,
} from "../actions";
import { toPlainAnswerText } from "../blocks";
import { parseAnswerSurfaceSource } from "../schema";

describe("normalizeSurfaceActionUrl", () => {
  it("accepts plain https links and reports the host", () => {
    expect(normalizeSurfaceActionUrl(" https://example.com/menu?x=1 ")).toEqual({
      url: "https://example.com/menu?x=1",
      host: "example.com",
      extra: 4,
    });
    expect(normalizeSurfaceActionUrl("https://example.com:8443/a#b")?.host).toBe(
      "example.com:8443",
    );
  });

  it("refuses other schemes and links with credentials", () => {
    for (const url of [
      "http://example.com",
      "javascript:alert(1)",
      "data:text/html,hi",
      "file:///etc/passwd",
      "mailto:a@b.c",
      "https://bank.com@evil.test/",
      "https://user:pass@example.com/",
      "not a url",
      "https://localhost/admin",
      "https://printer.local/",
      "https://127.0.0.1/",
      "https://192.168.1.1/",
      "https://10.0.0.8/",
      "https://[::1]/",
      "https://169.254.169.254/latest",
      `https://example.com/${"a".repeat(2100)}`,
    ]) {
      expect(normalizeSurfaceActionUrl(url), url).toBeNull();
    }
  });
});

describe("toSurfaceActionRequest", () => {
  it("cleans a prompt and keeps its line breaks", () => {
    expect(
      toSurfaceActionRequest({
        prompt: "  Book it\r\nfor 4" + String.fromCodePoint(0x202e, 0x200b) + "  ",
      }),
    ).toEqual({
      kind: "prompt",
      text: "Book it\nfor 4",
    });
  });

  it("drops invisible characters so the shown text is the sent text", () => {
    // Tag characters spell hidden ASCII a model would read; fillers and selectors hide too.
    const hidden =
      "Book it" + "\u{E0049}\u{E0047}\u{E004E}" + "\u3164\u2800\ufe0f\u2060\ufeff\u00ad";
    expect(toSurfaceActionRequest({ prompt: hidden })).toEqual({ kind: "prompt", text: "Book it" });
    expect(toSurfaceActionRequest({ prompt: "a\u2028b" })).toEqual({ kind: "prompt", text: "ab" });
    expect(toSurfaceActionRequest({ prompt: "Book   it\t now" })).toEqual({
      kind: "prompt",
      text: "Book it now",
    });
  });

  it("keeps ordinary punctuation and emoji", () => {
    expect(toSurfaceActionRequest({ prompt: "Compare A | B — 50% off? 🍕 café" })).toEqual({
      kind: "prompt",
      text: "Compare A | B — 50% off? 🍕 café",
    });
  });

  it("keeps the whole message on screen: one blank line at most, few lines", () => {
    expect(toSurfaceActionRequest({ prompt: "Book it\n\n\n\n\nand pay" })).toEqual({
      kind: "prompt",
      text: "Book it\n\nand pay",
    });
    expect(toSurfaceActionRequest({ prompt: Array(9).fill("line").join("\n") })).toBeNull();
  });

  it("rejects empty, oversized, mixed and unknown actions", () => {
    expect(toSurfaceActionRequest({ prompt: String.fromCodePoint(0x200b) + " " })).toBeNull();
    expect(
      toSurfaceActionRequest({ prompt: "x".repeat(SURFACE_ACTION_MAX_PROMPT_CHARS + 1) }),
    ).toBeNull();
    expect(toSurfaceActionRequest({ prompt: "hi", open: "https://a.com" })).toBeNull();
    expect(toSurfaceActionRequest({ run: "rm -rf /" })).toBeNull();
    expect(toSurfaceActionRequest("hi")).toBeNull();
    expect(toSurfaceActionRequest({ open: "http://a.com" })).toBeNull();
  });

  it("returns the normalized link for open", () => {
    expect(toSurfaceActionRequest({ open: "https://Example.com" })).toEqual({
      kind: "open",
      url: "https://example.com/",
      host: "example.com",
      extra: 0,
    });
  });
});

describe("button node", () => {
  const block = (action: unknown) =>
    JSON.stringify({
      type: "card",
      children: [
        { type: "slider", id: "n", label: "People", min: 1, max: 8, default: 2 },
        { type: "button", label: "Book", action },
      ],
    });

  it("parses message and link buttons", () => {
    expect(parseAnswerSurfaceSource(block({ prompt: "Book a table for {{n}}" })).ok).toBe(true);
    expect(parseAnswerSurfaceSource(block({ open: "https://example.com" })).ok).toBe(true);
  });

  it("rejects buttons with unsafe links, unknown actions or unknown names in the message", () => {
    expect(parseAnswerSurfaceSource(block({ open: "javascript:alert(1)" })).ok).toBe(false);
    expect(parseAnswerSurfaceSource(block({ run: "ls" })).ok).toBe(false);
    expect(parseAnswerSurfaceSource(block({ prompt: "Book for {{guests}}" })).ok).toBe(false);
  });

  it("drops message buttons from plain text and keeps links", () => {
    const fence = (action: unknown) => "Plan\n```cowork-ui\n" + block(action) + "\n```";
    expect(toPlainAnswerText(fence({ prompt: "Book it" }))).not.toContain("Book");
    expect(toPlainAnswerText(fence({ open: "https://example.com/menu" }))).toContain(
      "Book: https://example.com/menu",
    );
  });
});
