import { describe, expect, it } from "vitest";

import { normalizeTurnTranscript } from "../turn-transcript-normalizer";

describe("normalizeTurnTranscript", () => {
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
