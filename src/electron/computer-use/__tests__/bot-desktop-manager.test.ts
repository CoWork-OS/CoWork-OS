import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotDesktopManager, botDesktopKey, pngSize } from "../bot-desktop-manager";

function fakePng(width = 1280, height = 800): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

describe("BotDesktopManager", () => {
  let dataDir: string;
  let resourcesDir: string;
  let calls: string[][];
  let running: Set<string>;
  let imageBuilt: boolean;

  const runner = vi.fn(async (command: string, fullArgs: string[]) => {
    calls.push([command, ...fullArgs]);
    // A command for a server carries --host ssh://...; it behaves the same here.
    const args = fullArgs[0] === "--host" ? fullArgs.slice(2) : fullArgs;
    const out = (text: string) => ({ stdout: Buffer.from(text), stderr: "" });
    switch (args[0]) {
      case "version":
        if (command === "docker") return out("29.0.0");
        throw new Error("not installed");
      case "image":
        if (imageBuilt) return out("[]");
        throw new Error("No such image");
      case "build":
        imageBuilt = true;
        return out("");
      case "run":
        running.add(args[args.indexOf("--name") + 1]);
        return out("container-id");
      case "inspect":
        return out(running.has(args[args.length - 1]) ? "true" : "false");
      case "exec":
        if (args.includes("scrot --overwrite /tmp/cowork-shot.png && cat /tmp/cowork-shot.png")) {
          return { stdout: fakePng(), stderr: "" };
        }
        return out("1280 800");
      case "port":
        return out("127.0.0.1:55123\n");
      case "stop":
      case "rm":
        for (const name of args.slice(1)) running.delete(name);
        return out("");
      case "ps":
        return out("cowork-desktop-abc\nunrelated\n");
      default:
        return out("");
    }
  });

  beforeEach(() => {
    calls = [];
    running = new Set();
    imageBuilt = false;
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-desktop-data-"));
    resourcesDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-desktop-res-"));
    fs.writeFileSync(path.join(resourcesDir, "Dockerfile"), "FROM scratch\n");
    fs.writeFileSync(path.join(resourcesDir, "start-desktop.sh"), "#!/bin/sh\n");
    BotDesktopManager.configure({
      dataDir: () => dataDir,
      resourcesDir: () => resourcesDir,
      run: runner,
      runtimeCandidates: ["podman", "docker"],
      waitMs: 1000,
    });
  });

  afterEach(() => {
    BotDesktopManager.resetForTesting();
    fs.rmSync(dataDir, { recursive: true, force: true });
    fs.rmSync(resourcesDir, { recursive: true, force: true });
  });

  it("uses the first runtime whose daemon answers", async () => {
    expect(await BotDesktopManager.getInstance().detectRuntime()).toEqual({
      name: "docker",
      binary: "docker",
    });
  });

  it("builds the image once and starts a locked-down container for the bot", async () => {
    const manager = BotDesktopManager.getInstance();
    const png = await manager.withDesktop("bot-1", (desktop) => desktop.screenshot());
    expect(pngSize(png)).toEqual({ width: 1280, height: 800 });
    expect(calls.filter((call) => call[1] === "build")).toHaveLength(1);
    const run = calls.find((call) => call[1] === "run")!;
    expect(run).toEqual(
      expect.arrayContaining(["--cap-drop", "ALL", "--security-opt", "no-new-privileges"]),
    );
    expect(run).toContain("127.0.0.1::6080");
    expect(run).toContain(`cowork-desktop-${botDesktopKey("bot-1")}`);
    // The only host folder it sees is the bot's own home folder.
    const volumes = run.filter((_, index) => run[index - 1] === "--volume");
    expect(volumes).toEqual([`${manager.homeFolder("bot-1")}:/home/bot/work`]);
    expect(fs.statSync(manager.homeFolder("bot-1")).isDirectory()).toBe(true);

    await manager.withDesktop("bot-1", async () => undefined);
    expect(calls.filter((call) => call[1] === "run")).toHaveLength(1);
  });

  it("runs programs inside the desktop as the bot user, without a host shell", async () => {
    await BotDesktopManager.getInstance().withDesktop("bot-1", (desktop) =>
      desktop.exec(["xdotool", "type", "--", "hello; rm -rf /"]),
    );
    const exec = calls.filter((call) => call[1] === "exec").pop()!;
    expect(exec.slice(0, 6)).toEqual(["docker", "exec", "--user", "bot", "--env", "DISPLAY=:1"]);
    expect(exec.slice(-4)).toEqual(["xdotool", "type", "--", "hello; rm -rf /"]);
  });

  it("lets one task of a bot use its desktop at a time", async () => {
    const manager = BotDesktopManager.getInstance();
    const order: string[] = [];
    let release!: () => void;
    const first = manager.withDesktop("bot-1", async () => {
      order.push("first-start");
      await new Promise<void>((resolve) => (release = resolve));
      order.push("first-end");
    });
    await vi.waitFor(() => expect(order).toEqual(["first-start"]));
    const second = manager.withDesktop("bot-1", async () => {
      order.push("second");
    });
    release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first-start", "first-end", "second"]);
  });

  it("gives up waiting for a busy desktop", async () => {
    const manager = BotDesktopManager.getInstance();
    let release!: () => void;
    const first = manager.withDesktop(
      "bot-1",
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    await expect(manager.withDesktop("bot-1", async () => undefined)).rejects.toThrow(/busy/);
    release();
    await first;
  });

  it("gives a loopback viewer address that is read-only unless asked otherwise", async () => {
    const manager = BotDesktopManager.getInstance();
    const watching = new URL(await manager.viewerUrl("bot-1"));
    expect(watching.origin).toBe("http://127.0.0.1:55123");
    expect(watching.searchParams.get("view_only")).toBe("1");
    expect(watching.searchParams.get("password")).toMatch(/^.{8}$/);
    const using = new URL(await manager.viewerUrl("bot-1", { viewOnly: false }));
    expect(using.searchParams.get("view_only")).toBe("0");
  });

  it("stops desktops an earlier session left running, and only those", async () => {
    await BotDesktopManager.getInstance().stopLeftovers();
    expect(calls.find((call) => call[1] === "stop")).toEqual([
      "docker",
      "stop",
      "--time",
      "5",
      "cowork-desktop-abc",
    ]);
  });

  it("explains what is missing without a container runtime", async () => {
    BotDesktopManager.configure({
      dataDir: () => dataDir,
      resourcesDir: () => resourcesDir,
      run: async () => {
        throw new Error("not found");
      },
    });
    const status = await BotDesktopManager.getInstance().getStatus("bot-1");
    expect(status.state).toBe("unavailable");
    expect(status.reason).toMatch(/Docker Desktop or Podman/);
    await expect(
      BotDesktopManager.getInstance().withDesktop("bot-1", async () => undefined),
    ).rejects.toThrow(/Docker Desktop or Podman/);
  });

  describe("on your own server", () => {
    const servers: net.Server[] = [];
    afterEach(() => {
      for (const server of servers.splice(0)) server.close();
    });

    const configureRemote = (run = runner) => {
      const tunnels: Array<{ host: string; localPort: number; remotePort: number }> = [];
      BotDesktopManager.configure({
        dataDir: () => dataDir,
        resourcesDir: () => resourcesDir,
        run,
        runtimeCandidates: ["docker"],
        waitMs: 1000,
        desktopHostFor: () => "my-server",
        openTunnel: (host, localPort, remotePort) => {
          tunnels.push({ host, localPort, remotePort });
          // Stands in for ssh -L: something now listens on the local port.
          const server = net.createServer((socket) => socket.end());
          server.listen(localPort, "127.0.0.1");
          servers.push(server);
          return { kill: vi.fn(), exitCode: null } as Any;
        },
      });
      return tunnels;
    };

    it("runs Docker on the server over SSH, with the bot's files in a volume there", async () => {
      configureRemote();
      const manager = BotDesktopManager.getInstance();
      await manager.withDesktop("bot-1", (desktop) => desktop.exec(["true"]));
      const run = calls.find((call) => call.includes("run"))!;
      expect(run.slice(0, 4)).toEqual(["docker", "--host", "ssh://my-server", "run"]);
      const volumes = run.filter((_, index) => run[index - 1] === "--volume");
      expect(volumes).toEqual([`cowork-desktop-${botDesktopKey("bot-1")}-home:/home/bot/work`]);
      expect(fs.existsSync(manager.homeFolder("bot-1"))).toBe(false);
      const exec = calls.filter((call) => call.includes("exec")).pop()!;
      expect(exec.slice(0, 4)).toEqual(["docker", "--host", "ssh://my-server", "exec"]);
      expect(calls.find((call) => call.includes("build"))?.slice(0, 3)).toEqual([
        "docker",
        "--host",
        "ssh://my-server",
      ]);
    });

    it("shows the viewer through an SSH tunnel to the server's loopback", async () => {
      const tunnels = configureRemote();
      const url = new URL(await BotDesktopManager.getInstance().viewerUrl("bot-1"));
      expect(tunnels).toHaveLength(1);
      expect(tunnels[0]).toMatchObject({ host: "my-server", remotePort: 55123 });
      expect(url.hostname).toBe("127.0.0.1");
      expect(Number(url.port)).toBe(tunnels[0].localPort);
    });

    it("explains an untrusted host key instead of accepting it", async () => {
      configureRemote(async (command, args) => {
        if (args[0] === "--host") throw new Error("Host key verification failed.");
        return runner(command, args);
      });
      await expect(
        BotDesktopManager.getInstance().withDesktop("bot-1", async () => undefined),
      ).rejects.toThrow(/doesn't trust my-server yet.*ssh my-server/);
    });
  });
});
