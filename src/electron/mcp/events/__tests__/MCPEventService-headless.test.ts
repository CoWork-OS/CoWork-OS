import { describe, expect, it, vi } from "vitest";

// The headless daemon and the Linux server package ship without Electron. Loading
// MCPEventService must not import it at module scope, or the daemon exits on start.
vi.mock("electron", () => {
  throw new Error("Cannot find module 'electron'");
});

describe("MCPEventService without Electron", () => {
  it("loads when the electron package is unavailable", async () => {
    const module = await import("../MCPEventService");
    expect(module.MCPEventService).toBeTypeOf("function");
  });
});
