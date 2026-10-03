import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Workspace } from "../../../../shared/types";
import { MacOSSandbox } from "../macos-sandbox";

const CONNECT = `
const socket = require("net").connect(process.argv[1]);
socket.on("data", (data) => { console.log("CONNECTED " + data); process.exit(0); });
socket.on("error", (error) => { console.log("CONNECT_ERR " + error.code); process.exit(0); });
`;

const SERVE_AND_CONNECT = `
const net = require("net");
const server = net.createServer((client) => client.end("own")).listen("own.sock", () => {
  net.connect("own.sock").on("data", (data) => { console.log("CONNECTED " + data); process.exit(0); })
    .on("error", (error) => { console.log("CONNECT_ERR " + error.code); process.exit(0); });
});
`;

// Runs real sandbox-exec processes with network access allowed.
describe.skipIf(process.platform !== "darwin")("macOS sandbox Unix-domain sockets", () => {
  let base: string;
  let workspace: Workspace;
  let server: net.Server | undefined;
  const sandboxes: MacOSSandbox[] = [];

  beforeEach(() => {
    // Short path: sun_path holds at most 104 bytes.
    base = fs.realpathSync(fs.mkdtempSync(path.join("/tmp", "cw-sock-")));
    const root = path.join(base, "ws");
    fs.mkdirSync(root);
    workspace = {
      id: "sandbox-sockets",
      name: "Sandbox sockets",
      path: root,
      permissions: {
        read: true,
        write: true,
        delete: true,
        shell: true,
        network: true,
        accessSandboxMode: "workspace-write",
      },
      createdAt: 0,
      updatedAt: 0,
    } as Workspace;
  });

  afterEach(async () => {
    for (const sandbox of sandboxes.splice(0)) sandbox.cleanup();
    await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
    server = undefined;
    fs.rmSync(base, { recursive: true, force: true });
  });

  const run = async (script: string, ...args: string[]) => {
    const sandbox = new MacOSSandbox(workspace);
    sandboxes.push(sandbox);
    const result = await sandbox.execute(process.execPath, ["-e", script, ...args], {
      cwd: workspace.path,
      timeout: 15_000,
      allowNetwork: true,
    });
    return `${result.stdout}\n${result.stderr}`;
  };

  it("cannot reach another program's socket (Docker daemon, ssh-agent) with network on", async () => {
    // Stands in for ~/.docker/run/docker.sock: a socket served by an
    // unsandboxed process outside the workspace.
    const hostSocket = path.join(base, "host.sock");
    server = net.createServer((client) => client.end("host")).listen(hostSocket);
    await new Promise((resolve) => server!.once("listening", resolve));
    const output = await run(CONNECT, hostSocket);
    expect(output).toContain("CONNECT_ERR EPERM");
    expect(output).not.toContain("CONNECTED");
  }, 30_000);

  it("still serves and connects to its own socket in the workspace", async () => {
    const output = await run(SERVE_AND_CONNECT);
    expect(output).toContain("CONNECTED own");
  }, 30_000);
});
