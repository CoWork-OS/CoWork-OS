import { describe, expect, it } from "vitest";
import { OCCLUDING_OVERLAY_SELECTOR, rectsOverlap } from "../useSurfaceOcclusion";

describe("native tab occlusion", () => {
  it("treats touching edges as clear and any shared area as covered", () => {
    const surface = { left: 0, top: 100, right: 800, bottom: 600 };
    expect(rectsOverlap({ left: 700, top: 40, right: 900, bottom: 140 }, surface)).toBe(true);
    expect(rectsOverlap({ left: 0, top: 40, right: 800, bottom: 100 }, surface)).toBe(false);
    expect(rectsOverlap({ left: 801, top: 200, right: 900, bottom: 300 }, surface)).toBe(false);
  });

  it("watches menus, popups, dialogs and toasts", () => {
    for (const selector of ['[role="menu"]', '[role="listbox"]', '[aria-modal="true"]', ".toast"]) {
      expect(OCCLUDING_OVERLAY_SELECTOR).toContain(selector);
    }
  });
});
