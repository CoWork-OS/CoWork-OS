import { describe, expect, it, vi } from "vitest";

// node-pty is a native module that headless runs and CI may not have built. The tool registry
// (and everything importing it, such as the executor) must load without it.
vi.mock("node-pty", () => {
  throw new Error("node-pty must not load with the tool registry");
});

describe("tool registry native imports", () => {
  it("loads without node-pty", async () => {
    await expect(import("../registry")).resolves.toHaveProperty("ToolRegistry");
  }, 60_000);
});
