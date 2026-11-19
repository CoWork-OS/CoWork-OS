import type { Components } from "react-markdown";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MarkdownRenderer } from "../MarkdownRenderer";
import { buildMarkdownComponents } from "../markdown-components";
import { OPEN_TERMINAL_TAB_EVENT } from "../../utils/code-block-runs";

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

describe("MarkdownRenderer inline citations", () => {
  const citationComponents = buildMarkdownComponents({
    citations: [
      {
        index: 1,
        url: "https://example.com/source",
        title: "Research source",
        snippet: "Source excerpt",
        domain: "example.com",
        accessedAt: 1,
        sourceTool: "web_search",
      },
    ],
  });

  it("renders known references as inline source badges in paragraphs and lists", () => {
    const markup = renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        children: "The answer cites [1].\n\n- Supporting evidence [1].",
        components: citationComponents,
      }),
    );

    expect(markup.match(/title="Research source — example.com"/g)).toHaveLength(2);
    expect(markup.match(/vertical-align:super/g)).toHaveLength(2);
    expect(markup).toContain("The answer cites");
    expect(markup).toContain("Supporting evidence");
  });

  it("leaves unknown references visible alongside resolved sources", () => {
    const markup = renderToStaticMarkup(
      React.createElement(MarkdownRenderer, {
        children: "Compare [1] with [2].",
        components: citationComponents,
      }),
    );

    expect(markup).toContain('title="Research source — example.com"');
    expect(markup).toContain("with [2].");
  });
});

describe("MarkdownRenderer claim sources", () => {
  const components = buildMarkdownComponents({
    citations: [
      {
        index: 1,
        url: "https://calendar.google.com/event?eid=abc",
        title: "Proposal review",
        snippet: "",
        domain: "calendar.google.com",
        accessedAt: 0,
        sourceTool: "calendar_action",
        sourceLabel: "Google Calendar",
      },
      {
        index: 2,
        url: "https://example.com/report",
        title: "Pricing report",
        snippet: "",
        domain: "example.com",
        accessedAt: 0,
        sourceTool: "web_fetch",
      },
    ],
  }) as Components;
  const render = (markdown: string) =>
    renderToStaticMarkup(React.createElement(MarkdownRenderer, { children: markdown, components }));

  it("puts one sources row under a paragraph that cites sources", () => {
    const markup = render("Harbor Mutual closes tomorrow [1] and pricing is set [2] [1].");
    expect(markup.match(/class="claim-sources"/g)).toHaveLength(1);
    expect(markup).toContain("Google Calendar and web");
    expect(markup).toContain("2 sources");
  });

  it("links each known source in a grouped citation", () => {
    const markup = render("The claim cites [1, 2, 9].");
    expect(markup).toContain('title="Proposal review — calendar.google.com"');
    expect(markup).toContain('title="Pricing report — example.com"');
    expect(markup).toContain("[9]");
    expect(markup).toContain("2 sources");
  });

  it("puts one row after a whole list, not one per item", () => {
    const markup = render("- First [1]\n- Second [2]\n- Third [1]");
    expect(markup.match(/class="claim-sources"/g)).toHaveLength(1);
    expect(markup).toContain("2 sources");
  });

  it("adds no row to text without known references", () => {
    expect(render("Nothing cited here [9].")).not.toContain("claim-sources");
  });

  it.each([
    "Use the literal `[1]` here.",
    String.raw`Read the [docs \[1\]](https://example.com/help).`,
    "- Syntax:\n\n  ```text\n  [1]\n  ```",
  ])("does not credit literal citation-like text in %s", (markdown) => {
    expect(render(markdown)).not.toContain("claim-sources");
  });

  it("credits only the source referenced outside inline code and links", () => {
    const markup = render(
      "Use the `[1]` key and " + String.raw`[docs \[1\]](https://example.com/help). See [2].`,
    );
    expect(markup).toContain("1 source");
    expect(markup).not.toContain("Google Calendar");
  });
});

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
  const renderMarkdown = (markdown: string, markdownComponents: Components = components) =>
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

describe("MarkdownRenderer terminal tab links", () => {
  const renderMarkdown = (markdown: string) =>
    renderToStaticMarkup(React.createElement(MarkdownRenderer, { children: markdown, components }));

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("renders a #terminal link as a terminal chip", () => {
    const markup = renderMarkdown("The tunnel ([https tunnel](#terminal/bg-1a2b3c4d)) is up.");
    expect(markup).toMatch(
      /<a href="#terminal\/bg-1a2b3c4d" class="terminal-tab-link" title="Open https tunnel in the terminal panel"><span class="terminal-tab-link-icon" aria-hidden="true"><svg [^>]*lucide-terminal[^>]*>/,
    );
    expect(markup).toContain('<span class="terminal-tab-link-label">https tunnel</span>');
    expect(markup).not.toContain("clickable-file-path");
  });

  it("keeps inline code in the label from becoming a file chip", () => {
    const markup = renderMarkdown("[`npm run dev`](#terminal/bg-1a2b3c4d)");
    expect(markup).toContain('class="terminal-tab-link"');
    expect(markup).not.toContain("clickable-file-path");
  });

  it("leaves malformed terminal hrefs as plain links", () => {
    const markup = renderMarkdown("[x](#terminal/../y)");
    expect(markup).not.toContain("terminal-tab-link");
  });

  it("asks the app to open the linked tab when clicked", () => {
    const dispatchEvent = vi.fn();
    vi.stubGlobal("window", { dispatchEvent });
    const link = (components.a as (props: Record<string, unknown>) => React.ReactElement)({
      href: "#terminal/bg-1a2b3c4d",
      children: "planner server",
    });
    const anchor = (link.type as (props: unknown) => React.ReactElement<{ onClick: Function }>)(
      link.props,
    );
    const event = { preventDefault: vi.fn(), stopPropagation: vi.fn() };

    anchor.props.onClick(event);

    expect(event.preventDefault).toHaveBeenCalled();
    expect(dispatchEvent).toHaveBeenCalledTimes(1);
    const dispatched = dispatchEvent.mock.calls[0][0] as CustomEvent<{ tabId: string }>;
    expect(dispatched.type).toBe(OPEN_TERMINAL_TAB_EVENT);
    expect(dispatched.detail).toEqual({ tabId: "bg-1a2b3c4d" });
  });
});
