/**
 * Pasted memory exports (the "From another assistant" import, `MemoryService.importFromText`).
 *
 * The user runs `MEMORY_EXPORT_PROMPT` (src/shared/memory-import-prompt.ts) in another
 * assistant and pastes the answer back. This module parses that answer: the first code
 * block (or the whole text), category sections (Instructions, Identity, Career, Projects,
 * Preferences), `[YYYY-MM-DD] - entry` lines, and the closing note on whether the export
 * is complete. Pure: no service or database imports.
 */
import type { MemoryItemKind } from "./memory-items-types";
import type { TextMemoryImportCategory } from "../../shared/memory-import-prompt";

export interface TextImportEntry {
  /** The section the entry was listed under; `null` when the paste has no sections. */
  category: TextMemoryImportCategory | null;
  /** `YYYY-MM-DD` (or the free-form date the assistant gave); absent for `[unknown]`. */
  date?: string;
  text: string;
}

export interface ParsedTextImport {
  entries: TextImportEntry[];
  /** The assistant said more entries remain (the user should ask it to continue). */
  incomplete: boolean;
}

/** How each category is stored: archive row type and `memory_items` fact kind. */
export const TEXT_IMPORT_CATEGORY_STORAGE: Record<
  TextMemoryImportCategory,
  { type: "observation" | "decision" | "insight"; kind: MemoryItemKind; label: string }
> = {
  instructions: { type: "observation", kind: "rule", label: "Instructions" },
  identity: { type: "observation", kind: "identity", label: "Identity" },
  career: { type: "observation", kind: "identity", label: "Career" },
  projects: { type: "observation", kind: "project_fact", label: "Projects" },
  preferences: { type: "observation", kind: "preference", label: "Preferences" },
};

const CATEGORY_ALIASES: Array<[RegExp, TextMemoryImportCategory]> = [
  [/^(instructions?|rules?|response instructions?)$/, "instructions"],
  [/^(identity|personal( details| info(rmation)?)?|about me)$/, "identity"],
  [/^(career|work|professional|job)$/, "career"],
  [/^(projects?|goals?|projects (and|&) goals)$/, "projects"],
  [/^(preferences?|tastes?|working[- ]style)$/, "preferences"],
];

const UNKNOWN_DATES = new Set(["unknown", "n/a", "na", "no date", "undated", "?", ""]);

/**
 * A section header line: `## Instructions`, `**1. Identity**`, `1. **Career**:`,
 * `Projects:`. Returns `undefined` for a line that is not a header.
 */
function sectionOf(line: string): TextMemoryImportCategory | undefined {
  const isMarkdownHeading = /^#{1,6}\s+/.test(line);
  const isBold = /^(\d+[.)]\s*)?\*\*[^*]+\*\*\s*:?\s*$/.test(line);
  const isLabel = /^(\d+[.)]\s*)?[A-Za-z][A-Za-z &/-]{1,40}:$/.test(line);
  if (!isMarkdownHeading && !isBold && !isLabel) return undefined;
  const name = line
    .replace(/^#{1,6}\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/^\d+[.)]\s*/, "")
    .replace(/:\s*$/, "")
    .trim()
    .toLowerCase();
  for (const [pattern, category] of CATEGORY_ALIASES) {
    if (pattern.test(name)) return category;
  }
  return undefined;
}

/** Markdown heading or bold-only line that names no known category (skipped, not an entry). */
function isOtherHeading(line: string): boolean {
  return /^#{1,6}\s+/.test(line) || /^\*\*[^*]+\*\*\s*:?\s*$/.test(line);
}

function firstCodeBlock(text: string): { block: string; after: string } | null {
  const match = text.match(/```(?:[a-zA-Z0-9_-]+)?[ \t]*\r?\n?([\s\S]*?)```/);
  const block = match?.[1]?.trim();
  if (!match || !block) return null;
  return { block, after: text.slice((match.index ?? 0) + match[0].length) };
}

/** The closing note says entries remain ("Not the complete set", "more remain"). */
export function exportLooksIncomplete(note: string): boolean {
  const text = note.toLowerCase();
  if (!text.trim()) return false;
  if (/\b(no|none|nothing)\b[^.]{0,30}\b(remain|left|missing|omitted)/.test(text)) return false;
  return (
    /\b(not|isn't|is not|wasn't)\s+(the\s+|a\s+)?(complete|full|entire)\b/.test(text) ||
    /\bmore\s+(\w+\s+){0,2}(remain|left|to come|follow)/.test(text) ||
    /\b(partial|truncated|continued in|first (part|batch))\b/.test(text) ||
    /\b(say|type|reply|ask)\s+["“']?continue/.test(text)
  );
}

export function parseTextMemoryImport(pastedText: string): ParsedTextImport {
  const fenced = firstCodeBlock(pastedText);
  const source = fenced?.block ?? pastedText;
  const entries: TextImportEntry[] = [];
  const datedPattern = /^(?:[-*•]\s*)?\[([^\]]{0,120})\]\s*[-—–:]\s*(.+)$/;
  let category: TextMemoryImportCategory | null = null;
  let current: TextImportEntry | null = null;
  let trailingNote = fenced?.after ?? "";

  const flush = () => {
    if (current?.text) entries.push(current);
    current = null;
  };

  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("```")) continue;

    const section = sectionOf(line);
    if (section) {
      flush();
      category = section;
      continue;
    }
    if (isOtherHeading(line)) {
      flush();
      continue;
    }

    const dated = line.match(datedPattern);
    if (dated) {
      flush();
      const date = dated[1].trim();
      current = {
        category,
        ...(UNKNOWN_DATES.has(date.toLowerCase()) ? {} : { date }),
        text: dated[2].trim(),
      };
      continue;
    }

    // An indented line continues the previous entry.
    if (current && /^\s+/.test(rawLine)) {
      current.text = `${current.text} ${line}`;
      continue;
    }

    flush();
    // Without a code block the closing note is plain text after the last entry; keep it
    // out of the entries when it reads like one.
    if (!fenced && /\b(complete set|more remain|entries remain)\b/i.test(line)) {
      trailingNote += `\n${line}`;
      continue;
    }
    const text = line.replace(/^(?:[-*•]|\d+[.)])\s+/, "").trim();
    if (text) entries.push({ category, text });
  }
  flush();

  return {
    entries,
    incomplete: exportLooksIncomplete(trailingNote),
  };
}

/** The stored text of an entry: `[YYYY-MM-DD] - text`, or the text when undated. */
export function textImportEntryBody(entry: TextImportEntry): string {
  return entry.date ? `[${entry.date}] - ${entry.text}` : entry.text;
}
