/**
 * Read a Hermes Agent home (`~/.hermes`) into an import plan. Reads only.
 *
 * Paths follow Hermes' documented layout: SOUL.md, memories/MEMORY.md and
 * memories/USER.md (entries separated by a line holding only "§"), skills/<...>/SKILL.md
 * with skills/.bundled_manifest naming the skills Hermes ships, config.yaml, .env and
 * cron/jobs.json. Anything that does not match is skipped with a reason, never guessed.
 */

import * as os from "node:os";
import * as path from "node:path";
import { load as loadYaml, YAML11_SCHEMA } from "js-yaml";
import {
  IMPORT_PROVIDER_LABELS,
  readyItem,
  secretItem,
  skippedItem,
  splitIdList,
  type ImportChannelType,
  type ImportPlan,
  type ImportProviderId,
  type ImportSchedule,
  type PlannedImportItem,
} from "./plan";
import {
  PROVIDER_KEY_ENV,
  findSkillBundles,
  isDirectory,
  isFile,
  isSecretEnvKey,
  parseEnvText,
  providerFromName,
  readTextIfExists,
  secretValue,
  shortDescription,
} from "./source-files";

/** Hermes' memory files separate entries with a line holding only "§". */
const HERMES_ENTRY_DELIMITER = /\n§\n/;

/** Opening of Hermes' current default SOUL.md (seeded on first run). */
const HERMES_DEFAULT_SOUL_PREFIX =
  "You are Hermes Agent, an intelligent AI assistant created by Nous Research.";
const HERMES_DEFAULT_SOUL_SUFFIX =
  "Be targeted and efficient in your exploration and investigations.";

/** The env names Hermes reads for each chat platform CoWork can take over. */
const HERMES_CHANNEL_ENV: Record<
  ImportChannelType,
  { token: string; appToken?: string; allowedUsers: string }
> = {
  telegram: { token: "TELEGRAM_BOT_TOKEN", allowedUsers: "TELEGRAM_ALLOWED_USERS" },
  discord: { token: "DISCORD_BOT_TOKEN", allowedUsers: "DISCORD_ALLOWED_USERS" },
  slack: {
    token: "SLACK_BOT_TOKEN",
    appToken: "SLACK_APP_TOKEN",
    allowedUsers: "SLACK_ALLOWED_USERS",
  },
};

const CHANNEL_LABELS: Record<ImportChannelType, string> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
};

/** Platforms Hermes can serve that this import does not set up (by env prefix). */
const OTHER_PLATFORM_PREFIXES: ReadonlyArray<[string, string]> = [
  ["WHATSAPP_", "WhatsApp"],
  ["SIGNAL_", "Signal"],
  ["MATRIX_", "Matrix"],
  ["MATTERMOST_", "Mattermost"],
  ["EMAIL_", "Email"],
  ["TEAMS_", "Microsoft Teams"],
  ["GOOGLE_CHAT_", "Google Chat"],
  ["IMESSAGE_", "iMessage"],
  ["BLUEBUBBLES_", "BlueBubbles"],
  ["SMS_", "SMS"],
  ["IRC_", "IRC"],
];

export interface HermesHomeOptions {
  env?: NodeJS.ProcessEnv;
  homedir?: string;
  platform?: NodeJS.Platform;
}

/**
 * Where Hermes keeps its home: HERMES_HOME, then %LOCALAPPDATA%\hermes on Windows, then
 * ~/.hermes. A sticky profile (`active_profile`) points at `profiles/<name>`.
 */
export function resolveHermesHome(options: HermesHomeOptions = {}): string {
  const env = options.env ?? process.env;
  const homedir = options.homedir ?? os.homedir();
  const platform = options.platform ?? process.platform;
  let root = "";
  if (env.HERMES_HOME?.trim()) {
    root = env.HERMES_HOME.trim();
  } else if (platform === "win32" && env.LOCALAPPDATA?.trim()) {
    const local = path.join(env.LOCALAPPDATA.trim(), "hermes");
    root = isDirectory(local) ? local : path.join(homedir, ".hermes");
  } else {
    root = path.join(homedir, ".hermes");
  }
  const profile = readTextIfExists(path.join(root, "active_profile"))?.trim();
  if (profile && /^[A-Za-z0-9._-]+$/.test(profile) && profile !== "default") {
    const profileHome = path.join(root, "profiles", profile);
    if (isDirectory(profileHome)) return profileHome;
  }
  return root;
}

export function hermesHomeExists(home: string): boolean {
  return (
    isDirectory(home) &&
    (isFile(path.join(home, "config.yaml")) ||
      isFile(path.join(home, "SOUL.md")) ||
      isDirectory(path.join(home, "memories")) ||
      isDirectory(path.join(home, "skills")))
  );
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function asString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/** The persona text, or null when SOUL.md is empty or still Hermes' default. */
export function hermesPersonaText(raw: string): string | null {
  const text = raw.replace(/<!--[\s\S]*?-->/g, "").trim();
  // Older Hermes seeded a heading plus an explanatory comment; with the comment gone only
  // the heading is left.
  const withoutHeading = text.replace(/^#\s*Hermes Agent Persona\s*$/m, "").trim();
  if (!withoutHeading) return null;
  if (text.startsWith(HERMES_DEFAULT_SOUL_PREFIX) && text.endsWith(HERMES_DEFAULT_SOUL_SUFFIX)) {
    return null;
  }
  return text;
}

export function splitHermesEntries(raw: string): string[] {
  return raw
    .replace(/\r\n/g, "\n")
    .split(HERMES_ENTRY_DELIMITER)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0 && entry !== "§");
}

function readBundledSkillNames(skillsDir: string): Set<string> {
  const raw = readTextIfExists(path.join(skillsDir, ".bundled_manifest")) || "";
  const names = new Set<string>();
  for (const line of raw.split(/\r?\n/)) {
    const name = line.split(":")[0]?.trim();
    if (name) names.add(name.toLowerCase());
  }
  return names;
}

function mapHermesSchedule(
  schedule: Record<string, unknown>,
  tz: string | undefined,
  nowMs: number,
): ImportSchedule | { reason: string } {
  const kind = asString(schedule.kind);
  if (kind === "interval") {
    const minutes = Number(schedule.minutes);
    if (!Number.isFinite(minutes) || minutes <= 0) return { reason: "Interval has no minutes." };
    return { kind: "every", everyMs: Math.max(1, Math.round(minutes)) * 60_000 };
  }
  if (kind === "cron") {
    const expr = asString(schedule.expr);
    if (expr.split(/\s+/).length !== 5) return { reason: "Not a five-field cron expression." };
    return { kind: "cron", expr, ...(tz ? { tz } : {}) };
  }
  if (kind === "once") {
    const atMs = Date.parse(asString(schedule.run_at));
    if (!Number.isFinite(atMs)) return { reason: "One-time run has no valid time." };
    if (atMs <= nowMs) return { reason: "One-time run is already in the past." };
    return { kind: "at", atMs };
  }
  return { reason: `Unknown schedule kind "${kind || "none"}".` };
}

function readHermesCron(home: string, tz: string | undefined, nowMs: number): PlannedImportItem[] {
  const raw = readTextIfExists(path.join(home, "cron", "jobs.json"));
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [
      skippedItem(
        "cron:file",
        "scheduled_task",
        "Scheduled jobs",
        "cron/jobs.json is not valid JSON.",
      ),
    ];
  }
  const jobs = Array.isArray(parsed) ? parsed : asRecord(parsed).jobs;
  if (!Array.isArray(jobs)) return [];
  return jobs.map((value, index) => {
    const job = asRecord(value);
    const prompt = asString(job.prompt);
    const name = asString(job.name) || shortDescription(prompt, 48) || `Job ${index + 1}`;
    const id = `cron:${asString(job.id) || index}`;
    if (job.no_agent === true || (asString(job.script) && !prompt)) {
      return skippedItem(id, "scheduled_task", name, "Runs a script, not a prompt.");
    }
    if (!prompt) return skippedItem(id, "scheduled_task", name, "Has no prompt.");
    const schedule = mapHermesSchedule(asRecord(job.schedule), tz, nowMs);
    if ("reason" in schedule) return skippedItem(id, "scheduled_task", name, schedule.reason);
    const display = asString(asRecord(job.schedule).display);
    return readyItem(
      id,
      "scheduled_task",
      name,
      { kind: "scheduled_task", name, prompt, schedule },
      { detail: `${display || schedule.kind}, paused after import` },
    );
  });
}

export interface ReadSourceOptions {
  withSecrets: boolean;
  nowMs?: number;
}

export function readHermesHome(home: string, options: ReadSourceOptions): ImportPlan {
  const plan: ImportPlan = {
    source: "hermes",
    home,
    found: hermesHomeExists(home),
    withSecrets: options.withSecrets,
    items: [],
  };
  if (!plan.found) return plan;
  const items = plan.items;
  const nowMs = options.nowMs ?? Date.now();

  // Persona
  const soul = readTextIfExists(path.join(home, "SOUL.md"));
  if (soul !== null) {
    const persona = hermesPersonaText(soul);
    items.push(
      persona
        ? readyItem(
            "persona",
            "persona",
            "Persona (SOUL.md)",
            { kind: "persona", text: persona },
            {
              detail: shortDescription(persona),
            },
          )
        : skippedItem("persona", "persona", "Persona (SOUL.md)", "Still Hermes' default persona."),
    );
  }

  // Memory: memories/ is the current layout; the home root held them in older releases.
  const memoryFile = (name: string) =>
    readTextIfExists(path.join(home, "memories", name)) ?? readTextIfExists(path.join(home, name));
  const userEntries = splitHermesEntries(memoryFile("USER.md") || "");
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
  const agentEntries = splitHermesEntries(memoryFile("MEMORY.md") || "");
  if (agentEntries.length > 0) {
    items.push(
      readyItem(
        "memory:agent",
        "memory",
        "Agent notes (MEMORY.md)",
        { kind: "memory_entries", target: "agent", entries: agentEntries },
        { detail: `${agentEntries.length} ${agentEntries.length === 1 ? "note" : "notes"}` },
      ),
    );
  }

  // Skills: the ones Hermes ships are left behind; CoWork has its own.
  const skillsDir = path.join(home, "skills");
  const bundled = readBundledSkillNames(skillsDir);
  const seen = new Set<string>();
  let bundledCount = 0;
  for (const skill of findSkillBundles(skillsDir)) {
    const key = skill.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    const id = `skill:${key}`;
    const label = `Skill: ${skill.name}`;
    if (bundled.has(key) || bundled.has(path.basename(skill.dir).toLowerCase())) {
      bundledCount += 1;
      continue;
    }
    items.push(
      readyItem(
        id,
        "skill",
        label,
        { kind: "skill", bundleDir: skill.dir, name: skill.name },
        {
          detail: shortDescription(skill.description),
        },
      ),
    );
  }
  if (bundledCount > 0) {
    // One line for all of them: edits to a bundled skill stay in Hermes.
    items.push(
      skippedItem(
        "skill:bundled",
        "skill",
        `${bundledCount} ${bundledCount === 1 ? "skill that ships" : "skills that ship"} with Hermes`,
        "CoWork has its own built-in skills.",
      ),
    );
  }

  // config.yaml
  let config: Record<string, unknown> = {};
  const configText = readTextIfExists(path.join(home, "config.yaml"));
  if (configText !== null) {
    try {
      // Hermes writes config.yaml with PyYAML (YAML 1.1); js-yaml 5 defaults to YAML 1.2,
      // which leaves `<<` merge keys unexpanded.
      config = asRecord(loadYaml(configText, { schema: YAML11_SCHEMA }));
    } catch {
      items.push(
        skippedItem(
          "config",
          "model",
          "Settings (config.yaml)",
          "config.yaml could not be parsed.",
        ),
      );
    }
  }
  const env = parseEnvText(readTextIfExists(path.join(home, ".env")) || "", options.withSecrets);
  const handledEnv = new Set<string>();

  // Provider keys
  const keyedProviders = new Set<ImportProviderId>();
  for (const { env: envName, provider } of PROVIDER_KEY_ENV) {
    if (!env.has(envName)) continue;
    handledEnv.add(envName);
    if (keyedProviders.has(provider)) continue;
    keyedProviders.add(provider);
    items.push(
      secretItem(
        options.withSecrets,
        `key:${provider}`,
        "provider_key",
        `${IMPORT_PROVIDER_LABELS[provider]} API key`,
        () => ({ kind: "provider_key", provider, value: secretValue(env.get(envName)) }),
        envName,
      ),
    );
  }

  // Model
  const modelValue = config.model;
  const modelSection = asRecord(modelValue);
  const modelName =
    typeof modelValue === "string" ? modelValue.trim() : asString(modelSection.default);
  const providerName = asString(modelSection.provider);
  if (modelName || providerName) {
    let provider =
      providerName && providerName !== "auto"
        ? providerFromName(providerName, asString(modelSection.base_url))
        : null;
    if (!provider && (!providerName || providerName === "auto") && keyedProviders.size === 1) {
      provider = [...keyedProviders][0];
    }
    const label = `Model: ${modelName || providerName}`;
    items.push(
      provider
        ? readyItem(
            "model",
            "model",
            label,
            { kind: "model", provider, model: modelName || undefined },
            {
              detail: IMPORT_PROVIDER_LABELS[provider],
            },
          )
        : skippedItem(
            "model",
            "model",
            label,
            `Provider "${providerName || "auto"}" has no CoWork equivalent; pick a model in Settings.`,
          ),
    );
  }

  // Chat channels
  const platformConfig = (name: string) =>
    asRecord(asRecord(config.platforms)[name]).allow_from ??
    asRecord(asRecord(asRecord(config.gateway).platforms)[name]).allow_from;
  for (const channel of Object.keys(HERMES_CHANNEL_ENV) as ImportChannelType[]) {
    const names = HERMES_CHANNEL_ENV[channel];
    handledEnv.add(names.token);
    handledEnv.add(names.allowedUsers);
    if (names.appToken) handledEnv.add(names.appToken);
    if (!env.has(names.token)) continue;
    const allowedUsers = splitIdList(env.get(names.allowedUsers) ?? platformConfig(channel) ?? "");
    const detail =
      allowedUsers.length > 0
        ? `${allowedUsers.length} allowed ${allowedUsers.length === 1 ? "user" : "users"}`
        : "pairing required";
    if (names.appToken && !env.has(names.appToken)) {
      items.push(
        skippedItem(
          `channel:${channel}`,
          "channel",
          CHANNEL_LABELS[channel],
          `${names.appToken} is not set.`,
          {
            secret: true,
          },
        ),
      );
      continue;
    }
    items.push(
      secretItem(
        options.withSecrets,
        `channel:${channel}`,
        "channel",
        CHANNEL_LABELS[channel],
        () => {
          const botToken = secretValue(env.get(names.token));
          const appToken = names.appToken ? secretValue(env.get(names.appToken)) : undefined;
          return {
            kind: "channel",
            channel,
            allowedUsers,
            ...(botToken ? { tokens: { botToken, ...(appToken ? { appToken } : {}) } } : {}),
          };
        },
        detail,
      ),
    );
  }
  for (const [prefix, label] of OTHER_PLATFORM_PREFIXES) {
    const keys = [...env.keys()].filter((key) => key.startsWith(prefix));
    if (keys.length === 0) continue;
    keys.forEach((key) => handledEnv.add(key));
    items.push(
      skippedItem(
        `channel:${prefix.slice(0, -1).toLowerCase()}`,
        "channel",
        label,
        "Not carried over; connect it in Settings > Channels.",
      ),
    );
  }

  // Other credentials are listed by name so nothing is silently dropped.
  for (const key of [...env.keys()].sort()) {
    if (handledEnv.has(key) || !isSecretEnvKey(key)) continue;
    items.push(
      skippedItem(
        `key:${key.toLowerCase()}`,
        "provider_key",
        key,
        "No CoWork setting takes this key yet.",
        {
          secret: true,
        },
      ),
    );
  }

  // Command allowlist: Hermes stores approved danger categories, not commands.
  const allowlist = Array.isArray(config.command_allowlist) ? config.command_allowlist : [];
  allowlist.forEach((entry, index) => {
    const label = `Always allow: ${String(entry)}`;
    items.push(
      skippedItem(
        `command:${index}`,
        "command_rule",
        label,
        "Hermes approves a whole category of risky commands; CoWork asks per command.",
      ),
    );
  });

  const tz = asString(config.timezone) || undefined;
  items.push(...readHermesCron(home, tz, nowMs));
  return plan;
}
