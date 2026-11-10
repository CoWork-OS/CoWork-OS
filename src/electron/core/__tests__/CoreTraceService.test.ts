import { describe, expect, it, vi } from "vitest";
import { CoreTraceService } from "../CoreTraceService";

describe("CoreTraceService", () => {
  it("reuses an existing open trace instead of creating a duplicate", async () => {
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
    const service = new CoreTraceService(traceRepo as never);

    const result = await service.startTrace({
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
});
