import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { BoxSettingsData, Workspace } from "../../../shared/types";
import type { MCPCallResult, MCPServerConfig, MCPTool } from "../../mcp/types";
import {
  BoxBrainService,
  extractBoxMcpEntries,
  extractBoxMcpNextMarker,
  extractBoxMcpText,
} from "../BoxBrainService";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Database = module.default;
      const probe = new Database(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

const makeTool = (name: string): MCPTool => ({
  name,
  inputSchema: { type: "object" },
});

describe("Box Brain MCP response parsing", () => {
  it("unwraps text envelopes, entries, pagination, and document text", () => {
    const listing = {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            entries: [{ id: "file-1", type: "file", name: "Policy.md" }],
            next_marker: "marker-2",
          }),
        },
      ],
    };

    expect(extractBoxMcpEntries(listing)).toEqual([
      { id: "file-1", type: "file", name: "Policy.md" },
    ]);
    expect(extractBoxMcpNextMarker(listing)).toBe("marker-2");
    expect(
      extractBoxMcpText({
        content: [{ type: "text", text: JSON.stringify({ text: "company policy" }) }],
      }),
    ).toBe("company policy");
  });
});

describeWithSqlite("BoxBrainService", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: import("../../database/schema").DatabaseManager;
  let db: ReturnType<import("../../database/schema").DatabaseManager["getDatabase"]>;
  let workspace: Workspace;

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-box-brain-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;

    const { DatabaseManager } = await import("../../database/schema");
    manager = new DatabaseManager();
    db = manager.getDatabase();

    const workspacePath = path.join(tmpDir, "workspace");
    fs.mkdirSync(workspacePath, { recursive: true });
    workspace = {
      id: randomUUID(),
      name: "Box Brain test workspace",
      path: workspacePath,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: true,
      },
    };
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions) VALUES (?, ?, ?, ?, ?, ?)",
    ).run(
      workspace.id,
      workspace.name,
      workspace.path,
      workspace.createdAt,
      workspace.lastUsedAt,
      JSON.stringify(workspace.permissions),
    );

    // The fake capture callback returns this stable ID. Seeding it also
    // exercises the foreign key from box_brain_items.memory_id.
    const now = Date.now();
    db.prepare(
      "INSERT INTO memories (id, workspace_id, type, content, summary, tokens, is_compressed, is_private, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
    ).run(
      "memory-1",
      workspace.id,
      "observation",
      "old Box reference",
      "old Box reference",
      3,
      1,
      1,
      now,
      now,
    );
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("indexes incrementally, replaces changed memories, cleans deletions, and runs review", async () => {
    let entries: Array<Record<string, unknown>> = [
      {
        id: "file-1",
        type: "file",
        name: "Policy.md",
        etag: "1",
        size: 42,
        modified_at: "2026-08-29T08:00:00Z",
      },
    ];
    let documentText = "The current approval policy requires review.";
    const now = 1_800_000_000_000;
    const settings: BoxSettingsData = {
      enabled: true,
      accessToken: "test-access-token",
      mcpEnabled: true,
      brain: {
        enabled: true,
        workspaceId: workspace.id,
        rootFolderId: "0",
        syncIntervalMinutes: 60,
        maxItemsPerRun: 20,
        includeContent: true,
        useBoxAiSummaries: false,
        improvementEnabled: true,
        maxContentChars: 10000,
      },
    };
    const server: MCPServerConfig = {
      id: "box-server",
      name: "Box MCP",
      enabled: true,
      transport: "streamable-http",
      url: "https://mcp.box.com",
    };
    const tools = [makeTool("list_folder_content_by_folder_id"), makeTool("get_file_content")];
    const callServerTool = vi.fn(
      async (_serverId: string, toolName: string, _args?: Record<string, unknown>) => {
        const result =
          toolName === "list_folder_content_by_folder_id"
            ? { entries, next_marker: null }
            : { text: documentText };
        return {
          content: [{ type: "text", text: JSON.stringify(result) }],
        } satisfies MCPCallResult;
      },
    );
    const mcpManager = {
      connectServer: vi.fn(async () => undefined),
      getServerTools: vi.fn(() => tools),
      callServerTool,
    };
    const memory = {
      id: "memory-1",
      workspaceId: workspace.id,
      type: "observation" as const,
      content: "indexed Box reference",
      summary: "indexed Box reference",
      tokens: 3,
      isCompressed: true,
      isPrivate: true,
      createdAt: now,
      updatedAt: now,
    };
    const captureMemory = vi.fn(async () => memory);
    const replaceMemory = vi.fn(async () => memory);
    const deleteMemoryEntries = vi.fn();
    const runDreaming = vi.fn(async () => ({
      run: { id: "dream-run-1" },
      candidates: [],
    }));

    const service = new BoxBrainService(db, {
      getSettings: () => settings,
      getMcpManager: () => mcpManager,
      getBoxMcpServer: () => server,
      listWorkspaces: () => [workspace],
      captureMemory,
      replaceMemory,
      deleteMemoryEntries,
      runDreaming,
      now: () => now,
      wait: async () => undefined,
    });

    const first = await service.syncNow();
    expect(first).toMatchObject({
      success: true,
      status: "completed",
      discoveredCount: 1,
      indexedCount: 1,
      unchangedCount: 0,
      deletedCount: 0,
      improvementRunId: "dream-run-1",
    });
    expect(captureMemory).toHaveBeenCalledTimes(1);
    expect(runDreaming).toHaveBeenCalledTimes(1);
    expect(callServerTool).toHaveBeenCalledWith("box-server", "get_file_content", {
      file_id: "file-1",
    });
    expect(service.listItems(workspace.id)[0]).toMatchObject({
      boxId: "file-1",
      status: "indexed",
      memoryId: "memory-1",
      sourceUrl: "https://app.box.com/file/file-1",
    });

    const second = await service.syncNow();
    expect(second).toMatchObject({
      success: true,
      unchangedCount: 1,
      indexedCount: 0,
    });
    expect(captureMemory).toHaveBeenCalledTimes(1);
    expect(replaceMemory).toHaveBeenCalledTimes(0);
    expect(callServerTool).toHaveBeenCalledTimes(3);

    entries = [{ ...entries[0], etag: "2" }];
    documentText = "The updated approval policy requires two reviewers.";
    const third = await service.syncNow();
    expect(third).toMatchObject({ success: true, indexedCount: 1, unchangedCount: 0 });
    expect(replaceMemory).toHaveBeenCalledTimes(1);

    entries = [{ ...entries[0], name: "Renamed.md", etag: "2" }];
    const renamed = await service.syncNow();
    expect(renamed).toMatchObject({ success: true, indexedCount: 1, unchangedCount: 0 });
    expect(replaceMemory).toHaveBeenCalledTimes(2);

    entries = [];
    const fourth = await service.syncNow();
    expect(fourth).toMatchObject({ success: true, deletedCount: 1 });
    expect(deleteMemoryEntries).toHaveBeenCalledWith(workspace.id, ["memory-1"]);
    expect(service.listItems(workspace.id)[0]).toMatchObject({
      boxId: "file-1",
      status: "deleted",
    });
  });

  it("preserves unseen items when a paginated crawl reaches the run cap", async () => {
    let entries: Array<Record<string, unknown>> = [
      {
        id: "file-old",
        type: "file",
        name: "Old.md",
        etag: "1",
        size: 10,
      },
    ];
    const settings: BoxSettingsData = {
      enabled: true,
      accessToken: "test-access-token",
      mcpEnabled: true,
      brain: {
        enabled: true,
        workspaceId: workspace.id,
        rootFolderId: "0",
        syncIntervalMinutes: 60,
        maxItemsPerRun: 20,
        includeContent: true,
        useBoxAiSummaries: false,
        improvementEnabled: false,
        maxContentChars: 10000,
      },
    };
    const server: MCPServerConfig = {
      id: "box-server-capped",
      name: "Box MCP",
      enabled: true,
      transport: "streamable-http",
      url: "https://mcp.box.com",
    };
    const tools = [makeTool("list_folder_content_by_folder_id"), makeTool("get_file_content")];
    const callServerTool = vi.fn(
      async (_serverId: string, toolName: string, args?: Record<string, unknown>) => {
        if (toolName === "list_folder_content_by_folder_id") {
          const page = args?.marker
            ? { entries: [], next_marker: null }
            : {
                entries,
                next_marker: settings.brain?.maxItemsPerRun === 1 ? "page-2" : null,
              };
          return {
            content: [{ type: "text", text: JSON.stringify(page) }],
          } satisfies MCPCallResult;
        }
        return {
          content: [{ type: "text", text: JSON.stringify({ text: "reference text" }) }],
        } satisfies MCPCallResult;
      },
    );
    const mcpManager = {
      connectServer: vi.fn(async () => undefined),
      getServerTools: vi.fn(() => tools),
      callServerTool,
    };
    let captureCount = 0;
    const captureMemory = vi.fn(async () => {
      captureCount += 1;
      const id = `memory-capped-${captureCount}`;
      const timestamp = Date.now();
      db.prepare(
        "INSERT INTO memories (id, workspace_id, type, content, summary, tokens, is_compressed, is_private, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(
        id,
        workspace.id,
        "observation",
        "indexed Box reference",
        "indexed Box reference",
        3,
        1,
        1,
        timestamp,
        timestamp,
      );
      return {
        id,
        workspaceId: workspace.id,
        type: "observation" as const,
        content: "indexed Box reference",
        summary: "indexed Box reference",
        tokens: 3,
        isCompressed: true,
        isPrivate: true,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
    });
    const deleteMemoryEntries = vi.fn();

    const service = new BoxBrainService(db, {
      getSettings: () => settings,
      getMcpManager: () => mcpManager,
      getBoxMcpServer: () => server,
      listWorkspaces: () => [workspace],
      captureMemory,
      deleteMemoryEntries,
      now: () => Date.now(),
    });

    await service.syncNow();
    expect(service.listItems(workspace.id)).toEqual(
      expect.arrayContaining([expect.objectContaining({ boxId: "file-old", status: "indexed" })]),
    );

    entries = [
      {
        id: "file-new",
        type: "file",
        name: "New.md",
        etag: "2",
        size: 11,
      },
    ];
    settings.brain!.maxItemsPerRun = 1;
    const capped = await service.syncNow();

    expect(capped).toMatchObject({
      success: true,
      status: "partial",
      indexedCount: 1,
      deletedCount: 0,
    });
    expect(deleteMemoryEntries).not.toHaveBeenCalled();
    expect(service.listItems(workspace.id)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ boxId: "file-old", status: "indexed" }),
        expect.objectContaining({ boxId: "file-new", status: "indexed" }),
      ]),
    );
  });
});
