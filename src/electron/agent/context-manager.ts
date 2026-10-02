import { LLMMessage, LLMContent as _LLMContent, LLMToolResult as _LLMToolResult } from "./llm";
import { estimateImageTokens } from "./llm/image-utils";
import { getModelContextWindow } from "../../shared/model-metadata";
import { PINNED_CONTEXT_OPEN_TAGS } from "./pinned-context-blocks";

/**
 * Context Manager handles conversation history to prevent "input too long" errors
 * Manages context through compaction and truncation
 */

// Approximate token limits for different models
const MODEL_LIMITS: Record<string, number> = {
  // Claude Opus/Sonnet 4.6+ and the Claude 5 family ship a 1M window by default
  // (no beta header); Haiku 4.5 and the 4.5-and-older Opus/Sonnet models stay at 200K.
  "opus-4-6": 1_000_000,
  "sonnet-4-6": 1_000_000,
  "opus-4-5": 200000,
  "sonnet-4-5": 200000,
  "haiku-4-5": 200000,
  "sonnet-4": 200000,
  "sonnet-3-5": 200000,
  "haiku-3-5": 200000,
  // Common OpenAI model ids (conservative; underestimating is safer than overrunning).
  "gpt-4o": 128000,
  "gpt-4o-mini": 128000,
  "gpt-4.1": 128000,
  "gpt-4.1-mini": 128000,
  "gpt-4-turbo": 128000,
  "gpt-6-astra": 1_050_000,
  "gpt-6.1-sol": 1_050_000,
  "gpt-6-sol": 1_050_000,
  "gpt-6-luna": 1_050_000,
  "gpt-3.5-turbo": 16000,
  o1: 200000,
  "o1-mini": 128000,
  default: 100000,
};

/**
 * Resolve a Claude context window from any id shape: catalog keys ("opus-4-6"),
 * API ids ("claude-sonnet-5", "claude-opus-4-5-20251101"), OpenRouter ids
 * ("anthropic/claude-sonnet-4.6"), Bedrock ids ("us.anthropic.claude-opus-4-6-v1:0"),
 * and legacy ids ("claude-3-5-sonnet-latest").
 */
function inferClaudeLimit(key: string): number | null {
  // Versions are 1-2 digits so date suffixes ("sonnet-4-20250514") are not read as one.
  const current = key.match(
    /(opus|sonnet|haiku|fable|mythos)[-_.]?(\d{1,2})(?!\d)(?:[-_.](\d{1,2})(?!\d))?/,
  );
  if (current) {
    const family = current[1];
    const major = Number(current[2]);
    const minor = current[3] ? Number(current[3]) : 0;
    if (family === "fable" || family === "mythos") return 1_000_000;
    if (family === "haiku") return 200000;
    if (major >= 5 || (major === 4 && minor >= 6)) return 1_000_000;
    return 200000;
  }

  if (
    key.includes("claude") ||
    key.includes("sonnet") ||
    key.includes("opus") ||
    key.includes("haiku")
  ) {
    return 200000;
  }

  return null;
}

/**
 * Fallback windows for models the catalogue does not list. Values are the smallest
 * window across the family's API models, so compaction never overruns.
 */
function inferOpenModelLimit(key: string): number | null {
  if (key.includes("gemini")) return 1_000_000;
  if (/kimi-k2(?![-.]?0711)/.test(key)) return 262_144;
  if (key.includes("kimi") || key.includes("moonshot")) return 131_072;
  if (/glm-(?:4\.[6-9]|[5-9])/.test(key)) return 200_000;
  if (key.includes("glm")) return 131_072;
  if (key.includes("deepseek")) return 131_072;
  if (key.includes("minimax")) return 200_000;
  if (key.includes("qwen")) return 131_072;
  if (/grok-(?:[4-9])/.test(key)) return 256_000;
  if (key.includes("grok")) return 131_072;
  return null;
}

function inferModelLimit(modelKey: string): number | null {
  const key = modelKey.toLowerCase().trim();
  if (!key) return null;

  if (/gpt-6(?:\.1)?-(?:astra|sol|luna)/.test(key)) return 1_050_000;

  // Claude first: the catalogue lists Sonnet 4.5's beta 1M window, which CoWork does not enable.
  const claudeLimit = inferClaudeLimit(key);
  if (claudeLimit) return claudeLimit;

  // Generated models.dev snapshot (npm run models:sync), then family heuristics.
  const catalogueLimit = getModelContextWindow(key);
  if (catalogueLimit) return catalogueLimit;

  // Try to parse "8k", "16k", "32k", "128k" patterns.
  const match = key.match(/(^|[^0-9])(\d{1,3})k([^0-9]|$)/);
  if (match) {
    const k = Number(match[2]);
    if (Number.isFinite(k) && k > 0) {
      return k * 1000;
    }
  }

  return inferOpenModelLimit(key);
}

// Reserve tokens for system prompt and response
const RESERVED_TOKENS = 8000;

// Maximum tokens for a single tool result
const MAX_TOOL_RESULT_TOKENS_DEFAULT = 10000;
const MAX_TOOL_RESULT_TOKENS_DOCUMENT = 30000;

// Number of trailing messages inspected to identify "active" file paths.
// Older messages that reference these paths are given budget priority during compaction.
const ACTIVE_PATH_CONTEXT_WINDOW = 4;

// Messages that begin with one of these tags are treated as "pinned" and should
// survive compaction. (They are system-generated context blocks, not normal chat turns.)
const PINNED_MESSAGE_TAG_PREFIXES = PINNED_CONTEXT_OPEN_TAGS;

function messageTextForPinnedCheck(message: LLMMessage): string {
  if (typeof message.content === "string") return message.content;
  if (!Array.isArray(message.content)) return "";

  // Prefer the first text block if present.
  for (const block of message.content as Any[]) {
    if (block && block.type === "text" && typeof block.text === "string") {
      return block.text;
    }
  }
  return "";
}

function isPinnedMessage(message: LLMMessage): boolean {
  const text = messageTextForPinnedCheck(message).trimStart();
  if (!text) return false;
  return PINNED_MESSAGE_TAG_PREFIXES.some((prefix) => text.startsWith(prefix));
}

function messageHasToolUse(message: LLMMessage): boolean {
  if (!Array.isArray(message.content)) return false;
  return message.content.some((block: Any) => block?.type === "tool_use");
}

function messageHasToolResult(message: LLMMessage): boolean {
  if (!Array.isArray(message.content)) return false;
  return message.content.some((block: Any) => block?.type === "tool_result");
}

/**
 * Estimate token count from text (rough approximation)
 * LLMs use ~4 characters per token on average for English text
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  return Math.ceil(text.length / 4);
}

/**
 * Estimate tokens for a message
 */
export function estimateMessageTokens(message: LLMMessage): number {
  if (typeof message.content === "string") {
    return estimateTokens(message.content) + 10; // Add overhead for role, etc.
  }

  let tokens = 10; // Base overhead
  for (const content of message.content) {
    if (content.type === "text") {
      tokens += estimateTokens(content.text);
    } else if (content.type === "tool_use") {
      tokens += estimateTokens(content.name) + estimateTokens(JSON.stringify(content.input));
    } else if (content.type === "tool_result") {
      tokens += estimateTokens(content.content);
    } else if (content.type === "image") {
      tokens += estimateImageTokens(content);
    }
  }
  return tokens;
}

/**
 * Estimate total tokens for all messages
 */
export function estimateTotalTokens(messages: LLMMessage[], systemPrompt?: string): number {
  let total = systemPrompt ? estimateTokens(systemPrompt) : 0;
  for (const msg of messages) {
    total += estimateMessageTokens(msg);
  }
  return total;
}

/**
 * Truncate a string to fit within token limit
 */
export function truncateToTokens(text: string, maxTokens: number): string {
  const maxChars = maxTokens * 4;
  if (text.length <= maxChars) return text;

  const truncated = text.slice(0, maxChars - 100);
  return truncated + "\n\n[... content truncated due to length ...]";
}

/**
 * Safely parse JSON, returning null if parsing fails
 */
function safeJsonParse(jsonString: string): Any | null {
  try {
    return JSON.parse(jsonString);
  } catch {
    return null;
  }
}

function isExpandedDocumentPayload(parsed: Any): boolean {
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
  if (typeof parsed.content !== "string") return false;

  const format = String(parsed.format || "").toLowerCase();
  if (format === "docx" || format === "pdf" || format === "pptx") return true;

  const filePath = String(parsed.path || "").toLowerCase();
  return /\.(docx|pdf|pptx)$/i.test(filePath);
}

function getToolResultTokenBudget(parsed: Any | null): number {
  if (parsed && isExpandedDocumentPayload(parsed)) {
    return MAX_TOOL_RESULT_TOKENS_DOCUMENT;
  }
  return MAX_TOOL_RESULT_TOKENS_DEFAULT;
}

// Strings at or below this many JSON-escaped chars are never shortened.
const MIN_TRIMMED_STRING_CHARS = 400;
// Room kept free for the `_truncated` note added to trimmed JSON objects.
const TRUNCATION_NOTE_RESERVE = 400;
// Log-like fields report failures at the end, so they keep more tail than head.
const LOG_LIKE_KEYS = new Set([
  "stdout",
  "stderr",
  "output",
  "log",
  "logs",
  "trace",
  "traceback",
  "stack",
  "stacktrace",
]);
const LOG_HEAD_RATIO = 0.3;
const DEFAULT_HEAD_RATIO = 0.6;
const PLAIN_TEXT_HEAD_RATIO = 0.5;
// Trailing window notes written by read_file ("[... File window 0-30000 of 90000 bytes ...]",
// "[... Content window ...]") and parse_document ("[Content window 0-50000 of 90000 characters]").
const READ_WINDOW_NOTE_RE =
  /\n{1,2}\[(?:\.\.\. )?(?:File|Content) window (\d+)-(\d+) of (?:at least )?(\d+) (bytes|chars|characters)(?: \.\.\.)?\]\s*$/;
const READ_FILES_TRUNCATION_NOTE_RE = /\[\.\.\. truncated by read_files \.\.\.\]\s*$/;
// Notes this module appends when it trims a read window or a read_files entry. Compaction
// can trim a result again, and these must not be mistaken for file content then.
const TRIMMED_READ_NOTE_RE =
  /\n\n\[\.\.\. trimmed to fit the tool-result budget: delivered (?:bytes|chars) \d+-\d+ of \d+\. Call [a-z_]+ with [A-Za-z_]+=\d+ to continue \.\.\.\]\s*$/;
const TRIMMED_READ_FILES_NOTE_RE =
  /\n\n\[\.\.\. \d+ chars of this file omitted to fit the tool-result budget\. Call read_file with path .*? to read the rest \.\.\.\]\s*$/;
const OMITTED_ITEMS_NOTICE_RE = /^\[\.\.\. (\d+) more items omitted/;
const OMITTED_CHARS_NOTICE_RE = /\n?\[\.\.\. (\d+) chars omitted \.\.\.\]\n?/g;

function isPlainObject(value: unknown): value is Record<string, Any> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff;
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}

/** Move a cut point so it never separates a surrogate pair. */
function alignCut(text: string, index: number, direction: "back" | "forward"): number {
  if (index <= 0 || index >= text.length) return index;
  if (isHighSurrogate(text.charCodeAt(index - 1)) && isLowSurrogate(text.charCodeAt(index))) {
    return direction === "back" ? index - 1 : index + 1;
  }
  return index;
}

/** End a head excerpt right after a nearby newline so it holds whole lines. */
function snapHeadEnd(text: string, end: number): number {
  if (end <= 0) return 0;
  const newline = text.lastIndexOf("\n", end - 1);
  if (newline >= 0 && end - (newline + 1) <= Math.min(2000, Math.floor(end / 4))) {
    return newline + 1;
  }
  return alignCut(text, end, "back");
}

/** Start a tail excerpt at the beginning of a nearby line. */
function snapTailStart(text: string, start: number): number {
  if (start <= 0) return 0;
  if (text[start - 1] === "\n") return start;
  const newline = text.indexOf("\n", start);
  if (
    newline >= 0 &&
    newline + 1 - start <= Math.min(2000, Math.floor((text.length - start) / 4))
  ) {
    return newline + 1;
  }
  return alignCut(text, start, "forward");
}

function omittedCharsNotice(omitted: number): string {
  return `[... ${omitted} chars omitted ...]`;
}

/**
 * Keep the start and the end of text within maxChars and mark the omitted middle,
 * so errors and summaries at the end of an output survive truncation.
 */
function trimHeadTail(text: string, maxChars: number, headRatio: number): string {
  if (text.length <= maxChars) return text;
  const keep = Math.max(0, maxChars - omittedCharsNotice(text.length).length - 2);
  const headBudget = Math.floor(keep * headRatio);
  const headEnd = snapHeadEnd(text, headBudget);
  const tailStart = Math.max(headEnd, snapTailStart(text, text.length - (keep - headBudget)));
  const head = text.slice(0, headEnd);
  const tail = text.slice(tailStart);
  // Text trimmed before (e.g. re-trimmed during compaction) carries earlier notices:
  // count what they stood for instead of the notice text itself.
  let omitted = tailStart - headEnd;
  for (const match of text.slice(headEnd, tailStart).matchAll(OMITTED_CHARS_NOTICE_RE)) {
    omitted += Number(match[1]) - match[0].length;
  }
  // Always exactly one newline on each side, so a notice can be told apart from the text.
  const beforeNotice = head ? "\n" : "";
  const afterNotice = tail ? "\n" : "";
  return `${head}${beforeNotice}${omittedCharsNotice(omitted)}${afterNotice}${tail}`;
}

function jsonEscapedLength(text: string): number {
  return JSON.stringify(text).length - 2;
}

/** Length of the longest prefix of text[0, end) whose JSON-escaped form fits budget. */
function prefixWithinEscapedBudget(text: string, end: number, budget: number): number {
  let used = 0;
  let index = 0;
  while (index < end) {
    const code = text.charCodeAt(index);
    let width = 1;
    let cost = 1;
    if (code === 0x22 || code === 0x5c) {
      cost = 2;
    } else if (code < 0x20) {
      cost =
        code === 0x08 || code === 0x09 || code === 0x0a || code === 0x0c || code === 0x0d ? 2 : 6;
    } else if (
      isHighSurrogate(code) &&
      index + 1 < end &&
      isLowSurrogate(text.charCodeAt(index + 1))
    ) {
      width = 2;
      cost = 2;
    } else if (isHighSurrogate(code) || isLowSurrogate(code)) {
      cost = 6;
    }
    if (used + cost > budget) break;
    used += cost;
    index += width;
  }
  return index;
}

/**
 * Size of text in the unit its read window is measured in: read_file windows plain-text
 * files in UTF-8 bytes and extracted document text (and parse_document) in characters.
 */
function readWindowUnits(text: string, unit: "bytes" | "chars"): number {
  return unit === "bytes" ? Buffer.byteLength(text, "utf8") : text.length;
}

/**
 * read_file / parse_document payload: keep a head of the window and report exactly where
 * the delivered text ends, so continuing from the reported offset never skips content.
 */
function fitWindowedReadPayload(parsed: Record<string, Any>, maxChars: number): string | null {
  const content = parsed.content as string;
  const window = parsed.window as { start: number; end: number; total: number };
  const isParseDocument = typeof parsed.detected_type === "string";
  const toolName = isParseDocument ? "parse_document" : "read_file";
  const startParam = isParseDocument ? "start_char" : "startChar";
  const unit = isParseDocument || typeof parsed.format === "string" ? "chars" : "bytes";
  const windowNote = READ_WINDOW_NOTE_RE.exec(content) || TRIMMED_READ_NOTE_RE.exec(content);
  const bodyEnd = windowNote ? windowNote.index : content.length;

  const describe = (deliveredEnd: number) => ({
    note:
      `\n\n[... trimmed to fit the tool-result budget: delivered ${unit} ${window.start}-${deliveredEnd}` +
      ` of ${window.total}. Call ${toolName} with ${startParam}=${deliveredEnd} to continue ...]`,
    hint:
      "This result was trimmed to fit the tool-result budget. " +
      `Call ${toolName} with ${startParam}=${deliveredEnd} to continue reading.`,
  });
  const build = (keptContent: string, deliveredEnd: number): Record<string, Any> => {
    const text = describe(deliveredEnd);
    const next: Record<string, Any> = {
      ...parsed,
      content: keptContent + text.note,
      truncated: true,
      window: { ...window, end: deliveredEnd },
      hint: text.hint,
    };
    if (isParseDocument) {
      next.next_start_char = deliveredEnd;
      next.char_count = next.content.length;
    } else {
      next.nextStartChar = deliveredEnd;
    }
    return next;
  };

  // Measure the fixed part with the widest possible offsets.
  const available = maxChars - JSON.stringify(build("", window.total)).length;
  if (available < MIN_TRIMMED_STRING_CHARS) return null;
  const fitted = prefixWithinEscapedBudget(content, bodyEnd, available);
  // The window body already fits: the overflow is elsewhere, so trim generically.
  if (fitted >= bodyEnd) return null;
  const cut = snapHeadEnd(content, fitted);
  const removedUnits = readWindowUnits(content.slice(cut, bodyEnd), unit);
  const deliveredEnd = Math.max(window.start, window.end - removedUnits);
  const serialized = JSON.stringify(build(content.slice(0, cut), deliveredEnd));
  return serialized.length <= maxChars ? serialized : null;
}

interface TrimSlot {
  label: string;
  original: string;
  escapedLength: number;
  render: (maxRawChars: number) => string;
  assign: (value: string) => void;
}

/**
 * Shorten the longest strings to one shared cap (short strings stay intact) so the
 * serialized root fits maxChars. Returns false when even the minimum cap is too large.
 */
function fitTrimSlots(root: unknown, slots: TrimSlot[], maxChars: number): boolean {
  const candidates = slots.filter((slot) => slot.escapedLength > MIN_TRIMMED_STRING_CHARS);
  if (candidates.length === 0) return false;
  for (const slot of candidates) slot.assign("");
  const fixedChars = JSON.stringify(root).length;
  const valueFor = (slot: TrimSlot, cap: number): string =>
    slot.escapedLength <= cap
      ? slot.original
      : slot.render(Math.floor((cap * slot.original.length) / slot.escapedLength));
  const totalFor = (cap: number): number =>
    candidates.reduce((sum, slot) => sum + jsonEscapedLength(valueFor(slot, cap)), fixedChars);

  let low = MIN_TRIMMED_STRING_CHARS;
  let high = candidates.reduce((max, slot) => Math.max(max, slot.escapedLength), low);
  const fits = totalFor(low) <= maxChars;
  if (fits) {
    while (high - low > 32) {
      const mid = Math.floor((low + high) / 2);
      if (totalFor(mid) <= maxChars) low = mid;
      else high = mid;
    }
  }
  for (const slot of candidates) slot.assign(valueFor(slot, low));
  return fits;
}

function collectTrimSlots(
  parent: Record<string, Any> | Any[],
  key: string | number,
  label: string,
  headRatio: number,
  out: TrimSlot[],
  depth = 0,
): void {
  const value = (parent as Any)[key];
  if (typeof value === "string") {
    out.push({
      label: label || "(result)",
      original: value,
      escapedLength: jsonEscapedLength(value),
      render: (maxRawChars) => trimHeadTail(value, maxRawChars, headRatio),
      assign: (next) => {
        (parent as Any)[key] = next;
      },
    });
    return;
  }
  if (depth > 32 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((_item, index) =>
      collectTrimSlots(value, index, `${label}[${index}]`, headRatio, out, depth + 1),
    );
    return;
  }
  for (const childKey of Object.keys(value)) {
    const childRatio = LOG_LIKE_KEYS.has(childKey.toLowerCase()) ? LOG_HEAD_RATIO : headRatio;
    const childLabel = label ? `${label}.${childKey}` : childKey;
    collectTrimSlots(value, childKey, childLabel, childRatio, out, depth + 1);
  }
}

function collectArrays(value: unknown, label: string, out: Array<{ label: string; items: Any[] }>) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    if (value.length > 1) out.push({ label: label || "(result)", items: value });
    value.forEach((item, index) => collectArrays(item, `${label}[${index}]`, out));
    return;
  }
  for (const [childKey, child] of Object.entries(value)) {
    collectArrays(child, label ? `${label}.${childKey}` : childKey, out);
  }
}

/** Drop trailing items of the largest array, leaving a notice. Returns its label. */
function dropTrailingArrayItems(root: unknown, maxChars: number): string | null {
  const arrays: Array<{ label: string; items: Any[] }> = [];
  collectArrays(root, "", arrays);
  let target: { label: string; items: Any[]; size: number } | null = null;
  for (const entry of arrays) {
    const size = JSON.stringify(entry.items).length;
    if (!target || size > target.size) target = { ...entry, size };
  }
  if (!target) return null;

  const items = target.items;
  let omitted = 0;
  const previousNotice =
    typeof items[items.length - 1] === "string"
      ? OMITTED_ITEMS_NOTICE_RE.exec(items[items.length - 1])
      : null;
  if (previousNotice) {
    items.pop();
    omitted += Number(previousNotice[1]);
  }
  const excess = JSON.stringify(root).length - maxChars + 96;
  let removedChars = 0;
  while (items.length > 1 && removedChars < excess) {
    removedChars += JSON.stringify(items.pop()).length + 1;
    omitted += 1;
  }
  items.push(`[... ${omitted} more items omitted to fit the tool-result budget ...]`);
  return target.label;
}

/**
 * Fit any other JSON value: shorten long strings head+tail (logs keep more tail), then
 * drop trailing items of long arrays. Small fields such as exit codes stay intact and the
 * output remains valid JSON.
 */
function fitGenericJson(root: unknown, maxChars: number): string | null {
  // Strings are reassigned through their container, so wrap the root once.
  const holder: Record<string, Any> = { value: root };
  const wrapperChars = JSON.stringify({ value: null }).length - "null".length;
  const objectRoot = isPlainObject(root);
  const valueBudget = maxChars - (objectRoot ? TRUNCATION_NOTE_RESERVE : 0);

  const slots: TrimSlot[] = [];
  collectTrimSlots(holder, "value", "", DEFAULT_HEAD_RATIO, slots);
  const trimmedLabels = new Set<string>();
  for (const slot of slots) {
    const assign = slot.assign;
    slot.assign = (next) => {
      assign(next);
      if (next !== slot.original) trimmedLabels.add(slot.label);
      else trimmedLabels.delete(slot.label);
    };
  }

  const fitsBudget = () => JSON.stringify(holder.value).length <= valueBudget;
  let fits = fitTrimSlots(holder, slots, valueBudget + wrapperChars) || fitsBudget();
  const droppedFrom = new Set<string>();
  for (let attempt = 0; !fits && attempt < 8; attempt += 1) {
    const label = dropTrailingArrayItems(holder.value, valueBudget);
    if (!label) break;
    droppedFrom.add(label);
    fits = fitsBudget();
  }
  if (!fits) return null;

  if (objectRoot) {
    const fields = Array.from(trimmedLabels).slice(0, 6);
    const parts = [
      "This result was trimmed to fit the tool-result budget.",
      fields.length > 0
        ? `Shortened fields (omitted text marked "[... N chars omitted ...]"): ${fields.join(", ")}.`
        : "",
      droppedFrom.size > 0
        ? `Trailing items dropped from: ${Array.from(droppedFrom).join(", ")}.`
        : "",
    ];
    (root as Record<string, Any>)._truncated = parts.filter(Boolean).join(" ").slice(0, 380);
  }
  const serialized = JSON.stringify(holder.value);
  return serialized.length <= maxChars ? serialized : null;
}

/** Where a read_files entry's text ends in its file, if that can be determined. */
function describeReadFilesEntryWindow(
  file: Record<string, Any>,
): { end: number; unit: "bytes" | "chars" } | null {
  const content = file.content as string;
  const windowNote = READ_WINDOW_NOTE_RE.exec(content);
  if (windowNote) {
    return { end: Number(windowNote[2]), unit: windowNote[4] === "bytes" ? "bytes" : "chars" };
  }
  const trimmedNote = TRIMMED_READ_FILES_NOTE_RE.exec(content);
  if (trimmedNote) {
    // Trimmed before: the text shown so far ends where the earlier note said to continue.
    const continueAt = / and startChar=(\d+) to read the rest \.\.\.\]\s*$/.exec(trimmedNote[0]);
    if (!continueAt) return null;
    return {
      end: Number(continueAt[1]),
      unit: typeof file.format === "string" ? "chars" : "bytes",
    };
  }
  if (READ_FILES_TRUNCATION_NOTE_RE.test(content)) return null;
  // A plain-text file read whole: its window ends at the file size in bytes.
  if (typeof file.format !== "string" && Number.isFinite(file.size)) {
    return { end: Number(file.size), unit: "bytes" };
  }
  return null;
}

/**
 * read_files payload: shorten file contents (head only, small files stay intact), say
 * where each trimmed file continues, and keep skippedFiles/warnings and valid JSON.
 */
function fitReadFilesPayload(parsed: Record<string, Any>, maxChars: number): string | null {
  const files = parsed.files as Array<Record<string, Any>>;
  const budget = maxChars - TRUNCATION_NOTE_RESERVE;
  const originals = files.map((file) => ({ ...file }));

  const buildSlots = (): TrimSlot[] =>
    files.map((file, index) => {
      const original = originals[index]!;
      const content = original.content as string;
      const windowInfo = describeReadFilesEntryWindow(original);
      const windowNote =
        READ_WINDOW_NOTE_RE.exec(content) || TRIMMED_READ_FILES_NOTE_RE.exec(content);
      const bodyEnd = windowNote
        ? windowNote.index
        : content.replace(READ_FILES_TRUNCATION_NOTE_RE, "").length;
      let lastRender: { value: string; nextStartChar?: number } | null = null;
      return {
        label: String(original.path || `files[${index}]`),
        original: content,
        escapedLength: jsonEscapedLength(content),
        render: (maxRawChars) => {
          const notice = (omitted: number, nextStartChar?: number) =>
            `\n\n[... ${omitted} chars of this file omitted to fit the tool-result budget. ` +
            `Call read_file with path ${JSON.stringify(String(original.path || ""))}` +
            (nextStartChar !== undefined ? ` and startChar=${nextStartChar}` : "") +
            " to read the rest ...]";
          const reserve = notice(content.length, Number.MAX_SAFE_INTEGER).length;
          const cut = Math.min(bodyEnd, snapHeadEnd(content, Math.max(0, maxRawChars - reserve)));
          const nextStartChar = windowInfo
            ? Math.max(
                0,
                windowInfo.end - readWindowUnits(content.slice(cut, bodyEnd), windowInfo.unit),
              )
            : undefined;
          const value = content.slice(0, cut) + notice(content.length - cut, nextStartChar);
          lastRender = { value, nextStartChar };
          return value;
        },
        assign: (value) => {
          if (value === content || value === "") {
            Object.assign(file, original, { content: value });
            delete file.nextStartChar;
            return;
          }
          file.content = value;
          file.truncated = true;
          if (lastRender?.value === value && lastRender.nextStartChar !== undefined) {
            file.nextStartChar = lastRender.nextStartChar;
          }
        },
      };
    });

  const skippedFiles = Array.isArray(parsed.skippedFiles) ? parsed.skippedFiles : null;
  let fits = fitTrimSlots(parsed, buildSlots(), budget);
  while (!fits && files.length > 1 && skippedFiles) {
    // Too many files to show even a short head of each: skip the last ones explicitly.
    const dropped = files.pop()!;
    originals.pop();
    skippedFiles.push({
      path: dropped.path,
      reason: "Omitted to fit the tool-result budget; read it with read_file.",
    });
    fits = fitTrimSlots(parsed, buildSlots(), budget);
  }
  if (!fits) return null;

  parsed.truncated = true;
  if (typeof parsed.included === "number") parsed.included = files.length;
  if (skippedFiles && typeof parsed.skipped === "number") parsed.skipped = skippedFiles.length;
  const notice =
    "Some file contents were trimmed to fit the tool-result budget; each trimmed file says " +
    "where to continue with read_file.";
  if (Array.isArray(parsed.warnings)) parsed.warnings.push(notice);
  else parsed._truncated = notice;
  const serialized = JSON.stringify(parsed);
  return serialized.length <= maxChars ? serialized : null;
}

function isWindowedReadPayload(parsed: unknown): parsed is Record<string, Any> {
  if (!isPlainObject(parsed) || typeof parsed.content !== "string") return false;
  const window = parsed.window;
  return (
    isPlainObject(window) &&
    Number.isFinite(window.start) &&
    Number.isFinite(window.end) &&
    Number.isFinite(window.total)
  );
}

function isReadFilesPayload(parsed: unknown): parsed is Record<string, Any> {
  return (
    isPlainObject(parsed) &&
    Array.isArray(parsed.files) &&
    parsed.files.length > 0 &&
    parsed.files.every((file: unknown) => isPlainObject(file) && typeof file.content === "string")
  );
}

/**
 * Bound a tool result to the per-result budget without misleading the model:
 * - read_file / parse_document windows keep a head and report the real delivered end
 *   (`window.end`, `nextStartChar` / `next_start_char`, `truncated: true`);
 * - read_files trims per file and keeps skippedFiles/warnings;
 * - other JSON keeps small fields intact and shortens long strings head+tail;
 * - plain text keeps head and tail around an explicit omission marker.
 */
export function truncateToolResult(result: string): string {
  if (typeof result !== "string") {
    return "";
  }
  // Every budget is at least the default, so short results need no parsing.
  if (result.length <= MAX_TOOL_RESULT_TOKENS_DEFAULT * 4) return result;

  const parsed = safeJsonParse(result);
  const maxChars = getToolResultTokenBudget(parsed) * 4;
  if (result.length <= maxChars) return result;

  if (parsed !== null && typeof parsed === "object") {
    if (isWindowedReadPayload(parsed)) {
      const fitted = fitWindowedReadPayload(parsed, maxChars);
      if (fitted !== null) return fitted;
    }
    if (isReadFilesPayload(parsed)) {
      const fitted = fitReadFilesPayload(safeJsonParse(result), maxChars);
      if (fitted !== null) return fitted;
    }
    const fitted = fitGenericJson(safeJsonParse(result), maxChars);
    if (fitted !== null) return fitted;
  } else if (typeof parsed === "string") {
    const fitted = fitGenericJson(parsed, maxChars);
    if (fitted !== null) return fitted;
  }

  return trimHeadTail(result, maxChars, PLAIN_TEXT_HEAD_RATIO);
}

export type CompactionKind = "none" | "tool_truncation_only" | "message_removal";

export type CompactionMeta = {
  availableTokens: number;
  originalTokens: number;
  truncatedToolResults: {
    didTruncate: boolean;
    count: number;
    tokensAfter: number;
  };
  removedMessages: {
    didRemove: boolean;
    count: number;
    tokensAfter: number;
    messages: LLMMessage[];
  };
  kind: CompactionKind;
};

export type CompactionResult = {
  messages: LLMMessage[];
  meta: CompactionMeta;
};

/**
 * How many real tokens the model produces per token that estimateTokens() counts.
 * Claude Opus 4.7 introduced a tokenizer (also used by Opus 4.8, Opus 5.x and Fable)
 * that produces up to ~1.35x as many tokens as earlier Claude models for the same
 * text. CoWork's chars/4 estimate is calibrated on the older tokenizers, so without
 * this factor compaction would kick in too late and requests could overrun the window.
 * Billing is unaffected: costs use the token counts the provider reports.
 */
export function getTokenizerInflation(modelKey: string): number {
  const key = String(modelKey || "").toLowerCase();
  if (/(fable|mythos)/.test(key)) return 1.35;
  const opus = key.match(/opus[-_.]?(\d{1,2})(?!\d)(?:[-_.](\d{1,2})(?!\d))?/);
  if (opus) {
    const major = Number(opus[1]);
    const minor = opus[2] ? Number(opus[2]) : 0;
    if (major >= 5 || (major === 4 && minor >= 7)) return 1.35;
  }
  return 1;
}

/**
 * Context Manager class
 */
export class ContextManager {
  private modelKey: string;
  private maxTokens: number;
  private tokenizerInflation: number;

  constructor(modelKey: string = "default") {
    this.modelKey = modelKey;
    this.maxTokens = MODEL_LIMITS[modelKey] || inferModelLimit(modelKey) || MODEL_LIMITS.default;
    this.tokenizerInflation = getTokenizerInflation(modelKey);
  }

  /**
   * Get available tokens for messages (after reserving for system and response),
   * expressed in estimateTokens() units so callers can compare estimates directly.
   */
  getAvailableTokens(systemPromptTokens: number = 0): number {
    return (
      Math.floor(this.maxTokens / this.tokenizerInflation) - RESERVED_TOKENS - systemPromptTokens
    );
  }

  /**
   * Get the model's estimated total context window.
   */
  getModelTokenLimit(): number {
    return this.maxTokens;
  }

  /**
   * Estimate how many output tokens remain for a request, given current input.
   */
  estimateMaxOutputTokens(messages: LLMMessage[], systemPrompt: string = ""): number {
    const inputTokens = Math.ceil(
      estimateTotalTokens(messages, systemPrompt) * this.tokenizerInflation,
    );
    return Math.max(1, this.maxTokens - inputTokens);
  }

  /**
   * Compact messages to fit within token limit
   * Preserves recent messages and summarizes older ones
   */
  compactMessages(messages: LLMMessage[], systemPromptTokens: number = 0): LLMMessage[] {
    return this.compactMessagesWithMeta(messages, systemPromptTokens).messages;
  }

  compactMessagesWithMeta(
    messages: LLMMessage[],
    systemPromptTokens: number = 0,
  ): CompactionResult {
    const availableTokens = this.getAvailableTokens(systemPromptTokens);
    let currentTokens = estimateTotalTokens(messages);

    // If we're within limits, return as-is
    if (currentTokens <= availableTokens) {
      return {
        messages,
        meta: {
          availableTokens,
          originalTokens: currentTokens,
          truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: currentTokens },
          removedMessages: { didRemove: false, count: 0, tokensAfter: currentTokens, messages: [] },
          kind: "none",
        },
      };
    }

    console.log(`Context too large (${currentTokens} tokens), compacting...`);

    // Strategy 1: Truncate large tool results
    const truncated = this.truncateLargeResultsWithMeta(messages);
    currentTokens = estimateTotalTokens(truncated.messages);

    if (currentTokens <= availableTokens) {
      console.log(`After truncating tool results: ${currentTokens} tokens`);
      return {
        messages: truncated.messages,
        meta: {
          availableTokens,
          originalTokens: estimateTotalTokens(messages),
          truncatedToolResults: {
            didTruncate: truncated.count > 0,
            count: truncated.count,
            tokensAfter: currentTokens,
          },
          removedMessages: { didRemove: false, count: 0, tokensAfter: currentTokens, messages: [] },
          kind: "tool_truncation_only",
        },
      };
    }

    // Strategy 2: Remove older message pairs (keep first and recent)
    const removed = this.removeOlderMessagesWithMeta(truncated.messages, availableTokens);
    currentTokens = estimateTotalTokens(removed.messages);

    console.log(`After compaction: ${currentTokens} tokens, ${removed.messages.length} messages`);
    return {
      messages: removed.messages,
      meta: {
        availableTokens,
        originalTokens: estimateTotalTokens(messages),
        truncatedToolResults: {
          didTruncate: truncated.count > 0,
          count: truncated.count,
          tokensAfter: estimateTotalTokens(truncated.messages),
        },
        removedMessages: {
          didRemove: removed.removedMessages.length > 0,
          count: removed.removedMessages.length,
          tokensAfter: currentTokens,
          messages: removed.removedMessages,
        },
        kind: removed.removedMessages.length > 0 ? "message_removal" : "tool_truncation_only",
      },
    };
  }

  /**
   * Truncate large tool results in messages
   */
  private truncateLargeResultsWithMeta(messages: LLMMessage[]): {
    messages: LLMMessage[];
    count: number;
  } {
    let truncatedCount = 0;
    const out = messages.map((msg) => {
      if (typeof msg.content === "string") return msg;

      // Check if this message has tool results
      const hasToolResults = msg.content.some((c) => c.type === "tool_result");
      if (!hasToolResults) return msg;

      // Truncate tool results
      const newContent = msg.content.map((content) => {
        if (content.type === "tool_result") {
          const next = truncateToolResult(content.content);
          if (next !== content.content) truncatedCount += 1;
          return {
            type: "tool_result" as const,
            tool_use_id: content.tool_use_id,
            content: next,
            ...(content.is_error ? { is_error: content.is_error } : {}),
          };
        }
        return content;
      }) as LLMMessage["content"];

      return { ...msg, content: newContent };
    });
    return { messages: out, count: truncatedCount };
  }

  /**
   * Remove older messages while preserving conversation flow
   */
  /**
   * Extract file paths referenced in a set of messages (for active-work context detection).
   */
  private extractFilePathsFromMessages(msgs: LLMMessage[]): Set<string> {
    const paths = new Set<string>();
    const pathRegex = /(?:\/[\w.@-]+){2,}(?:\.\w+)?/g;
    for (const msg of msgs) {
      const text =
        typeof msg.content === "string"
          ? msg.content
          : Array.isArray(msg.content)
            ? (
                msg.content as Array<{
                  type: string;
                  text?: string;
                  input?: unknown;
                  content?: string;
                }>
              )
                .map((c) => {
                  if (c.type === "text") return c.text || "";
                  if (c.type === "tool_use") return JSON.stringify(c.input || "");
                  if (c.type === "tool_result")
                    return typeof c.content === "string" ? c.content : "";
                  return "";
                })
                .join(" ")
            : "";
      const matches = text.match(pathRegex);
      if (matches) matches.forEach((p) => paths.add(p));
    }
    return paths;
  }

  /**
   * Check if a message references any of the given active file paths.
   */
  private messageReferencesActivePaths(msg: LLMMessage, activePaths: Set<string>): boolean {
    if (activePaths.size === 0) return false;
    const text =
      typeof msg.content === "string"
        ? msg.content
        : Array.isArray(msg.content)
          ? (
              msg.content as Array<{
                type: string;
                text?: string;
                input?: unknown;
                content?: string;
              }>
            )
              .map((c) => {
                if (c.type === "text") return c.text || "";
                if (c.type === "tool_use") return JSON.stringify(c.input || "");
                if (c.type === "tool_result") return typeof c.content === "string" ? c.content : "";
                return "";
              })
              .join(" ")
          : "";
    for (const path of activePaths) {
      if (text.includes(path)) return true;
    }
    return false;
  }

  private removeOlderMessagesWithMeta(
    messages: LLMMessage[],
    targetTokens: number,
  ): { messages: LLMMessage[]; removedMessages: LLMMessage[] } {
    if (messages.length <= 2) return { messages, removedMessages: [] };

    // Keep first message (task context) and work backwards from end
    let currentTokens = 0;
    const keep = new Set<number>();

    // Always keep the first message (original task)
    const firstMsg = messages[0];
    const firstMsgTokens = estimateMessageTokens(firstMsg);
    keep.add(0);
    currentTokens += firstMsgTokens;

    // Always keep pinned messages (system-generated context blocks).
    for (let i = 1; i < messages.length; i++) {
      if (!isPinnedMessage(messages[i])) continue;
      keep.add(i);
      currentTokens += estimateMessageTokens(messages[i]);
    }

    // Extract file paths from recent messages to identify actively-worked files.
    // Older messages referencing these files should be preserved if budget allows.
    const recentSliceStart = Math.max(1, messages.length - ACTIVE_PATH_CONTEXT_WINDOW);
    const activeFilePaths = this.extractFilePathsFromMessages(messages.slice(recentSliceStart));

    // Prioritize keeping messages that reference active files (from older section).
    // Reserve up to 70% of budget for recency, use remaining for active-file context.
    const activeFileBudget = targetTokens * 0.15; // Up to 15% of budget for active-file messages
    let activeFileTokensUsed = 0;
    for (let i = 1; i < recentSliceStart; i++) {
      if (keep.has(i)) continue;
      if (!this.messageReferencesActivePaths(messages[i], activeFilePaths)) continue;
      const msgTokens = estimateMessageTokens(messages[i]);
      if (activeFileTokensUsed + msgTokens > activeFileBudget) continue;
      keep.add(i);
      currentTokens += msgTokens;
      activeFileTokensUsed += msgTokens;
    }

    // Add messages from the end until we hit the limit (preserve recency).
    for (let i = messages.length - 1; i > 0; i--) {
      if (keep.has(i)) continue;
      const msg = messages[i];
      const msgTokens = estimateMessageTokens(msg);

      const prevIdx = i - 1;
      const preserveAdjacentToolPair =
        msg.role === "user" &&
        messageHasToolResult(msg) &&
        prevIdx >= 0 &&
        !keep.has(prevIdx) &&
        messages[prevIdx]?.role === "assistant" &&
        messageHasToolUse(messages[prevIdx]);

      if (preserveAdjacentToolPair) {
        const prevTokens = estimateMessageTokens(messages[prevIdx]);
        if (currentTokens + msgTokens + prevTokens > targetTokens) {
          break;
        }
        keep.add(prevIdx);
        keep.add(i);
        currentTokens += msgTokens + prevTokens;
        i = prevIdx;
        continue;
      }

      if (currentTokens + msgTokens > targetTokens) {
        break;
      }

      keep.add(i);
      currentTokens += msgTokens;
    }

    const keptIndices = Array.from(keep).sort((a, b) => a - b);
    const compacted = keptIndices.map((i) => messages[i]);

    const removedMessages: LLMMessage[] = [];
    for (let i = 1; i < messages.length; i++) {
      if (!keep.has(i)) removedMessages.push(messages[i]);
    }

    return { messages: compacted, removedMessages };
  }

  /**
   * Check if adding a message would exceed limits
   */
  wouldExceedLimit(
    currentMessages: LLMMessage[],
    newMessage: LLMMessage,
    systemPromptTokens: number = 0,
  ): boolean {
    const currentTokens = estimateTotalTokens(currentMessages);
    const newTokens = estimateMessageTokens(newMessage);
    const availableTokens = this.getAvailableTokens(systemPromptTokens);

    return currentTokens + newTokens > availableTokens;
  }

  /**
   * Get current context utilization as a ratio (0-1+).
   */
  getContextUtilization(
    messages: LLMMessage[],
    systemPromptTokens: number = 0,
  ): { currentTokens: number; availableTokens: number; utilization: number } {
    const currentTokens = estimateTotalTokens(messages);
    const availableTokens = this.getAvailableTokens(systemPromptTokens);
    return {
      currentTokens,
      availableTokens,
      utilization: availableTokens > 0 ? currentTokens / availableTokens : 0,
    };
  }

  /**
   * Proactive compaction: compact down to a target utilization (e.g. 55%)
   * rather than only compacting when the context exceeds the hard limit.
   * This frees ample slack for a comprehensive compaction summary.
   */
  proactiveCompactWithMeta(
    messages: LLMMessage[],
    systemPromptTokens: number = 0,
    targetUtilization: number = 0.55,
  ): CompactionResult {
    const availableTokens = this.getAvailableTokens(systemPromptTokens);
    const targetTokens = Math.floor(availableTokens * targetUtilization);
    let currentTokens = estimateTotalTokens(messages);
    const originalTokens = currentTokens;

    if (currentTokens <= targetTokens) {
      return {
        messages,
        meta: {
          availableTokens,
          originalTokens,
          truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: currentTokens },
          removedMessages: { didRemove: false, count: 0, tokensAfter: currentTokens, messages: [] },
          kind: "none",
        },
      };
    }

    // Strategy 1: Truncate large tool results
    const truncated = this.truncateLargeResultsWithMeta(messages);
    currentTokens = estimateTotalTokens(truncated.messages);

    if (currentTokens <= targetTokens) {
      return {
        messages: truncated.messages,
        meta: {
          availableTokens,
          originalTokens,
          truncatedToolResults: {
            didTruncate: truncated.count > 0,
            count: truncated.count,
            tokensAfter: currentTokens,
          },
          removedMessages: { didRemove: false, count: 0, tokensAfter: currentTokens, messages: [] },
          kind: "tool_truncation_only",
        },
      };
    }

    // Strategy 2: Remove older messages down to targetTokens
    const removed = this.removeOlderMessagesWithMeta(truncated.messages, targetTokens);
    currentTokens = estimateTotalTokens(removed.messages);

    return {
      messages: removed.messages,
      meta: {
        availableTokens,
        originalTokens,
        truncatedToolResults: {
          didTruncate: truncated.count > 0,
          count: truncated.count,
          tokensAfter: estimateTotalTokens(truncated.messages),
        },
        removedMessages: {
          didRemove: removed.removedMessages.length > 0,
          count: removed.removedMessages.length,
          tokensAfter: currentTokens,
          messages: removed.removedMessages,
        },
        kind: removed.removedMessages.length > 0 ? "message_removal" : "tool_truncation_only",
      },
    };
  }
}
