/**
 * Terminal output helpers for shell code blocks run from an answer: turning raw PTY
 * output into plain text, and the follow-up message that hands that output to the agent.
 */

/** Longest output, in characters, that the follow-up message carries. */
export const CODE_BLOCK_RUN_MESSAGE_OUTPUT_LIMIT = 12_000;

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

// OSC (ESC ] ... BEL | ESC \), CSI (ESC [ ... final byte), and two-byte escapes.
const OSC_PATTERN = new RegExp(`${ESC}\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)`, "g");
const CSI_PATTERN = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, "g");
const OTHER_ESCAPE_PATTERN = new RegExp(`${ESC}[@-Z\\\\-_]`, "g");
// C0 controls other than tab, newline and carriage return.
const CONTROL_PATTERN = new RegExp("[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]", "g");

/** Drop OSC sequences, which never draw anything. */
export function stripOscSequences(text: string): string {
  return text.replace(OSC_PATTERN, "");
}

/** Apply backspaces and carriage returns the way a terminal draws one line. */
export function resolveTerminalLine(line: string): string {
  // A carriage return before the line end is the CRLF pair, not a redraw.
  const trimmed = line.endsWith("\r") ? line.replace(/\r+$/, "") : line;
  let cells: string[] = [];
  let cursor = 0;
  for (const char of trimmed) {
    if (char === "\r") {
      cursor = 0;
    } else if (char === "\b") {
      cursor = Math.max(0, cursor - 1);
    } else {
      cells[cursor] = char;
      cursor += 1;
    }
  }
  cells = Array.from(cells, (cell) => cell ?? " ");
  return cells.join("");
}

/** Raw PTY output as plain text: escapes removed, redraws applied, trailing blank lines cut. */
export function terminalOutputToPlainText(raw: string): string {
  const withoutEscapes = stripOscSequences(raw)
    .replace(CSI_PATTERN, "")
    .replace(OTHER_ESCAPE_PATTERN, "");
  const lines = withoutEscapes
    .split("\n")
    .map((line) => resolveTerminalLine(line).replace(CONTROL_PATTERN, "").replace(/\s+$/, ""));
  while (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  while (lines.length > 0 && lines[0] === "") lines.shift();
  return lines.join("\n");
}

/** Keep the head and the tail of long output, which is where commands report what happened. */
export function truncateMiddle(text: string, limit: number): { text: string; truncated: boolean } {
  if (text.length <= limit) return { text, truncated: false };
  const head = Math.floor(limit * 0.3);
  const tail = limit - head;
  const omitted = text.length - head - tail;
  return {
    text: `${text.slice(0, head)}\n… ${omitted} characters omitted …\n${text.slice(-tail)}`,
    truncated: true,
  };
}

function fenceFor(text: string): string {
  let longest = 2;
  for (const match of text.matchAll(/`{3,}/g)) {
    longest = Math.max(longest, match[0].length);
  }
  return "`".repeat(longest + 1);
}

export type CodeBlockRunOutcome = {
  command: string;
  /** Raw PTY output of the run. */
  output: string;
  exitCode: number | null;
  /** The runner kept only the tail of the output. */
  outputTruncated?: boolean;
};

const RUN_MESSAGE_INTRO = "I ran this command in my terminal (";

/** The command and exit status of a message built by buildCodeBlockRunMessage. */
export function parseCodeBlockRunMessage(
  message: string,
): { command: string; exitCode: number | null } | null {
  if (!message.startsWith(RUN_MESSAGE_INTRO)) return null;
  const status =
    /^I ran this command in my terminal \((?:exit code (-?\d+)|exit status unknown)\):/.exec(
      message,
    );
  const fence = /\n\n(`{3,})sh\n([\s\S]*?)\n\1\n/.exec(message);
  if (!status || !fence) return null;
  return { command: fence[2], exitCode: status[1] === undefined ? null : Number(status[1]) };
}

/** The follow-up message that hands a code block run's output to the agent. */
export function buildCodeBlockRunMessage(outcome: CodeBlockRunOutcome): string {
  const command = outcome.command.trim();
  const status =
    outcome.exitCode === null ? "exit status unknown" : `exit code ${outcome.exitCode}`;
  const plain = terminalOutputToPlainText(outcome.output);
  const { text, truncated } = truncateMiddle(plain, CODE_BLOCK_RUN_MESSAGE_OUTPUT_LIMIT);
  const commandFence = fenceFor(command);
  const lines = [`${RUN_MESSAGE_INTRO}${status}):`, "", `${commandFence}sh`];
  lines.push(command, commandFence, "");
  if (!text) {
    lines.push("It printed nothing.");
  } else {
    const outputFence = fenceFor(text);
    const note = truncated || outcome.outputTruncated ? "Output (shortened):" : "Output:";
    lines.push(note, "", `${outputFence}text`, text, outputFence);
  }
  return lines.join("\n");
}
