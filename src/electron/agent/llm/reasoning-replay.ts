import type { LLMMessage, LLMReasoningItem } from "./types";

/**
 * Reasoning replay.
 *
 * Reasoning models return opaque reasoning state (OpenAI Responses `reasoning` items with
 * `encrypted_content`, pi-ai `thinking` blocks with signatures). Sending it back on the
 * next request in the same turn lets the model continue its chain of thought across tool
 * calls instead of re-deriving it. The state is only valid for the model that produced
 * it, so it is replayed only to that model and only within the current turn (assistant
 * messages after the latest user text), which is all providers need.
 */

function isUserTextMessage(message: LLMMessage): boolean {
  if (message.role !== "user") return false;
  if (typeof message.content === "string") return message.content.trim().length > 0;
  return (message.content as Any[]).some((item) => item?.type === "text" || item?.type === "image");
}

/** Index of the first message of the current turn (after the latest user text message). */
export function currentTurnStartIndex(messages: LLMMessage[]): number {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    if (isUserTextMessage(messages[i])) return i + 1;
  }
  return 0;
}

function itemsFor(
  message: LLMMessage,
  format: LLMReasoningItem["format"],
  model: string,
): LLMReasoningItem[] {
  if (message.role !== "assistant" || !Array.isArray(message.reasoning)) return [];
  return message.reasoning.filter((item) => item?.format === format && item.model === model);
}

// ---- OpenAI Responses API -------------------------------------------------------------

export function reasoningFromResponsesOutput(output: unknown, model: string): LLMReasoningItem[] {
  if (!Array.isArray(output)) return [];
  return output
    .filter((item: Any) => item?.type === "reasoning" && typeof item.encrypted_content === "string")
    .map((item: Any) => ({ format: "openai-responses" as const, model, data: item }));
}

/** Reasoning input items to send before this assistant message's other items. */
export function responsesReplayItems(message: LLMMessage, model: string): Any[] {
  return itemsFor(message, "openai-responses", model).map((item) => {
    const data = item.data as Any;
    return {
      type: "reasoning",
      ...(typeof data.id === "string" ? { id: data.id } : {}),
      summary: Array.isArray(data.summary) ? data.summary : [],
      encrypted_content: data.encrypted_content,
    };
  });
}

// ---- pi-ai (Pi provider, ChatGPT sign-in) ---------------------------------------------

export function reasoningFromPiAiResponse(response: Any): LLMReasoningItem[] {
  const model = typeof response?.model === "string" ? response.model : "";
  if (!model || !Array.isArray(response?.content)) return [];
  return response.content
    .filter((block: Any) => block?.type === "thinking")
    .map((block: Any) => ({
      format: "pi-ai" as const,
      model,
      data: { api: response.api, provider: response.provider, block },
    }));
}

/**
 * pi-ai only replays thinking blocks when the assistant message's api/provider/model
 * match the request, so replayed messages must carry the original metadata.
 */
export function piAiReplay(
  message: LLMMessage,
  model: string,
): { blocks: Any[]; api?: string; provider?: string } | null {
  const items = itemsFor(message, "pi-ai", model);
  if (items.length === 0) return null;
  const first = items[0].data as Any;
  return {
    blocks: items.map((item) => (item.data as Any).block).filter(Boolean),
    api: typeof first?.api === "string" ? first.api : undefined,
    provider: typeof first?.provider === "string" ? first.provider : undefined,
  };
}
