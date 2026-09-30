import { describe, expect, it, vi } from "vitest";
import { getRoutineApiBaseUrl, loadRoutineHookMetadata } from "../routine-hook-metadata";

describe("routine hook metadata for browser hosts", () => {
  it("does not call missing hook methods or invent saved hook settings", async () => {
    const getStatus = vi.fn(async () => ({ enabled: true, serverRunning: true }));
    const getSettings = vi.fn(async () => ({ path: "/hooks" }));

    await expect(loadRoutineHookMetadata(() => false, getStatus, getSettings)).resolves.toEqual({
      status: null,
      settings: null,
    });
    expect(getStatus).not.toHaveBeenCalled();
    expect(getSettings).not.toHaveBeenCalled();
    expect(
      getRoutineApiBaseUrl({
        isBrowserHost: true,
        hookMetadataAvailable: false,
        status: null,
        settings: null,
      }),
    ).toBeNull();
  });

  it("uses actual hook metadata when the host advertises both methods", async () => {
    const status = {
      enabled: true,
      serverRunning: true,
      serverAddress: { host: "host.example", port: 9888 },
    };
    const settings = { host: "host.example", port: 9888, path: "/hooks" };
    await expect(
      loadRoutineHookMetadata(
        () => true,
        async () => status,
        async () => settings,
      ),
    ).resolves.toEqual({ status, settings });
    expect(
      getRoutineApiBaseUrl({
        isBrowserHost: true,
        hookMetadataAvailable: true,
        status,
        settings,
      }),
    ).toBe("http://host.example:9888/hooks");
  });

  it("preserves native hook metadata failures and native endpoint defaults", async () => {
    await expect(
      loadRoutineHookMetadata(
        () => true,
        async () => {
          throw new Error("hook settings failed");
        },
        async () => ({ path: "/hooks" }),
      ),
    ).rejects.toThrow("hook settings failed");
    expect(
      getRoutineApiBaseUrl({
        isBrowserHost: false,
        hookMetadataAvailable: true,
        status: null,
        settings: null,
      }),
    ).toBe("http://127.0.0.1:9877/hooks");
  });
});
