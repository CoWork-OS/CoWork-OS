import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { prefersReducedMotion, scrollBehavior, suppressMotionBriefly } from "../motion";

function stubWindow(reduced: boolean) {
  vi.stubGlobal("window", { matchMedia: () => ({ matches: reduced }) });
}

describe("motion helpers", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("scrolls smoothly unless reduced motion is on", () => {
    stubWindow(false);
    expect(prefersReducedMotion()).toBe(false);
    expect(scrollBehavior()).toBe("smooth");

    stubWindow(true);
    expect(prefersReducedMotion()).toBe(true);
    expect(scrollBehavior()).toBe("auto");
  });

  it("treats a missing window as full motion", () => {
    expect(prefersReducedMotion()).toBe(false);
  });

  describe("suppressMotionBriefly", () => {
    let classes: Set<string>;

    beforeEach(() => {
      vi.useFakeTimers();
      classes = new Set();
      vi.stubGlobal("document", {
        documentElement: {
          classList: {
            add: (name: string) => classes.add(name),
            remove: (name: string) => classes.delete(name),
          },
        },
      });
    });

    it("flags the document, then clears the flag", () => {
      suppressMotionBriefly(1000);
      expect(classes.has("motion-instant")).toBe(true);
      vi.advanceTimersByTime(999);
      expect(classes.has("motion-instant")).toBe(true);
      vi.advanceTimersByTime(1);
      expect(classes.has("motion-instant")).toBe(false);
    });

    it("extends the window when called again", () => {
      suppressMotionBriefly(1000);
      vi.advanceTimersByTime(800);
      suppressMotionBriefly(1000);
      vi.advanceTimersByTime(800);
      expect(classes.has("motion-instant")).toBe(true);
      vi.advanceTimersByTime(200);
      expect(classes.has("motion-instant")).toBe(false);
    });
  });
});
