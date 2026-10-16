import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotDesktopTools } from "../bot-desktop-tools";
import { BotDesktopManager } from "../../../computer-use/bot-desktop-manager";
import { ComputerViewService } from "../../../computer-use/computer-view-service";

function fakePng(width = 1280, height = 800): Buffer {
  const header = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(header, 0);
  header.writeUInt32BE(13, 8);
  header.write("IHDR", 12, "ascii");
  header.writeUInt32BE(width, 16);
  header.writeUInt32BE(height, 20);
  return header;
}

describe("BotDesktopTools", () => {
  let dataDir: string;
  let execs: string[][];
  const daemon = {
    getTask: vi.fn(() => ({ assignedAgentRoleId: "bot-1" })),
    logEvent: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    execs = [];
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "bot-desktop-tools-"));
    const resourcesDir = path.join(dataDir, "res");
    fs.mkdirSync(resourcesDir);
    fs.writeFileSync(path.join(resourcesDir, "Dockerfile"), "FROM scratch\n");
    fs.writeFileSync(path.join(resourcesDir, "start-desktop.sh"), "#!/bin/sh\n");
    const running = new Set<string>();
    BotDesktopManager.configure({
      dataDir: () => dataDir,
      resourcesDir: () => resourcesDir,
      runtimeCandidates: ["docker"],
      hostUid: 1000,
      run: async (_command, args) => {
        const out = (text: string) => ({ stdout: Buffer.from(text), stderr: "" });
        if (args[0] === "run") running.add(args[args.indexOf("--name") + 1]);
        if (args[0] === "inspect")
          return out(running.has(args[args.length - 1]) ? "true" : "false");
        if (args[0] === "exec") {
          execs.push(args.slice(args.indexOf("DISPLAY=:1") + 2));
          if (args.join(" ").includes("scrot")) return { stdout: fakePng(), stderr: "" };
        }
        return out("");
      },
    });
    ComputerViewService.resetForTesting({
      encodeFrame: () => ({ dataUrl: "data:image/jpeg;base64,", width: 960, height: 600 }),
      logEvent: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    BotDesktopManager.resetForTesting();
    ComputerViewService.resetForTesting();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("defines the desktop tools", () => {
    expect(BotDesktopTools.getToolDefinitions().map((tool) => tool.name)).toEqual([
      "desktop_screenshot",
      "desktop_open_url",
      "desktop_click",
      "desktop_type",
      "desktop_key",
      "desktop_scroll",
      "desktop_drag",
      "desktop_run",
    ]);
  });

  it("clicks with xdotool and returns a fresh screenshot the model can see", async () => {
    const tools = new BotDesktopTools(daemon, "task-1");
    const result = (await tools.execute("desktop_click", {
      x: 100.4,
      y: 200,
      double: true,
    })) as Any;
    expect(execs).toContainEqual([
      "xdotool",
      "mousemove",
      "--sync",
      "100",
      "200",
      "click",
      "--repeat",
      "2",
      "--delay",
      "80",
      "1",
    ]);
    expect(result).toMatchObject({
      success: true,
      mediaType: "image/png",
      width: 1280,
      height: 800,
    });
    expect(result.captureId).toMatch(/^desk_/);
    expect(ComputerViewService.getInstance().getState("task-1")).toMatchObject({
      status: "working",
      surface: "own_desktop",
    });
  });

  it("types text as one argument, never through a shell", async () => {
    await new BotDesktopTools(daemon, "task-1").execute("desktop_type", { text: "a; rm -rf ~" });
    expect(execs).toContainEqual(["xdotool", "type", "--delay", "12", "--", "a; rm -rf ~"]);
  });

  it("refuses unsafe input", async () => {
    const tools = new BotDesktopTools(daemon, "task-1");
    await expect(tools.execute("desktop_open_url", { url: "file:///etc/passwd" })).rejects.toThrow(
      /http or https/,
    );
    await expect(tools.execute("desktop_key", { keys: "ctrl+l; reboot" })).rejects.toThrow(
      /key name/,
    );
    await expect(tools.execute("desktop_click", { x: -5, y: 10 })).rejects.toThrow(/Coordinates/);
  });

  it("refuses to act while the person has taken over", async () => {
    ComputerViewService.getInstance().takeOver("task-1");
    await expect(
      new BotDesktopTools(daemon, "task-1").execute("desktop_screenshot"),
    ).rejects.toThrow(/taken over/);
  });

  it("works only for a bot's task", async () => {
    const tools = new BotDesktopTools({ getTask: () => ({}), logEvent: vi.fn() }, "task-2");
    await expect(tools.execute("desktop_screenshot")).rejects.toThrow(/Only a bot/);
  });

  it("runs commands inside the desktop, in the bot's work folder", async () => {
    const result = (await new BotDesktopTools(daemon, "task-1").execute("desktop_run", {
      command: "ls",
    })) as Any;
    expect(result.success).toBe(true);
    expect(execs).toContainEqual([
      "timeout",
      "--kill-after=5",
      "60s",
      "bash",
      "-lc",
      "cd ~/work && ls",
    ]);
  });
});
