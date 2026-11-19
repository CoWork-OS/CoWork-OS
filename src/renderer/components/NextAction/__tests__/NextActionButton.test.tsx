import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NextActionButton, NextActionContext } from "../NextActionButton";
import { cleanAssistantMessageForDisplay } from "../../MainContent/markdown-normalization";
import { splitNextAction } from "../../../../shared/answer-surfaces/next-action";

function render(activeMessageKey: string | null, messageKey: string | undefined): string {
  const button = createElement(NextActionButton, { text: "Find time with Sophie", messageKey });
  const scoped: ReactNode = createElement(
    NextActionContext.Provider,
    { value: { activeMessageKey, send: vi.fn(async () => undefined) } },
    button,
  );
  return renderToStaticMarkup(scoped as never);
}

describe("NextActionButton", () => {
  it("shows the whole message it sends under the live reply", () => {
    const html = render("evt-2", "evt-2");
    expect(html).toContain("next-action-button");
    expect(html).toContain("Find time with Sophie");
  });

  it("shows nothing under an older reply or without a conversation", () => {
    expect(render("evt-3", "evt-2")).toBe("");
    expect(render(null, "evt-2")).toBe("");
    expect(render("evt-2", undefined)).toBe("");
    expect(
      renderToStaticMarkup(createElement(NextActionButton, { text: "Hi", messageKey: "evt-2" })),
    ).toBe("");
  });
});

describe("display cleaning", () => {
  it("keeps the block intact so the renderer can find it", () => {
    const message = "- one\n- two\n\n```cowork-next\nGo deeper on item two\n```";
    expect(splitNextAction(cleanAssistantMessageForDisplay(message)).next).toBe(
      "Go deeper on item two",
    );
  });
});
