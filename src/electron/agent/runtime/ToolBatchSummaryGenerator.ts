import type { LLMToolResult } from "../llm/types";
import { LLMProviderFactory } from "../llm/provider-factory";
import type { ToolScheduleCallReport } from "./ToolScheduler";

export interface ToolBatchSummaryInput {
  phase: "step" | "follow_up" | "verification" | "delegation" | "team";
  callReports: ToolScheduleCallReport[];
  assistantIntent?: string;
  disableModel?: boolean;
}

export interface ToolBatchSummaryResult {
  semanticSummary: string;
  source: "model" | "fallback";
}

function compactText(value: unknown, maxLength = 120): string {
  const text = typeof value === "string" ? value.trim().replace(/\s+/g, " ") : "";
  if (!text) return "";
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength - 1).trimEnd()}…`;
}

function describeToolResult(toolResult: LLMToolResult): string {
  const content = compactText(toolResult.content, 80);
  if (!content) return "";
  return content;
}

function looksStructured(value: string): boolean {
  const text = value.trim();
  if (!text) return false;
  if (/^[\[{]/.test(text)) return true;
  if (/^[A-Za-z0-9_]+\s*\{/.test(text)) return true;
  if (/[{[]\s*[A-Za-z0-9_"']+\s*:/.test(text)) return true;
  return false;
}

function titleCase(value: string): string {
  return value
    .split(/\s+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1).toLowerCase())
    .join(" ");
}

function normalizeLabel(text: string): string {
  const trimmed = compactText(text, 80).replace(/^[\s\-–—:]+|[\s\-–—:]+$/g, "");
  if (!trimmed) return "";
  const cleaned = trimmed
    .replace(/[`"'*_]+/g, "")
    .replace(/\s+/g, " ")
    .replace(/\.$/, "")
    .trim();
  if (!cleaned) return "";
  return titleCase(cleaned.slice(0, 64));
}

function normalizeToolKey(value: string): string {
  return String(value || "").trim().toLowerCase();
}

function buildIntentLabel(intent: string): string {
  const compact = compactText(intent, 160)
    .replace(/^["'`]+|["'`]+$/g, "")
    .replace(/^(?:i(?:'m| am|’m)|we(?:'re| are|’re))\s+/i, "")
    .trim();
  if (!compact) return "";

  const firstClause = compact.split(/[.!?]/, 1)[0]?.trim() || compact;
  const shortened = firstClause.replace(/\s+(?:because|while|when|so|if|for|to)\b.*$/i, "").trim();
  const candidate = normalizeLabel(shortened);
  if (!candidate) return "";

  const wordCount = candidate.split(/\s+/).filter(Boolean).length;
  const isNarrative =
    /^(?:Found|Checking|Looking|Trying|Verifying)\b/i.test(candidate) && wordCount > 2;
  if (wordCount > 6 || isNarrative) return "";

  return candidate;
}

function inferBatchFamilyLabel(toolNames: string[]): string {
  const normalized = toolNames.map(normalizeToolKey).filter(Boolean);
  if (normalized.length === 0) return "";

  const everyIn = (set: ReadonlySet<string>) => normalized.every((name) => set.has(name));
  const anyIn = (set: ReadonlySet<string>) => normalized.some((name) => set.has(name));

  const workspaceInspectionTools = new Set([
    "read_file",
    "list_directory",
    "glob",
    "get_file_info",
    "system_info",
    "parse_document",
    "read_pdf_visual",
  ]);
  const historyTools = new Set([
    "task_history",
    "task_events",
    "search_sessions",
    "task_list_list",
  ]);
  const webResearchTools = new Set([
    "web_fetch",
    "web_search",
    "http_request",
    "browser_navigate",
    "browser_snapshot",
  ]);
  const codeSearchTools = new Set([
    "search_files",
    "grep",
    "rg_search",
    "glob",
  ]);
  const fileWriteTools = new Set([
    "write_file",
    "edit_file",
    "create_document",
    "generate_document",
    "compile_latex",
    "create_spreadsheet",
    "generate_spreadsheet",
    "create_presentation",
    "generate_presentation",
  ]);

  if (anyIn(historyTools)) return "Check Task History";
  if (everyIn(workspaceInspectionTools)) return "Inspect Workspace";
  if (everyIn(webResearchTools)) return "Research Sources";
  if (everyIn(codeSearchTools)) return "Search Code";
  if (anyIn(fileWriteTools)) return "Update Files";

  return "";
}

function shouldForceFamilyLabel(toolName: string): boolean {
  return new Set(["task_history", "task_events", "search_sessions", "task_list_list"]).has(
    normalizeToolKey(toolName),
  );
}

function describeToolInput(toolInput: unknown): string {
  if (!toolInput || typeof toolInput !== "object" || Array.isArray(toolInput)) return "";

  const detailKeys = [
    "path",
    "file",
    "filename",
    "query",
    "pattern",
    "url",
    "command",
    "prompt",
    "title",
    "name",
  ] as const;

  for (const key of detailKeys) {
    const value = (toolInput as Record<string, unknown>)[key];
    const detail = compactText(value, 48);
    if (detail && !looksStructured(detail)) return detail;
  }

  return "";
}

function buildDeterministicLabel(input: ToolBatchSummaryInput): string {
  const toolNames = input.callReports.map((report) => report.effectiveToolName || report.call.toolUse.name);
  const firstTool = toolNames[0] || "tool";
  const plural = toolNames.length > 1 ? "s" : "";
  const readableTool = firstTool
    .replace(/^read_/, "read ")
    .replace(/^write_/, "write ")
    .replace(/^edit_/, "edit ")
    .replace(/^list_/, "list ")
    .replace(/^get_/, "get ")
    .replace(/^search_/, "search ")
    .replace(/^browser_/, "browser ")
    .replace(/^web_/, "web ")
    .replace(/_/g, " ");
  if (toolNames.length === 1) {
    const report = input.callReports[0];
    const familyLabel = inferBatchFamilyLabel(toolNames);
    if (familyLabel && shouldForceFamilyLabel(firstTool)) return familyLabel;

    const inputDetail = describeToolInput(report.call.toolUse.input);
    if (inputDetail) {
      const detail = normalizeLabel(`${readableTool} ${inputDetail}`);
      if (detail) return detail;
    }

    const outputDetail = describeToolResult(report.toolResult);
    if (outputDetail && !looksStructured(outputDetail)) {
      const detail = normalizeLabel(`${readableTool} ${outputDetail}`);
      if (detail) return detail;
    }

    return titleCase(readableTool);
  }
  if (input.assistantIntent) {
    const intent = buildIntentLabel(input.assistantIntent);
    if (intent) return intent;
  }
  const familyLabel = inferBatchFamilyLabel(toolNames);
  if (familyLabel) return familyLabel;
  return titleCase(`${readableTool} batch${plural}`.trim());
}

function getSummaryPrompt(input: ToolBatchSummaryInput): string {
  const toolLines = input.callReports.map((report, index) => {
    const inputText = compactText(JSON.stringify(report.call.toolUse.input || {}), 160);
    const outputText = describeToolResult(report.toolResult);
    return [
      `${index + 1}. ${report.effectiveToolName || report.call.toolUse.name}`,
      inputText ? `   input: ${inputText}` : "",
      outputText ? `   output: ${outputText}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  });
  return [
    "You label completed tool batches for a timeline UI.",
    "Return only a short label of 2-6 words.",
    "Prefer an action-oriented phrase such as 'Read auth config' or 'Ran failing tests'.",
    "Do not use punctuation, quotes, bullets, or explanations.",
    "",
    `Phase: ${input.phase}`,
    ...(input.assistantIntent ? [`Assistant intent: ${compactText(input.assistantIntent, 240)}`] : []),
    "",
    "Completed tools:",
    ...toolLines,
  ].join("\n");
}

export class ToolBatchSummaryGenerator {
  async generateSummary(input: ToolBatchSummaryInput): Promise<ToolBatchSummaryResult> {
    const fallback = buildDeterministicLabel(input);
    if (input.disableModel || input.callReports.length <= 1) {
      return {
        semanticSummary: fallback,
        source: "fallback",
      };
    }

    try {
      const provider = LLMProviderFactory.createProvider({
        type: LLMProviderFactory.loadSettings().providerType,
      });
      const selection = LLMProviderFactory.resolveTaskModelSelection(
        { llmProfile: "cheap" },
        { forceProfile: "cheap" },
      );
      const response = await provider.createMessage({
        model: selection.modelId,
        maxTokens: 32,
        system: "You label completed tool batches with short, timeline-friendly phrases.",
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: getSummaryPrompt(input) }],
          },
        ],
      });
      const text = response.content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("\n")
        .trim();
      const label = normalizeLabel(text);
      if (label) {
        return {
          semanticSummary: label,
          source: "model",
        };
      }
    } catch {
      // best-effort fallback
    }

    return {
      semanticSummary: fallback,
      source: "fallback",
    };
  }
}

export function createToolBatchSummaryGenerator(): ToolBatchSummaryGenerator {
  return new ToolBatchSummaryGenerator();
}
