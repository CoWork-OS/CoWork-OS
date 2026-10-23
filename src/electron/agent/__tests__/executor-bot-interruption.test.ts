import { describe, expect, it, vi } from "vitest";
import { TaskExecutor } from "../executor";
vi.mock("electron", () => ({ app: { getPath: () => "/tmp" } }));

function executor() {
  return Object.assign(Object.create(TaskExecutor.prototype), {
    task: {
      id: "bot",
      prompt: "Start chatting with Coordinator.",
      agentConfig: { botConversation: true },
    },
    conversationHistory: [{ role: "user", content: "Read my context" }],
    plan: undefined,
    toolRegistry: { cleanup: vi.fn(async () => {}) },
    sendMessageUnlocked: vi.fn(async () => {}),
    executeUnlocked: vi.fn(async () => {}),
    emitEvent: vi.fn(),
    daemon: { updateTaskStatus: vi.fn() },
  });
}
describe("interrupted bot execution", () => {
  it("resumes the exact user turn without a duplicate transcript event or synthetic task", async () => {
    const e = executor();
    await e.resumeAfterInterruptionUnlocked({
      message: "Read my context",
      messageSource: "user",
      messageId: "turn",
    });
    expect(e.sendMessageUnlocked).toHaveBeenCalledWith(
      "Read my context",
      undefined,
      undefined,
      expect.objectContaining({
        messageId: "turn",
        messageSource: "user",
        suppressUserMessageEvent: true,
        transcriptAlreadyContainsMessage: true,
      }),
    );
    expect(e.executeUnlocked).not.toHaveBeenCalled();
  });
  it("restores a missing request in stale snapshot history while suppressing its already persisted event", async () => {
    const e = executor();
    e.conversationHistory = [];
    await e.resumeAfterInterruptionUnlocked({ message: "Read my context", messageSource: "user" });
    expect(e.sendMessageUnlocked).toHaveBeenCalledWith(
      "Read my context",
      undefined,
      undefined,
      expect.objectContaining({
        suppressUserMessageEvent: true,
        transcriptAlreadyContainsMessage: false,
      }),
    );
  });

  it("does not resume an old plan instead of the latest user turn", async () => {
    const e = executor();
    e.plan = { description: "Old handoff", steps: [{ id: "old", status: "pending" }] };
    await e.resumeAfterInterruptionUnlocked({ message: "Read my context", messageSource: "user" });
    expect(e.sendMessageUnlocked).toHaveBeenCalledOnce();
    expect(e.executeUnlocked).not.toHaveBeenCalled();
  });
  it("leaves a bot with no unfinished turn idle", async () => {
    const e = executor();
    await e.resumeAfterInterruptionUnlocked();
    expect(e.daemon.updateTaskStatus).toHaveBeenCalledWith("bot", "pending");
    expect(e.executeUnlocked).not.toHaveBeenCalled();
  });
});

describe("interrupted follow-up in an ordinary task", () => {
  function taskExecutor(conversationHistory: unknown[]) {
    const e = executor();
    e.task = { id: "chat", prompt: "Summarize the report", agentConfig: {} };
    e.conversationHistory = conversationHistory;
    return e;
  }
  const firstTurn = [
    { role: "user", content: "Summarize the report" },
    { role: "assistant", content: [{ type: "text", text: "Here is the summary." }] },
  ];

  it("answers the unanswered follow-up on the restored history instead of rerunning the first prompt", async () => {
    const e = taskExecutor(firstTurn);
    await e.resumeAfterInterruptionUnlocked({
      message: "Now list the risks",
      messageSource: "user",
      messageId: "follow-up",
    });
    expect(e.sendMessageUnlocked).toHaveBeenCalledWith(
      "Now list the risks",
      undefined,
      undefined,
      expect.objectContaining({
        messageId: "follow-up",
        suppressUserMessageEvent: true,
        transcriptAlreadyContainsMessage: false,
      }),
    );
    expect(e.executeUnlocked).not.toHaveBeenCalled();
    expect(e.emitEvent).toHaveBeenCalledWith(
      "log",
      expect.objectContaining({ recovery: "user_follow_up" }),
    );
  });

  it("does not take an earlier turn with the same words for the unanswered one", async () => {
    const e = taskExecutor([
      { role: "user", content: "continue" },
      { role: "assistant", content: [{ type: "text", text: "Done." }] },
    ]);
    await e.resumeAfterInterruptionUnlocked({ message: "continue", messageSource: "user" });
    expect(e.sendMessageUnlocked).toHaveBeenCalledWith(
      "continue",
      undefined,
      undefined,
      expect.objectContaining({ transcriptAlreadyContainsMessage: false }),
    );
  });

  it("continues a follow-up the checkpoint caught mid tool call", async () => {
    const e = taskExecutor([
      ...firstTurn,
      { role: "user", content: "Now list the risks" },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "read_file", input: {} }],
      },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "risks" }] },
    ]);
    await e.resumeAfterInterruptionUnlocked({
      message: "Now list the risks",
      messageSource: "user",
    });
    expect(e.sendMessageUnlocked).toHaveBeenCalledWith(
      "Now list the risks",
      undefined,
      undefined,
      expect.objectContaining({ transcriptAlreadyContainsMessage: true }),
    );
  });

  it("still runs a task without an unanswered follow-up from its prompt", async () => {
    const e = taskExecutor(firstTurn);
    await e.resumeAfterInterruptionUnlocked();
    expect(e.executeUnlocked).toHaveBeenCalledOnce();
    expect(e.sendMessageUnlocked).not.toHaveBeenCalled();
  });
});
