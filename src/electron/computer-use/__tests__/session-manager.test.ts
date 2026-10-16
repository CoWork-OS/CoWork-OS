import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

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

  it("does not intercept the user's Escape key for background sessions", () => {
    const sm = ComputerUseSessionManager.getInstance();
    sm.acquire("background", makeDaemon(), { background: true });
    expect((sm as Any).shortcutGuard.enable).not.toHaveBeenCalled();
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

  describe("waiting for the computer", () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    it("hands the computer to waiting tasks in order", async () => {
      const sm = ComputerUseSessionManager.getInstance();
      sm.acquire("task-a", makeDaemon());
      const waitingDaemon = makeDaemon();
      const order: string[] = [];
      const b = sm.acquireOrWait("task-b", waitingDaemon).then(() => order.push("b"));
      const c = sm.acquireOrWait("task-c", makeDaemon()).then(() => order.push("c"));
      expect(waitingDaemon.logEvent).toHaveBeenCalledWith(
        "task-b",
        "computer_use_waiting",
        expect.objectContaining({ holderTaskId: "task-a", position: 1 }),
      );
      expect(sm.getWaitingTaskIds()).toEqual(["task-b", "task-c"]);

      sm.endSessionIfOwner("task-a");
      await b;
      expect(sm.getActiveTaskId()).toBe("task-b");
      // A newcomer can't jump the line while task-c waits.
      sm.endSessionIfOwner("task-b");
      await c;
      expect(sm.getActiveTaskId()).toBe("task-c");
      expect(order).toEqual(["b", "c"]);
    });

    it("gives up after the wait runs out", async () => {
      const sm = ComputerUseSessionManager.getInstance();
      sm.acquire("task-a", makeDaemon());
      const waiting = sm.acquireOrWait("task-b", makeDaemon(), { waitMs: 1000 });
      const assertion = expect(waiting).rejects.toThrow(/busy with another task/);
      await vi.advanceTimersByTimeAsync(1001);
      await assertion;
      expect(sm.getWaitingTaskIds()).toEqual([]);
      expect(sm.getActiveTaskId()).toBe("task-a");
    });

    it("stops waiting when the waiting task ends", async () => {
      const sm = ComputerUseSessionManager.getInstance();
      sm.acquire("task-a", makeDaemon());
      const waiting = sm.acquireOrWait("task-b", makeDaemon());
      const assertion = expect(waiting).rejects.toThrow(/ended while waiting/);
      sm.cancelWaiting("task-b");
      await assertion;
      sm.endSessionIfOwner("task-a");
      expect(sm.getActiveTaskId()).toBeNull();
    });

    it("takes a free computer right away", async () => {
      const sm = ComputerUseSessionManager.getInstance();
      await sm.acquireOrWait("task-a", makeDaemon());
      expect(sm.getActiveTaskId()).toBe("task-a");
    });
  });
});
