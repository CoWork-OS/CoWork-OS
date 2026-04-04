export interface ApprovalCommandPreview {
  text: string;
  truncated: boolean;
}

interface ApprovalCommandPreviewOptions {
  maxLines?: number;
  maxChars?: number;
  heredocPreviewLines?: number;
}

const DEFAULT_MAX_LINES = 14;
const DEFAULT_MAX_CHARS = 1400;
const DEFAULT_HEREDOC_PREVIEW_LINES = 5;

function pluralize(count: number, singular: string, plural: string): string {
  return count === 1 ? singular : plural;
}

function collapseHeredocBodies(
  lines: string[],
  heredocPreviewLines: number,
): { lines: string[]; truncated: boolean } {
  const collapsed: string[] = [];
  let truncated = false;

  for (let index = 0; index < lines.length; ) {
    const line = lines[index];
    const markerMatch = line.match(/<<-?\s*(?:'([^'\n]+)'|"([^"\n]+)"|([^\s<>]+))/);
    const marker = markerMatch?.[1] || markerMatch?.[2] || markerMatch?.[3];

    if (!marker) {
      collapsed.push(line);
      index += 1;
      continue;
    }

    let closingIndex = -1;
    for (let searchIndex = index + 1; searchIndex < lines.length; searchIndex += 1) {
      if (lines[searchIndex].trim() === marker) {
        closingIndex = searchIndex;
        break;
      }
    }

    if (closingIndex === -1) {
      collapsed.push(line);
      index += 1;
      continue;
    }

    const bodyLines = lines.slice(index + 1, closingIndex);
    const visibleLines = bodyLines.slice(0, heredocPreviewLines);
    const hiddenLineCount = Math.max(0, bodyLines.length - visibleLines.length);

    collapsed.push(line, ...visibleLines);
    if (hiddenLineCount > 0) {
      truncated = true;
      collapsed.push(
        `[inline content truncated: ${hiddenLineCount} more ${pluralize(hiddenLineCount, "line", "lines")} hidden]`,
      );
    }
    collapsed.push(lines[closingIndex]);
    index = closingIndex + 1;
  }

  return { lines: collapsed, truncated };
}

export function buildApprovalCommandPreview(
  command: string,
  options: ApprovalCommandPreviewOptions = {},
): ApprovalCommandPreview {
  const normalized = command.replace(/\r\n/g, "\n");
  const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
  const maxChars = options.maxChars ?? DEFAULT_MAX_CHARS;
  const heredocPreviewLines = options.heredocPreviewLines ?? DEFAULT_HEREDOC_PREVIEW_LINES;

  const collapsed = collapseHeredocBodies(normalized.split("\n"), heredocPreviewLines);
  let previewLines = collapsed.lines;
  let truncated = collapsed.truncated;

  if (previewLines.length > maxLines) {
    const hiddenLineCount = previewLines.length - maxLines;
    previewLines = [
      ...previewLines.slice(0, maxLines),
      `[preview truncated: ${hiddenLineCount} additional ${pluralize(hiddenLineCount, "line", "lines")} hidden]`,
    ];
    truncated = true;
  }

  let previewText = previewLines.join("\n");
  if (previewText.length > maxChars) {
    const truncatedText = previewText.slice(0, Math.max(0, maxChars - 1)).trimEnd();
    previewText = `${truncatedText}\n[preview truncated for readability]`;
    truncated = true;
  }

  return {
    text: previewText,
    truncated,
  };
}
