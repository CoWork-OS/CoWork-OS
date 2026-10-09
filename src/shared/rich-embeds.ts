/**
 * Rich embeds in assistant messages (`::frame{…}` with an html fence, `::html{…}`,
 * `<rich-frame …>`, `::video{…}` and html fences that look like a page): the desktop chat
 * renders them, but everywhere else (channel gateways, the CLI, notifications, the tray,
 * search) they would show as markup. This turns each into one readable line. The rules for
 * what counts as an embed match AssistantMessageContent, which uses the same helpers.
 */

const HTML_FENCE_START_REGEX = /^\s*```(?:html|HTML)\s*$/;
const ANY_FENCE_START_REGEX = /^\s*```/;
const FENCE_END_REGEX = /^\s*```\s*$/;
const VIDEO_DIRECTIVE_LINE_REGEX = /^\s*::video\{(.+)\}\s*$/;
const HTML_DIRECTIVE_LINE_REGEX = /^\s*::html\{(.+)\}\s*$/;
const FRAME_DIRECTIVE_LINE_REGEX = /^\s*::frame\{(.+)\}\s*$/;
const RICH_FRAME_TAG_LINE_REGEX = /^\s*<rich-frame\b([^>]{0,2000})>(?:\s*<\/rich-frame>)?\s*$/i;
const RICH_FRAME_CLOSE_LINE_REGEX = /^\s*<\/rich-frame>\s*$/i;
const DIRECTIVE_ATTR_REGEX = /(\w+)\s*=\s*("(?:[^"\\]|\\.)*"|true|false)/g;
const HTML_ATTR_REGEX =
  /([a-z][a-z0-9_-]*)\s*=\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s"'=<>`]+)/gi;

const INTERACTIVE_NOTE = "interactive; open this answer in CoWork to use it";

/** An html fence the chat renders as a page (a form, or a full document), not as code. */
export function looksLikeRenderableHtml(html: string): boolean {
  const trimmed = html.trim();
  if (trimmed.length < 80) return false;
  if (
    !/<(?:!doctype|html|head|body|form|style|script|input|textarea|select|button)\b/i.test(trimmed)
  ) {
    return false;
  }
  return /<(?:form|input|textarea|select|button)\b/i.test(trimmed) || /<html\b/i.test(trimmed);
}

function plainTagText(value: string | undefined): string | undefined {
  const text = value
    ?.replace(/<[^>]{0,2000}>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return text || undefined;
}

/** The page's <title>, else its first <h1>. */
export function getRenderableHtmlTitle(html: string): string | undefined {
  const title = html.match(/<title\b[^>]{0,2000}>([\s\S]{0,2000}?)<\/title>/i)?.[1];
  const heading = html.match(/<h1\b[^>]{0,2000}>([\s\S]{0,2000}?)<\/h1>/i)?.[1];
  return plainTagText(title) ?? plainTagText(heading);
}

function unquote(value: string): string {
  if (value.length >= 2 && (value.startsWith('"') || value.startsWith("'"))) {
    return value.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return value;
}

function directiveAttrs(source: string, pattern: RegExp): Record<string, string> {
  const attrs: Record<string, string> = {};
  pattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(source)) !== null) attrs[match[1].toLowerCase()] = unquote(match[2]);
  return attrs;
}

function baseName(filePath: string): string {
  return filePath.split(/[\\/]/).filter(Boolean).pop() || filePath;
}

/** The html fence starting at or after `start` (blank lines allowed), if it is closed. */
function htmlFenceAfter(lines: string[], start: number): { html: string; end: number } | null {
  let index = start;
  while (index < lines.length && lines[index].trim() === "") index += 1;
  if (index >= lines.length || !HTML_FENCE_START_REGEX.test(lines[index])) return null;
  let end = index + 1;
  while (end < lines.length && !FENCE_END_REGEX.test(lines[end])) end += 1;
  if (end >= lines.length) return null;
  return { html: lines.slice(index + 1, end).join("\n"), end };
}

function fileEmbedLine(title: string | undefined, filePath: string): string {
  return `**${title || baseName(filePath)}** (${filePath}; open this answer in CoWork to view it)`;
}

/**
 * Replaces rich embeds with one readable line each. Other fenced code, including code
 * that only mentions a directive, is left exactly as written.
 */
export function richEmbedsToPlainText(message: string): string {
  const text = String(message || "");
  if (!/::(?:frame|html|video)\{|<rich-frame\b|```html/i.test(text)) return text;
  const lines = text.split("\n");
  const out: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    if (HTML_FENCE_START_REGEX.test(line)) {
      const fence = htmlFenceAfter(lines, index);
      if (fence && looksLikeRenderableHtml(fence.html)) {
        out.push(
          `**${getRenderableHtmlTitle(fence.html) || "Interactive page"}** (${INTERACTIVE_NOTE})`,
        );
        index = fence.end;
        continue;
      }
    }

    // Other fences (code samples) pass through untouched, directives inside included.
    if (ANY_FENCE_START_REGEX.test(line)) {
      out.push(line);
      let end = index + 1;
      while (end < lines.length && !FENCE_END_REGEX.test(lines[end])) {
        out.push(lines[end]);
        end += 1;
      }
      if (end < lines.length) out.push(lines[end]);
      index = end;
      continue;
    }

    const frame = line.match(FRAME_DIRECTIVE_LINE_REGEX);
    if (frame) {
      const attrs = directiveAttrs(frame[1], DIRECTIVE_ATTR_REGEX);
      const fence = htmlFenceAfter(lines, index + 1);
      if (fence) {
        const title = attrs.title || getRenderableHtmlTitle(fence.html) || "Interactive view";
        out.push(`**${title}** (${INTERACTIVE_NOTE})`);
        index = fence.end;
        continue;
      }
      if (attrs.path) {
        out.push(fileEmbedLine(attrs.title, attrs.path));
        continue;
      }
    }

    const html = line.match(HTML_DIRECTIVE_LINE_REGEX);
    if (html) {
      const attrs = directiveAttrs(html[1], DIRECTIVE_ATTR_REGEX);
      if (attrs.path) {
        out.push(fileEmbedLine(attrs.title, attrs.path));
        continue;
      }
    }

    const richFrame = line.match(RICH_FRAME_TAG_LINE_REGEX);
    if (richFrame) {
      const attrs = directiveAttrs(richFrame[1] || "", HTML_ATTR_REGEX);
      const filePath = attrs.path || attrs.src;
      if (filePath) {
        out.push(fileEmbedLine(attrs.title, filePath));
        if (index + 1 < lines.length && RICH_FRAME_CLOSE_LINE_REGEX.test(lines[index + 1])) {
          index += 1;
        }
        continue;
      }
    }

    const video = line.match(VIDEO_DIRECTIVE_LINE_REGEX);
    if (video) {
      const attrs = directiveAttrs(video[1], DIRECTIVE_ATTR_REGEX);
      if (attrs.path) {
        out.push(`Video: ${attrs.title || baseName(attrs.path)} (${attrs.path})`);
        continue;
      }
    }

    out.push(line);
  }
  return out.join("\n");
}
