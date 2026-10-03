/**
 * Budget truncation that respects prompt fragment boundaries.
 *
 * Memory and context blocks are line-oriented: wrapper tags such as
 * `<cowork_hot_memory>` sit on their own lines and every fragment is one line
 * (a bullet, a heading or a paragraph line). Cutting at a character offset can
 * leave half a bullet and an unclosed wrapper tag, which lets the next prompt
 * section read as part of the memory block. This helper keeps whole lines only,
 * drops dangling headings, and closes every wrapper tag it left open.
 */

const CHARS_PER_TOKEN = 4;
const OPEN_TAG_LINE = /^<([a-z][a-z0-9_:-]*)(?:\s[^<>]*)?>$/i;
const CLOSE_TAG_LINE = /^<\/([a-z][a-z0-9_:-]*)>$/i;
const HEADING_LINE = /^#{1,6}\s/;

function closingTag(name: string): string {
  return `</${name}>`;
}

function closingCost(openTags: string[], markerLength: number): number {
  return openTags.reduce((sum, name) => sum + closingTag(name).length + 1, 0) + markerLength;
}

function applyTagLine(openTags: string[], line: string): string[] {
  const trimmed = line.trim();
  const openMatch = OPEN_TAG_LINE.exec(trimmed);
  if (openMatch) return [...openTags, openMatch[1]];
  const closeMatch = CLOSE_TAG_LINE.exec(trimmed);
  if (closeMatch) {
    const index = openTags.lastIndexOf(closeMatch[1]);
    return index === -1 ? openTags : openTags.slice(0, index);
  }
  return openTags;
}

/**
 * Truncate `text` to roughly `maxTokens` (4 chars per token, the same estimate the
 * prompt composer uses) on a line boundary. Returns the text unchanged when it fits.
 * `marker` is appended inside the innermost open block when anything was cut.
 */
export function truncateAtFragmentBoundary(
  text: string,
  maxTokens: number,
  marker = "[... truncated for budget]",
): string {
  const source = String(text || "");
  const maxChars = Math.max(0, Math.floor(maxTokens * CHARS_PER_TOKEN));
  if (source.length <= maxChars) return source;
  if (maxChars === 0) return "";

  const markerLength = marker ? marker.length + 1 : 0;
  const lines = source.split("\n");
  const kept: string[] = [];
  let openTags: string[] = [];
  let used = 0;

  for (const line of lines) {
    const nextOpenTags = applyTagLine(openTags, line);
    const lineCost = line.length + 1;
    if (used + lineCost + closingCost(nextOpenTags, markerLength) > maxChars) break;
    kept.push(line);
    used += lineCost;
    openTags = nextOpenTags;
  }

  // Drop trailing blank lines, headings without content and wrappers opened
  // without any content, so the cut does not end on an empty heading.
  while (kept.length > 0) {
    const last = kept[kept.length - 1].trim();
    if (!last || HEADING_LINE.test(last)) {
      kept.pop();
      continue;
    }
    const openMatch = OPEN_TAG_LINE.exec(last);
    if (openMatch && openTags[openTags.length - 1] === openMatch[1]) {
      kept.pop();
      openTags = openTags.slice(0, -1);
      continue;
    }
    break;
  }

  if (kept.length === 0 && openTags.length === 0) {
    // A single line longer than the whole budget (for example minified JSON):
    // fall back to a character cut of plain text.
    const firstLine = lines.find((line) => line.trim() && !OPEN_TAG_LINE.test(line.trim()));
    if (!firstLine) return "";
    const room = Math.max(0, maxChars - markerLength);
    const cut = firstLine.slice(0, room).trimEnd();
    return cut ? (marker ? `${cut}\n${marker}` : cut) : "";
  }

  const out = [...kept];
  if (marker) out.push(marker);
  for (let index = openTags.length - 1; index >= 0; index -= 1) {
    out.push(closingTag(openTags[index]));
  }
  return out.join("\n");
}
