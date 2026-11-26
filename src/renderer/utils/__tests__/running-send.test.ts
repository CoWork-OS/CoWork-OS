import { describe, expect, it } from "vitest";
import {
  isAlternateSendChord,
  isRunningSendMode,
  runningSendHint,
  shouldWaitForTurn,
} from "../running-send";

const enter = (mods: Partial<Record<"metaKey" | "ctrlKey" | "altKey" | "shiftKey", boolean>>) => ({
  key: "Enter",
  metaKey: false,
  ctrlKey: false,
  altKey: false,
  shiftKey: false,
  ...mods,
});

describe("isAlternateSendChord", () => {
  it("is Cmd+Enter on macOS and Ctrl+Enter elsewhere", () => {
    expect(isAlternateSendChord(enter({ metaKey: true }), true)).toBe(true);
    expect(isAlternateSendChord(enter({ ctrlKey: true }), true)).toBe(false);
    expect(isAlternateSendChord(enter({ ctrlKey: true }), false)).toBe(true);
    expect(isAlternateSendChord(enter({ metaKey: true }), false)).toBe(false);
  });

  it("ignores plain Enter, Shift, Alt and other keys", () => {
    expect(isAlternateSendChord(enter({}), true)).toBe(false);
    expect(isAlternateSendChord(enter({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isAlternateSendChord(enter({ metaKey: true, altKey: true }), true)).toBe(false);
    expect(isAlternateSendChord({ ...enter({ metaKey: true }), key: "k" }, true)).toBe(false);
  });
});

describe("shouldWaitForTurn", () => {
  it("never waits when the agent is idle", () => {
    expect(shouldWaitForTurn({ working: false, mode: "queue", alternate: false })).toBe(false);
    expect(shouldWaitForTurn({ working: false, mode: "steer", alternate: true })).toBe(false);
  });

  it("follows the setting, and the alternate chord flips it", () => {
    expect(shouldWaitForTurn({ working: true, mode: "steer", alternate: false })).toBe(false);
    expect(shouldWaitForTurn({ working: true, mode: "steer", alternate: true })).toBe(true);
    expect(shouldWaitForTurn({ working: true, mode: "queue", alternate: false })).toBe(true);
    expect(shouldWaitForTurn({ working: true, mode: "queue", alternate: true })).toBe(false);
  });
});

describe("runningSendHint", () => {
  it("names what each key does for the platform", () => {
    expect(runningSendHint("steer", true)).toBe("Enter steers now · ⌘Enter sends after this run");
    expect(runningSendHint("queue", false)).toBe(
      "Enter sends after this run · Ctrl+Enter steers now",
    );
  });
});

describe("isRunningSendMode", () => {
  it("accepts only the two modes", () => {
    expect(isRunningSendMode("steer")).toBe(true);
    expect(isRunningSendMode("queue")).toBe(true);
    expect(isRunningSendMode("later")).toBe(false);
    expect(isRunningSendMode(undefined)).toBe(false);
  });
});
