import type { LLMMessage } from "./types";

/**
 * Claude Opus/Sonnet 4.6+ and every 5.x model reject a request whose last
 * message is an assistant turn ("assistant prefill") with HTTP 400. Older
 * models (Haiku 4.5, Sonnet/Opus 4.5 and earlier) still accept it. Matches
 * first-party, Bedrock/Vertex-style (`anthropic.claude-...`) and dotted
 * gateway ids (`anthropic/claude-opus-4.6`).
 */
const PREFILL_REJECTING_CLAUDE_MODEL =
  /claude-(?:opus|sonnet|haiku|fable|mythos)-(?:4[-.][6-9]|[5-9])(?![0-9])/i;

export const ASSISTANT_PREFILL_CONTINUE_PROMPT =
  "Continue exactly where your previous message stopped. Do not repeat what you already wrote.";

export function modelRejectsAssistantPrefill(modelId: string): boolean {
  return PREFILL_REJECTING_CLAUDE_MODEL.test(String(modelId || ""));
}

/**
 * Defensive guard for Anthropic-format adapters: if a caller still ends the
 * transcript with an assistant turn for a model that rejects prefill, append a
 * user turn asking the model to continue instead of sending a request that is
 * guaranteed to fail. A trailing turn with tool calls is left alone; it needs
 * tool results, not a text nudge.
 */
export function ensureNoTrailingAssistantPrefill(
  messages: LLMMessage[],
  modelId: string,
): LLMMessage[] {
  const last = messages[messages.length - 1];
  if (!last || last.role !== "assistant" || !modelRejectsAssistantPrefill(modelId)) {
    return messages;
  }
  if (Array.isArray(last.content) && last.content.some((block) => block?.type === "tool_use")) {
    return messages;
  }
  return [
    ...messages,
    { role: "user", content: [{ type: "text", text: ASSISTANT_PREFILL_CONTINUE_PROMPT }] },
  ];
}
