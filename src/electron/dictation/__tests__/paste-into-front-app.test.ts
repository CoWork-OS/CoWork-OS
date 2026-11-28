import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  CLIPBOARD_RESTORE_DELAY_MS,
  MAX_SNAPSHOT_BYTES,
  deliverDictation,
  resetAccessibilityPromptForTesting,
  snapshotClipboard,
  type ClipboardAccess,
  type ClipboardSnapshot,
  type PasteDeps,
} from "../paste-into-front-app";

const FILE_URL = 'electron application/osclipboard;format="public.file-url"';
const CONCEALED = 'electron application/osclipboard;format="org.nspasteboard.ConcealedType"';

function fakeClipboard(initial: ClipboardSnapshot) {
  const state = {
    items: initial,
    writes: [] as ClipboardSnapshot[],
    textWrites: [] as Array<{ text: string; transient: boolean }>,
    cleared: false,
    bookmark: false,
    changes: 0,
  };
  const text = async (snapshot: ClipboardSnapshot) => {
    const blob = snapshot.find((entry) => entry["text/plain"])?.["text/plain"];
    return blob ? blob.text() : "";
  };
  const clipboard: ClipboardAccess = {
    read: async () =>
      state.items.map((entry) => ({
        types: [
          ...Object.keys(entry),
          ...(state.bookmark ? ["electron application/bookmark"] : []),
        ],
        getType: async (type: string) =>
          type === "electron application/bookmark" ? { title: "t", url: "u" } : entry[type],
      })),
    write: async (snapshot) => {
      state.changes += 1;
      state.writes.push(snapshot);
      state.items = snapshot;
    },
    readText: () => text(state.items),
    writeText: async (value, options) => {
      state.changes += 1;
      state.textWrites.push({ text: value, transient: !!options?.transient });
      state.items = [{ "text/plain": new Blob([value]) }];
    },
    changeCount: async () => state.changes,
    clear: () => {
      state.changes += 1;
      state.cleared = true;
      state.items = [];
    },
  };
  return { clipboard, state, text: () => text(state.items) };
}

function deps(clipboard: ClipboardAccess, overrides: Partial<PasteDeps> = {}) {
  return {
    clipboard,
    accessibilityTrusted: vi.fn(() => true),
    postPaste: vi.fn(async () => {}),
    wait: vi.fn(async () => {}),
    ...overrides,
  } satisfies PasteDeps;
}

beforeEach(() => resetAccessibilityPromptForTesting());

describe("deliverDictation", () => {
  it("pastes, then puts back every format the clipboard held", async () => {
    const before: ClipboardSnapshot = [
      { "text/plain": new Blob(["notes.txt"]), [FILE_URL]: new Blob(["file:///notes.txt"]) },
    ];
    const { clipboard, state } = fakeClipboard(before);
    const d = deps(clipboard);
    expect(await deliverDictation("Hello", d)).toBe("pasted");
    expect(d.postPaste).toHaveBeenCalledTimes(1);
    expect(d.wait).toHaveBeenCalledWith(CLIPBOARD_RESTORE_DELAY_MS);
    // The dictated text was on the clipboard only for the paste, marked so managers skip it.
    expect(state.textWrites).toEqual([{ text: "Hello", transient: true }]);
    expect(state.writes).toHaveLength(1);
    expect(Object.keys(state.writes[0][0])).toEqual(["text/plain", FILE_URL]);
    expect(await state.writes[0][0][FILE_URL].text()).toBe("file:///notes.txt");
  });

  it("leaves something copied in the meantime alone, even the same text", async () => {
    const { clipboard, state, text } = fakeClipboard([{ "text/plain": new Blob(["old"]) }]);
    const d = deps(clipboard, {
      wait: vi.fn(async () => {
        state.changes += 1;
        state.items = [{ "text/plain": new Blob(["copied meanwhile"]) }];
      }),
    });
    await deliverDictation("Hello", d);
    expect(state.writes).toEqual([]);
    expect(await text()).toBe("copied meanwhile");

    const same = fakeClipboard([{ "text/plain": new Blob(["old"]) }]);
    await deliverDictation(
      "Hello",
      deps(same.clipboard, {
        wait: vi.fn(async () => {
          // Someone copied the very same text: only the change count tells.
          same.state.changes += 1;
          same.state.items = [{ "text/plain": new Blob(["Hello"]) }];
        }),
      }),
    );
    expect(same.state.writes).toEqual([]);
  });

  it("clears a clipboard that was empty", async () => {
    const { clipboard, state } = fakeClipboard([]);
    await deliverDictation("Hello", deps(clipboard));
    expect(state.cleared).toBe(true);
  });

  it("never holds or writes back a password manager's concealed entry", async () => {
    const { clipboard, state, text } = fakeClipboard([
      { "text/plain": new Blob(["hunter2"]), [CONCEALED]: new Blob([""]) },
    ]);
    expect(await snapshotClipboard(clipboard)).toBeNull();
    expect(await deliverDictation("Hello", deps(clipboard))).toBe("pasted");
    expect(state.writes).toEqual([]);
    expect(await text()).toBe("Hello");
    expect(state.textWrites).toEqual([{ text: "Hello", transient: false }]);
  });

  it("leaves the text on the clipboard when the old contents can't be held", async () => {
    const bookmark = fakeClipboard([{ "text/plain": new Blob(["x"]) }]);
    bookmark.state.bookmark = true;
    expect(await snapshotClipboard(bookmark.clipboard)).toBeNull();
    expect(await deliverDictation("Hello", deps(bookmark.clipboard))).toBe("pasted");
    expect(bookmark.state.writes).toEqual([]);
    expect(await bookmark.text()).toBe("Hello");

    const huge = fakeClipboard([
      { "image/png": new Blob([new Uint8Array(MAX_SNAPSHOT_BYTES + 1)]) },
    ]);
    expect(await snapshotClipboard(huge.clipboard)).toBeNull();
  });

  it("copies without Accessibility and asks macOS only once", async () => {
    const { clipboard, text } = fakeClipboard([{ "text/plain": new Blob(["old"]) }]);
    const trusted = vi.fn(() => false);
    const first = deps(clipboard, { accessibilityTrusted: trusted });
    expect(await deliverDictation("Hello", first)).toBe("copied");
    expect(first.postPaste).not.toHaveBeenCalled();
    expect(await text()).toBe("Hello");
    expect(trusted).toHaveBeenCalledWith(true);

    trusted.mockClear();
    await deliverDictation("Again", deps(clipboard, { accessibilityTrusted: trusted }));
    expect(trusted).not.toHaveBeenCalledWith(true);
  });

  it("only copies when told not to paste", async () => {
    const { clipboard, state, text } = fakeClipboard([{ "text/plain": new Blob(["old"]) }]);
    const d = deps(clipboard);
    expect(await deliverDictation("Hello", d, { paste: false })).toBe("copied");
    expect(d.postPaste).not.toHaveBeenCalled();
    expect(await text()).toBe("Hello");
    expect(state.textWrites).toEqual([{ text: "Hello", transient: false }]);
  });

  it("falls back to copying, as plain text, when the key press can't be posted", async () => {
    const { clipboard, state, text } = fakeClipboard([{ "text/plain": new Blob(["old"]) }]);
    const log = vi.fn();
    const d = deps(clipboard, {
      postPaste: vi.fn(async () => {
        throw new Error("osascript missing");
      }),
      log,
    });
    expect(await deliverDictation("Hello", d)).toBe("copied");
    expect(await text()).toBe("Hello");
    expect(state.textWrites.at(-1)).toEqual({ text: "Hello", transient: false });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Posting Cmd+V failed"));
  });

  it("doesn't put the clipboard back when its change count can't be read", async () => {
    const { clipboard, state } = fakeClipboard([{ "text/plain": new Blob(["old"]) }]);
    clipboard.changeCount = async () => null;
    expect(await deliverDictation("Hello", deps(clipboard))).toBe("pasted");
    expect(state.writes).toEqual([]);
  });

  it("says when putting the clipboard back failed", async () => {
    const { clipboard } = fakeClipboard([{ "text/plain": new Blob(["old"]) }]);
    clipboard.write = async () => {
      throw new Error("refused");
    };
    const log = vi.fn();
    expect(await deliverDictation("Hello", deps(clipboard, { log }))).toBe("pasted_clipboard_lost");
    expect(log).toHaveBeenCalledWith(expect.stringContaining("Could not put the clipboard back"));
  });
});
