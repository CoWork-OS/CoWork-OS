import { describe, expect, it } from "vitest";
import type { LLMMessage } from "../llm/types";
import { buildModelHandoffNote, summarizeEarlierToolActivity } from "../model-handoff-note";

const toolUse = (name: string) => ({ type: "tool_use" as const, id: name, name, input: {} });
const toolResult = (id: string) => ({
  type: "tool_result" as const,
  tool_use_id: id,
  content: "ok",
});

describe("model handoff note", () => {
  it("lists tool activity per earlier user turn, ignoring tool-result messages as turns", () => {
    const history = [
      { role: "user", content: "Plan my week" },
      { role: "assistant", content: [{ type: "text", text: "Sure" }] },
      { role: "user", content: "Find flights" },
      { role: "assistant", content: [toolUse("web_search"), toolUse("web_search")] },
      { role: "user", content: [toolResult("web_search")] },
      { role: "assistant", content: [toolUse("write_file")] },
      { role: "user", content: [toolResult("write_file")] },
      { role: "assistant", content: [{ type: "text", text: "Saved" }] },
    ] as LLMMessage[];

    expect(summarizeEarlierToolActivity(history)).toEqual(["turn 2: web_search ×2, write_file"]);
  });

  it("names both routes and tells the new model to build on the conversation", () => {
    const note = buildModelHandoffNote(
      {
        from: { providerType: "anthropic", modelId: "claude-sonnet-5" },
        to: { providerType: "openai", modelId: "gpt-6-astra" },
      },
      [{ role: "user", content: "Hello" }] as LLMMessage[],
    );

    expect(note).toContain("anthropic/claude-sonnet-5");
    expect(note).toContain("openai/gpt-6-astra");
    expect(note).toContain("continuing the same conversation");
    expect(note).not.toContain("Tools used");
  });

  it("keeps the summary short for long tool-heavy threads", () => {
    const history: LLMMessage[] = [];
    for (let turn = 0; turn < 10; turn += 1) {
      history.push({ role: "user", content: `step ${turn}` });
      history.push({
        role: "assistant",
        content: ["a", "b", "c", "d", "e", "f", "g"].map((name) => toolUse(`${name}${turn}`)),
      });
    }

    const lines = summarizeEarlierToolActivity(history);
    expect(lines).toHaveLength(6);
    expect(lines[0]).toMatch(/^turn 5: /);
    expect(lines[5]).toContain("+2 more");
  });
});
