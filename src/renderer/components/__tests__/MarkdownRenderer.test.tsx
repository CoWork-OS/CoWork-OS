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
    expect(markup).toContain("Click to open");
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

describe("MarkdownRenderer workspace image links", () => {
  const renderMarkdown = (markdown: string, markdownComponents: unknown = components) =>
    renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        children: markdown,
        components: markdownComponents,
      }),
    );

  it("adds an inline thumbnail after a link to a workspace image", () => {
    const markup = renderMarkdown("Saved [the image](qwen-image.png).");
    expect(markup).toContain("Click to open");
    expect(markup).toContain("markdown-image-link-preview");
  });

  it("does not add thumbnails for non-image or remote links", () => {
    expect(renderMarkdown("[report](report.pdf)")).not.toContain("markdown-image-link-preview");
    expect(renderMarkdown("[logo](https://example.com/logo.png)")).not.toContain(
      "markdown-image-link-preview",
    );
    expect(renderMarkdown("[vector](logo.svg)")).not.toContain("markdown-image-link-preview");
  });

  it("can disable link thumbnails for compact event titles", () => {
    const titleComponents = buildMarkdownComponents({
      workspacePath: "/private/tmp/qa",
      onOpenViewer: () => {},
      inlineImageLinks: false,
    });
    const markup = renderMarkdown("Created [image](qwen-image.png)", titleComponents);
    expect(markup).toContain("Click to open");
    expect(markup).not.toContain("markdown-image-link-preview");
  });

  it("keeps ![]() image embeds rendering through the image preview only", () => {
    const markup = renderMarkdown("![Sunset](sunset.png)");
    expect(markup).toContain("markdown-image-preview");
    expect(markup).not.toContain("markdown-image-link-preview");
  });

  it("renders file links as an icon-led chip and keeps web links plain", () => {
    const markup = renderMarkdown("See [`MainContent.tsx:42`](src/MainContent.tsx:42).");
    expect(markup).toMatch(
      /<a [^>]*class="clickable-file-path"[^>]*><span class="clickable-file-path-icon" aria-hidden="true"><svg [^>]*lucide-file-code[^>]*>/,
    );
    expect(markup).toMatch(
      /<span class="clickable-file-path-label"><code[^>]*>MainContent\.tsx:42<\/code><\/span>/,
    );
    expect(renderMarkdown("[docs](https://example.com/a.ts)")).not.toContain(
      "clickable-file-path-icon",
    );
  });

  it("decodes percent-encoded relative file links", () => {
    const markup = renderMarkdown("[my image](<my image.png>)");
    expect(markup).toContain('href="my%20image.png"');
    expect(markup).toContain('title="my image.png');
  });
});
