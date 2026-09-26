import { describe, expect, it } from "vitest";
import {
  clampResizableSidebarWidth,
  getResizableSidebarWidthConstraints,
} from "../resizable-sidebar-layout";

describe("resizable sidebar layout", () => {
  it("keeps the main column at its minimum when the container is narrow", () => {
    expect(getResizableSidebarWidthConstraints(700)).toEqual({ minWidth: 302, maxWidth: 302 });
    expect(clampResizableSidebarWidth(420, 700)).toBe(302);
  });

  it("retains the standard sidebar minimum when the container has room", () => {
    expect(getResizableSidebarWidthConstraints(818)).toEqual({ minWidth: 420, maxWidth: 420 });
    expect(clampResizableSidebarWidth(720, 1200)).toBe(720);
  });

  it("does not allocate width to the sidebar when the main column and divider cannot fit", () => {
    expect(getResizableSidebarWidthConstraints(390)).toEqual({ minWidth: 0, maxWidth: 0 });
    expect(clampResizableSidebarWidth(420, 390)).toBe(0);
  });
});
