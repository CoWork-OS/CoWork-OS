/** What a task's computer shows in the bot's panel: a recent frame, its status and who has control. */

export type ComputerViewSurface = "this_computer" | "browser";

export interface ComputerViewFrame {
  /** A downscaled JPEG data URL. Frames are never stored. */
  dataUrl: string;
  width: number;
  height: number;
  capturedAt: number;
  surface: ComputerViewSurface;
  /** What is shown, e.g. "Safari — Checkout" or a page title. */
  label?: string;
}

/**
 * - idle: the task is not using a computer
 * - waiting: another task has this computer; this one is in line
 * - working: the task is using a computer
 * - held: the person has taken over; the bot's computer actions are refused
 */
export type ComputerViewStatus = "idle" | "waiting" | "working" | "held";

export interface ComputerViewState {
  taskId: string;
  status: ComputerViewStatus;
  surface?: ComputerViewSurface;
  frame?: ComputerViewFrame;
  /** The bot asked the person to take over (passwords, codes, payments). */
  takeoverRequest?: { reason: string; at: number };
  waitingSince?: number;
  updatedAt: number;
}

/** Frames are scaled down to this width at most. */
export const COMPUTER_VIEW_FRAME_MAX_WIDTH = 960;
/** How often a watched browser is captured while a bot works in it. */
export const COMPUTER_VIEW_POLL_MS = 5_000;
/** The longest reason a bot may give when it asks the person to take over. */
export const COMPUTER_TAKEOVER_REASON_MAX_LENGTH = 300;

export function describeComputerViewStatus(state: ComputerViewState | null | undefined): string {
  if (!state) return "Not using a computer";
  switch (state.status) {
    case "held":
      return "You have control";
    case "waiting":
      return "Waiting for this computer";
    case "working":
      return state.surface === "browser" ? "Using the browser" : "Using this computer";
    default:
      return "Not using a computer";
  }
}
