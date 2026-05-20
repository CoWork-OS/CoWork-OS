import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  autolinkBareDomains,
  autolinkBareUrls,
  autolinkUrlsInBrackets,
} from "../../utils/markdown-autolink";
import {
  buildMarkdownComponents,
  normalizeCodeBlockTextForDisplay,
} from "../markdown-components";
import {
  createQuotedAssistantMessage,
  isXComLink,
  normalizeQuotedAssistantMarkdownPreview,
  normalizeSourcesSection,
  resolveSafeCollapsedBubbleHeight,
  shouldCreateFreshTaskForSend,
} from "../MainContent";
import { MarkdownRenderer } from "../MarkdownRenderer";

afterEach(() => {
  vi.unstubAllGlobals();
});

function getMarkdownLinkClickHandler(
  onOpenWebLinkInSidebar?: (url: string) => void,
): (event: { preventDefault: () => void; stopPropagation: () => void }) => Promise<void> {
  const components = buildMarkdownComponents({ onOpenWebLinkInSidebar });
  const link = components.a({
    href: "https://example.com/product",
    children: "Example",
  }) as ReactElement<{
    onClick: (event: { preventDefault: () => void; stopPropagation: () => void }) => Promise<void>;
  }>;
  return link.props.onClick;
}

describe("MainContent markdown normalization helpers", () => {
  it("routes external markdown links to the sidebar browser callback when available", async () => {
    const openExternal = vi.fn();
    const onOpenWebLinkInSidebar = vi.fn();
    vi.stubGlobal("window", { electronAPI: { openExternal } });
    const clickEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn() };

    await getMarkdownLinkClickHandler(onOpenWebLinkInSidebar)(clickEvent);

    expect(clickEvent.preventDefault).toHaveBeenCalled();
    expect(clickEvent.stopPropagation).toHaveBeenCalled();
    expect(onOpenWebLinkInSidebar).toHaveBeenCalledWith("https://example.com/product");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("falls back to the system browser when no sidebar browser callback is available", async () => {
    const openExternal = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", { electronAPI: { openExternal } });
    const clickEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn() };

    await getMarkdownLinkClickHandler()(clickEvent);

    expect(openExternal).toHaveBeenCalledWith("https://example.com/product");
  });

  it("renders X.com links with the inline X treatment", () => {
    const components = buildMarkdownComponents({});
    const link = components.a({
      href: "https://x.com/kylejeong/status/123",
      children: "Kyle Jeong post",
    }) as ReactElement<{
      className: string;
      title: string;
      children: Array<ReactElement<{ className: string; children?: unknown }>>;
    }>;

    expect(link.props.className).toBe("x-social-link");
    expect(link.props.title).toBe("https://x.com/kylejeong/status/123");
    expect(link.props.children[0].props.className).toBe("x-social-link-icon");
    expect(link.props.children[1].props.className).toBe("x-social-link-label");
    expect(link.props.children[1].props.children).toBe("Kyle Jeong post");
  });

  it("treats protocol-less X.com links as external links", async () => {
    const onOpenWebLinkInSidebar = vi.fn();
    const components = buildMarkdownComponents({ onOpenWebLinkInSidebar });
    const link = components.a({
      href: "x.com/kylejeong/status/123",
      children: "post",
    }) as ReactElement<{
      href: string;
      onClick: (event: { preventDefault: () => void; stopPropagation: () => void }) => Promise<void>;
    }>;
    const clickEvent = { preventDefault: vi.fn(), stopPropagation: vi.fn() };

    expect(link.props.href).toBe("https://x.com/kylejeong/status/123");
    await link.props.onClick(clickEvent);

    expect(onOpenWebLinkInSidebar).toHaveBeenCalledWith("https://x.com/kylejeong/status/123");
  });

  it("detects supported X link hosts without matching unrelated x domains", () => {
    expect(isXComLink("https://x.com/user/status/1")).toBe(true);
    expect(isXComLink("https://mobile.twitter.com/user/status/1")).toBe(true);
    expect(isXComLink("https://x.ai")).toBe(false);
  });

  it("does not rewrite non-citation sources text that only contains pipes", () => {
    const input = "Sources: see table | see appendix";
    expect(normalizeSourcesSection(input)).toBe(input);
  });

  it("splits numbered source entries onto separate lines", () => {
    const input = "Sources: [1] https://example.com | [2] https://example.org";
    const output = normalizeSourcesSection(input);

    expect(output).toContain("Sources: [1] https://example.com  \n[2] https://example.org");
  });

  it("autolinks legitimate bare domains while avoiding common abbreviations", () => {
    expect(autolinkBareDomains("Visit learn.microsoft.com for docs.")).toBe(
      "Visit [learn.microsoft.com](https://learn.microsoft.com) for docs.",
    );
    expect(autolinkBareDomains("Examples include e.g. and i.e. but not no.op.")).toBe(
      "Examples include e.g. and i.e. but not no.op.",
    );
  });

  it("autolinks bare domain URLs from the markdown utility module", () => {
    expect(autolinkBareUrls("Read spectrum.ieee.org/quantum for context.")).toBe(
      "Read [spectrum.ieee.org/quantum](https://spectrum.ieee.org/quantum) for context.",
    );
  });

  it("autolinks bracketed URLs without touching citation indices", () => {
    expect(autolinkUrlsInBrackets("Use [learn.microsoft.com] and [https://example.com/path].")).toBe(
      "Use [learn.microsoft.com](https://learn.microsoft.com) and [https://example.com/path](https://example.com/path).",
    );
    expect(autolinkUrlsInBrackets("Citations like [1] stay unchanged.")).toBe(
      "Citations like [1] stay unchanged.",
    );
  });

  it("trims trailing blank lines from diff code blocks only", () => {
    expect(normalizeCodeBlockTextForDisplay("- old\n+ new\n\n\n", "diff")).toBe("- old\n+ new");
    expect(normalizeCodeBlockTextForDisplay("line\n\n", "typescript")).toBe("line\n\n");
  });

  it("snaps collapsed user bubbles to a fully visible text line", () => {
    expect(resolveSafeCollapsedBubbleHeight([42, 88, 136, 184, 231], 220, 96)).toBe(184);
    expect(resolveSafeCollapsedBubbleHeight([42, 88], 220, 96)).toBe(96);
    expect(resolveSafeCollapsedBubbleHeight([], 220, 96)).toBe(220);
  });

  it("reuses the current chat task for follow-up messages", () => {
    expect(
      shouldCreateFreshTaskForSend({
        executionMode: "chat",
        selectedTaskId: "task-1",
        selectedTaskExecutionMode: "chat",
      }),
    ).toBe(false);
    expect(
      shouldCreateFreshTaskForSend({
        executionMode: "chat",
        selectedTaskId: "task-1",
        selectedTaskExecutionMode: "execute",
      }),
    ).toBe(false);
    expect(
      shouldCreateFreshTaskForSend({
        executionMode: "chat",
        selectedTaskId: null,
      }),
    ).toBe(true);
    expect(
      shouldCreateFreshTaskForSend({
        executionMode: "execute",
        selectedTaskId: "task-1",
        selectedTaskExecutionMode: "execute",
      }),
    ).toBe(false);
  });

  it("builds a quoted assistant payload from visible assistant text", () => {
    expect(
      createQuotedAssistantMessage("**Result:** done", "event-1", "550e8400-e29b-41d4-a716-446655440000"),
    ).toEqual({
      eventId: "event-1",
      taskId: "550e8400-e29b-41d4-a716-446655440000",
      message: "**Result:** done",
    });
    expect(createQuotedAssistantMessage("   ")).toBeNull();
  });

  it("preserves quote preview line breaks so markdown tables render", () => {
    const preview = normalizeQuotedAssistantMarkdownPreview(
      [
        "For this check, the result is:",
        "| Signal | Status |",
        "| --- | --- |",
        "| **Repetitive promotional blasts** | Not assessable |",
      ].join("\n"),
      420,
    );
    const markup = renderToStaticMarkup(
      createElement(
        "div",
        { className: "markdown-content" },
        createElement(
          MarkdownRenderer,
          { components: buildMarkdownComponents({}), children: preview },
        ),
      ),
    );

    expect(preview).toContain("\n| Signal | Status |");
    expect(markup).toContain("<table");
    expect(markup).toContain("<strong>Repetitive promotional blasts</strong>");
    expect(markup).not.toContain("| --- | --- |");
  });

  it("does not truncate quoted markdown before rendering by default", () => {
    const preview = normalizeQuotedAssistantMarkdownPreview(
      [
        "For this check, the result is:",
        "| Signal | Status |",
        "| --- | --- |",
        "| Repetitive promotional blasts | Not assessable |",
        "| Clickbait or fake urgency | Not assessable |",
      ].join("\n"),
    );
    const markup = renderToStaticMarkup(
      createElement(
        "div",
        { className: "markdown-content" },
        createElement(
          MarkdownRenderer,
          { components: buildMarkdownComponents({}), children: preview },
        ),
      ),
    );

    expect(markup).toContain("<table");
    expect(markup).toContain("Clickbait or fake urgency");
  });
});
