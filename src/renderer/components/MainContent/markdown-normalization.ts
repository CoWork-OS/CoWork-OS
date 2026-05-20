import {
  autolinkBareDomains,
  autolinkBareUrls,
  autolinkUrlsInBrackets,
} from "../../utils/markdown-autolink";
import { sanitizeToolCallTextFromAssistant } from "../../../shared/tool-call-text-sanitizer";
import {
  normalizeInlineLists,
  normalizeInlineHeadings,
  unwrapMarkdownCodeBlocks,
} from "../../utils/markdown-inline-lists";

const FILE_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "csv",
  "tsv",
  "ppt",
  "pptx",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "js",
  "ts",
  "tsx",
  "jsx",
  "css",
  "scss",
  "less",
  "sass",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "cpp",
  "c",
  "h",
  "hpp",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "toml",
  "ini",
  "env",
  "lock",
  "log",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "tiff",
  "mp3",
  "wav",
  "m4a",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "zip",
  "tar",
  "gz",
  "tgz",
  "rar",
  "7z",
]);

const stripHttpScheme = (value: string): string => value.replace(/^https?:\/\//, "");
const HTML_TAG_REGEX = /<[^>]*>/g;
const X_LINK_HOSTS = new Set(["x.com", "twitter.com"]);

export const stripHtmlTags = (value: string): string =>
  String(value || "")
    .replace(HTML_TAG_REGEX, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

export const extractDomainFromUrl = (raw: string): string => {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`);
    return parsed.hostname.replace(/^www\./i, "");
  } catch {
    return stripHttpScheme(trimmed).split("/")[0].replace(/^www\./i, "");
  }
};

export function isXComLink(raw: string): boolean {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return false;

  try {
    const parsed = new URL(
      trimmed.startsWith("http://") || trimmed.startsWith("https://")
        ? trimmed
        : `https://${trimmed}`,
    );
    const hostname = parsed.hostname.replace(/^(?:www\.|mobile\.)/i, "").toLowerCase();
    return X_LINK_HOSTS.has(hostname);
  } catch {
    return false;
  }
}

export const looksLikeLocalFilePath = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("#")) return false;
  if (trimmed.startsWith("file://")) return true;
  if (trimmed.startsWith("mailto:") || trimmed.startsWith("tel:")) return false;
  if (trimmed.includes("://") || trimmed.startsWith("www.")) return false;
  if (trimmed.includes("@")) return false;
  if (
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("/")
  )
    return true;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.includes("/") || trimmed.includes("\\")) return true;
  const extMatch = trimmed.match(/\.([a-zA-Z0-9]{1,8})$/);
  if (!extMatch) return false;
  return FILE_EXTENSIONS.has(extMatch[1].toLowerCase());
};

const GLOB_TOKEN_REGEX = /(?<![`\\])\*\*\/\*[^\s,;()]+/g;
const FENCED_CODE_BLOCK_REGEX = /(```[\s\S]*?```)/g;
const JSON_PATH_PAYLOAD_LINE_REGEX = /^(\s*)\{\s*"path"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}(\s*)$/;
const SOURCES_HEADING_REGEX = /(^|\n)(?:#{1,6}\s*)?sources\b[^\n]*(?:\n|$)/i;
const SOURCE_ENTRY_INLINE_SPLIT_REGEX =
  /\s+(\[\d+\]\s*(?:(?:\[[^\]]+\]\([^)]+\))|https?:\/\/))/gi;
const SOURCE_ENTRY_DETECT_REGEX =
  /\[\d+\]\s*(?:(?:\[[^\]]+\]\([^)]+\))|https?:\/\/\S+)/i;
/** Split pipe-separated sources onto separate lines. */
const SOURCE_PIPE_SEPARATOR_REGEX = /\s*\|\s*/g;
/** Split inline sources: "[1] ... [2] ..." -> one per line (whitespace before [N]). */
const SOURCE_INLINE_BEFORE_NUMBER_REGEX = /\s+(?=\[\d+\])/g;

/** Keep glob-style path patterns literal when rendering markdown. */
function protectGlobTokens(text: string): string {
  return text.replace(GLOB_TOKEN_REGEX, (token) => `\`${token}\``);
}

function transformOutsideFencedCodeBlocks(text: string, transform: (segment: string) => string): string {
  return text
    .split(FENCED_CODE_BLOCK_REGEX)
    .map((segment, index) => (index % 2 === 1 ? segment : transform(segment)))
    .join("");
}

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function escapeMarkdownHref(href: string): string {
  return encodeURI(href).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

export function autolinkJsonPathPayloadLines(text: string): string {
  return transformOutsideFencedCodeBlocks(text, (segment) =>
    segment
      .split("\n")
      .map((line) => {
        const match = line.match(JSON_PATH_PAYLOAD_LINE_REGEX);
        if (!match) return line;

        const [, leadingWhitespace, encodedPath, trailingWhitespace] = match;
        let pathValue: string;
        try {
          pathValue = JSON.parse(`"${encodedPath}"`);
        } catch {
          return line;
        }
        const normalizedPath = pathValue.trim();
        if (!normalizedPath || !looksLikeLocalFilePath(normalizedPath)) return line;

        return `${leadingWhitespace}[${escapeMarkdownLinkText(normalizedPath)}](${escapeMarkdownHref(normalizedPath)})${trailingWhitespace}`;
      })
      .join("\n"),
  );
}

/**
 * In a "Sources" section, force each numbered source entry onto its own line.
 * Handles pipe-separated sources ("[1] ... | [2] ...") and inline sources ("[1] ... [2] ...").
 * Works whether content is on the same line as "Sources:" or on following lines.
 */
export function normalizeSourcesSection(text: string): string {
  const heading = SOURCES_HEADING_REGEX.exec(text);
  if (!heading) return text;

  const headingStart = heading.index + (heading[1] ? heading[1].length : 0);
  const headingMatch = heading[0];
  const headingLineEnd = text.indexOf("\n", headingStart);

  let sectionStart: number;
  let sectionEnd: number;

  if (headingLineEnd === -1) {
    // Content on same line as "Sources:" (e.g. "Sources: [1] ... | [2] ...")
    const sourcesLabelEnd = headingMatch.match(/sources\b[:\s]*/i)?.[0]?.length ?? 0;
    sectionStart = heading.index + sourcesLabelEnd;
    sectionEnd = text.length;
  } else {
    sectionStart = headingLineEnd + 1;
    const remainder = text.slice(sectionStart);
    const nextHeading = /\n#{1,6}\s+\S/.exec(remainder);
    sectionEnd = nextHeading ? sectionStart + nextHeading.index + 1 : text.length;
  }

  const sectionBody = text.slice(sectionStart, sectionEnd);
  const normalizedForDetection = sectionBody
    .replace(SOURCE_PIPE_SEPARATOR_REGEX, "\n")
    .replace(SOURCE_INLINE_BEFORE_NUMBER_REGEX, "\n")
    .trimStart();

  if (
    !SOURCE_ENTRY_DETECT_REGEX.test(normalizedForDetection) &&
    !/\[\d+\]/.test(normalizedForDetection)
  ) {
    return text;
  }

  const normalizedSectionBody = normalizedForDetection
    .replace(SOURCE_ENTRY_INLINE_SPLIT_REGEX, "  \n$1")
    .trimStart();

  return `${text.slice(0, sectionStart)}${normalizedSectionBody}${text.slice(sectionEnd)}`;
}

export function normalizeMarkdownForDisplay(text: string): string {
  const sanitized = sanitizeToolCallTextFromAssistant(text).text;
  const protected_ = protectGlobTokens(sanitized);
  const withJsonPaths = autolinkJsonPathPayloadLines(protected_);
  const withBareUrls = transformOutsideFencedCodeBlocks(withJsonPaths, (seg) =>
    autolinkUrlsInBrackets(autolinkBareDomains(autolinkBareUrls(seg))),
  );
  return normalizeSourcesSection(withBareUrls);
}

export function normalizeTimelineTitleMarkdownForDisplay(text: string): string {
  // Normalize inline headings (### mid-line -> line-start) and lists
  const normalized = normalizeInlineLists(
    normalizeInlineHeadings(normalizeMarkdownForDisplay(text)),
  );
  // Escape only single # so shell comments like "# route check" are not rendered
  // as <h1>. Allow ##, ###, etc. to render as headings.
  return normalized.replace(
    /^( {0,3})(#)(?=\s)/gm,
    (_match: string, indent: string, hash: string) =>
      `${indent}${hash.replace(/#/g, "\\#")}`,
  );
}

export function cleanAssistantMessageForDisplay(message: string): string {
  const sanitized = String(message || "")
    .replace(/\[\[speak\]\]([\s\S]*?)\[\[\/speak\]\]/gi, "$1")
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
    .replace(/<tool_result>[\s\S]*?<\/tool_result>/gi, "")
    .trim();
  return normalizeMarkdownForDisplay(
    normalizeInlineLists(unwrapMarkdownCodeBlocks(sanitized)),
  );
}
