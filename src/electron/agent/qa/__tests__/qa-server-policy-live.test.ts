import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPolicies } from "../../../admin/policies";
import { PlaywrightQAService } from "../playwright-qa-service";
import type { Workspace } from "../../../../shared/types";

vi.mock("../../../admin/policies", async (importOriginal) => {
  const original = await importOriginal<typeof import("../../../admin/policies")>();
  return { ...original, loadPolicies: vi.fn(original.loadPolicies) };
});

describe.skipIf(process.platform !== "darwin")("real QA server network policy", () => {
  let root: string;
  let service: PlaywrightQAService | undefined;
  afterEach(async () => {
    await service?.cleanup();
    service = undefined;
    if (root) fs.rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it.each(["127.0.0.1", "0.0.0.0"])(
    "denies egress and guards the real server's %s listener",
    async (host) => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-qa-live-policy-"));
      const reservation = net.createServer();
      await new Promise<void>((resolve) => reservation.listen(0, "127.0.0.1", resolve));
      const port = (reservation.address() as net.AddressInfo).port;
      await new Promise<void>((resolve) => reservation.close(() => resolve()));
      const policies = loadPolicies();
      vi.mocked(loadPolicies).mockReturnValue({
        ...policies,
        runtime: {
          ...policies.runtime,
          allowedSandboxTypes: ["macos"],
          network: { ...policies.runtime.network, allowShellNetwork: false },
        },
      });
      const workspace = {
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
        path.join(root, "server.js"),
        `
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const probe = net.connect(80, '192.0.2.1');
probe.on('error', error => {
  fs.writeFileSync('egress-proof.txt', error.code);
  if (!['EPERM', 'EACCES'].includes(error.code)) process.exit(1);
  http.createServer((req, res) => res.end('local server works')).listen(${port}, '${host}');
});
setTimeout(() => process.exit(2), 10_000).unref();
`,
      );
      service = new PlaywrightQAService(workspace, undefined, async () => true);
      const started = (
        service as unknown as { startServer(config: unknown): Promise<void> }
      ).startServer({
        targetUrl: `http://127.0.0.1:${port}`,
        serverCommand: `${process.execPath} server.js`,
        serverStartupTimeout: 6000,
      });
      const error = await started.then(
        () => undefined,
        (error) => error,
      );
      if (host === "127.0.0.1" && error) throw error;
      if (host !== "127.0.0.1" && error) expect(error.message).toMatch(/non-loopback/);
      expect(fs.readFileSync(path.join(root, "egress-proof.txt"), "utf8")).toMatch(/EPERM|EACCES/);
      if (host === "127.0.0.1") {
        expect(await (await fetch(`http://127.0.0.1:${port}`)).text()).toBe("local server works");
      } else {
        const child = (
          service as unknown as { serverProcess: import("node:child_process").ChildProcess }
        ).serverProcess;
        await vi.waitFor(() => expect(child.signalCode).toBe("SIGKILL"), { timeout: 5000 });
        await expect(fetch(`http://127.0.0.1:${port}`)).rejects.toThrow();
      }
    },
    15_000,
  );
});
