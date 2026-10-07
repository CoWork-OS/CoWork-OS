import { describe, expect, it, vi } from "vitest";

// The headless daemon (Linux server package) has no Electron: importing the canvas protocol
// module, which the canvas manager pulls in, must not load it.
vi.mock("electron", () => {
  throw new Error("Cannot find module 'electron'");
});

describe("canvas protocol in the headless daemon", () => {
  it("imports without loading Electron", async () => {
    const module = await import("../canvas-protocol");
    expect(typeof module.registerCanvasProtocol).toBe("function");
  });

  it("registers a handler on an explicit protocol without loading Electron", async () => {
    const { registerCanvasProtocol } = await import("../canvas-protocol");
    const handle = vi.fn();
    registerCanvasProtocol({ handle } as never, "session-1");
    expect(handle).toHaveBeenCalledWith("canvas", expect.any(Function));
  });
});
