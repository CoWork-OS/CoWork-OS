import { visibleSurfaceText } from "./actions";

/**
 * The suggested next steps at the end of an answer: a ```cowork-next block holding up to
 * three messages the user would likely send next, one per line, most likely first ("Find
 * 20 minutes with Sophie this week"). The app draws each as a button under the answer, and
 * a click sends exactly that text as the user's message. Because each button shows every
 * character it sends, it needs no separate confirmation; the message still goes through the
 * agent like anything the user types, so every tool it leads to meets the normal policies
 * and approvals.
 */

/** The fence language that marks the suggested next steps. */
export const NEXT_ACTION_FENCE_LANGUAGE = "cowork-next";

/** Short enough to read whole on one button. */
export const NEXT_ACTION_MAX_CHARS = 100;

/** Buttons under one answer; further lines in the block are ignored. */
export const NEXT_ACTION_MAX_STEPS = 3;

const FENCE_START = /^\s*```cowork-next\s*$/i;
const FENCE_END = /^\s*```\s*$/;
const LIST_MARKER = /^\s*(?:[-*•]|\d+[.)])\s+/;

export type NextActionSplit = {
  /** The answer without any ```cowork-next block. */
  body: string;
  /** The messages the buttons send, most likely first; empty when there are none. */
  steps: string[];
};

/** One button's text: visible characters on one line, or null if empty or too long. */
export function normalizeNextAction(raw: string): string | null {
  const text = visibleSurfaceText(String(raw || "").replace(/\s*\n\s*/g, " "));
  if (!text || text.length > NEXT_ACTION_MAX_CHARS) return null;
  return text;
}

/** The block's lines as steps: one per line, with unusable and repeated lines dropped. */
export function normalizeNextActions(raw: string): string[] {
  const steps: string[] = [];
  for (const line of String(raw || "").split("\n")) {
    const step = normalizeNextAction(line.replace(LIST_MARKER, ""));
    if (!step || steps.some((seen) => seen.toLowerCase() === step.toLowerCase())) continue;
    steps.push(step);
    if (steps.length === NEXT_ACTION_MAX_STEPS) break;
  }
  return steps;
}

export function hasNextActionBlock(message: string): boolean {
  return String(message || "")
    .split("\n")
    .some((line) => FENCE_START.test(line));
}

/**
 * Splits off the suggested next steps. Every ```cowork-next block is removed from the body,
 * finished or not, so one never shows as raw text; only the last one counts, and only when
 * nothing but blank lines follows it (next steps sit at the end of the answer).
 */
export function splitNextAction(message: string): NextActionSplit {
  const text = String(message || "");
  if (!hasNextActionBlock(text)) return { body: text, steps: [] };
  const lines = text.split("\n");
  const kept: string[] = [];
  let steps: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!FENCE_START.test(lines[index])) {
      kept.push(lines[index]);
      continue;
    }
    let end = index + 1;
    while (end < lines.length && !FENCE_END.test(lines[end])) end += 1;
    const closed = end < lines.length;
    const atEnd = lines.slice(end + 1).every((line) => line.trim() === "");
    steps = closed && atEnd ? normalizeNextActions(lines.slice(index + 1, end).join("\n")) : [];
    index = end;
  }
  return {
    body: kept
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .replace(/^\s*\n/, "")
      .trimEnd(),
    steps,
  };
}

/** The answer without its suggested next steps, for every view that shows text only. */
export function withoutNextAction(message: string): string {
  return splitNextAction(message).body;
}

export const NEXT_ACTION_PROMPT = [
  "SUGGESTED NEXT STEPS (cowork-next):",
  "When there are clear things the user is likely to ask for next (book the slot you found, draft the reply, fix the issue you diagnosed, go deeper on the top item), end your final answer with them in one ```cowork-next block: one step per line, at most three, most likely first, each at most 100 characters and written as the user's own request.",
  "The app shows each line as a button under your answer and a click sends exactly that text to you as the user's message. Use one block, only as the very last thing in the answer. Offer only steps that are distinct and genuinely likely; one is fine. Leave the block out when the task is done with nothing obvious left, when you asked the user a question, or in progress updates.",
  "Example:",
  "```cowork-next",
  "Find 20 minutes with Sophie this week",
  "Draft the follow-up to Sophie",
  "```",
].join("\n");
