import { describe, expect, it } from "vitest";
import type { AttentionItem } from "../../../shared/attention";
import { attentionInScope } from "../attention-scope";

function item(id: string, overrides: Partial<AttentionItem> = {}): AttentionItem {
  return {
    id,
    kind: "approval",
    state: "Approval needed",
    title: id,
    createdAt: 1,
    urgent: true,
    actor: { kind: "agent", name: "Agent" },
    origin: { kind: "you", label: "You started it" },
    place: { kind: "local", label: "This Mac" },
    workspaceId: "ws",
    taskId: `task-${id}`,
    ref: { type: "approval", approvalId: id, taskId: `task-${id}` },
    ...overrides,
  };
}

describe("attentionInScope", () => {
  const items = [
    item("here", { ownerAgentRoleIds: ["ops"] }),
    item("there", { workspaceId: "other" }),
    item("commitment", { kind: "commitment", workspaceId: undefined, taskId: undefined }),
    item("offer", { kind: "suggestion", urgent: false }),
  ];
  const ids = (scoped: AttentionItem[]) => scoped.map((entry) => entry.id);

  it("keeps every decision across workspaces, but not offers", () => {
    expect(ids(attentionInScope(items, { workspaceId: null }))).toEqual([
      "here",
      "there",
      "commitment",
    ]);
  });

  it("narrows to one workspace and to one agent's work", () => {
    expect(ids(attentionInScope(items, { workspaceId: "ws" }))).toEqual(["here"]);
    expect(ids(attentionInScope(items, { workspaceId: null, agentRoleId: "ops" }))).toEqual([
      "here",
    ]);
    expect(attentionInScope(items, { workspaceId: "ws", agentRoleId: "other" })).toEqual([]);
  });
});
