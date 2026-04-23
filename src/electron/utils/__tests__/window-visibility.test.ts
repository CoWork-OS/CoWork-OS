import { describe, expect, it, vi } from "vitest";
import { revealWindow, type RevealableWindow } from "../window-visibility";

function createWindowMock(overrides: Partial<RevealableWindow> = {}): RevealableWindow {
  return {
    isDestroyed: vi.fn(() => false),
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    isVisible: vi.fn(() => true),
    show: vi.fn(),
    focus: vi.fn(),
    ...overrides,
  };
}

describe("revealWindow", () => {
  it("returns false for a missing window", () => {
    expect(revealWindow(null)).toBe(false);
  });

  it("shows a hidden window before focusing it", () => {
    const window = createWindowMock({
      isVisible: vi.fn(() => false),
    });

    expect(revealWindow(window)).toBe(true);
    expect(window.show).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("restores a minimized window before focusing it", () => {
    const window = createWindowMock({
      isMinimized: vi.fn(() => true),
    });

    expect(revealWindow(window)).toBe(true);
    expect(window.restore).toHaveBeenCalledOnce();
    expect(window.focus).toHaveBeenCalledOnce();
  });

  it("does nothing for a destroyed window", () => {
    const window = createWindowMock({
      isDestroyed: vi.fn(() => true),
    });

    expect(revealWindow(window)).toBe(false);
    expect(window.restore).not.toHaveBeenCalled();
    expect(window.show).not.toHaveBeenCalled();
    expect(window.focus).not.toHaveBeenCalled();
  });
});
