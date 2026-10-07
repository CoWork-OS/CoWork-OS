import { describe, it, expect, vi } from "vitest";
import { AutomationRuntime } from "../AutomationRuntime";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}
describe("shared automation lifecycle", () => {
  it("waits for startup before cleanup and never leaves a late timer running", async () => {
    const ready = deferred();
    let timer = false;
    const service = {
      start: vi.fn(async () => {
        await ready.promise;
        timer = true;
      }),
      stop: vi.fn(() => {
        timer = false;
      }),
    };
    const runtime = new AutomationRuntime("node");
    runtime.register("cron", service);
    const starting = runtime.start("cron");
    await Promise.resolve();
    await Promise.resolve();
    const stopping = runtime.stop("cron");
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    ready.resolve();
    await starting;
    await stopping;
    expect(timer).toBe(false);
    expect(service.stop).toHaveBeenCalledOnce();
    expect(runtime.snapshot().producers.find((p) => p.id === "cron")?.state).toBe("stopped");
  });
  it("coalesces starts and fences a queued start superseded by stop and restart", async () => {
    const service = { start: vi.fn(), stop: vi.fn() };
    const runtime = new AutomationRuntime("desktop");
    runtime.register("heartbeat", service);
    const obsolete = runtime.start("heartbeat");
    const stopped = runtime.stop("heartbeat");
    const started = runtime.start("heartbeat");
    expect(runtime.start("heartbeat")).toBe(started);
    await Promise.all([obsolete, stopped, started]);
    expect(service.start).toHaveBeenCalledOnce();
  });
  it("cleans partial startup and allows an explicit retry", async () => {
    const service = {
      start: vi
        .fn()
        .mockRejectedValueOnce(new Error("private failure"))
        .mockResolvedValue(undefined),
      stop: vi.fn(),
    };
    const runtime = new AutomationRuntime("node");
    runtime.register("event_triggers", service);
    await expect(runtime.start("event_triggers")).rejects.toThrow("private failure");
    expect(service.stop).toHaveBeenCalledOnce();
    expect(JSON.stringify(runtime.snapshot())).not.toContain("private failure");
    await runtime.start("event_triggers");
    expect(runtime.snapshot().producers.find((p) => p.id === "event_triggers")?.state).toBe(
      "running",
    );
  });
  it("continues shutdown after a failure and blocks new starts", async () => {
    const runtime = new AutomationRuntime("node");
    const stopped = vi.fn();
    runtime.register("cron", { start: vi.fn(), stop: stopped });
    runtime.register("routines", {
      start: vi.fn(),
      stop: () => {
        throw new Error("stop failed");
      },
    });
    await expect(runtime.shutdown()).rejects.toThrow("Automation shutdown failed");
    expect(stopped).toHaveBeenCalledOnce();
    await expect(runtime.start("cron")).rejects.toThrow("shutting down");
  });
  it("coalesces recovery before producers and drains it before releasing ownership", async () => {
    const calls: string[] = [];
    const ready = deferred();
    const runtime = new AutomationRuntime("node");
    runtime.attachOwnership({
      acquire: async () => ({ owner: "fixture", generation: 1, expiresAt: Date.now() + 60000 }),
      validate: async () => true,
      release: async () => {
        calls.push("release");
      },
    });
    runtime.registerRecovery({
      start: async () => {
        calls.push("recover");
        await ready.promise;
      },
      stop: async () => {
        calls.push("drain");
      },
    });
    runtime.register("cron", {
      start: () => {
        calls.push("cron");
      },
      stop: () => {},
    });
    runtime.register("heartbeat", {
      start: () => {
        calls.push("heartbeat");
      },
      stop: () => {},
    });
    const starting = Promise.all([runtime.start("cron"), runtime.start("heartbeat")]);
    await vi.waitFor(() => expect(calls).toEqual(["recover"]));
    ready.resolve();
    await starting;
    expect(calls.filter((x) => x === "recover")).toHaveLength(1);
    await runtime.shutdown();
    expect(calls.slice(-2)).toEqual(["drain", "release"]);
  });
  it("parks recovery on ownership loss and restarts it after takeover", async () => {
    let owned = true;
    let generation = 1;
    const runtime = new AutomationRuntime("node");
    runtime.attachOwnership({
      acquire: async () =>
        owned ? { owner: "fixture", generation, expiresAt: Date.now() + 60000 } : null,
      validate: async () => owned,
      release: async () => {},
    });
    const recovery = { start: vi.fn(), stop: vi.fn() };
    runtime.registerRecovery(recovery);
    runtime.register("cron", { start: vi.fn(), stop: vi.fn() });
    await runtime.start("cron");
    owned = false;
    await runtime.refreshOwnership();
    expect(recovery.stop).toHaveBeenCalledOnce();
    owned = true;
    generation++;
    await runtime.refreshOwnership();
    expect(recovery.start).toHaveBeenCalledTimes(2);
    await runtime.shutdown();
  });
  it("reports uninitialized producers and desktop interaction honestly on Node", () => {
    const snapshot = new AutomationRuntime("node").snapshot();
    expect(snapshot.producers.every((p) => p.state === "not_started")).toBe(true);
    expect(snapshot.capabilities.desktopInteraction).toBe("waiting_for_desktop");
  });
  it("blocks retry while partial startup cleanup is uncertain", async () => {
    const service = {
      start: vi.fn().mockRejectedValue(new Error("startup failed")),
      stop: vi.fn().mockRejectedValueOnce(new Error("cleanup failed")).mockResolvedValue(undefined),
    };
    const runtime = new AutomationRuntime("node");
    runtime.register("cron", service);
    await expect(runtime.start("cron")).rejects.toThrow("startup failed");
    await expect(runtime.start("cron")).rejects.toThrow("cleanup must finish");
    expect(service.start).toHaveBeenCalledOnce();
    await runtime.stop("cron");
    await expect(runtime.start("cron")).rejects.toThrow("startup failed");
    expect(service.start).toHaveBeenCalledTimes(2);
  });
  it("parks producers after renewal failure and restarts only with a fresh generation", async () => {
    let owned = true;
    let generation = 1;
    const authority = {
      acquire: vi.fn(async () =>
        owned ? { owner: "fixture", generation, expiresAt: Date.now() + 60000 } : null,
      ),
      validate: vi.fn(async () => owned),
      release: vi.fn(async () => {}),
    };
    const runtime = new AutomationRuntime("node");
    runtime.attachOwnership(authority);
    const service = { start: vi.fn(), stop: vi.fn() };
    runtime.register("cron", service);
    try {
      await runtime.start("cron");
      owned = false;
      await runtime.refreshOwnership();
      expect(service.stop).toHaveBeenCalledOnce();
      expect(() => runtime.captureFence()).toThrow("Waiting for");
      owned = true;
      generation = 2;
      await runtime.refreshOwnership();
      expect(service.start).toHaveBeenCalledTimes(2);
      expect(runtime.captureFence().generation).toBe(2);
    } finally {
      await runtime.shutdown();
    }
  });
  it("drains the remaining producers after one owner-loss cleanup fails and blocks dispatch", async () => {
    let owned = true;
    const runtime = new AutomationRuntime("node");
    runtime.attachOwnership({
      acquire: async () =>
        owned ? { owner: "fixture", generation: 1, expiresAt: Date.now() + 60000 } : null,
      validate: async () => owned,
      release: async () => {},
    });
    const cron = {
      start: vi.fn(),
      stop: vi.fn().mockRejectedValueOnce(new Error("cleanup failed")).mockResolvedValue(undefined),
    };
    const heartbeat = { start: vi.fn(), stop: vi.fn() };
    runtime.register("cron", cron);
    runtime.register("heartbeat", heartbeat);
    try {
      await runtime.start("cron");
      await runtime.start("heartbeat");
      owned = false;
      await expect(runtime.refreshOwnership()).rejects.toThrow("ownership cleanup failed");
      expect(heartbeat.stop).toHaveBeenCalledOnce();
      expect(() => runtime.captureFence()).toThrow("cleanup must finish");
    } finally {
      await runtime.shutdown();
    }
  });
});
