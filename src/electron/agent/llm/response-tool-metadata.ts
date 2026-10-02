import { randomUUID } from "node:crypto";
import type { LLMResponse } from "./types";

/** Repair correlation for rejected calls, never repair malformed calls into execution. */
export function normalizeResponseToolMetadata(response: LLMResponse): LLMResponse {
  if (
    !response ||
    !Array.isArray(response.content) ||
    response.content.some((block) => !block || typeof block !== "object")
  ) {
    throw new Error("Invalid provider response: content must be an array of content blocks.");
  }
  const idCounts = new Map<string, number>();
  for (const block of response.content) {
    if (block.type === "tool_use" && typeof block.id === "string" && block.id.trim()) {
      idCounts.set(block.id, (idCounts.get(block.id) ?? 0) + 1);
    }
  }
  const usedIds = new Set(idCounts.keys());
  let changed = false;
  const content = response.content.map((block) => {
    if (block.type !== "tool_use") return block;
    const validId = typeof block.id === "string" && block.id.trim().length > 0;
    const duplicateId = validId && idCounts.get(block.id)! > 1;
    const validName = typeof block.name === "string" && block.name.trim().length > 0;
    const validInput =
      block.input !== null && typeof block.input === "object" && !Array.isArray(block.input);
    if (validId && !duplicateId && validName && validInput) return block;

    changed = true;
    let id = block.id;
    if (!validId || duplicateId) {
      do {
        id = `rejected_${randomUUID()}`;
      } while (usedIds.has(id));
      usedIds.add(id);
    }
    return {
      ...block,
      id,
      name: validName ? block.name : "invalid_tool_call",
      input: validInput ? block.input : {},
      inputError: {
        code: "invalid_shape" as const,
        message:
          "Tool call is invalid: each call requires a unique nonempty ID, a nonempty tool name, and an argument object. Request the tool again with valid fields.",
      },
    };
  });
  // Gemini (finishReason STOP) and several OpenAI-compatible servers report a
  // turn that ends in tool calls as a normal stop. The loops treat end_turn as
  // "answer complete", so they would run the tools once and return the preamble
  // text as the answer. A response that carries tool calls is a tool_use turn.
  const stopReason =
    content.some((block) => block.type === "tool_use") &&
    (response.stopReason === "end_turn" ||
      response.stopReason === "stop_sequence" ||
      response.stopReason === undefined)
      ? "tool_use"
      : response.stopReason;
  if (!changed && stopReason === response.stopReason) return response;
  return { ...response, content, stopReason };
}
