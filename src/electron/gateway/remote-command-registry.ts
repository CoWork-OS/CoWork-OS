export type RemoteCommandActiveTaskPolicy =
  | "dispatch"
  | "cancelTask"
  | "unlinkTask"
  | "rejectWhileActive"
  | "taskFollowup";

export interface RemoteCommandDefinition {
  name: string;
  aliases?: string[];
  description: string;
  activeTaskPolicy: RemoteCommandActiveTaskPolicy;
  category?: string;
  argsHint?: string;
  naturalShortcuts?: string[];
  hidden?: boolean;
}

export interface NativeRemoteCommandDefinition {
  name: string;
  canonicalName: string;
  description: string;
  argsHint?: string;
  activeTaskPolicy: RemoteCommandActiveTaskPolicy;
  category?: string;
}

export const CORE_NATIVE_REMOTE_COMMAND_NAMES = [
  "help",
  "commands",
  "status",
  "workspaces",
  "workspace",
  "new",
  "newtask",
  "stop",
  "cancel",
  "pause",
  "resume",
  "queue",
  "steer",
  "background",
  "skills",
  "skill",
  "schedule",
  "brief",
  "approve",
  "deny",
  "models",
  "providers",
  "agent",
] as const;

export const REMOTE_COMMAND_DEFINITIONS: RemoteCommandDefinition[] = [
  {
    name: "start",
    description: "Start or initialize the channel session.",
    activeTaskPolicy: "dispatch",
    category: "Basics",
  },
  {
    name: "help",
    description: "Show channel help.",
    activeTaskPolicy: "dispatch",
    category: "Basics",
    naturalShortcuts: ["help", "commands", "menu"],
  },
  {
    name: "commands",
    aliases: ["menu"],
    description: "Browse commands by page or category.",
    activeTaskPolicy: "dispatch",
    category: "Basics",
    argsHint: "[page|category]",
  },
  {
    name: "status",
    description: "Show status for the current session or task.",
    activeTaskPolicy: "dispatch",
    category: "Basics",
    naturalShortcuts: ["status", "task status"],
  },
  {
    name: "brief",
    description: "Create a brief from channel context.",
    activeTaskPolicy: "dispatch",
    category: "Work",
    argsHint: "[morning|today|tomorrow|week|schedule|list|unschedule]",
  },
  {
    name: "inbox",
    description: "Summarize recent channel messages.",
    activeTaskPolicy: "dispatch",
    category: "Work",
    argsHint: "[limit|triage|autopilot|followups]",
  },
  {
    name: "simplify",
    description: "Run the simplify skill slash command.",
    activeTaskPolicy: "dispatch",
    category: "Skills",
    argsHint: "[objective]",
  },
  {
    name: "batch",
    description: "Run the batch skill slash command.",
    activeTaskPolicy: "dispatch",
    category: "Skills",
    argsHint: "<objective>",
  },
  {
    name: "llm-wiki",
    description: "Run the LLM wiki skill slash command.",
    activeTaskPolicy: "dispatch",
    category: "Skills",
    argsHint: "<objective>",
  },
  {
    name: "schedule",
    description: "Create or manage scheduled tasks.",
    activeTaskPolicy: "dispatch",
    category: "Work",
    argsHint: "<schedule> <prompt>",
  },
  {
    name: "digest",
    description: "Summarize recent channel transcript.",
    activeTaskPolicy: "dispatch",
    category: "Work",
    argsHint: "[lookback|count]",
  },
  {
    name: "followups",
    aliases: ["commitments"],
    description: "Summarize commitments and follow-ups.",
    activeTaskPolicy: "dispatch",
    category: "Work",
    argsHint: "[lookback|count]",
  },
  {
    name: "workspaces",
    description: "List workspaces.",
    activeTaskPolicy: "dispatch",
    category: "Workspace",
  },
  {
    name: "workspace",
    description: "Select or inspect the current workspace.",
    activeTaskPolicy: "dispatch",
    category: "Workspace",
    argsHint: "[name|number]",
  },
  {
    name: "cancel",
    aliases: ["stop"],
    description: "Cancel the currently linked task.",
    activeTaskPolicy: "cancelTask",
    category: "Task Control",
    naturalShortcuts: ["stop", "cancel"],
  },
  {
    name: "pause",
    aliases: ["interrupt"],
    description: "Pause the current task.",
    activeTaskPolicy: "dispatch",
    category: "Task Control",
  },
  {
    name: "resume",
    aliases: ["continue"],
    description: "Resume the current task.",
    activeTaskPolicy: "dispatch",
    category: "Task Control",
  },
  {
    name: "newtask",
    aliases: ["new", "reset"],
    description: "Unlink this chat from the current task.",
    activeTaskPolicy: "unlinkTask",
    category: "Task Control",
    argsHint: "[temp]",
    naturalShortcuts: ["new", "new task", "start over"],
  },
  {
    name: "background",
    aliases: ["bg", "btw"],
    description: "Start a separate background task without changing this chat session.",
    activeTaskPolicy: "dispatch",
    category: "Task Control",
    argsHint: "<prompt>",
  },
  {
    name: "steer",
    description: "Send steering guidance to the active task.",
    activeTaskPolicy: "taskFollowup",
    category: "Task Control",
    argsHint: "<message>",
  },
  {
    name: "fork",
    aliases: ["forksession", "branch"],
    description: "Fork the current task session.",
    activeTaskPolicy: "dispatch",
    category: "Task Control",
  },
  {
    name: "task",
    description: "Show current task details.",
    activeTaskPolicy: "dispatch",
    category: "Task Control",
  },
  {
    name: "addworkspace",
    description: "Add a workspace.",
    activeTaskPolicy: "dispatch",
    category: "Workspace",
    argsHint: "<path>",
  },
  {
    name: "models",
    description: "List available models.",
    activeTaskPolicy: "dispatch",
    category: "Settings",
  },
  {
    name: "model",
    description: "Select a model.",
    activeTaskPolicy: "dispatch",
    category: "Settings",
    argsHint: "<name>",
  },
  {
    name: "provider",
    description: "Select an LLM provider.",
    activeTaskPolicy: "dispatch",
    category: "Settings",
    argsHint: "<name>",
  },
  {
    name: "pair",
    description: "Pair an authorized user.",
    activeTaskPolicy: "dispatch",
    category: "Settings",
    argsHint: "<code>",
  },
  {
    name: "shell",
    description: "Manage shell permissions.",
    activeTaskPolicy: "dispatch",
    category: "Settings",
    argsHint: "on|off",
  },
  {
    name: "approve",
    aliases: ["yes", "y"],
    description: "Approve a pending request.",
    activeTaskPolicy: "dispatch",
    category: "Approvals",
    argsHint: "[id]",
  },
  {
    name: "deny",
    aliases: ["no", "n"],
    description: "Deny a pending request.",
    activeTaskPolicy: "dispatch",
    category: "Approvals",
    argsHint: "[id]",
  },
  {
    name: "feedback",
    description: "Give feedback on current task output.",
    activeTaskPolicy: "dispatch",
    category: "Task Control",
    argsHint: "approve|reject|edit|next",
  },
  {
    name: "queue",
    aliases: ["q"],
    description: "Show or clear the CoWork queue.",
    activeTaskPolicy: "dispatch",
    category: "Task Control",
    argsHint: "[clear|prompt]",
  },
  {
    name: "removeworkspace",
    description: "Remove a workspace.",
    activeTaskPolicy: "dispatch",
    category: "Workspace",
    argsHint: "<name>",
  },
  {
    name: "retry",
    description: "Retry the last task.",
    activeTaskPolicy: "dispatch",
    category: "Task Control",
  },
  {
    name: "history",
    description: "Show channel history.",
    activeTaskPolicy: "dispatch",
    category: "Task Control",
  },
  {
    name: "skills",
    description: "List enabled skills.",
    activeTaskPolicy: "dispatch",
    category: "Skills",
  },
  {
    name: "skill",
    description: "Toggle or inspect a skill.",
    activeTaskPolicy: "dispatch",
    category: "Skills",
    argsHint: "<id>",
  },
  {
    name: "providers",
    description: "List LLM providers.",
    activeTaskPolicy: "dispatch",
    category: "Settings",
  },
  {
    name: "settings",
    description: "Show channel settings.",
    activeTaskPolicy: "dispatch",
    category: "Settings",
  },
  {
    name: "activation",
    description: "Manage channel activation.",
    activeTaskPolicy: "dispatch",
    category: "WhatsApp",
    argsHint: "all|mention|commands",
  },
  {
    name: "memorytrust",
    description: "Manage trusted memory behavior.",
    activeTaskPolicy: "dispatch",
    category: "Settings",
  },
  {
    name: "selfchat",
    description: "Manage WhatsApp self-chat mode.",
    activeTaskPolicy: "dispatch",
    category: "WhatsApp",
    argsHint: "on|off",
  },
  {
    name: "ambient",
    description: "Manage ambient ingest mode.",
    activeTaskPolicy: "dispatch",
    category: "WhatsApp",
    argsHint: "on|off",
  },
  {
    name: "ingest",
    description: "Manage ingest-only behavior.",
    activeTaskPolicy: "dispatch",
    category: "WhatsApp",
    argsHint: "on|off",
  },
  {
    name: "prefix",
    description: "Manage response prefixing.",
    activeTaskPolicy: "dispatch",
    category: "WhatsApp",
    argsHint: "<text|off>",
  },
  {
    name: "numbers",
    description: "List allowed numbers.",
    activeTaskPolicy: "dispatch",
    category: "WhatsApp",
  },
  {
    name: "allow",
    description: "Allow a number.",
    activeTaskPolicy: "dispatch",
    category: "WhatsApp",
    argsHint: "<number>",
  },
  {
    name: "disallow",
    description: "Disallow a number.",
    activeTaskPolicy: "dispatch",
    category: "WhatsApp",
    argsHint: "<number>",
  },
  {
    name: "debug",
    description: "Show channel debug info.",
    activeTaskPolicy: "dispatch",
    category: "Settings",
  },
  {
    name: "version",
    description: "Show app version.",
    activeTaskPolicy: "dispatch",
    category: "Basics",
  },
  {
    name: "agent",
    aliases: ["agents"],
    description: "Select or inspect agent role.",
    activeTaskPolicy: "dispatch",
    category: "Agents",
    argsHint: "[name|id|clear]",
  },
];

const COMMANDS_BY_NAME = new Map<string, RemoteCommandDefinition>();

for (const command of REMOTE_COMMAND_DEFINITIONS) {
  COMMANDS_BY_NAME.set(command.name, command);
  for (const alias of command.aliases || []) {
    COMMANDS_BY_NAME.set(alias, command);
  }
}

export function normalizeRemoteCommandName(command: string): string {
  return String(command || "")
    .trim()
    .replace(/^\//, "")
    .split("@", 1)[0]
    .toLowerCase();
}

export function resolveRemoteCommand(command: string): RemoteCommandDefinition | undefined {
  const name = normalizeRemoteCommandName(command);
  if (!name) return undefined;
  return COMMANDS_BY_NAME.get(name);
}

export function getCanonicalRemoteCommand(command: string): string | undefined {
  const definition = resolveRemoteCommand(command);
  return definition ? `/${definition.name}` : undefined;
}

export function listRemoteCommands(): RemoteCommandDefinition[] {
  return REMOTE_COMMAND_DEFINITIONS.filter((command) => !command.hidden);
}

export function listRemoteCommandCategories(): string[] {
  const categories = new Set<string>();
  for (const command of listRemoteCommands()) {
    categories.add(command.category || "Other");
  }
  return Array.from(categories).sort((a, b) => a.localeCompare(b));
}

export function listNativeRemoteCommands(
  names: readonly string[] = CORE_NATIVE_REMOTE_COMMAND_NAMES,
): NativeRemoteCommandDefinition[] {
  const seen = new Set<string>();
  const commands: NativeRemoteCommandDefinition[] = [];

  for (const rawName of names) {
    const name = normalizeRemoteCommandName(rawName);
    if (!name || seen.has(name)) continue;

    const definition = resolveRemoteCommand(name);
    if (!definition || definition.hidden) continue;

    seen.add(name);
    commands.push({
      name,
      canonicalName: definition.name,
      description: definition.description,
      argsHint: definition.argsHint,
      activeTaskPolicy: definition.activeTaskPolicy,
      category: definition.category,
    });
  }

  return commands;
}
