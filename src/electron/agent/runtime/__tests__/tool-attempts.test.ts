import { describe, expect, it, vi } from "vitest";
import { TOOL_GROUPS, type ToolAttempt } from "../../../../shared/types";
import {
  describeUnverifiedAttempts,
  isToolOutcomeUnknownError,
  ToolAttemptTracker,
  toolIdempotencyKey,
  unresolvedUnknownAttempts,
  type ToolAttemptPersistence,
} from "../tool-attempts";
import { resolveToolEffect, toolCallTarget } from "../tool-effect";

vi.mock("../../../mcp/tool-policy", () => ({ getConfiguredMcpToolPolicy: () => undefined }));

function memoryStore(): ToolAttemptPersistence & { rows: Map<string, ToolAttempt> } {
  const rows = new Map<string, ToolAttempt>();
  return {
    rows,
    begin: async (input) => {
      const attempt: ToolAttempt = { ...input, status: "started" };
      rows.set(input.id, attempt);
      return attempt;
    },
    finish: async (id, status, finishedAt, reason) => {
      const row = rows.get(id);
      if (!row || (row.status !== "started" && row.status !== "unknown")) return row;
      const next = { ...row, status, finishedAt, ...(reason ? { reason } : {}) };
      rows.set(id, next);
      return next;
    },
  };
}

describe("resolveToolEffect", () => {
  it("treats every group:write and group:destructive member as a write", () => {
    for (const name of [...TOOL_GROUPS["group:write"], ...TOOL_GROUPS["group:destructive"]]) {
      expect(resolveToolEffect(name), name).toBe("write");
    }
  });

  it("classifies reads, and MCP tools by their read-only hint", () => {
    expect(resolveToolEffect("read_file")).toBe("read");
    expect(resolveToolEffect("mcp_jira_search", { mcpReadOnly: () => true })).toBe("read");
    expect(resolveToolEffect("mcp_jira_create_issue", { mcpReadOnly: () => false })).toBe(
      "unknown",
    );
    expect(resolveToolEffect("mcp_unannotated", { mcpReadOnly: () => undefined })).toBe("unknown");
  });

  it("finds the target a call acts on", () => {
    expect(toolCallTarget({ path: "report.md", content: "x" })).toBe("report.md");
    expect(toolCallTarget({ url: "https://example.com" })).toBe("https://example.com");
    expect(toolCallTarget({ query: "x" })).toBeUndefined();
  });
});

describe("ToolAttemptTracker", () => {
  it("keys calls by task, step, tool and canonical arguments", () => {
    const key = toolIdempotencyKey("t1", "s1", "write_file", { path: "a", content: "b" });
    expect(key).toMatch(/^[a-f0-9]{32}$/);
    expect(toolIdempotencyKey("t1", "s1", "write_file", { content: "b", path: "a" })).toBe(key);
    expect(toolIdempotencyKey("t1", "s2", "write_file", { path: "a", content: "b" })).not.toBe(key);
  });

  it("records writes only, and completes them", async () => {
    const store = memoryStore();
    const tracker = new ToolAttemptTracker(store, "t1");
    expect(await tracker.begin("read_file", { path: "a" }, "read")).toBeNull();
    const handle = await tracker.begin("write_file", { path: "a", content: "x" }, "write", "s1");
    expect(handle?.attempt).toMatchObject({ status: "started", target: "a", stepId: "s1" });
    await tracker.completed(handle);
    expect(store.rows.get(handle!.attempt.id)?.status).toBe("completed");
  });

  it("turns a timeout after dispatch into an unknown outcome with read-back guidance", async () => {
    const store = memoryStore();
    const tracker = new ToolAttemptTracker(store, "t1");
    const handle = await tracker.begin("write_file", { path: "report.md", content: "x" }, "write");
    const surfaced = await tracker.failed(
      handle,
      new Error("Tool write_file timed out after 30s"),
      false,
    );

    expect(isToolOutcomeUnknownError(surfaced)).toBe(true);
    const message = (surfaced as Error).message;
    expect(message).toContain("Outcome unknown: write_file may have completed");
    expect(message).toContain("Do not repeat it blindly");
    expect(message).toContain("read_file or list_directory on report.md");
    expect(message).toContain(handle!.attempt.idempotencyKey);
    expect(store.rows.get(handle!.attempt.id)?.status).toBe("unknown");

    await tracker.readBack("read_file", { path: "report.md" });
    expect(store.rows.get(handle!.attempt.id)).toMatchObject({
      status: "checked",
      reason: "read_back:read_file",
    });
  });

  it("keeps a definite failure as an error", async () => {
    const store = memoryStore();
    const tracker = new ToolAttemptTracker(store, "t1");
    const handle = await tracker.begin("write_file", { path: "a" }, "write");
    const error = new Error("Path is outside the workspace");
    expect(await tracker.failed(handle, error, false)).toBe(error);
    expect(store.rows.get(handle!.attempt.id)?.status).toBe("failed");
  });

  it("never blocks a call when the store fails", async () => {
    const tracker = new ToolAttemptTracker(
      {
        begin: async () => {
          throw new Error("database unavailable");
        },
        finish: async () => undefined,
      },
      "t1",
    );
    expect(await tracker.begin("write_file", { path: "a" }, "write")).toBeNull();
  });
});

describe("unresolved unknown attempts", () => {
  const attempt = (overrides: Partial<ToolAttempt>): ToolAttempt => ({
    id: "a",
    taskId: "t1",
    toolName: "write_file",
    argsHash: "h",
    idempotencyKey: "k1",
    effect: "write",
    status: "unknown",
    startedAt: 1,
    ...overrides,
  });

  it("are settled by a read-back or a completed retry with the same key", () => {
    expect(unresolvedUnknownAttempts([attempt({})])).toHaveLength(1);
    expect(unresolvedUnknownAttempts([attempt({ status: "checked" })])).toHaveLength(0);
    expect(
      unresolvedUnknownAttempts([attempt({}), attempt({ id: "b", status: "completed" })]),
    ).toHaveLength(0);
    expect(
      unresolvedUnknownAttempts([
        attempt({}),
        attempt({ id: "b", status: "completed", idempotencyKey: "k2" }),
      ]),
    ).toHaveLength(1);
  });

  it("are named in the completion note", () => {
    expect(describeUnverifiedAttempts([attempt({ target: "report.md" })])).toMatch(
      /^Not verified: write_file on report\.md\. This call may or may not have taken effect/,
    );
  });
});
