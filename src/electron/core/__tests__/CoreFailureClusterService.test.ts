import { describe, expect, it, vi } from "vitest";
import { CoreFailureClusterService } from "../CoreFailureClusterService";

describe("CoreFailureClusterService", () => {
  it("creates a new cluster for the first matching failure", () => {
    const createdCluster = {
      id: "cluster-1",
      profileId: "profile-1",
      workspaceId: "workspace-1",
      category: "unknown",
      fingerprint: "fp-1",
      rootCauseSummary: "Timeout while dispatching",
      status: "open",
      recurrenceCount: 1,
      firstSeenAt: 100,
      lastSeenAt: 100,
      createdAt: 200,
      updatedAt: 200,
    };
    const failureRepo = {
      update: vi.fn(),
    };
    const clusterRepo = {
      findByFingerprint: vi.fn(() => undefined),
      create: vi.fn(() => createdCluster),
      addMember: vi.fn(),
      update: vi.fn(),
    };
    const service = new CoreFailureClusterService(failureRepo as never, clusterRepo as never);

    const result = service.upsertClusterForRecord({
      id: "failure-1",
      traceId: "trace-1",
      profileId: "profile-1",
      workspaceId: "workspace-1",
      category: "unknown",
      severity: "medium",
      fingerprint: "fp-1",
      summary: "Timeout while dispatching",
      status: "open",
      sourceSurface: "heartbeat",
      createdAt: 100,
    });

    expect(result).toBe(createdCluster);
    expect(clusterRepo.create).toHaveBeenCalled();
    expect(clusterRepo.addMember).toHaveBeenCalledWith(
      "cluster-1",
      "failure-1",
      expect.any(Number),
    );
    expect(failureRepo.update).toHaveBeenCalledWith("failure-1", { status: "clustered" });
  });

  it("updates an existing cluster and promotes repeated failures to stable", () => {
    const existingCluster = {
      id: "cluster-2",
      profileId: "profile-2",
      workspaceId: "workspace-2",
      category: "wake_timing",
      fingerprint: "fp-2",
      rootCauseSummary: "Short summary",
      status: "open",
      recurrenceCount: 1,
      firstSeenAt: 50,
      lastSeenAt: 50,
      createdAt: 50,
      updatedAt: 50,
    };
    const updatedCluster = {
      ...existingCluster,
      rootCauseSummary: "Longer and more precise summary",
      status: "stable",
      recurrenceCount: 2,
      lastSeenAt: 120,
      updatedAt: 220,
    };
    const failureRepo = {
      update: vi.fn(),
    };
    const clusterRepo = {
      findByFingerprint: vi.fn(() => existingCluster),
      update: vi.fn(() => updatedCluster),
      addMember: vi.fn(),
      create: vi.fn(),
    };
    const service = new CoreFailureClusterService(failureRepo as never, clusterRepo as never);

    const result = service.upsertClusterForRecord({
      id: "failure-2",
      traceId: "trace-2",
      profileId: "profile-2",
      workspaceId: "workspace-2",
      category: "wake_timing",
      severity: "high",
      fingerprint: "fp-2",
      summary: "Longer and more precise summary",
      status: "open",
      sourceSurface: "heartbeat",
      createdAt: 120,
    });

    expect(result).toBe(updatedCluster);
    expect(clusterRepo.update).toHaveBeenCalledWith(
      "cluster-2",
      expect.objectContaining({
        recurrenceCount: 2,
        status: "stable",
        rootCauseSummary: "Longer and more precise summary",
        lastSeenAt: 120,
      }),
    );
    expect(clusterRepo.addMember).toHaveBeenCalledWith(
      "cluster-2",
      "failure-2",
      expect.any(Number),
    );
    expect(failureRepo.update).toHaveBeenCalledWith("failure-2", { status: "clustered" });
  });
});
