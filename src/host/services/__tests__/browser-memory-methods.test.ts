import { afterEach, describe, expect, it, vi } from "vitest";
import { CuratedMemoryService } from "../../../electron/memory/CuratedMemoryService";
import { MemorySynthesizer } from "../../../electron/memory/MemorySynthesizer";
import { MemoryWriteGate } from "../../../electron/memory/MemoryWriteGate";
import { MemoryService } from "../../../electron/memory/MemoryService";
import { MemoryObservationService } from "../../../electron/memory/MemoryObservationService";
import { ChronicleObservationRepository } from "../../../electron/chronicle/ChronicleObservationRepository";
import type { Workspace } from "../../../shared/types";
import { createBrowserMemoryDefinitions } from "../browser-memory-methods";

const workspace = {
  id: "workspace-one",
  path: "/work/one",
  permissions: { read: true, write: true, delete: true },
} as Workspace;
function setup(resolved: Workspace | null = workspace) {
  const resolveWorkspace = vi.fn(async () => resolved);
  const definitions = createBrowserMemoryDefinitions({ resolveWorkspace });
  const call = async (name: string, args: unknown[] = []) => {
    const method = definitions[name];
    return method.handler(method.validate?.(args) ?? args, {} as never);
  };
  return { call, resolveWorkspace, definitions };
}
afterEach(() => vi.restoreAllMocks());

describe("browser memory services", () => {
  it("checks current workspace permission before reads, imports, edits and deletes", async () => {
    const get = vi.spyOn(MemoryService, "getSettings");
    const save = vi.spyOn(MemoryService, "updateSettings");
    const remove = vi.spyOn(MemoryService, "deleteImportedEntry");
    const imported = vi.spyOn(MemoryService, "importFromText");
    const { call } = setup({
      ...workspace,
      permissions: { ...workspace.permissions, read: false },
    });
    for (const [name, args] of [
      ["getMemorySettings", [workspace.id]],
      ["saveMemorySettings", [{ workspaceId: workspace.id, settings: { enabled: false } }]],
      ["deleteImportedMemoryEntry", [{ workspaceId: workspace.id, memoryId: "memory-one" }]],
      [
        "importMemoryFromText",
        [{ workspaceId: workspace.id, provider: "QA", pastedText: "Disposable test memory." }],
      ],
    ] as Array<[string, unknown[]]>) {
      await expect(call(name, args)).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
    expect(get).not.toHaveBeenCalled();
    expect(save).not.toHaveBeenCalled();
    expect(remove).not.toHaveBeenCalled();
    expect(imported).not.toHaveBeenCalled();
  });

  it("requires delete authority independently from workspace write authority", async () => {
    vi.spyOn(MemoryService, "updateSettings").mockResolvedValue(undefined);
    const remove = vi.spyOn(MemoryService, "deleteImported");
    const { call } = setup({
      ...workspace,
      permissions: { ...workspace.permissions, delete: false },
    });
    await expect(
      call("saveMemorySettings", [{ workspaceId: workspace.id, settings: { retentionDays: 30 } }]),
    ).resolves.toEqual({ success: true });
    await expect(call("deleteImportedMemories", [workspace.id])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(remove).not.toHaveBeenCalled();
  });

  it("authorizes details and timeline by the stored memory workspace", async () => {
    vi.spyOn(MemoryService, "getFullDetails").mockResolvedValue([
      { id: "memory-one", workspaceId: "private-workspace" },
    ] as never);
    const timeline = vi.spyOn(MemoryService, "getTimelineContext");
    const { call, resolveWorkspace } = setup(null);
    await expect(call("getMemoryDetails", [["memory-one"]])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(call("getMemoryTimeline", [{ memoryId: "memory-one" }])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(resolveWorkspace).toHaveBeenCalledWith("private-workspace");
    expect(timeline).not.toHaveBeenCalled();
  });

  it("rejects unbounded pages and settings identifiers before touching services", async () => {
    const imported = vi.spyOn(MemoryService, "findImported");
    const settings = vi.spyOn(MemoryService, "updateSettings");
    const { call } = setup();
    await expect(
      call("findImportedMemories", [{ workspaceId: workspace.id, limit: 201 }]),
    ).rejects.toThrow();
    await expect(
      call("saveMemorySettings", [
        { workspaceId: workspace.id, settings: { workspaceId: "other-workspace" } },
      ]),
    ).rejects.toThrow();
    expect(imported).not.toHaveBeenCalled();
    expect(settings).not.toHaveBeenCalled();
  });

  it("passes paginated reads and does not turn service failures into empty results", async () => {
    const imported = vi.spyOn(MemoryService, "findImported").mockResolvedValue([]);
    vi.spyOn(MemoryService, "getStats").mockRejectedValue(new Error("Memory storage unavailable"));
    const { call } = setup();
    await call("findImportedMemories", [{ workspaceId: workspace.id, limit: 20, offset: 40 }]);
    expect(imported).toHaveBeenCalledWith(workspace.id, 20, 40);
    await expect(call("getMemoryStats", [workspace.id])).rejects.toThrow(
      "Memory storage unavailable",
    );
  });

  it("restricts observation edits to the requested authorized workspace", async () => {
    const update = vi.spyOn(MemoryObservationService, "update").mockResolvedValue(null as never);
    const { call, definitions } = setup();
    await call("updateMemoryObservation", [
      { workspaceId: workspace.id, memoryId: "memory-one", patch: { privacyState: "suppressed" } },
    ]);
    expect(update).toHaveBeenCalledWith(workspace.id, "memory-one", { privacyState: "suppressed" });
    expect(definitions.updateMemoryObservation.mutation).toBe(true);
  });

  it("returns a Chronicle display DTO without local asset or file paths", async () => {
    vi.spyOn(ChronicleObservationRepository, "list").mockResolvedValue([
      {
        id: "observation",
        appName: "QA",
        capturedAt: 1,
        windowTitle: "Disposable",
        imagePath: "/private/image.png",
        workspaceId: workspace.id,
      },
    ] as never);
    const { call } = setup();
    const result = await call("listChronicleObservations", [{ workspaceId: workspace.id }]);
    expect(JSON.stringify(result)).not.toContain("/private");
    expect(result).toEqual([expect.objectContaining({ id: "observation", appName: "QA" })]);
  });

  it("no longer exposes profile fact editors (facts are edited in the Memory Hub)", () => {
    const { definitions } = setup();
    for (const name of [
      "addUserFact",
      "updateUserFact",
      "deleteUserFact",
      "cleanupRecurringRelationshipHistory",
    ]) {
      expect(definitions[name]).toBeUndefined();
    }
  });
  it("authorizes approval records using their stored workspace and returns only display DTOs", async () => {
    const pending = {
      id: "pending-one",
      workspaceId: workspace.id,
      target: "archive",
      action: "capture",
      payload: {},
    } as never;
    vi.spyOn(MemoryWriteGate, "findPending").mockResolvedValue(pending);
    const display = vi
      .spyOn(MemoryWriteGate, "findPendingForDisplay")
      .mockResolvedValue({ id: "pending-one", payload: { apiKey: "[redacted]" } } as never);
    const apply = vi
      .spyOn(MemoryWriteGate, "applyPending")
      .mockResolvedValue({ status: "applied" } as never);
    const reject = vi
      .spyOn(MemoryWriteGate, "rejectForDisplay")
      .mockResolvedValue({ status: "rejected" } as never);
    const { call } = setup();
    await expect(call("getMemoryWriteApproval", ["pending-one"])).resolves.toMatchObject({
      payload: { apiKey: "[redacted]" },
    });
    expect(display).toHaveBeenCalledWith("pending-one");
    await expect(
      call("approveMemoryWriteApproval", [{ id: "pending-one", workspaceId: "wrong-workspace" }]),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(apply).not.toHaveBeenCalled();
    await call("approveMemoryWriteApproval", [{ id: "pending-one", workspaceId: workspace.id }]);
    expect(apply).toHaveBeenCalledWith("pending-one", {
      workspaceId: workspace.id,
      reviewedBy: "user",
      effectiveWorkspace: workspace,
    });
    await call("rejectMemoryWriteApproval", [
      { id: "pending-one", workspaceId: workspace.id, reason: "Disposable rejection" },
    ]);
    expect(reject).toHaveBeenCalledWith("pending-one", {
      workspaceId: workspace.id,
      reviewedBy: "user",
      resolution: "Disposable rejection",
    });
    const denied = setup({ ...workspace, permissions: { ...workspace.permissions, write: false } });
    await expect(
      denied.call("approveMemoryWriteApproval", [{ id: "pending-one", workspaceId: workspace.id }]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("requires delete authority for removal approvals and automatic network access for external writes", async () => {
    const find = vi.spyOn(MemoryWriteGate, "findPending");
    const apply = vi.spyOn(MemoryWriteGate, "applyPending");
    const { call } = setup({
      ...workspace,
      permissions: {
        ...workspace.permissions,
        delete: false,
        network: true,
        accessNetworkMode: "on-request",
      },
    });
    find.mockResolvedValue({
      workspaceId: workspace.id,
      target: "curated",
      action: "curate",
      payload: { action: "remove" },
    } as never);
    await expect(
      call("approveMemoryWriteApproval", [{ id: "remove-one", workspaceId: workspace.id }]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    find.mockResolvedValue({
      workspaceId: workspace.id,
      target: "external",
      action: "remember",
      payload: {},
    } as never);
    await expect(
      call("approveMemoryWriteApproval", [{ id: "external-one", workspaceId: workspace.id }]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(apply).not.toHaveBeenCalled();
  });

  it("keeps approval lists bounded and propagates read failures", async () => {
    const list = vi
      .spyOn(MemoryWriteGate, "listPendingForDisplay")
      .mockRejectedValue(new Error("Unavailable approval storage"));
    const { call } = setup();
    await expect(
      call("listMemoryWriteApprovals", [{ workspaceId: workspace.id, limit: 201 }]),
    ).rejects.toThrow();
    expect(list).not.toHaveBeenCalled();
    await expect(
      call("listMemoryWriteApprovals", [{ workspaceId: workspace.id, limit: 50 }]),
    ).rejects.toThrow("Unavailable approval storage");
    expect(list).toHaveBeenCalledWith(workspace.id, 50);
  });
  it("promotes only an observation in the authorized workspace with filesystem policy guards", async () => {
    const details = vi
      .spyOn(MemoryObservationService, "details")
      .mockResolvedValue([
        { workspaceId: workspace.id, taskId: "task-one", title: "Disposable promoted fact" },
      ] as never);
    const curate = vi.spyOn(CuratedMemoryService, "curate").mockResolvedValue({ success: true });
    const { call } = setup();
    await call("promoteMemoryObservation", [
      { workspaceId: workspace.id, memoryId: "observation-one" },
    ]);
    expect(curate).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: workspace.id,
        taskId: "task-one",
        content: "Disposable promoted fact",
        target: "workspace",
        action: "add",
        filesystemReadGuard: expect.any(Function),
        filesystemWriteGuard: expect.any(Function),
      }),
    );
    details.mockResolvedValue([
      { workspaceId: "another-workspace", title: "Private other workspace" },
    ] as never);
    await expect(
      call("promoteMemoryObservation", [
        { workspaceId: workspace.id, memoryId: "other-observation" },
      ]),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(curate).toHaveBeenCalledTimes(1);
    details.mockResolvedValue([{ workspaceId: workspace.id, title: "Disposable fact" }] as never);
    curate.mockResolvedValue({ success: false, error: "File policy denied" });
    await expect(
      call("promoteMemoryObservation", [
        { workspaceId: workspace.id, memoryId: "observation-one" },
      ]),
    ).rejects.toMatchObject({ code: "CONFLICT", message: "File policy denied" });
    const readonly = setup({
      ...workspace,
      permissions: { ...workspace.permissions, write: false },
    });
    await expect(
      readonly.call("promoteMemoryObservation", [
        { workspaceId: workspace.id, memoryId: "observation-one" },
      ]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("builds a guarded layer preview from the authorized recent task and propagates failures", async () => {
    const prefetch = vi.spyOn(MemorySynthesizer, "prefetchBoxBrainHits").mockResolvedValue([]);
    const preview = vi
      .spyOn(MemorySynthesizer, "buildLayerPreview")
      .mockResolvedValue({ workspaceId: workspace.id, layers: [] } as never);
    const definitions = createBrowserMemoryDefinitions({
      resolveWorkspace: async () => workspace,
      getRecentTask: async () => ({
        prompt: "Disposable recent task",
        assignedAgentRoleId: "role-one",
      }),
    });
    await definitions.getMemoryLayerPreview.handler([workspace.id], {} as never);
    expect(prefetch).toHaveBeenCalledWith(workspace.id, "Disposable recent task");
    expect(preview).toHaveBeenCalledWith(
      workspace.id,
      workspace.path,
      "Disposable recent task",
      expect.objectContaining({
        workspaceCanRead: true,
        agentRoleId: "role-one",
        boxBrainHits: [],
        filesystemReadGuard: expect.any(Function),
      }),
    );
    preview.mockRejectedValue(new Error("Layer storage unavailable"));
    await expect(
      definitions.getMemoryLayerPreview.handler([workspace.id], {} as never),
    ).rejects.toThrow("Layer storage unavailable");
  });
});

describe("browser memory items (What CoWork knows)", () => {
  const WS = "7b0f8e4c-3a52-4d8e-9b1a-2f6c1d9e0a11";
  function setupItems(permissions: Partial<Workspace["permissions"]>) {
    const memoryItems = {
      list: vi.fn(async () => ({ items: [], total: 0, offset: 0, hasMore: false })),
      delete: vi.fn(async () => ({ success: true, item: null })),
      add: vi.fn(async () => ({ success: true, item: null })),
      clearGlobal: vi.fn(async () => ({ success: true, deleted: 0 })),
    };
    const definitions = createBrowserMemoryDefinitions({
      resolveWorkspace: async () =>
        ({
          ...workspace,
          id: WS,
          permissions: { ...workspace.permissions, ...permissions },
        }) as Workspace,
      memoryItems: memoryItems as never,
    });
    const call = async (name: string, args: unknown[]) => {
      const method = definitions[name];
      return method.handler(method.validate?.(args) ?? args, {} as never);
    };
    return { memoryItems, call, definitions };
  }

  it("exposes the desktop method names", () => {
    const { definitions } = setupItems({});
    for (const name of [
      "listMemoryItems",
      "getMemoryItem",
      "getMemoryItemWhy",
      "addMemoryItem",
      "updateMemoryItem",
      "setMemoryItemPinned",
      "deleteMemoryItem",
      "clearGlobalMemoryItems",
    ]) {
      expect(definitions[name]).toBeDefined();
    }
  });

  it("checks workspace read, write and delete authority", async () => {
    const readOnly = setupItems({ write: false, delete: false });
    await expect(readOnly.call("listMemoryItems", [{ workspaceId: WS }])).resolves.toMatchObject({
      total: 0,
    });
    await expect(
      readOnly.call("addMemoryItem", [
        { workspaceId: WS, content: "Prefers tea", kind: "preference", scope: "global" },
      ]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      readOnly.call("deleteMemoryItem", [{ workspaceId: WS, id: "item-1" }]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      readOnly.call("clearGlobalMemoryItems", [{ workspaceId: WS, confirm: true }]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(readOnly.memoryItems.add).not.toHaveBeenCalled();
    expect(readOnly.memoryItems.delete).not.toHaveBeenCalled();
    expect(readOnly.memoryItems.clearGlobal).not.toHaveBeenCalled();

    const full = setupItems({});
    await full.call("deleteMemoryItem", [{ workspaceId: WS, id: "item-1" }]);
    expect(full.memoryItems.delete).toHaveBeenCalledWith({ workspaceId: WS, id: "item-1" });
  });

  it("attributes memory used per reply, like the desktop IPC", async () => {
    const loadMemoryUsedTimeline = vi.fn(async (workspaceId: string, taskId: string) =>
      workspaceId === WS && taskId === "task-1"
        ? [
            { id: "u1", type: "user_message", timestamp: 1, payload: {} },
            {
              id: "m1",
              type: "memory_used",
              timestamp: 2,
              payload: { surface: "chat", refs: ["memory:item-1"] },
            },
            { id: "r1", type: "assistant_message", timestamp: 3, payload: {} },
          ]
        : null,
    );
    const definitions = createBrowserMemoryDefinitions({
      resolveWorkspace: async (workspaceId) =>
        workspaceId === WS ? ({ ...workspace, id: WS } as Workspace) : null,
      memoryItems: {} as never,
      loadMemoryUsedTimeline,
    });
    const method = definitions.getMemoryUsedForTask;
    expect(method).toBeDefined();
    const call = (args: unknown[]) => method.handler(method.validate?.(args) ?? args, {} as never);

    await expect(call([{ workspaceId: WS, taskId: "task-1" }])).resolves.toMatchObject({
      taskId: "task-1",
      replies: { r1: { refs: ["memory:item-1"], surfaces: ["chat"] } },
      replyEventIds: ["r1"],
    });
    // A task outside the workspace reads as "nothing used".
    await expect(call([{ workspaceId: WS, taskId: "other" }])).resolves.toMatchObject({
      replies: {},
      replyEventIds: [],
    });
    await expect(
      call([{ workspaceId: "8c1f9e5d-4b63-4e9f-8c2b-3a7d2e0f1b22", taskId: "task-1" }]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(() => method.validate?.([{ workspaceId: WS, taskId: "task-1", extra: 1 }])).toThrow();
  });

  it("validates payloads with the desktop schemas", async () => {
    const { call, memoryItems } = setupItems({});
    await expect(
      call("addMemoryItem", [
        {
          workspaceId: WS,
          content: "Prefers tea",
          kind: "preference",
          scope: "global",
          source: "x",
        },
      ]),
    ).rejects.toThrow();
    await expect(call("clearGlobalMemoryItems", [{ workspaceId: WS }])).rejects.toThrow();
    expect(memoryItems.add).not.toHaveBeenCalled();
  });
});

describe("browser memory hub sources and health", () => {
  const WS = "7b0f8e4c-3a52-4d8e-9b1a-2f6c1d9e0a11";
  function setupHealth(permissions: Partial<Workspace["permissions"]>, withService = true) {
    const memoryHealth = {
      sources: vi.fn(async (workspaceId: string) => ({ workspaceId })),
      health: vi.fn(async () => ({ generatedAt: 1, checks: [], ok: true })),
    };
    const definitions = createBrowserMemoryDefinitions({
      resolveWorkspace: async () =>
        ({
          ...workspace,
          id: WS,
          permissions: { ...workspace.permissions, ...permissions },
        }) as Workspace,
      memoryItems: {} as never,
      ...(withService ? { memoryHealth: memoryHealth as never } : {}),
    });
    const call = async (name: string, args: unknown[]) => {
      const method = definitions[name];
      return method.handler(method.validate?.(args) ?? args, {} as never);
    };
    return { memoryHealth, call, definitions };
  }

  it("exposes the desktop methods as reads behind workspace read authority", async () => {
    const { call, definitions, memoryHealth } = setupHealth({ write: false, delete: false });
    expect(definitions.getMemorySources.mutation).toBe(false);
    expect(definitions.getMemoryHealth.mutation).toBe(false);
    await expect(call("getMemorySources", [{ workspaceId: WS }])).resolves.toEqual({
      workspaceId: WS,
    });
    await expect(call("getMemoryHealth", [{ workspaceId: WS }])).resolves.toMatchObject({
      ok: true,
    });
    expect(memoryHealth.sources).toHaveBeenCalledWith(WS);

    const denied = setupHealth({ read: false });
    await expect(denied.call("getMemoryHealth", [{ workspaceId: WS }])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(denied.memoryHealth.health).not.toHaveBeenCalled();
  });

  it("validates payloads with the desktop schema and reports a missing database", async () => {
    const { call, memoryHealth } = setupHealth({});
    await expect(call("getMemorySources", [{ workspaceId: WS, extra: 1 }])).rejects.toThrow();
    await expect(call("getMemorySources", [{ workspaceId: "../x" }])).rejects.toThrow();
    expect(memoryHealth.sources).not.toHaveBeenCalled();

    const unavailable = setupHealth({}, false);
    await expect(unavailable.call("getMemoryHealth", [{ workspaceId: WS }])).rejects.toMatchObject({
      code: "HOST_UNAVAILABLE",
    });
  });
});

describe("browser memory folder methods", () => {
  it("mirrors the desktop memoryRepo methods except opening the folder", async () => {
    const { MemoryRepoService } = await import("../../../electron/memory/repo/MemoryRepoService");
    MemoryRepoService.setInstance(null);
    const { call, definitions } = setup();
    expect(definitions.getMemoryRepoStatus.mutation).toBe(false);
    expect(definitions.compactMemoryRepoHistory.mutation).toBe(true);
    expect(definitions.readMemoryRepoLines.mutation).toBe(false);
    expect(definitions.openMemoryRepoFolder).toBeUndefined();

    await expect(call("compactMemoryRepoHistory")).resolves.toEqual({
      compacted: false,
      error: "The memory folder is off.",
    });
    await expect(call("readMemoryRepoLines", [["repo:me.md#L1"]])).resolves.toEqual([]);
    for (const refs of [[], ["repo:../x.md#L1"], ["repo:.git/config#L1"], "repo:me.md#L1"]) {
      await expect(call("readMemoryRepoLines", [refs])).rejects.toThrow();
    }
  });

  it("mirrors the desktop dream methods with the same validation", async () => {
    const { MemoryRepoService } = await import("../../../electron/memory/repo/MemoryRepoService");
    MemoryRepoService.setInstance(null);
    const { call, definitions } = setup();
    expect(definitions.getMemoryRepoDreams.mutation).toBe(false);
    expect(definitions.getMemoryRepoDreamDiff.mutation).toBe(false);
    for (const name of [
      "acceptMemoryRepoDream",
      "rejectMemoryRepoDream",
      "undoMemoryRepoDream",
      "dreamMemoryRepoNow",
    ]) {
      expect(definitions[name].mutation).toBe(true);
    }
    await expect(call("getMemoryRepoDreams")).resolves.toMatchObject({
      folderReady: false,
      dreams: [],
      pendingReviews: 0,
    });
    await expect(call("getMemoryRepoDreamDiff", ["d-1", "review"])).resolves.toBe("");
    await expect(call("acceptMemoryRepoDream", ["d-1"])).resolves.toEqual({
      ok: false,
      error: "The memory folder is off.",
    });
    await expect(call("dreamMemoryRepoNow")).resolves.toEqual({
      ran: false,
      reason: "unavailable",
    });
    for (const id of ["", "../x", "a/b", "x".repeat(65), 7]) {
      await expect(call("undoMemoryRepoDream", [id])).rejects.toThrow();
    }
    await expect(call("getMemoryRepoDreamDiff", ["d-1", "branch"])).rejects.toThrow();
  });
});
