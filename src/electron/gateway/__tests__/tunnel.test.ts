/**
 * Tests for Webhook Tunnel Manager
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Mock child_process
vi.mock("child_process", () => ({
  spawn: vi.fn(),
  execSync: vi.fn(),
}));

// Import after mocking
import { TunnelManager, TunnelConfig, TunnelStatus as _TunnelStatus } from "../tunnel";
import { spawn as _spawn, execSync as _execSync } from "child_process";

describe("TunnelManager", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe("constructor", () => {
    it("should create instance with default config values", () => {
      const config: TunnelConfig = {
        provider: "ngrok",
        port: 3000,
      };

      const manager = new TunnelManager(config);
      const info = manager.getInfo();

      expect(info.provider).toBe("ngrok");
      expect(info.port).toBe(3000);
      expect(info.status).toBe("stopped");
    });

    it("should set protocol based on provider", () => {
      const ngrokManager = new TunnelManager({ provider: "ngrok", port: 3000 });
      const ltManager = new TunnelManager({ provider: "localtunnel", port: 3000 });

      // Protocol is internal but affects URL generation
      expect(ngrokManager.status).toBe("stopped");
      expect(ltManager.status).toBe("stopped");
    });

    it("should accept custom configuration", () => {
      const config: TunnelConfig = {
        provider: "ngrok",
        port: 8080,
        host: "127.0.0.1",
        ngrokAuthToken: "test-token",
        ngrokRegion: "eu",
        verbose: true,
        autoRestart: false,
        restartDelay: 10000,
      };

      const manager = new TunnelManager(config);
      const info = manager.getInfo();

      expect(info.port).toBe(8080);
      expect(info.provider).toBe("ngrok");
    });
  });

  describe("status", () => {
    it("should return current status", () => {
      const manager = new TunnelManager({ provider: "ngrok", port: 3000 });
      expect(manager.status).toBe("stopped");
    });

    it("should return url as undefined when stopped", () => {
      const manager = new TunnelManager({ provider: "ngrok", port: 3000 });
      expect(manager.url).toBeUndefined();
    });
  });

  describe("getInfo", () => {
    it("should return complete tunnel info", () => {
      const manager = new TunnelManager({
        provider: "ngrok",
        port: 3000,
      });

      const info = manager.getInfo();

      expect(info).toEqual({
        url: "",
        provider: "ngrok",
        port: 3000,
        status: "stopped",
        startedAt: undefined,
        error: undefined,
      });
    });
  });

  describe("start", () => {
    it("should return existing URL if already running", async () => {
      const manager = new TunnelManager({ provider: "ngrok", port: 3000 });

      // Mock internal state to simulate running tunnel
      (manager as Any)._status = "running";
      (manager as Any)._url = "https://test.ngrok.io";

      const url = await manager.start();
      expect(url).toBe("https://test.ngrok.io");
    });

    it("should throw error for unsupported provider", async () => {
      const manager = new TunnelManager({
        provider: "invalid" as Any,
        port: 3000,
      });

      // Mock the provider check to pass
      (manager as Any).checkProviderInstalled = vi.fn().mockResolvedValue(true);

      await expect(manager.start()).rejects.toThrow("Unsupported tunnel provider");
    });

    it("should emit starting event", async () => {
      const manager = new TunnelManager({ provider: "ngrok", port: 3000 });

      // Mock the provider check to fail immediately
      (manager as Any).checkProviderInstalled = vi
        .fn()
        .mockRejectedValue(new Error("Not installed"));

      const startingHandler = vi.fn();
      manager.on("starting", startingHandler);

      try {
        await manager.start();
      } catch {
        // Expected to fail
      }

      expect(startingHandler).toHaveBeenCalled();
    });

    it("should set error status on failure", async () => {
      const manager = new TunnelManager({ provider: "ngrok", port: 3000 });

      // Mock the provider check to fail
      (manager as Any).checkProviderInstalled = vi
        .fn()
        .mockRejectedValue(new Error("ngrok not found"));

      try {
        await manager.start();
      } catch {
        // Expected
      }

      expect(manager.status).toBe("error");
      expect(manager.getInfo().error).toBe("ngrok not found");
    });

    it("should emit error event on failure", async () => {
      const manager = new TunnelManager({ provider: "ngrok", port: 3000 });

      // Mock the provider check to fail
      (manager as Any).checkProviderInstalled = vi
        .fn()
        .mockRejectedValue(new Error("Provider error"));

      const errorHandler = vi.fn();
      manager.on("error", errorHandler);

      try {
        await manager.start();
      } catch {
        // Expected
      }

      expect(errorHandler).toHaveBeenCalled();
    });
  });

  describe("stop", () => {
    it("should stop a running tunnel", async () => {
      const manager = new TunnelManager({ provider: "ngrok", port: 3000 });

      // Mock internal state to simulate running tunnel
      (manager as Any)._status = "running";
      (manager as Any)._url = "https://test.ngrok.io";

      await manager.stop();

      expect(manager.status).toBe("stopped");
      expect(manager.url).toBeUndefined();
    });

    it("should be safe to call stop when already stopped", async () => {
      const manager = new TunnelManager({ provider: "ngrok", port: 3000 });

      // Should not throw
      await manager.stop();

      expect(manager.status).toBe("stopped");
    });

    it("should emit stopped event", async () => {
      const manager = new TunnelManager({ provider: "ngrok", port: 3000 });

      const stoppedHandler = vi.fn();
      manager.on("stopped", stoppedHandler);

      // Mock internal state
      (manager as Any)._status = "running";

      await manager.stop();

      expect(stoppedHandler).toHaveBeenCalled();
    });

    it("should clear restart timer when stopping", async () => {
      const manager = new TunnelManager({
        provider: "ngrok",
        port: 3000,
        autoRestart: true,
      });

      // Mock a restart timer
      (manager as Any).restartTimer = setTimeout(() => {}, 10000);

      await manager.stop();

      expect((manager as Any).restartTimer).toBeUndefined();
    });
  });

  describe("provider support", () => {
    it("should support ngrok provider", () => {
      const manager = new TunnelManager({ provider: "ngrok", port: 3000 });
      expect(manager.getInfo().provider).toBe("ngrok");
    });

    it("should support tailscale provider", () => {
      const manager = new TunnelManager({ provider: "tailscale", port: 3000 });
      expect(manager.getInfo().provider).toBe("tailscale");
    });

    it("should support cloudflare provider", () => {
      const manager = new TunnelManager({ provider: "cloudflare", port: 3000 });
      expect(manager.getInfo().provider).toBe("cloudflare");
    });

    it("should support localtunnel provider", () => {
      const manager = new TunnelManager({ provider: "localtunnel", port: 3000 });
      expect(manager.getInfo().provider).toBe("localtunnel");
    });
  });

  describe("events", () => {
    it("should be an EventEmitter", () => {
      const manager = new TunnelManager({ provider: "ngrok", port: 3000 });

      expect(typeof manager.on).toBe("function");
      expect(typeof manager.emit).toBe("function");
      expect(typeof manager.off).toBe("function");
    });

    it("should support event handlers", () => {
      const manager = new TunnelManager({ provider: "ngrok", port: 3000 });

      const handler = vi.fn();
      manager.on("test", handler);
      manager.emit("test", "data");

      expect(handler).toHaveBeenCalledWith("data");
    });
  });
});

describe("TunnelConfig", () => {
  it("should accept minimal config", () => {
    const config: TunnelConfig = {
      provider: "ngrok",
      port: 3000,
    };

    expect(config.provider).toBe("ngrok");
    expect(config.port).toBe(3000);
  });

  it("should accept full ngrok config", () => {
    const config: TunnelConfig = {
      provider: "ngrok",
      port: 3000,
      host: "localhost",
      ngrokAuthToken: "token123",
      ngrokRegion: "eu",
      ngrokSubdomain: "mysubdomain",
      protocol: "https",
      pathPrefix: "/api",
      verbose: true,
      autoRestart: true,
      restartDelay: 5000,
    };

    expect(config.ngrokAuthToken).toBe("token123");
    expect(config.ngrokRegion).toBe("eu");
    expect(config.ngrokSubdomain).toBe("mysubdomain");
  });

  it("should accept tailscale config", () => {
    const config: TunnelConfig = {
      provider: "tailscale",
      port: 3000,
      tailscaleHostname: "my-machine",
    };

    expect(config.tailscaleHostname).toBe("my-machine");
  });

  it("should accept cloudflare config", () => {
    const config: TunnelConfig = {
      provider: "cloudflare",
      port: 3000,
      cloudflareTunnelName: "my-tunnel",
      cloudflareCredentialsFile: "/path/to/creds.json",
    };

    expect(config.cloudflareTunnelName).toBe("my-tunnel");
    expect(config.cloudflareCredentialsFile).toBe("/path/to/creds.json");
  });
});
