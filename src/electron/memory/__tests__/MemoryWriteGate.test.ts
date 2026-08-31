import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryFeaturesManager } from "../../settings/memory-features-manager";

const repoMock = vi.hoisted(() => {
  let records: Any[] = [];
  return {
    reset() {
      records = [];
    },
    create: vi.fn((input: Any) => {
      const record = {
        id: `pending-${records.length + 1}`,
        ...input,
        status: "pending",
        createdAt: Date.now(),
        evidence: input.evidence || [],
      };
      records.push(record);
      return record;
    }),
    list: vi.fn((params: Any = {}) =>
      records.filter(
        (record) =>
          (!params.workspaceId || record.workspaceId === params.workspaceId) &&
          (!params.status || record.status === params.status),
      ),
    ),
    countPending: vi.fn(
      (workspaceId?: string) =>
        records.filter(
          (record) =>
            record.status === "pending" && (!workspaceId || record.workspaceId === workspaceId),
        ).length,
    ),
    findById: vi.fn((id: string) => records.find((record) => record.id === id)),
    updateStatus: vi.fn((id: string, status: string, details: Any = {}) => {
      const record = records.find((item) => item.id === id);
      if (!record) return undefined;
      record.status = status;
      record.resolution = details.resolution;
      return record;
    }),
    updateStatusIfCurrent: vi.fn(
      (id: string, expectedStatus: string, status: string, details: Any = {}) => {
        const record = records.find((item) => item.id === id);
        if (!record || record.status !== expectedStatus) return undefined;
        record.status = status;
        record.resolution = details.resolution;
        record.reviewedBy = details.reviewedBy;
        return record;
      },
    ),
  };
});

const serviceMocks = vi.hoisted(() => ({
  capture: vi.fn(),
  curate: vi.fn(),
  upsertDistilledEntry: vi.fn(),
  remember: vi.fn(),
  mirrorMemory: vi.fn(),
}));

vi.mock("../../database/repositories", () => ({
  PendingMemoryWriteRepository: class {
    create = repoMock.create;
    list = repoMock.list;
    countPending = repoMock.countPending;
    findById = repoMock.findById;
    updateStatus = repoMock.updateStatus;
    updateStatusIfCurrent = repoMock.updateStatusIfCurrent;
  },
  WorkspaceRepository: class {
    findById(id: string) {
      return { id, name: "Workspace One" };
    }
  },
}));

vi.mock("../MemoryService", () => ({
  MemoryService: {
    capture: serviceMocks.capture,
  },
}));

vi.mock("../CuratedMemoryService", () => ({
  CuratedMemoryService: {
    curate: serviceMocks.curate,
    upsertDistilledEntry: serviceMocks.upsertDistilledEntry,
  },
}));

vi.mock("../SupermemoryService", () => ({
  SupermemoryService: {
    remember: serviceMocks.remember,
    mirrorMemory: serviceMocks.mirrorMemory,
  },
}));

import { MemoryWriteGate } from "../MemoryWriteGate";

const baseRequest = {
  workspaceId: "ws-1",
  taskId: "task-1",
  action: "add",
  origin: "agent_tool" as const,
  summary: "Save memory",
  payload: { content: "Important project fact" },
  proposedValue: "Important project fact",
};

describe("MemoryWriteGate", () => {
  beforeEach(() => {
    repoMock.reset();
    serviceMocks.capture.mockReset().mockResolvedValue({ id: "memory-1" });
    serviceMocks.curate.mockReset().mockResolvedValue({ success: true });
    serviceMocks.upsertDistilledEntry.mockReset().mockResolvedValue({ id: "curated-1" });
    serviceMocks.remember.mockReset().mockResolvedValue({
      containerTag: "cowork:ws-1",
      memoryIds: ["external-1"],
    });
    serviceMocks.mirrorMemory.mockReset().mockResolvedValue(undefined);
    MemoryWriteGate.initialize({ getDatabase: () => ({}) } as Any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.COWORK_MEMORY_WRITE_APPROVAL_MODE;
  });

  it("allows writes when approval mode is off", () => {
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryWriteApprovalMode: "off",
    });

    const decision = MemoryWriteGate.evaluate({
      ...baseRequest,
      target: "curated",
    });

    expect(decision).toEqual({ allowed: true });
    expect(MemoryWriteGate.listPending("ws-1")).toHaveLength(0);
  });

  it("stages curated writes in curated_only mode", () => {
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryWriteApprovalMode: "curated_only",
    });

    const decision = MemoryWriteGate.evaluate({
      ...baseRequest,
      target: "curated",
    });

    expect(decision.allowed).toBe(false);
    const pending = MemoryWriteGate.listPending("ws-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.target).toBe("curated");
    expect(pending[0]?.proposedValue).toBe("Important project fact");
  });

  it("stages external writes when overridden by environment", () => {
    process.env.COWORK_MEMORY_WRITE_APPROVAL_MODE = "external_only";
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryWriteApprovalMode: "off",
    });

    const decision = MemoryWriteGate.evaluate({
      ...baseRequest,
      target: "external",
      action: "remember",
    });

    expect(decision.allowed).toBe(false);
    expect(MemoryWriteGate.listPending("ws-1")[0]?.action).toBe("remember");
  });

  it("blocks sensitive external writes without storing pending payloads", () => {
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryWriteApprovalMode: "off",
    });

    const decision = MemoryWriteGate.evaluate({
      ...baseRequest,
      target: "external",
      action: "remember",
      payload: {
        content: "Use api_key=sk-1234567890abcdef for testing",
      },
    });

    expect(decision.allowed).toBe(false);
    expect("blocked" in decision && decision.blocked).toBe(true);
    expect(MemoryWriteGate.listPending("ws-1")).toHaveLength(0);
  });

  it("applies archive pending writes with the write gate bypassed", async () => {
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryWriteApprovalMode: "all",
    });

    const decision = MemoryWriteGate.evaluate({
      ...baseRequest,
      target: "archive",
      payload: {
        type: "decision",
        content: "Use write approval for memory changes",
      },
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed || !("staged" in decision)) throw new Error("Expected staged decision");

    const applied = await MemoryWriteGate.applyPending(decision.pendingId, {
      workspaceId: "ws-1",
      reviewedBy: "test",
    });

    expect(applied.status).toBe("applied");
    expect(serviceMocks.capture).toHaveBeenCalledWith(
      "ws-1",
      "task-1",
      "decision",
      "Use write approval for memory changes",
      false,
      expect.objectContaining({ skipMemoryWriteGate: true }),
    );
  });

  it("rejects pending writes without replaying the payload", () => {
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryWriteApprovalMode: "curated_only",
    });

    const decision = MemoryWriteGate.evaluate({
      ...baseRequest,
      target: "curated",
      payload: {
        action: "add",
        target: "workspace",
        kind: "project_fact",
        content: "Rejected fact",
      },
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed || !("staged" in decision)) throw new Error("Expected staged decision");

    const rejected = MemoryWriteGate.rejectForDisplay(decision.pendingId, {
      workspaceId: "ws-1",
      reviewedBy: "test",
      resolution: "Not useful",
    });

    expect(rejected.status).toBe("rejected");
    expect(serviceMocks.curate).not.toHaveBeenCalled();
  });

  it("applies external remember writes after approval", async () => {
    process.env.COWORK_MEMORY_WRITE_APPROVAL_MODE = "external_only";
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryWriteApprovalMode: "off",
    });

    const decision = MemoryWriteGate.evaluate({
      ...baseRequest,
      target: "external",
      action: "remember",
      payload: {
        content: "External approved memory",
        containerTag: "cowork:ws-1",
        metadata: { source: "test" },
      },
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed || !("staged" in decision)) throw new Error("Expected staged decision");

    await MemoryWriteGate.applyPending(decision.pendingId, { workspaceId: "ws-1" });

    expect(serviceMocks.remember).toHaveBeenCalledWith(
      expect.objectContaining({
        content: "External approved memory",
        containerTag: "cowork:ws-1",
        taskId: "task-1",
        skipMemoryWriteGate: true,
      }),
    );
  });

  it("applies distilled curated upserts after approval", async () => {
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryWriteApprovalMode: "curated_only",
    });

    const decision = MemoryWriteGate.evaluate({
      ...baseRequest,
      target: "curated",
      action: "upsert",
      origin: "distill",
      payload: {
        action: "upsert",
        target: "workspace",
        kind: "project_fact",
        content: "Distilled fact",
        confidence: 0.9,
        source: "distill",
      },
      proposedValue: "Distilled fact",
    });
    expect(decision.allowed).toBe(false);
    if (decision.allowed || !("staged" in decision)) throw new Error("Expected staged decision");

    await MemoryWriteGate.applyPending(decision.pendingId, { workspaceId: "ws-1" });

    expect(serviceMocks.upsertDistilledEntry).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws-1",
        target: "workspace",
        kind: "project_fact",
        content: "Distilled fact",
        confidence: 0.9,
        skipMemoryWriteGate: true,
      }),
    );
  });
});
