import { beforeEach, describe, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({
  configs: [] as Any[],
  connectTunnel: vi.fn(),
  disconnectTunnel: vi.fn(),
  connectClient: vi.fn(),
  disconnectClient: vi.fn(),
}));
vi.mock("../remote-client", () => ({
  RemoteGatewayClient: class {
    constructor(config: Any) {
      state.configs.push({ ...config });
    }
    connect = state.connectClient;
    disconnect = state.disconnectClient;
    getStatus() {
      return { state: "connected" };
    }
  },
}));
vi.mock("../ssh-tunnel", () => ({
  SSHTunnelManager: class {
    on() {}
    connect = state.connectTunnel;
    disconnect = state.disconnectTunnel;
    getLocalUrl() {
      return "ws://127.0.0.1:43123";
    }
    getStatus() {
      return { state: "connected" };
    }
  },
}));
import { FleetConnectionManager } from "../fleet-manager";
const device = {
  id: "remote",
  role: "remote",
  config: { url: "ws://remote.invalid:18789", token: "fixture", sshTunnel: { enabled: true } },
} as Any;
beforeEach(() => {
  vi.clearAllMocks();
  state.configs.length = 0;
  state.connectTunnel.mockResolvedValue(undefined);
  state.connectClient.mockResolvedValue(undefined);
});
describe("fleet SSH authentication transport", () => {
  it("constructs the client after the tunnel and pins reconnect configuration to loopback", async () => {
    const manager = new FleetConnectionManager();
    await manager.connectDevice(device);
    expect(state.configs).toHaveLength(1);
    expect(state.configs[0]).toMatchObject({ url: "ws://127.0.0.1:43123", token: "fixture" });
    expect(device.config.url).toBe("ws://remote.invalid:18789");
  });
  it("never authenticates on tunnel failure", async () => {
    state.connectTunnel.mockRejectedValue(new Error("tunnel failed"));
    const manager = new FleetConnectionManager();
    await expect(manager.connectDevice(device)).rejects.toThrow("tunnel failed");
    expect(state.configs).toHaveLength(0);
    expect(state.connectClient).not.toHaveBeenCalled();
    expect(manager.getStatus(device.id).state).toBe("error");
  });
  it("does not create a client after disconnect during tunnel startup", async () => {
    let ready!: () => void;
    state.connectTunnel.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          ready = resolve;
        }),
    );
    const manager = new FleetConnectionManager();
    const connecting = manager.connectDevice(device);
    manager.disconnectDevice(device.id);
    ready();
    await expect(connecting).rejects.toThrow("cancelled");
    expect(state.configs).toHaveLength(0);
  });
  it.each(["ws://remote.invalid:18789", "wss://remote.invalid:18789"])(
    "preserves direct %s connections and cleans up a failed gateway",
    async (url) => {
      const manager = new FleetConnectionManager();
      await manager.connectDevice({
        ...device,
        config: { ...device.config, url, sshTunnel: undefined },
      });
      expect(state.configs[0].url).toBe(url);
      state.connectClient.mockRejectedValue(new Error("gateway failed"));
      await expect(manager.connectDevice(device)).rejects.toThrow("gateway failed");
      expect(state.disconnectTunnel).toHaveBeenCalled();
      expect(state.disconnectClient).toHaveBeenCalled();
    },
  );
});
