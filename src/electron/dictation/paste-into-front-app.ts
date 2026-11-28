/**
 * Puts dictated text into the app in front (macOS): the text goes on the clipboard, a
 * Cmd+V key press is posted to the system, and the clipboard is put back as it was.
 *
 * Posting a key press needs Accessibility permission. Without it the text stays on the
 * clipboard and the person pastes it themself.
 */
import { execFile, spawn } from "node:child_process";

/**
 * What the clipboard held before dictation: every item with every format it offered,
 * including the system's own formats, so a copied file or picture comes back whole.
 */
export type ClipboardSnapshot = Array<Record<string, Blob>>;

/** One item as the clipboard reads it (Electron's `ClipboardItem`). */
export interface ClipboardReadItem {
  readonly types: readonly string[];
  getType(type: string): Promise<unknown>;
}

export interface ClipboardAccess {
  read(): Promise<ClipboardReadItem[]>;
  write(snapshot: ClipboardSnapshot): Promise<void>;
  readText(): Promise<string>;
  /**
   * `transient` marks the text so clipboard managers don't keep it (it is only on the
   * clipboard for the paste).
   */
  writeText(text: string, options?: { transient?: boolean }): Promise<void>;
  clear(): void;
  /**
   * The system pasteboard's change count, which every write by any app raises; null when
   * it can't be read.
   */
  changeCount(): Promise<number | null>;
}

export interface PasteDeps {
  clipboard: ClipboardAccess;
  /** Whether CoWork may post key presses; `prompt` asks macOS to show its permission dialog. */
  accessibilityTrusted(prompt: boolean): boolean;
  /** Posts Cmd+V to the app in front. */
  postPaste(): Promise<void>;
  wait(ms: number): Promise<void>;
  log?(message: string): void;
}

/** `pasted_clipboard_lost`: pasted, but what the clipboard held before couldn't be put back. */
export type DeliveryResult = "pasted" | "copied" | "pasted_clipboard_lost";

export interface DeliveryOptions {
  /** False when the person switched apps while dictating: the text is only copied. */
  paste: boolean;
}

/** Time the app in front gets to read the clipboard before it is put back. */
export const CLIPBOARD_RESTORE_DELAY_MS = 600;
/** Larger clipboards (a big picture, say) are left out rather than held in memory. */
export const MAX_SNAPSHOT_BYTES = 32 * 1024 * 1024;

/**
 * Pasteboard markers (nspasteboard.org) that password managers and similar apps put on
 * what they copy: concealed, transient or auto-generated. Such contents are never held or
 * written back, so a copied password isn't copied again past its own clear timer.
 */
const PRIVATE_MARKER = "org.nspasteboard.";

/**
 * Reads everything on the clipboard. Returns null when part of it can't be held as data,
 * is marked private, or is too large; the dictated text then simply stays on the clipboard.
 */
export async function snapshotClipboard(
  clipboard: ClipboardAccess,
): Promise<ClipboardSnapshot | null> {
  try {
    const snapshot: ClipboardSnapshot = [];
    let bytes = 0;
    for (const item of await clipboard.read()) {
      const entry: Record<string, Blob> = {};
      if (item.types.some((type) => type.includes(PRIVATE_MARKER))) return null;
      for (const type of item.types) {
        const value = await item.getType(type);
        if (!(value instanceof Blob)) return null;
        bytes += value.size;
        if (bytes > MAX_SNAPSHOT_BYTES) return null;
        entry[type] = value;
      }
      if (Object.keys(entry).length > 0) snapshot.push(entry);
    }
    return snapshot;
  } catch {
    return null;
  }
}

async function restoreClipboard(
  clipboard: ClipboardAccess,
  snapshot: ClipboardSnapshot,
): Promise<void> {
  if (snapshot.length === 0) {
    clipboard.clear();
    return;
  }
  await clipboard.write(snapshot);
}

let promptedForAccessibility = false;

/** Tests reset the once-per-run Accessibility prompt. */
export function resetAccessibilityPromptForTesting(): void {
  promptedForAccessibility = false;
}

/**
 * Paste `text` into the app in front, or leave it on the clipboard when CoWork can't post
 * key presses. The clipboard is put back only if it still holds the dictated text, so
 * something the person copied in the meantime is never overwritten.
 */
export async function deliverDictation(
  text: string,
  deps: PasteDeps,
  options: DeliveryOptions = { paste: true },
): Promise<DeliveryResult> {
  const describe = (error: unknown) => (error instanceof Error ? error.name : "Error");

  if (!options.paste) {
    await deps.clipboard.writeText(text);
    return "copied";
  }
  if (!deps.accessibilityTrusted(false)) {
    await deps.clipboard.writeText(text);
    // macOS shows its dialog once per run; after that the overlay's message says what to do.
    if (!promptedForAccessibility) {
      promptedForAccessibility = true;
      deps.accessibilityTrusted(true);
    }
    return "copied";
  }

  const snapshot = await snapshotClipboard(deps.clipboard);
  await deps.clipboard.writeText(text, { transient: snapshot !== null });
  const written = await deps.clipboard.changeCount().catch(() => null);

  try {
    await deps.postPaste();
  } catch (error) {
    deps.log?.(`Posting Cmd+V failed (${describe(error)})`);
    if (snapshot) await deps.clipboard.writeText(text);
    return "copied";
  }
  if (!snapshot) return "pasted";

  await deps.wait(CLIPBOARD_RESTORE_DELAY_MS);
  try {
    // Put back only if nothing wrote to the clipboard since: same change count, same text.
    const unchanged =
      written !== null &&
      (await deps.clipboard.changeCount().catch(() => null)) === written &&
      (await deps.clipboard.readText()) === text;
    if (!unchanged) return "pasted";
    await restoreClipboard(deps.clipboard, snapshot);
    return "pasted";
  } catch (error) {
    deps.log?.(`Could not put the clipboard back (${describe(error)})`);
    return "pasted_clipboard_lost";
  }
}

/**
 * Cmd+V through Quartz events, run by the system's JavaScript for Automation. Unlike
 * System Events `keystroke`, it needs no Automation permission, only Accessibility.
 * Key code 9 is V on the ANSI layout.
 */
const POST_PASTE_SCRIPT = [
  'ObjC.import("CoreGraphics");',
  "const source = $.CGEventSourceCreate($.kCGEventSourceStateCombinedSessionState);",
  "const down = $.CGEventCreateKeyboardEvent(source, 9, true);",
  "const up = $.CGEventCreateKeyboardEvent(source, 9, false);",
  "$.CGEventSetFlags(down, $.kCGEventFlagMaskCommand);",
  "$.CGEventSetFlags(up, $.kCGEventFlagMaskCommand);",
  "$.CGEventPost($.kCGHIDEventTap, down);",
  "$.CGEventPost($.kCGHIDEventTap, up);",
].join("\n");

const POST_PASTE_TIMEOUT_MS = 5_000;

export function postPasteKeystroke(): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/osascript", ["-l", "JavaScript", "-e", POST_PASTE_SCRIPT], {
      stdio: "ignore",
    });
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error("Pasting timed out"));
    }, POST_PASTE_TIMEOUT_MS);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`Pasting failed (exit ${code})`));
    });
  });
}

const FRONTMOST_SCRIPT = [
  'ObjC.import("AppKit");',
  "const app = $.NSWorkspace.sharedWorkspace.frontmostApplication;",
  'String(app.bundleIdentifier.js) + ":" + String(app.processIdentifier);',
].join("\n");

/** "bundle.id:pid" of the app in front, from AppKit; needs no permission. Null on failure. */
export function readFrontmostApp(): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", FRONTMOST_SCRIPT],
      { timeout: 3_000 },
      (error, stdout) => {
        const value = String(stdout ?? "").trim();
        resolve(!error && /^[^\s:]*:\d+$/.test(value) ? value : null);
      },
    );
  });
}

const CHANGE_COUNT_SCRIPT =
  'ObjC.import("AppKit"); String($.NSPasteboard.generalPasteboard.changeCount);';

/** NSPasteboard's change count for the general pasteboard; null on failure. */
export function readPasteboardChangeCount(): Promise<number | null> {
  return new Promise((resolve) => {
    execFile(
      "/usr/bin/osascript",
      ["-l", "JavaScript", "-e", CHANGE_COUNT_SCRIPT],
      { timeout: 3_000 },
      (error, stdout) => {
        const value = Number(String(stdout ?? "").trim());
        resolve(!error && Number.isInteger(value) ? value : null);
      },
    );
  });
}
