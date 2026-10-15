import { describe, expect, it } from "vitest";
import type { AttentionItem, AttentionSnapshot } from "../../../shared/attention";
import type { Task, Workspace } from "../../../shared/types";
import type { WebRequestContext } from "../../web/WebApplication";
import { createBrowserAttentionDefinitions } from "../browser-attention-methods";

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
    ref: { type: "approval", approvalId: id, taskId: `task-${id}` },
    ...overrides,
  };
}

const context = {
  sessionId: "browser-session",
  identity: { profileId: "profile-one" },
} as WebRequestContext;

function setup(snapshot: AttentionSnapshot | null) {
  const workspace = (id: string, read: boolean) => ({ id, permissions: { read } }) as Workspace;
  const tasks: Record<string, Partial<Task>> = {
    "task-readable": { id: "task-readable", workspaceId: "ws-readable" },
    "task-hidden": { id: "task-hidden", workspaceId: "ws-hidden" },
  };
  const methods = createBrowserAttentionDefinitions({
    getAttention: () => (snapshot ? { snapshot: async () => snapshot } : null),
    resolveWorkspace: async (id) =>
      id === "ws-readable" ? workspace(id, true) : id === "ws-hidden" ? workspace(id, false) : null,
    getTask: async (id) => (tasks[id] as Task) ?? null,
  });
  return {
    methods,
    list: (ctx = context) => methods.listAttention.handler([], ctx) as Promise<AttentionSnapshot>,
  };
}

describe("browser attention methods", () => {
  it("lists only items in workspaces the browser may read, plus the user's own", async () => {
    const { methods, list } = setup({
      generatedAt: 5,
      failedSources: ["flows"],
      items: [
        item("in-readable", { taskId: "task-readable", workspaceId: "ws-readable" }),
        item("in-hidden", { taskId: "task-hidden", workspaceId: "ws-hidden" }),
        // An item that names another workspace than its session's is not trusted.
        item("mismatched", { taskId: "task-readable", workspaceId: "ws-hidden" }),
        item("gone-session", { taskId: "task-missing" }),
        item("suggestion-hidden", { kind: "suggestion", workspaceId: "ws-hidden" }),
        item("commitment", { kind: "commitment" }),
      ],
    });
    expect(methods.listAttention.capability).toBe("tasks.read");
    expect(methods.listAttention.mutation).toBeUndefined();
    const result = await list();
    expect(result.items.map((entry) => entry.id)).toEqual(["in-readable", "commitment"]);
    expect(result).toMatchObject({ generatedAt: 5, failedSources: ["flows"] });
  });

  it("needs a paired session and says when the queue isn't running", async () => {
    await expect(
      setup({ generatedAt: 1, items: [], failedSources: [] }).list({
        identity: { profileId: "profile-one" },
      } as WebRequestContext),
    ).rejects.toMatchObject({ code: "UNAUTHENTICATED" });
    await expect(setup(null).list()).rejects.toMatchObject({
      code: "HOST_UNAVAILABLE",
      retryable: true,
    });
  });
});
