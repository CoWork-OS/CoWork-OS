import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { SubAgentsStripButton } from "../TaskStatusStrip";

describe("SubAgentsStripButton", () => {
  it("labels one agent in the singular", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SubAgentsStripButton, { count: 1, onOpen: () => undefined }),
    );
    expect(markup).toContain("Agent<");
    expect(markup).toContain(">1</span>");
  });

  it("labels several agents in the plural", () => {
    const markup = renderToStaticMarkup(
      React.createElement(SubAgentsStripButton, { count: 3, onOpen: () => undefined }),
    );
    expect(markup).toContain("Agents");
    expect(markup).toContain(">3</span>");
  });
});
