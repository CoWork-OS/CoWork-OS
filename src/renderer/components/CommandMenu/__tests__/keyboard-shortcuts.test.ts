import { describe, expect, it } from "vitest";
import {
  buildKeyboardShortcuts,
  isNextAttentionShortcut,
  isShortcutListShortcut,
  sessionPositionFromShortcut,
  type KeyChord,
} from "../keyboard-shortcuts";

function chord(overrides: Partial<KeyChord>): KeyChord {
  return {
    key: "",
    code: "",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...overrides,
  };
}

describe("shortcut list", () => {
  it("shows Mac keys on Mac and Ctrl/Alt keys elsewhere", () => {
    const mac = buildKeyboardShortcuts(true);
    const other = buildKeyboardShortcuts(false);
    expect(mac.find((s) => s.id === "command-menu")?.keys).toBe("⌘K");
    expect(other.find((s) => s.id === "command-menu")?.keys).toBe("Ctrl+K");
    expect(mac.find((s) => s.id === "session-position")?.keys).toContain("⌃1");
    expect(other.find((s) => s.id === "session-position")?.keys).toContain("Alt+1");
  });

  it("leaves Mac-only menu shortcuts out on Windows and Linux", () => {
    const mac = buildKeyboardShortcuts(true).map((s) => s.id);
    const other = buildKeyboardShortcuts(false).map((s) => s.id);
    expect(mac).toContain("new-session");
    expect(mac).toContain("settings");
    expect(other).not.toContain("new-session");
    expect(other).not.toContain("settings");
  });

  it("has unique ids and says where each shortcut works", () => {
    const list = buildKeyboardShortcuts(true);
    expect(new Set(list.map((s) => s.id)).size).toBe(list.length);
    for (const shortcut of list) {
      expect(shortcut.title).not.toBe("");
      expect(shortcut.where).not.toBe("");
      expect(shortcut.keys).not.toBe("");
    }
  });
});

describe("shortcut list chord", () => {
  it("is Cmd or Ctrl with /, even when the layout needs Shift for /", () => {
    expect(isShortcutListShortcut(chord({ key: "/", metaKey: true }))).toBe(true);
    expect(isShortcutListShortcut(chord({ key: "/", ctrlKey: true }))).toBe(true);
    expect(isShortcutListShortcut(chord({ key: "/", ctrlKey: true, shiftKey: true }))).toBe(true);
    expect(isShortcutListShortcut(chord({ key: "?", metaKey: true, shiftKey: true }))).toBe(false);
    expect(isShortcutListShortcut(chord({ key: "/", metaKey: true, altKey: true }))).toBe(false);
    expect(isShortcutListShortcut(chord({ key: "/" }))).toBe(false);
  });
});

describe("next session that needs you chord", () => {
  it("is Cmd+Shift+U on Mac and Ctrl+Shift+U elsewhere", () => {
    expect(
      isNextAttentionShortcut(chord({ code: "KeyU", metaKey: true, shiftKey: true }), true),
    ).toBe(true);
    expect(
      isNextAttentionShortcut(chord({ code: "KeyU", ctrlKey: true, shiftKey: true }), true),
    ).toBe(false);
    expect(
      isNextAttentionShortcut(chord({ code: "KeyU", ctrlKey: true, shiftKey: true }), false),
    ).toBe(true);
    expect(isNextAttentionShortcut(chord({ code: "KeyU", ctrlKey: true }), false)).toBe(false);
  });
});

describe("session position chord", () => {
  it("is Ctrl+digit on Mac, leaving Cmd+digit to the rail and Option+digit to typing", () => {
    expect(sessionPositionFromShortcut(chord({ code: "Digit3", ctrlKey: true }), true)).toBe(3);
    expect(sessionPositionFromShortcut(chord({ code: "Digit3", metaKey: true }), true)).toBeNull();
    expect(sessionPositionFromShortcut(chord({ code: "Digit3", altKey: true }), true)).toBeNull();
  });

  it("is Alt+digit on Windows and Linux, leaving Ctrl+digit to the rail", () => {
    expect(sessionPositionFromShortcut(chord({ code: "Digit9", altKey: true }), false)).toBe(9);
    expect(sessionPositionFromShortcut(chord({ code: "Digit1", ctrlKey: true }), false)).toBeNull();
  });

  it("ignores 0, Shift, and keys that are not top-row digits", () => {
    expect(sessionPositionFromShortcut(chord({ code: "Digit0", ctrlKey: true }), true)).toBeNull();
    expect(
      sessionPositionFromShortcut(chord({ code: "Digit2", ctrlKey: true, shiftKey: true }), true),
    ).toBeNull();
    expect(sessionPositionFromShortcut(chord({ code: "Numpad2", ctrlKey: true }), true)).toBeNull();
  });
});
