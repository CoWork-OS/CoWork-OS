import type { ReactElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createPdfDocumentRenderer, type PdfPageRender } from "../pdf-document-renderer";
import { PDFDocumentSurface } from "../PDFDocumentSurface";

// This suite exercises the surface's state/effect/ref wiring without a DOM or
// PDF worker. The renderer tests separately exercise loading and actual calls
// into the page/canvas boundary.
const hooks = vi.hoisted(() => {
  let cursor = 0;
  let slots: Array<{
    value?: unknown;
    deps?: unknown[];
    cleanup?: () => void;
  }> = [];
  let effects: Array<() => void> = [];
  const changed = (before: unknown[] | undefined, after: unknown[]) =>
    !before ||
    before.length !== after.length ||
    after.some((value, index) => !Object.is(value, before[index]));
  return {
    reset() {
      slots = [];
      effects = [];
      cursor = 0;
    },
    begin() {
      cursor = 0;
    },
    commit() {
      const pending = effects;
      effects = [];
      pending.forEach((effect) => effect());
    },
    useRef(value: unknown) {
      const slot = (slots[cursor++] ??= { value: { current: value } });
      return slot.value;
    },
    useState(value: unknown) {
      const slot = (slots[cursor++] ??= { value });
      return [
        slot.value,
        (next: unknown) => {
          slot.value = typeof next === "function" ? next(slot.value) : next;
        },
      ];
    },
    useMemo(create: () => unknown, deps: unknown[]) {
      const slot = (slots[cursor++] ??= {});
      if (changed(slot.deps, deps)) {
        slot.value = create();
        slot.deps = deps;
      }
      return slot.value;
    },
    useEffect(effect: () => (() => void) | undefined, deps: unknown[]) {
      const slot = (slots[cursor++] ??= {});
      if (changed(slot.deps, deps)) {
        slot.deps = deps;
        effects.push(() => {
          slot.cleanup?.();
          slot.cleanup = effect();
        });
      }
    },
  };
});

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useRef: hooks.useRef,
  useState: hooks.useState,
  useMemo: hooks.useMemo,
  useEffect: hooks.useEffect,
}));
vi.mock("../pdf-document-renderer", () => ({ createPdfDocumentRenderer: vi.fn() }));

function elements(tree: unknown): ReactElement<Record<string, unknown>>[] {
  if (Array.isArray(tree)) return tree.flatMap(elements);
  if (!tree || typeof tree !== "object" || !("props" in tree)) return [];
  const element = tree as ReactElement<Record<string, unknown>>;
  return [element, ...elements(element.props.children)];
}

const baseProps = {
  fileName: "dinner.pdf",
  pdfDataBase64: "ZGlubmVy",
  selection: null,
  onSelectionChange: () => {},
};
const page = (mountCanvas = vi.fn()): PdfPageRender => ({
  width: 750,
  height: 990,
  textItems: [],
  mountCanvas,
});
const render = (props: Parameters<typeof PDFDocumentSurface>[0] = baseProps) => {
  hooks.begin();
  const tree = PDFDocumentSurface(props);
  hooks.commit();
  return elements(tree);
};

beforeEach(() => {
  hooks.reset();
  vi.mocked(createPdfDocumentRenderer).mockReset();
  vi.mocked(createPdfDocumentRenderer).mockImplementation(() => ({
    ready: Promise.resolve(),
    dispose: vi.fn(),
  }));
});

describe("PDF surface lifecycle wiring", () => {
  it("mounts loaded page canvases with their render callbacks", () => {
    expect(render().some((node) => node.type === "canvas")).toBe(false);
    const first = page();
    vi.mocked(createPdfDocumentRenderer).mock.calls[0][0].onPages([first]);
    const canvas = render().find((node) => node.type === "canvas");
    expect(canvas?.props.ref).toBe(first.mountCanvas);
  });

  it("keeps loaded pages across selection changes and uses the latest parent callback", () => {
    const oldPageCount = vi.fn();
    const latestPageCount = vi.fn();
    render({ ...baseProps, onPageCountChange: oldPageCount });
    render({ ...baseProps, onPageCountChange: latestPageCount });
    const first = page();
    vi.mocked(createPdfDocumentRenderer).mock.calls[0][0].onPages([first]);
    const selected = render({
      ...baseProps,
      onPageCountChange: latestPageCount,
      selection: { kind: "pdf", pageIndex: 0, x: 0.1, y: 0.2, w: 0.3, h: 0.4, excerpt: "Dinner" },
    });
    expect(createPdfDocumentRenderer).toHaveBeenCalledOnce();
    expect(oldPageCount).not.toHaveBeenCalled();
    expect(latestPageCount).toHaveBeenCalledWith(1);
    expect(selected.find((node) => node.type === "canvas")?.props.ref).toBe(first.mountCanvas);
    expect(selected.some((node) => node.props.className === "pdf-selection-box")).toBe(true);
  });

  it("mounts the newly selected page without reloading the PDF", () => {
    render({ ...baseProps, visiblePageIndex: 0 });
    const pages = [page(), page()];
    vi.mocked(createPdfDocumentRenderer).mock.calls[0][0].onPages(pages);
    expect(
      render({ ...baseProps, visiblePageIndex: 0 }).find((node) => node.type === "canvas")?.props
        .ref,
    ).toBe(pages[0].mountCanvas);
    expect(
      render({ ...baseProps, visiblePageIndex: 1 }).find((node) => node.type === "canvas")?.props
        .ref,
    ).toBe(pages[1].mountCanvas);
    expect(createPdfDocumentRenderer).toHaveBeenCalledOnce();
  });

  it("disposes the old source and surfaces drawing errors", () => {
    render();
    const oldRenderer = vi.mocked(createPdfDocumentRenderer).mock.results[0].value;
    render({ ...baseProps, pdfDataBase64: "bmV3" });
    expect(oldRenderer.dispose).toHaveBeenCalledOnce();
    expect(createPdfDocumentRenderer).toHaveBeenCalledTimes(2);
    vi.mocked(createPdfDocumentRenderer).mock.calls[1][0].onError("PDF drawing failed");
    const nodes = render({ ...baseProps, pdfDataBase64: "bmV3" });
    expect(
      nodes.find((node) => node.props.className === "document-editor-error")?.props.children,
    ).toBe("PDF drawing failed");
    expect(nodes.some((node) => node.type === "canvas")).toBe(false);
  });
});
