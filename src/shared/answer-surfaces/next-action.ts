import { visibleSurfaceText } from "./actions";

/**
 * The one suggested next step at the end of an answer: a ```cowork-next block holding the
 * message the user would most likely send next ("Find 20 minutes with Sophie this week").
 * The app draws it as a single button under the answer, and a click sends exactly that
 * text as the user's message. Because the button shows every character it sends, it needs
 * no separate confirmation; the message still goes through the agent like anything the
 * user types, so every tool it leads to meets the normal policies and approvals.
 */

/** The fence language that marks the suggested next step. */
export const NEXT_ACTION_FENCE_LANGUAGE = "cowork-next";

/** Short enough to read whole on one button. */
export const NEXT_ACTION_MAX_CHARS = 100;

const FENCE_START = /^\s*```cowork-next\s*$/i;
const FENCE_END = /^\s*```\s*$/;

export type NextActionSplit = {
  /** The answer without any ```cowork-next block. */
  body: string;
  /** The message the button sends, or null when there is none or it is unusable. */
  next: string | null;
};

/** The button text: visible characters on one line, or null if empty or too long. */
export function normalizeNextAction(raw: string): string | null {
  const text = visibleSurfaceText(String(raw || "").replace(/\s*\n\s*/g, " "));
  if (!text || text.length > NEXT_ACTION_MAX_CHARS) return null;
  return text;
}

export function hasNextActionBlock(message: string): boolean {
  return String(message || "")
    .split("\n")
    .some((line) => FENCE_START.test(line));
}

/**
 * Splits off the suggested next step. Every ```cowork-next block is removed from the body,
 * finished or not, so one never shows as raw text; only the last one counts, and only when
 * nothing but blank lines follows it (a next step sits at the end of the answer).
 */
export function splitNextAction(message: string): NextActionSplit {
  const text = String(message || "");
  if (!hasNextActionBlock(text)) return { body: text, next: null };
  const lines = text.split("\n");
  const kept: string[] = [];
  let next: string | null = null;
  for (let index = 0; index < lines.length; index += 1) {
    if (!FENCE_START.test(lines[index])) {
      kept.push(lines[index]);
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !FENCE_END.test(lines[end])) end += 1;
    const closed = end < lines.length;
    const atEnd = lines.slice(end + 1).every((line) => line.trim() === "");
    next = closed && atEnd ? normalizeNextAction(lines.slice(index + 1, end).join("\n")) : null;
    index = end;
  }
  return {
    body: kept
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\s*\n/, "")
      .trimEnd(),
    next,
  };
}

/** The answer without its suggested next step, for every view that shows text only. */
export function withoutNextAction(message: string): string {
  return splitNextAction(message).body;
}

export const NEXT_ACTION_PROMPT = [
  "SUGGESTED NEXT STEP (cowork-next):",
  "When there is one clear thing the user is likely to ask for next (book the slot you found, draft the reply, fix the issue you diagnosed, go deeper on the top item), end your final answer with it in a ```cowork-next block: one line, at most 100 characters, written as the user's own request.",
  "The app shows it as a button under your answer and a click sends exactly that text to you as the user's message. Give at most one, only as the very last thing in the answer, and leave it out when the task is done with nothing obvious left, when you asked the user a question, or in progress updates.",
  "Example:",
  "```cowork-next",
  "Find 20 minutes with Sophie this week",
  "```",
].join("\n");
