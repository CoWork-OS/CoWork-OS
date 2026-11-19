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

const POSSIBLE_NEXT_ACTION = /```cowork-next/i;
const FENCE_START = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const FENCE_END = /^ {0,3}(`{3,}|~{3,})\s*$/;
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

/** Skip literal examples inside ordinary Markdown code fences. */
function* findNextActionFences(lines: string[]): Generator<{ start: number; end: number }> {
  for (let start = 0; start < lines.length; start += 1) {
    const opener = FENCE_START.exec(lines[start]);
    if (!opener) continue;
    const [, delimiter, info] = opener;
    if (delimiter[0] === "`" && info.includes("`")) continue;

    let end = start + 1;
    for (; end < lines.length; end += 1) {
      const closing = FENCE_END.exec(lines[end])?.[1];
      if (closing?.[0] === delimiter[0] && closing.length >= delimiter.length) break;
    }
    if (delimiter === "```" && info.trimEnd().toLowerCase() === NEXT_ACTION_FENCE_LANGUAGE) {
      yield { start, end };
    }
    start = end;
  }
}

export function hasNextActionBlock(message: string): boolean {
  const text = String(message || "");
  return POSSIBLE_NEXT_ACTION.test(text) && !findNextActionFences(text.split("\n")).next().done;
}

/**
 * Splits off the suggested next steps. Every ```cowork-next block is removed from the body,
 * finished or not, so one never shows as raw text; only the last one counts, and only when
 * nothing but blank lines follows it (next steps sit at the end of the answer).
 */
export function splitNextAction(message: string): NextActionSplit {
  const text = String(message || "");
  if (!POSSIBLE_NEXT_ACTION.test(text)) return { body: text, steps: [] };
  const lines = text.split("\n");
  const kept: string[] = [];
  let cursor = 0;
  let steps: string[] = [];
  for (const { start, end } of findNextActionFences(lines)) {
    kept.push(...lines.slice(cursor, start));
    // Clean up only the gap left by the action. Keep blank lines within examples intact.
    while (kept.at(-1)?.trim() === "") kept.pop();
    cursor = end + 1;
    while (lines[cursor]?.trim() === "") cursor += 1;
    if (kept.length && cursor < lines.length) kept.push("");
    steps =
      end < lines.length && cursor === lines.length
        ? normalizeNextActions(lines.slice(start + 1, end).join("\n"))
        : [];
  }
  if (cursor === 0) return { body: text, steps };
  kept.push(...lines.slice(cursor));
  return { body: kept.join("\n"), steps };
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
