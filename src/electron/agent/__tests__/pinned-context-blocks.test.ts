import { describe, expect, it } from "vitest";

import type { LLMMessage } from "../llm";
import {
  findPinnedContextBlockContent,
  PINNED_CONTEXT_TAGS,
  removePinnedContextBlock,
  upsertPinnedContextBlock,
} from "../pinned-context-blocks";

const { userProfile, memoryRecall, taskListReminder } = PINNED_CONTEXT_TAGS;

describe("pinned context blocks", () => {
  it("keeps blocks in their own message when the first message is not plain text", () => {
    const messages: LLMMessage[] = [
      { role: "user", content: [{ type: "text", text: "Execute this step: compare images" }] },
      { role: "assistant", content: "Looking." },
    ];

    upsertPinnedContextBlock(messages, {
      tag: userProfile.open,
      content: `${userProfile.open}\nPrefers TypeScript.\n${userProfile.close}`,
    });
    upsertPinnedContextBlock(messages, {
      tag: memoryRecall.open,
      content: `${memoryRecall.open}\n- old fact\n${memoryRecall.close}`,
      insertAfterTag: userProfile.open,
    });
    upsertPinnedContextBlock(messages, {
      tag: memoryRecall.open,
      content: `${memoryRecall.open}\n- new fact\n${memoryRecall.close}`,
    });

    expect(messages).toHaveLength(3);
    expect(messages[1]).toEqual({
      role: "user",
      content: [
        `${userProfile.open}\nPrefers TypeScript.\n${userProfile.close}`,
        `${memoryRecall.open}\n- new fact\n${memoryRecall.close}`,
      ].join("\n\n"),
    });

    removePinnedContextBlock(messages, userProfile.open);
    expect(messages[1].content).toBe(`${memoryRecall.open}\n- new fact\n${memoryRecall.close}`);
    removePinnedContextBlock(messages, memoryRecall.open);
    expect(messages).toHaveLength(2);
  });

  it("wraps untagged content and resolves legacy symbolic names", () => {
    const messages: LLMMessage[] = [{ role: "user", content: "Task" }];

    upsertPinnedContextBlock(messages, {
      tag: "PINNED_TASK_LIST_REMINDER",
      content: "CHECKLIST REMINDER: verify",
    });

    expect(messages[1].content).toBe(
      `${taskListReminder.open}\nCHECKLIST REMINDER: verify\n${taskListReminder.close}`,
    );
    expect(findPinnedContextBlockContent(messages, taskListReminder.open)).toBe(
      "CHECKLIST REMINDER: verify",
    );
    removePinnedContextBlock(messages, "PINNED_TASK_LIST_REMINDER");
    expect(messages).toEqual([{ role: "user", content: "Task" }]);
  });

  it("never inserts a block between a tool call and its result", () => {
    const messages: LLMMessage[] = [
      { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "glob", input: {} }] },
      { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "[]" }] },
    ];

    upsertPinnedContextBlock(messages, {
      tag: userProfile.open,
      content: `${userProfile.open}\nx\n${userProfile.close}`,
    });

    expect(messages.map((message) => message.role)).toEqual(["assistant", "user", "user"]);
    expect(messages[2].content).toContain(userProfile.open);
  });
});
