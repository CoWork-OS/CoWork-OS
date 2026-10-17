/**
 * The real import targets: each one writes through the manager that owns that data, so an
 * import gets the same validation, encryption and history as a change made in Settings.
 *
 * - persona → PersonalityManager (encrypted settings)
 * - memory → the memory folder (MemoryRepoService: me.md, workspace notes, inbox)
 * - skills → SkillRegistry (security scan, quarantine)
 * - provider keys and model → LLMProviderFactory (safeStorage-encrypted settings)
 * - chat channels → ChannelRepository (config sealed with safeStorage)
 * - command allowlist → profile permission rules (PermissionSettingsManager)
 * - scheduled tasks → CronService, or the cron store when no service runs (CLI)
 * - workspace instructions → the workspace kit (.cowork/AGENTS.md, with revision history)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";
import type { AgentImportSource, PermissionRule } from "../../shared/types";
import { LLMProviderFactory } from "../agent/llm/provider-factory";
import { getSkillRegistry } from "../agent/skill-registry";
import { withKitFrontmatter, writeTemplate } from "../context/kit-operations";
import { writeKitFileWithSnapshot } from "../context/kit-revisions";
import { loadCronStore, saveCronStore } from "../cron/store";
import { validateCronExpression, validateCronTimeZone } from "../cron/schedule";
import type { CronJob, CronService } from "../cron";
import { ChannelRepository } from "../database/repository-facades";
import { MemoryRepoService, type MemoryRepoSkipReason } from "../memory/repo/MemoryRepoService";
import { PermissionSettingsManager } from "../security/permission-settings-manager";
import { permissionRuleFingerprint } from "../security/permission-utils";
import { PersonalityManager } from "../settings/personality-manager";
import type {
  AgentImportTargets,
  ImportWorkspace,
  ImportedScheduledTask,
  TargetOutcome,
} from "./apply";
import type { ImportChannelType, ImportProviderId } from "./plan";

const SOURCE_LABELS: Record<AgentImportSource, string> = {
  hermes: "Hermes",
  openclaw: "OpenClaw",
};

const MEMORY_SKIP_LABELS: Record<MemoryRepoSkipReason, string> = {
  empty: "empty",
  low_salience: "too vague",
  secret_only: "only a secret",
  no_memory: "marked no-memory",
  memory_disabled: "memory off for the workspace",
  private: "private",
  outranked: "already noted differently",
  too_large: "too long",
  unavailable: "memory folder unavailable",
  busy: "memory folder busy",
  dirty: "memory folder has unsaved changes",
};

/** The `.cowork/AGENTS.md` limit (kit-contracts). */
const MAX_INSTRUCTIONS_CHARS = 12_000;

export type ImportCronTarget =
  /** The app: jobs go through the running scheduler. */
  | { kind: "service"; service: CronService }
  /**
   * The CLI: no scheduler runs, so jobs are added to the store file. Refused while the
   * desktop app is open, because its scheduler would write over the file.
   */
  | { kind: "store"; storePath: string; desktopRunning: boolean };

export interface DefaultImportTargetDeps {
  db: Database.Database;
  workspace: ImportWorkspace | null;
  cron: ImportCronTarget | null;
}

/**
 * Discord bot tokens start with the bot's user id in base64, which is the application id
 * the gateway needs. Null when the token does not have that shape.
 */
export function discordApplicationIdFromToken(token: string): string | null {
  const first = token.split(".")[0] || "";
  try {
    const decoded = Buffer.from(first, "base64").toString("utf8");
    return /^\d{15,22}$/.test(decoded) ? decoded : null;
  } catch {
    return null;
  }
}

function settingsNode(settings: Record<string, unknown>, key: string): Record<string, unknown> {
  const existing = settings[key];
  if (existing && typeof existing === "object" && !Array.isArray(existing)) {
    return existing as Record<string, unknown>;
  }
  const node: Record<string, unknown> = {};
  settings[key] = node;
  return node;
}

function memoryOutcome(result: Awaited<ReturnType<MemoryRepoService["remember"]>>): TargetOutcome {
  return result.status === "written"
    ? { ok: true }
    : { ok: false, reason: MEMORY_SKIP_LABELS[result.reason] || result.reason };
}

function commandRule(prefix: string, source: AgentImportSource): PermissionRule {
  return {
    source: "profile",
    effect: "allow",
    scope: { kind: "command_prefix", prefix },
    metadata: { importedFrom: source },
  };
}

function scheduleForStore(task: ImportedScheduledTask, nowMs: number): CronJob["schedule"] {
  return task.schedule.kind === "every"
    ? { kind: "every", everyMs: task.schedule.everyMs, anchorMs: nowMs }
    : task.schedule;
}

async function addScheduledTaskToStore(
  storePath: string,
  task: ImportedScheduledTask,
  workspace: ImportWorkspace,
): Promise<TargetOutcome> {
  const nowMs = Date.now();
  const store = await loadCronStore(storePath);
  const job: CronJob = {
    id: randomUUID(),
    name: task.name,
    description: `Imported from ${SOURCE_LABELS[task.source]}`,
    // Paused: the user turns it on after checking the prompt and the access profile.
    enabled: false,
    allowUserInput: false,
    createdAtMs: nowMs,
    updatedAtMs: nowMs,
    schedule: scheduleForStore(task, nowMs),
    workspaceId: workspace.id,
    taskPrompt: task.prompt,
    taskTitle: task.name,
    state: { runHistory: [], totalRuns: 0, successfulRuns: 0, failedRuns: 0 },
  };
  store.jobs.push(job);
  await saveCronStore(storePath, store);
  return { ok: true, note: "Paused; turn it on in Scheduled tasks." };
}

export function createDefaultImportTargets(deps: DefaultImportTargetDeps): AgentImportTargets {
  const channels = new ChannelRepository(deps.db);
  return {
    workspace: deps.workspace,

    persona: {
      existing: () => PersonalityManager.loadConfigV2().soulDocument || "",
      save: (text) => {
        const config = PersonalityManager.loadConfigV2();
        PersonalityManager.saveConfigV2({ ...config, soulDocument: text });
      },
    },

    memory: {
      available: () => MemoryRepoService.get()?.isWritable() === true,
      remember: async ({ text, target, source, workspace }) => {
        const service = MemoryRepoService.get();
        if (!service) return { ok: false, reason: MEMORY_SKIP_LABELS.unavailable };
        const common = {
          text,
          by: "user" as const,
          origin: "import" as const,
          skipWorkspacePolicy: true,
          metadata: { source },
        };
        if (target === "user") {
          return memoryOutcome(
            await service.remember({ ...common, kind: "preference", scope: "global" }),
          );
        }
        return memoryOutcome(
          await service.remember(
            workspace
              ? {
                  ...common,
                  kind: "project_fact",
                  scope: "workspace",
                  workspaceId: workspace.id,
                  workspaceName: workspace.name,
                }
              : { ...common, kind: "insight", scope: "global" },
          ),
        );
      },
      importToInbox: async (entries, label) => {
        const service = MemoryRepoService.get();
        if (!service)
          return { imported: 0, duplicates: 0, skipped: 0, error: MEMORY_SKIP_LABELS.unavailable };
        return service.importToInbox(
          entries.map((entry) => ({
            text: entry.text,
            ...(entry.added ? { added: entry.added } : {}),
          })),
          label,
        );
      },
    },

    skills: {
      install: async (bundleDir, sourceRef) => {
        const result = await getSkillRegistry().installFromLocalBundle(bundleDir, sourceRef);
        if (result.success) {
          return result.security?.state === "installed_with_warning"
            ? { ok: true, note: result.security.summary || "Installed with a security warning." }
            : { ok: true };
        }
        return {
          ok: false,
          reason:
            result.security?.state === "quarantined"
              ? `${result.error || "Quarantined by the security scan"}; review it in Settings > Skills.`
              : result.error || "Not installed.",
        };
      },
    },

    providers: {
      hasKey: (provider) => {
        const settings = LLMProviderFactory.loadSettings() as unknown as Record<string, unknown>;
        const node = settings[provider];
        return Boolean(
          node && typeof node === "object" && (node as Record<string, unknown>).apiKey,
        );
      },
      saveKey: (provider, value) => {
        // LLMProviderFactory stores provider settings encrypted (safeStorage), never in plain text.
        const settings = LLMProviderFactory.loadSettings() as unknown as Record<string, unknown>;
        const node = settingsNode(settings, provider);
        node.apiKey = value;
        if (provider === "anthropic" || provider === "openai") node.authMethod = "api_key";
        LLMProviderFactory.saveSettings(
          settings as unknown as ReturnType<typeof LLMProviderFactory.loadSettings>,
        );
        LLMProviderFactory.clearCache?.();
      },
      active: () => {
        const status = LLMProviderFactory.getConfigStatus();
        const current = status.providers.find(
          (provider) => provider.type === status.currentProvider,
        );
        return { provider: status.currentProvider, configured: current?.configured === true };
      },
      selectModel: (provider: ImportProviderId, model?: string) => {
        const settings = LLMProviderFactory.loadSettings() as unknown as Record<string, unknown>;
        settings.providerType = provider;
        // Anthropic models use CoWork's own model keys; keep its default there.
        if (model && provider !== "anthropic") {
          settings.modelKey = model;
          settingsNode(settings, provider).model = model;
        }
        LLMProviderFactory.saveSettings(
          settings as unknown as ReturnType<typeof LLMProviderFactory.loadSettings>,
        );
        LLMProviderFactory.clearCache?.();
      },
    },

    channels: {
      exists: async (channel: ImportChannelType) => Boolean(await channels.findByType(channel)),
      create: async ({ channel, botToken, appToken, allowedUsers, source }) => {
        const securityConfig = {
          // Hermes and OpenClaw allowlists stay allowlists; without one, people pair first.
          mode: allowedUsers.length > 0 ? ("allowlist" as const) : ("pairing" as const),
          ...(allowedUsers.length > 0 ? { allowedUsers } : {}),
          pairingCodeTTL: 300,
          maxPairingAttempts: 5,
          rateLimitPerMinute: 30,
        };
        const name = `${channel[0].toUpperCase()}${channel.slice(1)} (from ${SOURCE_LABELS[source]})`;
        let config: Record<string, unknown>;
        if (channel === "telegram") {
          config = { botToken };
        } else if (channel === "discord") {
          const applicationId = discordApplicationIdFromToken(botToken);
          if (!applicationId)
            throw new Error("Could not read the Discord application id from the bot token.");
          config = { botToken, applicationId };
        } else {
          if (!appToken) throw new Error("Slack needs an app-level token.");
          config = { botToken, appToken, progressRelayMode: "minimal" };
        }
        const created = await channels.createIfTypeAbsent({
          type: channel,
          name,
          // Switched off like any new channel until the user tests it.
          enabled: false,
          config,
          securityConfig,
          status: "disconnected",
        });
        if (!created) throw new Error(`A ${channel} channel is already set up.`);
      },
    },

    commandRules: {
      has: (prefix) => {
        const fingerprint = permissionRuleFingerprint(commandRule(prefix, "hermes"));
        return PermissionSettingsManager.loadSettings().rules.some(
          (rule) => permissionRuleFingerprint(rule) === fingerprint,
        );
      },
      // A profile rule like the ones "Always allow" saves. It is not a policy bypass: the
      // permission engine still applies protected paths, guardrails, dangerous-command
      // consent and the access profile's limits before a rule is consulted.
      add: (prefix, source) => {
        PermissionSettingsManager.appendRule(commandRule(prefix, source));
      },
    },

    scheduledTasks: {
      add: async (task, workspace) => {
        const cron = deps.cron;
        if (!cron) return { ok: false, reason: "Scheduled tasks are not available here." };
        if (task.schedule.kind === "cron") {
          if (!validateCronExpression(task.schedule.expr)) {
            return { ok: false, reason: "Not a valid cron expression." };
          }
          if (!validateCronTimeZone(task.schedule.tz)) {
            return { ok: false, reason: "Unknown time zone." };
          }
        }
        if (cron.kind === "store") {
          if (cron.desktopRunning) {
            return {
              ok: false,
              reason:
                "CoWork is open; import from Settings > Import, or quit CoWork and run this again.",
            };
          }
          return addScheduledTaskToStore(cron.storePath, task, workspace);
        }
        const result = await cron.service.add({
          name: task.name,
          description: `Imported from ${SOURCE_LABELS[task.source]}`,
          // Paused: the user turns it on after checking the prompt and the access profile.
          enabled: false,
          schedule: task.schedule,
          workspaceId: workspace.id,
          taskPrompt: task.prompt,
          taskTitle: task.name,
        });
        return result.ok
          ? { ok: true, note: "Paused; turn it on in Scheduled tasks." }
          : { ok: false, reason: result.error };
      },
    },

    workspaceInstructions: {
      write: async (text, workspace, source) => {
        const relPath = path.join(".cowork", "AGENTS.md");
        const absPath = path.join(workspace.path, relPath);
        const marker = `<!-- imported from ${source} -->`;
        const section = `${marker}\n## Imported from ${SOURCE_LABELS[source]}\n\n${text.trim()}\n`;
        let existing: string | null = null;
        try {
          existing = fs.readFileSync(absPath, "utf8");
        } catch {
          existing = null;
        }
        if (existing === null) {
          const stamp = new Date().toISOString().slice(0, 10);
          await writeTemplate(
            workspace.path,
            relPath,
            withKitFrontmatter(relPath, section, stamp),
            "missing",
          );
          return { ok: true };
        }
        if (existing.includes(marker))
          return { ok: false, reason: "Already imported into this workspace." };
        const next = `${existing.trimEnd()}\n\n${section}`;
        if (next.length > MAX_INSTRUCTIONS_CHARS) {
          return {
            ok: false,
            reason: `The workspace instructions would pass ${MAX_INSTRUCTIONS_CHARS} characters; copy the parts you need.`,
          };
        }
        writeKitFileWithSnapshot(absPath, next, "user", `import:${source}`);
        return { ok: true, note: "Added to the workspace's existing instructions." };
      },
    },
  };
}
