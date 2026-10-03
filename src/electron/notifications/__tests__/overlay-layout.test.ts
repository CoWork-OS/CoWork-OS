import { describe, expect, it } from "vitest";
import { getOverlayLayout } from "../overlay-layout";

const bounds = { x: 0, y: 0, width: 1440, height: 900 };

describe("Dock overlay placement", () => {
  it("centers above a bottom Dock and stacks upwards", () => {
    const display = { bounds, workArea: { x: 0, y: 25, width: 1440, height: 800 } };
    const first = getOverlayLayout(display, "near-dock", 0);
    const second = getOverlayLayout(display, "near-dock", 1);
    expect(first.x + first.width / 2).toBe(720);
    expect(first.y + first.height).toBe(809);
    expect(second.y + second.height).toBeLessThan(first.y);
  });

  it.each(["left", "right"])("reserves space for a %s Dock", (side) => {
    const display = {
      bounds,
      workArea: { x: side === "left" ? 80 : 0, y: 25, width: 1360, height: 875 },
    };
    const card = getOverlayLayout(display, "near-dock", 0);
    if (side === "left") expect(card.x).toBe(96);
    else expect(card.x + card.width).toBe(1344);
  });

  it("handles an auto-hidden Dock on a display with negative coordinates", () => {
    const display = {
      bounds: { x: -1600, y: -900, width: 1600, height: 900 },
      workArea: { x: -1600, y: -875, width: 1600, height: 875 },
    };
    const card = getOverlayLayout(display, "near-dock", 0);
    expect(card.x + card.width / 2).toBe(-800);
    expect(card.y + card.height).toBe(-16);
  });

  it("keeps cards inside a small work area", () => {
    const display = { bounds, workArea: { x: 100, y: 40, width: 320, height: 180 } };
    const card = getOverlayLayout(display, "near-dock", 4);
    expect(card.x).toBeGreaterThanOrEqual(100);
    expect(card.y).toBeGreaterThanOrEqual(40);
    expect(card.x + card.width).toBeLessThanOrEqual(420);
    expect(card.y + card.height).toBeLessThanOrEqual(220);
  });

  it("retains a top-right placement for system notification fallback", () => {
    const display = { bounds, workArea: { x: 0, y: 25, width: 1440, height: 800 } };
    const card = getOverlayLayout(display, "system", 0);
    expect(card.x + card.width).toBe(1424);
    expect(card.y).toBe(33);
  });
});
