import React from "react";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { WorkResultMarkdown } from "../WorkResultMarkdown";

const workViewSource = readFileSync(
  fileURLToPath(new URL("../WorkView.tsx", import.meta.url)),
  "utf8",
);
const styles = readFileSync(fileURLToPath(new URL("../work-view.css", import.meta.url)), "utf8");

function render(text: string): string {
  return renderToStaticMarkup(
    React.createElement(WorkResultMarkdown, { className: "work-view-result", text }),
  );
}

describe("Work detail result", () => {
  it("renders the summary's markdown instead of showing raw syntax", () => {
    const markup = render(
      "Reviewed **three** files in `src/`:\n\n- Fixed the parser\n- Added tests",
    );

    expect(markup).toContain('<div class="work-view-result">');
    expect(markup).toContain("<strong>three</strong>");
    expect(markup).toContain("<code>src/</code>");
    expect(markup).toContain("<li>Fixed the parser</li>");
    expect(markup).not.toContain("**");
    expect(markup).not.toContain("- Fixed");
  });

  it("keeps headings quiet and links inert inside the summary card", () => {
    const markup = render("## Summary\nSee [the report](https://example.com/report).");

    expect(markup).toContain('<p class="work-view-result-heading">Summary</p>');
    expect(markup).not.toContain("<h2");
    expect(markup).not.toContain("<a ");
    expect(markup).toContain("the report");
  });

  it("is what the Work detail panel uses, with the five-line clamp kept", () => {
    expect(workViewSource).toContain(
      '<WorkResultMarkdown className="work-view-result" text={result} />',
    );
    expect(workViewSource).not.toContain('<p className="work-view-result">');
    expect(styles).toMatch(/\.work-view-result\s*\{[^}]*-webkit-line-clamp:\s*5;/s);
    expect(styles).not.toMatch(/\.work-view-result\s*\{[^}]*white-space:\s*pre-wrap/s);
  });
});
