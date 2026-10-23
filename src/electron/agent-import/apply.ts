/**
 * Apply an import plan through CoWork's own managers.
 *
 * The applier only talks to `AgentImportTargets` (targets.ts wires the real managers), so
 * it is testable without Electron. A dry run walks the same checks and writes nothing.
 * Every item fails soft: one that cannot be written is reported with a reason and the
 * rest carry on. Error text is scrubbed of the plan's secret values before it is
 * returned or logged.
 */

import type {
  AgentImportCategory,
  AgentImportItemResult,
  AgentImportResult,
  AgentImportSource,
} from "../../shared/types";
import { createLogger } from "../utils/logger";
import {
  IMPORT_PROVIDER_LABELS,
  isLocalModelProvider,
  modelProviderLabel,
  planSecretValues,
  scrubSecrets,
  type ImportChannelType,
  type ImportModelProviderId,
  type ImportPlan,
  type ImportProviderId,
  type ImportSchedule,
  type PlannedImportItem,
} from "./plan";

const logger = createLogger("AgentImport");

export interface ImportWorkspace {
  id: string;
  name: string;
  path: string;
}

export type TargetOutcome = { ok: true; note?: string } | { ok: false; reason: string };

export interface ImportedScheduledTask {
  name: string;
  prompt: string;
  schedule: ImportSchedule;
  source: AgentImportSource;
}

export interface AgentImportTargets {
  /** Where scheduled tasks, workspace instructions and agent notes go; null when none. */
  workspace: ImportWorkspace | null;
  persona: {
    /** CoWork's current custom persona text ("" when none). */
    existing(): string;
    save(text: string, source: AgentImportSource): void;
  };
  memory: {
    available(): boolean;
    remember(input: {
      text: string;
      target: "user" | "agent";
      source: AgentImportSource;
      workspace: ImportWorkspace | null;
    }): Promise<TargetOutcome>;
    importToInbox(
      entries: Array<{ text: string; added?: string }>,
      label: string,
    ): Promise<{ imported: number; duplicates: number; skipped: number; error?: string }>;
  };
  skills: {
    install(bundleDir: string, sourceRef: string): Promise<TargetOutcome>;
  };
  providers: {
    hasKey(provider: ImportProviderId): boolean;
    saveKey(provider: ImportProviderId, value: string): void;
    /** The provider CoWork uses now and whether it is set up. */
    active(): { provider: string; configured: boolean };
    /** `baseUrl` is set for a local model server (Ollama, OpenAI-compatible). */
    selectModel(provider: ImportModelProviderId, model?: string, baseUrl?: string): void;
  };
  channels: {
    exists(channel: ImportChannelType): Promise<boolean>;
    create(input: {
      channel: ImportChannelType;
      botToken: string;
      appToken?: string;
      allowedUsers: string[];
      source: AgentImportSource;
    }): Promise<void>;
  };
  commandRules: {
    has(prefix: string): boolean;
    add(prefix: string, source: AgentImportSource): void;
  };
  scheduledTasks: {
    add(task: ImportedScheduledTask, workspace: ImportWorkspace): Promise<TargetOutcome>;
  };
  workspaceInstructions: {
    write(
      text: string,
      workspace: ImportWorkspace,
      source: AgentImportSource,
    ): Promise<TargetOutcome>;
  };
}

export interface ApplyImportOptions {
  dryRun: boolean;
  excludeItemIds?: readonly string[];
}

/** Keys first so a model choice can rely on a key imported in the same run. */
const CATEGORY_ORDER: AgentImportCategory[] = [
  "persona",
  "user_profile",
  "memory",
  "skill",
  "provider_key",
  "model",
  "channel",
  "command_rule",
  "scheduled_task",
  "workspace_instructions",
];

const SOURCE_LABELS: Record<AgentImportSource, string> = {
  hermes: "Hermes",
  openclaw: "OpenClaw",
};

const CHANNEL_LABELS: Record<ImportChannelType, string> = {
  telegram: "Telegram",
  discord: "Discord",
  slack: "Slack",
};

type Verdict = TargetOutcome;

class ImportRun {
  private readonly keysImported = new Set<ImportProviderId>();

  constructor(
    private readonly plan: ImportPlan,
    private readonly targets: AgentImportTargets,
    private readonly dryRun: boolean,
  ) {}

  async item(item: PlannedImportItem): Promise<Verdict> {
    const { targets, dryRun, plan } = this;
    const payload = item.payload;
    switch (payload.kind) {
      case "persona": {
        const existing = targets.persona.existing().trim();
        if (existing && existing !== payload.text.trim()) {
          return {
            ok: false,
            reason: "CoWork already has a custom persona; replace it in Settings > Personality.",
          };
        }
        if (existing) return { ok: false, reason: "Already imported." };
        if (!dryRun) targets.persona.save(payload.text, plan.source);
        return { ok: true };
      }
      case "memory_entries": {
        if (!targets.memory.available()) {
          return {
            ok: false,
            reason: "The memory folder is off; turn it on in Settings > Memory.",
          };
        }
        if (dryRun) return { ok: true };
        let written = 0;
        const reasons = new Map<string, number>();
        for (const text of payload.entries) {
          const outcome = await targets.memory.remember({
            text,
            target: payload.target,
            source: plan.source,
            workspace: targets.workspace,
          });
          if (outcome.ok) written += 1;
          else reasons.set(outcome.reason, (reasons.get(outcome.reason) || 0) + 1);
        }
        const skippedNote = [...reasons].map(([reason, count]) => `${count} ${reason}`).join(", ");
        if (written === 0) return { ok: false, reason: skippedNote || "Nothing was written." };
        return {
          ok: true,
          note: skippedNote
            ? `${written} of ${payload.entries.length} written; skipped: ${skippedNote}`
            : `${written} written`,
        };
      }
      case "memory_inbox": {
        if (!targets.memory.available()) {
          return {
            ok: false,
            reason: "The memory folder is off; turn it on in Settings > Memory.",
          };
        }
        if (dryRun) return { ok: true };
        const outcome = await targets.memory.importToInbox(payload.entries, payload.label);
        if (outcome.error) return { ok: false, reason: outcome.error };
        if (outcome.imported === 0) {
          return {
            ok: false,
            reason: outcome.duplicates > 0 ? "Already imported." : "Nothing was written.",
          };
        }
        return { ok: true, note: `${outcome.imported} notes in the memory inbox to review` };
      }
      case "skill": {
        if (dryRun) return { ok: true };
        return targets.skills.install(
          payload.bundleDir,
          `${SOURCE_LABELS[plan.source]}: ${payload.name}`,
        );
      }
      case "provider_key": {
        if (!payload.value) return { ok: false, reason: "No value." };
        if (targets.providers.hasKey(payload.provider)) {
          return { ok: false, reason: "CoWork already has a key for this provider." };
        }
        if (!dryRun) targets.providers.saveKey(payload.provider, payload.value);
        this.keysImported.add(payload.provider);
        return { ok: true };
      }
      case "model": {
        const active = targets.providers.active();
        if (active.configured) {
          return {
            ok: false,
            reason: "CoWork already has a working model; change it in Settings > Models.",
          };
        }
        const provider = payload.provider;
        if (isLocalModelProvider(provider)) {
          // A local server needs no key, but CoWork's OpenAI-compatible setup needs a model.
          if (provider === "openai-compatible" && !payload.model) {
            return { ok: false, reason: "No model name; pick one in Settings > Models." };
          }
        } else if (!targets.providers.hasKey(provider) && !this.keysImported.has(provider)) {
          return {
            ok: false,
            reason: `No ${IMPORT_PROVIDER_LABELS[provider]} key; include credentials or add one in Settings > Models.`,
          };
        }
        if (!dryRun) targets.providers.selectModel(provider, payload.model, payload.baseUrl);
        return {
          ok: true,
          note: payload.baseUrl
            ? `${modelProviderLabel(provider)} at ${payload.baseUrl}`
            : modelProviderLabel(provider),
        };
      }
      case "channel": {
        if (!payload.tokens) return { ok: false, reason: "No bot token." };
        if (await targets.channels.exists(payload.channel)) {
          return {
            ok: false,
            reason: `A ${CHANNEL_LABELS[payload.channel]} channel is already set up.`,
          };
        }
        if (!dryRun) {
          await targets.channels.create({
            channel: payload.channel,
            botToken: payload.tokens.botToken,
            appToken: payload.tokens.appToken,
            allowedUsers: payload.allowedUsers,
            source: plan.source,
          });
        }
        return { ok: true, note: "Added switched off; turn it on in Settings > Channels." };
      }
      case "command_rule": {
        if (targets.commandRules.has(payload.prefix))
          return { ok: false, reason: "Already allowed." };
        if (!dryRun) targets.commandRules.add(payload.prefix, plan.source);
        return { ok: true };
      }
      case "scheduled_task": {
        const workspace = targets.workspace;
        if (!workspace)
          return { ok: false, reason: "Choose a workspace to put scheduled tasks in." };
        if (dryRun) return { ok: true };
        return targets.scheduledTasks.add(
          {
            name: payload.name,
            prompt: payload.prompt,
            schedule: payload.schedule,
            source: plan.source,
          },
          workspace,
        );
      }
      case "workspace_instructions": {
        const workspace = targets.workspace;
        if (!workspace) return { ok: false, reason: "Choose a workspace for these instructions." };
        if (dryRun) return { ok: true };
        return targets.workspaceInstructions.write(payload.text, workspace, plan.source);
      }
      case "none":
      default:
        return { ok: false, reason: "Nothing to import." };
    }
  }
}

export async function applyImportPlan(
  plan: ImportPlan,
  targets: AgentImportTargets,
  options: ApplyImportOptions,
): Promise<AgentImportResult> {
  const excluded = new Set(options.excludeItemIds ?? []);
  const secrets = planSecretValues(plan);
  const run = new ImportRun(plan, targets, options.dryRun);
  const ordered = [...plan.items].sort(
    (a, b) => CATEGORY_ORDER.indexOf(a.category) - CATEGORY_ORDER.indexOf(b.category),
  );
  const results: AgentImportItemResult[] = [];
  for (const item of ordered) {
    const base = {
      id: item.id,
      category: item.category,
      label: item.label,
      ...(item.detail ? { detail: item.detail } : {}),
      ...(item.secret ? { secret: true } : {}),
    };
    if (item.status === "skipped") {
      results.push({ ...base, status: "skipped", ...(item.reason ? { reason: item.reason } : {}) });
      continue;
    }
    if (excluded.has(item.id)) {
      results.push({ ...base, status: "skipped", reason: "Left out." });
      continue;
    }
    try {
      const verdict = await run.item(item);
      if (verdict.ok) {
        results.push({
          ...base,
          status: options.dryRun ? "ready" : "imported",
          ...(verdict.note ? { reason: scrubSecrets(verdict.note, secrets) } : {}),
        });
      } else {
        results.push({ ...base, status: "skipped", reason: scrubSecrets(verdict.reason, secrets) });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ ...base, status: "failed", reason: scrubSecrets(message, secrets) });
    }
  }
  const count = (status: AgentImportItemResult["status"]) =>
    results.filter((result) => result.status === status).length;
  const result: AgentImportResult = {
    source: plan.source,
    home: plan.home,
    dryRun: options.dryRun,
    imported: count("imported"),
    ready: count("ready"),
    skipped: count("skipped"),
    failed: count("failed"),
    items: results,
  };
  // Counts only: item text can hold personal data and is never logged.
  logger.info(
    `${options.dryRun ? "Dry run of" : "Imported"} ${SOURCE_LABELS[plan.source]} home: ` +
      `${result.imported} imported, ${result.ready} ready, ${result.skipped} skipped, ${result.failed} failed`,
  );
  return result;
}
