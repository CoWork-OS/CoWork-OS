import { describe, expect, it } from "vitest";

import { computeEmailFitScale, getEmailFitInset, measureEmailContentWidth } from "../email-html-layout";

function createMockElement(
  metrics: Partial<{
    left: number;
    right: number;
    width: number;
    scrollWidth: number;
    offsetWidth: number;
  }>,
): HTMLElement {
  const element = {
    querySelectorAll: () => [],
  } as unknown as HTMLElement;
  setElementMetrics(element, metrics);
  return element;
}

function createMockDocument(bodyScrollWidth = 0, documentScrollWidth = 0): Document {
  return {
    body: createMockElement({ width: bodyScrollWidth, scrollWidth: bodyScrollWidth }),
    documentElement: createMockElement({ width: documentScrollWidth, scrollWidth: documentScrollWidth }),
  } as unknown as Document;
}

function setElementMetrics(
  element: HTMLElement,
  metrics: Partial<{
    left: number;
    right: number;
    width: number;
    scrollWidth: number;
    offsetWidth: number;
  }>,
) {
  const left = metrics.left ?? 0;
  const width = metrics.width ?? Math.max(0, (metrics.right ?? 0) - left);
  const right = metrics.right ?? left + width;

  Object.defineProperty(element, "scrollWidth", {
    configurable: true,
    value: metrics.scrollWidth ?? width,
  });
  Object.defineProperty(element, "offsetWidth", {
    configurable: true,
    value: metrics.offsetWidth ?? width,
  });
  element.getBoundingClientRect = () =>
    ({
      x: left,
      y: 0,
      left,
      top: 0,
      right,
      bottom: 0,
      width,
      height: 0,
      toJSON: () => undefined,
    }) as DOMRect;
}

describe("measureEmailContentWidth", () => {
  it("uses descendant painted bounds when fixed-width email tables overflow the root", () => {
    const doc = createMockDocument();
    const invoice = createMockElement({ left: 80, width: 640, right: 720, scrollWidth: 640 });
    const root = createMockElement({ left: 0, width: 500, scrollWidth: 500 });
    root.querySelectorAll = () => [invoice] as unknown as NodeListOf<HTMLElement>;

    expect(measureEmailContentWidth(doc, root)).toBe(720);
  });

  it("accounts for nested element scroll width when the painted rect is constrained", () => {
    const doc = createMockDocument();
    const wideCell = createMockElement({ left: 120, width: 300, scrollWidth: 760 });
    const root = createMockElement({ left: 20, width: 520, scrollWidth: 520 });
    root.querySelectorAll = () => [wideCell] as unknown as NodeListOf<HTMLElement>;

    expect(measureEmailContentWidth(doc, root)).toBe(860);
  });

  it("ignores missing element layout fields without poisoning the measurement", () => {
    const doc = createMockDocument();
    const vector = {
      scrollWidth: undefined,
      offsetWidth: undefined,
      getBoundingClientRect: () =>
        ({
          left: 40,
          right: 220,
          width: 180,
        }) as DOMRect,
    } as unknown as HTMLElement;
    const root = createMockElement({ left: 0, width: 500, scrollWidth: 500 });
    root.querySelectorAll = () => [vector] as unknown as NodeListOf<HTMLElement>;

    expect(measureEmailContentWidth(doc, root)).toBe(500);
  });
});

describe("computeEmailFitScale", () => {
  it("adds a safety inset when an email fills the available width", () => {
    expect(computeEmailFitScale(1400, 1400)).toBeCloseTo(0.9314, 4);
  });

  it("shrinks over-wide emails by content width plus the safety inset", () => {
    expect(computeEmailFitScale(1000, 1250)).toBeCloseTo(0.744, 4);
  });

  it("returns neutral scale when the iframe has no measurable width", () => {
    expect(computeEmailFitScale(0, 1250)).toBe(1);
  });
});

describe("getEmailFitInset", () => {
  it("keeps a practical right-side reading margin for wide invoices", () => {
    expect(getEmailFitInset(1400)).toBe(96);
  });

  it("keeps a minimum inset for narrow panels", () => {
    expect(getEmailFitInset(320)).toBe(40);
  });
});
