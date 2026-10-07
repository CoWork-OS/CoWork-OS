/**
 * Convert ATX headings (###, ##, #) that appear mid-line into line-start headings
 * so they render correctly. E.g. "From X: ### Architecture Overview" -> "From X:\n### Architecture Overview"
 * Only same-line spaces/tabs count, so existing line breaks and indentation are kept, and
 * fenced code is left untouched so "x = 1 # note" stays on its line.
 */
export function normalizeInlineHeadings(text: string): string {
  return transformOutsideFencedCode(text, (segment) =>
    segment.replace(/(?<=\S)[ \t]+(#{1,6})([ \t]+)/g, "\n$1$2"),
  );
}

const FENCE_OPEN_REGEX = /^[ \t]*(`{3,}|~{3,})/;
// A list marker only counts when space/tab and text follow it on the same line, so a
// sentence ending in "Door 1." never opens an empty item on the next line.
const NUMBERED_MARKER_REGEX = /(?<=^|[ \t])(\d{1,9})([.)])(?=[ \t]+\S)/g;
const BULLET_MARKER_REGEX = /(?<=^|[ \t])([-*•])(?=[ \t]+\S)/g;
const THEMATIC_BREAK_REGEX = /^[ \t]*([-*_])(?:[ \t]*\1){2,}[ \t]*$/;
const PARENTHETICAL_ITEM_REGEX = /\s+\((\d+)\)[ \t]+(?=\S)/g;

/**
 * Apply `transform` to the text outside fenced code blocks (``` or ~~~), leaving fence
 * contents untouched. An unclosed fence runs to the end of the text, as in CommonMark.
 */
function transformOutsideFencedCode(text: string, transform: (segment: string) => string): string {
  const output: string[] = [];
  let prose: string[] = [];
  let closingFence: RegExp | null = null;
  const flushProse = () => {
    if (prose.length > 0) output.push(transform(prose.join("\n")));
    prose = [];
  };
  for (const line of text.split("\n")) {
    if (closingFence) {
      output.push(line);
      if (closingFence.test(line)) closingFence = null;
      continue;
    }
    const open = line.match(FENCE_OPEN_REGEX);
    // A backtick fence's info string cannot contain backticks (that is inline code instead).
    if (open && !(open[1][0] === "`" && line.slice(open[0].length).includes("`"))) {
      flushProse();
      output.push(line);
      closingFence = new RegExp(`^[ \\t]*${open[1][0]}{${open[1].length},}[ \\t]*\\r?$`);
      continue;
    }
    prose.push(line);
  }
  flushProse();
  return output.join("\n");
}

/** Break `line` before each index in `splitAt`, dropping the spaces that preceded it. */
function breakLineAt(line: string, splitAt: number[], indent: string): string {
  let result = "";
  let cursor = 0;
  for (const index of splitAt) {
    result += line.slice(cursor, index).replace(/[ \t]+$/, "") + "\n" + indent;
    cursor = index;
  }
  return result + line.slice(cursor);
}

/**
 * Split "1. X 2. Y 3. Z" on one line. The numbers must count up by one with the same
 * delimiter, so prose like "Requires Node 18. Then Version 2. Next" is left alone. A run
 * that starts mid-line must start at 1. A line that already begins with a marker is a
 * rendered list item, so it needs three items before it is split: "1. Upgrade to Version 2.
 * Next, migrate." stays one item.
 */
function splitInlineNumberedItems(line: string): string {
  const markers = [...line.matchAll(NUMBERED_MARKER_REGEX)].map((match) => ({
    index: match.index ?? 0,
    value: Number(match[1]),
    delimiter: match[2],
  }));
  if (markers.length < 2) return line;
  const indent = line.match(/^[ \t]*/)?.[0] ?? "";
  const splitAt: number[] = [];
  let lineStartRun = false;
  let start = 0;
  while (start < markers.length) {
    const first = markers[start];
    let end = start + 1;
    while (
      end < markers.length &&
      markers[end].delimiter === first.delimiter &&
      markers[end].value === markers[end - 1].value + 1
    ) {
      end++;
    }
    const atLineStart = first.index === indent.length;
    if ((atLineStart || first.value === 1) && end - start >= (atLineStart ? 3 : 2)) {
      lineStartRun ||= atLineStart;
      for (let i = start + 1; i < end; i++) splitAt.push(markers[i].index);
      start = end;
    } else {
      start++;
    }
  }
  return splitAt.length > 0 ? breakLineAt(line, splitAt, lineStartRun ? indent : "") : line;
}

/**
 * Split "• X • Y" (anywhere on a line) and "- X - Y - Z" / "* X * Y * Z" (only on a line
 * that is already that kind of bullet item, with three items). Hyphens and asterisks are
 * ordinary prose and math ("people * 0.4 * 250", "**Speed** - it's faster"), so they need
 * the stronger signal, and a "-" or "*" followed by a digit never starts an item.
 */
function splitInlineBulletItems(line: string): string {
  if (THEMATIC_BREAK_REGEX.test(line)) return line;
  const markers = [...line.matchAll(BULLET_MARKER_REGEX)].map((match) => ({
    index: match.index ?? 0,
    char: match[1],
  }));
  if (markers.length < 2) return line;
  const indent = line.match(/^[ \t]*/)?.[0] ?? "";
  const dots = markers.filter((marker) => marker.char === "•");
  if (dots.length >= 2) {
    return breakLineAt(
      line,
      dots.slice(1).map((marker) => marker.index),
      dots[0].index === indent.length ? indent : "",
    );
  }
  const first = markers[0];
  if (first.char === "•" || first.index !== indent.length) return line;
  const items = markers.filter(
    (marker, i) =>
      marker.char === first.char && (i === 0 || !/^[ \t]+\d/.test(line.slice(marker.index + 1))),
  );
  if (items.length < 3) return line;
  return breakLineAt(
    line,
    items.slice(1).map((marker) => marker.index),
    indent,
  );
}

/**
 * Split inline list items into proper newline-separated markdown list items.
 * Handles LLM output that puts "1. X 2. Y 3. Z" on one line instead of separate lines,
 * and converts parenthetical numbers "(1) X (2) Y" into markdown list format.
 * Fenced code blocks are left untouched.
 */
export function normalizeInlineLists(text: string): string {
  return transformOutsideFencedCode(text, (segment) =>
    segment
      .split("\n")
      .map((line) =>
        splitInlineNumberedItems(line).split("\n").map(splitInlineBulletItems).join("\n"),
      )
      .join("\n")
      // Parenthetical: "(1) X (2) Y" or ", (1) X, (2) Y" -> markdown list format
      .replace(PARENTHETICAL_ITEM_REGEX, "\n$1. "),
  );
}

/**
 * Unwrap fenced code blocks with language "markdown" or "md" so the inner content
 * is parsed as markdown instead of displayed as literal code. LLMs often wrap
 * deliverables in ```markdown blocks. Also unwraps plain ``` blocks when the
 * content contains markdown headings (lines starting with #).
 */
export function unwrapMarkdownCodeBlocks(text: string): string {
  let result = text;
  // 1. ```markdown or ```md (case-insensitive) - always unwrap
  result = result.replace(
    /^[ \t]*```(?:markdown|md)\s*\r?\n([\s\S]*?)\r?\n[ \t]*```(?!\w)/gim,
    "$1",
  );
  // 2. Plain ``` with content containing # headings - likely a markdown document
  result = result.replace(
    /^[ \t]*```(?!\w)\s*\r?\n([\s\S]*?)\r?\n[ \t]*```(?!\w)/gm,
    (fullMatch, content) =>
      /\n#{1,6}\s/m.test(content) || /^#{1,6}\s/m.test(content) ? content : fullMatch,
  );
  return result;
}

/**
 * Remove trailing " **" from inside code blocks containing glob patterns.
 * LLMs sometimes output glob + " **" (trying to bold the code) which leaves
 * literal asterisks visible.
 */
function stripTrailingBoldFromGlobCodeBlocks(text: string): string {
  return text.replace(/`(\*\*\/\*[\w*?[\]{}.-]+)\s*\*\*`/g, "`$1`");
}

/**
 * Wrap glob patterns (e.g. **\/*team*) in backticks so they render as code
 * instead of confusing the bold delimiter parser.
 */
function wrapGlobPatterns(text: string): string {
  const globPattern = /\*\*\/[A-Za-z0-9_./*?[\]{}-]+/g;
  const parts = text.split("`");
  // With odd number of backticks the last segment is inside an unclosed backtick —
  // cap the loop so we don't process it as outside-code text.
  const safeLen = parts.length % 2 === 0 ? parts.length - 1 : parts.length;
  for (let i = 0; i < safeLen; i += 2) {
    // Only process non-code segments (odd split indices are inside backticks)
    parts[i] = parts[i].replace(globPattern, (m) => "`" + m + "`");
  }
  return parts.join("`");
}

/**
 * Fix unclosed bold at end of line (e.g. "**Electron" or "**CoWork OS").
 * CommonMark leaves these as literal; adding the closing ** makes them render.
 * Only fix when the line has an odd number of ** (one unclosed pair). Fenced code is left
 * untouched, since "y = x ** 2" there is not bold.
 */
export function fixUnclosedBold(text: string): string {
  return transformOutsideFencedCode(text, (segment) =>
    segment.replace(/^.*$/gm, (line) => {
      const count = (line.match(/\*\*/g) || []).length;
      return count % 2 === 1 ? line + "**" : line;
    }),
  );
}

/**
 * Full markdown normalization for collab display: inline headings + inline lists,
 * plus glob wrapping and unclosed-bold fixes so ** renders correctly.
 */
export function normalizeMarkdownForCollab(text: string): string {
  let result = text;
  result = unwrapMarkdownCodeBlocks(result);
  result = stripTrailingBoldFromGlobCodeBlocks(result);
  result = wrapGlobPatterns(result);
  result = fixUnclosedBold(result);
  result = normalizeInlineHeadings(result);
  result = normalizeInlineLists(result);
  return result;
}
