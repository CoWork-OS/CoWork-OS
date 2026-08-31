import { describe, expect, it, vi } from "vitest";
import { CoreTraceService } from "../CoreTraceService";

describe("CoreTraceService", () => {
  it("reuses an existing open trace instead of creating a duplicate", () => {
    const existingTrace = {
      id: "trace-1",
      profileId: "profile-1",
      workspaceId: "workspace-1",
      targetKey: "agent:planner",
      sourceSurface: "heartbeat",
      traceKind: "dispatch",
      status: "running",
      startedAt: 100,
      createdAt: 100,
    } as const;
    const traceRepo = {
      findOpenTrace: vi.fn(() => existingTrace),
      create: vi.fn(),
    };
    const candidateRepo = {
      listForTrace: vi.fn(),
    };
    const service = new CoreTraceService(traceRepo as never, candidateRepo as never);

    const result = service.startTrace({
      profileId: "profile-1",
      workspaceId: "workspace-1",
      targetKey: "agent:planner",
      sourceSurface: "heartbeat",
      traceKind: "dispatch",
      status: "running",
      startedAt: 100,
    });

    expect(result).toBe(existingTrace);
    expect(traceRepo.findOpenTrace).toHaveBeenCalledWith({
      profileId: "profile-1",
      sourceSurface: "heartbeat",
      targetKey: "agent:planner",
      heartbeatRunId: undefined,
      subconsciousRunId: undefined,
    });
    expect(traceRepo.create).not.toHaveBeenCalled();
  });

  it("returns trace details with events and memory candidates", () => {
    const trace = {
      id: "trace-2",
      profileId: "profile-2",
      sourceSurface: "subconscious",
      traceKind: "memory_distill",
      status: "completed",
      startedAt: 200,
      createdAt: 200,
    };
    const events = [
      {
        id: "event-1",
        traceId: "trace-2",
        phase: "collect",
        eventType: "started",
        summary: "Started",
        createdAt: 200,
      },
    ];
    const candidates = [{ id: "candidate-1", traceId: "trace-2", profileId: "profile-2" }];
    const traceRepo = {
      findById: vi.fn(() => trace),
      listEvents: vi.fn(() => events),
    };
    const candidateRepo = {
      listForTrace: vi.fn(() => candidates),
    };
    const service = new CoreTraceService(traceRepo as never, candidateRepo as never);

    expect(service.getTrace("trace-2")).toEqual({
      trace,
      events,
      candidates,
    });
  });
});
