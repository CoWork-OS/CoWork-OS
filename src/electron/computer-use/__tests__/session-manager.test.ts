import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("../safety-overlay", () => ({
  CUASafetyOverlay: class {
    show = vi.fn();
    hide = vi.fn();
    updateStatus = vi.fn();
  },
}));

vi.mock("../window-isolation", () => ({
  WindowIsolation: class {
    isolate = vi.fn().mockResolvedValue(undefined);
    restore = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock("../shortcut-guard", () => ({
  ShortcutGuard: class {
    enable = vi.fn();
    disable = vi.fn();
  },
}));

import { ComputerUseSessionManager } from "../session-manager";

type Any = any; // oxlint-disable-line typescript-eslint/no-explicit-any

function makeDaemon(): Any {
  return {
    requestApproval: vi.fn().mockResolvedValue(true),
    logEvent: vi.fn(),
  };
}

describe("ComputerUseSessionManager", () => {
  beforeEach(() => {
    ComputerUseSessionManager.resetForTesting();
  });

  afterEach(() => {
    ComputerUseSessionManager.resetForTesting();
  });

  it("allows the same task to acquire repeatedly", () => {
    const sm = ComputerUseSessionManager.getInstance();
    const d = makeDaemon();
    const pm1 = sm.acquire("task-a", d);
    const pm2 = sm.acquire("task-a", d);
    expect(pm1).toBe(pm2);
  });

  it("rejects a second task while the first session is active", () => {
    const sm = ComputerUseSessionManager.getInstance();
    sm.acquire("task-a", makeDaemon());
    expect(() => sm.acquire("task-b", makeDaemon())).toThrow(/already active/);
  });

  it("releases the lock after awaited session teardown", async () => {
    const sm = ComputerUseSessionManager.getInstance();
    sm.acquire("task-a", makeDaemon());
    await sm.abortSession("task-a");
    sm.acquire("task-b", makeDaemon());
    expect(sm.getActiveTaskId()).toBe("task-b");
  });
});
