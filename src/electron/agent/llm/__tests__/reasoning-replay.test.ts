import { describe, expect, it } from "vitest";

import {
  currentTurnStartIndex,
  piAiReplay,
  reasoningFromPiAiResponse,
  reasoningFromResponsesOutput,
  responsesReplayItems,
} from "../reasoning-replay";
import type { LLMMessage } from "../types";

describe("reasoning replay", () => {
  it("captures encrypted Responses reasoning and replays it only to the same model", () => {
    const reasoning = reasoningFromResponsesOutput(
      [
        { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" },
        { type: "reasoning", id: "rs_2", summary: [] },
        { type: "function_call", call_id: "c1" },
      ],
      "gpt-6-sol",
    );
    expect(reasoning).toHaveLength(1);

    const message: LLMMessage = { role: "assistant", content: [], reasoning };
    expect(responsesReplayItems(message, "gpt-6-sol")).toEqual([
      { type: "reasoning", id: "rs_1", summary: [], encrypted_content: "enc" },
    ]);
    expect(responsesReplayItems(message, "gpt-6-luna")).toEqual([]);
  });

  it("keeps pi-ai thinking blocks with the metadata pi-ai needs to accept them", () => {
    const reasoning = reasoningFromPiAiResponse({
      api: "openai-codex-responses",
      provider: "openai-codex",
      model: "gpt-6-astra",
      content: [
        { type: "thinking", thinking: "plan", thinkingSignature: "sig" },
        { type: "text", text: "hi" },
      ],
    });
    const replay = piAiReplay({ role: "assistant", content: [], reasoning }, "gpt-6-astra");
    expect(replay).toEqual({
      blocks: [{ type: "thinking", thinking: "plan", thinkingSignature: "sig" }],
      api: "openai-codex-responses",
      provider: "openai-codex",
    });
    expect(piAiReplay({ role: "assistant", content: [], reasoning }, "other-model")).toBeNull();
  });

  it("limits replay to the current turn", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: "first task" },
      { role: "assistant", content: [{ type: "text", text: "done" }] },
      { role: "user", content: "second task" },
      { role: "assistant", content: [] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "c1", content: "ok" }] },
    ];
    expect(currentTurnStartIndex(messages)).toBe(3);
  });
});
