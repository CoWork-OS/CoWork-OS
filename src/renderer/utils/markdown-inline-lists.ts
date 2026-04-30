/**
 * Convert ATX headings (###, ##, #) that appear mid-line into line-start headings
 * so they render correctly. E.g. "From X: ### Architecture Overview" -> "From X:\n### Architecture Overview"
 */
export function normalizeInlineHeadings(text: string): string {
  return text.replace(/\s+(#{1,6})(\s+)/g, "\n$1$2");
}

/**
 * Split inline list items into proper newline-separated markdown list items.
 * Handles LLM output that puts "1. X 2. Y 3. Z" on one line instead of separate lines.
 * Uses [ \t]+ (space/tab only) between items so we don't match across existing newlines.
 * Also converts parenthetical numbers "(1) X (2) Y" into markdown list format.
 */
export function normalizeInlineLists(text: string): string {
  let prev = "";
  let result = text;
  while (result !== prev) {
    prev = result;
    // Numbered: "1. X 2. Y" or "1) X 2) Y" -> separate lines (space/tab between items only)
    result = result.replace(/(\d+[.)]\s+[^\n]+?)[ \t]+(\d+[.)]\s)/g, "$1\n$2");
    // Bullet: "- X - Y" or "• X • Y" -> separate lines
    result = result.replace(/([-*•]\s+[^\n]+?)[ \t]+([-*•]\s)/g, "$1\n$2");
  }
  // Parenthetical: "(1) X (2) Y" or ", (1) X, (2) Y" -> markdown list format
  result = result.replace(/\s+\((\d+)\)\s+/g, "\n$1. ");
  return result;
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
  result = result.replace(/^[ \t]*```(?:markdown|md)\s*\r?\n([\s\S]*?)\r?\n[ \t]*```(?!\w)/gim, "$1");
  // 2. Plain ``` with content containing # headings - likely a markdown document
  result = result.replace(/^[ \t]*```(?!\w)\s*\r?\n([\s\S]*?)\r?\n[ \t]*```(?!\w)/gm, (fullMatch, content) =>
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
 * Only fix when the line has an odd number of ** (one unclosed pair).
 */
export function fixUnclosedBold(text: string): string {
  return text.replace(/^.*$/gm, (line) => {
    const count = (line.match(/\*\*/g) || []).length;
    return count % 2 === 1 ? line + "**" : line;
  });
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
