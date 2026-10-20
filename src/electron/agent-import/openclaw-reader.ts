/**
 * Read an OpenClaw home (`~/.openclaw`, or the older `~/.clawdbot` / `~/.moltbot`) into an
 * import plan. Reads only.
 *
 * Paths follow OpenClaw's documented layout: openclaw.json (JSON5) at the root, the agent
 * workspace in workspace/ (or workspace-main/, workspace-assistant/, workspace.default/,
 * or agents.defaults.workspace) holding SOUL.md, AGENTS.md, MEMORY.md, USER.md, memory/
 * daily notes and skills/, plus exec-approvals.json, credentials/ allowlists and the
 * legacy cron/jobs.json. Anything else is skipped with a reason.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import JSON5 from "json5";
import {
  IMPORT_PROVIDER_LABELS,
  modelProviderLabel,
  readyItem,
  secretItem,
  skippedItem,
  splitIdList,
  type ImportChannelType,
  type ImportModelProviderId,
  type ImportPlan,
  type ImportProviderId,
  type ImportSchedule,
  type PlannedImportItem,
} from "./plan";
import type { ReadSourceOptions } from "./hermes-reader";
import {
  PROVIDER_KEY_ENV,
  commandPrefixFromAllowlistPattern,
  findSkillBundles,
  isDirectory,
  isFile,
  localModelEndpoint,
  parseEnvText,
  providerFromName,
  readTextIfExists,
  shortDescription,
  splitMarkdownEntries,
} from "./source-files";

const CONFIG_FILE_NAMES = ["openclaw.json", "clawdbot.json", "moltbot.json"];
const WORKSPACE_DIR_NAMES = [
  "workspace",
  "workspace-main",
  "workspace-assistant",
  "workspace.default",
];
/** Above this many notes MEMORY.md goes to the inbox for review instead of straight in. */
const MAX_DIRECT_MEMORY_NOTES = 50;
const MAX_DAILY_NOTES = 300;
/** CoWork's limit for workspace instructions (.cowork/AGENTS.md). */
export const MAX_WORKSPACE_INSTRUCTIONS_CHARS = 12_000;

const CHANNEL_LABELS: Record<ImportChannelType, string> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
};

const OTHER_CHANNEL_LABELS: Record<string, string> = {
  whatsapp: "WhatsApp",
  signal: "Signal",
  matrix: "Matrix",
  mattermost: "Mattermost",
  msteams: "Microsoft Teams",
  irc: "IRC",
  googlechat: "Google Chat",
  bluebubbles: "BlueBubbles",
  imessage: "iMessage",
  nostr: "Nostr",
  twitch: "Twitch",
};

export interface OpenClawHomeOptions {
  homedir?: string;
}

/** The first of ~/.openclaw, ~/.clawdbot, ~/.moltbot that exists (else ~/.openclaw). */
export function resolveOpenClawHome(options: OpenClawHomeOptions = {}): string {
  const homedir = options.homedir ?? os.homedir();
  for (const name of [".openclaw", ".clawdbot", ".moltbot"]) {
    const candidate = path.join(homedir, name);
    if (isDirectory(candidate)) return candidate;
  }
  return path.join(homedir, ".openclaw");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function expandHome(value: string, homedir: string): string {
  return value === "~" || value.startsWith("~/") || value.startsWith("~\\")
    ? path.join(homedir, value.slice(1))
    : value;
}

function readJsonFile(filePath: string): unknown {
  const raw = readTextIfExists(filePath);
  if (raw === null) return undefined;
  try {
    return JSON5.parse(raw);
  } catch {
    return undefined;
  }
}

function readConfig(home: string): {
  config: Record<string, unknown>;
  file?: string;
  error?: string;
} {
  for (const name of CONFIG_FILE_NAMES) {
    const file = path.join(home, name);
    if (!isFile(file)) continue;
    const raw = readTextIfExists(file);
    if (raw === null) return { config: {}, file, error: `${name} could not be read.` };
    try {
      return { config: asRecord(JSON5.parse(raw)), file };
    } catch {
      return { config: {}, file, error: `${name} could not be parsed.` };
    }
  }
  return { config: {} };
}

export function resolveOpenClawWorkspace(
  home: string,
  config: Record<string, unknown>,
  homedir = os.homedir(),
): string | null {
  for (const name of WORKSPACE_DIR_NAMES) {
    const dir = path.join(home, name);
    if (isDirectory(dir)) return dir;
  }
  const custom = asString(asRecord(asRecord(config.agents).defaults).workspace);
  if (custom) {
    const dir = path.resolve(expandHome(custom, homedir));
    if (isDirectory(dir)) return dir;
  }
  return null;
}

export function openClawHomeExists(home: string): boolean {
  return (
    isDirectory(home) &&
    (CONFIG_FILE_NAMES.some((name) => isFile(path.join(home, name))) ||
      WORKSPACE_DIR_NAMES.some((name) => isDirectory(path.join(home, name))))
  );
}

/**
 * A secret value from the config: a plain string, a `${VAR}` template or an `env`
 * SecretRef resolve against the env sources; `file` and `exec` refs are not followed.
 */
function resolveSecretValue(
  value: unknown,
  env: Map<string, string>,
): { value?: string; unresolved?: string } {
  if (typeof value === "string") {
    const template = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value.trim());
    if (template) {
      const resolved = env.get(template[1]);
      return resolved ? { value: resolved } : { unresolved: `${template[1]} is not set.` };
    }
    return value.trim() ? { value: value.trim() } : {};
  }
  const ref = asRecord(value);
  const source = asString(ref.source);
  if (source === "env") {
    const resolved = env.get(asString(ref.id));
    return resolved ? { value: resolved } : { unresolved: `${asString(ref.id)} is not set.` };
  }
  if (source === "file" || source === "exec") {
    return { unresolved: `Stored as a ${source} reference, which CoWork does not follow.` };
  }
  return {};
}

function collectEnv(home: string, config: Record<string, unknown>): Map<string, string> {
  // Values are needed to resolve `${VAR}` references; the caller only keeps them when
  // secrets are opted in.
  const env = parseEnvText(readTextIfExists(path.join(home, ".env")) || "", true);
  const section = asRecord(config.env);
  for (const [key, value] of [
    ...Object.entries(section),
    ...Object.entries(asRecord(section.vars)),
  ]) {
    if (typeof value === "string" && value.trim() && !env.has(key)) env.set(key, value.trim());
  }
  return env;
}

function channelField(config: Record<string, unknown>, channel: string, field: string): unknown {
  const section = asRecord(asRecord(config.channels)[channel]);
  return section[field] ?? asRecord(asRecord(section.accounts).default)[field];
}

function telegramAllowFrom(home: string, config: Record<string, unknown>): string[] {
  const fromConfig = splitIdList(channelField(config, "telegram", "allowFrom") ?? []);
  if (fromConfig.length > 0) return fromConfig;
  for (const name of ["telegram-default-allowFrom.json", "telegram-allowFrom.json"]) {
    const parsed = readJsonFile(path.join(home, "credentials", name));
    const list = Array.isArray(parsed) ? parsed : asRecord(parsed).allowFrom;
    const ids = splitIdList(list ?? []);
    if (ids.length > 0) return ids;
  }
  return [];
}

function mapOpenClawSchedule(
  schedule: Record<string, unknown>,
  nowMs: number,
): ImportSchedule | { reason: string } {
  const kind = asString(schedule.kind);
  if (kind === "cron") {
    const expr = asString(schedule.expr) || asString(schedule.cron);
    if (expr.split(/\s+/).length !== 5) return { reason: "Not a five-field cron expression." };
    const tz = asString(schedule.tz);
    return { kind: "cron", expr, ...(tz ? { tz } : {}) };
  }
  if (kind === "every") {
    const everyMs = Number(schedule.everyMs);
    if (!Number.isFinite(everyMs) || everyMs < 60_000) {
      return { reason: "Repeats more often than once a minute." };
    }
    return { kind: "every", everyMs: Math.round(everyMs) };
  }
  if (kind === "at") {
    const atMs = Number.isFinite(Number(schedule.atMs))
      ? Number(schedule.atMs)
      : Date.parse(asString(schedule.at));
    if (!Number.isFinite(atMs)) return { reason: "One-time run has no valid time." };
    if (atMs <= nowMs) return { reason: "One-time run is already in the past." };
    return { kind: "at", atMs };
  }
  return { reason: `Schedule kind "${kind || "none"}" has no CoWork equivalent.` };
}

function readOpenClawCron(home: string, nowMs: number): PlannedImportItem[] {
  const file = path.join(home, "cron", "jobs.json");
  if (!isFile(file)) {
    return isFile(path.join(home, "state", "openclaw.sqlite"))
      ? [
          skippedItem(
            "cron:state",
            "scheduled_task",
            "Scheduled jobs",
            "This OpenClaw keeps jobs in its state database, which CoWork does not read. Recreate them in Scheduled tasks.",
          ),
        ]
      : [];
  }
  const parsed = readJsonFile(file);
  const jobs = Array.isArray(parsed) ? parsed : asRecord(parsed).jobs;
  if (!Array.isArray(jobs)) {
    return [
      skippedItem(
        "cron:file",
        "scheduled_task",
        "Scheduled jobs",
        "cron/jobs.json could not be read.",
      ),
    ];
  }
  return jobs.map((value, index) => {
    const job = asRecord(value);
    const payload = asRecord(job.payload);
    const prompt = asString(payload.message) || asString(job.message);
    const name = asString(job.name) || shortDescription(prompt, 48) || `Job ${index + 1}`;
    const id = `cron:${asString(job.id) || asString(job.jobId) || index}`;
    const payloadKind = asString(payload.kind) || (prompt ? "agentTurn" : "");
    if (payloadKind !== "agentTurn" || !prompt) {
      return skippedItem(
        id,
        "scheduled_task",
        name,
        "Only jobs that send the agent a message carry over.",
      );
    }
    const schedule = mapOpenClawSchedule(asRecord(job.schedule), nowMs);
    if ("reason" in schedule) return skippedItem(id, "scheduled_task", name, schedule.reason);
    return readyItem(
      id,
      "scheduled_task",
      name,
      { kind: "scheduled_task", name, prompt, schedule },
      { detail: `${schedule.kind}, paused after import` },
    );
  });
}

function modelFromConfig(config: Record<string, unknown>): string {
  const defaults = asRecord(asRecord(config.agents).defaults);
  const raw = defaults.model;
  const value = typeof raw === "string" ? raw.trim() : asString(asRecord(raw).primary);
  if (!value || value.includes("/")) return value;
  // A display alias: find the catalog entry that carries it.
  for (const [key, entry] of Object.entries(asRecord(defaults.models))) {
    const alias = typeof entry === "string" ? entry : asString(asRecord(entry).alias);
    if (alias === value) return key;
  }
  return value;
}

export function readOpenClawHome(
  home: string,
  options: ReadSourceOptions & { homedir?: string },
): ImportPlan {
  const plan: ImportPlan = {
    source: "openclaw",
    home,
    found: openClawHomeExists(home),
    withSecrets: options.withSecrets,
    items: [],
  };
  if (!plan.found) return plan;
  const items = plan.items;
  const nowMs = options.nowMs ?? Date.now();
  const { config, error: configError } = readConfig(home);
  if (configError) items.push(skippedItem("config", "model", "Settings", configError));
  const workspace = resolveOpenClawWorkspace(home, config, options.homedir);
  const workspaceFile = (name: string) =>
    workspace ? readTextIfExists(path.join(workspace, name)) : null;

  // Persona
  const soul = workspaceFile("SOUL.md");
  if (soul !== null) {
    const text = soul.replace(/<!--[\s\S]*?-->/g, "").trim();
    items.push(
      text
        ? readyItem(
            "persona",
            "persona",
            "Persona (SOUL.md)",
            { kind: "persona", text },
            {
              detail: shortDescription(text),
            },
          )
        : skippedItem("persona", "persona", "Persona (SOUL.md)", "SOUL.md is empty."),
    );
  }

  // Workspace instructions
  const agents = workspaceFile("AGENTS.md");
  if (agents !== null && agents.trim()) {
    const text = agents.trim();
    items.push(
      text.length > MAX_WORKSPACE_INSTRUCTIONS_CHARS
        ? skippedItem(
            "instructions",
            "workspace_instructions",
            "Workspace instructions (AGENTS.md)",
            `${text.length} characters; CoWork's limit is ${MAX_WORKSPACE_INSTRUCTIONS_CHARS}. Copy the parts you need.`,
          )
        : readyItem(
            "instructions",
            "workspace_instructions",
            "Workspace instructions (AGENTS.md)",
            { kind: "workspace_instructions", text },
            { detail: ".cowork/AGENTS.md in the chosen workspace" },
          ),
    );
  }

  // Memory
  const userEntries = splitMarkdownEntries(workspaceFile("USER.md") || "").filter(
    // Template fields left blank ("- **Name:**") are not facts.
    (entry) => !/:\s*\**\s*$/.test(entry),
  );
  if (userEntries.length > 0) {
    items.push(
      readyItem(
        "memory:user",
        "user_profile",
        "About you (USER.md)",
        { kind: "memory_entries", target: "user", entries: userEntries },
        { detail: `${userEntries.length} ${userEntries.length === 1 ? "fact" : "facts"} to me.md` },
      ),
    );
  }
  const agentEntries = splitMarkdownEntries(workspaceFile("MEMORY.md") || "");
  if (agentEntries.length > 0) {
    items.push(
      agentEntries.length <= MAX_DIRECT_MEMORY_NOTES
        ? readyItem(
            "memory:agent",
            "memory",
            "Agent notes (MEMORY.md)",
            { kind: "memory_entries", target: "agent", entries: agentEntries },
            { detail: `${agentEntries.length} notes` },
          )
        : readyItem(
            "memory:agent",
            "memory",
            "Agent notes (MEMORY.md)",
            {
              kind: "memory_inbox",
              label: "OpenClaw MEMORY.md",
              entries: agentEntries.map((text) => ({ text })),
            },
            { detail: `${agentEntries.length} notes to review in the memory inbox` },
          ),
    );
  }
  if (workspace && isDirectory(path.join(workspace, "memory"))) {
    const daily: Array<{ text: string; added?: string }> = [];
    const dir = path.join(workspace, "memory");
    let names: string[] = [];
    try {
      names = fs
        .readdirSync(dir)
        .filter((name) => name.toLowerCase().endsWith(".md"))
        .sort();
    } catch {
      names = [];
    }
    for (const name of names) {
      const added = /^(\d{4}-\d{2}-\d{2})/.exec(name)?.[1];
      for (const text of splitMarkdownEntries(readTextIfExists(path.join(dir, name)) || "")) {
        if (daily.length >= MAX_DAILY_NOTES) break;
        daily.push({ text, ...(added ? { added } : {}) });
      }
    }
    if (daily.length > 0) {
      items.push(
        readyItem(
          "memory:daily",
          "memory",
          "Daily notes (memory/)",
          { kind: "memory_inbox", label: "OpenClaw daily notes", entries: daily },
          { detail: `${daily.length} notes to review in the memory inbox` },
        ),
      );
    }
  }

  // Skills
  const skillRoots = [
    ...(workspace
      ? [path.join(workspace, "skills"), path.join(workspace, ".agents", "skills")]
      : []),
    path.join(home, "skills"),
  ];
  const seen = new Set<string>();
  for (const root of skillRoots) {
    for (const skill of findSkillBundles(root)) {
      const key = skill.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(
        readyItem(
          `skill:${key}`,
          "skill",
          `Skill: ${skill.name}`,
          { kind: "skill", bundleDir: skill.dir, name: skill.name },
          { detail: shortDescription(skill.description) },
        ),
      );
    }
  }

  // Provider keys: config providers, then env sources, then auth profiles.
  const env = collectEnv(home, config);
  const keys = new Map<ImportProviderId, { value?: string; unresolved?: string; from: string }>();
  const unmapped: string[] = [];
  for (const [name, entryValue] of Object.entries(asRecord(asRecord(config.models).providers))) {
    const entry = asRecord(entryValue);
    if (entry.apiKey === undefined) continue;
    // A local model server takes no CoWork key; its placeholder key stays behind.
    if (localModelEndpoint(name, asString(entry.baseUrl), asString(entry.api))) continue;
    const provider =
      asString(entry.api) === "anthropic-messages"
        ? "anthropic"
        : providerFromName(name, asString(entry.baseUrl));
    if (!provider) {
      unmapped.push(name);
      continue;
    }
    if (!keys.has(provider))
      keys.set(provider, {
        ...resolveSecretValue(entry.apiKey, env),
        from: `models.providers.${name}`,
      });
  }
  for (const { env: envName, provider } of PROVIDER_KEY_ENV) {
    const value = env.get(envName);
    if (value && !keys.has(provider)) keys.set(provider, { value, from: envName });
  }
  const authProfiles = asRecord(
    readJsonFile(path.join(home, "agents", "main", "agent", "auth-profiles.json")),
  );
  const profiles = asRecord(authProfiles.profiles ?? authProfiles);
  for (const [name, profileValue] of Object.entries(profiles)) {
    const profile = asRecord(profileValue);
    const provider = providerFromName(name);
    const value = resolveSecretValue(profile.key ?? profile.apiKey, env);
    if (provider && (value.value || value.unresolved) && !keys.has(provider)) {
      keys.set(provider, { ...value, from: "auth profile" });
    }
  }
  for (const [provider, key] of keys) {
    const label = `${IMPORT_PROVIDER_LABELS[provider]} API key`;
    if (!key.value) {
      items.push(
        skippedItem(`key:${provider}`, "provider_key", label, key.unresolved || "No value.", {
          secret: true,
          detail: key.from,
        }),
      );
      continue;
    }
    const value = key.value;
    items.push(
      secretItem(
        options.withSecrets,
        `key:${provider}`,
        "provider_key",
        label,
        () => ({ kind: "provider_key", provider, value }),
        key.from,
      ),
    );
  }
  for (const name of unmapped) {
    items.push(
      skippedItem(
        `key:${name.toLowerCase()}`,
        "provider_key",
        `${name} provider`,
        "No CoWork equivalent; add it in Settings > Models.",
        {
          secret: true,
        },
      ),
    );
  }

  // Model
  const model = modelFromConfig(config);
  if (model) {
    const [first, ...rest] = model.split("/");
    const providerEntry = asRecord(asRecord(asRecord(config.models).providers)[first]);
    const local =
      rest.length > 0
        ? localModelEndpoint(first, asString(providerEntry.baseUrl), asString(providerEntry.api))
        : null;
    const provider: ImportModelProviderId | null =
      local?.provider ?? (rest.length > 0 ? providerFromName(first) : null);
    items.push(
      provider
        ? readyItem(
            "model",
            "model",
            `Model: ${model}`,
            {
              kind: "model",
              provider,
              model: rest.join("/"),
              ...(local ? { baseUrl: local.baseUrl } : {}),
            },
            {
              detail: local
                ? `${modelProviderLabel(provider)} at ${local.baseUrl}`
                : modelProviderLabel(provider),
            },
          )
        : skippedItem(
            "model",
            "model",
            `Model: ${model}`,
            "No CoWork equivalent; pick a model in Settings.",
          ),
    );
  }

  // Chat channels
  const channelTokens: Record<ImportChannelType, { bot: unknown; app?: unknown }> = {
    telegram: { bot: channelField(config, "telegram", "botToken") },
    discord: { bot: channelField(config, "discord", "token") },
    slack: {
      bot: channelField(config, "slack", "botToken"),
      app: channelField(config, "slack", "appToken"),
    },
  };
  for (const channel of Object.keys(channelTokens) as ImportChannelType[]) {
    const tokens = channelTokens[channel];
    if (tokens.bot === undefined) continue;
    const bot = resolveSecretValue(tokens.bot, env);
    const app = channel === "slack" ? resolveSecretValue(tokens.app, env) : {};
    const allowedUsers =
      channel === "telegram"
        ? telegramAllowFrom(home, config)
        : splitIdList(channelField(config, channel, "allowFrom") ?? []);
    const detail =
      allowedUsers.length > 0
        ? `${allowedUsers.length} allowed ${allowedUsers.length === 1 ? "user" : "users"}`
        : "pairing required";
    const missing = !bot.value
      ? bot.unresolved || "No bot token."
      : channel === "slack" && !app.value
        ? app.unresolved || "No app token."
        : null;
    if (missing) {
      items.push(
        skippedItem(`channel:${channel}`, "channel", CHANNEL_LABELS[channel], missing, {
          secret: true,
          detail,
        }),
      );
      continue;
    }
    const botToken = bot.value as string;
    const appToken = app.value;
    items.push(
      secretItem(
        options.withSecrets,
        `channel:${channel}`,
        "channel",
        CHANNEL_LABELS[channel],
        () => ({
          kind: "channel",
          channel,
          allowedUsers,
          tokens: { botToken, ...(appToken ? { appToken } : {}) },
        }),
        detail,
      ),
    );
  }
  for (const name of Object.keys(asRecord(config.channels))) {
    const label = OTHER_CHANNEL_LABELS[name];
    if (!label) continue;
    items.push(
      skippedItem(
        `channel:${name}`,
        "channel",
        label,
        "Not carried over; connect it in Settings > Channels.",
      ),
    );
  }

  // Command allowlist
  const approvals = asRecord(readJsonFile(path.join(home, "exec-approvals.json")));
  const patterns = new Set<string>();
  for (const agent of Object.values(asRecord(approvals.agents))) {
    const list = asRecord(agent).allowlist;
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const pattern = typeof entry === "string" ? entry : asString(asRecord(entry).pattern);
      if (pattern) patterns.add(pattern);
    }
  }
  const prefixes = new Set<string>();
  for (const pattern of patterns) {
    const mapped = commandPrefixFromAllowlistPattern(pattern);
    const label = `Always allow: ${pattern}`;
    if ("reason" in mapped) {
      items.push(skippedItem(`command:${pattern}`, "command_rule", label, mapped.reason));
      continue;
    }
    if (prefixes.has(mapped.prefix)) continue;
    prefixes.add(mapped.prefix);
    items.push(
      readyItem(
        `command:${pattern}`,
        "command_rule",
        label,
        { kind: "command_rule", prefix: mapped.prefix },
        {
          detail: `commands starting with "${mapped.prefix}"`,
        },
      ),
    );
  }

  items.push(...readOpenClawCron(home, nowMs));
  return plan;
}
