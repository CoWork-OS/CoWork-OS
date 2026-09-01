import { describe, expect, it, vi } from "vitest";
import { AutomationOutcomeService } from "../AutomationOutcomeService";
import type { AutomationRunOutcomeRepository } from "../AutomationRunOutcomeRepository";

function outcomeInput(overrides: Record<string, unknown> = {}) {
  return {
    source: "heartbeat" as const,
    title: "Heartbeat found work",
    summary: "One item needs review.",
    usefulness: "actionable" as const,
    trigger: "heartbeat" as const,
    notificationRecommended: true,
    notificationKey: "heartbeat:agent-1:workspace-1",
    ...overrides,
  };
}

describe("AutomationOutcomeService", () => {
  it("notifies the first changed output and suppresses an identical repeat", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const previous = {
      id: "previous",
      ...outcomeInput(),
      changeHash: "same-hash",
      createdAt: 1,
    };
    const repo = {
      create: vi
        .fn()
        .mockImplementation((input) => ({ id: input.id || "current", ...input, createdAt: 2 })),
      findLatestByNotificationKey: vi.fn().mockReturnValue(previous),
      markNotificationDelivered: vi.fn(),
      markNotificationSkipped: vi.fn(),
    } as unknown as AutomationRunOutcomeRepository;
    const service = new AutomationOutcomeService({ repo, notify });

    const first = await service.record(outcomeInput({ changeHash: "new-hash" }));
    const repeat = await service.record(outcomeInput({ changeHash: "same-hash" }));

    expect(notify).toHaveBeenCalledTimes(1);
    expect(repo.markNotificationDelivered).toHaveBeenCalledTimes(1);
    expect(repo.markNotificationSkipped).toHaveBeenCalledWith(
      "current",
      "unchanged_output",
      expect.any(Number),
    );
    expect(first.changeHash).toBe("new-hash");
    expect(repeat.changeHash).toBe("same-hash");
  });

  it("derives a stable hash when callers do not provide one", async () => {
    const repo = {
      create: vi.fn().mockImplementation((input) => ({ id: "outcome-1", ...input, createdAt: 1 })),
      findLatestByNotificationKey: vi.fn().mockReturnValue(null),
      markNotificationDelivered: vi.fn(),
    } as unknown as AutomationRunOutcomeRepository;
    const service = new AutomationOutcomeService({ repo });

    const first = await service.record(outcomeInput());
    const second = await service.record(outcomeInput());

    expect(first.changeHash).toMatch(/^[a-f0-9]{64}$/);
    expect(second.changeHash).toBe(first.changeHash);
  });

  it("canonicalizes metric keys and unordered evidence references before hashing", async () => {
    const repo = {
      create: vi.fn().mockImplementation((input) => ({ id: "outcome-1", ...input, createdAt: 1 })),
    } as unknown as AutomationRunOutcomeRepository;
    const service = new AutomationOutcomeService({ repo });

    const first = await service.record(
      outcomeInput({
        metrics: { z: 2, a: 1 },
        evidenceRefs: [{ id: "b" }, { id: "a" }],
        notificationRecommended: false,
      }),
    );
    const second = await service.record(
      outcomeInput({
        metrics: { a: 1, z: 2 },
        evidenceRefs: [{ id: "a" }, { id: "b" }],
        notificationRecommended: false,
      }),
    );

    expect(second.changeHash).toBe(first.changeHash);
  });

  it("derives a stable notification key when an actionable caller omits one", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const previous = {
      id: "previous",
      ...outcomeInput({ notificationKey: undefined }),
      changeHash: "same-hash",
      createdAt: 1,
    };
    const repo = {
      create: vi
        .fn()
        .mockImplementation((input) => ({ id: input.id || "current", ...input, createdAt: 2 })),
      findLatestByNotificationKey: vi.fn().mockReturnValue(previous),
      markNotificationDelivered: vi.fn(),
    } as unknown as AutomationRunOutcomeRepository;
    const service = new AutomationOutcomeService({ repo, notify });

    await service.record(
      outcomeInput({
        workspaceId: "workspace-1",
        notificationKey: undefined,
        changeHash: "same-hash",
      }),
    );

    expect(repo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        notificationKey: "automation:heartbeat:workspace:workspace-1",
      }),
    );
    expect(repo.findLatestByNotificationKey).toHaveBeenCalledWith(
      "automation:heartbeat:workspace:workspace-1",
      expect.any(String),
    );
    expect(notify).not.toHaveBeenCalled();
  });

  it("retries a stored notification with a fresh delivery id and clears suppression state", async () => {
    const notify = vi.fn().mockResolvedValue(undefined);
    const outcome = {
      id: "outcome-1",
      ...outcomeInput(),
      changeHash: "hash-1",
      notificationSkippedAt: 123,
      notificationSkipReason: "unchanged_output",
      createdAt: 2,
    };
    const repo = {
      findById: vi.fn().mockReturnValue(outcome),
      markNotificationDelivered: vi.fn(),
    } as unknown as AutomationRunOutcomeRepository;
    const service = new AutomationOutcomeService({ repo, notify });

    const retried = await service.retryNotification(outcome.id);

    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        title: outcome.title,
        deliveryId: expect.any(String),
      }),
    );
    expect(repo.markNotificationDelivered).toHaveBeenCalledWith(outcome.id, expect.any(Number));
    expect(retried.notificationSkippedAt).toBeUndefined();
    expect(retried.notificationSkipReason).toBeUndefined();
    expect(retried.notificationDeliveredAt).toEqual(expect.any(Number));
  });
});
