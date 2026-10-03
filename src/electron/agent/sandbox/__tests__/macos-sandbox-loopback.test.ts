import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { MacOSSandbox } from "../macos-sandbox";
import { LoopbackListenerGuard } from "../loopback-listener-guard";
import type { LoopbackListenerViolation } from "../loopback-listener-guard";

// A server that listens on the given host, connects to itself, then tries
// egress to a public address (TEST-NET, so it never leaves the machine even
// if it were allowed) and a UDP bind.
const PROBE = `
const net = require("net");
const dgram = require("dgram");
const host = process.argv[1];
const server = net.createServer((socket) => socket.end("hi"));
server.on("error", (error) => { console.log("LISTEN_ERR " + error.code); process.exit(0); });
server.listen(0, host, () => {
  console.log("LISTEN_OK");
  const client = net.connect(server.address().port, host);
  client.on("data", () => {
    console.log("CONNECT_OK");
    const egress = net.connect(80, "192.0.2.1");
    egress.setTimeout(1500);
    egress.on("connect", () => { console.log("EGRESS_OK"); finish(); });
    egress.on("error", (error) => { console.log("EGRESS_ERR " + error.code); finish(); });
    egress.on("timeout", () => { console.log("EGRESS_TIMEOUT"); finish(); });
  });
  client.on("error", (error) => { console.log("CONNECT_ERR " + error.code); process.exit(0); });
});
function finish() {
  const udp = dgram.createSocket("udp4");
  udp.on("error", (error) => { console.log("UDP_ERR " + error.code); process.exit(0); });
  udp.bind(0, "127.0.0.1", () => { console.log("UDP_OK"); process.exit(0); });
}
`;

function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// Runs real sandbox-exec processes.
describe.skipIf(process.platform !== "darwin")("macOS sandbox loopback servers", () => {
  let base: string;
  let workspace: Workspace;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-sandbox-loopback-"));
    const root = path.join(base, "workspace");
    fs.mkdirSync(root);
    workspace = {
      id: "sandbox-loopback",
      name: "Sandbox loopback",
      path: root,
      permissions: {
        read: true,
        write: true,
        delete: true,
        shell: true,
        network: false,
        accessSandboxMode: "workspace-write",
      },
      createdAt: 0,
      updatedAt: 0,
    } as Workspace;
  });

  afterEach(() => {
    fs.rmSync(base, { recursive: true, force: true });
  });

  async function probe(host: string, allowLoopbackListen: boolean): Promise<string> {
    const sandbox = new MacOSSandbox(workspace);
    try {
      const result = await sandbox.execute(process.execPath, ["-e", PROBE, host], {
        cwd: workspace.path,
        timeout: 15_000,
        allowLoopbackListen,
        envPassthrough: ["PATH", "HOME", "USER", "LANG", "TERM"],
      });
      return `${result.stdout}\n${result.stderr}`;
    } finally {
      sandbox.cleanup();
    }
  }

  it("denies listening by default", async () => {
    expect(await probe("127.0.0.1", false)).toContain("LISTEN_ERR EPERM");
  }, 30_000);

  it.each(["127.0.0.1", "::1"])(
    "serves on %s while egress and UDP binds stay denied",
    async (host) => {
      const output = await probe(host, true);
      expect(output).toContain("LISTEN_OK");
      expect(output).toContain("CONNECT_OK");
      expect(output).toContain("EGRESS_ERR EPERM");
      expect(output).toContain("UDP_ERR EPERM");
    },
    30_000,
  );

  it("lets the guard catch a server that listens on all interfaces", async () => {
    const sandbox = new MacOSSandbox(workspace);
    const { process: child } = sandbox.spawnProcess(
      process.execPath,
      ["-e", 'require("net").createServer().listen(0, "0.0.0.0", () => console.log("LISTENING"))'],
      { cwd: workspace.path, allowLoopbackListen: true, detached: true },
    );
    const guard = new LoopbackListenerGuard(undefined, 100);
    try {
      const violation = await new Promise<LoopbackListenerViolation>((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("guard did not report")), 10_000);
        guard.watch(child.pid!, (found) => {
          clearTimeout(timer);
          resolve(found);
        });
      });
      expect(violation.address).toMatch(/^\*\.\d+$/);
    } finally {
      process.kill(-child.pid!, "SIGKILL");
      sandbox.cleanup();
    }
    const deadline = Date.now() + 5_000;
    while (isRunning(child.pid!) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(isRunning(child.pid!)).toBe(false);
  }, 30_000);
});
