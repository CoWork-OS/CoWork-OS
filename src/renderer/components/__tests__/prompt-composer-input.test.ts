import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  PromptComposerInput,
  applyComposerTextReplacement,
  formatPastedWebLinkAsMarkdown,
  getPastedText,
  isKeyboardEditEcho,
  keyboardEditEchoForKey,
  type IntegrationMentionSpan,
  type KeyboardEditEcho,
} from "../PromptComposerInput";

describe("PromptComposerInput", () => {
  it("renders integration mention chips inline from canonical mention text", () => {
    const markup = renderToStaticMarkup(
      React.createElement(PromptComposerInput, {
        value: "Use @Gmail for triage",
        mentions: [
          {
            spanId: "gmail-1",
            start: 4,
            end: 10,
            mention: {
              id: "builtin:gmail",
              label: "Gmail",
              source: "builtin",
              providerKey: "google-workspace:gmail",
              iconKey: "gmail",
              tools: ["gmail_action"],
              promptHint: "Use gmail_action.",
            },
          },
        ],
        className: "input-field input-textarea",
        ariaLabel: "Message",
        onChange: vi.fn(),
        onKeyDown: vi.fn(),
        onPaste: vi.fn(),
        onCursorChange: vi.fn(),
      }),
    );

    expect(markup).toContain("integration-mention-chip");
    expect(markup).toContain("integration-mention-icon-svg");
    expect(markup).toContain("Gmail");
    expect(markup).toContain("for triage");
  });

  it("formats pasted standalone GitHub URLs as compact Markdown links", () => {
    expect(formatPastedWebLinkAsMarkdown("https://github.com/nousresearch/hermes-agent")).toBe(
      "[nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent)",
    );
  });

  it("does not rewrite pasted text containing more than one token", () => {
    expect(
      formatPastedWebLinkAsMarkdown("see https://github.com/nousresearch/hermes-agent"),
    ).toBeNull();
  });

  it("reads plain text from native paste data", () => {
    const clipboardData = {
      getData: (type: string) => (type === "text/plain" ? "Pasted task" : ""),
    };

    expect(getPastedText(clipboardData)).toBe("Pasted task");
  });

  it("does not treat an empty clipboard as editor content", () => {
    expect(getPastedText({ getData: () => "" })).toBe("");
  });

  it("renders Markdown web links as inline favicon chips", () => {
    const markup = renderToStaticMarkup(
      React.createElement(PromptComposerInput, {
        value: "[nousresearch/hermes-agent](https://github.com/nousresearch/hermes-agent)",
        mentions: [],
        className: "input-field input-textarea",
        ariaLabel: "Message",
        onChange: vi.fn(),
        onKeyDown: vi.fn(),
        onPaste: vi.fn(),
        onCursorChange: vi.fn(),
      }),
    );

    expect(markup).toContain("composer-link-chip");
    expect(markup).toContain("composer-link-favicon");
    expect(markup).toContain("nousresearch/hermes-agent");
    expect(markup).toContain("github.com");
    expect(markup).not.toContain("https://github.com/nousresearch/hermes-agent</span>");
  });
});

const MULTI_PARAGRAPH_PROMPT = [
  "Create an Excel workbook called costs.xlsx for our onboarding pilot.",
  "Invoice ID | Date | Supplier\n00041 | 03/10/2026 | Studio",
  "Then give me a link to open it.",
].join("\n\n");

type ComposerInputEvent =
  | { kind: "keydown"; key: string; shiftKey?: boolean }
  | { kind: "keyup" }
  | { kind: "beforeinput"; inputType: string; data: string | null };

/**
 * Replays input the way PromptComposerInput applies it: handled keys edit on
 * keydown and leave an expected echo, every other edit arrives as beforeinput,
 * and each edit builds on the previous edit's text and caret even when no
 * re-render happened in between.
 */
function replayComposerInput(events: ComposerInputEvent[]): string {
  let value = "";
  let mentions: IntegrationMentionSpan[] = [];
  let caret = 0;
  let echo: KeyboardEditEcho | null = null;
  const replace = (start: number, end: number, text: string) => {
    const next = applyComposerTextReplacement(value, mentions, start, end, text);
    value = next.value;
    mentions = next.mentions;
    caret = next.cursor;
  };
  for (const event of events) {
    if (event.kind === "keyup") {
      echo = null;
      continue;
    }
    if (event.kind === "keydown") {
      echo = null;
      if (event.key === "Enter" && event.shiftKey) {
        echo = keyboardEditEchoForKey(event.key);
        replace(caret, caret, "\n");
      } else if (event.key.length === 1) {
        echo = keyboardEditEchoForKey(event.key);
        replace(caret, caret, event.key);
      }
      continue;
    }
    if (echo) {
      const pending = echo;
      echo = null;
      if (isKeyboardEditEcho(pending, event.inputType, event.data)) continue;
    }
    if (event.inputType === "insertText" || event.inputType === "insertFromPaste") {
      replace(caret, caret, event.data ?? "");
    } else if (event.inputType === "insertParagraph" || event.inputType === "insertLineBreak") {
      replace(caret, caret, "\n");
    }
  }
  return value;
}

describe("PromptComposerInput edit sequencing", () => {
  it("keeps every paragraph of a single multi-paragraph text insertion", () => {
    expect(
      replayComposerInput([
        { kind: "beforeinput", inputType: "insertText", data: MULTI_PARAGRAPH_PROMPT },
      ]),
    ).toBe(MULTI_PARAGRAPH_PROMPT);
  });

  it("keeps every paragraph when line and paragraph inserts arrive back to back", () => {
    const events: ComposerInputEvent[] = [];
    MULTI_PARAGRAPH_PROMPT.split("\n").forEach((line, index, lines) => {
      if (line) events.push({ kind: "beforeinput", inputType: "insertText", data: line });
      if (index < lines.length - 1) {
        events.push({ kind: "beforeinput", inputType: "insertParagraph", data: null });
      }
    });

    expect(replayComposerInput(events)).toBe(MULTI_PARAGRAPH_PROMPT);
  });

  it("does not swallow text inserted right after a handled Shift+Enter", () => {
    // Automation and text tools insert lines with Shift+Enter between them. The
    // next insertion can arrive before the keydown's cleanup timer runs, and it
    // used to be dropped, leaving only the first paragraph to be sent.
    const events: ComposerInputEvent[] = [];
    MULTI_PARAGRAPH_PROMPT.split("\n").forEach((line, index, lines) => {
      if (line) events.push({ kind: "beforeinput", inputType: "insertText", data: line });
      if (index < lines.length - 1) events.push({ kind: "keydown", key: "Enter", shiftKey: true });
    });

    expect(replayComposerInput(events)).toBe(MULTI_PARAGRAPH_PROMPT);
  });

  it("keeps a multi-paragraph paste inserted at the caret", () => {
    expect(
      replayComposerInput([
        { kind: "keydown", key: "A" },
        { kind: "keyup" },
        { kind: "beforeinput", inputType: "insertFromPaste", data: MULTI_PARAGRAPH_PROMPT },
      ]),
    ).toBe(`A${MULTI_PARAGRAPH_PROMPT}`);
  });

  it("still drops the native echo of a key the editor already applied", () => {
    expect(
      replayComposerInput([
        { kind: "keydown", key: "a" },
        { kind: "beforeinput", inputType: "insertText", data: "a" },
        { kind: "keydown", key: "Enter", shiftKey: true },
        { kind: "beforeinput", inputType: "insertLineBreak", data: null },
        { kind: "keydown", key: "b" },
      ]),
    ).toBe("a\nb");
  });

  it("only treats the matching input type and text as a keyboard echo", () => {
    const lineBreak = keyboardEditEchoForKey("Enter")!;
    expect(isKeyboardEditEcho(lineBreak, "insertParagraph", null)).toBe(true);
    expect(isKeyboardEditEcho(lineBreak, "insertLineBreak", null)).toBe(true);
    expect(isKeyboardEditEcho(lineBreak, "insertText", "Second paragraph")).toBe(false);
    expect(isKeyboardEditEcho(lineBreak, "insertFromPaste", null)).toBe(false);

    const typed = keyboardEditEchoForKey("x")!;
    expect(isKeyboardEditEcho(typed, "insertText", "x")).toBe(true);
    expect(isKeyboardEditEcho(typed, "insertText", "xyz")).toBe(false);
    expect(keyboardEditEchoForKey("ArrowLeft")).toBeNull();
  });

  it("widens a replacement that touches a mention chip to the whole chip", () => {
    const mention: IntegrationMentionSpan = {
      spanId: "gmail-1",
      start: 4,
      end: 10,
      mention: {
        id: "builtin:gmail",
        label: "Gmail",
        source: "builtin",
        providerKey: "google-workspace:gmail",
        iconKey: "gmail",
        tools: ["gmail_action"],
        promptHint: "Use gmail_action.",
      },
    };
    const next = applyComposerTextReplacement("Use @Gmail now", [mention], 9, 10, "");

    expect(next.value).toBe("Use  now");
    expect(next.mentions).toEqual([]);
    expect(next.cursor).toBe(4);
  });
});
