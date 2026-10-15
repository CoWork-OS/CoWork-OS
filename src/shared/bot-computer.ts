import { COMPUTER_USE_TOOL_NAMES } from "./computer-use-contract";

/**
 * Where a bot works: which computer its tasks may drive.
 * - auto: decided per task (today: this computer or the in-app browser)
 * - this_computer: this Mac's apps and screen, plus the in-app browser
 * - browser: only the in-app browser
 * - off: no computer at all (files, commands and connectors still work)
 */
export const BOT_WORKS_ON_VALUES = ["auto", "this_computer", "browser", "off"] as const;
export type BotWorksOn = (typeof BOT_WORKS_ON_VALUES)[number];

export const BOT_WORKS_ON_OPTIONS: ReadonlyArray<{
  value: BotWorksOn;
  label: string;
  description: string;
}> = [
  {
    value: "auto",
    label: "Auto",
    description: "Uses this computer or the browser, whichever the task needs.",
  },
  {
    value: "this_computer",
    label: "This computer",
    description: "Can use apps on this Mac and the browser. Actions still ask for approval.",
  },
  { value: "browser", label: "Browser", description: "Only the in-app browser." },
  { value: "off", label: "Off", description: "No computer or browser." },
];

const WORKS_ON_SET = new Set<string>(BOT_WORKS_ON_VALUES);

export function isBotWorksOn(value: unknown): value is BotWorksOn {
  return typeof value === "string" && WORKS_ON_SET.has(value);
}

/** A missing or unknown value means Auto. */
export function normalizeBotWorksOn(value: unknown): BotWorksOn {
  return isBotWorksOn(value) ? value : "auto";
}

/** How much computer a setting allows; a lower rank is narrower. */
const WORKS_ON_RANK: Record<BotWorksOn, number> = {
  off: 0,
  browser: 1,
  this_computer: 2,
  auto: 2,
};

/** The narrower of two settings, so an inherited limit can never be widened. */
export function narrowestBotWorksOn(
  ...values: Array<BotWorksOn | undefined | null>
): BotWorksOn | undefined {
  let result: BotWorksOn | undefined;
  for (const value of values) {
    if (!isBotWorksOn(value)) continue;
    if (!result || WORKS_ON_RANK[value] < WORKS_ON_RANK[result]) result = value;
  }
  return result;
}

/**
 * Tools that act on this computer itself: its screen, apps, clipboard and default browser.
 * Desktop MCP drivers (such as Codex computer use) count too; the tool registry identifies
 * them from local configuration.
 */
export const HOST_COMPUTER_TOOL_NAMES: readonly string[] = [
  ...COMPUTER_USE_TOOL_NAMES,
  "take_screenshot",
  "screen_context_resolve",
  "open_application",
  "open_url",
  "open_path",
  "show_in_folder",
  "run_applescript",
  "read_clipboard",
  "write_clipboard",
  "application_operation",
  "native_application_create",
  "local_photoshop_create",
  "local_photoshop_edit",
  "local_photoshop_read",
];

const HOST_COMPUTER_TOOL_SET = new Set(HOST_COMPUTER_TOOL_NAMES);

/** host: this computer; browser: the in-app browser; handoff: asking the person to take over. */
export type ComputerToolKind = "host" | "browser" | "handoff";

/** Which computer a tool acts on, or null when it acts on neither. */
export function computerToolKind(
  toolName: string,
  options: { hostDesktopMcp?: boolean } = {},
): ComputerToolKind | null {
  const name = String(toolName || "").trim();
  if (options.hostDesktopMcp || HOST_COMPUTER_TOOL_SET.has(name)) return "host";
  if (name.startsWith("browser_")) return "browser";
  if (name === "request_takeover") return "handoff";
  return null;
}

/** Whether a bot's "Works on" setting takes this tool away. */
export function isComputerToolBlocked(
  worksOn: BotWorksOn | undefined,
  kind: ComputerToolKind | null,
): boolean {
  if (!kind || !worksOn) return false;
  if (worksOn === "off") return true;
  if (worksOn === "browser") return kind === "host";
  return false;
}

/** Whether a tool drives a computer (this one or the browser) or hands it to the person. */
export function isComputerTool(toolName: string): boolean {
  return computerToolKind(toolName) !== null;
}
