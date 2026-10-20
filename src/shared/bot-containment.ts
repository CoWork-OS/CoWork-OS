/**
 * Which files a bot may work on when nobody started the run by hand.
 * - own_folder: its own folder under the app's data, plus folders you share with it (default)
 * - workspace: whichever workspace the run was given, as before containment
 *
 * A run you start yourself (a bot chat, or a task you type and assign while in a project) always
 * works in the workspace you picked: picking it is the consent.
 */
export const BOT_FILE_ACCESS_VALUES = ["own_folder", "workspace"] as const;
export type BotFileAccess = (typeof BOT_FILE_ACCESS_VALUES)[number];

export const BOT_FILE_ACCESS_OPTIONS: ReadonlyArray<{
  value: BotFileAccess;
  label: string;
  description: string;
}> = [
  {
    value: "own_folder",
    label: "Its own folder",
    description:
      "Runs nobody started by hand (heartbeat, Slack and other channels, schedules) work in a folder only this bot uses. Chats you start still use your project.",
  },
  {
    value: "workspace",
    label: "Your workspace",
    description:
      "Every run works in the workspace it was given, including runs nobody started by hand.",
  },
];

const FILE_ACCESS_SET = new Set<string>(BOT_FILE_ACCESS_VALUES);

export function isBotFileAccess(value: unknown): value is BotFileAccess {
  return typeof value === "string" && FILE_ACCESS_SET.has(value);
}

/** A missing or unknown value means its own folder: bots are contained by default. */
export function normalizeBotFileAccess(value: unknown): BotFileAccess {
  return isBotFileAccess(value) ? value : "own_folder";
}

/** Workspace rows for bots' own folders; hidden from workspace lists like temp workspaces. */
export const BOT_WORKSPACE_ID_PREFIX = "__bot_workspace__:";

export function botWorkspaceId(roleId: string): string {
  return `${BOT_WORKSPACE_ID_PREFIX}${roleId}`;
}

export function isBotWorkspaceId(id: string | null | undefined): boolean {
  return typeof id === "string" && id.startsWith(BOT_WORKSPACE_ID_PREFIX);
}

/**
 * The access limit every task in a bot's own folder works under. It caps only the sandbox:
 * Full access becomes workspace-write, so shell commands and code always run sandboxed, while
 * approvals, network and the reviewer stay as the task's own profile has them. Resolved by
 * id like a built-in profile, but never offered in profile pickers.
 */
export const BOT_CONTAINED_ACCESS_CEILING = {
  id: "__bot_contained__",
  label: "Bot's own folder",
  description: "Sandboxed: shell commands and code never run with full access.",
  sandbox: "workspace-write",
  approval: "on-request",
  reviewer: "none",
  network: "enabled",
} as const;

/**
 * Host tools a run in a bot's own folder never gets, whatever its "Works on" setting: they read
 * the app's environment (API keys, tokens) or act on this Mac's processes and login items.
 */
export const BOT_CONTAINED_DENIED_TOOL_NAMES: ReadonlySet<string> = new Set([
  "get_env",
  "find_macos_app_processes",
  "terminate_macos_app_processes",
  "list_macos_launch_agents",
  "disable_macos_launch_agents",
  "native_application_inspect",
]);

/** The task fields the containment decision reads, for the task and each of its ancestors. */
export interface BotContainmentTaskFacts {
  assignedAgentRoleId?: string;
  promptProvenance?: string;
  agentConfig?: {
    botConversation?: boolean;
    gatewayContext?: unknown;
    originChannel?: unknown;
  };
}

/**
 * Whether a bot's run must move into the bot's own folder: the task is assigned to a bot set to
 * "Its own folder", it is not a bot chat (chats and team peers live in the project the person
 * opened them in), and no task in its chain was typed by the person in the app. A message from
 * the owner through Slack or another channel does not count: nobody picked a project for it.
 *
 * `chain` is the task followed by its ancestors, nearest first.
 */
export function shouldContainBotRun(
  chain: readonly BotContainmentTaskFacts[],
  fileAccess: BotFileAccess,
): boolean {
  const [task] = chain;
  if (!task?.assignedAgentRoleId || fileAccess !== "own_folder") return false;
  if (task.agentConfig?.botConversation === true) return false;
  const typedInApp = chain.some(
    (entry) =>
      entry.promptProvenance === "user_typed" &&
      entry.agentConfig?.gatewayContext === undefined &&
      entry.agentConfig?.originChannel === undefined,
  );
  return !typedInApp;
}
