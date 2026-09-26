import { describe, expect, it } from "vitest";

import type { LLMMessage } from "../../llm/types";
import { piAiReplay, responsesReplayItems } from "../../llm/reasoning-replay";
import {
  assertNormalizedTurnTranscript,
  normalizeTurnTranscript,
} from "../turn-transcript-normalizer";

describe("normalizeTurnTranscript", () => {
  it("preserves provider reasoning across a complete tool round", () => {
    const reasoning: NonNullable<LLMMessage["reasoning"]> = [
      {
        format: "openai-responses",
        model: "test-model",
        data: { type: "reasoning", encrypted_content: "opaque-state", summary: [] },
      },
      {
        format: "pi-ai",
        model: "test-model",
        data: {
          api: "responses",
          provider: "openai",
          block: { type: "thinking", thinking: "opaque-thought" },
        },
      },
    ];
    const messages: LLMMessage[] = [
      { role: "user", content: "Read the file" },
      {
        role: "assistant",
        phase: "commentary",
        reasoning,
        content: [{ type: "tool_use", id: "read-1", name: "read_file", input: {} }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "read-1", content: "contents" }],
      },
    ];

    const normalized = assertNormalizedTurnTranscript(messages);
    expect(normalized[1]).toMatchObject({ phase: "commentary", reasoning });
    expect(responsesReplayItems(normalized[1], "test-model")).toHaveLength(1);
    expect(piAiReplay(normalized[1], "test-model")?.blocks).toHaveLength(1);
    expect(normalizeTurnTranscript(messages).modified).toBe(false);
  });

  it("drops orphan tool_result-only user messages", () => {
    const normalized = normalizeTurnTranscript([
      { role: "user", content: "task context" },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "orphan", content: '{"ok":false}' }],
      },
    ]);

    expect(normalized.messages).toEqual([{ role: "user", content: "task context" }]);
    expect(normalized.issues.some((issue) => issue.kind === "orphan_tool_result")).toBe(true);
  });

  it("splits mixed tool_result user messages from trailing user content", () => {
    const normalized = normalizeTurnTranscript([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "a.ts" } }],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "done" },
          { type: "text", text: "follow-up question" },
        ],
      },
    ]);

    expect(normalized.messages).toEqual([
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "tool-1", name: "read_file", input: { path: "a.ts" } }],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "done" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "follow-up question" }],
      },
    ]);
    expect(normalized.issues.some((issue) => issue.kind === "mixed_tool_result_user_message")).toBe(
      true,
    );
  });

  it("removes incomplete tool rounds entirely", () => {
    const normalized = normalizeTurnTranscript([
      {
        role: "assistant",
        content: [
          { type: "text", text: "Fetching sources." },
          {
            type: "tool_use",
            id: "tool-1",
            name: "web_fetch",
            input: { url: "https://a.example" },
          },
          {
            type: "tool_use",
            id: "tool-2",
            name: "web_fetch",
            input: { url: "https://b.example" },
          },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tool-1", content: "partial" }],
      },
      { role: "assistant", content: "Recovered later." },
    ]);

    expect(normalized.messages).toEqual([{ role: "assistant", content: "Recovered later." }]);
    expect(normalized.issues.some((issue) => issue.kind === "missing_tool_result")).toBe(true);
  });
});
