import { describe, it, expect, vi } from "vitest";
import {
  ComputerUseHelperRuntime,
  HelperTransportError,
  HelperCommandError,
} from "../helper-runtime";
function runtime(failures = 1, failure: Error = new HelperTransportError("reply lost")) {
  const r = new ComputerUseHelperRuntime();
  let writes = 0;
  const child = {
    exitCode: null,
    killed: false,
    kill: vi.fn(),
    stdin: {
      write: (payload: string, callback: Function) => {
        const { id } = JSON.parse(payload);
        callback();
        queueMicrotask(() => {
          if (++writes <= failures) (r as any).rejectAllPending(failure);
          else
            (r as any).handleHelperStdoutChunk(
              JSON.stringify({ id, ok: true, result: { ok: true } }) + "\n",
            );
        });
      },
    },
  };
  const start = vi.spyOn(r as any, "ensureHelperProcess").mockResolvedValue(child);
  return { r, start };
}
describe("native helper transport replay boundary", () => {
  it.each(["mouseClick", "typeText", "keyPress", "setValue", "background", "activateApp"])(
    "never resends uncertain %s",
    async (cmd) => {
      const { r, start } = runtime();
      await expect((r as any).bridgeCommand(cmd, {})).rejects.toThrow(/reply lost/);
      expect(start).toHaveBeenCalledTimes(1);
    },
  );
  it("can retry read-only discovery after helper loss", async () => {
    const { r, start } = runtime();
    await expect((r as any).bridgeCommand("listWindows", {})).resolves.toEqual({ ok: true });
    expect(start).toHaveBeenCalledTimes(2);
  });
  it.each(["observe", "press"])(
    "refreshes an unavailable AX client only for read-only %s",
    async (action) => {
      const { r, start } = runtime(
        1,
        new HelperCommandError("AX unavailable", "ax_inventory_unavailable"),
      );
      const result = (r as any).bridgeCommand("background", { action });
      if (action === "observe") {
        await expect(result).resolves.toEqual({ ok: true });
        expect(start).toHaveBeenCalledTimes(2);
      } else {
        await expect(result).rejects.toThrow(/AX unavailable/);
        expect(start).toHaveBeenCalledTimes(1);
      }
    },
  );
});
