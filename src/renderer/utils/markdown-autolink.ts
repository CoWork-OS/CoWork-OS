import { KNOWN_FILE_EXTENSIONS } from "./file-extensions";

/**
 * Convert bare domains (domain.tld without path) into markdown links.
 * e.g. "learn.microsoft.com" -> "[learn.microsoft.com](https://learn.microsoft.com)"
 * Only matches when not already inside a link or brackets.
 */
const BARE_DOMAIN_REGEX =
  /(?<!\(|\[|\/)(?:^|(?<=\s))((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,})(?=[\s\])|,;:]|$)/gi;
const BARE_URL_REGEX =
  /(?<!\(|\[)(?:^|(?<=\s))((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/[^\s)\]]+)/gi;
const BRACKETED_URL_REGEX =
  /\[(https?:\/\/[^\]\s]+)\](?!\s*\()|\[((?:[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\]\s]*)?)\](?!\s*\()/gi;
const COMMON_BARE_DOMAIN_EXCLUSIONS = new Set(["e.g", "i.e"]);

// File extensions that are also real, commonly linked top-level domains (docs.rs,
// bun.sh). A token ending in one of these is only treated as a file name when it
// carries a file-name hint such as an uppercase letter or an underscore.
const AMBIGUOUS_FILE_EXTENSION_TLDS = new Set(["rs", "sh"]);

// Private-use characters delimit placeholders for protected Markdown spans. They are
// not whitespace, so the autolink lookarounds treat a placeholder like adjacent text.
const PLACEHOLDER_OPEN = "";
const PLACEHOLDER_CLOSE = "";
const PLACEHOLDER_REGEX = /(\d+)/g;

function looksLikeFileName(host: string): boolean {
  const labels = host.split(".");
  const extension = (labels[labels.length - 1] || "").toLowerCase();
  if (!KNOWN_FILE_EXTENSIONS.has(extension)) return false;
  if (!AMBIGUOUS_FILE_EXTENSION_TLDS.has(extension)) return true;
  const stem = labels.slice(0, -1).join(".");
  return /[A-Z_]/.test(stem);
}

function shouldAutolinkBareDomain(domain: string): boolean {
  const normalized = domain.toLowerCase();
  if (COMMON_BARE_DOMAIN_EXCLUSIONS.has(normalized)) return false;
  if (looksLikeFileName(domain)) return false;

  const labels = normalized.split(".").filter(Boolean);
  if (labels.length < 2) return false;

  const firstLabel = labels[0] || "";
  const tld = labels[labels.length - 1] || "";

  if (/^v?\d+$/.test(firstLabel)) return false;
  if (labels.length === 2 && firstLabel.length < 3 && tld.length < 3) return false;

  return true;
}

/** Index just past the bracket that closes the one at `start`, or -1. */
function findClosingBracket(text: string, start: number, open: string, close: string): number {
  let depth = 0;
  for (let index = start; index < text.length; index += 1) {
    const char = text[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "\n" && text[index + 1] === "\n") return -1;
    if (char === open) depth += 1;
    else if (char === close) {
      depth -= 1;
      if (depth === 0) return index + 1;
    }
  }
  return -1;
}

/** End index of an inline link, image, or reference link starting at `start`, or -1. */
function matchMarkdownLinkEnd(text: string, start: number): number {
  const labelStart = text[start] === "!" ? start + 1 : start;
  if (text[labelStart] !== "[") return -1;
  const labelEnd = findClosingBracket(text, labelStart, "[", "]");
  if (labelEnd < 0) return -1;
  const next = text[labelEnd];
  if (next === "(") return findClosingBracket(text, labelEnd, "(", ")");
  if (next === "[") return findClosingBracket(text, labelEnd, "[", "]");
  return -1;
}

/** End index of an inline code span starting at `start`, or -1 when it never closes. */
function matchInlineCodeEnd(text: string, start: number): number {
  let runEnd = start;
  while (text[runEnd] === "`") runEnd += 1;
  const runLength = runEnd - start;
  let search = runEnd;
  while (search < text.length) {
    const closeStart = text.indexOf("`", search);
    if (closeStart < 0) return -1;
    let closeEnd = closeStart;
    while (text[closeEnd] === "`") closeEnd += 1;
    if (closeEnd - closeStart === runLength) return closeEnd;
    search = closeEnd;
  }
  return -1;
}

const FENCE_OPENING_REGEX = / {0,3}(`{3,}|~{3,})[^\n]*/y;
const ANGLE_AUTOLINK_REGEX = /<(?:[a-z][a-z0-9+.-]{1,31}:[^\s<>]*|[^\s<>@]+@[^\s<>]+)>/iy;
const REFERENCE_DEFINITION_REGEX = / {0,3}\[[^\]\n]+\]:[ \t]*\S[^\n]*/y;

/** End index of a sticky `regex` match at `start`, or -1. */
function matchStickyEnd(regex: RegExp, text: string, start: number): number {
  regex.lastIndex = start;
  const match = regex.exec(text);
  return match ? start + match[0].length : -1;
}

/** End index of a fenced code block whose opening fence starts the line at `start`, or -1. */
function matchFencedCodeEnd(text: string, start: number): number {
  FENCE_OPENING_REGEX.lastIndex = start;
  const opening = FENCE_OPENING_REGEX.exec(text);
  if (!opening) return -1;
  const fence = opening[1] || "";
  const infoString = opening[0].slice(opening[0].indexOf(fence) + fence.length);
  if (fence.startsWith("`") && infoString.includes("`")) return -1;
  const bodyStart = start + opening[0].length;
  const closing = new RegExp(`\\n {0,3}${fence[0]}{${fence.length},}[ \\t]*(?=\\n|$)`, "g");
  closing.lastIndex = bodyStart;
  const match = closing.exec(text);
  return match ? match.index + match[0].length : text.length;
}

/**
 * Apply `transform` to the text outside existing Markdown constructs whose contents
 * must stay literal: fenced and inline code, inline links and images (label and
 * target, including nested brackets), reference links and definitions, and
 * angle-bracket autolinks. Protected spans are swapped for placeholders while the
 * transform runs, so the surrounding text keeps its original context.
 */
function transformOutsideProtectedMarkdown(
  text: string,
  transform: (unprotected: string) => string,
): string {
  const spans: string[] = [];
  let output = "";
  let index = 0;
  const protect = (end: number) => {
    spans.push(text.slice(index, end));
    output += `${PLACEHOLDER_OPEN}${spans.length - 1}${PLACEHOLDER_CLOSE}`;
    index = end;
  };

  while (index < text.length) {
    const char = text[index];
    const atLineStart = index === 0 || text[index - 1] === "\n";
    if (atLineStart) {
      const fenceEnd = matchFencedCodeEnd(text, index);
      if (fenceEnd > index) {
        protect(fenceEnd);
        continue;
      }
      const definitionEnd = matchStickyEnd(REFERENCE_DEFINITION_REGEX, text, index);
      if (definitionEnd > index) {
        protect(definitionEnd);
        continue;
      }
    }
    if (char === "\\") {
      output += text.slice(index, index + 2);
      index += 2;
      continue;
    }
    if (char === "`") {
      const codeEnd = matchInlineCodeEnd(text, index);
      if (codeEnd > index) {
        protect(codeEnd);
        continue;
      }
      let runEnd = index;
      while (text[runEnd] === "`") runEnd += 1;
      output += text.slice(index, runEnd);
      index = runEnd;
      continue;
    }
    if (char === "<") {
      const autolinkEnd = matchStickyEnd(ANGLE_AUTOLINK_REGEX, text, index);
      if (autolinkEnd > index) {
        protect(autolinkEnd);
        continue;
      }
    }
    if (char === "[" || (char === "!" && text[index + 1] === "[")) {
      const linkEnd = matchMarkdownLinkEnd(text, index);
      if (linkEnd > index) {
        protect(linkEnd);
        continue;
      }
    }
    output += char;
    index += 1;
  }

  if (spans.length === 0) return transform(text);
  return transform(output).replace(
    PLACEHOLDER_REGEX,
    (match, spanIndex: string) => spans[Number(spanIndex)] ?? match,
  );
}

export function autolinkBareDomains(text: string): string {
  return transformOutsideProtectedMarkdown(text, (segment) =>
    segment.replace(BARE_DOMAIN_REGEX, (_match, domain) => {
      if (!shouldAutolinkBareDomain(domain)) return _match;
      return `[${domain}](https://${domain})`;
    }),
  );
}

export function autolinkBareUrls(text: string): string {
  return transformOutsideProtectedMarkdown(text, (segment) =>
    segment.replace(BARE_URL_REGEX, (_match, url: string) => {
      if (looksLikeFileName(url.split("/")[0] || "")) return _match;
      return `[${url}](https://${url})`;
    }),
  );
}

export function autolinkUrlsInBrackets(text: string): string {
  return transformOutsideProtectedMarkdown(text, (segment) =>
    segment.replace(
      BRACKETED_URL_REGEX,
      (_match, fullUrl: string | undefined, bareDomain: string | undefined) => {
        const url = fullUrl ?? bareDomain;
        if (!url) return _match;
        if (!fullUrl && looksLikeFileName(url.split("/")[0] || "")) return _match;
        const href = url.startsWith("http") ? url : `https://${url}`;
        return `[${url}](${href})`;
      },
    ),
  );
}
