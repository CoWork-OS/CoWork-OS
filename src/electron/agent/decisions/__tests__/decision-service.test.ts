import { describe, expect, it, vi } from "vitest";
import { DecisionService } from "../decision-service";
import type { DecisionProvider } from "../decision-provider";
import type { JevRequest, JevResponse } from "../types";

const request: JevRequest = {
  state: { untrusted: "bounded task text" },
  questions: {
    ok: { type: "noul", instructions: "Is the bounded state sufficient?" },
  },
};

function response(): JevResponse {
  return {
    model: "jev-test",
    answers: { ok: { type: "noul", noul: 0.9 } },
    usage: { input_tokens: 2, output_tokens: 1 },
  };
}

function fakeProvider(decide: DecisionProvider["decide"]): DecisionProvider {
  return {
    decide,
    testConnection: vi.fn(),
    health: vi.fn(),
  };
}

describe("DecisionService", () => {
  it("returns typed success and records redacted metadata only", async () => {
    const service = new DecisionService({
      provider: fakeProvider(vi.fn(async () => response())),
      cache: { enabled: true },
    });

    const result = await service.decide(request, { purpose: "test", cacheKey: "same" });

    expect(result.status).toBe("success");
    expect(result.response?.answers.ok).toMatchObject({ type: "noul", noul: 0.9 });
    expect(result.stateDigest).toHaveLength(64);
    expect(service.getTelemetry().snapshot()).toMatchObject({
      total: 1,
      byStatus: { success: 1 },
    });
  });

  it("uses the bounded cache without a second provider call", async () => {
    const decide = vi.fn(async () => response());
    const service = new DecisionService({
      provider: fakeProvider(decide),
      cache: { enabled: true, ttlMs: 10_000 },
    });

    await service.decide(request, { cacheKey: "same" });
    const cached = await service.decide(request, { cacheKey: "same" });

    expect(decide).toHaveBeenCalledOnce();
    expect(cached).toMatchObject({ status: "success", fromCache: true, latencyMs: 0 });
  });

  it("enforces call and concurrency budgets", async () => {
    let release!: () => void;
    const pending = new Promise<JevResponse>((resolve) => {
      release = () => resolve(response());
    });
    const service = new DecisionService({
      provider: fakeProvider(vi.fn(async () => pending)),
      maxConcurrent: 1,
      maxCalls: 1,
    });

    const first = service.decide(request);
    const second = await service.decide(request);
    release();
    await first;

    expect(second.status).toBe("budget_exhausted");
    expect(service.getUsage().calls).toBe(1);
  });

  it("opens the circuit after repeated provider failures", async () => {
    const service = new DecisionService({
      provider: fakeProvider(
        vi.fn(async () => {
          throw new Error("offline");
        }),
      ),
      circuitFailureThreshold: 2,
    });

    expect((await service.decide(request)).status).toBe("unavailable");
    expect((await service.decide(request)).status).toBe("unavailable");
    expect((await service.decide(request)).status).toBe("circuit_open");
  });

  it("honors cancellation before making a provider call", async () => {
    const controller = new AbortController();
    controller.abort();
    const decide = vi.fn(async () => response());
    const service = new DecisionService({ provider: fakeProvider(decide) });

    const result = await service.decide(request, { signal: controller.signal });

    expect(result.status).toBe("cancelled");
    expect(decide).not.toHaveBeenCalled();
  });

  it("returns promptly when an in-flight provider ignores cancellation", async () => {
    const controller = new AbortController();
    const pending = new Promise<JevResponse>(() => undefined);
    const service = new DecisionService({
      provider: fakeProvider(vi.fn(async () => pending)),
      timeoutMs: 5_000,
    });

    const resultPromise = service.decide(request, { signal: controller.signal });
    controller.abort();
    await expect(resultPromise).resolves.toMatchObject({
      status: "cancelled",
      reason: "cancelled",
    });
  });
});
