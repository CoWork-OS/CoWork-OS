export interface ToolCallTextSanitizationResult {
  text: string;
  hadToolCallText: boolean;
  removedSegments: number;
}

const XML_TOOL_PATTERNS: RegExp[] = [
  /<tool_call\b[\s\S]*?<\/tool_call>/gi,
  /<tool_result\b[\s\S]*?<\/tool_result>/gi,
  /<tool\b[^>]*>[\s\S]*?<\/tool>/gi,
  /<function_call\b[\s\S]*?<\/function_call>/gi,
  /<\/?(?:tool_call|tool_result|tool|function_call)\b[^>]*>/gi,
  /<\/?[a-z0-9_-]+:(?:tool_call|tool_result|tool|function_call)\b[^>]*>/gi,
  /<tool_name>\s*[^<]+<\/tool_name>\s*<parameters>\s*[\s\S]*?<\/parameters>/gi,
  /<tool_name>\s*[^<]+<\/tool_name>/gi,
  /<parameters>\s*[\s\S]*?<\/parameters>/gi,
  /\[TOOL_CALL\][\s\S]*?\[\/TOOL_CALL\]/gi,
  /\[TOOL_RESULT\][\s\S]*?\[\/TOOL_RESULT\]/gi,
];

const TOOL_TEXT_MARKERS = [
  "<tool_name>",
  "</tool_name>",
  "<parameters>",
  "</parameters>",
  "<tool_call>",
  "</tool_call>",
  "<tool_result>",
  "</tool_result>",
  "<tool ",
  "</tool>",
  "\"tool_name\"",
  "\"tool\"",
  "\"tool_call\"",
  "[TOOL_CALL]",
  "[/TOOL_CALL]",
  "[TOOL_RESULT]",
  "[/TOOL_RESULT]",
];

const PLAIN_TOOL_TRANSCRIPT_MARKERS = [
  "to=run_command",
  "to=skill",
  "to=skill_list",
  "assistant to=run_command",
  "assistant to=skill",
  "assistant to=skill_list",
  "\"cwd\":",
  "\"timeout_ms\":",
  // Full-width CJK bracket separators appear in raw Claude tool-call streams
  "】【",
  // Generic JSON parameter patterns common across all tools
  "\"pattern\":",
  "\"file_path\":",
  "\"command\":",
  "\"query\":",
  "\"tool\":",
  "\"input\":",
  "\"arguments\":",
];

const INLINE_TOOL_JSON_PATTERNS: RegExp[] = [
  /\{\s*"id"\s*:\s*"call_[^"]+"\s*,\s*"tool"\s*:\s*"[^"]+"\s*,\s*"input"\s*:\s*\{[\s\S]*?\}\s*\}/gi,
  /\{\s*"tool_name"\s*:\s*"[^"]+"\s*,\s*"arguments"\s*:\s*"(?:\\.|[^"])*"\s*\}/gi,
];

function looksLikePlainToolTranscript(input: string): boolean {
  const lower = input.toLowerCase();
  const hasTranscriptLead =
    /\b(?:assistant\s+)?to=[a-z_][\w-]*\b/i.test(input) || lower.includes("to=run_command");
  if (!hasTranscriptLead) return false;
  // One marker is sufficient when paired with a clear to=[tool] lead
  const markerHits = PLAIN_TOOL_TRANSCRIPT_MARKERS.filter((marker) => lower.includes(marker)).length;
  return markerHits >= 1;
}

function stripFencedToolBlocks(input: string): { text: string; removed: number } {
  let removed = 0;
  const text = input.replace(/```[\s\S]*?```/g, (block) => {
    const lower = block.toLowerCase();
    const looksLikeToolCall = TOOL_TEXT_MARKERS.some((marker) => lower.includes(marker));
    if (!looksLikeToolCall) return block;
    removed += 1;
    return "";
  });

  return { text, removed };
}

function looksLikePlainToolTranscriptLine(line: string): boolean {
  const trimmed = line.trim();
  if (!trimmed) return false;

  const transcriptLeadMatch = trimmed.match(/\b(?:assistant\s+)?to=[a-z_][\w-]*\b/i);
  if (!transcriptLeadMatch) return false;
  if (trimmed.indexOf("{", transcriptLeadMatch.index || 0) !== -1) {
    return false;
  }

  const lower = trimmed.toLowerCase();
  return PLAIN_TOOL_TRANSCRIPT_MARKERS.some((marker) => lower.includes(marker));
}

function stripLeadingPlainToolTranscriptLines(input: string): { text: string; removed: number } {
  const lines = input.split(/\r?\n/);
  let startIndex = 0;

  while (startIndex < lines.length && looksLikePlainToolTranscriptLine(lines[startIndex])) {
    startIndex += 1;
  }

  if (startIndex === 0) {
    return { text: input, removed: 0 };
  }

  return {
    text: lines.slice(startIndex).join("\n").trimStart(),
    removed: startIndex,
  };
}

function stripLeadingPlainToolTranscriptPrefix(input: string): { text: string; removed: number } {
  const source = String(input || "");
  const firstLineBreak = source.search(/\r?\n/);
  const firstLine = firstLineBreak === -1 ? source : source.slice(0, firstLineBreak);
  const rest = firstLineBreak === -1 ? "" : source.slice(firstLineBreak);

  const transcriptLeadMatch = firstLine.match(/\b(?:assistant\s+)?to=[a-z_][\w-]*\b/i);
  if (!transcriptLeadMatch) {
    return { text: source, removed: 0 };
  }

  const jsonStart = firstLine.indexOf("{", transcriptLeadMatch.index || 0);
  if (jsonStart === -1) {
    return { text: source, removed: 0 };
  }

  const prefix = firstLine.slice(0, jsonStart);
  if (!prefix.trim()) {
    return { text: source, removed: 0 };
  }

  return {
    text: `${firstLine.slice(jsonStart)}${rest}`.trimStart(),
    removed: 1,
  };
}

function stripEmptyObjectThenInlineTranscriptPrefix(input: string): { text: string; removed: number } {
  const lines = input.split(/\r?\n/);
  if (lines.length < 2) {
    return { text: input, removed: 0 };
  }

  const firstLine = lines[0].trim();
  if (firstLine !== "{}" && firstLine !== "[]") {
    return { text: input, removed: 0 };
  }

  const secondLine = lines[1];
  const transcriptLeadMatch = secondLine.match(/\b(?:assistant\s+)?to=[a-z_][\w-]*\b/i);
  if (!transcriptLeadMatch) {
    return { text: input, removed: 0 };
  }

  const jsonStart = secondLine.indexOf("{", transcriptLeadMatch.index || 0);
  if (jsonStart === -1) {
    return { text: input, removed: 0 };
  }

  const tail = [secondLine.slice(jsonStart), ...lines.slice(2)].join("\n").trimStart();
  return {
    text: tail,
    removed: 1,
  };
}

export function sanitizeToolCallTextFromAssistant(raw: string): ToolCallTextSanitizationResult {
  const input = String(raw || "");
  if (!input.trim()) {
    return { text: "", hadToolCallText: false, removedSegments: 0 };
  }

  let text = input;
  let removedSegments = 0;

  const fenced = stripFencedToolBlocks(text);
  text = fenced.text;
  removedSegments += fenced.removed;

  for (const pattern of XML_TOOL_PATTERNS) {
    text = text.replace(pattern, (match) => {
      if (match.trim().length > 0) {
        removedSegments += 1;
      }
      return "";
    });
  }

  for (const pattern of INLINE_TOOL_JSON_PATTERNS) {
    text = text.replace(pattern, (match) => {
      if (match.trim().length > 0) {
        removedSegments += 1;
      }
      return "";
    });
  }

  const strippedTranscript = stripLeadingPlainToolTranscriptLines(text);
  text = strippedTranscript.text;
  removedSegments += strippedTranscript.removed;

  const strippedPrefix = stripLeadingPlainToolTranscriptPrefix(text);
  text = strippedPrefix.text;
  removedSegments += strippedPrefix.removed;

  const strippedEmptyObject = stripEmptyObjectThenInlineTranscriptPrefix(text);
  text = strippedEmptyObject.text;
  removedSegments += strippedEmptyObject.removed;

  if (looksLikePlainToolTranscript(text)) {
    return {
      text: "",
      hadToolCallText: true,
      removedSegments: Math.max(removedSegments, 1),
    };
  }

  text = text
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+(?=[{[])/g, "\n")
    .trim();

  return {
    text,
    hadToolCallText: removedSegments > 0,
    removedSegments,
  };
}
