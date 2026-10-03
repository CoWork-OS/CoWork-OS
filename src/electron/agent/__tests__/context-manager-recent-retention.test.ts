import { describe, expect, it } from "vitest";

import { ContextManager } from "../context-manager";
import type { LLMMessage } from "../llm";
import { normalizeTurnTranscript } from "../runtime/turn-transcript-normalizer";

function toolExchange(index: number, resultChars: number): LLMMessage[] {
  return [
    {
      role: "assistant",
      content: [
        {
          type: "tool_use",
          id: `t${index}`,
          name: "read_file",
          input: { path: `src/f${index}.ts` },
        },
      ],
    },
    {
      role: "user",
      content: [
        { type: "tool_result", tool_use_id: `t${index}`, content: "x".repeat(resultChars) },
      ],
    },
  ];
}

describe("ContextManager keeps the latest work when the first message fills the budget", () => {
  it("retains the last user request and the last complete tool exchange", () => {
    const contextManager = new ContextManager("claude-haiku-4-5");
    const messages: LLMMessage[] = [
      { role: "user", content: `Analyze the attached report:\n${"r".repeat(280_000)}` },
      {
        role: "user",
        content: `<cowork_compaction_summary>\n${"s".repeat(24_000)}\n</cowork_compaction_summary>`,
      },
    ];
    for (let index = 0; index < 40; index++) {
      messages.push(...toolExchange(index, 12_000));
      if (index === 30) {
        messages.push({ role: "user", content: "USER UPDATE: also cover the appendix tables" });
      }
    }

    const result = contextManager.proactiveCompactWithMeta(messages, 15_000, 0.35);
    const kept = JSON.stringify(result.messages);

    expect(result.meta.removedMessages.didRemove).toBe(true);
    expect(kept).toContain("USER UPDATE: also cover the appendix tables");
    expect(kept).toContain('"tool_use_id":"t39"');
    expect(kept).toContain('"id":"t39"');
    expect(normalizeTurnTranscript(result.messages).issues).toEqual([]);
  });
});
