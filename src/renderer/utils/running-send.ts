import type { RunningSendMode } from "../../shared/types";

/**
 * What Enter does with a message sent while the agent is working. "steer" hands it to the
 * running loop at its next step; "queue" holds it until the run finishes and then starts a
 * new turn with it. Cmd+Enter (Ctrl+Enter off macOS) does the other one.
 */
export const DEFAULT_RUNNING_SEND_MODE: RunningSendMode = "steer";

export function isRunningSendMode(value: unknown): value is RunningSendMode {
  return value === "steer" || value === "queue";
}

interface EnterChord {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** Cmd+Enter on macOS, Ctrl+Enter elsewhere: send the other way. */
export function isAlternateSendChord(event: EnterChord, isMac: boolean): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.altKey) return false;
  return isMac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
}

/** True when this send should wait for the current run to finish. */
export function shouldWaitForTurn(input: {
  working: boolean;
  mode: RunningSendMode;
  alternate: boolean;
}): boolean {
  if (!input.working) return false;
  return (input.mode === "queue") !== input.alternate;
}

/** The composer's hint while the agent works, such as "Enter steers now · ⌘Enter waits". */
export function runningSendHint(mode: RunningSendMode, isMac: boolean): string {
  const alternate = isMac ? "⌘Enter" : "Ctrl+Enter";
  const steer = "steers now";
  const queue = "sends after this run";
  return mode === "queue"
    ? `Enter ${queue} · ${alternate} ${steer}`
    : `Enter ${steer} · ${alternate} ${queue}`;
}
