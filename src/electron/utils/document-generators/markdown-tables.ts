/**
 * GitHub-flavored markdown table parsing shared by the document generators.
 *
 * A table is a header row, a delimiter row such as `| --- | :-: |`, and any
 * number of body rows. Cells are split on unescaped pipes; a leading and a
 * trailing pipe are optional.
 */

export type MarkdownTableAlignment = "left" | "center" | "right" | undefined;

export interface MarkdownTable {
  header: string[];
  alignments: MarkdownTableAlignment[];
  rows: string[][];
}

const DELIMITER_CELL = /^:?-+:?$/;

/** Splits one table line into trimmed cells, honoring `\|` escapes. */
export function splitMarkdownTableRow(line: string): string[] {
  let body = line.trim();
  if (body.startsWith("|")) body = body.slice(1);
  if (body.endsWith("|") && !body.endsWith("\\|")) body = body.slice(0, -1);

  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === "\\" && body[index + 1] === "|") {
      current += "|";
      index += 1;
    } else if (char === "|") {
      cells.push(current.trim());
      current = "";
    } else {
      current += char;
    }
  }
  cells.push(current.trim());
  return cells;
}

function isTableRow(line: string): boolean {
  return line.includes("|") && line.trim().length > 0;
}

function parseDelimiterRow(line: string): MarkdownTableAlignment[] | null {
  if (!isTableRow(line)) return null;
  const cells = splitMarkdownTableRow(line);
  if (cells.length === 0 || !cells.every((cell) => DELIMITER_CELL.test(cell))) return null;
  return cells.map((cell) =>
    cell.startsWith(":") && cell.endsWith(":")
      ? "center"
      : cell.endsWith(":")
        ? "right"
        : cell.startsWith(":")
          ? "left"
          : undefined,
  );
}

/**
 * Parses a table that starts at `lines[start]`. Returns the table and the
 * index of the first line after it, or null when no table starts there.
 */
export function parseMarkdownTableAt(
  lines: readonly string[],
  start: number,
): { table: MarkdownTable; end: number } | null {
  const headerLine = lines[start];
  const delimiterLine = lines[start + 1];
  if (headerLine === undefined || delimiterLine === undefined || !isTableRow(headerLine)) {
    return null;
  }
  const alignments = parseDelimiterRow(delimiterLine);
  const header = splitMarkdownTableRow(headerLine);
  if (!alignments || alignments.length !== header.length) return null;

  const rows: string[][] = [];
  let end = start + 2;
  while (end < lines.length && isTableRow(lines[end])) {
    rows.push(splitMarkdownTableRow(lines[end]));
    end += 1;
  }
  return { table: { header, alignments, rows }, end };
}

/** Parses text that is exactly one markdown table; anything else returns null. */
export function parseMarkdownTable(text: string): MarkdownTable | null {
  const lines = text
    .trim()
    .split(/\r?\n/)
    .map((line) => line.trim());
  const parsed = parseMarkdownTableAt(lines, 0);
  return parsed && parsed.end === lines.length ? parsed.table : null;
}
