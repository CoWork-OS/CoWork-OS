/**
 * Keyboard shortcuts of the in-app browser workbench.
 *
 * Shared by the main process (which intercepts them in browser pages and in
 * the app window while the workbench has focus, before app menu accelerators
 * like Cmd+R or Cmd+W fire) and the renderer (which runs the command). Only
 * these exact chords are taken; every other key reaches the page.
 */

export type BrowserShortcutCommand =
  | "new-tab"
  | "close-tab"
  | "reopen-tab"
  | "next-tab"
  | "previous-tab"
  | "select-tab-1"
  | "select-tab-2"
  | "select-tab-3"
  | "select-tab-4"
  | "select-tab-5"
  | "select-tab-6"
  | "select-tab-7"
  | "select-tab-8"
  | "select-last-tab"
  | "focus-address"
  | "reload"
  | "hard-reload"
  | "back"
  | "forward"
  | "find"
  | "find-next"
  | "find-previous"
  | "zoom-in"
  | "zoom-out"
  | "zoom-reset"
  | "toggle-full-view";

export type BrowserShortcutInput = {
  key: string;
  code?: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
  alt?: boolean;
};

const DIGIT_COMMANDS: Record<string, BrowserShortcutCommand> = {
  "1": "select-tab-1",
  "2": "select-tab-2",
  "3": "select-tab-3",
  "4": "select-tab-4",
  "5": "select-tab-5",
  "6": "select-tab-6",
  "7": "select-tab-7",
  "8": "select-tab-8",
  "9": "select-last-tab",
};

function digitOf(input: BrowserShortcutInput): string {
  const fromCode = /^Digit([0-9])$/.exec(input.code || "")?.[1];
  if (fromCode) return fromCode;
  return /^[0-9]$/.test(input.key) ? input.key : "";
}

/**
 * The browser command for a key chord, or null. `platform` decides the primary
 * modifier: Command on macOS, Control elsewhere.
 */
export function matchBrowserShortcut(
  input: BrowserShortcutInput,
  platform: string,
): BrowserShortcutCommand | null {
  const mac = platform === "darwin";
  const mod = mac ? input.meta === true : input.ctrl === true;
  // On macOS a Control chord is never the primary modifier (except Ctrl+Tab).
  const otherModifier = mac ? input.ctrl === true : input.meta === true;
  const shift = input.shift === true;
  const alt = input.alt === true;
  const key = String(input.key || "");
  const lower = key.length === 1 ? key.toLowerCase() : key;
  const code = input.code || "";

  // Ctrl+Tab / Ctrl+Shift+Tab switch tabs on every platform.
  if (key === "Tab" && input.ctrl === true && !alt && !(mac && input.meta)) {
    return shift ? "previous-tab" : "next-tab";
  }
  // Alt+Left/Right go back/forward on Windows and Linux.
  if (!mac && alt && !input.ctrl && !input.meta && !shift) {
    if (key === "ArrowLeft") return "back";
    if (key === "ArrowRight") return "forward";
  }
  if (!mod || otherModifier || alt) return null;

  const digit = digitOf(input);
  if (digit && !shift && DIGIT_COMMANDS[digit]) return DIGIT_COMMANDS[digit];
  if (digit === "0" && !shift) return "zoom-reset";

  if (code === "BracketLeft" || key === "[" || key === "{") {
    return shift ? "previous-tab" : "back";
  }
  if (code === "BracketRight" || key === "]" || key === "}") {
    return shift ? "next-tab" : "forward";
  }
  if (code === "Equal" || key === "=" || key === "+") return "zoom-in";
  if (code === "Minus" || key === "-" || key === "_") return shift ? null : "zoom-out";

  switch (lower) {
    case "t":
      return shift ? "reopen-tab" : "new-tab";
    case "w":
      return shift ? null : "close-tab";
    case "l":
      return shift ? null : "focus-address";
    case "r":
      return shift ? "hard-reload" : "reload";
    case "f":
      return shift ? null : "find";
    case "g":
      return shift ? "find-previous" : "find-next";
    case "b":
      return shift ? "toggle-full-view" : null;
    default:
      return null;
  }
}
