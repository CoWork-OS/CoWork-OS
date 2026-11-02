/**
 * Inline & Spill for tool results. When a result is shortened to fit the context window,
 * its full text is kept outside the window under a short handle, and the omission marker
 * says how to page through it:
 *
 *   [... 51234 chars omitted; call tool_result_read(handle="sp0123456789ab", offset=4000) to continue ...]
 *
 * This module holds the handle and marker formats and the sink the truncation code writes
 * to; tool-result-spill-store.ts keeps the text on disk and serves pages of it.
 */

export const TOOL_RESULT_READ_TOOL = "tool_result_read";

/** A base handle is "sp" + 12 hex chars; one part of a multi-part result adds ".<n>". */
const SPILL_HANDLE_SOURCE = String.raw`sp[0-9a-f]{12}(?:\.\d{1,6})?`;
const SPILL_HANDLE_RE = new RegExp(`^${SPILL_HANDLE_SOURCE}$`);

export function isSpillHandle(value: unknown): value is string {
  return typeof value === "string" && SPILL_HANDLE_RE.test(value);
}

/** Handle of part `index` of the result whose base handle is `base`. */
export function spillPartHandle(base: string, index: number): string {
  return `${base}.${index}`;
}

/** Where the truncation code keeps the full text of what it omits. */
export interface ToolResultSpillSink {
  /** A fresh base handle. Parts of one result are `${base}.${n}` (spillPartHandle). */
  newHandle(): string;
  /** Keep each entry's full text under its handle (all or none). False when nothing was kept. */
  write(parts: ReadonlyMap<string, string>): boolean;
}

/** Where the omitted text of one notice continues: a handle and the offset into its text. */
export interface SpillLocation {
  handle: string;
  offset: number;
}

export function omittedCharsNotice(omitted: number, spill?: SpillLocation): string {
  return spill
    ? `[... ${omitted} chars omitted; call ${TOOL_RESULT_READ_TOOL}(handle="${spill.handle}", ` +
        `offset=${spill.offset}) to continue ...]`
    : `[... ${omitted} chars omitted ...]`;
}

export function omittedItemsNotice(omitted: number, handle?: string): string {
  return (
    `[... ${omitted} more items omitted to fit the tool-result budget` +
    (handle ? `; call ${TOOL_RESULT_READ_TOOL}(handle="${handle}", offset=0) to read them` : "") +
    " ...]"
  );
}

/**
 * Either form of the omitted-chars notice, with the newline on each side that the
 * trimmers add. Groups: 1 omitted count, 2 handle (optional), 3 offset (optional).
 */
const OMITTED_CHARS_NOTICE_SOURCE =
  String.raw`\n?\[\.\.\. (\d+) chars omitted` +
  String.raw`(?:; call tool_result_read\(handle="(${SPILL_HANDLE_SOURCE})", offset=(\d+)\) to continue)?` +
  String.raw` \.\.\.\]\n?`;

/** A fresh global regex for omitted-chars notices (callers iterate with matchAll/exec). */
export function omittedCharsNoticeRegExp(): RegExp {
  return new RegExp(OMITTED_CHARS_NOTICE_SOURCE, "g");
}

/** `^[... N more items omitted`, at the start of an omitted-items notice. */
export const OMITTED_ITEMS_NOTICE_RE = /^\[\.\.\. (\d+) more items omitted/;

const SPILL_CLAUSE_RE = new RegExp(
  String.raw`; call tool_result_read\(handle="(${SPILL_HANDLE_SOURCE})", offset=\d+\) to (?:continue|read them)`,
  "g",
);

/**
 * Text whose notices lose their tool_result_read clauses (for text that was not kept):
 * every clause, or only those that name `handle`.
 */
export function stripSpillClauses(text: string, handle?: string): string {
  return text.replace(SPILL_CLAUSE_RE, (clause, clauseHandle: string) =>
    handle === undefined || clauseHandle === handle ? "" : clause,
  );
}

// Matches a tool_result_read call in plain text and inside a JSON string (escaped quotes).
const SPILL_REFERENCE_RE = new RegExp(
  String.raw`tool_result_read\(handle=\\?"(${SPILL_HANDLE_SOURCE})\\?", offset=(\d+)\)`,
  "g",
);

/** Every tool_result_read reference in text, in order, first offset per handle. */
export function extractSpillReferences(text: string): SpillLocation[] {
  if (typeof text !== "string" || !text.includes(TOOL_RESULT_READ_TOOL)) return [];
  const seen = new Set<string>();
  const out: SpillLocation[] = [];
  for (const match of text.matchAll(SPILL_REFERENCE_RE)) {
    const handle = match[1]!;
    if (seen.has(handle)) continue;
    seen.add(handle);
    out.push({ handle, offset: Number(match[2]) });
  }
  return out;
}

/**
 * Spills fields of one result on first need: each field is written once, under its own
 * handle, the first time a trimmer has to cut it. For trimmers that retry at smaller
 * sizes, so a field is never written twice.
 */
export class LazyFieldSpill {
  private readonly handles = new Map<string, string | null>();

  constructor(private readonly sink?: ToolResultSpillSink) {}

  /** The handle under which `text` (the field's full value) is kept, or undefined. */
  handleFor(field: string, text: string): string | undefined {
    if (!this.sink) return undefined;
    const known = this.handles.get(field);
    if (known !== undefined) return known ?? undefined;
    let handle: string | null = null;
    try {
      const candidate = this.sink.newHandle();
      if (this.sink.write(new Map([[candidate, text]]))) handle = candidate;
    } catch {
      handle = null;
    }
    this.handles.set(field, handle);
    return handle ?? undefined;
  }
}

/** Header of the handle index that compaction keeps in its summary block. */
export const SPILL_HANDLE_INDEX_HEADER =
  "Shortened tool results you can still page with tool_result_read (handle, tool, where the omitted text starts):";

export interface SpillIndexEntry extends SpillLocation {
  toolName?: string;
}

/**
 * The spilled results of messages that compaction removes, so their handles survive the
 * summary. Keeps the most recent `max` handles. Empty when there are none.
 */
export function buildSpillHandleIndex(entries: SpillIndexEntry[], max = 20): string {
  const byHandle = new Map<string, SpillIndexEntry>();
  for (const entry of entries) {
    if (!isSpillHandle(entry.handle)) continue;
    byHandle.delete(entry.handle);
    byHandle.set(entry.handle, entry);
  }
  const kept = Array.from(byHandle.values()).slice(-max);
  if (kept.length === 0) return "";
  const lines = kept.map((entry) => {
    const tool = entry.toolName ? ` (${entry.toolName.replace(/[^A-Za-z0-9_.-]/g, "")})` : "";
    return `- ${TOOL_RESULT_READ_TOOL}(handle="${entry.handle}", offset=${entry.offset})${tool}`;
  });
  return [SPILL_HANDLE_INDEX_HEADER, ...lines].join("\n");
}

/** Text without a handle index built by buildSpillHandleIndex (for memory capture). */
export function stripSpillHandleIndex(text: string): string {
  const start = text.indexOf(SPILL_HANDLE_INDEX_HEADER);
  if (start < 0) return text;
  const lines = text.slice(start).split("\n");
  let end = 1;
  while (end < lines.length && lines[end]!.startsWith(`- ${TOOL_RESULT_READ_TOOL}(`)) end += 1;
  const rest = lines.slice(end).join("\n");
  return `${text.slice(0, start)}${rest}`.replace(/\n{3,}/g, "\n\n").trim();
}
