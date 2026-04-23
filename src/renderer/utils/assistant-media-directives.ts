export type AssistantMediaDirective = {
  type: "video" | "html";
  path: string;
};

const VIDEO_DIRECTIVE_LINE_REGEX = /^\s*::video\{(.+)\}\s*$/;
const HTML_DIRECTIVE_LINE_REGEX = /^\s*::html\{(.+)\}\s*$/;
const DIRECTIVE_ATTR_REGEX = /(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|true|false)/g;

function decodeQuotedValue(value: string): string {
  if (!value.startsWith("\"") || !value.endsWith("\"")) return value;
  return value.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\");
}

function parseDirectiveLine(
  line: string,
  type: AssistantMediaDirective["type"],
): AssistantMediaDirective | null {
  const matcher = type === "video" ? VIDEO_DIRECTIVE_LINE_REGEX : HTML_DIRECTIVE_LINE_REGEX;
  const match = line.match(matcher);
  if (!match) return null;

  const attrs = match[1];
  const parsed: Record<string, unknown> = {};
  let attrMatch: RegExpExecArray | null;

  DIRECTIVE_ATTR_REGEX.lastIndex = 0;
  while ((attrMatch = DIRECTIVE_ATTR_REGEX.exec(attrs)) !== null) {
    const key = attrMatch[1];
    const rawValue = attrMatch[2];
    parsed[key] =
      rawValue === "true" || rawValue === "false"
        ? rawValue === "true"
        : decodeQuotedValue(rawValue);
  }

  const unmatched = attrs.replace(DIRECTIVE_ATTR_REGEX, "").trim();
  if (unmatched.length > 0) return null;

  if (typeof parsed.path !== "string" || parsed.path.trim().length === 0) {
    return null;
  }

  return {
    type,
    path: parsed.path.trim(),
  };
}

export function extractAssistantMediaDirectives(message: string): AssistantMediaDirective[] {
  const directives: AssistantMediaDirective[] = [];
  const lines = String(message || "").split("\n");

  for (const line of lines) {
    if (line.trimStart().startsWith("::video{")) {
      const parsed = parseDirectiveLine(line, "video");
      if (parsed) directives.push(parsed);
      continue;
    }
    if (line.trimStart().startsWith("::html{")) {
      const parsed = parseDirectiveLine(line, "html");
      if (parsed) directives.push(parsed);
    }
  }

  return directives;
}

export function hasAssistantMediaDirective(message: string): boolean {
  return extractAssistantMediaDirectives(message).length > 0;
}
