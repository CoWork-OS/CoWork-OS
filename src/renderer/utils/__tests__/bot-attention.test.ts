import { describe, expect, it } from "vitest";
import type { AttentionItem } from "../../../shared/attention";
import {
  botAttentionItems,
  botAttentionLine,
  botsAttentionCount,
  withQueueNeedsYou,
} from "../bot-attention";

function item(id: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    kind: "approval",
    state: "Approval needed",
    title: `Decision ${id}`,
    createdAt: 1,
    urgent: true,
    actor: { kind: "agent", name: "Agent" },
    origin: { kind: "you", label: "You started it" },
    place: { kind: "local", label: "This Mac" },
    workspaceId: "ws",
    taskId: `task-${id}`,
    ownerAgentRoleIds: ["lead"],
    ref: { type: "approval", approvalId: id, taskId: `task-${id}` },
    ...overrides,
  };
}

describe("bot attention", () => {
  const items = [
    item("own"),
    item("delegated", { ownerAgentRoleIds: ["helper", "lead"] }),
    item("helper-only", { ownerAgentRoleIds: ["helper"] }),
    item("other-workspace", { workspaceId: "elsewhere" }),
    item("unowned", { ownerAgentRoleIds: undefined }),
    item("no-session", { taskId: undefined }),
  ];

  it("lists a bot's decisions in one workspace, including work it delegated", () => {
    expect(
      botAttentionItems(items, { workspaceId: "ws", botId: "lead" }).map((entry) => entry.id),
    ).toEqual(["own", "delegated"]);
    expect(
      botAttentionItems(items, { workspaceId: "ws", botId: "helper" }).map((entry) => entry.id),
    ).toEqual(["delegated", "helper-only"]);
    expect(botAttentionItems(items, { workspaceId: "", botId: "lead" })).toEqual([]);
  });

  it("counts each decision once across bots", () => {
    expect(botsAttentionCount(items, "ws", ["lead", "helper"])).toBe(3);
    expect(botsAttentionCount(items, "ws", [])).toBe(0);
  });

  it("replaces only Needs you, and waits for the store's counts", () => {
    expect(withQueueNeedsYou({ needs_you: 5, working: 2, scheduled: 1, results: 9 }, 1)).toEqual({
      needs_you: 1,
      working: 2,
      scheduled: 1,
      results: 9,
    });
    expect(withQueueNeedsYou(null, 1)).toBeNull();
  });

  it("says what each kind of decision waits for", () => {
    expect(botAttentionLine(item("a"))).toBe("Waiting for your approval");
    expect(botAttentionLine(item("q", { kind: "question", state: "Question" }))).toBe(
      "Has a question for you",
    );
    expect(botAttentionLine(item("qs", { kind: "question", state: "2 questions" }))).toBe(
      "Has 2 questions for you",
    );
    expect(botAttentionLine(item("s", { kind: "session", state: "Resume available" }))).toBe(
      "Resume available",
    );
  });
});
