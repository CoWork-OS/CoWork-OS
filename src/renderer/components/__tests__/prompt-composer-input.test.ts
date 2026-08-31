import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import {
  PromptComposerInput,
  formatPastedWebLinkAsMarkdown,
  getPastedText,
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
