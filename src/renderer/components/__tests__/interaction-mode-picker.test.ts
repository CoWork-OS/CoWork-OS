import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { InteractionModePicker, interactionModeLabel } from "../MainContent/InteractionModePicker";

describe("InteractionModePicker", () => {
  it("shows only the two primary choices and an advanced disclosure", () => {
    const html = renderToStaticMarkup(
      createElement(InteractionModePicker, {
        selection: { mode: "smart" },
        open: true,
        onToggle: () => {},
        onChange: () => {},
      }),
    );
    expect(html).toContain("Smart");
    expect(html).toContain("Chat");
    expect(html).toContain("Advanced…");
    expect(html).not.toContain(">Execute<");
    expect(html).not.toContain(">Verified<");
  });
  it("makes the current advanced override visible even when closed", () => {
    expect(interactionModeLabel({ mode: "smart", executionOverride: "plan" })).toBe("Smart · Plan");
  });
});
