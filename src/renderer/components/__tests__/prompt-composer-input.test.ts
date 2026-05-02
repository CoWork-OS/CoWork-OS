import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { PromptComposerInput } from "../PromptComposerInput";

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
    expect(markup).toContain("Gmail");
    expect(markup).toContain("for triage");
  });
});
