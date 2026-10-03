import type { LLMContent, LLMMessage, LLMTool, LLMToolChoiceMode, LLMToolResult } from "./types";

/**
 * Prompt-described tool protocol for models whose server rejects native tool
 * definitions (Ollama "does not support tools", llama.cpp without --jinja,
 * vLLM without --enable-auto-tool-choice). Tools are described in the system
 * prompt, the model answers with `<tool_call>` blocks that the text tool-call
 * parser turns into tool_use blocks, and earlier calls and results are replayed
 * as plain text because such servers cannot render native tool messages.
 */

/** Set to 0/false/off to disable text tool-call recovery for every provider. */
export const TEXT_TOOL_CALL_FALLBACK_ENV = "COWORK_TEXT_TOOL_CALL_FALLBACK";

/**
 * First-party cloud APIs return structured tool calls reliably; text that looks
 * like a call from them is far more likely to be quoted content than a call.
 */
const FIRST_PARTY_CLOUD_PROVIDERS = new Set([
  "anthropic",
  "openai",
  "gemini",
  "azure",
  "azure-anthropic",
  "bedrock",
]);

/** Adapters that serve local or self-hosted open-weight models. */
const LOCAL_MODEL_PROVIDERS = new Set([
  "ollama",
  "openai-compatible",
  "mlx",
  "omlx",
  "hf-agents",
  "atomic-chat",
]);

export function isTextToolCallFallbackEnabledByDefault(providerType: string): boolean {
  const configured = String(process.env[TEXT_TOOL_CALL_FALLBACK_ENV] || "")
    .trim()
    .toLowerCase();
  if (["0", "false", "off", "no", "disabled"].includes(configured)) return false;
  const type = String(providerType || "")
    .trim()
    .toLowerCase();
  if (FIRST_PARTY_CLOUD_PROVIDERS.has(type)) return false;
  return LOCAL_MODEL_PROVIDERS.has(type);
}

const NATIVE_TOOLS_UNSUPPORTED_PATTERNS: RegExp[] = [
  // Ollama: "registry.ollama.ai/library/gemma2:2b does not support tools"
  /\b(?:does not|doesn't|do not|don't) support tools\b/i,
  /\btools? (?:are|is) not supported\b/i,
  /\b(?:does not|doesn't) support (?:function|tool)[ _-]?call/i,
  // llama.cpp server started without a tool-capable template
  /\btools param requires --jinja\b/i,
  // vLLM started without a tool-call parser
  /--enable-auto-tool-choice\b/i,
];

/** The server refused the request because the model cannot take native tools. */
export function isNativeToolsUnsupportedError(
  status: number | undefined,
  message: string | undefined,
): boolean {
  if (typeof status === "number" && status < 400) return false;
  const text = String(message || "");
  return NATIVE_TOOLS_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(text));
}

const nativeToolsUnsupported = new Set<string>();

export function nativeToolSupportKey(
  providerType: string,
  endpoint: string,
  model: string,
): string {
  return [
    providerType,
    String(endpoint || "").replace(/\/+$/, ""),
    String(model || "").trim(),
  ].join("|");
}

/** Remember for this process that the model rejected native tools. */
export function markNativeToolsUnsupported(key: string): void {
  nativeToolsUnsupported.add(key);
}

export function areNativeToolsUnsupported(key: string): boolean {
  return nativeToolsUnsupported.has(key);
}

export function clearNativeToolSupportCacheForTests(): void {
  nativeToolsUnsupported.clear();
}

const MAX_DESCRIPTION_CHARS = 200;
const MAX_OPTIONAL_ARGUMENTS = 8;

function firstSentence(description: string): string {
  const collapsed = String(description || "")
    .replace(/\s+/g, " ")
    .trim();
  const sentence = collapsed.match(/^.*?[.!?](?=\s|$)/)?.[0] ?? collapsed;
  return sentence.length > MAX_DESCRIPTION_CHARS
    ? `${sentence.slice(0, MAX_DESCRIPTION_CHARS - 3).trimEnd()}...`
    : sentence;
}

function describeType(schema: unknown): string {
  if (!schema || typeof schema !== "object") return "any";
  const record = schema as Record<string, unknown>;
  if (Array.isArray(record.enum) && record.enum.length > 0 && record.enum.length <= 6) {
    return record.enum.map((value) => JSON.stringify(value)).join("|");
  }
  if (typeof record.type === "string") return record.type;
  if (Array.isArray(record.type)) return record.type.filter((t) => typeof t === "string").join("|");
  return "any";
}

function describeArguments(tool: LLMTool): string {
  const properties =
    tool.input_schema?.properties && typeof tool.input_schema.properties === "object"
      ? tool.input_schema.properties
      : {};
  const required = new Set(
    Array.isArray(tool.input_schema?.required) ? tool.input_schema.required : [],
  );
  const requiredParts = [...required].map(
    (name) => `${JSON.stringify(name)}: ${describeType(properties[name])} (required)`,
  );
  const optionalNames = Object.keys(properties).filter((name) => !required.has(name));
  const optionalParts = optionalNames
    .slice(0, MAX_OPTIONAL_ARGUMENTS)
    .map((name) => `${JSON.stringify(name)}: ${describeType(properties[name])}`);
  if (optionalNames.length > MAX_OPTIONAL_ARGUMENTS) {
    optionalParts.push(`...${optionalNames.length - MAX_OPTIONAL_ARGUMENTS} more optional`);
  }
  return `{${[...requiredParts, ...optionalParts].join(", ")}}`;
}

/** Compact system-prompt addendum describing the tools and the call format. */
export function buildTextToolProtocolInstructions(tools: LLMTool[]): string {
  const lines = [
    "# Tool calling",
    "Native function calling is unavailable for this model. To use a tool, write one block per call in exactly this form, with nothing after the last block:",
    '<tool_call>{"name": "<tool name>", "arguments": {<JSON object>}}</tool_call>',
    '- Use only the tools listed below and put every required argument in "arguments".',
    '- After your tool calls, stop. Results arrive in the next user message as <tool_response name="<tool name>">...</tool_response>.',
    "- When no tool is needed, answer normally without any <tool_call> block.",
    "",
    "Available tools:",
    ...tools.map(
      (tool) =>
        `- ${tool.name}: ${firstSentence(tool.description)} Arguments: ${describeArguments(tool)}`,
    ),
  ];
  return lines.join("\n");
}

/** The system prompt with the tool protocol appended when tools may be called. */
export function withTextToolProtocolInstructions(
  system: string,
  tools: LLMTool[] | undefined,
  toolChoice?: LLMToolChoiceMode,
): string {
  if (!tools || tools.length === 0 || toolChoice === "none") return system;
  const instructions = buildTextToolProtocolInstructions(tools);
  return system ? `${system}\n\n${instructions}` : instructions;
}

/**
 * Tool output is untrusted. Escape the protocol's own tags so a result cannot
 * close its envelope early or pose as a call the model then copies.
 */
function neutralizeProtocolTags(text: string): string {
  return text.replace(/<(\/?)(tool_response|tool_call)\b/gi, "&lt;$1$2");
}

function formatToolCall(name: string, input: Record<string, unknown>): string {
  return `<tool_call>${JSON.stringify({ name, arguments: input })}</tool_call>`;
}

function formatToolResponse(name: string, result: LLMToolResult): string {
  const safeName = name.replace(/[^\w.-]/g, "_");
  const error = result.is_error ? ' error="true"' : "";
  return `<tool_response name="${safeName}"${error}>\n${neutralizeProtocolTags(
    String(result.content ?? ""),
  )}\n</tool_response>`;
}

/**
 * Replay tool_use blocks as `<tool_call>` text and tool results as
 * `<tool_response>` user text, for servers that cannot render native tool
 * messages for this model.
 */
export function toTextToolProtocolMessages(messages: LLMMessage[]): LLMMessage[] {
  const toolNames = new Map<string, string>();
  return messages.map((message) => {
    if (typeof message.content === "string") return message;
    const blocks = message.content as Array<LLMContent | LLMToolResult>;
    if (!blocks.some((block) => block.type === "tool_use" || block.type === "tool_result")) {
      return message;
    }
    const content: LLMContent[] = [];
    for (const block of blocks) {
      if (block.type === "tool_use") {
        toolNames.set(block.id, block.name);
        content.push({ type: "text", text: formatToolCall(block.name, block.input) });
      } else if (block.type === "tool_result") {
        const name = toolNames.get(block.tool_use_id) ?? "tool";
        content.push({ type: "text", text: formatToolResponse(name, block) });
        for (const companion of block.companion_user_content ?? []) {
          content.push(
            companion.type === "text"
              ? { type: "text", text: neutralizeProtocolTags(companion.text) }
              : companion,
          );
        }
      } else {
        content.push(block);
      }
    }
    return { ...message, content };
  });
}
