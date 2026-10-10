import { isAnswerSurfaceFenceEnd, isAnswerSurfaceFenceStart } from "./blocks";
import { lintAnswerSurface } from "./runtime";
import { parseAnswerSurfaceSource } from "./schema";

/**
 * The answer-block repair loop: before an answer is shown, every ```cowork-ui block is
 * checked; a block that would not render (bad JSON, schema errors, an unfinished fence)
 * or whose formulas have no value at the defaults is sent back to the model once with
 * the exact problem, and the fix replaces it only if it checks out. Pure helpers here;
 * the executor makes the model call.
 */

export const MAX_REPAIRED_BLOCKS = 2;

export type AnswerSurfaceProblem = {
  /** Which ```cowork-ui block of the message (0-based). */
  blockIndex: number;
  source: string;
  error: string;
};

type BlockRange = { start: number; end: number; closed: boolean };

function blockRanges(lines: string[]): BlockRange[] {
  const ranges: BlockRange[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    if (!isAnswerSurfaceFenceStart(lines[index])) continue;
    let end = index + 1;
    while (end < lines.length && !isAnswerSurfaceFenceEnd(lines[end])) end += 1;
    ranges.push({ start: index, end, closed: end < lines.length });
    index = end;
  }
  return ranges;
}

/** What is wrong with a block's source, or null when it renders with every value. */
export function answerSurfaceProblem(source: string, closed = true): string | null {
  if (!closed) return "The block was cut off: it has no closing ``` fence.";
  const parsed = parseAnswerSurfaceSource(source);
  if (!parsed.ok) return parsed.error;
  // Logic outputs are only known in the app's sandbox, so their formulas are not judged.
  const empty = lintAnswerSurface(parsed.spec, {}, { skipLogicValues: true });
  if (empty.length > 0) {
    return `These formulas have no value with the default inputs: ${empty.slice(0, 5).join("; ")}.`;
  }
  return null;
}

/** Every block of the message that needs repair, in order. */
export function findAnswerSurfaceProblems(message: string): AnswerSurfaceProblem[] {
  const lines = String(message || "").split("\n");
  const problems: AnswerSurfaceProblem[] = [];
  blockRanges(lines).forEach((range, blockIndex) => {
    const source = lines.slice(range.start + 1, range.end).join("\n");
    const error = answerSurfaceProblem(source, range.closed);
    if (error) problems.push({ blockIndex, source, error });
  });
  return problems;
}

/** The message with one block's source replaced (and its fence closed). */
export function replaceAnswerSurfaceBlock(
  message: string,
  blockIndex: number,
  source: string,
): string {
  const lines = String(message || "").split("\n");
  const range = blockRanges(lines)[blockIndex];
  if (!range) return message;
  const fenceEnd = range.closed ? [lines[range.end]] : ["```"];
  return [
    ...lines.slice(0, range.start + 1),
    source.trim(),
    ...fenceEnd,
    ...lines.slice(range.closed ? range.end + 1 : range.end),
  ].join("\n");
}

/** The JSON object in a repair reply: a bare object, or one inside a fence. */
export function extractRepairedBlock(reply: string): string | null {
  const text = String(reply || "").trim();
  const fenced = text.match(/```(?:cowork-ui|json)?\s*\n([\s\S]*?)\n\s*```/i);
  const body = (fenced ? fenced[1] : text).trim();
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start === -1 || end <= start) return null;
  return body.slice(start, end + 1);
}

/** The repair request for one block: the problem, the surrounding intent, the block. */
export function buildAnswerSurfaceRepairPrompt(
  problem: AnswerSurfaceProblem,
  prose: string,
): string {
  return [
    "This ```cowork-ui block from your answer cannot be shown as it is.",
    `Problem: ${problem.error}`,
    "",
    "Return only the corrected block as one strict JSON object (no fence, no comments, no explanation).",
    "Keep its content and intent; change only what is needed to fix the problem. Guard formulas so they give a number for every input in range.",
    "",
    prose ? `What the answer says around it:\n${prose.slice(0, 1200)}\n` : "",
    "Block:",
    problem.source.slice(0, 20_000),
  ].join("\n");
}

export type AnswerSurfaceRepairOutcome = { text: string; repaired: number; kept: string[] };

/**
 * Runs the repair loop over a message: for each broken block (at most MAX_REPAIRED_BLOCKS)
 * asks once, and swaps in the reply only when it checks out. `ask` makes the model call
 * and returns its text; a throwing or useless reply leaves that block as it was.
 */
export async function repairAnswerSurfaces(
  message: string,
  ask: (prompt: string) => Promise<string>,
): Promise<AnswerSurfaceRepairOutcome> {
  const problems = findAnswerSurfaceProblems(message);
  if (problems.length === 0) return { text: message, repaired: 0, kept: [] };
  const prose = message
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("```"))
    .join("\n");
  let text = message;
  let repaired = 0;
  const kept: string[] = [];
  for (const problem of problems.slice(0, MAX_REPAIRED_BLOCKS)) {
    let reply = "";
    try {
      reply = await ask(buildAnswerSurfaceRepairPrompt(problem, prose));
    } catch (error) {
      kept.push(error instanceof Error ? error.message : "the repair call failed");
      continue;
    }
    const fixed = extractRepairedBlock(reply);
    const stillBroken = fixed ? answerSurfaceProblem(fixed) : "no block in the reply";
    if (fixed && stillBroken === null) {
      text = replaceAnswerSurfaceBlock(text, problem.blockIndex, fixed);
      repaired += 1;
    } else {
      kept.push(String(stillBroken));
    }
  }
  return { text, repaired, kept };
}
