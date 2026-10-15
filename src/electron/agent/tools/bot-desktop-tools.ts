import { createHash } from "crypto";
import type { LLMTool } from "../llm/types";
import {
  BotDesktopManager,
  pngSize,
  type BotDesktopSession,
} from "../../computer-use/bot-desktop-manager";
import { ComputerViewService } from "../../computer-use/computer-view-service";

interface DaemonLike {
  getTask?: (taskId: string) => { assignedAgentRoleId?: string } | undefined;
  logEvent: (taskId: string, type: string, payload: Record<string, unknown>) => void;
}

const MAX_TYPE_LENGTH = 4000;
const MAX_URL_LENGTH = 4096;
const MAX_COMMAND_OUTPUT = 12_000;
/** xdotool key names: letters, digits and + - _ only (e.g. ctrl+l, Return, alt+F4). */
const KEY_PATTERN = /^[A-Za-z0-9_+-]{1,64}$/;

const point = (description: string) => ({
  type: "object" as const,
  properties: {
    x: { type: "number", description: `${description} x, in screenshot pixels` },
    y: { type: "number", description: `${description} y, in screenshot pixels` },
  },
  required: ["x", "y"],
});

/**
 * BotDesktopTools drive the bot's own desktop: a separate Linux desktop that only this bot uses
 * ("Works on: Its own desktop"). Every action returns a fresh screenshot of that desktop. The
 * tool registry offers these tools only to a bot set to work there.
 */
export class BotDesktopTools {
  constructor(
    private daemon: DaemonLike,
    private taskId: string,
  ) {}

  static getToolDefinitions(): LLMTool[] {
    return [
      {
        name: "desktop_screenshot",
        description:
          "Use to see your own desktop (a separate Linux desktop only you use, 1280x800). Returns a screenshot; use its pixel coordinates for clicks.",
        input_schema: { type: "object", properties: {} },
      },
      {
        name: "desktop_open_url",
        description:
          "Use to open a web page in the browser on your own desktop. Sign-ins there are yours alone and are kept between conversations.",
        input_schema: {
          type: "object",
          properties: { url: { type: "string", description: "An http or https address" } },
          required: ["url"],
        },
      },
      {
        name: "desktop_click",
        description: "Use to click at a point on your own desktop, from the latest screenshot.",
        input_schema: {
          type: "object",
          properties: {
            ...point("Where to click:").properties,
            button: { type: "string", enum: ["left", "right", "middle"] },
            double: { type: "boolean", description: "Double-click" },
          },
          required: ["x", "y"],
        },
      },
      {
        name: "desktop_type",
        description:
          "Use to type text into the focused field on your own desktop. Never type passwords or one-time codes; ask the person to take over instead.",
        input_schema: {
          type: "object",
          properties: { text: { type: "string", maxLength: MAX_TYPE_LENGTH } },
          required: ["text"],
        },
      },
      {
        name: "desktop_key",
        description:
          "Use to press keys on your own desktop, e.g. Return, Tab, Escape, ctrl+l, ctrl+a, alt+Left.",
        input_schema: {
          type: "object",
          properties: { keys: { type: "string", description: "One key or chord, e.g. ctrl+l" } },
          required: ["keys"],
        },
      },
      {
        name: "desktop_scroll",
        description: "Use to scroll at a point on your own desktop. Positive amount scrolls down.",
        input_schema: {
          type: "object",
          properties: {
            ...point("Where to scroll:").properties,
            amount: { type: "number", description: "Wheel steps, -20 to 20" },
          },
          required: ["x", "y", "amount"],
        },
      },
      {
        name: "desktop_drag",
        description: "Use to drag with the mouse on your own desktop from one point to another.",
        input_schema: {
          type: "object",
          properties: {
            from_x: { type: "number" },
            from_y: { type: "number" },
            to_x: { type: "number" },
            to_y: { type: "number" },
          },
          required: ["from_x", "from_y", "to_x", "to_y"],
        },
      },
      {
        name: "desktop_run",
        description:
          "Use to run a shell command inside your own desktop (not on the person's computer), e.g. to install a tool or read a downloaded file. Your files are in ~/work.",
        input_schema: {
          type: "object",
          properties: {
            command: { type: "string", maxLength: 2000 },
            timeout_seconds: { type: "number", description: "1 to 300, default 60" },
          },
          required: ["command"],
        },
      },
    ];
  }

  async execute(toolName: string, input: Record<string, unknown> = {}): Promise<unknown> {
    switch (toolName) {
      case "desktop_screenshot":
        return this.act("screenshot", async () => undefined);
      case "desktop_open_url": {
        const url = this.readUrl(input.url);
        return this.act(
          "open_url",
          async (desktop) => {
            await desktop.exec(
              [
                "chromium",
                "--no-sandbox",
                "--no-first-run",
                "--no-default-browser-check",
                "--start-maximized",
                "--user-data-dir=/home/bot/work/.browser",
                url,
              ],
              { detach: true },
            );
          },
          { settleMs: 2500, note: `Opened ${url}` },
        );
      }
      case "desktop_click": {
        const x = this.readCoordinate(input.x);
        const y = this.readCoordinate(input.y);
        const button = input.button === "right" ? "3" : input.button === "middle" ? "2" : "1";
        return this.act("click", (desktop) =>
          desktop
            .exec([
              "xdotool",
              "mousemove",
              "--sync",
              String(x),
              String(y),
              "click",
              ...(input.double === true ? ["--repeat", "2", "--delay", "80"] : []),
              button,
            ])
            .then(() => undefined),
        );
      }
      case "desktop_type": {
        const text = typeof input.text === "string" ? input.text : "";
        if (!text || text.length > MAX_TYPE_LENGTH) {
          throw new Error(`text must be 1 to ${MAX_TYPE_LENGTH} characters`);
        }
        return this.act("type", (desktop) =>
          desktop
            .exec(["xdotool", "type", "--delay", "12", "--", text], { timeoutMs: 120_000 })
            .then(() => undefined),
        );
      }
      case "desktop_key": {
        const keys = typeof input.keys === "string" ? input.keys.trim() : "";
        if (!KEY_PATTERN.test(keys))
          throw new Error("keys must be a key name or chord like ctrl+l");
        return this.act("key", (desktop) =>
          desktop.exec(["xdotool", "key", "--", keys]).then(() => undefined),
        );
      }
      case "desktop_scroll": {
        const x = this.readCoordinate(input.x);
        const y = this.readCoordinate(input.y);
        const amount = Math.max(-20, Math.min(20, Math.round(Number(input.amount) || 0)));
        if (!amount) throw new Error("amount must be a non-zero number of wheel steps");
        return this.act("scroll", (desktop) =>
          desktop
            .exec([
              "xdotool",
              "mousemove",
              "--sync",
              String(x),
              String(y),
              "click",
              "--repeat",
              String(Math.abs(amount)),
              "--delay",
              "40",
              amount > 0 ? "5" : "4",
            ])
            .then(() => undefined),
        );
      }
      case "desktop_drag": {
        const coords = ["from_x", "from_y", "to_x", "to_y"].map((key) =>
          String(this.readCoordinate(input[key])),
        );
        return this.act("drag", (desktop) =>
          desktop
            .exec([
              "xdotool",
              "mousemove",
              "--sync",
              coords[0],
              coords[1],
              "mousedown",
              "1",
              "mousemove",
              "--sync",
              coords[2],
              coords[3],
              "mouseup",
              "1",
            ])
            .then(() => undefined),
        );
      }
      case "desktop_run":
        return this.runCommand(input);
      default:
        throw new Error(`Unknown desktop tool: ${toolName}`);
    }
  }

  private botId(): string {
    const botId = this.daemon.getTask?.(this.taskId)?.assignedAgentRoleId;
    if (!botId) {
      throw new Error("Only a bot set to work on its own desktop can use these tools.");
    }
    return botId;
  }

  private readCoordinate(value: unknown): number {
    const number = Number(value);
    if (!Number.isFinite(number) || number < 0 || number > 10_000) {
      throw new Error("Coordinates must be screenshot pixels from the latest desktop screenshot");
    }
    return Math.round(number);
  }

  private readUrl(value: unknown): string {
    const raw = typeof value === "string" ? value.trim() : "";
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      throw new Error("url must be a full http or https address");
    }
    if (
      (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
      raw.length > MAX_URL_LENGTH
    ) {
      throw new Error("url must be a full http or https address");
    }
    return parsed.href;
  }

  /** Takes the bot's turn on its desktop, does the action, and returns a fresh screenshot. */
  private async act(
    action: string,
    run: (desktop: BotDesktopSession) => Promise<void>,
    options: { settleMs?: number; note?: string } = {},
  ) {
    const view = ComputerViewService.getInstance();
    view.assertNotHeld(this.taskId);
    const botId = this.botId();
    view.noteWorking(this.taskId, "own_desktop");
    return BotDesktopManager.getInstance().withDesktop(
      botId,
      async (desktop) => {
        view.assertNotHeld(this.taskId);
        await run(desktop);
        await new Promise((resolve) => setTimeout(resolve, options.settleMs ?? 400));
        const png = await desktop.screenshot();
        view.publishFrame(this.taskId, "own_desktop", png, "Its own desktop");
        this.daemon.logEvent(this.taskId, "tool_result", {
          tool: `desktop_${action}`,
          success: true,
          surface: "own_desktop",
        });
        const { width, height } = pngSize(png);
        return {
          success: true,
          action,
          captureId: `desk_${Date.now()}_${createHash("sha256").update(png).digest("hex").slice(0, 12)}`,
          imageBase64: png.toString("base64"),
          mediaType: "image/png",
          width,
          height,
          target: { appName: "Bot desktop" },
          ...(options.note ? { note: options.note } : {}),
        };
      },
      { onStarting: () => view.noteWorking(this.taskId, "own_desktop") },
    );
  }

  private async runCommand(input: Record<string, unknown>) {
    const command = typeof input.command === "string" ? input.command.trim() : "";
    if (!command || command.length > 2000) throw new Error("command must be 1 to 2000 characters");
    const seconds = Math.max(1, Math.min(300, Math.round(Number(input.timeout_seconds) || 60)));
    const view = ComputerViewService.getInstance();
    view.assertNotHeld(this.taskId);
    const botId = this.botId();
    view.noteWorking(this.taskId, "own_desktop");
    return BotDesktopManager.getInstance().withDesktop(botId, async (desktop) => {
      try {
        const result = await desktop.exec(["bash", "-lc", `cd ~/work && ${command}`], {
          timeoutMs: seconds * 1000,
        });
        return {
          success: true,
          output: result.stdout.toString("utf8").slice(-MAX_COMMAND_OUTPUT),
          stderr: result.stderr.slice(-MAX_COMMAND_OUTPUT / 4),
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message.slice(-MAX_COMMAND_OUTPUT) : String(error),
        };
      }
    });
  }
}
