import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { buildMarkdownComponents } from "../markdown-components";

const components = buildMarkdownComponents({
  workspacePath: "/private/tmp/qa",
  onOpenViewer: () => {},
});

function renderLink(href: string) {
  return renderToStaticMarkup(
    React.createElement(MarkdownRenderer, {
      children: `[Download result](${href})`,
      components,
    }),
  );
}

describe("MarkdownRenderer file links", () => {
  it("routes sandbox file links through the existing file preview component", () => {
    const markup = renderLink("sandbox:/private/tmp/qa/result.txt");
    expect(markup).toContain('href="/private/tmp/qa/result.txt"');
    expect(markup).toContain("Click to preview");
    expect(markup).not.toContain("sandbox:");
  });

  it.each([
    "javascript:alert(1)",
    "data:text/html,hello",
    "sandbox://example.com/result.txt",
    "sandbox:/\\example.com/result.txt",
  ])("does not enable unsafe or remote pseudo-protocol links: %s", (href) => {
    expect(renderLink(href)).not.toContain("href=");
  });

  it("preserves normal web links", () => {
    expect(renderLink("https://example.com/result")).toContain('href="https://example.com/result"');
  });

  it("does not turn sandbox image sources into renderer requests", () => {
    const markup = renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        children: "![preview](sandbox:/private/tmp/qa/image.png)",
      }),
    );
    expect(markup).not.toContain('src="/private/');
  });
});
