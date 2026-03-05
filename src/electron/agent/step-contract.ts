import * as path from "path";

export type StepContractMode = "mutation_required" | "artifact_presence_required" | "analysis_only";
export type StepContractEnforcementLevel = "strict" | "standard";

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
const CANONICAL_EXTENSIONS_WITH_DOT = CANONICAL_ARTIFACT_EXTENSION_LIST.map((extension) => `.${extension}`);
const CANONICAL_EXTENSION_PATTERN = CANONICAL_ARTIFACT_EXTENSION_LIST
  .map((extension) => extension.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
  .join("|");

export const CANONICAL_ARTIFACT_EXTENSION_REGEX = new RegExp(
  `\\.(${CANONICAL_EXTENSION_PATTERN})\\b`,
  "i",
);
const CANONICAL_ARTIFACT_EXTENSION_REGEX_GLOBAL = new RegExp(
  `\\.(${CANONICAL_EXTENSION_PATTERN})\\b`,
  "gi",
);

export const CANONICAL_ARTIFACT_PATH_REGEX = new RegExp(
  `(?:\\/|\\.{1,2}\\/)?[A-Za-z0-9_./-]+\\.(${CANONICAL_EXTENSION_PATTERN})\\b`,
  "gi",
);

const COMMAND_PREFIX_REGEX =
  /(^|\s)(python3?|node|npm|npx|pnpm|yarn|bash|sh|zsh|git|curl|wget|make|cmake|xcodebuild|uv|pip3?|go|cargo|java|ruby|php|ssh|scp|sftp|ping|traceroute|mtr|nc|netcat|telnet|dig|nslookup|nmap)\b/i;
const SHELL_OPERATOR_REGEX = /(?:\|\||&&|[|;<>])/;
const URL_LIKE_REGEX = /^[a-z][a-z0-9+.-]*:\/\//i;

function normalizeWithLeadingDot(extension: string): string {
  const raw = String(extension || "").trim().toLowerCase();
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
  const normalized = String(text || "").toLowerCase();
  if (!normalized.trim()) return [];

  const extensions = new Set<string>();
  const matches = normalized.match(CANONICAL_ARTIFACT_EXTENSION_REGEX_GLOBAL);
  if (matches) {
    for (const token of matches) {
      const extension = normalizeWithLeadingDot(path.extname(token));
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
  if (/\bjson\b/.test(normalized)) extensions.add(".json");
  if (/\bxlsx\b|\bexcel\b|\bspreadsheet\b/.test(normalized)) extensions.add(".xlsx");
  if (/\bpptx\b|\bslides?\b|\bpowerpoint\b/.test(normalized)) extensions.add(".pptx");
  if (/\bpdf\b/.test(normalized)) extensions.add(".pdf");
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
    if (isArtifactPathLikeToken(value)) {
      candidates.add(value);
    }
    backtickMatch = backtickPattern.exec(source);
  }

  const barePattern = new RegExp(CANONICAL_ARTIFACT_PATH_REGEX.source, "gi");
  let bareMatch = barePattern.exec(source);
  while (bareMatch) {
    const token = String(bareMatch[0] || "").trim();
    const start = bareMatch.index;
    const inCommandSnippet = commandSnippetRanges.some((range) => start >= range.start && start < range.end);
    if (!inCommandSnippet && token) {
      candidates.add(token);
    }
    bareMatch = barePattern.exec(source);
  }

  return Array.from(candidates.values());
}

export function descriptionHasWriteIntent(text: string): boolean {
  const desc = String(text || "").toLowerCase();
  const explicitWriteVerb =
    /\b(write|create|draft|generate|produce|compose|build|save|author|scaffold|bootstrap|initialize|implement|configure|add|edit|update|append|rewrite)\b/.test(
      desc,
    );
  if (explicitWriteVerb) return true;

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

export function descriptionHasReadOnlyIntent(text: string): boolean {
  const desc = String(text || "").toLowerCase();
  return /\b(read|analy[sz]e|review|understand|examine|inspect|check|parse|extract|summarize|study|explore|investigate|look)\b/.test(
    desc,
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
  return /\b(file|document|docx?|pdf|whitepaper|markdown|csv|xlsx|json|jsonl|txt|pptx|presentation|slides?|spec(?:ification)?|proposal|project|workspace|widget|xcode|scheme|entitlements?|plist|source code|code file)\b/.test(
    desc,
  );
}

export function descriptionHasChecklistReportCue(text: string): boolean {
  const desc = String(text || "").toLowerCase();
  if (!desc.trim()) return false;
  return /\b(checklist|scorecard|qa|audit|report)\b/.test(desc);
}

export function deriveStepContractMode(opts: {
  description: string;
  requiresMutation: boolean;
  requiresArtifactEvidence: boolean;
  requiresWriteByArtifactMode: boolean;
}): {
  mode: StepContractMode;
  enforcementLevel: StepContractEnforcementLevel;
  contractReason: string;
} {
  const desc = String(opts.description || "");

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
