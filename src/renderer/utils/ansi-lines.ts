import { stripOscSequences } from "../../shared/terminal-output-text";

/** One run of text with the same terminal style. */
export type AnsiSpan = {
  text: string;
  /** Palette index 0-15 for the foreground, if one is set. */
  fg?: number;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
};

type CellStyle = Omit<AnsiSpan, "text">;
type Cell = { char: string; style: CellStyle };

// Escapes are built from strings: the formatter rewrites \u escapes as invisible characters.
const CSI_PATTERN = new RegExp("\\u001b\\[([0-?]*)[ -/]*([@-~])", "g");
const OTHER_ESCAPE_PATTERN = new RegExp("\\u001b[@-Z\\\\-_]", "g");
const CONTROL_PATTERN = new RegExp("[\\u0000-\\u0007\\u000b\\u000c\\u000e-\\u001f\\u007f]");
const ESC = String.fromCharCode(0x1b);

function applySgr(style: CellStyle, params: string): CellStyle {
  const codes = params === "" ? [0] : params.split(";").map((part) => Number(part) || 0);
  let next: CellStyle = { ...style };
  for (let index = 0; index < codes.length; index += 1) {
    const code = codes[index];
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 3) next.italic = true;
    else if (code === 4) next.underline = true;
    else if (code === 22) {
      next.bold = false;
      next.dim = false;
    } else if (code === 23) next.italic = false;
    else if (code === 24) next.underline = false;
    else if (code >= 30 && code <= 37) next.fg = code - 30;
    else if (code >= 90 && code <= 97) next.fg = code - 90 + 8;
    else if (code === 39) delete next.fg;
    else if (code === 38 || code === 48) {
      // 256-colour and true-colour forms: keep the 16-colour part, skip the rest.
      const mode = codes[index + 1];
      if (code === 38 && mode === 5 && codes[index + 2] !== undefined && codes[index + 2] < 16) {
        next.fg = codes[index + 2];
      }
      index += mode === 5 ? 2 : mode === 2 ? 4 : 0;
    }
  }
  return next;
}

function sameStyle(a: CellStyle, b: CellStyle): boolean {
  return (
    a.fg === b.fg &&
    Boolean(a.bold) === Boolean(b.bold) &&
    Boolean(a.dim) === Boolean(b.dim) &&
    Boolean(a.italic) === Boolean(b.italic) &&
    Boolean(a.underline) === Boolean(b.underline)
  );
}

function cellsToSpans(cells: Cell[]): AnsiSpan[] {
  const spans: AnsiSpan[] = [];
  for (const cell of cells) {
    const last = spans[spans.length - 1];
    if (last && sameStyle(last, cell.style)) last.text += cell.char;
    else spans.push({ ...cell.style, text: cell.char });
  }
  return spans;
}

/**
 * Raw terminal output as styled lines, drawn the way a terminal would draw them:
 * colours and weight from SGR codes, carriage returns and backspaces redraw the line,
 * erase-in-line clears it, and other escapes are dropped.
 */
export function ansiToLines(raw: string): AnsiSpan[][] {
  const text = stripOscSequences(raw).replace(OTHER_ESCAPE_PATTERN, "");
  const lines: AnsiSpan[][] = [];
  let style: CellStyle = {};
  for (const rawLine of text.split("\n")) {
    const line = rawLine.endsWith("\r") ? rawLine.replace(/\r+$/, "") : rawLine;
    const cells: Cell[] = [];
    let cursor = 0;
    let index = 0;
    const put = (char: string) => {
      while (cells.length < cursor) cells.push({ char: " ", style: {} });
      cells[cursor] = { char, style };
      cursor += 1;
    };
    while (index < line.length) {
      const char = line[index];
      if (char === ESC && line[index + 1] === "[") {
        CSI_PATTERN.lastIndex = index;
        const match = CSI_PATTERN.exec(line);
        if (match && match.index === index) {
          const [sequence, params, final] = match;
          if (final === "m") style = applySgr(style, params);
          else if (final === "K") {
            if (params === "" || params === "0") cells.length = Math.min(cells.length, cursor);
            else if (params === "2") cells.length = 0;
          } else if (final === "G") cursor = Math.max(0, (Number(params) || 1) - 1);
          index += sequence.length;
          continue;
        }
      }
      if (char === "\r") cursor = 0;
      else if (char === "\b") cursor = Math.max(0, cursor - 1);
      else if (char === "\t") {
        const stop = (Math.floor(cursor / 8) + 1) * 8;
        while (cursor < stop) put(" ");
      } else if (!CONTROL_PATTERN.test(char)) put(char);
      index += 1;
    }
    lines.push(cellsToSpans(cells));
  }
  while (lines.length > 0 && lines[lines.length - 1].every((span) => !span.text.trim())) {
    lines.pop();
  }
  while (lines.length > 0 && lines[0].every((span) => !span.text.trim())) {
    lines.shift();
  }
  return lines;
}
