import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspacePermissionRuleStore } from "../repositories";

vi.mock("uuid", () => ({
  v4: vi.fn(() => "rule-123"),
}));

type MockRow = {
  id: string;
  workspace_id: string;
  effect: string;
  scope_kind: string;
  scope_tool_name: string | null;
  scope_path: string | null;
  scope_prefix: string | null;
  scope_server_name: string | null;
  metadata_json: string | null;
  created_at: number;
  updated_at: number;
};

describe("WorkspacePermissionRuleStore", () => {
  let rows: MockRow[];
  let repository: WorkspacePermissionRuleStore;

  beforeEach(() => {
    rows = [];
    const db = {
      prepare: vi.fn((sql: string) => {
        if (sql.includes("INSERT INTO workspace_permission_rules")) {
          return {
            run: (
              id: string,
              workspaceId: string,
              effect: string,
              scopeKind: string,
              scopeToolName: string | null,
              scopePath: string | null,
              scopePrefix: string | null,
              scopeServerName: string | null,
              metadataJson: string | null,
              createdAt: number,
              updatedAt: number,
            ) => {
              rows.push({
                id,
                workspace_id: workspaceId,
                effect,
                scope_kind: scopeKind,
                scope_tool_name: scopeToolName,
                scope_path: scopePath,
                scope_prefix: scopePrefix,
                scope_server_name: scopeServerName,
                metadata_json: metadataJson,
                created_at: createdAt,
                updated_at: updatedAt,
              });
              return { changes: 1 };
            },
          };
        }

        if (sql.includes("SELECT *\n      FROM workspace_permission_rules")) {
          return {
            all: (workspaceId: string) =>
              rows
                .filter((row) => row.workspace_id === workspaceId)
                .sort((a, b) => b.updated_at - a.updated_at || b.created_at - a.created_at),
          };
        }

        if (sql.includes("SELECT * FROM workspace_permission_rules WHERE id = ?")) {
          return {
            get: (id: string) => rows.find((row) => row.id === id),
          };
        }

        if (sql.includes("DELETE FROM workspace_permission_rules WHERE id = ?")) {
          return {
            run: (id: string) => {
              const before = rows.length;
              rows = rows.filter((row) => row.id !== id);
              return { changes: before - rows.length };
            },
          };
        }

        throw new Error(`Unexpected SQL: ${sql}`);
      }),
    } as Any;

    repository = new WorkspacePermissionRuleStore(db);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("creates, lists, and deletes workspace-local rules", () => {
    const created = repository.create({
      workspaceId: "workspace-1",
      effect: "allow",
      scope: {
        kind: "path",
        toolName: "edit_file",
        path: "/tmp/workspace/src",
      },
      metadata: { source: "approval" },
    });

    expect(created).toEqual(
      expect.objectContaining({
        id: "rule-123",
        workspaceId: "workspace-1",
        source: "workspace_db",
        effect: "allow",
        scope: {
          kind: "path",
          toolName: "edit_file",
          path: "/tmp/workspace/src",
        },
        metadata: { source: "approval" },
      }),
    );

    expect(repository.listByWorkspaceId("workspace-1")).toHaveLength(1);

    const deleted = repository.deleteById(created.id);
    expect(deleted).toEqual(created);
    expect(repository.listByWorkspaceId("workspace-1")).toEqual([]);
  });

  it("returns null when deleting a missing rule", () => {
    expect(repository.deleteById("missing-rule")).toBeNull();
  });

  it("does not delete a rule when the workspace id does not match", () => {
    const created = repository.create({
      workspaceId: "workspace-1",
      effect: "allow",
      scope: {
        kind: "tool",
        toolName: "open_url",
      },
    });

    expect(repository.deleteByWorkspaceAndId("workspace-2", created.id)).toBeNull();
    expect(repository.listByWorkspaceId("workspace-1")).toEqual([
      expect.objectContaining({
        id: created.id,
        workspaceId: "workspace-1",
        effect: "allow",
        scope: {
          kind: "tool",
          toolName: "open_url",
        },
      }),
    ]);
  });
});
