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
    rejectPending: vi.fn((details: Any = {}) => {
      const pending = records.filter(
        (record) =>
          record.status === "pending" &&
          (!details.workspaceId || record.workspaceId === details.workspaceId),
      );
      for (const record of pending) {
        record.status = "rejected";
        record.reviewedBy = details.reviewedBy;
        record.resolution = details.resolution;
      }
      return pending.length;
    }),
  };
});

const serviceMocks = vi.hoisted(() => ({
  capture: vi.fn(),
  curate: vi.fn(),
  upsertDistilledEntry: vi.fn(),
}));

vi.mock("../../database/repository-facades", () => ({
  PendingMemoryWriteRepository: class {
    create = repoMock.create;
    list = repoMock.list;
    countPending = repoMock.countPending;
    findById = repoMock.findById;
    updateStatus = repoMock.updateStatus;
    updateStatusIfCurrent = repoMock.updateStatusIfCurrent;
    rejectPending = repoMock.rejectPending;
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

import { MemoryWriteGate } from "../MemoryWriteGate";
import { MemoryWriter } from "../MemoryWriter";

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
    MemoryWriteGate.initialize({ getDatabase: () => ({}) } as Any);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env.COWORK_MEMORY_WRITE_APPROVAL_MODE;
    delete process.env.COWORK_APPROVAL_PROMPTS;
  });

  it("redacts legacy approval summaries and nested display values without changing the stored write", async () => {
    const record = repoMock.create({
      ...baseRequest,
      target: "archive",
      summary: "Legacy token=fake-secret-value",
      payload: { content: "Bearer fake-secret-value", nested: { apiKey: "fake-key-value" } },
      reason: "password=fake-password-value",
    });
    const display = await MemoryWriteGate.findPendingForDisplay(record.id);
    expect(display?.summary).toBe("Legacy token=[redacted]");
    expect(display?.payload).toEqual({
      content: "Bearer [redacted]",
      nested: { apiKey: "[redacted]" },
    });
    expect(display?.reason).toBe("password=[redacted]");
    expect((await MemoryWriteGate.findPending(record.id))?.summary).toContain("fake-secret-value");
  });

  it("allows writes when approval mode is off", async () => {
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryWriteApprovalMode: "off",
    });

    const decision = await MemoryWriteGate.evaluate({
      ...baseRequest,
      target: "curated",
    });

    expect(decision).toEqual({ allowed: true });
    expect(await MemoryWriteGate.listPending("ws-1")).toHaveLength(0);
  });

  it("auto-commits saved review settings when approval prompts are disabled", async () => {
    process.env.COWORK_APPROVAL_PROMPTS = "off";
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryWriteApprovalMode: "all",
    });

    const decision = await MemoryWriteGate.evaluate({
      ...baseRequest,
      target: "curated",
    });

    expect(decision).toEqual({ allowed: true });
    expect(await MemoryWriteGate.pendingCount("ws-1")).toBe(0);
  });

  it("stages curated writes in curated_only mode", async () => {
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryWriteApprovalMode: "curated_only",
    });

    const decision = await MemoryWriteGate.evaluate({
      ...baseRequest,
      target: "curated",
    });

    expect(decision.allowed).toBe(false);
    const pending = await MemoryWriteGate.listPending("ws-1");
    expect(pending).toHaveLength(1);
    expect(pending[0]?.target).toBe("curated");
    expect(pending[0]?.proposedValue).toBe("Important project fact");
  });

  it("redacts shared-detector secret shapes in pending display values", async () => {
    const record = repoMock.create({
      ...baseRequest,
      target: "archive",
      summary: "Saved AKIAABCDEFGHIJKLMNOP for later",
    });
    const display = await MemoryWriteGate.findPendingForDisplay(record.id);
    expect(display?.summary).toBe("Saved [REDACTED_SECRET] for later");
  });

  it("applies archive pending writes with the write gate bypassed", async () => {
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryWriteApprovalMode: "all",
    });

    const decision = await MemoryWriteGate.evaluate({
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

  it("replays an approved memory_remember fact through MemoryWriter, kind and scope intact", async () => {
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryWriteApprovalMode: "curated_only",
    });
    const ingest = vi.fn(async (candidate: Any) => ({
      status: "written",
      action: "inserted",
      item: { id: "item-1", scope: candidate.scope, workspaceId: candidate.workspaceId },
      supersededIds: [],
      redactions: 0,
    }));
    MemoryWriter.setInstance({ ingest } as unknown as MemoryWriter);
    try {
      const decision = await MemoryWriteGate.evaluate({
        ...baseRequest,
        target: "curated",
        action: "remember",
        payload: {
          action: "remember",
          kind: "decision",
          scope: "workspace",
          source: "inferred",
          confidence: 0.7,
          pinned: false,
          recordId: "rec-1",
          content: "We decided to keep SQLite",
        },
      });
      if (decision.allowed || !("staged" in decision)) throw new Error("Expected staged decision");
      await MemoryWriteGate.applyPending(decision.pendingId, { workspaceId: "ws-1" });
      expect(ingest).toHaveBeenCalledWith(
        expect.objectContaining({
          content: "We decided to keep SQLite",
          kind: "decision",
          scope: "workspace",
          workspaceId: "ws-1",
          source: "inferred",
          sourceRef: expect.objectContaining({ store: "agent_tool", id: "rec-1" }),
          taskId: "task-1",
        }),
      );
      expect(serviceMocks.curate).not.toHaveBeenCalled();
    } finally {
      MemoryWriter.setInstance(null);
    }
  });

  it("keeps a staged core-candidate fact linked to its candidate and ignores other refs", async () => {
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryWriteApprovalMode: "background_only",
    });
    const ingest = vi.fn(async (candidate: Any) => ({
      status: "written",
      action: "inserted",
      item: { id: "item-1", scope: candidate.scope, workspaceId: candidate.workspaceId },
      supersededIds: [],
      redactions: 0,
    }));
    MemoryWriter.setInstance({ ingest } as unknown as MemoryWriter);
    const stage = async (sourceRef: Record<string, unknown>) => {
      const decision = await MemoryWriteGate.evaluate({
        ...baseRequest,
        target: "curated",
        action: "remember",
        origin: "distill",
        payload: {
          action: "remember",
          kind: "preference",
          scope: "workspace",
          source: "inferred",
          confidence: 0.9,
          recordId: "candidate-1",
          sourceRef,
          content: "Prefer deterministic prompts",
        },
      });
      if (decision.allowed || !("staged" in decision)) throw new Error("Expected staged decision");
      await MemoryWriteGate.applyPending(decision.pendingId, { workspaceId: "ws-1" });
      return decision.pendingId;
    };
    try {
      const pendingId = await stage({
        store: "core_candidate",
        id: "candidate-1",
        traceId: "trace-1",
        candidateType: "preference",
        injected: { nested: true },
      });
      expect(ingest).toHaveBeenLastCalledWith(
        expect.objectContaining({
          source: "inferred",
          sourceRef: {
            store: "core_candidate",
            id: "candidate-1",
            traceId: "trace-1",
            candidateType: "preference",
            approvedFrom: pendingId,
          },
        }),
      );

      await stage({ store: "user_edit", id: "spoofed" });
      expect(ingest).toHaveBeenLastCalledWith(
        expect.objectContaining({
          sourceRef: expect.objectContaining({ store: "agent_tool", id: "candidate-1" }),
        }),
      );
    } finally {
      MemoryWriter.setInstance(null);
    }
  });

  it("rejects pending writes without replaying the payload", async () => {
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryWriteApprovalMode: "curated_only",
    });

    const decision = await MemoryWriteGate.evaluate({
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

    const rejected = await MemoryWriteGate.rejectForDisplay(decision.pendingId, {
      workspaceId: "ws-1",
      reviewedBy: "test",
      resolution: "Not useful",
    });

    expect(rejected.status).toBe("rejected");
    expect(serviceMocks.curate).not.toHaveBeenCalled();
  });

  it("rejects the pending backlog without replaying any payload", async () => {
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryWriteApprovalMode: "all",
    });

    const first = await MemoryWriteGate.evaluate({
      ...baseRequest,
      target: "archive",
    });
    const second = await MemoryWriteGate.evaluate({
      ...baseRequest,
      target: "curated",
    });
    expect(first.allowed).toBe(false);
    expect(second.allowed).toBe(false);

    const rejected = await MemoryWriteGate.rejectAllPending({ reviewedBy: "migration-test" });

    expect(rejected).toBe(2);
    expect(await MemoryWriteGate.pendingCount("ws-1")).toBe(0);
    expect(repoMock.rejectPending).toHaveBeenCalledWith({
      workspaceId: undefined,
      reviewedBy: "migration-test",
      resolution:
        "Rejected by the no-prompt memory-write migration; stale queued data was not replayed.",
    });
    expect(serviceMocks.capture).not.toHaveBeenCalled();
    expect(serviceMocks.curate).not.toHaveBeenCalled();
  });

  it("applies distilled curated upserts after approval", async () => {
    vi.spyOn(MemoryFeaturesManager, "loadSettings").mockReturnValue({
      contextPackInjectionEnabled: true,
      heartbeatMaintenanceEnabled: true,
      memoryWriteApprovalMode: "curated_only",
    });

    const decision = await MemoryWriteGate.evaluate({
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

describe("MemoryWriteGate.initialize", () => {
  it("is idempotent for the same database and re-initializes for another", () => {
    const state = MemoryWriteGate as unknown as { pendingRepo: unknown };
    const dbA = {};
    const dbB = {};
    const managerFor = (db: object) =>
      ({ getDatabase: () => db }) as unknown as Parameters<typeof MemoryWriteGate.initialize>[0];

    MemoryWriteGate.initialize(managerFor(dbA));
    const firstRepo = state.pendingRepo;
    MemoryWriteGate.initialize(managerFor(dbA));
    MemoryWriteGate.initialize(managerFor(dbA));
    expect(state.pendingRepo).toBe(firstRepo);

    MemoryWriteGate.initialize(managerFor(dbB));
    expect(state.pendingRepo).not.toBe(firstRepo);
  });
});
