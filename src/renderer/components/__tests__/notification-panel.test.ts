import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { NotificationMarkdownPreview } from "../NotificationPanel";

describe("NotificationMarkdownPreview", () => {
  it("renders markdown emphasis without leaking raw markers", () => {
    const markup = renderToStaticMarkup(
      React.createElement(NotificationMarkdownPreview, {
        text: "Almarion, **Meetings** for today: No live calendar meetings.",
      }),
    );

    expect(markup).toContain("<strong>Meetings</strong>");
    expect(markup).not.toContain("**Meetings**");
  });

  it("normalizes inline markdown headings in compact notification copy", () => {
    const markup = renderToStaticMarkup(
      React.createElement(NotificationMarkdownPreview, {
        text: "Executing the alternative strategy for the key decision: ## Alternative toolchain",
      }),
    );

    expect(markup).toContain("<strong>Alternative toolchain</strong>");
    expect(markup).not.toContain("## Alternative toolchain");
  });
});
