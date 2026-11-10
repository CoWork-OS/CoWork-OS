import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPolicies } from "../../../admin/policies";
import { PlaywrightQAService } from "../playwright-qa-service";
import type { Workspace } from "../../../../shared/types";

vi.mock("../../../admin/policies", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../admin/policies")>();
  return { ...original, loadPolicies: vi.fn(original.loadPolicies) };
});

const defaultPolicies = loadPolicies();

describe.skipIf(process.platform !== "darwin")("real QA server network policy", () => {
  let root: string;
  let port: number;
  let workspace: Workspace;
  let service: PlaywrightQAService | undefined;
  const approve = vi.fn().mockResolvedValue(true);

  beforeEach(async () => {
    approve.mockClear();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-qa-live-policy-"));
    const reservation = net.createServer();
    await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
    port = (reservation.address() as net.AddressInfo).port;
    await new Promise<void>((resolve) => reservation.close(() => resolve()));
    const policies = structuredClone(defaultPolicies);
    policies.runtime.allowedSandboxTypes = ["macos"];
    policies.runtime.network = {
      ...policies.runtime.network,
      defaultAction: "allow",
      allowedDomains: [],
      blockedDomains: [],
      allowShellNetwork: true,
    };
    vi.mocked(loadPolicies).mockReturnValue(policies);
    workspace = {
      id: "qa-live",
      name: "QA live",
      path: root,
      createdAt: 0,
      permissions: {
        read: true,
        write: true,
        delete: true,
        shell: true,
        network: true,
        accessSandboxMode: "workspace-write",
        accessApprovalPolicy: "on-request",
        accessNetworkMode: "enabled",
        sandboxType: "macos",
      },
    } as Workspace;
    fs.writeFileSync(
      path.join(root, "server.cjs"),
      `const fs = require('node:fs');
fs.writeFileSync('server-started.txt', 'started');
require('node:http').createServer((req, res) => res.end('local server works')).listen(${port}, '127.0.0.1');
`,
    );
  });

  afterEach(async () => {
    await service?.cleanup();
    service = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  function launch() {
    service = new PlaywrightQAService(workspace, undefined, approve);
    return (service as unknown as { startServer(config: unknown): Promise<void> }).startServer({
      targetUrl: `http://127.0.0.1:${port}`,
      serverCommand: `${JSON.stringify(process.execPath)} server.cjs`,
      serverStartupTimeout: 6000,
    });
  }

  it.each(["administrator", "task", "on-request"])(
    "refuses server startup before spawn when %s authority does not enable networking",
    async (authority) => {
      if (authority === "administrator") loadPolicies().runtime.network.allowShellNetwork = false;
      else if (authority === "task") workspace.permissions.network = false;
      else workspace.permissions.accessNetworkMode = "on-request";

      await expect(launch()).rejects.toThrow(/TCP listeners are denied/);
      expect(approve).toHaveBeenCalledOnce();
      expect(fs.existsSync(path.join(root, "server-started.txt"))).toBe(false);
    },
    15_000,
  );

  it("serves loopback requests when task and administrator network authority are enabled", async () => {
    await launch();
    expect(approve).toHaveBeenCalledOnce();
    expect(fs.readFileSync(path.join(root, "server-started.txt"), "utf8")).toBe("started");
    expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("local server works");
  }, 15_000);
});
