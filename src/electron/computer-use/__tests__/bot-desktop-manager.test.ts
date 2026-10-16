import * as fs from "fs";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  BotDesktopManager,
  botDesktopKey,
  normalizeDesktopFilePath,
  pngSize,
} from "../bot-desktop-manager";

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
        if (args.some((arg) => arg.includes("scrot"))) {
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
      hostUid: 1000,
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
    // The viewer passwords never ride in the environment: they go in over stdin after start.
    expect(run.join(" ")).not.toContain("VNC_PASSWORD");
    const passwd = calls.find((call) => call.join(" ").includes(".vnc/passwd"))!;
    expect(passwd.slice(0, 4)).toEqual(["docker", "exec", "--interactive", "--user"]);
    expect(runner.mock.calls.find((call) => call[1].includes("--interactive"))?.[2]?.input).toMatch(
      /^.{8}\n__BEGIN_VIEWONLY__\n.{8}\n$/,
    );

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
    // Watching gets the view-only password; only take-over gets the one that can drive it.
    expect(using.searchParams.get("password")).not.toBe(watching.searchParams.get("password"));
  });

  it("skips idle stop while the person is using the desktop, and the poller while a task is", async () => {
    let inUse = true;
    let now = 0;
    BotDesktopManager.configure({
      dataDir: () => dataDir,
      resourcesDir: () => resourcesDir,
      run: runner,
      runtimeCandidates: ["docker"],
      hostUid: 1000,
      idleStopMs: 1000,
      now: () => now,
      inUse: () => inUse,
    });
    const manager = BotDesktopManager.getInstance();
    let release!: () => void;
    const turn = manager.withDesktop("bot-1", async () => {
      await new Promise<void>((resolve) => (release = resolve));
    });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(await manager.captureIfRunning("bot-1")).toBeNull();
    release();
    await turn;
    expect(await manager.captureIfRunning("bot-1")).not.toBeNull();
    now = 5000;
    await (manager as Any).stopIdleDesktops();
    expect(calls.find((call) => call[1] === "stop")).toBeUndefined();
    inUse = false;
    await (manager as Any).stopIdleDesktops();
    expect(calls.find((call) => call[1] === "stop")).toBeDefined();
  });

  it("remembers that no runtime was found instead of probing on every call", async () => {
    const probes: string[] = [];
    BotDesktopManager.configure({
      dataDir: () => dataDir,
      resourcesDir: () => resourcesDir,
      runtimeCandidates: ["docker", "podman"],
      run: async (command) => {
        probes.push(command);
        throw new Error("not found");
      },
    });
    const manager = BotDesktopManager.getInstance();
    expect((await manager.getStatus("bot-1")).state).toBe("unavailable");
    expect((await manager.getStatus("bot-1")).state).toBe("unavailable");
    expect(probes).toEqual(["docker", "podman"]);
  });

  it("stops desktops an earlier session left running, here and on bots' servers", async () => {
    BotDesktopManager.configure({
      dataDir: () => dataDir,
      resourcesDir: () => resourcesDir,
      run: runner,
      runtimeCandidates: ["docker"],
      hostUid: 1000,
      desktopHosts: () => ["my-server", "my-server", "bad host"],
    });
    await BotDesktopManager.getInstance().stopLeftovers();
    const stops = calls.filter((call) => call.includes("stop"));
    expect(stops).toEqual([
      ["docker", "stop", "--time", "5", "cowork-desktop-abc"],
      ["docker", "--host", "ssh://my-server", "stop", "--time", "5", "cowork-desktop-abc"],
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

    it("refuses a link in the work folder instead of reading through it", async () => {
      const reads: string[][] = [];
      configureRemote(async (command, args) => {
        const exec = args.indexOf("exec");
        if (exec >= 0 && args.includes("stat")) {
          return { stdout: Buffer.from("symbolic link\t9\n"), stderr: "" };
        }
        if (exec >= 0 && args.includes("head")) reads.push(args);
        return runner(command, args);
      });
      await expect(BotDesktopManager.getInstance().readFile("bot-1", "zero")).rejects.toThrow(
        /not a file/,
      );
      expect(reads).toHaveLength(0);
    });

    // What Docker prints when its SSH connection fails, around ssh's own message.
    const sshFailure = (stderr: string) =>
      new Error(
        `error during connect: Get "http://docker.example.com/v1.55/containers/json": command ` +
          `[ssh -o ConnectTimeout=30 -T -- my-server docker system dial-stdio] has exited with ` +
          `exit status 255, make sure the URL is valid: stderr=${stderr}`,
      );

    it("explains an untrusted host key instead of accepting it", async () => {
      configureRemote(async (command, args) => {
        if (args[0] === "--host") throw sshFailure("Host key verification failed.");
        return runner(command, args);
      });
      await expect(
        BotDesktopManager.getInstance().withDesktop("bot-1", async () => undefined),
      ).rejects.toThrow(/doesn't trust my-server yet.*ssh my-server/);
    });

    it("explains other connection failures with ssh's own words", async () => {
      configureRemote(async (command, args) => {
        if (args[0] === "--host") throw sshFailure("Connection closed by 10.0.0.5 port 22");
        return runner(command, args);
      });
      await expect(
        BotDesktopManager.getInstance().withDesktop("bot-1", async () => undefined),
      ).rejects.toThrow(
        /couldn't connect to my-server over SSH \(Connection closed by 10\.0\.0\.5/,
      );
    });

    it("reports a command's own Permission denied as it is, not as an SSH sign-in problem", async () => {
      configureRemote(async (command, args) => {
        if (args[0] === "--host" && args.includes("exec") && args.includes("touch")) {
          throw new Error("touch: cannot touch 'x': Permission denied");
        }
        return runner(command, args);
      });
      await expect(
        BotDesktopManager.getInstance().withDesktop("bot-1", (desktop) =>
          desktop.exec(["touch", "x"]),
        ),
      ).rejects.toThrow("touch: cannot touch 'x': Permission denied");
    });
  });

  describe("files in its work folder", () => {
    it("accepts paths inside ~/work only", () => {
      expect(normalizeDesktopFilePath("Downloads/report.pdf")).toBe("Downloads/report.pdf");
      expect(normalizeDesktopFilePath("~/work/a.txt")).toBe("a.txt");
      expect(normalizeDesktopFilePath("/home/bot/work/./b.txt")).toBe("b.txt");
      for (const bad of ["", "/etc/passwd", "../secret", "a/../../b", ".browser/Cookies"]) {
        expect(() => normalizeDesktopFilePath(bad)).toThrow(/inside ~\/work/);
      }
    });

    it("lists the newest files, without the browser profile", async () => {
      const manager = BotDesktopManager.getInstance();
      const home = manager.homeFolder("bot-1");
      fs.mkdirSync(path.join(home, "Downloads"), { recursive: true });
      fs.mkdirSync(path.join(home, ".browser"), { recursive: true });
      fs.writeFileSync(path.join(home, "old.txt"), "old");
      fs.utimesSync(path.join(home, "old.txt"), new Date(1000), new Date(1000));
      fs.writeFileSync(path.join(home, "Downloads", "report.pdf"), "pdf-bytes");
      fs.writeFileSync(path.join(home, ".browser", "Cookies"), "secret");
      const files = await manager.listFiles("bot-1");
      expect(files.map((file) => file.path)).toEqual(["Downloads/report.pdf", "old.txt"]);
      expect(files[0].size).toBe(9);
    });

    it("never leads outside the work folder, even through a link", async () => {
      const manager = BotDesktopManager.getInstance();
      const home = manager.homeFolder("bot-1");
      fs.mkdirSync(home, { recursive: true });
      const outside = path.join(dataDir, "outside.txt");
      fs.writeFileSync(outside, "private");
      fs.symlinkSync(outside, path.join(home, "link.txt"));
      expect(() => manager.localFilePath("bot-1", "link.txt")).toThrow(/outside/);
      await expect(manager.readFile("bot-1", "link.txt")).rejects.toThrow(/outside/);
      fs.writeFileSync(path.join(home, "ok.txt"), "fine");
      expect((await manager.readFile("bot-1", "ok.txt")).data.toString()).toBe("fine");
    });
  });

  describe("a shared desktop", () => {
    const configureShared = (groups: Record<string, string>) =>
      BotDesktopManager.configure({
        dataDir: () => dataDir,
        resourcesDir: () => resourcesDir,
        run: runner,
        runtimeCandidates: ["docker"],
        waitMs: 1000,
        desktopGroupFor: (botId) => groups[botId],
      });

    it("gives bots with the same name one desktop and one home folder", async () => {
      const manager = configureShared({ "bot-1": "research-team", "bot-2": "research-team" });
      await manager.withDesktop("bot-1", async () => undefined);
      await manager.withDesktop("bot-2", async () => undefined);
      expect(calls.filter((call) => call[1] === "run")).toHaveLength(1);
      expect(manager.desktopKey("bot-1")).toBe(manager.desktopKey("bot-2"));
      expect(manager.homeFolder(manager.desktopKey("bot-1"))).not.toBe(manager.homeFolder("bot-1"));
    });

    it("makes bots on a shared desktop take turns", async () => {
      const manager = configureShared({ "bot-1": "research-team", "bot-2": "research-team" });
      let release!: () => void;
      const first = manager.withDesktop(
        "bot-1",
        () => new Promise<void>((resolve) => (release = resolve)),
      );
      await vi.waitFor(() => expect(release).toBeTypeOf("function"));
      await expect(manager.withDesktop("bot-2", async () => undefined)).rejects.toThrow(/busy/);
      release();
      await first;
    });

    it("asks whether the shared desktop is in use by its key, not by one bot", async () => {
      let now = 0;
      const asked: string[] = [];
      const manager = BotDesktopManager.configure({
        dataDir: () => dataDir,
        resourcesDir: () => resourcesDir,
        run: runner,
        runtimeCandidates: ["docker"],
        idleStopMs: 1000,
        now: () => now,
        desktopGroupFor: () => "research-team",
        inUse: (key) => {
          asked.push(key);
          return true;
        },
      });
      await manager.withDesktop("bot-1", async () => undefined);
      now = 5000;
      await (manager as Any).stopIdleDesktops();
      expect(asked).toEqual([manager.desktopKey("bot-1")]);
      expect(calls.find((call) => call[1] === "stop")).toBeUndefined();
    });

    it("keeps bots without a shared name on desktops of their own", () => {
      const manager = configureShared({ "bot-1": "research-team" });
      expect(manager.desktopKey("bot-2")).toBe("bot-2");
      expect(manager.desktopKey("bot-1")).not.toBe(manager.desktopKey("bot-2"));
    });
  });
});
