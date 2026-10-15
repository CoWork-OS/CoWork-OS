import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";

const children: Array<EventEmitter & Record<string, unknown>> = [];
vi.mock("child_process", async (original) => ({
  ...(await original<typeof import("child_process")>()),
  spawn: vi.fn(() => {
    const index = children.length;
    const child = Object.assign(new EventEmitter(), {
      exitCode: null as number | null,
      killed: false,
      stdout: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      stderr: Object.assign(new EventEmitter(), { setEncoding: vi.fn() }),
      // The replaced helper reports its exit only after its successor is busy.
      kill: vi.fn(() => {
        child.killed = true;
        setTimeout(() => child.emit("exit", null, "SIGTERM"), 5);
      }),
      stdin: {
        write: (payload: string, callback: (error?: Error) => void) => {
          const { id } = JSON.parse(payload);
          callback();
          const reply =
            index === 0
              ? {
                  id,
                  ok: false,
                  error: { code: "ax_inventory_unavailable", message: "AX unavailable" },
                }
              : { id, ok: true, result: [] };
          setTimeout(
            () => child.stdout.emit("data", JSON.stringify(reply) + "\n"),
            index === 0 ? 0 : 20,
          );
        },
      },
    });
    children.push(child);
    return child;
  }),
}));
vi.mock("fs/promises", async (original) => ({
  ...(await original<typeof import("fs/promises")>()),
  access: vi.fn(async () => undefined),
}));

describe("helper restart during read-only AX recovery", () => {
  it("does not let the replaced helper's late exit reject the retried read", async () => {
    const { ComputerUseHelperRuntime } = await import("../helper-runtime");
    const runtime = new ComputerUseHelperRuntime();
    await expect(runtime.listWindows(42)).resolves.toEqual([]);
    expect(children).toHaveLength(2);
    expect(children[0].kill).toHaveBeenCalledWith("SIGTERM");
  });
});
