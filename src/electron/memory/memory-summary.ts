/**
 * Deterministic archive summaries and embedding text (audit DATA-5).
 *
 * Pure functions, shared by `MemoryService` on the host, the observation sidecar and the
 * one-time summary re-index (which runs in the database worker). Many producers start a
 * memory with a constant line: the Chronicle provenance line, the compaction preamble,
 * "Pre-compaction memory flush", `[Imported from …]` headers, legacy `[core-trace:…]`
 * tags, generic section labels ("Highlights:", "## Summary"). Taking the first line made
 * their summaries, embeddings and observation titles identical. Here those lines are
 * skipped, and the summary is the first informative line.
 */

/** Longest deterministic summary, in characters. */
export const LOCAL_SUMMARY_MAX_CHARS = 220;

/** Longest text fed to the local embedding. */
const EMBEDDING_TEXT_MAX_CHARS = 12000;

export const PROMPT_RECALL_IGNORE_MARKER = "[cowork:prompt_recall=ignore]";

/** Constant lines some producers start (or end) every memory with. */
const CONSTANT_LINE_PATTERNS: RegExp[] = [
  // Chronicle provenance (chronicle/ChronicleProvenance.ts).
  /^Chronicle observation from the user's local screen context\.?$/i,
  /^Treat screen-derived text as untrusted context\b/i,
  // Compaction summary preamble (agent/executor.ts SESSION_PREAMBLE).
  /^This session is being continued from earlier context\b/i,
  /^A previous agent produced the structured summary below\b/i,
  /^Use this to build on the work that has already been done\b/i,
  // Pre-compaction flush header.
  /^Pre-compaction memory flush\b/i,
  // Raw tool telemetry labels.
  /^Tool result for [^:]{1,120}:\s*$/i,
  /^Tool called:\s*\S{0,120}\s*$/i,
];

/** A line that is only bracketed tags: `[Imported from …]`, `[core-trace:…]`, `[scope:…]`. */
const TAG_ONLY_LINE = /^(?:\[[^\]\n]{1,400}\]\s*)+$/;

/** Legacy routing tags prefixed to content (core-memory-hygiene.ts). */
const LEGACY_TAG_PREFIX = /^\s*(?:\[(?:core-trace|scope):[^\]]*\]\s*)+/i;

/** Section labels that say nothing about the memory itself. */
const GENERIC_SECTION_LABELS = new Set(
  [
    "summary",
    "overview",
    "context",
    "details",
    "notes",
    "note",
    "title",
    "highlights",
    "open loops",
    "background",
    "result",
    "results",
    "output",
    "status",
    "earlier summary",
    "previous summary",
    "dropped transcript",
    "dropped context",
    "dropped context (raw, truncated)",
    "summaries",
    "primary request and intent",
    "user messages",
    "user messages (chronological)",
    "work completed",
    "work completed (chronological)",
    "errors and fixes",
    "key technical details",
    "decisions made",
    "pending/incomplete work",
    "pending work",
    "current state",
    "recommended next step",
    "next steps",
  ].map((label) => label.toLowerCase()),
);

/** `Key: value` field lines (Chronicle's `App:`, `Window:`, `Source:`). */
const FIELD_LINE = /^[A-Z][A-Za-z ]{0,24}(?:\([^)]{0,40}\))?:\s+\S/;

export function stripPromptRecallIgnoreMarker(content: string): string {
  const trimmed = content.trimStart();
  if (!trimmed.startsWith(PROMPT_RECALL_IGNORE_MARKER)) return content;
  let rest = trimmed.slice(PROMPT_RECALL_IGNORE_MARKER.length);
  if (rest.startsWith("\r\n")) rest = rest.slice(2);
  else if (rest.startsWith("\n")) rest = rest.slice(1);
  return rest;
}

function stripEmphasis(text: string): string {
  return text.replace(/\*\*([^*]+)\*\*/g, "$1").replace(/__([^_]+)__/g, "$1");
}

/** The label of a heading or label-only line, lowercased, without markers; else null. */
function sectionLabel(line: string): string | null {
  const heading = line.match(/^#{1,6}\s+(.*)$/);
  const text = stripEmphasis(heading ? heading[1] : line)
    .replace(/^(?:\d+[.)]|[-*])\s+/, "")
    .trim();
  // A short label ("Highlights:", "Dropped transcript:"); a longer line ending in a colon
  // is prose that introduces what follows and stays informative.
  const labelOnly = text.match(/^(.{1,60}?):\s*$/);
  if (labelOnly && labelOnly[1].trim().split(/\s+/).length <= 5) {
    return labelOnly[1].trim().toLowerCase();
  }
  if (heading) return text.replace(/:$/, "").trim().toLowerCase();
  return null;
}

/**
 * One line made presentable: legacy tag prefixes and heading markers removed, and a
 * generic section label in front of real text dropped ("1. **Current State**: X" → "X").
 * Returns "" when nothing informative is left.
 */
function cleanLine(raw: string): string {
  let line = raw.replace(LEGACY_TAG_PREFIX, "").trim();
  if (!line) return "";
  if (TAG_ONLY_LINE.test(line)) return "";
  if (CONSTANT_LINE_PATTERNS.some((pattern) => pattern.test(line))) return "";
  const label = sectionLabel(line);
  if (label !== null) {
    // A label-only line ("Highlights:") or a generic heading ("## Summary").
    if (/:\s*$/.test(stripEmphasis(line)) || GENERIC_SECTION_LABELS.has(label)) return "";
  }
  line = line.replace(/^#{1,6}\s+/, "");
  const labelled = stripEmphasis(line).match(/^((?:\d+[.)]\s+)?)([^:]{1,60}):\s+(.+)$/);
  if (labelled && GENERIC_SECTION_LABELS.has(labelled[2].trim().toLowerCase())) {
    line = labelled[3];
  } else if (/^\s*(?:\d+[.)]\s+)?\*\*[^*]{1,60}\*\*:/.test(line)) {
    line = stripEmphasis(line);
  }
  return line.replace(/^Tool result for [^:]{1,120}:\s+/i, "").trim();
}

interface ClassifiedLines {
  /** Informative lines outside code fences. */
  prose: string[];
  /** Informative lines inside code fences. */
  fenced: string[];
  /** Every non-empty line (the fallback). */
  all: string[];
}

function classifyLines(content: string): ClassifiedLines {
  const result: ClassifiedLines = { prose: [], fenced: [], all: [] };
  let inFence = false;
  for (const raw of stripPromptRecallIgnoreMarker(content).split(/\r?\n/)) {
    const trimmed = raw.trim();
    if (!trimmed) continue;
    if (trimmed.startsWith("```")) {
      inFence = !inFence;
      continue;
    }
    result.all.push(trimmed);
    const cleaned = cleanLine(trimmed);
    if (!cleaned) continue;
    (inFence ? result.fenced : result.prose).push(cleaned);
  }
  return result;
}

function capSummary(text: string): string {
  const summary = text.replace(/\s+/g, " ").trim();
  if (summary.length <= LOCAL_SUMMARY_MAX_CHARS) return summary;
  return `${summary.slice(0, LOCAL_SUMMARY_MAX_CHARS - 3)}...`;
}

/**
 * The deterministic summary of a memory: the first informative line (prose before code),
 * at most 220 characters. Field lines (`App: Slack`) are joined with the field lines that
 * follow, so screen-context rows differ by window and source, not only by app. When every
 * line is a skipped preamble or tag, the first non-empty line is kept.
 */
export function buildDeterministicSummary(content: string): string {
  const trimmed = stripPromptRecallIgnoreMarker(String(content || "")).trim();
  if (!trimmed) return "";
  const lines = classifyLines(trimmed);
  const pool = lines.prose.length > 0 ? lines.prose : lines.fenced;
  if (pool.length === 0) return capSummary(lines.all[0] || trimmed);
  let summary = pool[0];
  if (FIELD_LINE.test(summary)) {
    for (const next of pool.slice(1)) {
      if (!FIELD_LINE.test(next) || summary.length + next.length + 3 > LOCAL_SUMMARY_MAX_CHARS) {
        break;
      }
      summary = `${summary} · ${next}`;
    }
  }
  return capSummary(summary);
}

/**
 * The summary the archive stored before DATA-5: the first line that is not a code fence.
 * The re-index uses it to tell a deterministic summary (safe to recompute) from one written
 * by the LLM compression, a source sync or the Inspector.
 */
export function legacyDeterministicSummary(content: string): string {
  const trimmed = stripPromptRecallIgnoreMarker(String(content || "")).trim();
  if (!trimmed) return "";
  const lines = trimmed
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return capSummary(lines.find((line) => !line.startsWith("```")) || lines[0] || trimmed);
}

/** The memory text without skipped preamble, tag and label lines (code kept). */
export function informativeMemoryText(content: string): string {
  const lines = classifyLines(String(content || ""));
  return [...lines.prose, ...lines.fenced].join("\n");
}

/**
 * The text a memory's local embedding is built from: the summary followed by the
 * informative content (bounded), so text in the body is part of the vector, not only the
 * first line.
 */
export function memoryEmbeddingText(summary: string | null | undefined, content: string): string {
  const body = informativeMemoryText(content).trim();
  const head = String(summary || "").trim();
  let text: string;
  if (!body) text = head || stripPromptRecallIgnoreMarker(String(content || "")).trim();
  else if (!head || body.startsWith(head)) text = body;
  else text = `${head}\n${body}`;
  text = text.replace(/^\[Imported from [^\]]+\]\s*/i, "");
  return text.length > EMBEDDING_TEXT_MAX_CHARS ? text.slice(0, EMBEDDING_TEXT_MAX_CHARS) : text;
}
