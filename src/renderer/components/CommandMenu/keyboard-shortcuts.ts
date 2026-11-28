import type { CommandMenuShortcutSpec } from "./command-menu-model";

/**
 * The keyboard shortcuts the app offers, for the command menu's Shortcuts scope and
 * docs/keyboard-shortcuts.md. This list describes the shortcuts; each one is still handled
 * where it applies (App.tsx, SidebarRail.tsx, the composer, the browser, the menus), so a
 * change to a handler needs a matching change here.
 */

interface ShortcutKeys {
  /** As shown on macOS, such as "⌘⇧B". */
  mac: string;
  /** As shown on Windows and Linux, such as "Ctrl+Shift+B". Omitted when Mac-only. */
  other?: string;
}

interface ShortcutDefinition extends Omit<CommandMenuShortcutSpec, "keys"> {
  keys: ShortcutKeys;
}

const same = (keys: string): ShortcutKeys => ({ mac: keys, other: keys });
const mod = (mac: string, other: string): ShortcutKeys => ({ mac, other });

const SHORTCUTS: readonly ShortcutDefinition[] = [
  // Anywhere in the app window
  {
    id: "command-menu",
    title: "Open the command menu",
    keys: mod("⌘K", "Ctrl+K"),
    where: "Anywhere",
    keywords: ["search", "find", "palette", "jump"],
  },
  {
    id: "shortcut-list",
    title: "Show keyboard shortcuts",
    keys: mod("⌘/", "Ctrl+/"),
    where: "Anywhere",
    keywords: ["keys", "hotkeys", "help", "list"],
  },
  {
    id: "next-attention",
    title: "Next session that needs you",
    keys: mod("⌘⇧U", "Ctrl+Shift+U"),
    where: "Anywhere",
    keywords: ["unread", "attention", "waiting", "approval", "question", "finished"],
    action: { type: "next-attention-session" },
  },
  {
    id: "session-position",
    title: "Open session 1–9 in the sidebar list",
    keys: mod("⌃1 … ⌃9", "Alt+1 … Alt+9"),
    where: "Anywhere",
    keywords: ["jump", "switch", "chat", "number"],
  },
  {
    id: "rail-position",
    title: "Open sidebar destination 1–9",
    keys: mod("⌘1 … ⌘9", "Ctrl+1 … Ctrl+9"),
    where: "Anywhere",
    keywords: ["rail", "navigate", "inbox", "home", "number"],
  },
  {
    id: "new-session",
    title: "New session",
    keys: { mac: "⌘N" },
    where: "Anywhere",
    keywords: ["new task", "create", "chat"],
    action: { type: "new-session" },
  },
  {
    id: "settings",
    title: "Open Settings",
    keys: { mac: "⌘," },
    where: "Anywhere",
    keywords: ["preferences", "options"],
    action: { type: "open-settings" },
  },
  {
    id: "quick-task",
    title: "Quick task window",
    keys: mod("⌘⇧Space", "Ctrl+Shift+Space"),
    where: "From any app",
    keywords: ["global", "hotkey", "quick input"],
  },
  {
    id: "window-capture",
    title: "Attach the window in front to your message",
    keys: { mac: "⌘⇧2" },
    where: "From any app",
    keywords: ["screenshot", "capture", "window", "screen", "attach"],
  },
  {
    id: "dictation",
    title: "Dictate into the app in front (when turned on)",
    keys: { mac: "⌃⇧Space" },
    where: "From any app",
    keywords: ["dictation", "voice", "speech", "microphone", "talk", "type"],
  },
  {
    id: "rail-reorder",
    title: "Move a sidebar destination up or down",
    keys: mod("⌥↑ / ⌥↓", "Alt+↑ / Alt+↓"),
    where: "Sidebar rail, with a destination focused",
    keywords: ["reorder", "rail"],
  },
  {
    id: "toggle-browser",
    title: "Open the browser, or switch between side and full view",
    keys: mod("⌘⇧B", "Ctrl+Shift+B"),
    where: "Session",
    keywords: ["web", "workbench", "fullscreen"],
  },

  // Composer
  { id: "send", title: "Send message", keys: same("Enter"), where: "Composer" },
  {
    id: "newline",
    title: "New line",
    keys: mod("⇧Enter", "Shift+Enter"),
    where: "Composer",
    keywords: ["line break", "return"],
  },
  {
    id: "send-other-way",
    title: "While the agent works: send the other way (steer now, or after this run)",
    keys: mod("⌘Enter", "Ctrl+Enter"),
    where: "Composer",
    keywords: ["queue", "steer", "later", "after", "running", "interrupt"],
  },
  {
    id: "accept-suggestion",
    title: "Accept the suggested prompt",
    keys: same("Tab"),
    where: "Empty composer",
    keywords: ["prediction", "autocomplete"],
  },
  {
    id: "dismiss-suggestion",
    title: "Dismiss the suggested prompt",
    keys: same("Esc"),
    where: "Empty composer",
    keywords: ["prediction"],
  },
  {
    id: "question-option",
    title: "Pick an answer",
    keys: same("1 … 4"),
    where: "Question card",
    keywords: ["option", "choice", "approval"],
  },
  {
    id: "question-step",
    title: "Previous or next question",
    keys: same("← / →"),
    where: "Question card",
  },

  // Built-in browser
  { id: "browser-new-tab", title: "New tab", keys: mod("⌘T", "Ctrl+T"), where: "Browser" },
  {
    id: "browser-reopen-tab",
    title: "Reopen closed tab",
    keys: mod("⌘⇧T", "Ctrl+Shift+T"),
    where: "Browser",
  },
  { id: "browser-close-tab", title: "Close tab", keys: mod("⌘W", "Ctrl+W"), where: "Browser" },
  {
    id: "browser-next-tab",
    title: "Next or previous tab",
    keys: mod("⌃Tab / ⌃⇧Tab", "Ctrl+Tab / Ctrl+Shift+Tab"),
    where: "Browser",
  },
  {
    id: "browser-tab-number",
    title: "Go to tab 1–8, or the last tab",
    keys: mod("⌘1 … ⌘9", "Ctrl+1 … Ctrl+9"),
    where: "Browser",
  },
  {
    id: "browser-address",
    title: "Focus the address bar",
    keys: mod("⌘L", "Ctrl+L"),
    where: "Browser",
    keywords: ["url", "location"],
  },
  {
    id: "browser-reload",
    title: "Reload, or hard reload",
    keys: mod("⌘R / ⌘⇧R", "Ctrl+R / Ctrl+Shift+R"),
    where: "Browser",
    keywords: ["refresh"],
  },
  {
    id: "browser-history",
    title: "Back or forward",
    keys: mod("⌘[ / ⌘]", "Ctrl+[ / Ctrl+]"),
    where: "Browser",
    keywords: ["history"],
  },
  {
    id: "browser-find",
    title: "Find in page, next, previous",
    keys: mod("⌘F / ⌘G / ⌘⇧G", "Ctrl+F / Ctrl+G / Ctrl+Shift+G"),
    where: "Browser",
    keywords: ["search"],
  },
  {
    id: "browser-zoom",
    title: "Zoom in, out, reset",
    keys: mod("⌘= / ⌘- / ⌘0", "Ctrl+= / Ctrl+- / Ctrl+0"),
    where: "Browser",
  },

  // Panels and viewers
  {
    id: "inbox-move",
    title: "Next or previous thread",
    keys: same("J / K"),
    where: "Inbox",
    keywords: ["mail", "email"],
  },
  { id: "inbox-archive", title: "Archive thread", keys: same("E"), where: "Inbox" },
  { id: "inbox-trash", title: "Move thread to trash", keys: same("#"), where: "Inbox" },
  { id: "inbox-draft", title: "Draft a reply", keys: same("D"), where: "Inbox" },
  {
    id: "video-play",
    title: "Play or pause",
    keys: same("Space / K"),
    where: "Video player",
  },
  {
    id: "video-seek",
    title: "Back or forward 10 s, 5 s",
    keys: same("J / L, ← / →"),
    where: "Video player",
  },
  { id: "video-volume", title: "Volume", keys: same("↑ / ↓"), where: "Video player" },
  { id: "video-frame", title: "Step one frame", keys: same(", / ."), where: "Video player" },
  {
    id: "video-toggles",
    title: "Mute, full screen, loop",
    keys: same("M / F / R"),
    where: "Video player",
  },
  {
    id: "image-zoom",
    title: "Zoom in, out, reset",
    keys: same("+ / - / 0"),
    where: "Image viewer",
  },
  {
    id: "slides-step",
    title: "Previous or next slide",
    keys: same("← / →"),
    where: "Presentation",
  },
  {
    id: "canvas-keys",
    title: "Refresh, pause, copy, save, history, console",
    keys: same("R / P / C / S / H / L"),
    where: "Live Canvas preview, focused",
  },
];

/** The shortcut list for this platform. Mac-only shortcuts are left out elsewhere. */
export function buildKeyboardShortcuts(isMac: boolean): CommandMenuShortcutSpec[] {
  return SHORTCUTS.flatMap(({ keys, ...rest }) => {
    const shown = isMac ? keys.mac : keys.other;
    return shown ? [{ ...rest, keys: shown }] : [];
  });
}

/**
 * True for Cmd/Ctrl+/: open the menu on the Shortcuts scope. Shift may be held, since some
 * layouts need it to type "/"; the key itself must be "/".
 */
export function isShortcutListShortcut(event: KeyChord): boolean {
  return (event.metaKey || event.ctrlKey) && !event.altKey && event.key === "/";
}

/** True for Cmd/Ctrl+Shift+U: the next session that needs you. */
export function isNextAttentionShortcut(event: KeyChord, isMac: boolean): boolean {
  const primary = isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return primary && event.shiftKey && !event.altKey && event.code === "KeyU";
}

/**
 * The sidebar position for Ctrl+1–9 on macOS and Alt+1–9 elsewhere, or null. Cmd/Ctrl+1–9
 * already opens the rail destinations, and Option+digit types characters on macOS.
 */
export function sessionPositionFromShortcut(event: KeyChord, isMac: boolean): number | null {
  const held = isMac
    ? event.ctrlKey && !event.metaKey && !event.altKey
    : event.altKey && !event.ctrlKey && !event.metaKey;
  if (!held || event.shiftKey) return null;
  const digit = /^Digit([1-9])$/.exec(event.code)?.[1];
  return digit ? Number(digit) : null;
}

export interface KeyChord {
  key: string;
  code: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}
