import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Workspace } from "../../../../shared/types";
import type { AdminPolicies } from "../../../admin/policies";

const state = vi.hoisted(() => ({ spawned: false }));
vi.mock("net", () => ({
  Socket: class {
    listeners = new Map<string, () => void>();
    setTimeout() {}
    once(event: string, listener: () => void) {
      this.listeners.set(event, listener);
    }
    destroy() {}
    connect() {
      queueMicrotask(() => this.listeners.get(state.spawned ? "connect" : "error")?.());
    }
  },
}));
vi.mock("../../../admin/policies", () => ({ loadPolicies: vi.fn() }));
vi.mock("../../sandbox/sandbox-factory", () => ({ createSandbox: vi.fn() }));
vi.mock("../../sandbox/loopback-listener-guard", () => ({
  getLoopbackListenerGuard: () => ({ watch: vi.fn(() => vi.fn()) }),
}));

import { loadPolicies } from "../../../admin/policies";
import { createSandbox } from "../../sandbox/sandbox-factory";
import { PlaywrightQAService } from "../playwright-qa-service";

describe("QA server subprocess policy", () => {
  let root: string;
  let workspace: Workspace;
  let effectiveWorkspace: Workspace;
  let policies: AdminPolicies;
  let sandbox: {
    type: "macos" | "none";
    spawnProcess: ReturnType<typeof vi.fn>;
    cleanup: ReturnType<typeof vi.fn>;
  };
  let approve: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.useFakeTimers();
    state.spawned = false;
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-qa-server-policy-"));
    workspace = {
      id: "qa-policy",
      name: "QA policy",
      path: root,
      createdAt: 0,
      permissions: {
        read: true,
        write: true,
        delete: true,
        shell: true,
        network: true,
        accessSandboxMode: "danger-full-access",
        accessApprovalPolicy: "never",
        unrestrictedFileAccess: true,
        accessNetworkMode: "enabled",
      },
    };
    policies = {
      version: 1,
      runtime: {
        allowedSandboxTypes: ["macos", "docker"],
        requireSandboxForShell: false,
        allowUnsandboxedShell: true,
        network: {
          allowShellNetwork: true,
          defaultAction: "allow",
          allowedDomains: [],
          blockedDomains: [],
        },
      },
    } as AdminPolicies;
    effectiveWorkspace = workspace;
    vi.mocked(loadPolicies).mockImplementation(() => policies);
    sandbox = {
      type: "macos",
      cleanup: vi.fn(),
      spawnProcess: vi.fn(() => {
        state.spawned = true;
        return {
          process: Object.assign(new EventEmitter(), { pid: 12345, kill: vi.fn() }),
          cleanup: vi.fn(),
        };
      }),
    };
    vi.mocked(createSandbox).mockImplementation(async () => sandbox as never);
    approve = vi.fn().mockResolvedValue(true);
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function launch() {
    const service = new PlaywrightQAService(
      workspace,
      undefined,
      approve,
      {},
      () => effectiveWorkspace,
    );
    const pending = (
      service as unknown as { startServer(config: unknown): Promise<void> }
    ).startServer({
      targetUrl: "http://localhost:3000",
      serverCommand: "node server.js",
      serverStartupTimeout: 1000,
    });
    let outcome: { error?: unknown } | undefined;
    pending.then(
      () => {
        outcome = {};
      },
      (error) => {
        outcome = { error };
      },
    );
    await vi.waitFor(() => expect(outcome).toBeDefined(), { timeout: 3000 });
    if (outcome!.error) throw outcome!.error;
  }

  it("keeps administrator-denied networking off after command approval", async () => {
    policies.runtime.network.allowShellNetwork = false;
    await launch();
    expect(approve).toHaveBeenCalledOnce();
    expect(sandbox.spawnProcess).toHaveBeenCalledWith(
      "node",
      ["server.js"],
      expect.objectContaining({ allowNetwork: false }),
    );
  });

  it("refuses NoSandbox when networking is disabled despite full filesystem access", async () => {
    workspace.permissions.accessNetworkMode = "disabled";
    sandbox.type = "none";
    await expect(launch()).rejects.toThrow(/OS-level sandbox/);
    expect(sandbox.spawnProcess).not.toHaveBeenCalled();
    expect(sandbox.cleanup).toHaveBeenCalledOnce();
  });

  it.each([
    { defaultAction: "deny" as const },
    { allowedDomains: ["example.com"] },
    { blockedDomains: ["example.com"] },
  ])("keeps administrator network restrictions effective: %j", async (network) => {
    Object.assign(policies.runtime.network, network);
    await launch();
    expect(sandbox.spawnProcess).toHaveBeenCalledWith(
      "node",
      ["server.js"],
      expect.objectContaining({ allowNetwork: false }),
    );
  });

  it.each([
    { network: false },
    { accessNetworkMode: "on-request" as const },
    { accessDomainRules: [{ pattern: "example.com", access: "allow" as const }] },
  ])("refuses an unenforceable NoSandbox network policy: %j", async (permissions) => {
    Object.assign(workspace.permissions, permissions);
    sandbox.type = "none";
    await expect(launch()).rejects.toThrow(/OS-level sandbox/);
    expect(sandbox.spawnProcess).not.toHaveBeenCalled();
  });

  it.each([
    { requireSandboxForShell: true },
    { allowUnsandboxedShell: false },
    {
      network: {
        allowShellNetwork: false,
        defaultAction: "allow" as const,
        allowedDomains: [],
        blockedDomains: [],
      },
    },
  ])("refuses NoSandbox when administrator policy prohibits it: %j", async (runtime) => {
    Object.assign(policies.runtime, runtime);
    sandbox.type = "none";
    await expect(launch()).rejects.toThrow(/OS-level sandbox/);
    expect(sandbox.spawnProcess).not.toHaveBeenCalled();
  });

  it.each([
    { accessSandboxMode: "workspace-write" as const },
    { delete: false },
    { unrestrictedFileAccess: false },
    { accessFilesystemRules: [{ path: "private", access: "deny" as const }] },
  ])("refuses NoSandbox when filesystem authority is finite: %j", async (permissions) => {
    Object.assign(workspace.permissions, permissions);
    sandbox.type = "none";
    await expect(launch()).rejects.toThrow(/OS-level sandbox/);
    expect(sandbox.spawnProcess).not.toHaveBeenCalled();
  });

  it("rejects a backend excluded by administrator policy", async () => {
    policies.runtime.allowedSandboxTypes = ["docker"];
    await expect(launch()).rejects.toThrow(/blocked by administrator policy/);
    expect(sandbox.spawnProcess).not.toHaveBeenCalled();
    expect(sandbox.cleanup).toHaveBeenCalledOnce();
  });

  it("invalidates approval when workspace authority changes while awaiting consent", async () => {
    approve.mockImplementation(async () => {
      workspace.permissions.network = false;
      return true;
    });
    await expect(launch()).rejects.toThrow(/authority changed/);
    expect(sandbox.spawnProcess).not.toHaveBeenCalled();
    expect(sandbox.cleanup).toHaveBeenCalledOnce();
  });

  it("invalidates approval when administrator policy changes during sandbox initialization", async () => {
    vi.mocked(createSandbox).mockImplementation(async () => {
      policies.runtime.network.allowShellNetwork = false;
      return sandbox as never;
    });
    await expect(launch()).rejects.toThrow(/authority changed/);
    expect(sandbox.spawnProcess).not.toHaveBeenCalled();
    expect(sandbox.cleanup).toHaveBeenCalledOnce();
  });

  it("invalidates approval when the task replaces its effective workspace during initialization", async () => {
    vi.mocked(createSandbox).mockImplementation(async () => {
      effectiveWorkspace = {
        ...workspace,
        permissions: { ...workspace.permissions, network: false },
      };
      return sandbox as never;
    });
    await expect(launch()).rejects.toThrow(/authority changed/);
    expect(workspace.permissions.network).toBe(true);
    expect(sandbox.spawnProcess).not.toHaveBeenCalled();
  });

  it("retains approved networked servers under unrestricted authority", async () => {
    await launch();
    expect(sandbox.spawnProcess).toHaveBeenCalledWith(
      "node",
      ["server.js"],
      expect.objectContaining({ allowNetwork: true }),
    );
  });

  it("retains offline sandboxed servers for bounded on-request profiles", async () => {
    Object.assign(workspace.permissions, {
      accessSandboxMode: "workspace-write",
      accessApprovalPolicy: "on-request",
      accessNetworkMode: "on-request",
      unrestrictedFileAccess: false,
    });
    await launch();
    expect(sandbox.spawnProcess).toHaveBeenCalledWith(
      "node",
      ["server.js"],
      expect.objectContaining({ allowNetwork: false }),
    );
  });

  it("retains approved NoSandbox servers only under unrestricted workspace and admin authority", async () => {
    sandbox.type = "none";
    await launch();
    expect(sandbox.spawnProcess).toHaveBeenCalledWith(
      "node",
      ["server.js"],
      expect.objectContaining({ allowNetwork: true }),
    );
  });

  it("does not launch a process when the existing server already answers", async () => {
    state.spawned = true;
    await launch();
    expect(createSandbox).not.toHaveBeenCalled();
    expect(sandbox.spawnProcess).not.toHaveBeenCalled();
  });

  it("does not launch a process after denied command consent", async () => {
    approve.mockResolvedValue(false);
    await expect(launch()).rejects.toThrow(/approval denied/);
    expect(createSandbox).not.toHaveBeenCalled();
    expect(sandbox.spawnProcess).not.toHaveBeenCalled();
  });

  it("cleans up a sandbox whose spawn fails", async () => {
    sandbox.spawnProcess.mockImplementation(() => {
      throw new Error("spawn failed");
    });
    await expect(launch()).rejects.toThrow("spawn failed");
    expect(sandbox.cleanup).toHaveBeenCalledOnce();
  });
});
