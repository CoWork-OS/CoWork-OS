import type { AnchorHTMLAttributes, MouseEvent, ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import { describe, expect, it, vi } from "vitest";
import { buildFileViewerMarkdownComponents } from "../file-viewer-markdown";

function preview(filePath = "/workspace/README.md") {
  const onOpenFile = vi.fn();
  const onOpenExternal = vi.fn(async (_url: string) => undefined);
  const onError = vi.fn();
  const components = buildFileViewerMarkdownComponents({
    filePath,
    onOpenFile,
    onOpenExternal,
    onError,
  });
  const Link = components.a as (
    props: AnchorHTMLAttributes<HTMLAnchorElement>,
  ) => ReactElement<AnchorHTMLAttributes<HTMLAnchorElement>>;
  const click = (href?: string) => {
    const event = {
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    } as unknown as MouseEvent<HTMLAnchorElement>;
    Link({ href, children: "Open" }).props.onClick!(event);
    return event;
  };
  return { components, click, onOpenFile, onOpenExternal, onError };
}

describe("file preview Markdown navigation", () => {
  it("opens a README-relative document without navigating the app", () => {
    const view = preview();
    const event = view.click("docs/what-you-own.md");
    expect(event.preventDefault).toHaveBeenCalledOnce();
    expect(view.onOpenFile).toHaveBeenCalledWith("/workspace/docs/what-you-own.md");
    expect(view.onOpenExternal).not.toHaveBeenCalled();
  });

  it("resolves parent paths from a nested document and decodes file names", () => {
    const view = preview("/workspace/docs/guide.md");
    view.click("../reports/Our%20Plan.pdf#summary");
    expect(view.onOpenFile).toHaveBeenCalledWith("/workspace/reports/Our Plan.pdf");
  });

  it("preserves reserved characters in the document directory", () => {
    const view = preview("/workspace/100% ready #1?/README.md");
    view.click("next.md");
    expect(view.onOpenFile).toHaveBeenCalledWith("/workspace/100% ready #1?/next.md");
  });

  it("supports Windows paths without treating the drive as a URL scheme", () => {
    const view = preview("C:\\workspace\\docs\\guide.md");
    view.click("../report.md");
    expect(view.onOpenFile).toHaveBeenCalledWith("C:/workspace/report.md");
    view.click("C:\\workspace\\README.md");
    expect(view.onOpenFile).toHaveBeenLastCalledWith("C:/workspace/README.md");
  });

  it.each(["https://example.com/docs", "mailto:help@example.com", "//example.com/docs"])(
    "opens an external link through the host handler: %s",
    (href) => {
      const view = preview();
      const event = view.click(href);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(view.onOpenExternal).toHaveBeenCalledWith(
        href.startsWith("//") ? `https:${href}` : href,
      );
      expect(view.onOpenFile).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, "", "javascript:alert(1)", "data:text/html,hello", "\\\\server\\share"])(
    "prevents navigation for an empty or unsupported destination: %s",
    (href) => {
      const view = preview();
      const event = view.click(href);
      expect(event.preventDefault).toHaveBeenCalledOnce();
      expect(view.onOpenFile).not.toHaveBeenCalled();
      expect(view.onOpenExternal).not.toHaveBeenCalled();
    },
  );

  it("leaves in-page fragments as fragment navigation", () => {
    const view = preview();
    expect(view.click("#summary").preventDefault).not.toHaveBeenCalled();
    expect(view.onOpenFile).not.toHaveBeenCalled();
  });

  it("reports malformed encoded file links without navigating", () => {
    const view = preview();
    view.click("broken%ZZ.md");
    expect(view.onOpenFile).not.toHaveBeenCalled();
    expect(view.onError).toHaveBeenCalledOnce();
  });

  it("reports a rejected external open", async () => {
    const view = preview();
    const error = new Error("Cannot open this URL");
    view.onOpenExternal.mockRejectedValueOnce(error);
    view.click("https://example.com");
    await Promise.resolve();
    expect(view.onError).toHaveBeenCalledWith(error);
  });

  it("keeps ReactMarkdown's unsafe-protocol filter", () => {
    const view = preview();
    const markup = renderToStaticMarkup(
      <ReactMarkdown components={view.components}>{"[Open](javascript:alert)"}</ReactMarkdown>,
    );
    expect(markup).not.toContain("javascript:");
  });
});
