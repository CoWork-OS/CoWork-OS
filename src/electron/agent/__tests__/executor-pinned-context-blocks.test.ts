import { describe, expect, it, vi } from "vitest";

import type { LLMMessage } from "../llm";
import { ContextManager } from "../context-manager";
import { TaskExecutor } from "../executor";
import { SessionRuntime } from "../runtime/SessionRuntime";

const PROFILE = "<cowork_user_profile>\nPrefers TypeScript.\n</cowork_user_profile>";
const RECALL = "<cowork_memory_recall>\n- [match:insight] use pnpm\n</cowork_memory_recall>";

function createState(): Any {
  return {
    transcript: {
      conversationHistory: [],
      lastUserMessage: "Prompt",
      lastAssistantOutput: null,
      lastNonVerificationOutput: null,
      lastAssistantText: null,
      explicitChatSummaryBlock: null,
      explicitChatSummaryCreatedAt: 0,
      explicitChatSummarySourceMessageCount: 0,
      stepOutcomeSummaries: [],
    },
    tooling: {},
    files: {},
    loop: { compactionCount: 0 },
    recovery: {},
    queues: { pendingFollowUps: [] },
    skills: {},
    worker: {},
    permissions: {},
    verification: {},
    checklist: { items: [], updatedAt: 0, verificationNudgeNeeded: false, nudgeReason: null },
    promptCache: {},
    usage: {},
  };
}

// Real executor pinned-block helpers, wired through the executor's own
// SessionRuntime deps so the tags SessionRuntime passes are the ones used live.
function createRuntime(opts: { recall?: (query: string) => string } = {}) {
  const executor = Object.create(TaskExecutor.prototype) as Any;
  executor.task = { id: "task-1", title: "Task", prompt: "Prompt", agentConfig: {} };
  executor.workspace = { id: "workspace-1", path: "/tmp", permissions: {} };
  executor.contextManager = new ContextManager("claude-sonnet-4-5");
  executor.logTag = "[Executor:test]";
  executor.maybeInjectTurnBudgetSoftLanding = () => {};
  executor.checkBudgets = () => {};
  executor.buildUserProfileBlock = () => PROFILE;
  executor.computeSharedContextKey = () => "shared";
  executor.buildSharedContextBlock = () => "";
  executor.buildHybridMemoryRecallBlock = async (_workspaceId: string, query: string) =>
    opts.recall ? opts.recall(query) : RECALL;
  executor.maybePreCompactionMemoryFlush = async () => {};
  executor.pruneStaleToolErrors = () => {};
  executor.emitEvent = () => {};
  const runtime = new SessionRuntime(executor.createSessionRuntimeDeps(), createState());
  return { executor, runtime };
}

function countOccurrences(messages: LLMMessage[], needle: string): number {
  return JSON.stringify(messages).split(needle).length - 1;
}

async function runTurns(
  runtime: SessionRuntime,
  initialMessages: LLMMessage[],
  memoryQueries: string[],
): Promise<{ messages: LLMMessage[]; firstMessageByTurn: string[] }> {
  let messages = initialMessages;
  let carry = {
    lastTurnMemoryRecallQuery: "",
    lastTurnMemoryRecallBlock: "",
    lastSharedContextKey: "",
    lastSharedContextBlock: "",
  };
  const firstMessageByTurn: string[] = [];
  for (const [turn, memoryQuery] of memoryQueries.entries()) {
    const result = await runtime.prepareMessagesForTurnIteration({
      messages,
      phase: "step",
      systemPromptTokens: 1000,
      allowSharedContextInjection: false,
      allowMemoryInjection: true,
      memoryQuery,
      contextLabel: "step:1 Fix the bug",
      ...carry,
    });
    messages = result.messages;
    carry = {
      lastTurnMemoryRecallQuery: result.lastTurnMemoryRecallQuery,
      lastTurnMemoryRecallBlock: result.lastTurnMemoryRecallBlock,
      lastSharedContextKey: result.lastSharedContextKey,
      lastSharedContextBlock: result.lastSharedContextBlock,
    };
    firstMessageByTurn.push(String(messages[0].content));
    // The step loop appends one tool round-trip per iteration.
    messages.push({
      role: "assistant",
      content: [
        { type: "tool_use", id: `tool-${turn}`, name: "read_file", input: { path: "a.ts" } },
      ],
    });
    messages.push({
      role: "user",
      content: [{ type: "tool_result", tool_use_id: `tool-${turn}`, content: "file body" }],
    });
  }
  return { messages, firstMessageByTurn };
}

describe("pinned context blocks across turn iterations", () => {
  it("keeps exactly one profile and recall block and leaves message[0] byte-identical", async () => {
    const { runtime } = createRuntime();

    const { messages, firstMessageByTurn } = await runTurns(
      runtime,
      [{ role: "user", content: "Execute this step: Fix the bug" }],
      ["Fix the bug", "Fix the bug", "Fix the bug"],
    );

    expect(countOccurrences(messages, "<cowork_user_profile>")).toBe(1);
    expect(countOccurrences(messages, "<cowork_memory_recall>")).toBe(1);
    expect(firstMessageByTurn[1]).toBe(firstMessageByTurn[0]);
    expect(firstMessageByTurn[2]).toBe(firstMessageByTurn[0]);
    expect(firstMessageByTurn[0]).toContain("Execute this step: Fix the bug");
  });

  it("removes the recall block once the recall builder returns nothing", async () => {
    const { runtime } = createRuntime({
      recall: (query) => (query === "Fix the bug" ? RECALL : ""),
    });

    const { messages, firstMessageByTurn } = await runTurns(
      runtime,
      [{ role: "user", content: "Execute this step: Fix the bug" }],
      ["Fix the bug", "Unrelated follow-up"],
    );

    expect(firstMessageByTurn[0]).toContain("<cowork_memory_recall>");
    expect(countOccurrences(messages, "<cowork_memory_recall>")).toBe(0);
    expect(countOccurrences(messages, "<cowork_user_profile>")).toBe(1);
    expect(String(messages[0].content)).toContain("Execute this step: Fix the bug");
  });

  it("collapses copies left in message[0] by earlier builds into one", async () => {
    const { runtime } = createRuntime();
    const legacyFirstMessage = [
      "Execute this step: Fix the bug",
      PROFILE,
      RECALL,
      PROFILE,
      RECALL,
      "CHECKLIST REMINDER: stays as user text",
    ].join("\n\n");

    const { messages } = await runTurns(
      runtime,
      [{ role: "user", content: legacyFirstMessage }],
      ["Fix the bug"],
    );

    expect(countOccurrences(messages, "<cowork_user_profile>")).toBe(1);
    expect(countOccurrences(messages, "<cowork_memory_recall>")).toBe(1);
    expect(String(messages[0].content)).toContain("CHECKLIST REMINDER: stays as user text");
  });

  it("wraps the checklist reminder so it is removed on the next iteration", async () => {
    const { runtime } = createRuntime();
    (runtime as Any).state.checklist.verificationNudgeNeeded = true;
    (runtime as Any).taskListVerificationReminderPending = true;

    const { messages, firstMessageByTurn } = await runTurns(
      runtime,
      [{ role: "user", content: "Execute this step: Fix the bug" }],
      ["Fix the bug", "Fix the bug"],
    );

    expect(firstMessageByTurn[0]).toContain("CHECKLIST REMINDER:");
    expect(countOccurrences(messages, "CHECKLIST REMINDER:")).toBe(0);
  });

  it("does not touch user text that only mentions a pinned tag", async () => {
    const { runtime } = createRuntime();
    const userText = "Explain why <cowork_memory_recall> shows up twice in the transcript";

    const { messages } = await runTurns(
      runtime,
      [{ role: "user", content: userText }],
      ["Fix the bug", "Fix the bug"],
    );

    expect(String(messages[0].content).startsWith(userText)).toBe(true);
    expect(countOccurrences(messages, "- [match:insight] use pnpm")).toBe(1);
  });

  it("replaces the compaction summary instead of appending a second one", async () => {
    const { executor, runtime } = createRuntime();
    let summaryCount = 0;
    executor.buildCompactionSummaryBlock = vi.fn(async () => {
      summaryCount += 1;
      return `<cowork_compaction_summary>\nCurrent State: summary ${summaryCount}\n</cowork_compaction_summary>`;
    });
    const removed: LLMMessage[] = [{ role: "assistant", content: "older work" }];
    let messages: LLMMessage[] = [
      { role: "user", content: "Execute this step: Fix the bug" },
      { role: "assistant", content: "recent work" },
    ];

    for (let round = 0; round < 2; round++) {
      const result = await (runtime as Any).installCompactionSummary({
        messages,
        removedMessages: removed,
        systemPromptTokens: 0,
        contextLabel: "step:1",
      });
      messages = result.messages;
      // prepareMessagesForTurnIteration consolidates after installing.
      executor.consolidateConsecutiveUserMessages(messages);
    }

    expect(countOccurrences(messages, "<cowork_compaction_summary>")).toBe(1);
    expect(JSON.stringify(messages)).toContain("Current State: summary 2");
    expect(JSON.stringify(messages)).not.toContain("Current State: summary 1");
    // The replaced summary must reach the summarizer so its facts carry forward.
    expect(executor.buildCompactionSummaryBlock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        previousSummary: expect.stringContaining("Current State: summary 1"),
      }),
    );
  });
});
