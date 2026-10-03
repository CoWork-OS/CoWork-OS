/**
 * `<no-memory>` blocks every explicit memory write of a task (memory_remember and its
 * deprecated aliases memory_save, memory_curate add/replace, supermemory_remember), and an
 * explicit save is not blocked by the auto-capture setting.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  curate: vi.fn(),
  evaluate: vi.fn(),
  remember: vi.fn(),
  ingest: vi.fn(),
}));

vi.mock("../../../memory/MemoryService", () => ({
  MemoryService: { capture: mocks.capture },
}));
vi.mock("../../../memory/CuratedMemoryService", () => ({
  CuratedMemoryService: {
    curate: mocks.curate,
    list: vi.fn(async () => []),
    syncWorkspaceFiles: vi.fn(async () => undefined),
  },
}));
vi.mock("../../../memory/MemoryWriteGate", () => ({
  MemoryWriteGate: { evaluate: mocks.evaluate },
}));
vi.mock("../../../memory/SupermemoryService", () => ({
  SupermemoryService: { remember: mocks.remember, isConfigured: () => true },
}));
vi.mock("../../../memory/MemoryWriter", () => ({
  MemoryWriter: { get: () => ({ ingest: mocks.ingest }) },
}));
vi.mock("../../../security/access-profile-paths", () => ({
  evaluateWorkspaceFilesystemAccess: () => ({ decision: "allow" }),
}));

import { MemoryTools } from "../memory-tools";
import { SupermemoryTools } from "../supermemory-tools";

const workspace = {
  id: "ws-1",
  name: "test",
  path: "/tmp",
  createdAt: 0,
  permissions: { read: true, write: true, delete: false, network: false, shell: false },
} as Any;

function daemonFor(prompt: string) {
  return {
    logEvent: vi.fn(),
    getTask: vi.fn(() => ({ id: "task-1", prompt, rawPrompt: prompt })),
    getTaskEvents: vi.fn(() => []),
  } as Any;
}

describe("explicit memory writes and <no-memory>", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.evaluate.mockResolvedValue({ allowed: true });
    mocks.capture.mockResolvedValue({ id: "mem-1" });
    mocks.curate.mockResolvedValue({ success: true, entry: { id: "cur-1" } });
    mocks.remember.mockResolvedValue({ containerTag: "tag", memoryIds: ["s-1"] });
    mocks.ingest.mockResolvedValue({
      status: "written",
      action: "inserted",
      item: { id: "item-1", kind: "rule", scope: "workspace", workspaceId: "ws-1", pinned: false },
      supersededIds: [],
      redactions: 0,
    });
  });

  it("blocks memory_remember (facts and history) for a <no-memory> task", async () => {
    const tools = new MemoryTools(workspace, daemonFor("<no-memory> fix the bug"), "task-1");
    for (const kind of ["rule", "outcome"]) {
      const result = await tools.remember({ content: "a fact", kind });
      expect(result.success).toBe(false);
      expect(String(result.error)).toMatch(/no-memory/);
    }
    expect(mocks.evaluate).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("blocks the deprecated memory_save alias for a <no-memory> task", async () => {
    const tools = new MemoryTools(workspace, daemonFor("<no-memory> fix the bug"), "task-1");
    const result = (await tools.executeLegacyAlias("memory_save", {
      content: "a fact",
      type: "insight",
    })) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(result.deprecated).toContain("memory_remember");
    expect(mocks.ingest).not.toHaveBeenCalled();
  });

  it("blocks memory_curate add and replace but allows remove for a <no-memory> task", async () => {
    const tools = new MemoryTools(workspace, daemonFor("<no-memory/> tidy up"), "task-1");
    for (const action of ["add", "replace"] as const) {
      const result = await tools.curate({ action, target: "user", content: "x", match: "y" });
      expect(result.success).toBe(false);
    }
    expect(mocks.curate).not.toHaveBeenCalled();
    const removed = await tools.curate({ action: "remove", target: "user", id: "cur-1" });
    expect(removed.success).toBe(true);
    expect(mocks.curate).toHaveBeenCalledTimes(1);
  });

  it("blocks supermemory_remember for a <no-memory> task", async () => {
    const tools = new SupermemoryTools(workspace, daemonFor("<no-memory> research"), "task-1");
    const result = await tools.remember({ content: "remember this" });
    expect(result.success).toBe(false);
    expect(result.blocked).toBe(true);
    expect(mocks.remember).not.toHaveBeenCalled();
  });

  it("blocks a write whose own content carries <no-memory>", async () => {
    const tools = new MemoryTools(workspace, daemonFor("normal task"), "task-1");
    const result = await tools.remember({ content: "secret plan <no-memory>", kind: "decision" });
    expect(result.success).toBe(false);
    expect(mocks.ingest).not.toHaveBeenCalled();
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("saves history explicitly with forceCapture so autoCapture=false does not block it", async () => {
    const tools = new MemoryTools(workspace, daemonFor("normal task"), "task-1");
    const result = await tools.remember({ content: "Release 2.1 shipped", kind: "outcome" });
    expect(result).toEqual({
      success: true,
      id: "archive:mem-1",
      stored: "archive",
      type: "summary",
    });
    expect(mocks.capture).toHaveBeenCalledWith(
      "ws-1",
      "task-1",
      "summary",
      "Release 2.1 shipped",
      false,
      expect.objectContaining({ origin: "tool", forceCapture: true }),
    );
    // A staged save replays as an explicit save too.
    expect(mocks.evaluate.mock.calls[0][0].payload.options).toEqual({
      origin: "tool",
      forceCapture: true,
    });
  });
});
