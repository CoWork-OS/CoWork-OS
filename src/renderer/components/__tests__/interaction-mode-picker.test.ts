import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { InteractionModePicker, interactionModeLabel } from "../MainContent/InteractionModePicker";

describe("InteractionModePicker", () => {
  it("shows Ask and Do as the primary choices and keeps runtime overrides advanced", () => {
    const html = renderToStaticMarkup(
      createElement(InteractionModePicker, {
        selection: { mode: "smart" },
        open: true,
        onToggle: () => {},
        onChange: () => {},
      }),
    );
    expect(html).toContain(">Do</button>");
    expect(html).toContain(">Ask</button>");
    expect(html).toContain("Work mode");
    expect(html).toContain("Advanced…");
    expect(html).not.toContain(">Execute<");
    expect(html).not.toContain(">Verified<");
  });
  it("makes the current advanced override visible even when closed", () => {
    expect(interactionModeLabel({ mode: "smart", executionOverride: "plan" })).toBe("Do · Plan");
  });

  it("maps the user-facing labels without changing the runtime selection", () => {
    expect(interactionModeLabel({ mode: "chat" })).toBe("Ask");
    expect(interactionModeLabel({ mode: "smart" })).toBe("Do");
  });
});
