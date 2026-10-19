import * as path from "path";

export type StepContractMode = "mutation_required" | "artifact_presence_required" | "analysis_only";
export type StepContractEnforcementLevel = "strict" | "standard" | "advisory";

const CANONICAL_ARTIFACT_EXTENSION_LIST = [
  "pdf",
  "docx",
  "md",
  "csv",
  "xlsx",
  "json",
  "jsonl",
  "txt",
  "pptx",
  "psd",
  "psb",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "ico",
  "mp4",
  "mov",
  "webm",
  "html",
  "css",
  "js",
  "jsx",
  "ts",
  "tsx",
  "py",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "rb",
  "php",
  "sh",
  "sql",
  "yaml",
  "yml",
  "toml",
  "xml",
  "xcodeproj",
  "xcworkspace",
  "xcscheme",
  "pbxproj",
  "entitlements",
  "plist",
] as const;

const CANONICAL_ARTIFACT_EXTENSION_SET = new Set<string>(CANONICAL_ARTIFACT_EXTENSION_LIST);
export { CANONICAL_ARTIFACT_EXTENSION_SET as CANONICAL_ARTIFACT_EXTENSION_SET_EXPORT };
const CANONICAL_EXTENSIONS_WITH_DOT = CANONICAL_ARTIFACT_EXTENSION_LIST.map(
  (extension) => `.${extension}`,
);
const CANONICAL_EXTENSION_PATTERN = CANONICAL_ARTIFACT_EXTENSION_LIST.map((extension) =>
  extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
).join("|");

export const CANONICAL_ARTIFACT_EXTENSION_REGEX = new RegExp(
  `\\.(${CANONICAL_EXTENSION_PATTERN})\\b`,
  "i",
);
const CANONICAL_ARTIFACT_EXTENSION_REGEX_GLOBAL = new RegExp(
  `\\.(${CANONICAL_EXTENSION_PATTERN})\\b`,
  "gi",
);
const TRAILING_ARTIFACT_EXTENSION_REGEX = new RegExp(`\\.(${CANONICAL_EXTENSION_PATTERN})$`, "i");

export const CANONICAL_ARTIFACT_PATH_REGEX = new RegExp(
  `(?:\\/|\\.{1,2}\\/)?[A-Za-z0-9_./-]+\\.(${CANONICAL_EXTENSION_PATTERN})\\b`,
  "gi",
);

const COMMAND_PREFIX_REGEX =
  /(^|\s)(python3?|node|npm|npx|pnpm|yarn|bash|sh|zsh|git|curl|wget|cat|make|cmake|xcodebuild|uv|pip3?|go|cargo|java|ruby|php|ssh|scp|sftp|ping|traceroute|mtr|nc|netcat|telnet|dig|nslookup|nmap)\b/i;
const SHELL_OPERATOR_REGEX = /(?:\|\||&&|[|;<>])/;
const URL_LIKE_REGEX = /^[a-z][a-z0-9+.-]*:\/\//i;
const ALTERNATE_EXTENSION_PATH_REGEX =
  /((?:\/|\.{1,2}\/)?[A-Za-z0-9_./-]+)\.([A-Za-z0-9]+)\/\.([A-Za-z0-9]+)\b/g;
const WRITE_VERB_PATTERN =
  "write|create|draft|generate|produce|compose|build|save|author|scaffold|bootstrap|initialize|implement|configure|add|edit|update|append|rewrite|delete|remove|rename|move|modify|replace|fix|refactor|patch|adjust|optimi[sz]e|tweak|stabili[sz]e|bump|upgrade|repair|migrate";
// "change", "correct", "convert" and "resolve" are also nouns/adjectives or
// read-only verbs ("the change log", "is correct", "resolve the hostname"),
// so they count only with an object that makes them a remediation.
const STRONG_WRITE_VERB_REGEX = new RegExp(
  String.raw`\b(${WRITE_VERB_PATTERN})\b|\b(?:change|correct|convert)\s+(?:it|them|this|that|these|those|the|a|an|all|any|each|every|its|their|our)\b|\bresolve\s+(?:(?:the|all|any|each|every|its|their|our|these|those|remaining|outstanding)\s+)*(?:(?:merge|type|lint|build|test)\s+)?(?:conflicts?|issues?|bugs?|errors?|warnings?|failures?|problems?|it|them)\b`,
);
// A write verb with list commas on both sides is a noun in an enumeration
// ("purchase, wallet, save, UI, and test code"), not an instruction.
const LIST_ITEM_WRITE_VERB_REGEX = new RegExp(
  String.raw`,\s*(?:${WRITE_VERB_PATTERN})\s*(?=,)`,
  "g",
);
// Continue through dots inside filenames ("package.json") so the extension of
// a protected file does not leak into the positive text.
const NEGATED_CLAUSE_REGEX =
  /\b(?:do\s+not|don't|must\s+not|should\s+not|never|no\s+need\s+to|without)\b(?:[^,.;!?\n]|\.(?=[A-Za-z0-9_/-]))*/gi;
const PASSIVE_ARTIFACT_WRITE_CUE_REGEX =
  /\b(saved|written|created|generated|produced|updated|edited|rewritten|appended|stored|placed)\s+(?:as|to|at|in|under)\b/;

function normalizeWithLeadingDot(extension: string): string {
  const raw = String(extension || "")
    .trim()
    .toLowerCase();
  if (!raw) return "";
  return raw.startsWith(".") ? raw : `.${raw}`;
}

export function getCanonicalArtifactExtensions(): string[] {
  return [...CANONICAL_EXTENSIONS_WITH_DOT];
}

export function hasArtifactExtensionMention(text: string): boolean {
  return CANONICAL_ARTIFACT_EXTENSION_REGEX.test(String(text || ""));
}

export function extractArtifactExtensionsFromText(text: string): string[] {
  // An extension shorthand names alternative files, not two required output
  // formats. Concrete paths selected by the caller contribute their extension.
  const normalized = String(text || "")
    .replace(ALTERNATE_EXTENSION_PATH_REGEX, " ")
    .toLowerCase();
  if (!normalized.trim()) return [];

  const extensions = new Set<string>();
  const matches = normalized.match(CANONICAL_ARTIFACT_EXTENSION_REGEX_GLOBAL);
  if (matches) {
    for (const token of matches) {
      // The regex returns the extension token itself (".html"), not a path.
      // path.extname(".html") is empty because Node treats it as a dotfile.
      const extension = normalizeWithLeadingDot(token);
      if (extension && CANONICAL_ARTIFACT_EXTENSION_SET.has(extension.slice(1))) {
        extensions.add(extension);
      }
    }
  }

  if (/\bmarkdown\b|\bmd file\b/.test(normalized)) extensions.add(".md");
  if (/\bmd\b/.test(normalized)) extensions.add(".md");
  if (/\bdocx\b|\bword document\b/.test(normalized)) extensions.add(".docx");
  if (/\bcsv\b/.test(normalized)) extensions.add(".csv");
  if (/\bjsonl\b/.test(normalized)) extensions.add(".jsonl");
  // App capabilities and checks do not request a separately created JSON file.
  // Explicit .json paths were collected above and remain authoritative.
  // Neither does JSON described as data the app handles ("valid JSON round trips",
  // "exported non-ASCII JSON satisfies the import limit").
  const jsonOutputText = normalized
    .replace(/\b(?:export\s*(?:\/|and)\s*import|import\s*(?:\/|and)\s*export)\s+json\b/g, " ")
    .replace(
      /\bjson\s+(?:export\s*(?:\/|and)\s*import|import\s*(?:\/|and)\s*export|round[- ]trips?|transfers?|handling|validation|imports?|exports?|parsing)\b/g,
      " ",
    )
    .replace(
      /\b(?:exported|imported|valid|invalid|malformed|parsed|serialized|corrupt|stored)\s+(?:[\w-]+\s+)?json\b/g,
      " ",
    );
  if (/\bjson\b/.test(jsonOutputText)) extensions.add(".json");
  if (/\bxlsx\b|\bexcel\b|\bspreadsheet\b/.test(normalized)) extensions.add(".xlsx");
  if (/\bpptx\b|\bslides?\b|\bpowerpoint\b/.test(normalized)) extensions.add(".pptx");
  if (/\bpdf\b/.test(normalized)) extensions.add(".pdf");
  if (/\bpsd\b/.test(normalized)) extensions.add(".psd");
  if (/\bpng\b/.test(normalized)) extensions.add(".png");
  if (/\btxt\b|\btext file\b|\bplain text\b/.test(normalized)) extensions.add(".txt");
  return Array.from(extensions.values());
}

export function isLikelyCommandSnippet(text: string): boolean {
  const value = String(text || "").trim();
  if (!value) return false;
  if (SHELL_OPERATOR_REGEX.test(value)) return true;
  if (COMMAND_PREFIX_REGEX.test(value)) return true;
  if (/\s-[A-Za-z]/.test(value)) return true;
  return false;
}

export function isArtifactPathLikeToken(text: string): boolean {
  const value = String(text || "")
    .trim()
    .replace(/^['"]+|['"]+$/g, "");
  if (!value) return false;
  if (URL_LIKE_REGEX.test(value)) return false;
  if (isLikelyCommandSnippet(value)) return false;
  if (path.isAbsolute(value)) return true;
  if (CANONICAL_ARTIFACT_EXTENSION_REGEX.test(value)) return true;
  const hasSeparator = value.includes("/") || value.includes("\\");
  const hasWhitespace = /\s/.test(value);
  return hasSeparator && !hasWhitespace;
}

export function extractArtifactPathCandidates(text: string): string[] {
  const source = String(text || "");
  if (!source.trim()) return [];

  const candidates = new Set<string>();
  const alternateRanges: Array<{ start: number; end: number }> = [];
  const commandSnippetRanges: Array<{ start: number; end: number }> = [];
  const backtickPattern = /`([^`]+)`/g;
  let backtickMatch = backtickPattern.exec(source);
  while (backtickMatch) {
    const token = String(backtickMatch[0] || "");
    const value = token.replace(/`/g, "").trim();
    if (!value) {
      backtickMatch = backtickPattern.exec(source);
      continue;
    }
    const start = backtickMatch.index;
    if (isLikelyCommandSnippet(value)) {
      commandSnippetRanges.push({ start, end: start + token.length });
    }
    if (isArtifactPathLikeToken(value) && !/\.[a-z0-9]+\/\.[a-z0-9]+$/i.test(value)) {
      candidates.add(value);
    }
    backtickMatch = backtickPattern.exec(source);
  }

  for (const match of source.matchAll(ALTERNATE_EXTENSION_PATH_REGEX)) {
    const [, stem, firstExtension, secondExtension] = match;
    const inCommandSnippet = commandSnippetRanges.some(
      (range) => match.index >= range.start && match.index < range.end,
    );
    if (
      inCommandSnippet ||
      !CANONICAL_ARTIFACT_EXTENSION_SET.has(firstExtension.toLowerCase()) ||
      !CANONICAL_ARTIFACT_EXTENSION_SET.has(secondExtension.toLowerCase())
    )
      continue;
    candidates.add(`${stem}.${firstExtension}`);
    candidates.add(`${stem}.${secondExtension}`);
    alternateRanges.push({ start: match.index, end: match.index + match[0].length });
  }

  const barePattern = new RegExp(CANONICAL_ARTIFACT_PATH_REGEX.source, "gi");
  let bareMatch = barePattern.exec(source);
  while (bareMatch) {
    const token = String(bareMatch[0] || "").trim();
    const start = bareMatch.index;
    const inCommandSnippet = commandSnippetRanges.some(
      (range) => start >= range.start && start < range.end,
    );
    const inAlternatePath = alternateRanges.some(
      (range) => start >= range.start && start < range.end,
    );
    if (!inCommandSnippet && !inAlternatePath && token) {
      // The bare pattern stops at whitespace, so "/Users/me/Library/Application
      // Support/app/notes.md" matches only "Support/app/notes.md". That tail is
      // not a workspace-relative path: report the whole absolute path instead.
      const absolutePrefix = /^[./~]/.test(token) ? null : spacedAbsolutePathPrefix(source, start);
      candidates.add(absolutePrefix ? `${absolutePrefix} ${token}` : token);
    }
    bareMatch = barePattern.exec(source);
  }

  return Array.from(candidates.values());
}

// Words that join two separate paths ("compare /tmp/out and docs/a.md") rather
// than continue one folder name that contains a space.
const PATH_JOINING_WORDS = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "by",
  "for",
  "from",
  "in",
  "inside",
  "into",
  "of",
  "on",
  "or",
  "plus",
  "the",
  "then",
  "to",
  "under",
  "versus",
  "via",
  "vs",
  "with",
  "within",
]);

/**
 * When the path that ends at `start` began earlier as an absolute path whose
 * folder names contain single spaces, return the part before the space at
 * `start - 1` (for example "/Users/me/Library/Application"). Returns null when
 * the preceding words are not one continuous absolute path.
 */
function spacedAbsolutePathPrefix(source: string, start: number): string | null {
  if (start < 2 || source[start - 1] !== " ") return null;
  const tokens = source.slice(0, start - 1).split(" ");
  const parts: string[] = [];
  for (let index = tokens.length - 1; index >= 0 && parts.length < 6; index -= 1) {
    const token = tokens[index];
    // Empty tokens (double spaces), line breaks, and clause punctuation all end
    // the path; so does a complete file name ("/tmp/a.md docs/b.md").
    if (!token || /\s/.test(token) || /[,;:!?)\]}>]$/.test(token)) return null;
    if (TRAILING_ARTIFACT_EXTENSION_REGEX.test(token) || token.includes("://")) return null;
    const unquoted = token.replace(/^[`'"([{<]+/, "");
    if (/^(?:~|[A-Za-z]:)?\//.test(unquoted)) {
      if (unquoted.endsWith("/")) return null;
      parts.unshift(unquoted);
      return parts.join(" ");
    }
    if (unquoted !== token || PATH_JOINING_WORDS.has(token.toLowerCase())) return null;
    parts.unshift(token);
  }
  return null;
}

export function extractArtifactPathAlternativeGroups(text: string): string[][] {
  const groups: string[][] = [];
  for (const match of String(text || "").matchAll(ALTERNATE_EXTENSION_PATH_REGEX)) {
    const [, stem, firstExtension, secondExtension] = match;
    if (
      CANONICAL_ARTIFACT_EXTENSION_SET.has(firstExtension.toLowerCase()) &&
      CANONICAL_ARTIFACT_EXTENSION_SET.has(secondExtension.toLowerCase())
    ) {
      groups.push([`${stem}.${firstExtension}`, `${stem}.${secondExtension}`]);
    }
  }
  return groups;
}

export function descriptionHasWriteIntent(text: string): boolean {
  let desc = String(text || "").toLowerCase();
  // Establishing what a report covers is planning. An explicit output path or
  // a separate write verb still makes the step an artifact-producing operation.
  if (extractArtifactPathCandidates(desc).length === 0) {
    desc = desc.replace(
      /\b(?:define|establish|specify|lock|set)\s+(?:the\s+)?(?:(?:report|project|task)\s+)?scope\b/g,
      " ",
    );
  }
  if (descriptionHasStrongWriteIntent(desc)) return true;

  const structuredWriteVerb = /\b(lock|define|specify|establish|set)\b/.test(desc);
  if (structuredWriteVerb) {
    const hasArtifactCue = descriptionHasArtifactCue(desc) || hasArtifactExtensionMention(desc);
    const hasArtifactPath = extractArtifactPathCandidates(desc).length > 0;
    const namingOnlyCue =
      /\b(output|artifact|file)\s+name\b/.test(desc) ||
      /\bname\s+(?:the\s+)?(?:output|artifact|file)\b/.test(desc) ||
      /\bdefine\s+(?:the\s+)?(?:output|artifact|file)\s+name\b/.test(desc) ||
      /\bset\s+(?:the\s+)?(?:output|artifact|file)\s+name\b/.test(desc);
    if (!namingOnlyCue && (hasArtifactCue || hasArtifactPath)) {
      return true;
    }
  }

  // "prepare" is ambiguous (often setup/planning only). Treat it as write-intent
  // only when paired with a concrete artifact/output cue.
  const prepareArtifactCue =
    /\bprepare(?:\s+[\w./-]+){0,6}\s+(?:a\s+|an\s+|the\s+)?(file|document|artifact|report|summary|proposal|plan|markdown|md|docx|pdf|csv|json|xlsx|pptx|slides?|presentation|code|script|output)\b/.test(
      desc,
    );
  return prepareArtifactCue;
}

/**
 * Remove file paths so words inside them are not read as instructions: the
 * folder in ".../skills/implement-in-app-purchases/references/pre-check.md"
 * does not ask the step to implement anything.
 */
function removePathTokens(text: string): string {
  const paths = extractArtifactPathCandidates(text)
    // A backticked phrase that ends in a filename ("`write notes.md`") is prose.
    .filter((candidate) => !/\s/.test(candidate) || /^(?:~|[A-Za-z]:)?\//.test(candidate))
    .sort((a, b) => b.length - a.length);
  let result = text;
  for (const candidate of paths) {
    result = result.split(candidate).join(" ");
  }
  return result;
}

export function stripNegatedClauses(text: string): string {
  return String(text || "").replace(NEGATED_CLAUSE_REGEX, " ");
}

export function descriptionHasStrongWriteIntent(text: string): boolean {
  const desc = removePathTokens(String(text || "").toLowerCase())
    // In inspection steps, "the build scripts" and "or build scripts" name
    // existing files; "build" is not an instruction to produce anything.
    .replace(/\b(?:the|existing|current|and|or)\s+build\s+scripts?\b/g, " ")
    // "Review the update" names an input; "update the report" is a mutation.
    // Other real write verbs ("write the update") remain in the sentence.
    .replace(/\b(?:the|an?|this|that|project|status|weekly|daily)\s+update\b/g, " ");
  return STRONG_WRITE_VERB_REGEX.test(desc) || PASSIVE_ARTIFACT_WRITE_CUE_REGEX.test(desc);
}

export function descriptionHasProtectiveConstraintIntent(text: string): boolean {
  const desc = String(text || "").toLowerCase();
  return (
    /\bexclude\b[^!?\n]{0,200}\bfrom\s+(?:consideration|scope|the\s+task)\b/.test(desc) ||
    /\b(?:do\s+not|don't|must\s+not|should\s+not|never)\s+(?:touch|modify|move|edit|change|write|delete|remove|rename)\b/.test(
      desc,
    ) ||
    // "create"/"access" are only protective when they target workspace content;
    // "do not access the internet" is not a file guardrail.
    /\b(?:do\s+not|don't|must\s+not|should\s+not|never)\s+(?:create|access)\b[^.;!?\n]{0,80}\b(?:files?|directories|folders?|paths?|workspace)\b/.test(
      desc,
    ) ||
    // Keep dots that are part of a filename (for example `notes.txt`) while
    // still stopping at an actual sentence boundary before the constraint.
    /\bleave\b(?:[^!?\n.]|\.(?=[A-Za-z0-9_/-])){0,160}\b(?:untouched|unchanged)\b/.test(desc) ||
    /\b(?:was|were|is|are)\s+not\s+(?:modified|moved|edited|changed|touched)\b/.test(desc)
  );
}

/**
 * Detect a plan step that only repeats a prohibition from the task prompt.
 * Such a step is a guardrail, not executable work. In particular, action
 * verbs inside "do not create, edit, or delete..." must not become tool
 * requirements or be sent to the model as an instruction to perform them.
 */
export function isReadOnlyConstraintOnlyStep(text: string): boolean {
  const desc = String(text || "").trim();
  if (!desc || !descriptionHasProtectiveConstraintIntent(desc)) return false;

  const operation = "(?:create|write|edit|modify|move|delete|remove|rename|access|touch|read|open)";
  const actionList =
    operation + "(?:(?:\\s*,\\s*(?:(?:and|or)\\s+)?|\\s+(?:and|or)\\s+)" + operation + ")*";
  const match = desc.match(
    new RegExp(
      "^\\s*(?:do\\s+not|don't|must\\s+not|should\\s+not|never)\\s+" +
        actionList +
        "\\s+([\\s\\S]+?)\\s*[.!?]?\\s*$",
      "i",
    ),
  );
  if (!match) return false;

  const target = String(match[1] || "").replace(
    /\b[A-Za-z0-9_./-]+\.(?:csv|tsv|xlsx?|docx?|pdf|md|txt|json|jsonl|ya?ml|toml|xml|pptx?|html?|css|js|tsx?|py|go|rs|swift|sql)\b/gi,
    " ",
  );
  if (!/\b(?:files?|directories|folders?|paths?|workspace)\b/i.test(target)) return false;

  // Keep a step executable when it continues with a positive task after the
  // prohibition (for example, "Do not edit sources; create a separate report"
  // or "Don't touch other files, just fix the failing test").
  if (/[;:]|\b(?:just|only)\b/i.test(target)) return false;
  return !/\b(?:but|then|instead|also|provide|return|calculate|compute|verify|compare|check|summari[sz]e|report|produce|create|write|edit|modify|move|delete|remove|rename|access|read|open|update|fix|add|append|insert|change|set|replace|refactor|implement|run|save|generate|export|build)\b/i.test(
    target,
  );
}

const READ_ONLY_VERB_REGEX =
  /\b(read|search|fetch|retrieve|browse|visit|analy[sz]e|review|understand|examine|inspect|check|parse|extract|summarize|study|explore|investigate|look)\b/;

export function descriptionHasReadOnlyIntent(text: string): boolean {
  const desc = String(text || "").toLowerCase();
  return descriptionHasProtectiveConstraintIntent(desc) || READ_ONLY_VERB_REGEX.test(desc);
}

/**
 * A step that only reads or inspects: it says to read/inspect something and
 * has no write instruction once negated clauses ("without overwriting
 * uncommitted changes") and list nouns ("wallet, save, UI") are set aside.
 * Naming existing files ("Inspect ProjectSettings/ProjectVersion.txt") does not
 * make it a write. A prohibition alone ("Do not modify the file before the
 * wait") is a guardrail, not an inspection.
 */
export function isReadOnlyInspectionStep(text: string): boolean {
  const instructionText = stripNegatedClauses(String(text || "").toLowerCase()).replace(
    LIST_ITEM_WRITE_VERB_REGEX,
    ",",
  );
  const prose = removePathTokens(instructionText);
  return (
    READ_ONLY_VERB_REGEX.test(prose) &&
    !descriptionHasWriteIntent(instructionText) &&
    !descriptionHasScaffoldIntent(prose)
  );
}

export function descriptionHasDiscoveryIntent(text: string): boolean {
  const desc = String(text || "").toLowerCase();
  return (
    (/\b(search|locate|find|discover|identify|inventory|catalog|survey|enumerate|scan|detect)\b/.test(
      desc,
    ) ||
      /\bclarify\s+scope\b/.test(desc)) &&
    !descriptionHasWriteIntent(desc)
  );
}

export function descriptionHasSummaryCue(text: string): boolean {
  const desc = String(text || "").toLowerCase();
  return /\b(compile|finalize|package|bundle|deliver|report|summary|summarize)\b/.test(desc);
}

export function descriptionHasScaffoldIntent(text: string): boolean {
  const desc = String(text || "").toLowerCase();
  return /\b(scaffold|bootstrap|initialize|set up project|setup project|create widget|create project)\b/.test(
    desc,
  );
}

export function descriptionHasArtifactCue(text: string): boolean {
  const desc = String(text || "").toLowerCase();
  return /\b(file|document|docx?|pdf|whitepaper|markdown|csv|xlsx|json|jsonl|txt|pptx|mp4|mov|webm|presentation|slides?|video|clip|footage|spec(?:ification)?|proposal|project|workspace|widget|xcode|scheme|entitlements?|plist|source code|code file)\b/.test(
    desc,
  );
}

export function descriptionHasChecklistReportCue(text: string): boolean {
  const desc = String(text || "").toLowerCase();
  if (!desc.trim()) return false;
  return /\b(checklist|scorecard|qa|audit|report)\b/.test(desc);
}

// A named source file makes a step about code even when it mentions a document
// format ("the PDF export feature in src/export/pdf.ts"). Framework names such
// as "Next.js" are not file targets.
const CODE_SOURCE_TARGET_REGEX =
  /(?:^|[\s`'"(])(?!(?:next|node|nuxt|vue|react|express|three|d3|chart|angular|ember|alpine|solid|socket)\.js\b)[\w./-]*[\w-]\.(?:tsx?|jsx?|mjs|cjs|py|go|rs|java|kt|kts|swift|rb|php|cs|cpp|cc|c|h|hpp|scala|vue|svelte|dart|sh)(?=$|[\s`'"),.;:!?\]])/i;

export function descriptionNamesCodeSourceFile(text: string): boolean {
  return CODE_SOURCE_TARGET_REGEX.test(String(text || ""));
}

export type GeneratedArtifactFormat = "document" | "spreadsheet";

const GENERATED_FORMAT_NOUNS: Record<GeneratedArtifactFormat, string> = {
  document: String.raw`word\s+documents?|docx|pdfs?|[\w./-]*[\w-]\.(?:pdf|docx)`,
  spreadsheet: String.raw`spreadsheets?|excel|xlsx|workbooks?|[\w./-]*[\w-]\.xlsx`,
};
const ARTIFACT_CREATION_VERB = String.raw`(?:create|generate|write|save|produce|export|build|make|draft|prepare|compile|render)`;
const OBJECT_STOP_WORD = String.raw`(?:that|which|to|for|in|into|from|with|of|and|or|as|on|by|at|using|via|about|then)`;
// The format noun is the created object ("a PDF report", "PDF invoices", "an
// Excel workbook") unless it only describes a software component ("the xlsx
// parser", "a PDF export feature", "a PDF viewer").
const NOT_SOFTWARE_COMPONENT_MODIFIER =
  String.raw`(?![\w-])(?!\s+(?:parser|parsing|export(?:er|ing)?(?!\s+of\b)|import(?:er|ing)?|` +
  String.raw`feature|button|viewer|preview|reader|writer|library|lib|module|component|endpoint|` +
  String.raw`api|support|generat(?:or|ion)|handler|service|function|method|class|plugin|` +
  String.raw`integration|convert(?:er|ion)|render(?:er|ing)|engine|util(?:ity|ities)?|helper|` +
  String.raw`pipeline|logic|tests?)\b)`;

/**
 * True when a document/spreadsheet format is the object being created ("create
 * a PDF report", "export the results to Excel"), not a modifier of a code object
 * ("make the xlsx parser handle merged cells") or an input ("read the PDF spec").
 */
export function descriptionCreatesFormatArtifact(
  text: string,
  format: GeneratedArtifactFormat,
): boolean {
  const desc = String(text || "").toLowerCase();
  const noun = GENERATED_FORMAT_NOUNS[format];
  const createdObject = new RegExp(
    String.raw`\b${ARTIFACT_CREATION_VERB}\s+(?:(?:a|an|the|new|final|single|separate|one|\d+)\s+)*` +
      String.raw`(?:(?!${OBJECT_STOP_WORD}\b)[\w'-]+\s+){0,3}?(?:${noun})${NOT_SOFTWARE_COMPONENT_MODIFIER}`,
  );
  const convertedInto = new RegExp(
    String.raw`\b(?:export|save|convert|output|render|write|turn|transform|compile)\b` +
      String.raw`(?:(?!\b(?:that|which)\b)[^.;!?\n]){0,60}?\b(?:to|as|into)\s+` +
      String.raw`(?:(?:a|an|the|new|final|single)\s+)*(?:${noun})(?![\w-])`,
  );
  return createdObject.test(desc) || convertedInto.test(desc);
}

export function deriveStepContractMode(opts: {
  description: string;
  requiresMutation: boolean;
  requiresArtifactEvidence: boolean;
  requiresWriteByArtifactMode: boolean;
  hasReadOnlyConstraint?: boolean;
}): {
  mode: StepContractMode;
  enforcementLevel: StepContractEnforcementLevel;
  contractReason: string;
} {
  const desc = String(opts.description || "");

  // When the task has an explicit read-only constraint (e.g. "do not edit files"),
  // downgrade all enforcement to advisory — the step should not fail for missing mutations.
  // Note: we only check the task-level flag, NOT descriptionHasReadOnlyIntent() —
  // a step like "research trends" describes read-only activities but the task may still
  // need file output.
  if (opts.hasReadOnlyConstraint) {
    return {
      mode: "analysis_only",
      enforcementLevel: "advisory",
      contractReason: "readonly_constraint_detected",
    };
  }

  if (opts.requiresMutation || opts.requiresWriteByArtifactMode) {
    return {
      mode: "mutation_required",
      enforcementLevel: "strict",
      contractReason: "step_requires_artifact_mutation",
    };
  }

  if (opts.requiresArtifactEvidence) {
    const summaryLike = descriptionHasSummaryCue(desc);
    return {
      mode: "artifact_presence_required",
      enforcementLevel: summaryLike ? "standard" : "strict",
      contractReason: summaryLike
        ? "step_requires_artifact_presence_for_summary"
        : "step_requires_artifact_presence",
    };
  }

  return {
    mode: "analysis_only",
    enforcementLevel: "standard",
    contractReason: "analysis_or_readonly_step",
  };
}
