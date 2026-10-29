import { COMPUTER_USE_TOOL_NAMES } from "./computer-use-contract";

/**
 * Where a bot works: which computer its tasks may drive.
 * - auto: decided per task (today: this computer or the in-app browser)
 * - this_computer: this Mac's apps and screen, plus the in-app browser
 * - own_desktop: a separate desktop on this computer that only this bot uses (a container)
 * - browser: only the in-app browser
 * - off: no computer at all (files, commands and connectors still work)
 */
export const BOT_WORKS_ON_VALUES = [
  "auto",
  "this_computer",
  "own_desktop",
  "browser",
  "off",
] as const;
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
  {
    value: "own_desktop",
    label: "Its own desktop",
    description:
      "A separate desktop that only this bot uses, with its own browser and files. Needs Docker Desktop or Podman.",
  },
  { value: "browser", label: "Browser", description: "Only the in-app browser." },
  { value: "off", label: "Off", description: "No computer or browser." },
];

const WORKS_ON_SET = new Set<string>(BOT_WORKS_ON_VALUES);

/**
 * What a bot's own desktop may reach on the network.
 * - internet: public internet only, never this computer or the local network (default)
 * - off: no network at all
 */
export const BOT_DESKTOP_NETWORK_VALUES = ["internet", "off"] as const;
export type BotDesktopNetwork = (typeof BOT_DESKTOP_NETWORK_VALUES)[number];

export const BOT_DESKTOP_NETWORK_OPTIONS: ReadonlyArray<{
  value: BotDesktopNetwork;
  label: string;
  description: string;
}> = [
  {
    value: "internet",
    label: "Internet only",
    description:
      "Websites and online services, but not this Mac, apps running on it, or devices on your local network.",
  },
  {
    value: "off",
    label: "No network",
    description: "Nothing online: for work on files only.",
  },
];

const DESKTOP_NETWORK_SET = new Set<string>(BOT_DESKTOP_NETWORK_VALUES);

export function isBotDesktopNetwork(value: unknown): value is BotDesktopNetwork {
  return typeof value === "string" && DESKTOP_NETWORK_SET.has(value);
}

/** A missing or unknown value means internet only. */
export function normalizeBotDesktopNetwork(value: unknown): BotDesktopNetwork {
  return isBotDesktopNetwork(value) ? value : "internet";
}

/** Resource limits of a bot's own desktop container; the bot's details panel states them too. */
export const BOT_DESKTOP_LIMITS = { memoryGb: 4, cpus: 2 } as const;

/** An SSH host alias or user@host from your SSH config: no spaces, no leading dash, no options. */
export const DESKTOP_HOST_PATTERN = /^(?!-)[A-Za-z0-9._@-]{1,100}$/;

export function isValidDesktopHost(host: unknown): host is string {
  return typeof host === "string" && DESKTOP_HOST_PATTERN.test(host);
}

/** A shared desktop's name: lowercase letters, digits and dashes, like research-team. */
export const DESKTOP_GROUP_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function isValidDesktopGroup(group: unknown): group is string {
  return typeof group === "string" && DESKTOP_GROUP_PATTERN.test(group);
}

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
  own_desktop: 1,
  this_computer: 2,
  auto: 2,
};

/** The narrower of two settings, so an inherited limit can never be widened. */
export function narrowestBotWorksOn(
  ...values: Array<BotWorksOn | undefined | null>
): BotWorksOn | undefined {
  if (values.includes("browser") && values.includes("own_desktop")) return "off";
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
  // The user's own terminal tabs in the terminal dock.
  "list_terminal_tabs",
  "read_terminal",
  "application_operation",
  "native_application_create",
  "local_photoshop_create",
  "local_photoshop_edit",
  "local_photoshop_read",
];

const HOST_COMPUTER_TOOL_SET = new Set(HOST_COMPUTER_TOOL_NAMES);

/**
 * host: this computer; browser: the in-app browser; desktop: the bot's own desktop;
 * handoff: asking the person to take over.
 */
export type ComputerToolKind = "host" | "browser" | "desktop" | "handoff";

/** Which computer a tool acts on, or null when it acts on neither. */
export function computerToolKind(
  toolName: string,
  options: { hostDesktopMcp?: boolean } = {},
): ComputerToolKind | null {
  const name = String(toolName || "").trim();
  if (options.hostDesktopMcp || HOST_COMPUTER_TOOL_SET.has(name)) return "host";
  if (name.startsWith("browser_")) return "browser";
  if (name.startsWith("desktop_")) return "desktop";
  if (name === "request_takeover") return "handoff";
  return null;
}

/** Whether a bot's "Works on" setting takes this tool away. */
export function isComputerToolBlocked(
  worksOn: BotWorksOn | undefined,
  kind: ComputerToolKind | null,
): boolean {
  if (!kind) return false;
  // The bot's own desktop exists only for a bot set to work there.
  if (kind === "desktop") return worksOn !== "own_desktop";
  if (!worksOn) return false;
  if (worksOn === "off") return true;
  if (worksOn === "browser") return kind === "host";
  // On its own desktop a bot leaves this computer and the in-app browser alone.
  if (worksOn === "own_desktop") return kind === "host" || kind === "browser";
  return false;
}

/** Whether a tool drives a computer (this one or the browser) or hands it to the person. */
export function isComputerTool(toolName: string): boolean {
  return computerToolKind(toolName) !== null;
}

/** A task the person taught a bot by doing it once on its own desktop (Teach a task). */
export interface TaughtTask {
  id: string;
  name: string;
  createdAt: number;
  durationMs: number;
  eventCount: number;
}

export const TAUGHT_TASK_NAME_MAX_LENGTH = 60;
