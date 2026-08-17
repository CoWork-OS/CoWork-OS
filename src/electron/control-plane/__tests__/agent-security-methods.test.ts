import { beforeEach, describe, expect, it, vi } from "vitest";
import { ErrorCodes, Methods } from "../protocol";

const serviceDouble = vi.hoisted(() => ({
  getStatus: vi.fn(),
  listFindings: vi.fn(),
  installHook: vi.fn(),
  uninstallHook: vi.fn(),
  prune: vi.fn(),
}));

vi.mock("../../security/numbat", () => ({
  getNumbatService: () => serviceDouble,
}));

import { registerAgentSecurityMethods } from "../registerAgentSecurityMethods";

describe("registerAgentSecurityMethods", () => {
  const methods = new Map<string, (...args: Any[]) => Any>();
  const requireScope = vi.fn();

  beforeEach(() => {
    methods.clear();
    requireScope.mockReset();
    serviceDouble.getStatus.mockReset();
    serviceDouble.listFindings.mockReset();
    serviceDouble.installHook.mockReset();
    serviceDouble.uninstallHook.mockReset();
    serviceDouble.prune.mockReset();
    registerAgentSecurityMethods({
      server: {
        registerMethod: (name: string, handler: (...args: Any[]) => Any) => {
          methods.set(name, handler);
        },
      } as Any,
      requireScope,
    });
  });

  it("exposes only redacted runtime health to read-scoped clients", async () => {
    serviceDouble.getStatus.mockResolvedValue({
      enabled: true,
      mode: "enforce",
      health: "unavailable",
      binaryPath: "/Users/alice/private/runtime/numbat",
      lastError: "checksum failed at /Users/alice/private/runtime/numbat",
      pendingObservations: 0,
    });
    const client = { id: "read-client" };

    const result = await methods.get(Methods.AGENT_SECURITY_STATUS)?.(client, {
      refresh: true,
    });

    expect(requireScope).toHaveBeenCalledWith(client, "read");
    expect(result).toEqual(
      expect.objectContaining({
        health: "unavailable",
        binaryPath: undefined,
        lastError: "Agent security runtime is unavailable",
      }),
    );
  });

  it("requires admin scope for findings that can contain local action metadata", async () => {
    const client = { id: "admin-client" };
    serviceDouble.listFindings.mockReturnValue([]);

    await methods.get(Methods.AGENT_SECURITY_FINDINGS_LIST)?.(client, { limit: 10 });

    expect(requireScope).toHaveBeenCalledWith(client, "admin");
  });

  it("requires operation-bound confirmation for hook mutations", async () => {
    const client = { id: "admin-client" };
    const install = methods.get(Methods.AGENT_SECURITY_HOOK_INSTALL)!;

    await expect(install(client, { agent: "codex" })).rejects.toMatchObject({
      code: ErrorCodes.INVALID_PARAMS,
    });
    await expect(
      install(client, { agent: "codex", confirmation: "uninstall:codex" }),
    ).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
    await install(client, { agent: "codex", confirmation: "install:codex" });

    expect(serviceDouble.installHook).toHaveBeenCalledWith("codex");
  });

  it("requires explicit confirmation for history pruning", async () => {
    const client = { id: "admin-client" };
    const prune = methods.get(Methods.AGENT_SECURITY_PRUNE)!;

    await expect(prune(client, {})).rejects.toMatchObject({ code: ErrorCodes.INVALID_PARAMS });
    await prune(client, { confirmation: "prune" });

    expect(serviceDouble.prune).toHaveBeenCalledTimes(1);
  });
});
