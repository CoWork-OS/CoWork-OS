import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { createElement } from "react";
import { InteractionModePicker, interactionModeLabel } from "../MainContent/InteractionModePicker";

describe("InteractionModePicker", () => {
  it("offers Do, Ask and Plan and nothing else", () => {
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
    expect(html).toContain(">Plan</button>");
    expect(html).toContain("Work mode");
    expect(html).not.toContain("Advanced");
    expect(html).not.toContain(">Execute<");
    expect(html).not.toContain(">Analyze<");
    expect(html).not.toContain(">Debug<");
    expect(html).not.toContain(">Verified<");
  });
  it("labels a pinned Plan selection even when closed", () => {
    expect(interactionModeLabel({ mode: "smart", executionOverride: "plan" })).toBe("Plan");
  });

  it("maps the user-facing labels without changing the runtime selection", () => {
    expect(interactionModeLabel({ mode: "chat" })).toBe("Ask");
    expect(interactionModeLabel({ mode: "smart" })).toBe("Do");
  });
});
