import { describe, expect, it, vi } from "vitest";
import { SecureMcpTunnelSupervisor } from "../TunnelSupervisor";
import { SecureMcpTunnelSettingsManager } from "../settings";
vi.mock("../settings", () => ({
  SecureMcpTunnelSettingsManager: { updateTunnel: vi.fn(), loadSettings: () => ({ tunnels: [] }) },
}));
describe("live tunnel policy replacement", () => {
  it("waits for revocation before publishing policy and starting the replacement", async () => {
    const supervisor = new SecureMcpTunnelSupervisor();
    (supervisor as Any).clients.set("test", {});
    const events: string[] = [];
    let revoked!: () => void;
    vi.spyOn(supervisor as Any, "stopTunnelUnlocked").mockImplementation(async () => {
      events.push("stop");
      await new Promise<void>((r) => (revoked = r));
      events.push("revoked");
      return null;
    });
    vi.mocked(SecureMcpTunnelSettingsManager.updateTunnel).mockImplementation(() => {
      events.push("persist");
      return { enabled: true } as Any;
    });
    vi.spyOn(supervisor as Any, "startTunnelUnlocked").mockImplementation(async () => {
      events.push("restart");
      return {} as Any;
    });
    const update = supervisor.updateTunnel("test", { policy: { readOnly: true } });
    await Promise.resolve();
    await Promise.resolve();
    expect(events).toEqual(["stop"]);
    revoked();
    await update;
    expect(events).toEqual(["stop", "revoked", "persist", "restart"]);
  });
  it("serializes simultaneous enable and disable updates without orphaning authority", async () => {
    const supervisor = new SecureMcpTunnelSupervisor();
    let revoke!: () => void;
    const old = {
      stop: vi.fn(async () => new Promise<void>((r) => (revoke = r))),
      getStatus: () => ({}),
    };
    (supervisor as Any).clients.set("test", old);
    const replacement = { stop: vi.fn(async () => {}), getStatus: () => ({}) };
    vi.mocked(SecureMcpTunnelSettingsManager.updateTunnel).mockImplementation(
      (_id, updates) => ({ enabled: updates.enabled }) as Any,
    );
    vi.spyOn(supervisor as Any, "startTunnelUnlocked").mockImplementation(async () => {
      (supervisor as Any).clients.set("test", replacement);
      return {} as Any;
    });
    const enabled = supervisor.updateTunnel("test", { enabled: true });
    const disabled = supervisor.updateTunnel("test", { enabled: false });
    await Promise.resolve();
    await Promise.resolve();
    revoke();
    await Promise.all([enabled, disabled]);
    expect(replacement.stop).toHaveBeenCalledOnce();
    expect((supervisor as Any).clients.has("test")).toBe(false);
  });
});
