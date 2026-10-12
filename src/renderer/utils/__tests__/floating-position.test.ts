import { describe, expect, it } from "vitest";
import { getFloatingPosition } from "../floating-position";

describe("getFloatingPosition", () => {
  it("opens above a trigger near the bottom edge", () => {
    const result = getFloatingPosition(
      { top: 560, bottom: 590, right: 790 },
      { width: 250, height: 180 },
      { width: 800, height: 600 },
    );
    expect(result).toEqual({ top: 372, left: 538, width: 250, maxHeight: 576 });
  });
  it("shrinks a wide menu and clamps an oversized panel inside a short viewport", () => {
    const result = getFloatingPosition(
      { top: 40, bottom: 60, right: 50 },
      { width: 380, height: 420 },
      { width: 220, height: 160 },
    );
    expect(result).toEqual({ top: 12, left: 12, width: 196, maxHeight: 136 });
  });
  it("opens below when there is room", () => {
    expect(
      getFloatingPosition(
        { top: 40, bottom: 60, right: 400 },
        { width: 250, height: 180 },
        { width: 800, height: 600 },
      ).top,
    ).toBe(68);
  });
});
