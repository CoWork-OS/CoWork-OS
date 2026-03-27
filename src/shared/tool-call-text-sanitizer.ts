export interface ToolCallTextSanitizationResult {
  text: string;
  hadToolCallText: boolean;
  removedSegments: number;
}

const XML_TOOL_PATTERNS: RegExp[] = [
  /<tool_call\b[\s\S]*?<\/tool_call>/gi,
  /<tool_result\b[\s\S]*?<\/tool_result>/gi,
  /<function_call\b[\s\S]*?<\/function_call>/gi,
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
  "\"tool_name\"",
  "\"tool_call\"",
  "[TOOL_CALL]",
  "[/TOOL_CALL]",
  "[TOOL_RESULT]",
  "[/TOOL_RESULT]",
];

const PLAIN_TOOL_TRANSCRIPT_MARKERS = [
  "to=run_command",
  "assistant to=run_command",
  "\"cwd\":",
  "\"timeout_ms\":",
  // Full-width CJK bracket separators appear in raw Claude tool-call streams
  "】【",
  // Generic JSON parameter patterns common across all tools
  "\"pattern\":",
  "\"file_path\":",
  "\"command\":",
  "\"query\":",
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

  if (looksLikePlainToolTranscript(text)) {
    return {
      text: "",
      hadToolCallText: true,
      removedSegments: Math.max(removedSegments, 1),
    };
  }

  text = text
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  return {
    text,
    hadToolCallText: removedSegments > 0,
    removedSegments,
  };
}
