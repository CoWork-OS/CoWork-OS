import { describe, expect, it, vi } from "vitest";
import { generateComposerPrediction } from "../ComposerPredictionService";
import { predictionRevision } from "../../../shared/composer-predictions";
import type { Task, TaskEvent } from "../../../shared/types";
import type { LLMProvider } from "../llm/types";

const task = {
  id: "t",
  status: "completed",
  prompt: "Compare these options",
  resultSummary: "A costs less.",
} as Task;
const events = [
  { id: "u", type: "user_message", payload: { message: "Compare these options" } },
  { id: "a", type: "assistant_message", payload: { message: "A costs less. B is faster." } },
  { id: "c", type: "task_completed", payload: {} },
] as TaskEvent[];
function provider(text = '{"text":"Show me the tradeoffs."}', stopReason = "end_turn") {
  return {
    createMessage: vi.fn().mockResolvedValue({ content: [{ type: "text", text }], stopReason }),
  } as unknown as LLMProvider;
}

describe("composer predictions", () => {
  it("uses only bounded conversation context and never enables tools", async () => {
    const llm = provider();
    const long = [
      ...events.slice(0, 2),
      {
        id: "internal",
        type: "assistant_message",
        payload: { message: "PRIVATE INTERNAL", internal: true },
      },
      { id: "tool", type: "tool_result", payload: { message: "TOOL SECRET" } },
      events[2],
    ] as TaskEvent[];
    expect(await generateComposerPrediction(task, long, "c", llm, "model")).toEqual({
      revision: "c",
      text: "Show me the tradeoffs.",
    });
    const request = vi.mocked(llm.createMessage).mock.calls[0][0];
    expect(request.tools).toBeUndefined();
    expect(request.maxTokens).toBe(256);
    expect(request.signal).toBeInstanceOf(AbortSignal);
    expect(request.messages[0].content).not.toContain("PRIVATE INTERNAL");
    expect(request.messages[0].content).not.toContain("TOOL SECRET");
    expect(request.messages[0].content).toContain("A costs less. B is faster.");
  });

  it("uses the actual result rather than generic completion status prose", async () => {
    const llm = provider();
    await generateComposerPrediction(
      task,
      [
        events[0],
        {
          ...events[2],
          payload: {
            message: "Completed via follow-up",
            resultSummary: "A costs less. B is faster.",
          },
        },
      ] as TaskEvent[],
      "c",
      llm,
      "m",
    );
    const context = JSON.parse(
      vi.mocked(llm.createMessage).mock.calls[0][0].messages[0].content as string,
    );
    expect(context.conversation.at(-1).text).toBe("A costs less. B is faster.");
    expect(JSON.stringify(context)).not.toContain("Completed via follow-up");
  });

  it("does not duplicate the final assistant answer in the completion summary", async () => {
    const llm = provider();
    await generateComposerPrediction(
      task,
      [
        events[0],
        events[1],
        {
          ...events[2],
          payload: { message: "Task complete", resultSummary: events[1].payload.message },
        },
      ] as TaskEvent[],
      "c",
      llm,
      "m",
    );
    const context = JSON.parse(
      vi.mocked(llm.createMessage).mock.calls[0][0].messages[0].content as string,
    );
    expect(
      context.conversation.filter((message: { role: string }) => message.role === "assistant"),
    ).toHaveLength(1);
  });

  it("propagates cancellation to the provider", async () => {
    const controller = new AbortController();
    const llm = provider();
    vi.mocked(llm.createMessage).mockImplementation(async (request) => {
      controller.abort();
      expect(request.signal?.aborted).toBe(true);
      throw new Error("aborted");
    });
    expect(
      await generateComposerPrediction(task, events, "c", llm, "m", controller.signal),
    ).toBeNull();
  });

  it("skips active tasks, stale revisions, and unanswered user messages", async () => {
    const llm = provider();
    expect(
      await generateComposerPrediction({ ...task, status: "executing" }, events, "c", llm, "m"),
    ).toBeNull();
    expect(await generateComposerPrediction(task, events, "old", llm, "m")).toBeNull();
    const next = [
      ...events,
      { id: "next", type: "user_message", payload: { message: "Wait" } },
    ] as TaskEvent[];
    expect(await generateComposerPrediction(task, next, "next", llm, "m")).toBeNull();
    expect(llm.createMessage).not.toHaveBeenCalled();
  });

  it.each([
    ['{"text":""}', "end_turn"],
    ['{"text":"line one\\nline two"}', "end_turn"],
    [JSON.stringify({ text: "x".repeat(501) }), "end_turn"],
    ["not json", "end_turn"],
    ['{"text":"partial"}', "max_tokens"],
    ['{"text":"refused"}', "refusal"],
  ])("silently skips unusable output %s", async (text, stop) => {
    expect(
      await generateComposerPrediction(task, events, "c", provider(text, stop), "m"),
    ).toBeNull();
  });

  it("fails quietly when the provider is unavailable", async () => {
    const llm = provider();
    vi.mocked(llm.createMessage).mockRejectedValue(new Error("offline"));
    expect(await generateComposerPrediction(task, events, "c", llm, "m")).toBeNull();
  });

  it("handles canonical timeline events through their legacy message type", () => {
    expect(
      predictionRevision([
        { ...events[1], type: "timeline_group_finished", legacyType: "assistant_message" },
      ] as TaskEvent[]),
    ).toBe("a");
  });
});
