/**
 * Importing a Hermes or OpenClaw home: the readers against fixture homes (fake data
 * only), the preview never holding a secret, and the applier's checks, dry run and
 * fail-soft reporting against fake targets.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyImportPlan, type AgentImportTargets } from "../apply";
import {
  hermesPersonaText,
  readHermesHome,
  resolveHermesHome,
  splitHermesEntries,
} from "../hermes-reader";
import { readOpenClawHome, resolveOpenClawHome } from "../openclaw-reader";
import { toPreview, type ImportPlan, type PlannedImportItem } from "../plan";
import { commandPrefixFromAllowlistPattern, parseEnvText, WITHHELD_SECRET } from "../source-files";
import { discordApplicationIdFromToken } from "../targets";
import { detectAgentImports } from "../index";

const FIXTURES = path.join(__dirname, "fixtures");
const NOW = Date.parse("2026-10-17T12:00:00Z");

// Fake credentials, written at runtime (dotenv files are ignored by git).
const HERMES_ENV = [
  "# fixture",
  "OPENROUTER_API_KEY=sk-or-fixture-hermes-0001",
  'TELEGRAM_BOT_TOKEN="123456:fixture-telegram-token"',
  "TELEGRAM_ALLOWED_USERS=111, 222",
  "SLACK_BOT_TOKEN=xoxb-fixture-slack",
  "EXA_API_KEY=fixture-exa-key",
  "WHATSAPP_ENABLED=true",
  "LLM_MODEL=",
].join("\n");
const HERMES_SECRETS = [
  "sk-or-fixture-hermes-0001",
  "123456:fixture-telegram-token",
  "xoxb-fixture-slack",
  "fixture-exa-key",
];

const DISCORD_TOKEN = `${Buffer.from("123456789012345678").toString("base64")}.fixture.discordtoken`;
const OPENCLAW_ENV = [
  "OPENROUTER_API_KEY=sk-or-fixture-openclaw-0002",
  "TELEGRAM_BOT_TOKEN=654321:fixture-openclaw-telegram",
  `DISCORD_BOT_TOKEN=${DISCORD_TOKEN}`,
  "MYLAB_API_KEY=fixture-lab-key",
].join("\n");
const OPENCLAW_SECRETS = [
  "sk-or-fixture-openclaw-0002",
  "654321:fixture-openclaw-telegram",
  DISCORD_TOKEN,
  "fixture-lab-key",
];
const OPENCLAW_AGENTS_MD = "# Workspace rules\n\n- Run `npm test` before saying a change works.\n";

let base: string;
let hermesHome: string;
let openclawHome: string;

beforeEach(() => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-import-")));
  hermesHome = path.join(base, ".hermes");
  openclawHome = path.join(base, ".openclaw");
  fs.cpSync(path.join(FIXTURES, "hermes-home"), hermesHome, { recursive: true });
  fs.cpSync(path.join(FIXTURES, "openclaw-home"), openclawHome, { recursive: true });
  fs.writeFileSync(path.join(hermesHome, ".env"), HERMES_ENV);
  fs.writeFileSync(path.join(openclawHome, ".env"), OPENCLAW_ENV);
  fs.writeFileSync(path.join(openclawHome, "workspace", "AGENTS.md"), OPENCLAW_AGENTS_MD);
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

function byId(plan: ImportPlan, id: string): PlannedImportItem {
  const item = plan.items.find((entry) => entry.id === id);
  if (!item) throw new Error(`No item ${id}: ${plan.items.map((entry) => entry.id).join(", ")}`);
  return item;
}

function expectNoSecrets(value: unknown, secrets: string[]): void {
  const text = JSON.stringify(value);
  for (const secret of secrets) expect(text).not.toContain(secret);
}

describe("locating homes", () => {
  it("finds ~/.hermes, honours HERMES_HOME and a sticky profile", () => {
    expect(resolveHermesHome({ env: {}, homedir: base, platform: "darwin" })).toBe(hermesHome);
    const custom = path.join(base, "elsewhere");
    expect(resolveHermesHome({ env: { HERMES_HOME: custom }, homedir: base })).toBe(custom);
    fs.mkdirSync(path.join(hermesHome, "profiles", "work"), { recursive: true });
    fs.writeFileSync(path.join(hermesHome, "active_profile"), "work\n");
    expect(resolveHermesHome({ env: {}, homedir: base, platform: "darwin" })).toBe(
      path.join(hermesHome, "profiles", "work"),
    );
  });

  it("falls back to the older OpenClaw folder names", () => {
    fs.renameSync(openclawHome, path.join(base, ".clawdbot"));
    expect(resolveOpenClawHome({ homedir: base })).toBe(path.join(base, ".clawdbot"));
  });

  it("detects both homes for onboarding", () => {
    const found = detectAgentImports({ env: {}, homedir: base, platform: "darwin" });
    expect(found.map((entry) => [entry.source, entry.found])).toEqual([
      ["hermes", true],
      ["openclaw", true],
    ]);
    const empty = detectAgentImports({ env: {}, homedir: path.join(base, "nobody") });
    expect(empty.every((entry) => !entry.found)).toBe(true);
  });
});

describe("Hermes reader", () => {
  it("reads persona, memory, user skills, model, channels and cron without credentials", () => {
    const plan = readHermesHome(hermesHome, { withSecrets: false, nowMs: NOW });
    expect(plan.found).toBe(true);

    expect(byId(plan, "persona")).toMatchObject({
      status: "ready",
      payload: { kind: "persona", text: expect.stringContaining("You are Atlas") },
    });
    expect(byId(plan, "memory:user").payload).toEqual({
      kind: "memory_entries",
      target: "user",
      entries: [
        "Prefers metric units.",
        "Is building a weather station as a hobby project.",
        "Likes answers under 200 words.",
      ],
    });
    expect(byId(plan, "memory:agent").payload).toMatchObject({
      target: "agent",
      entries: expect.any(Array),
    });

    expect(byId(plan, "skill:field-notes")).toMatchObject({ status: "ready" });
    expect(byId(plan, "skill:bundled")).toMatchObject({
      status: "skipped",
      label: "1 skill that ships with Hermes",
    });
    expect(plan.items.some((item) => item.id === "skill:bundled-tool")).toBe(false);

    expect(byId(plan, "key:openrouter")).toMatchObject({
      status: "skipped",
      secret: true,
      detail: "OPENROUTER_API_KEY",
    });
    expect(byId(plan, "model")).toMatchObject({
      status: "ready",
      payload: { kind: "model", provider: "openrouter", model: "anthropic/claude-sonnet-4" },
    });
    expect(byId(plan, "channel:telegram")).toMatchObject({
      status: "skipped",
      secret: true,
      detail: "2 allowed users",
    });
    expect(byId(plan, "channel:slack").reason).toMatch(/SLACK_APP_TOKEN is not set/);
    expect(byId(plan, "channel:whatsapp")).toMatchObject({ status: "skipped" });
    expect(byId(plan, "key:exa_api_key")).toMatchObject({ status: "skipped", secret: true });
    expect(byId(plan, "command:0")).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/category/),
    });

    expect(byId(plan, "cron:a1")).toMatchObject({
      status: "ready",
      payload: {
        kind: "scheduled_task",
        schedule: { kind: "cron", expr: "0 8 * * *", tz: "Europe/Lisbon" },
      },
    });
    expect(byId(plan, "cron:b2").payload).toMatchObject({
      schedule: { kind: "every", everyMs: 1_800_000 },
    });
    expect(byId(plan, "cron:c3").reason).toMatch(/in the past/);
    expect(byId(plan, "cron:d4").reason).toMatch(/script/);

    // Without the opt-in no credential value is held anywhere in the plan.
    expectNoSecrets(plan, HERMES_SECRETS);
  });

  it("carries credentials only when they are opted in, and never into the preview", () => {
    const plan = readHermesHome(hermesHome, { withSecrets: true, nowMs: NOW });
    expect(byId(plan, "key:openrouter")).toMatchObject({
      status: "ready",
      payload: { kind: "provider_key", provider: "openrouter", value: "sk-or-fixture-hermes-0001" },
    });
    expect(byId(plan, "channel:telegram")).toMatchObject({
      status: "ready",
      payload: {
        kind: "channel",
        channel: "telegram",
        allowedUsers: ["111", "222"],
        tokens: { botToken: "123456:fixture-telegram-token" },
      },
    });
    // Keys CoWork has no setting for stay behind even with the opt-in.
    expect(byId(plan, "key:exa_api_key").status).toBe("skipped");
    expectNoSecrets(toPreview(plan), HERMES_SECRETS);
  });

  it("treats Hermes' default persona as nothing to import", () => {
    expect(hermesPersonaText("# Hermes Agent Persona\n\n<!--\nEdit this file.\n-->\n")).toBeNull();
    expect(
      hermesPersonaText(
        "You are Hermes Agent, an intelligent AI assistant created by Nous Research. Be targeted and efficient in your exploration and investigations.",
      ),
    ).toBeNull();
    expect(hermesPersonaText("You are Atlas.")).toBe("You are Atlas.");
  });

  it("splits memory entries only on a line holding the section sign", () => {
    expect(splitHermesEntries("a § inline\n§\nb\n\n§\n")).toEqual(["a § inline", "b"]);
  });

  it("expands YAML 1.1 merge keys in config.yaml, as PyYAML writes them", () => {
    fs.writeFileSync(
      path.join(hermesHome, "config.yaml"),
      "defaults: &defaults\n  provider: openrouter\nmodel:\n  <<: *defaults\n  default: anthropic/claude-sonnet-4\n",
    );
    const plan = readHermesHome(hermesHome, { withSecrets: false, nowMs: NOW });
    expect(byId(plan, "model").payload).toMatchObject({
      kind: "model",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
    });
  });

  it("returns an empty plan for a missing home", () => {
    const plan = readHermesHome(path.join(base, "missing"), { withSecrets: false });
    expect(plan).toMatchObject({ found: false, items: [] });
  });
});

describe("OpenClaw reader", () => {
  it("reads the JSON5 config, the workspace files and the legacy cron file", () => {
    const plan = readOpenClawHome(openclawHome, { withSecrets: false, nowMs: NOW, homedir: base });
    expect(plan.found).toBe(true);

    expect(byId(plan, "persona").payload).toEqual({
      kind: "persona",
      text: "You are Juniper, a cheerful gardening assistant who keeps replies short.",
    });
    expect(byId(plan, "instructions").payload).toMatchObject({
      kind: "workspace_instructions",
      text: expect.stringContaining("npm test"),
    });
    // The blank "Name:" template field is not a fact.
    expect(byId(plan, "memory:user").payload).toEqual({
      kind: "memory_entries",
      target: "user",
      entries: ["Prefers tea over coffee.", "Grows tomatoes on a balcony."],
    });
    expect(byId(plan, "memory:agent").payload).toMatchObject({
      entries: ["The balcony faces south.", "Watering happens at 7am."],
    });
    expect(byId(plan, "memory:daily").payload).toEqual({
      kind: "memory_inbox",
      label: "OpenClaw daily notes",
      entries: [{ text: "Planted basil seedlings.", added: "2026-09-01" }],
    });
    expect(byId(plan, "skill:garden-planner").status).toBe("ready");

    expect(byId(plan, "key:openrouter")).toMatchObject({ status: "skipped", secret: true });
    expect(byId(plan, "key:mylab").reason).toMatch(/No CoWork equivalent/);
    expect(byId(plan, "model").payload).toEqual({
      kind: "model",
      provider: "openrouter",
      model: "anthropic/claude-sonnet-4",
    });
    expect(byId(plan, "channel:telegram").detail).toBe("1 allowed user");
    expect(byId(plan, "channel:discord").detail).toBe("1 allowed user");
    expect(byId(plan, "channel:whatsapp").status).toBe("skipped");

    expect(byId(plan, "command:/opt/homebrew/bin/rg")).toMatchObject({
      status: "ready",
      payload: { kind: "command_rule", prefix: "rg" },
    });
    expect(byId(plan, "command:/usr/bin/*").status).toBe("skipped");
    expect(byId(plan, "command:/bin/bash").reason).toMatch(/approval-gated/);

    expect(byId(plan, "cron:j1").payload).toMatchObject({
      prompt: "Draft my standup notes",
      schedule: { kind: "cron", expr: "30 9 * * 1-5", tz: "Europe/Berlin" },
    });
    expect(byId(plan, "cron:j2").status).toBe("skipped");

    expectNoSecrets(plan, OPENCLAW_SECRETS);
  });

  it("resolves ${VAR} templates and env SecretRefs when credentials are opted in", () => {
    const plan = readOpenClawHome(openclawHome, { withSecrets: true, nowMs: NOW, homedir: base });
    expect(byId(plan, "key:openrouter").payload).toEqual({
      kind: "provider_key",
      provider: "openrouter",
      value: "sk-or-fixture-openclaw-0002",
    });
    expect(byId(plan, "channel:telegram").payload).toEqual({
      kind: "channel",
      channel: "telegram",
      allowedUsers: ["777"],
      tokens: { botToken: "654321:fixture-openclaw-telegram" },
    });
    expect(byId(plan, "channel:discord").payload).toMatchObject({
      tokens: { botToken: DISCORD_TOKEN },
    });
    expectNoSecrets(toPreview(plan), OPENCLAW_SECRETS);
  });

  it("reads JSON5 with comments, unquoted keys and trailing commas", () => {
    fs.writeFileSync(
      path.join(openclawHome, "openclaw.json"),
      [
        "// written by hand",
        "{",
        "  agents: { defaults: { model: 'anthropic/claude-opus-4', }, },",
        "  /* trailing comma below */",
        "  channels: {},",
        "}",
      ].join("\n"),
    );
    const plan = readOpenClawHome(openclawHome, { withSecrets: false, nowMs: NOW, homedir: base });
    expect(byId(plan, "model").payload).toEqual({
      kind: "model",
      provider: "anthropic",
      model: "claude-opus-4",
    });
  });

  it("reports a config it cannot parse instead of failing", () => {
    fs.writeFileSync(path.join(openclawHome, "openclaw.json"), "{ not json5");
    const plan = readOpenClawHome(openclawHome, { withSecrets: false, nowMs: NOW, homedir: base });
    expect(byId(plan, "config").reason).toMatch(/could not be parsed/);
    expect(byId(plan, "persona").status).toBe("ready");
  });
});

describe("source helpers", () => {
  it("withholds credential values unless asked", () => {
    const env = parseEnvText(
      "A_API_KEY=secret\nALLOWED_USERS=1,2\nEMPTY=\nexport B_TOKEN='t'",
      false,
    );
    expect(env.get("A_API_KEY")).toBe(WITHHELD_SECRET);
    expect(env.get("B_TOKEN")).toBe(WITHHELD_SECRET);
    expect(env.get("ALLOWED_USERS")).toBe("1,2");
    expect(env.has("EMPTY")).toBe(false);
    expect(parseEnvText("A_API_KEY=secret # note", true).get("A_API_KEY")).toBe("secret");
  });

  it("only turns exact, non-shell programs into command rules", () => {
    expect(commandPrefixFromAllowlistPattern("/opt/homebrew/bin/rg")).toEqual({ prefix: "rg" });
    expect(commandPrefixFromAllowlistPattern("C:\\tools\\jq.exe")).toEqual({ prefix: "jq" });
    for (const pattern of [
      "/usr/bin/*",
      "/bin/bash",
      "/usr/bin/python3.12",
      "/usr/bin/env",
      "git status",
      "",
    ]) {
      expect(commandPrefixFromAllowlistPattern(pattern)).toHaveProperty("reason");
    }
  });

  it("reads the Discord application id from a bot token", () => {
    expect(discordApplicationIdFromToken(DISCORD_TOKEN)).toBe("123456789012345678");
    expect(discordApplicationIdFromToken("not-a-token")).toBeNull();
  });
});

function fakeTargets(
  overrides: Partial<{
    activeConfigured: boolean;
    existingPersona: string;
    workspace: boolean;
  }> = {},
) {
  const calls: Array<[string, ...unknown[]]> = [];
  const keys = new Set<string>();
  const targets: AgentImportTargets = {
    workspace:
      overrides.workspace === false
        ? null
        : { id: "ws-1", name: "Garden", path: path.join(base, "ws") },
    persona: {
      existing: () => overrides.existingPersona ?? "",
      save: (text) => calls.push(["persona", text]),
    },
    memory: {
      available: () => true,
      remember: async (input) => {
        calls.push(["remember", input.target, input.text, input.workspace?.id ?? null]);
        return input.text.includes("200 words") ? { ok: false, reason: "too long" } : { ok: true };
      },
      importToInbox: async (entries, label) => {
        calls.push(["inbox", label, entries.length]);
        return { imported: entries.length, duplicates: 0, skipped: 0 };
      },
    },
    skills: {
      install: async (dir) => {
        calls.push(["skill", path.basename(dir)]);
        return { ok: true };
      },
    },
    providers: {
      hasKey: (provider) => keys.has(provider),
      saveKey: (provider) => {
        keys.add(provider);
        calls.push(["key", provider]);
      },
      active: () => ({ provider: "anthropic", configured: overrides.activeConfigured === true }),
      selectModel: (provider, model) => calls.push(["model", provider, model]),
    },
    channels: {
      exists: async () => false,
      create: async (input) => {
        calls.push(["channel", input.channel, input.allowedUsers]);
      },
    },
    commandRules: {
      has: () => false,
      add: (prefix) => calls.push(["command", prefix]),
    },
    scheduledTasks: {
      add: async (task, workspace) => {
        calls.push(["cron", task.name, workspace.id]);
        return { ok: true };
      },
    },
    workspaceInstructions: {
      write: async (_text, workspace) => {
        calls.push(["instructions", workspace.id]);
        return { ok: true };
      },
    },
  };
  return { targets, calls };
}

describe("applying a plan", () => {
  it("writes nothing on a dry run and reports what would be imported", async () => {
    const plan = readHermesHome(hermesHome, { withSecrets: true, nowMs: NOW });
    const { targets, calls } = fakeTargets();
    const result = await applyImportPlan(plan, targets, { dryRun: true });
    expect(calls).toEqual([]);
    expect(result.dryRun).toBe(true);
    expect(result.imported).toBe(0);
    expect(result.items.find((item) => item.id === "model")?.status).toBe("ready");
    expect(result.items.find((item) => item.id === "skill:field-notes")?.status).toBe("ready");
  });

  it("imports through the targets, keys before the model, and fails soft", async () => {
    const plan = readHermesHome(hermesHome, { withSecrets: true, nowMs: NOW });
    const { targets, calls } = fakeTargets();
    const result = await applyImportPlan(plan, targets, {
      dryRun: false,
      excludeItemIds: ["cron:b2"],
    });
    const status = (id: string) => result.items.find((item) => item.id === id);

    expect(calls).toContainEqual(["persona", expect.stringContaining("Atlas")]);
    expect(calls).toContainEqual(["remember", "user", "Prefers metric units.", "ws-1"]);
    expect(calls).toContainEqual(["skill", "field-notes"]);
    expect(calls).toContainEqual(["channel", "telegram", ["111", "222"]]);
    expect(calls).toContainEqual(["cron", "Morning brief", "ws-1"]);
    expect(calls.findIndex((call) => call[0] === "key")).toBeLessThan(
      calls.findIndex((call) => call[0] === "model"),
    );
    expect(status("memory:user")).toMatchObject({
      status: "imported",
      reason: expect.stringMatching(/2 of 3 written/),
    });
    expect(status("cron:b2")).toMatchObject({ status: "skipped", reason: "Left out." });
    expect(status("channel:telegram")?.reason).toMatch(/switched off/);
    expect(result.failed).toBe(0);
  });

  it("keeps an existing persona and model, and needs a workspace for scheduled tasks", async () => {
    const plan = readHermesHome(hermesHome, { withSecrets: false, nowMs: NOW });
    const { targets, calls } = fakeTargets({
      activeConfigured: true,
      existingPersona: "You are someone else.",
      workspace: false,
    });
    const result = await applyImportPlan(plan, targets, { dryRun: false });
    const status = (id: string) => result.items.find((item) => item.id === id);
    expect(status("persona")).toMatchObject({
      status: "skipped",
      reason: expect.stringMatching(/already has a custom persona/),
    });
    expect(status("model")?.reason).toMatch(/already has a working model/);
    expect(status("cron:a1")?.reason).toMatch(/Choose a workspace/);
    expect(
      calls.some((call) => call[0] === "persona" || call[0] === "model" || call[0] === "cron"),
    ).toBe(false);
    // Agent notes go to the global lessons without a workspace.
    expect(calls).toContainEqual([
      "remember",
      "agent",
      "Deploys go through the staging branch first.",
      null,
    ]);
  });

  it("does not choose a model without a key for its provider", async () => {
    const plan = readHermesHome(hermesHome, { withSecrets: false, nowMs: NOW });
    const { targets } = fakeTargets();
    const result = await applyImportPlan(plan, targets, { dryRun: true });
    expect(result.items.find((item) => item.id === "model")?.reason).toMatch(/No OpenRouter key/);
  });

  it("reports a target that throws as failed, with credentials scrubbed from the reason", async () => {
    const plan = readOpenClawHome(openclawHome, { withSecrets: true, nowMs: NOW, homedir: base });
    const { targets } = fakeTargets();
    targets.channels.create = async (input) => {
      throw new Error(`gateway refused token ${input.botToken}`);
    };
    const consoleSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    const result = await applyImportPlan(plan, targets, { dryRun: false });
    consoleSpy.mockRestore();
    const telegram = result.items.find((item) => item.id === "channel:telegram");
    expect(telegram).toMatchObject({
      status: "failed",
      reason: "gateway refused token [redacted]",
    });
    expect(result.items.find((item) => item.id === "instructions")?.status).toBe("imported");
    expectNoSecrets(result, OPENCLAW_SECRETS);
  });
});
