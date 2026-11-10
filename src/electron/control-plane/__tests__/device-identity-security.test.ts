import { afterEach, expect, it, vi } from "vitest";
const cached = vi.hoisted(() => ({ statuses: {} as Record<string, Any>, getClient: vi.fn() }));
vi.mock("../fleet-manager", () => ({
  getFleetConnectionManager: () => ({
    getStatus: (id: string) => cached.statuses[id],
    getClient: cached.getClient,
  }),
  initFleetConnectionManager: vi.fn(),
  shutdownFleetConnectionManager: vi.fn(),
}));
import { ControlPlaneSettingsManager } from "../settings";
import { findManagedRemoteDeviceByNodeId } from "../handlers";
afterEach(() => {
  vi.restoreAllMocks();
  cached.statuses = {};
  cached.getClient.mockClear();
});
it("resolves only the requested saved or authenticated identity without contacting other remotes", async () => {
  const devices = ["one", "two"].map((id) => ({
    id,
    role: "remote",
    taskNodeId: `node-${id}`,
    config: { url: `ws://${id}.invalid:18789`, token: "fixture" },
    clientId: `stored-${id}`,
  }));
  vi.spyOn(ControlPlaneSettingsManager, "loadSettings").mockReturnValue({
    managedDevices: devices,
  } as Any);
  cached.statuses.two = { state: "connected", clientId: "authenticated-two" };
  for (const alias of ["two", "node-two", "stored-two", "authenticated-two"])
    expect((await findManagedRemoteDeviceByNodeId(alias))?.id).toBe("two");
  expect(await findManagedRemoteDeviceByNodeId("unknown")).toBeNull();
  expect(cached.getClient).not.toHaveBeenCalled();
  cached.statuses.one = { state: "connected", clientId: "authenticated-two" };
  await expect(findManagedRemoteDeviceByNodeId("authenticated-two")).rejects.toThrow("ambiguous");
});
