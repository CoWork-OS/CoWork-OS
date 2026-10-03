import { randomUUID } from "node:crypto";
import { createLogger } from "../../utils/logger";
import { normalizeToolName } from "../tool-semantics";
import type { LLMContent, LLMRequest, LLMResponse, LLMTool, LLMToolUse } from "./types";

/**
 * Recovers tool calls that a model wrote as assistant text instead of returning
 * native `tool_calls`. Local models served through Ollama, LM Studio, MLX,
 * llama.cpp and similar servers do this when the chat template and the
 * server's tool-call parser disagree, or when a small model ignores the
 * template. Without recovery the executor strips the markup and nothing runs.
 *
 * The parser is deliberately conservative: it only accepts tools that were
 * offered in the request, only accepts JSON-object arguments that carry every
 * required field, ignores code examples that are framed as explanations, and
 * never runs when the provider already returned native tool calls.
 */

const logger = createLogger("text-tool-calls");

export type TextToolCallFormat =
  | "tool_call_tag"
  | "function_tag"
  | "python_tag"
  | "mistral_tool_calls"
  | "bare_json"
  | "fenced_json";

export type TextToolCallRejectionReason =
  | "unknown_tool"
  | "malformed_json"
  | "invalid_arguments"
  | "missing_required"
  | "call_limit";

export interface TextToolCallRejection {
  format: TextToolCallFormat;
  reason: TextToolCallRejectionReason;
  name?: string;
}

export interface ParsedTextToolCalls {
  toolUses: LLMToolUse[];
  /** Assistant text with the accepted call markup removed. */
  remainingText: string;
  formats: TextToolCallFormat[];
  rejected: TextToolCallRejection[];
}

export interface TextToolCallParseOptions {
  /** Upper bound on calls accepted from one message. */
  maxCalls?: number;
  /**
   * Text of the latest user turn. When the user asked how to call a tool,
   * fenced and bare JSON are treated as an answer, not as calls.
   */
  userText?: string;
}

export const DEFAULT_MAX_TEXT_TOOL_CALLS = 8;

interface RawCall {
  name: string;
  args: unknown;
  argsPresent: boolean;
  /** `<parameter=key>value</parameter>` bodies carry raw strings coerced by schema. */
  rawParameters?: boolean;
}

interface Candidate {
  start: number;
  end: number;
  format: TextToolCallFormat;
  /** null: the markup was a call attempt whose body could not be parsed. */
  calls: RawCall[] | null;
}

interface Span {
  start: number;
  end: number;
}

interface Fence extends Span {
  lang: string;
  contentStart: number;
  contentEnd: number;
}

const TAG_OPENER = /<tool_call>|<function=([A-Za-z_][\w.-]*)>|<\|python_tag\|>|\[TOOL_CALLS\]/gi;
const STRONG_FENCE_LANGS = new Set([
  "tool_call",
  "tool_calls",
  "tool_code",
  "tool_use",
  "function_call",
  "tool",
]);
const WEAK_FENCE_LANGS = new Set(["", "json", "jsonc"]);
const LINE_EXPLANATION_CONTEXT =
  /\b(?:example|examples|syntax|format|literal|e\.g\.?|for instance|such as|means|looks like|represented by)\b/i;
const MESSAGE_EXPLANATION_CONTEXT =
  /\b(?:for example|example|examples|e\.g\.|for instance|syntax|format|template|schema|looks like|would look like|like this|you (?:can|could|would|should|might) (?:call|use|invoke|run|send))\b/i;
const USER_SYNTAX_QUESTION =
  /\b(?:how (?:do|can|would|should|to)|what(?:'s| is| does) (?:the )?(?:syntax|format|shape|structure)|show me (?:an? )?(?:example|sample)|examples? of|syntax (?:for|of)|format (?:for|of))\b/i;
const USER_SYNTAX_SUBJECT = /\b(?:call|calls|calling|invoke|tool|tools|function|functions|json)\b/i;
const PYTHON_TAG_TERMINATORS = ["<|eom_id|>", "<|eot_id|>", "<|end_of_text|>"];

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function blank(text: string): string {
  return text.replace(/[^\n]/g, " ");
}

/** Locate fenced blocks; an unterminated fence runs to the end of the text. */
function findFences(text: string): Fence[] {
  const fences: Fence[] = [];
  const linePattern = /[^\n]*(?:\n|$)/g;
  let open: { start: number; marker: string; lang: string; contentStart: number } | null = null;
  let match: RegExpExecArray | null;
  while ((match = linePattern.exec(text)) !== null) {
    if (match[0].length === 0) break;
    const line = match[0];
    const lineStart = match.index;
    const lineEnd = lineStart + line.length;
    const fenceMatch = line.match(/^\s*(`{3,}|~{3,})\s*([^\s`]*)/);
    if (!open) {
      if (fenceMatch) {
        open = {
          start: lineStart,
          marker: fenceMatch[1],
          lang: fenceMatch[2].toLowerCase(),
          contentStart: lineEnd,
        };
      }
    } else if (fenceMatch && fenceMatch[1].startsWith(open.marker) && !fenceMatch[2]) {
      fences.push({
        start: open.start,
        end: lineEnd,
        lang: open.lang,
        contentStart: open.contentStart,
        contentEnd: lineStart,
      });
      open = null;
    }
  }
  if (open) {
    fences.push({
      start: open.start,
      end: text.length,
      lang: open.lang,
      contentStart: open.contentStart,
      contentEnd: text.length,
    });
  }
  return fences;
}

/** Blank out fenced blocks and inline code so openers inside them are not scanned. */
function maskCode(text: string, fences: Fence[]): string {
  let masked = text;
  for (const fence of fences) {
    masked =
      masked.slice(0, fence.start) +
      blank(masked.slice(fence.start, fence.end)) +
      masked.slice(fence.end);
  }
  return masked.replace(/`[^`\n]*(?:`|$)/gm, (span) => " ".repeat(span.length));
}

/** End index (exclusive) of the balanced JSON object/array starting at `start`, or -1. */
function findBalancedJsonEnd(text: string, start: number, limit: number): number {
  const stack: string[] = [];
  let inString = false;
  for (let index = start; index < limit; index += 1) {
    const char = text[index];
    if (inString) {
      if (char === "\\") index += 1;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === "{" || char === "[") stack.push(char === "{" ? "}" : "]");
    else if (char === "}" || char === "]") {
      if (stack.pop() !== char) return -1;
      if (stack.length === 0) return index + 1;
    }
  }
  return -1;
}

/**
 * Read consecutive JSON objects/arrays from `start`. Returns null when a value
 * looks like JSON but does not parse (malformed), otherwise the values read and
 * the index where reading stopped.
 */
function readJsonValues(
  text: string,
  start: number,
  limit: number,
  separators: RegExp,
): { values: unknown[]; end: number } | null {
  const values: unknown[] = [];
  let position = start;
  let afterLastValue = start;
  while (position < limit) {
    while (position < limit && separators.test(text[position])) position += 1;
    if (position >= limit || (text[position] !== "{" && text[position] !== "[")) break;
    const end = findBalancedJsonEnd(text, position, limit);
    if (end < 0) return null;
    try {
      values.push(JSON.parse(text.slice(position, end)));
    } catch {
      return null;
    }
    position = end;
    afterLastValue = end;
  }
  return { values, end: afterLastValue };
}

/**
 * `requireArguments`: untagged JSON (bare or fenced) only counts as a call when
 * it carries an arguments key or an OpenAI-style function wrapper, so ordinary
 * JSON answers with a "name" field are left alone.
 */
function toRawCall(value: unknown, requireArguments: boolean): RawCall | null {
  if (!isPlainObject(value)) return null;
  let call: Record<string, unknown> = value;
  let wrapped = false;
  if (isPlainObject(call.function) && typeof call.function.name === "string") {
    call = call.function;
    wrapped = true;
  }
  const name = [call.name, call.tool_name, call.tool].find(
    (candidate): candidate is string => typeof candidate === "string" && candidate.trim() !== "",
  );
  if (!name) return null;
  const argsKey = ["arguments", "parameters", "input", "args"].find((key) => key in call);
  if (requireArguments && !argsKey && !wrapped) return null;
  return { name, args: argsKey ? call[argsKey] : undefined, argsPresent: Boolean(argsKey) };
}

/** Every JSON value must describe a call (arrays are flattened); otherwise null. */
function toRawCalls(values: unknown[], requireArguments = false): RawCall[] | null {
  const result: RawCall[] = [];
  for (const value of values) {
    const items = Array.isArray(value) ? value : [value];
    for (const item of items) {
      const call = toRawCall(item, requireArguments);
      if (!call) return null;
      result.push(call);
    }
  }
  return result.length > 0 ? result : null;
}

function indexOfIgnoreCase(text: string, needle: string, from: number): number {
  return text.toLowerCase().indexOf(needle.toLowerCase(), from);
}

function parseParameterBody(body: string): Record<string, string> | null {
  const parameterPattern =
    /<parameter=([A-Za-z_][\w.-]*)>([\s\S]*?)(?:<\/parameter>|(?=<parameter=)|$)/gi;
  const parameters: Record<string, string> = {};
  let consumed = "";
  let match: RegExpExecArray | null;
  while ((match = parameterPattern.exec(body)) !== null) {
    if (match[0].length === 0) {
      parameterPattern.lastIndex += 1;
      continue;
    }
    parameters[match[1]] = match[2].replace(/^\r?\n/, "").replace(/\r?\n$/, "");
    consumed += match[0];
  }
  const residue = body.replace(parameterPattern, "");
  if (consumed.length === 0 || residue.trim().length > 0) return null;
  return parameters;
}

/**
 * Read the JSON body that follows an opener, string-aware so markup inside
 * argument strings cannot end the body early, then consume `closeTag` when it
 * directly follows. A missing close tag (cut off by a stop token) is accepted.
 */
function readTaggedJsonBody(
  text: string,
  bodyStart: number,
  limit: number,
  closeTag: string,
): { values: unknown[]; end: number } | null {
  const read = readJsonValues(text, bodyStart, limit, /\s/);
  if (!read || read.values.length === 0) return null;
  const close = text.slice(read.end, limit).match(/^\s*/)?.[0].length ?? 0;
  const closeStart = read.end + close;
  const hasClose = text.slice(closeStart, closeStart + closeTag.length).toLowerCase() === closeTag;
  return { values: read.values, end: hasClose ? closeStart + closeTag.length : read.end };
}

/** End of a malformed tagged body: its close tag when present, else `limit`. */
function malformedEnd(text: string, from: number, limit: number, closeTag: string): number {
  const close = indexOfIgnoreCase(text, closeTag, from);
  return close >= 0 && close < limit ? close + closeTag.length : limit;
}

/** `<function=name>` followed by a JSON object, `<parameter=...>` pairs, or nothing. */
function parseFunctionTag(
  text: string,
  openerStart: number,
  openerEnd: number,
  name: string,
  limit: number,
): Candidate | null {
  const closeTag = "</function>";
  const leading = text.slice(openerEnd, limit).match(/^\s*/)?.[0].length ?? 0;
  const bodyStart = openerEnd + leading;

  if (text[bodyStart] === "{") {
    const read = readTaggedJsonBody(text, openerEnd, limit, closeTag);
    if (!read || read.values.length !== 1) {
      const end = malformedEnd(text, openerEnd, limit, closeTag);
      return { start: openerStart, end, format: "function_tag", calls: null };
    }
    return {
      start: openerStart,
      end: read.end,
      format: "function_tag",
      calls: [{ name, args: read.values[0], argsPresent: true }],
    };
  }

  const close = indexOfIgnoreCase(text, closeTag, openerEnd);
  const nextOpener = indexOfIgnoreCase(text, "<function=", openerEnd);
  const closeInRange = close >= 0 && close < limit && (nextOpener < 0 || close < nextOpener);
  const bodyEnd = closeInRange ? close : Math.min(limit, nextOpener >= 0 ? nextOpener : limit);
  const body = text.slice(openerEnd, bodyEnd);
  const end = closeInRange ? close + closeTag.length : bodyEnd;

  if (body.trim().length === 0) {
    if (!closeInRange) return null;
    return {
      start: openerStart,
      end,
      format: "function_tag",
      calls: [{ name, args: {}, argsPresent: true }],
    };
  }
  if (/^<parameter=/i.test(body.trim())) {
    const parameters = parseParameterBody(body);
    return {
      start: openerStart,
      end,
      format: "function_tag",
      calls: parameters
        ? [{ name, args: parameters, argsPresent: true, rawParameters: true }]
        : null,
    };
  }
  // Prose such as "<function=name> names it" is not a call body.
  return null;
}

function parseToolCallTag(
  text: string,
  openerStart: number,
  openerEnd: number,
  limit: number,
): Candidate | null {
  const closeTag = "</tool_call>";
  const trimmed = text.slice(openerEnd, limit).trimStart();

  if (/^<function=/i.test(trimmed)) {
    const close = indexOfIgnoreCase(text, closeTag, openerEnd);
    const bodyEnd = close >= 0 && close < limit ? close : limit;
    const end = close >= 0 && close < limit ? close + closeTag.length : limit;
    const inner = scanTaggedCalls(text, text, openerEnd, bodyEnd);
    const residue = removeSpans(text.slice(0, bodyEnd), inner).slice(openerEnd);
    if (inner.length === 0 || residue.trim().length > 0) {
      return { start: openerStart, end, format: "tool_call_tag", calls: null };
    }
    const malformed = inner.some((candidate) => candidate.calls === null);
    return {
      start: openerStart,
      end,
      format: "tool_call_tag",
      calls: malformed ? null : inner.flatMap((candidate) => candidate.calls ?? []),
    };
  }
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    // A bare tag in prose ("the <tool_call> tag wraps each call") is not a call.
    return null;
  }

  const read = readTaggedJsonBody(text, openerEnd, limit, closeTag);
  if (!read) {
    const end = malformedEnd(text, openerEnd, limit, closeTag);
    return { start: openerStart, end, format: "tool_call_tag", calls: null };
  }
  return {
    start: openerStart,
    end: read.end,
    format: "tool_call_tag",
    calls: toRawCalls(read.values),
  };
}

function parsePythonTag(
  text: string,
  openerStart: number,
  openerEnd: number,
  limit: number,
): Candidate | null {
  const terminators = PYTHON_TAG_TERMINATORS.map((token) => ({
    token,
    index: text.indexOf(token, openerEnd),
  })).filter((entry) => entry.index >= 0 && entry.index < limit);
  terminators.sort((a, b) => a.index - b.index);
  const terminator = terminators[0];
  const bodyEnd = terminator ? terminator.index : limit;
  const body = text.slice(openerEnd, bodyEnd).trim();
  if (!body.startsWith("{") && !body.startsWith("[")) {
    // Built-in tool syntax (`brave_search.call(query=...)`) is not supported.
    return null;
  }
  const end = terminator ? terminator.index + terminator.token.length : bodyEnd;
  const read = readJsonValues(text, openerEnd, bodyEnd, /[\s;]/);
  if (!read || read.values.length === 0 || text.slice(read.end, bodyEnd).trim().length > 0) {
    return { start: openerStart, end, format: "python_tag", calls: null };
  }
  return { start: openerStart, end, format: "python_tag", calls: toRawCalls(read.values) };
}

function parseMistralToolCalls(
  text: string,
  openerStart: number,
  openerEnd: number,
  limit: number,
): Candidate | null {
  const rest = text.slice(openerEnd, limit);
  const leading = rest.match(/^\s*/)?.[0].length ?? 0;
  const bodyStart = openerEnd + leading;
  if (text[bodyStart] === "[" || text[bodyStart] === "{") {
    const read = readJsonValues(text, bodyStart, limit, /\s/);
    if (!read || read.values.length === 0) {
      return { start: openerStart, end: limit, format: "mistral_tool_calls", calls: null };
    }
    return {
      start: openerStart,
      end: read.end,
      format: "mistral_tool_calls",
      calls: toRawCalls(read.values),
    };
  }
  // Newer Mistral tokenizers: [TOOL_CALLS]name[CALL_ID]id[ARGS]{...}
  const named = text
    .slice(bodyStart, limit)
    .match(/^([A-Za-z_][\w.-]*)(?:\[CALL_ID\][\w-]*)?\[ARGS\]/);
  if (!named) return null;
  const argsStart = bodyStart + named[0].length;
  const read = readJsonValues(text, argsStart, limit, /\s/);
  if (!read || read.values.length !== 1) {
    return { start: openerStart, end: limit, format: "mistral_tool_calls", calls: null };
  }
  return {
    start: openerStart,
    end: read.end,
    format: "mistral_tool_calls",
    calls: [{ name: named[1], args: read.values[0], argsPresent: true }],
  };
}

function lineStartOf(text: string, index: number): number {
  return text.lastIndexOf("\n", Math.max(0, index - 1)) + 1;
}

/**
 * "For example: <tool_call>..." on the same line, or an immediately preceding
 * "Here is an example:" line. A preceding code block (blank in `masked`) does
 * not carry its introduction forward to markup after it.
 */
function isExplainedAt(masked: string, index: number): boolean {
  const lineStart = lineStartOf(masked, index);
  if (LINE_EXPLANATION_CONTEXT.test(masked.slice(lineStart, index))) return true;
  let cursor = lineStart;
  while (cursor > 0) {
    const previousStart = lineStartOf(masked, cursor - 1);
    const previousLine = masked.slice(previousStart, cursor - 1);
    if (previousLine.length > 0 && previousLine.trim().length === 0) return false;
    if (previousLine.trim().length > 0) {
      const trimmed = previousLine.trimEnd();
      return trimmed.endsWith(":") && LINE_EXPLANATION_CONTEXT.test(trimmed);
    }
    cursor = previousStart;
  }
  return false;
}

function scanTaggedCalls(text: string, masked: string, from: number, limit: number): Candidate[] {
  const candidates: Candidate[] = [];
  const opener = new RegExp(TAG_OPENER.source, "gi");
  opener.lastIndex = from;
  let match: RegExpExecArray | null;
  while ((match = opener.exec(masked)) !== null && match.index < limit) {
    const start = match.index;
    const openerEnd = start + match[0].length;
    if (isExplainedAt(masked, start)) continue;
    const token = match[0].toLowerCase();
    let candidate: Candidate | null;
    if (token === "<tool_call>") {
      candidate = parseToolCallTag(text, start, openerEnd, limit);
    } else if (token === "<|python_tag|>") {
      candidate = parsePythonTag(text, start, openerEnd, limit);
    } else if (token === "[tool_calls]") {
      candidate = parseMistralToolCalls(text, start, openerEnd, limit);
    } else {
      candidate = parseFunctionTag(text, start, openerEnd, match[1], limit);
    }
    if (!candidate) continue;
    candidates.push(candidate);
    opener.lastIndex = Math.max(candidate.end, openerEnd);
  }
  return candidates;
}

function removeSpans(text: string, spans: Span[]): string {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  let result = "";
  let cursor = 0;
  for (const span of sorted) {
    if (span.start < cursor) continue;
    result += text.slice(cursor, span.start);
    cursor = span.end;
  }
  return result + text.slice(cursor);
}

/** A fenced block whose whole content is tool calls (JSON or tagged), else null. */
function parseFenceContent(text: string, fence: Fence): Candidate | null {
  const content = text.slice(fence.contentStart, fence.contentEnd);
  const trimmed = content.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    const read = readJsonValues(text, fence.contentStart, fence.contentEnd, /\s/);
    if (!read || text.slice(read.end, fence.contentEnd).trim().length > 0) {
      return STRONG_FENCE_LANGS.has(fence.lang)
        ? { start: fence.start, end: fence.end, format: "fenced_json", calls: null }
        : null;
    }
    const calls = toRawCalls(read.values, true);
    return calls ? { start: fence.start, end: fence.end, format: "fenced_json", calls } : null;
  }
  const inner = scanTaggedCalls(text, text, fence.contentStart, fence.contentEnd);
  if (inner.length === 0) return null;
  const residue = removeSpans(text.slice(0, fence.contentEnd), inner).slice(fence.contentStart);
  if (residue.trim().length > 0) return null;
  const malformed = inner.some((candidate) => candidate.calls === null);
  return {
    start: fence.start,
    end: fence.end,
    format: inner[0].format,
    calls: malformed ? null : inner.flatMap((candidate) => candidate.calls ?? []),
  };
}

function userAskedAboutToolSyntax(userText: string | undefined): boolean {
  const text = String(userText || "");
  return USER_SYNTAX_QUESTION.test(text) && USER_SYNTAX_SUBJECT.test(text);
}

function findCandidates(text: string, userText: string | undefined): Candidate[] {
  const fences = findFences(text);
  const masked = maskCode(text, fences);
  const candidates = scanTaggedCalls(text, masked, 0, text.length);
  const syntaxQuestion = userAskedAboutToolSyntax(userText);

  if (fences.length > 0 && !syntaxQuestion) {
    const fenceCandidates = fences.map((fence) => ({
      fence,
      candidate: parseFenceContent(text, fence),
    }));
    // An explanatory answer that mixes tool-shaped JSON with other code blocks
    // or example wording is documentation, not a call.
    const allFencesAreCalls = fenceCandidates.every(({ candidate }) => candidate !== null);
    const outside = removeSpans(masked, fences);
    const explanatory = MESSAGE_EXPLANATION_CONTEXT.test(outside);
    for (const { fence, candidate } of fenceCandidates) {
      if (!candidate) continue;
      if (STRONG_FENCE_LANGS.has(fence.lang)) {
        if (isExplainedAt(masked, fence.start)) continue;
      } else if (!WEAK_FENCE_LANGS.has(fence.lang) || !allFencesAreCalls || explanatory) {
        continue;
      }
      candidates.push(candidate);
    }
  }

  if (candidates.length === 0 && fences.length === 0 && !syntaxQuestion) {
    const trimmed = text.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      const start = text.indexOf(trimmed[0]);
      const read = readJsonValues(text, start, text.length, /\s/);
      if (read && read.values.length > 0 && text.slice(read.end).trim().length === 0) {
        const calls = toRawCalls(read.values, true);
        if (calls) candidates.push({ start: 0, end: text.length, format: "bare_json", calls });
      }
    }
  }

  return candidates.sort((a, b) => a.start - b.start);
}

function resolveToolName(name: string, toolsByName: Map<string, LLMTool>): LLMTool | undefined {
  const trimmed = name.trim();
  const exact = toolsByName.get(trimmed);
  if (exact) return exact;
  const normalized = normalizeToolName(trimmed);
  return toolsByName.get(normalized.stripped) ?? toolsByName.get(normalized.canonicalName);
}

function schemaTypes(schema: unknown): string[] {
  if (!isPlainObject(schema)) return [];
  const type = schema.type;
  if (typeof type === "string") return [type];
  return Array.isArray(type)
    ? type.filter((entry): entry is string => typeof entry === "string")
    : [];
}

function coerceParameterValue(raw: string, propertySchema: unknown): unknown {
  const types = schemaTypes(propertySchema);
  if (types.length === 0 || types.includes("string")) return raw;
  try {
    return JSON.parse(raw.trim());
  } catch {
    return raw;
  }
}

function resolveArguments(
  call: RawCall,
  tool: LLMTool,
): { input: Record<string, unknown> } | { reason: TextToolCallRejectionReason } {
  let args = call.args;
  if (!call.argsPresent || args === null) {
    args = {};
  } else if (typeof args === "string") {
    if (args.trim().length === 0) {
      args = {};
    } else {
      try {
        args = JSON.parse(args);
      } catch {
        return { reason: "invalid_arguments" };
      }
    }
  }
  if (!isPlainObject(args)) return { reason: "invalid_arguments" };

  let input: Record<string, unknown> = args;
  if (call.rawParameters) {
    const properties = isPlainObject(tool.input_schema?.properties)
      ? tool.input_schema.properties
      : {};
    input = Object.fromEntries(
      Object.entries(args).map(([key, value]) => [
        key,
        typeof value === "string" ? coerceParameterValue(value, properties[key]) : value,
      ]),
    );
  }

  const required = Array.isArray(tool.input_schema?.required) ? tool.input_schema.required : [];
  if (required.some((key) => input[key] === undefined)) return { reason: "missing_required" };
  return { input };
}

function cleanRemainingText(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Extract tool calls written as text. Only names in `tools` are accepted.
 */
export function parseTextToolCalls(
  text: string,
  tools: LLMTool[],
  options: TextToolCallParseOptions = {},
): ParsedTextToolCalls {
  const source = String(text || "");
  const empty: ParsedTextToolCalls = {
    toolUses: [],
    remainingText: source,
    formats: [],
    rejected: [],
  };
  if (!source.trim() || !Array.isArray(tools) || tools.length === 0) return empty;
  if (!/[{[<]/.test(source)) return empty;

  const toolsByName = new Map(tools.map((tool) => [tool.name, tool]));
  const maxCalls = Math.max(1, Math.floor(options.maxCalls ?? DEFAULT_MAX_TEXT_TOOL_CALLS));
  const toolUses: LLMToolUse[] = [];
  const accepted: Span[] = [];
  const formats: TextToolCallFormat[] = [];
  const rejected: TextToolCallRejection[] = [];

  for (const candidate of findCandidates(source, options.userText)) {
    if (!candidate.calls) {
      rejected.push({ format: candidate.format, reason: "malformed_json" });
      continue;
    }
    const resolved: LLMToolUse[] = [];
    let rejection: TextToolCallRejection | null = null;
    for (const call of candidate.calls) {
      const tool = resolveToolName(call.name, toolsByName);
      if (!tool) {
        rejection = { format: candidate.format, reason: "unknown_tool", name: call.name };
        break;
      }
      const args = resolveArguments(call, tool);
      if ("reason" in args) {
        rejection = { format: candidate.format, reason: args.reason, name: tool.name };
        break;
      }
      resolved.push({
        type: "tool_use",
        id: `call_text_${randomUUID().replace(/-/g, "").slice(0, 24)}`,
        name: tool.name,
        input: args.input,
      });
    }
    if (rejection) {
      rejected.push(rejection);
      continue;
    }
    if (toolUses.length + resolved.length > maxCalls) {
      for (const call of resolved) {
        rejected.push({ format: candidate.format, reason: "call_limit", name: call.name });
      }
      continue;
    }
    toolUses.push(...resolved);
    accepted.push(candidate);
    if (!formats.includes(candidate.format)) formats.push(candidate.format);
  }

  if (toolUses.length === 0) return { ...empty, rejected };
  return {
    toolUses,
    remainingText: cleanRemainingText(removeSpans(source, accepted)),
    formats,
    rejected,
  };
}

export interface TextToolCallFallbackContext {
  providerType: string;
  model: string;
  /** native_tools: tools were sent natively; text_protocol: tools were described in the prompt. */
  mode: "native_tools" | "text_protocol";
  maxCalls?: number;
}

export interface TextToolCallFallbackStats {
  recoveredResponses: number;
  recoveredCalls: number;
  rejectedCalls: number;
  textProtocolActivations: number;
  byFormat: Partial<Record<TextToolCallFormat, number>>;
}

function createEmptyStats(): TextToolCallFallbackStats {
  return {
    recoveredResponses: 0,
    recoveredCalls: 0,
    rejectedCalls: 0,
    textProtocolActivations: 0,
    byFormat: {},
  };
}

let stats = createEmptyStats();

/** Process-wide counters for how often the text fallback fires. */
export function getTextToolCallFallbackStats(): TextToolCallFallbackStats {
  return { ...stats, byFormat: { ...stats.byFormat } };
}

export function resetTextToolCallFallbackStatsForTests(): void {
  stats = createEmptyStats();
}

/** Called by providers when they switch a model to the prompt-described tool protocol. */
export function recordTextToolProtocolActivation(providerType: string, model: string): void {
  stats.textProtocolActivations += 1;
  logger.info("Native tool calling unsupported; using the text tool protocol", {
    providerType,
    model,
  });
}

function latestUserText(request: LLMRequest): string {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index];
    if (message.role !== "user") continue;
    if (typeof message.content === "string") return message.content;
    return message.content
      .map((block) => (block.type === "text" ? block.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Convert tool calls written as assistant text into tool_use blocks. Responses
 * that already carry native tool calls, requests without tools, and requests
 * that disabled tool use are returned unchanged.
 */
export function applyTextToolCallFallback(
  response: LLMResponse,
  request: LLMRequest,
  context: TextToolCallFallbackContext,
): LLMResponse {
  const tools = request.tools;
  if (!Array.isArray(tools) || tools.length === 0 || request.toolChoice === "none") {
    return response;
  }
  if (!Array.isArray(response.content) || response.stopReason === "refusal") return response;
  if (response.content.some((block) => block.type === "tool_use")) return response;
  const textBlocks = response.content.filter(
    (block): block is Extract<LLMContent, { type: "text" }> => block.type === "text",
  );
  const text = textBlocks.map((block) => block.text).join("\n");
  if (!text.trim()) return response;

  const parsed = parseTextToolCalls(text, tools, {
    maxCalls: context.maxCalls,
    userText: latestUserText(request),
  });
  stats.rejectedCalls += parsed.rejected.length;
  if (parsed.toolUses.length === 0) {
    if (parsed.rejected.length > 0) {
      logger.info("Ignored tool-call text that could not be executed", {
        providerType: context.providerType,
        model: context.model,
        mode: context.mode,
        rejected: parsed.rejected,
      });
    }
    return response;
  }

  stats.recoveredResponses += 1;
  stats.recoveredCalls += parsed.toolUses.length;
  for (const format of parsed.formats) {
    stats.byFormat[format] = (stats.byFormat[format] ?? 0) + 1;
  }
  logger.info("Recovered tool calls from assistant text", {
    providerType: context.providerType,
    model: context.model,
    mode: context.mode,
    calls: parsed.toolUses.map((call) => call.name),
    formats: parsed.formats,
    rejected: parsed.rejected.length,
  });

  const content: LLMContent[] = [];
  let textPlaced = false;
  for (const block of response.content) {
    if (block.type !== "text") {
      content.push(block);
      continue;
    }
    if (textPlaced) continue;
    textPlaced = true;
    if (parsed.remainingText) content.push({ type: "text", text: parsed.remainingText });
  }
  content.push(...parsed.toolUses);
  return { ...response, content, stopReason: "tool_use" };
}
