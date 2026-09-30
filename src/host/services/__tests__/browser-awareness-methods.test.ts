import { describe, expect, it, vi } from "vitest";
import { createBrowserAwarenessDefinitions } from "../browser-awareness-methods";
import {
  DEFAULT_AWARENESS_CONFIG,
  type AwarenessService,
} from "../../../electron/awareness/AwarenessService";
import type { Workspace } from "../../../shared/types";
function setup() {
  const config = structuredClone(DEFAULT_AWARENESS_CONFIG);
  const service = {
    getConfig: vi.fn(() => config),
    saveConfig: vi.fn((value) => value),
    listBeliefs: vi.fn(() => [{ id: "belief-one", workspaceId: "workspace-one" }]),
    updateBelief: vi.fn(),
    deleteBelief: vi.fn(() => true),
    getSummary: vi.fn(),
    getSnapshot: vi.fn(),
    listEvents: vi.fn(() => [{ id: "event-one", payload: { privatePath: "/private" } }]),
  };
  const resolveWorkspace = vi.fn(
    async () =>
      ({
        id: "workspace-one",
        permissions: { read: true, write: true, delete: false },
      }) as Workspace,
  );
  const definitions = createBrowserAwarenessDefinitions({
    service: service as unknown as AwarenessService,
    resolveWorkspace,
  });
  const call = async (name: string, args: unknown[]) => {
    const method = definitions[name];
    return method.handler(method.validate?.(args) ?? args, {} as never);
  };
  return { service, config, resolveWorkspace, call };
}
describe("browser awareness", () => {
  it("merges only the changed global/source settings into current host values", async () => {
    const { call, service, config } = setup();
    await call("saveAwarenessConfig", [{ sources: { conversation: { ttlMinutes: 45 } } }]);
    expect(service.saveConfig).toHaveBeenCalledWith({
      ...config,
      sources: {
        ...config.sources,
        conversation: { ...config.sources.conversation, ttlMinutes: 45 },
      },
    });
    await expect(
      call("saveAwarenessConfig", [{ sources: { unexpected: { enabled: true } } }]),
    ).rejects.toThrow();
    await expect(call("saveAwarenessConfig", [{ defaultTtlMinutes: 10081 }])).rejects.toThrow();
  });
  it("requires the stored belief workspace for edits and separate delete permission", async () => {
    const { call, service, resolveWorkspace } = setup();
    await call("updateAwarenessBelief", ["belief-one", { confidence: 0.9 }]);
    expect(resolveWorkspace).toHaveBeenCalledWith("workspace-one");
    expect(service.updateBelief).toHaveBeenCalledWith("belief-one", { confidence: 0.9 });
    await expect(call("deleteAwarenessBelief", ["belief-one"])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    expect(service.deleteBelief).not.toHaveBeenCalled();
    resolveWorkspace.mockResolvedValue({
      id: "workspace-one",
      permissions: { read: false },
    } as Workspace);
    await expect(
      call("updateAwarenessBelief", ["belief-one", { value: "Disposable edited fact" }]),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(call("listAwarenessBeliefs", ["workspace-one"])).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });
  it("bounds and scopes reads, omits raw event payloads, and propagates storage errors", async () => {
    const { call, service } = setup();
    expect(
      await call("listAwarenessEvents", [{ workspaceId: "workspace-one", limit: 20 }]),
    ).toEqual([{ id: "event-one" }]);
    expect(service.listEvents).toHaveBeenCalledWith({ workspaceId: "workspace-one", limit: 20 });
    await expect(
      call("listAwarenessEvents", [{ workspaceId: "workspace-one", limit: 201 }]),
    ).rejects.toThrow();
    service.getSummary.mockImplementation(() => {
      throw new Error("Awareness storage failed");
    });
    await expect(call("getAwarenessSummary", ["workspace-one"])).rejects.toThrow(
      "Awareness storage failed",
    );
    await expect(
      call("updateAwarenessBelief", ["belief-one", { workspaceId: "spoofed" }]),
    ).rejects.toThrow();
  });
});
