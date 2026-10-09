import { describe, expect, it } from "vitest";
import { matchBrowserShortcut } from "../browser-shortcuts";

const mac = (key: string, extra: Record<string, unknown> = {}) =>
  matchBrowserShortcut({ key, meta: true, ...extra }, "darwin");
const win = (key: string, extra: Record<string, unknown> = {}) =>
  matchBrowserShortcut({ key, ctrl: true, ...extra }, "win32");

describe("browser shortcuts", () => {
  it("maps the browser chords with the platform's primary modifier", () => {
    expect(mac("t")).toBe("new-tab");
    expect(mac("T", { shift: true })).toBe("reopen-tab");
    expect(mac("w")).toBe("close-tab");
    expect(mac("l")).toBe("focus-address");
    expect(mac("r")).toBe("reload");
    expect(mac("R", { shift: true })).toBe("hard-reload");
    expect(mac("f")).toBe("find");
    expect(mac("g")).toBe("find-next");
    expect(mac("G", { shift: true })).toBe("find-previous");
    expect(mac("B", { shift: true })).toBe("toggle-full-view");
    expect(win("t")).toBe("new-tab");
    expect(win("w")).toBe("close-tab");
  });

  it("maps brackets, digits and zoom keys by physical key", () => {
    expect(mac("[", { code: "BracketLeft" })).toBe("back");
    expect(mac("]", { code: "BracketRight" })).toBe("forward");
    expect(mac("{", { code: "BracketLeft", shift: true })).toBe("previous-tab");
    expect(mac("}", { code: "BracketRight", shift: true })).toBe("next-tab");
    expect(mac("1", { code: "Digit1" })).toBe("select-tab-1");
    expect(mac("9", { code: "Digit9" })).toBe("select-last-tab");
    expect(mac("0", { code: "Digit0" })).toBe("zoom-reset");
    expect(mac("=", { code: "Equal" })).toBe("zoom-in");
    expect(mac("+", { code: "Equal", shift: true })).toBe("zoom-in");
    expect(mac("-", { code: "Minus" })).toBe("zoom-out");
  });

  it("switches tabs with Ctrl+Tab everywhere and Alt+arrows off macOS", () => {
    expect(matchBrowserShortcut({ key: "Tab", ctrl: true }, "darwin")).toBe("next-tab");
    expect(matchBrowserShortcut({ key: "Tab", ctrl: true, shift: true }, "linux")).toBe(
      "previous-tab",
    );
    expect(matchBrowserShortcut({ key: "ArrowLeft", alt: true }, "win32")).toBe("back");
    expect(matchBrowserShortcut({ key: "ArrowLeft", alt: true }, "darwin")).toBeNull();
  });

  it("leaves page shortcuts and other modifiers alone", () => {
    expect(mac("k")).toBeNull();
    expect(mac("c")).toBeNull();
    expect(mac("t", { alt: true })).toBeNull();
    // Control is not the primary modifier on macOS.
    expect(matchBrowserShortcut({ key: "t", ctrl: true }, "darwin")).toBeNull();
    expect(matchBrowserShortcut({ key: "t", meta: true }, "win32")).toBeNull();
    expect(matchBrowserShortcut({ key: "t" }, "darwin")).toBeNull();
    expect(matchBrowserShortcut({ key: "Escape" }, "darwin")).toBeNull();
  });
});
