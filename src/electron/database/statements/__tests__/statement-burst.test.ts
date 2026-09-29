import { describe, expect, it } from "vitest";
import {
  bindStatementContext,
  currentStatementContext,
  detachedStatementContext,
  StatementBurstGate,
  withStatementContext,
} from "../statement-burst";

// The burst gate on its own, with statements whose round trip takes a turn of the event
// loop like a worker request does.

function worker(gate: StatementBurstGate, log: string[]) {
  return async (entry: string, fail = false): Promise<string> => {
    const waiting = gate.enter(currentStatementContext() ?? { label: "none" });
    if (waiting) await waiting;
    try {
      await new Promise((resolve) => setImmediate(resolve));
      log.push(entry);
      if (fail) throw new Error(`${entry} failed`);
      return entry;
    } finally {
      gate.finished();
    }
  };
}

const io = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

describe("statement burst gate", () => {
  it("keeps each operation's statement sequence uninterrupted", async () => {
    const gate = new StatementBurstGate();
    const log: string[] = [];
    const statement = worker(gate, log);
    const operation = (name: string) =>
      withStatementContext(name, async () => {
        await statement(`${name}:read`);
        // Host work between statements, without real I/O.
        await Promise.resolve();
        await statement(`${name}:write`);
      });
    await Promise.all([operation("a"), operation("b"), operation("c")]);
    expect(log).toEqual(["a:read", "a:write", "b:read", "b:write", "c:read", "c:write"]);
  });

  it("lets other operations run while one waits on real I/O, as before", async () => {
    const gate = new StatementBurstGate();
    const log: string[] = [];
    const statement = worker(gate, log);
    const slow = withStatementContext("slow", async () => {
      await statement("slow:before-network");
      await io(20);
      await statement("slow:after-network");
    });
    await io(1);
    const fast = withStatementContext("fast", async () => {
      await statement("fast:read");
      await statement("fast:write");
    });
    await Promise.all([slow, fast]);
    expect(log).toEqual(["slow:before-network", "fast:read", "fast:write", "slow:after-network"]);
  });

  it("admits concurrent statements of one operation together", async () => {
    const gate = new StatementBurstGate();
    const log: string[] = [];
    const statement = worker(gate, log);
    const other = withStatementContext("other", () => statement("other:1"));
    const batch = withStatementContext("batch", () =>
      Promise.all([statement("batch:1"), statement("batch:2"), statement("batch:3")]),
    );
    await Promise.all([other, batch]);
    expect(log[0]).toBe("other:1");
    expect(log.slice(1).sort()).toEqual(["batch:1", "batch:2", "batch:3"]);
  });

  it("releases the gate when a statement fails", async () => {
    const gate = new StatementBurstGate();
    const log: string[] = [];
    const statement = worker(gate, log);
    const failing = withStatementContext("failing", () => statement("failing:1", true));
    const next = withStatementContext("next", () => statement("next:1"));
    await expect(failing).rejects.toThrow("failing:1 failed");
    await expect(next).resolves.toBe("next:1");
  });

  it("treats statements outside any operation as operations of their own", async () => {
    const gate = new StatementBurstGate();
    const log: string[] = [];
    const statement = worker(gate, log);
    await Promise.all([statement("x"), statement("y"), statement("z")]);
    expect(log.sort()).toEqual(["x", "y", "z"]);
  });

  it("opens one operation per outer call of a bound class, shared by nested calls", async () => {
    class Service {
      outer(): Promise<[string | undefined, string | undefined]> {
        const own = currentStatementContext();
        return Promise.resolve([own?.label, this.inner()]);
      }
      inner(): string | undefined {
        return currentStatementContext()?.label;
      }
      static staticCall(): string | undefined {
        return currentStatementContext()?.label;
      }
    }
    bindStatementContext(Service.prototype, "Service");
    bindStatementContext(Service, "Service");
    const service = new Service();
    expect(await service.outer()).toEqual(["Service.outer", "Service.outer"]);
    expect(service.inner()).toBe("Service.inner");
    expect(Service.staticCall()).toBe("Service.staticCall");
    expect(currentStatementContext()).toBeUndefined();
  });

  it("runs scheduled work as its own operation, not the scheduler's", async () => {
    const gate = new StatementBurstGate();
    const log: string[] = [];
    const statement = worker(gate, log);
    let scheduled: Promise<unknown> = Promise.resolve();
    await withStatementContext("scheduler", async () => {
      scheduled = new Promise((resolve) => {
        setTimeout(() => {
          resolve(
            detachedStatementContext("timer", async () => {
              expect(currentStatementContext()?.label).toBe("timer");
              await statement("timer:1");
            }),
          );
        }, 1);
      });
      expect(currentStatementContext()?.label).toBe("scheduler");
      await statement("scheduler:1");
    });
    await scheduled;
    expect(log).toEqual(["scheduler:1", "timer:1"]);
  });
});
