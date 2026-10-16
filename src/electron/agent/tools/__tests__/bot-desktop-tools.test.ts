import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BotDesktopTools } from "../bot-desktop-tools";
import { BotDesktopManager } from "../../../computer-use/bot-desktop-manager";
import { BotTaskRecordings } from "../../../computer-use/bot-task-recordings";
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
  let inputs: string[];
  let recordingOnDesktop: boolean;
  const daemon = {
    getTask: vi.fn(() => ({ assignedAgentRoleId: "bot-1" })),
    logEvent: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    execs = [];
    inputs = [];
    recordingOnDesktop = false;
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
      run: async (_command, args, options) => {
        const out = (text: string) => ({ stdout: Buffer.from(text), stderr: "" });
        if (args[0] === "run") running.add(args[args.indexOf("--name") + 1]);
        if (args[0] === "inspect")
          return out(running.has(args[args.length - 1]) ? "true" : "false");
        if (args[0] === "exec") {
          const program = args.slice(args.indexOf("DISPLAY=:1") + 2);
          execs.push(program);
          if (options?.input !== undefined) inputs.push(options.input);
          if (args.join(" ").includes("scrot")) return { stdout: fakePng(), stderr: "" };
          if (program[0] === "cowork-teach" && program[1] === "status") {
            return out(recordingOnDesktop ? "recording" : "idle");
          }
          if (program[0] === "cowork-teach" && program[1] === "record") recordingOnDesktop = true;
          if (program[0] === "cowork-teach" && program[1] === "cancel") recordingOnDesktop = false;
        }
        return out("");
      },
    });
    ComputerViewService.resetForTesting({
      encodeFrame: () => ({ dataUrl: "data:image/jpeg;base64,", width: 960, height: 600 }),
      logEvent: vi.fn(),
    });
    BotTaskRecordings.configure({ dataDir: () => dataDir });
  });

  afterEach(() => {
    vi.useRealTimers();
    BotDesktopManager.resetForTesting();
    BotTaskRecordings.resetForTesting();
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
      "desktop_save_file",
      "desktop_taught_tasks",
      "desktop_replay_task",
      "desktop_run",
    ]);
  });

  describe("taught tasks", () => {
    const events = [
      { t: 0, e: "button" as const, down: 1 as const, d: 1, x: 300, y: 200 },
      { t: 80, e: "button" as const, down: 0 as const, d: 1, x: 300, y: 200 },
      { t: 2400, e: "key" as const, down: 1 as const, d: 36, x: 300, y: 200 },
    ];

    it("lists the tasks the person taught, by name and length only", async () => {
      const tools = new BotDesktopTools(daemon, "task-1");
      expect(await tools.execute("desktop_taught_tasks")).toMatchObject({ tasks: [] });
      BotTaskRecordings.getInstance().save("bot-1", "Download the invoice", events);
      const result = (await tools.execute("desktop_taught_tasks")) as Any;
      expect(result.tasks).toEqual([
        { name: "Download the invoice", seconds: 2, taught: expect.any(String) },
      ]);
      expect(JSON.stringify(result)).not.toContain('"d":36');
    });

    it("replays a taught task on the desktop and returns a screenshot", async () => {
      BotTaskRecordings.getInstance().save("bot-1", "Download the invoice", events);
      const result = (await new BotDesktopTools(daemon, "task-1").execute("desktop_replay_task", {
        name: "download the invoice",
      })) as Any;
      expect(execs).toContainEqual(["cowork-teach", "play"]);
      // The recording goes in over stdin (the desktop never keeps it).
      expect(inputs.at(-1)?.trim().split("\n")).toHaveLength(3);
      expect(result).toMatchObject({ success: true, mediaType: "image/png" });
      expect(result.note).toContain('Replayed "Download the invoice"');
    });

    it("names the taught tasks when asked for one that doesn't exist", async () => {
      BotTaskRecordings.getInstance().save("bot-1", "Download the invoice", events);
      await expect(
        new BotDesktopTools(daemon, "task-1").execute("desktop_replay_task", { name: "Pay rent" }),
      ).rejects.toThrow(/This bot was taught: "Download the invoice"/);
      expect(execs).toEqual([]);
    });

    it("keeps the bot off its desktop while the person is recording a task", async () => {
      await BotDesktopManager.getInstance().startRecording("bot-1");
      const tools = new BotDesktopTools(daemon, "task-1");
      await expect(tools.execute("desktop_click", { x: 1, y: 1 })).rejects.toThrow(
        /teaching you a task/,
      );
      await expect(tools.execute("desktop_run", { command: "ls" })).rejects.toThrow(
        /teaching you a task/,
      );
      await BotDesktopManager.getInstance().finishRecording("bot-1", false);
      await expect(tools.execute("desktop_click", { x: 1, y: 1 })).resolves.toMatchObject({
        success: true,
      });
    });
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

  it("hands a file from its work folder to the conversation's workspace", async () => {
    const workspacePath = path.join(dataDir, "workspace");
    fs.mkdirSync(workspacePath);
    const home = BotDesktopManager.getInstance().homeFolder("bot-1");
    fs.mkdirSync(path.join(home, "Downloads"), { recursive: true });
    fs.writeFileSync(path.join(home, "Downloads", "report.pdf"), "pdf-bytes");
    const tools = new BotDesktopTools(daemon, "task-1", () => ({
      path: workspacePath,
      permissions: { read: true, write: true, delete: false, network: true, shell: false },
    }));
    const first = (await tools.execute("desktop_save_file", {
      path: "Downloads/report.pdf",
    })) as Any;
    const second = (await tools.execute("desktop_save_file", {
      path: "Downloads/report.pdf",
    })) as Any;
    expect(first).toMatchObject({
      success: true,
      path: path.join("artifacts", "bot-desktop", "report.pdf"),
    });
    expect(second.path).toBe(path.join("artifacts", "bot-desktop", "report (2).pdf"));
    expect(fs.readFileSync(path.join(workspacePath, first.path), "utf8")).toBe("pdf-bytes");
    // A name taken by the person's own file is skipped, never replaced.
    const own = path.join(workspacePath, "artifacts", "bot-desktop", "report (3).pdf");
    fs.writeFileSync(own, "mine");
    const third = (await tools.execute("desktop_save_file", {
      path: "Downloads/report.pdf",
    })) as Any;
    expect(third.path).toBe(path.join("artifacts", "bot-desktop", "report (4).pdf"));
    expect(fs.readFileSync(own, "utf8")).toBe("mine");
    expect(daemon.logEvent).toHaveBeenCalledWith(
      "task-1",
      "artifact_created",
      expect.objectContaining({ source: "bot_desktop" }),
    );
    await expect(tools.execute("desktop_save_file", { path: "../../etc/passwd" })).rejects.toThrow(
      /inside ~\/work/,
    );
  });
});
