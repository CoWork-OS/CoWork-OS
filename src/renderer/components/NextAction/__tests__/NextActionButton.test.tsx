import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NextActions, NextActionContext } from "../NextActionButton";
import { cleanAssistantMessageForDisplay } from "../../MainContent/markdown-normalization";
import { splitNextAction } from "../../../../shared/answer-surfaces/next-action";

function render(activeMessageKey: string | null, messageKey: string | undefined): string {
  const button = createElement(NextActions, {
    steps: ["Find time with Sophie", "Draft the follow-up"],
    messageKey,
  });
  const scoped: ReactNode = createElement(
    NextActionContext.Provider,
    { value: { activeMessageKey, send: vi.fn(async () => undefined) } },
    button,
  );
  return renderToStaticMarkup(scoped as never);
}

describe("NextActions", () => {
  it("shows every message it sends under the live reply, the likeliest first", () => {
    const html = render("evt-2", "evt-2");
    expect(html.match(/next-action-button/g)).toHaveLength(2);
    expect(html.indexOf("Find time with Sophie")).toBeLessThan(html.indexOf("Draft the follow-up"));
    expect(html.match(/is-primary/g)).toHaveLength(1);
  });

  it("shows nothing under an older reply or without a conversation", () => {
    expect(render("evt-3", "evt-2")).toBe("");
    expect(render(null, "evt-2")).toBe("");
    expect(render("evt-2", undefined)).toBe("");
    expect(
      renderToStaticMarkup(createElement(NextActions, { steps: ["Hi"], messageKey: "evt-2" })),
    ).toBe("");
  });
});

describe("display cleaning", () => {
  it("keeps the block intact so the renderer can find it", () => {
    const message = "- one\n- two\n\n```cowork-next\nGo deeper on item two\n```";
    expect(splitNextAction(cleanAssistantMessageForDisplay(message)).steps).toEqual([
      "Go deeper on item two",
    ]);
  });

  it("keeps literal Next Action syntax in a Markdown code example during display cleaning", () => {
    const example = ["````markdown", "```cowork-next", "Sample step", "```", "````"].join("\n");
    const message = `${example}\n\n\`\`\`cowork-next\nUse that format\n\`\`\``;
    expect(splitNextAction(cleanAssistantMessageForDisplay(message))).toEqual({
      body: example,
      steps: ["Use that format"],
    });
  });
});
