import { describe, expect, it } from "vitest";
import fs from "node:fs";
import { IPC_CHANNELS } from "../types";

describe("IPC channel definitions", () => {
  const preloadSource = fs.readFileSync("src/electron/preload.ts", "utf-8");

  it("aliases the shared channel constant in preload", () => {
    expect(preloadSource).toContain("IPC_CHANNELS as SHARED_IPC_CHANNELS");
    expect(preloadSource).toContain("const IPC_CHANNELS = SHARED_IPC_CHANNELS;");
  });

  it("exports a non-empty shared channel map", () => {
    expect(Object.keys(IPC_CHANNELS).length).toBeGreaterThan(0);
  });
});
