/**
 * Tests for Tailscale Exposure Manager
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

// Mock the tailscale utilities
vi.mock("../tailscale", () => ({
  isTailscaleInstalled: vi.fn(),
  getTailnetHostname: vi.fn(),
  enableTailscaleServe: vi.fn(),
  disableTailscaleServe: vi.fn(),
  enableTailscaleFunnel: vi.fn(),
  disableTailscaleFunnel: vi.fn(),
  checkTailscaleFunnelAvailable: vi.fn(),
}));

// Mock settings
vi.mock("../settings", () => ({
  TailscaleSettingsManager: {
    updateSettings: vi.fn(),
  },
  TailscaleMode: {},
}));

import {
  startTailscaleExposure,
  stopTailscaleExposure,
  getExposureStatus,
  checkTailscaleAvailability,
  type TailscaleExposureConfig as _TailscaleExposureConfig,
} from "../exposure";

import {
  isTailscaleInstalled,
  getTailnetHostname,
  enableTailscaleServe,
  disableTailscaleServe,
  enableTailscaleFunnel,
  disableTailscaleFunnel,
  checkTailscaleFunnelAvailable,
} from "../tailscale";

import { TailscaleSettingsManager } from "../settings";

describe("getExposureStatus", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Reset state by stopping any active exposure
    await stopTailscaleExposure();
  });

  it("should return inactive status when no exposure", () => {
    const status = getExposureStatus();
    expect(status.active).toBe(false);
    expect(status.mode).toBeUndefined();
    expect(status.hostname).toBeUndefined();
  });
});

describe("startTailscaleExposure", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await stopTailscaleExposure();
  });

  afterEach(async () => {
    await stopTailscaleExposure();
  });

  it("should return success immediately when mode is off", async () => {
    const result = await startTailscaleExposure({
      mode: "off",
      port: 8080,
    });

    expect(result.success).toBe(true);
    expect(result.hostname).toBeUndefined();
    expect(isTailscaleInstalled).not.toHaveBeenCalled();
  });

  it("should return error when Tailscale is not installed", async () => {
    vi.mocked(isTailscaleInstalled).mockResolvedValue(false);

    const result = await startTailscaleExposure({
      mode: "serve",
      port: 8080,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("not installed");
  });

  it("should enable serve mode successfully", async () => {
    vi.mocked(isTailscaleInstalled).mockResolvedValue(true);
    vi.mocked(enableTailscaleServe).mockResolvedValue(true);
    vi.mocked(getTailnetHostname).mockResolvedValue("test-machine.tailnet.ts.net");

    const result = await startTailscaleExposure({
      mode: "serve",
      port: 8080,
    });

    expect(result.success).toBe(true);
    expect(result.hostname).toBe("test-machine.tailnet.ts.net");
    expect(result.httpsUrl).toBe("https://test-machine.tailnet.ts.net");
    expect(result.wssUrl).toBe("wss://test-machine.tailnet.ts.net");
    expect(result.cleanup).toBeDefined();
    expect(enableTailscaleServe).toHaveBeenCalledWith(8080, "/");
  });

  it("should enable funnel mode when available", async () => {
    vi.mocked(isTailscaleInstalled).mockResolvedValue(true);
    vi.mocked(checkTailscaleFunnelAvailable).mockResolvedValue(true);
    vi.mocked(enableTailscaleFunnel).mockResolvedValue(true);
    vi.mocked(getTailnetHostname).mockResolvedValue("test-machine.tailnet.ts.net");

    const result = await startTailscaleExposure({
      mode: "funnel",
      port: 8080,
    });

    expect(result.success).toBe(true);
    expect(enableTailscaleFunnel).toHaveBeenCalledWith(8080, "/");
  });

  it("should fallback to serve when funnel is not available", async () => {
    vi.mocked(isTailscaleInstalled).mockResolvedValue(true);
    vi.mocked(checkTailscaleFunnelAvailable).mockResolvedValue(false);
    vi.mocked(enableTailscaleServe).mockResolvedValue(true);
    vi.mocked(getTailnetHostname).mockResolvedValue("test-machine.tailnet.ts.net");

    const result = await startTailscaleExposure({
      mode: "funnel",
      port: 8080,
    });

    expect(result.success).toBe(true);
    expect(enableTailscaleServe).toHaveBeenCalled();
    expect(enableTailscaleFunnel).not.toHaveBeenCalled();
  });

  it("should handle path prefix correctly", async () => {
    vi.mocked(isTailscaleInstalled).mockResolvedValue(true);
    vi.mocked(enableTailscaleServe).mockResolvedValue(true);
    vi.mocked(getTailnetHostname).mockResolvedValue("test-machine.tailnet.ts.net");

    const result = await startTailscaleExposure({
      mode: "serve",
      port: 8080,
      pathPrefix: "/api",
    });

    expect(result.success).toBe(true);
    expect(result.httpsUrl).toBe("https://test-machine.tailnet.ts.net/api");
    expect(result.wssUrl).toBe("wss://test-machine.tailnet.ts.net/api");
    expect(enableTailscaleServe).toHaveBeenCalledWith(8080, "/api");
  });

  it("should return error when enable fails", async () => {
    vi.mocked(isTailscaleInstalled).mockResolvedValue(true);
    vi.mocked(enableTailscaleServe).mockResolvedValue(false);

    const result = await startTailscaleExposure({
      mode: "serve",
      port: 8080,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("Failed to enable");
  });

  it("should return error when hostname cannot be determined", async () => {
    vi.mocked(isTailscaleInstalled).mockResolvedValue(true);
    vi.mocked(enableTailscaleServe).mockResolvedValue(true);
    vi.mocked(getTailnetHostname).mockResolvedValue(null);

    const result = await startTailscaleExposure({
      mode: "serve",
      port: 8080,
    });

    expect(result.success).toBe(false);
    expect(result.error).toContain("hostname");
    expect(disableTailscaleServe).toHaveBeenCalled();
  });

  it("should handle enable exception gracefully", async () => {
    vi.mocked(isTailscaleInstalled).mockResolvedValue(true);
    vi.mocked(enableTailscaleServe).mockRejectedValue(new Error("CLI error"));

    const result = await startTailscaleExposure({
      mode: "serve",
      port: 8080,
    });

    expect(result.success).toBe(false);
    expect(result.error).toBe("CLI error");
  });

  it("should update settings on success", async () => {
    vi.mocked(isTailscaleInstalled).mockResolvedValue(true);
    vi.mocked(enableTailscaleServe).mockResolvedValue(true);
    vi.mocked(getTailnetHostname).mockResolvedValue("test-machine.tailnet.ts.net");

    await startTailscaleExposure({
      mode: "serve",
      port: 8080,
      resetOnExit: true,
    });

    expect(TailscaleSettingsManager.updateSettings).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: "serve",
        lastHostname: "test-machine.tailnet.ts.net",
        resetOnExit: true,
      }),
    );
  });

  it("should track active exposure state", async () => {
    vi.mocked(isTailscaleInstalled).mockResolvedValue(true);
    vi.mocked(enableTailscaleServe).mockResolvedValue(true);
    vi.mocked(getTailnetHostname).mockResolvedValue("test-machine.tailnet.ts.net");

    await startTailscaleExposure({
      mode: "serve",
      port: 8080,
    });

    const status = getExposureStatus();
    expect(status.active).toBe(true);
    expect(status.mode).toBe("serve");
    expect(status.hostname).toBe("test-machine.tailnet.ts.net");
  });

  it("should use custom logger functions", async () => {
    vi.mocked(isTailscaleInstalled).mockResolvedValue(true);
    vi.mocked(enableTailscaleServe).mockResolvedValue(true);
    vi.mocked(getTailnetHostname).mockResolvedValue("test.ts.net");

    const log = vi.fn();
    const warn = vi.fn();

    await startTailscaleExposure({
      mode: "serve",
      port: 8080,
      log,
      warn,
    });

    expect(log).toHaveBeenCalled();
  });
});

describe("stopTailscaleExposure", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    // Start an exposure first
    vi.mocked(isTailscaleInstalled).mockResolvedValue(true);
    vi.mocked(enableTailscaleServe).mockResolvedValue(true);
    vi.mocked(getTailnetHostname).mockResolvedValue("test.ts.net");
  });

  it("should do nothing when no active exposure", async () => {
    await stopTailscaleExposure(); // Make sure nothing is active
    await stopTailscaleExposure(); // Call again

    // Should not throw
    expect(true).toBe(true);
  });

  it("should disable serve mode on stop", async () => {
    await startTailscaleExposure({ mode: "serve", port: 8080 });
    await stopTailscaleExposure();

    expect(disableTailscaleServe).toHaveBeenCalled();
  });

  it("should disable funnel mode on stop", async () => {
    vi.mocked(checkTailscaleFunnelAvailable).mockResolvedValue(true);
    vi.mocked(enableTailscaleFunnel).mockResolvedValue(true);

    await startTailscaleExposure({ mode: "funnel", port: 8080 });
    await stopTailscaleExposure();

    expect(disableTailscaleFunnel).toHaveBeenCalled();
  });

  it("should clear active exposure state", async () => {
    await startTailscaleExposure({ mode: "serve", port: 8080 });
    expect(getExposureStatus().active).toBe(true);

    await stopTailscaleExposure();
    expect(getExposureStatus().active).toBe(false);
  });

  it("should update settings to mode off", async () => {
    await startTailscaleExposure({ mode: "serve", port: 8080 });
    vi.clearAllMocks();

    await stopTailscaleExposure();

    expect(TailscaleSettingsManager.updateSettings).toHaveBeenCalledWith({
      mode: "off",
    });
  });
});

describe("cleanup function", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await stopTailscaleExposure();
    vi.mocked(isTailscaleInstalled).mockResolvedValue(true);
    vi.mocked(enableTailscaleServe).mockResolvedValue(true);
    vi.mocked(getTailnetHostname).mockResolvedValue("test.ts.net");
  });

  it("should disable exposure when cleanup is called", async () => {
    const result = await startTailscaleExposure({ mode: "serve", port: 8080 });
    expect(result.cleanup).toBeDefined();

    await result.cleanup!();

    expect(disableTailscaleServe).toHaveBeenCalled();
  });

  it("should not disable when resetOnExit is false", async () => {
    const result = await startTailscaleExposure({
      mode: "serve",
      port: 8080,
      resetOnExit: false,
    });

    vi.clearAllMocks();
    await result.cleanup!();

    expect(disableTailscaleServe).not.toHaveBeenCalled();
  });

  it("should clear state even on cleanup error", async () => {
    const result = await startTailscaleExposure({ mode: "serve", port: 8080 });
    vi.mocked(disableTailscaleServe).mockRejectedValue(new Error("Cleanup failed"));

    await result.cleanup!();

    expect(getExposureStatus().active).toBe(false);
  });
});

describe("checkTailscaleAvailability", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should return not installed when Tailscale is missing", async () => {
    vi.mocked(isTailscaleInstalled).mockResolvedValue(false);

    const result = await checkTailscaleAvailability();

    expect(result.installed).toBe(false);
    expect(result.funnelAvailable).toBe(false);
    expect(result.hostname).toBeNull();
  });

  it("should return full status when installed", async () => {
    vi.mocked(isTailscaleInstalled).mockResolvedValue(true);
    vi.mocked(checkTailscaleFunnelAvailable).mockResolvedValue(true);
    vi.mocked(getTailnetHostname).mockResolvedValue("my-host.tailnet.ts.net");

    const result = await checkTailscaleAvailability();

    expect(result.installed).toBe(true);
    expect(result.funnelAvailable).toBe(true);
    expect(result.hostname).toBe("my-host.tailnet.ts.net");
  });

  it("should check funnel availability when installed", async () => {
    vi.mocked(isTailscaleInstalled).mockResolvedValue(true);
    vi.mocked(checkTailscaleFunnelAvailable).mockResolvedValue(false);
    vi.mocked(getTailnetHostname).mockResolvedValue("test.ts.net");

    const result = await checkTailscaleAvailability();

    expect(result.funnelAvailable).toBe(false);
  });
});
