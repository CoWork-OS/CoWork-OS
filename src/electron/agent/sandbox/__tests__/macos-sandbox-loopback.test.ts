import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { once } from "node:events";
import { execFileSync, type ChildProcess } from "node:child_process";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { MacOSSandbox } from "../macos-sandbox";

// Every fixture binds explicitly to IPv4 or IPv6 loopback. No exposed listener
// is needed to prove the kernel denial inherited by children.
const PROBE = `
const net = require("node:net");
const host = process.argv[2];
setTimeout(() => process.exit(3), 5000).unref();
function listen() {
  const server = net.createServer(socket => socket.end("control"));
  server.on("error", error => { console.log("LISTEN_ERR " + error.code); process.exit(0); });
  server.listen(0, host, () => {
    console.log("LISTEN_OK");
    const client = net.connect({ host, port: server.address().port });
    client.on("data", () => { console.log("CONNECT_OK"); client.destroy(); server.close(() => process.exit(0)); });
    client.on("error", error => { console.log("CONNECT_ERR " + error.code); process.exit(1); });
  });
}
if (process.send) { process.send("ready"); process.once("message", listen); }
else listen();
`;

const DETACHED_PROBE = `
const { spawn } = require("node:child_process");
const child = spawn(process.execPath, [process.argv[2], process.argv[3]], {
  detached: true, stdio: ["ignore", "pipe", "pipe", "ipc"]
});
child.stdout.pipe(process.stdout); child.stderr.pipe(process.stderr);
child.on("message", () => {
  console.log("READY PARENT_PID " + process.pid + " CHILD_PID " + child.pid);
  process.stdin.once("data", () => child.send("listen"));
});
child.on("error", error => { console.error(error); process.exit(1); });
child.on("close", code => process.exit(code === null ? 1 : code));
`;

describe.skipIf(process.platform !== "darwin")("macOS kernel listener policy", () => {
  let base: string;
  let workspace: Workspace;
  let sandbox: MacOSSandbox;
  let probePath: string;
  let detachedPath: string;

  beforeEach(() => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-listener-policy-"));
    const root = path.join(base, "workspace");
    fs.mkdirSync(root);
    workspace = {
      id: "listener-policy",
      name: "Listener policy",
      path: root,
      permissions: {
        read: true,
        write: true,
        delete: true,
        shell: true,
        network: false,
        accessSandboxMode: "workspace-write",
        accessNetworkMode: "disabled",
      },
      createdAt: 0,
      updatedAt: 0,
    } as Workspace;
    sandbox = new MacOSSandbox(workspace);
    probePath = path.join(root, "listen.cjs");
    detachedPath = path.join(root, "detach.cjs");
    fs.writeFileSync(probePath, PROBE);
    fs.writeFileSync(detachedPath, DETACHED_PROBE);
  });
  afterEach(() => {
    sandbox.cleanup();
    fs.rmSync(base, { recursive: true, force: true });
  });

  it.each([false, true])(
    "denies listening with legacy opt-in=%s",
    async (allowLoopbackListen) => {
      const result = await sandbox.execute(process.execPath, [probePath, "127.0.0.1"], {
        cwd: workspace.path,
        timeout: 10000,
        allowLoopbackListen,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("LISTEN_ERR EPERM");
      expect(result.stdout).not.toContain("LISTEN_OK");
    },
    15000,
  );

  it("denies IPv6 loopback listening", async () => {
    const result = await sandbox.execute(process.execPath, [probePath, "::1"], {
      cwd: workspace.path,
      timeout: 10000,
      allowLoopbackListen: true,
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("LISTEN_ERR EPERM");
  }, 15000);

  it.each(["execute", "spawnProcess"] as const)(
    "retains denial after a descendant changes process group through %s",
    async (route) => {
      const args = [detachedPath, probePath, "127.0.0.1"];
      let groups: { parent: number; child: number; childPid: number } | undefined;
      let observationError: unknown;
      const observe = (process: ChildProcess) => {
        let buffered = "";
        let observed = false;
        process.stdout?.on("data", (chunk) => {
          buffered += String(chunk);
          const ready = buffered.match(/READY PARENT_PID (\d+) CHILD_PID (\d+)/);
          if (!ready || observed) return;
          observed = true;
          try {
            // Inspect from the host harness; do not give the sandboxed child
            // extra process-inspection authority just to measure this property.
            const pgid = (pid: string) =>
              Number(
                execFileSync("/bin/ps", ["-o", "pgid=", "-p", pid], { encoding: "utf8" }).trim(),
              );
            groups = { parent: pgid(ready[1]), child: pgid(ready[2]), childPid: Number(ready[2]) };
          } catch (error) {
            observationError = error;
          } finally {
            process.stdin?.write("listen\n");
          }
        });
      };
      let output: string;
      if (route === "execute") {
        const result = await sandbox.execute(process.execPath, args, {
          cwd: workspace.path,
          timeout: 10000,
          allowLoopbackListen: true,
          onProcess: observe,
        });
        expect(result.exitCode, result.stdout + result.stderr).toBe(0);
        output = result.stdout + result.stderr;
      } else {
        const launched = sandbox.spawnProcess(process.execPath, args, {
          cwd: workspace.path,
          detached: true,
          allowLoopbackListen: true,
          onProcess: observe,
        });
        const chunks: string[] = [];
        launched.process.stdout?.on("data", (chunk) => chunks.push(String(chunk)));
        launched.process.stderr?.on("data", (chunk) => chunks.push(String(chunk)));
        try {
          const [code] = await once(launched.process, "close");
          expect(code, chunks.join("")).toBe(0);
        } finally {
          launched.cleanup();
        }
        output = chunks.join("");
      }
      expect(observationError).toBeUndefined();
      expect(groups).toBeDefined();
      expect(groups!.child).toBe(groups!.childPid);
      expect(groups!.child).not.toBe(groups!.parent);
      expect(output).toContain("LISTEN_ERR EPERM");
      expect(output).not.toContain("LISTEN_OK");
    },
    15000,
  );

  it.each(["127.0.0.1", "::1"])(
    "permits an authorized dev server on %s",
    async (host) => {
      workspace.permissions.network = true;
      workspace.permissions.accessNetworkMode = "enabled";
      const result = await sandbox.execute(process.execPath, [probePath, host], {
        cwd: workspace.path,
        timeout: 10000,
        allowNetwork: true,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("LISTEN_OK");
      expect(result.stdout).toContain("CONNECT_OK");
    },
    15000,
  );

  it("preserves outbound connections to an existing loopback service", async () => {
    const server = net.createServer((socket) => socket.end("HOST_CONTROL"));
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const port = (server.address() as net.AddressInfo).port;
    const clientPath = path.join(workspace.path, "client.cjs");
    fs.writeFileSync(
      clientPath,
      `const socket=require("node:net").connect({host:"127.0.0.1",port:${port}}); socket.on("data",data=>console.log(String(data))); socket.on("error",()=>process.exit(1));`,
    );
    try {
      const result = await sandbox.execute(process.execPath, [clientPath], {
        cwd: workspace.path,
        timeout: 10000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("HOST_CONTROL");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  }, 15000);
});
