import { describe, expect, it, vi } from "vitest";
import { DEFAULT_QUEUE_SETTINGS, type QueueSettings } from "../../../shared/types";
import { WebApplicationError } from "../../web/WebApplication";
import { BrowserDesktopRpcService } from "../browser-desktop-rpc";
import { createBrowserQueueDefinitions } from "../browser-queue-methods";

function makeDaemon(initial: QueueSettings = DEFAULT_QUEUE_SETTINGS) {
  let settings = { ...initial };
  let persisted = { ...initial };
  return {
    daemon: {
      getQueueSettings: vi.fn(() => ({ ...settings })),
      saveQueueSettings: vi.fn((next: QueueSettings) => {
        persisted = { ...next };
        settings = { ...next };
      }),
    },
    get persisted() {
      return { ...persisted };
    },
    replaceRuntimeSettings(next: QueueSettings) {
      settings = { ...next };
    },
  };
}

describe("browser queue settings methods", () => {
  it("advertises only the host-admin scoped read and idempotent write methods", () => {
    const fake = makeDaemon();
    const definitions = createBrowserQueueDefinitions(fake.daemon);
    const rpc = new BrowserDesktopRpcService(definitions);

    expect(rpc.methodNames).toEqual(["getQueueSettings", "saveQueueSettings"]);
    expect(rpc.capabilities).toEqual(new Set(["agents.manage"]));
    expect(rpc.manifest).toEqual({
      getQueueSettings: { mutation: false },
      saveQueueSettings: { mutation: true },
    });
  });

  it("reads the authoritative host settings as an exact safe DTO", () => {
    const fake = makeDaemon({ maxConcurrentTasks: 4, taskTimeoutMinutes: 90 });
    const read = createBrowserQueueDefinitions(fake.daemon).getQueueSettings;

    expect(read?.handler([], {} as never)).toEqual({
      maxConcurrentTasks: 4,
      taskTimeoutMinutes: 90,
    });
  });

  it("persists and applies a validated desired state before confirming with readback", () => {
    const fake = makeDaemon();
    const save = createBrowserQueueDefinitions(fake.daemon).saveQueueSettings;
    const desired = { maxConcurrentTasks: 12, taskTimeoutMinutes: 120 };

    expect(save?.handler([desired], {} as never)).toEqual({ success: true });
    expect(fake.daemon.saveQueueSettings).toHaveBeenCalledWith(desired);
    expect(fake.persisted).toEqual(desired);
    expect(fake.daemon.getQueueSettings).toHaveBeenCalledTimes(1);
  });

  it.each([
    [{ maxConcurrentTasks: 0, taskTimeoutMinutes: 120 }],
    [{ maxConcurrentTasks: 21, taskTimeoutMinutes: 120 }],
    [{ maxConcurrentTasks: 2.5, taskTimeoutMinutes: 120 }],
    [{ maxConcurrentTasks: 2, taskTimeoutMinutes: 4 }],
    [{ maxConcurrentTasks: 2, taskTimeoutMinutes: 1441 }],
    [{ maxConcurrentTasks: 2, taskTimeoutMinutes: 120, extra: true }],
  ])("rejects invalid or open-schema values before calling the host", (value) => {
    const fake = makeDaemon();
    const rpc = new BrowserDesktopRpcService(createBrowserQueueDefinitions(fake.daemon));
    const method = rpc.methods()["desktop.saveQueueSettings"];

    expect(() => method.validateParams?.({ args: [value] })).toThrow(WebApplicationError);
    expect(fake.daemon.saveQueueSettings).not.toHaveBeenCalled();
  });

  it("keeps an unsupported host route absent", () => {
    const rpc = new BrowserDesktopRpcService(createBrowserQueueDefinitions());
    expect(rpc.methodNames).toEqual([]);
    expect(rpc.capabilities.size).toBe(0);
  });

  it("surfaces failed persistence and refuses to claim unverified settings", () => {
    const failedWrite = makeDaemon();
    failedWrite.daemon.saveQueueSettings.mockImplementation(() => {
      throw new Error("disk detail is not exposed to the browser");
    });
    const write = createBrowserQueueDefinitions(failedWrite.daemon).saveQueueSettings;
    expect(() =>
      write?.handler([{ maxConcurrentTasks: 3, taskTimeoutMinutes: 80 }], {} as never),
    ).toThrow("Queue settings could not be saved.");
    expect(failedWrite.persisted).toEqual(DEFAULT_QUEUE_SETTINGS);

    const mismatchedReadback = makeDaemon();
    mismatchedReadback.daemon.saveQueueSettings.mockImplementation(() => undefined);
    const mismatchedWrite = createBrowserQueueDefinitions(
      mismatchedReadback.daemon,
    ).saveQueueSettings;
    expect(() =>
      mismatchedWrite?.handler([{ maxConcurrentTasks: 3, taskTimeoutMinutes: 80 }], {} as never),
    ).toThrow("Queue settings could not be confirmed.");
  });
});
