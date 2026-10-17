/**
 * What an import of a Hermes or OpenClaw home would bring over.
 *
 * The readers (hermes-reader.ts, openclaw-reader.ts) build a plan from files on disk and
 * write nothing; the applier (apply.ts) writes it through CoWork's own managers. A plan
 * item carries its payload in the main process only: the renderer and the CLI see the
 * preview (`toPreview`), which never holds a secret value.
 */

import type {
  AgentImportCategory,
  AgentImportPreview,
  AgentImportPreviewItem,
  AgentImportSource,
} from "../../shared/types";

/** Providers an import can carry a key or a model choice to. */
export const IMPORT_PROVIDER_IDS = [
  "openrouter",
  "anthropic",
  "openai",
  "gemini",
  "deepseek",
  "groq",
  "xai",
  "kimi",
] as const;
export type ImportProviderId = (typeof IMPORT_PROVIDER_IDS)[number];

export const IMPORT_PROVIDER_LABELS: Record<ImportProviderId, string> = {
  openrouter: "OpenRouter",
  anthropic: "Anthropic",
  openai: "OpenAI",
  gemini: "Gemini",
  deepseek: "DeepSeek",
  groq: "Groq",
  xai: "xAI",
  kimi: "Kimi",
};

export type ImportChannelType = "telegram" | "discord" | "slack";

export type ImportSchedule =
  | { kind: "cron"; expr: string; tz?: string }
  | { kind: "every"; everyMs: number }
  | { kind: "at"; atMs: number };

export type ImportPayload =
  | { kind: "persona"; text: string }
  /** Short curated facts; `user` facts go to me.md, `agent` notes to the agent's notes. */
  | { kind: "memory_entries"; target: "user" | "agent"; entries: string[] }
  /** Long or dated notes: they land in the inbox for the user to review. */
  | { kind: "memory_inbox"; label: string; entries: Array<{ text: string; added?: string }> }
  | { kind: "skill"; bundleDir: string; name: string }
  /** `value` is present only when secrets were opted in. */
  | { kind: "provider_key"; provider: ImportProviderId; value?: string }
  | { kind: "model"; provider: ImportProviderId; model?: string }
  | {
      kind: "channel";
      channel: ImportChannelType;
      allowedUsers: string[];
      /** Present only when secrets were opted in. */
      tokens?: { botToken: string; appToken?: string };
    }
  | { kind: "command_rule"; prefix: string }
  | { kind: "scheduled_task"; name: string; prompt: string; schedule: ImportSchedule }
  | { kind: "workspace_instructions"; text: string }
  | { kind: "none" };

export interface PlannedImportItem extends AgentImportPreviewItem {
  payload: ImportPayload;
}

export interface ImportPlan {
  source: AgentImportSource;
  home: string;
  found: boolean;
  withSecrets: boolean;
  items: PlannedImportItem[];
}

export const SECRETS_OPT_IN_REASON = "Credentials are left out unless you include them.";

export function readyItem(
  id: string,
  category: AgentImportCategory,
  label: string,
  payload: ImportPayload,
  extra: { detail?: string; secret?: boolean } = {},
): PlannedImportItem {
  return {
    id,
    category,
    label,
    ...(extra.detail ? { detail: extra.detail } : {}),
    secret: extra.secret === true,
    status: "ready",
    payload,
  };
}

export function skippedItem(
  id: string,
  category: AgentImportCategory,
  label: string,
  reason: string,
  extra: { detail?: string; secret?: boolean } = {},
): PlannedImportItem {
  return {
    id,
    category,
    label,
    ...(extra.detail ? { detail: extra.detail } : {}),
    secret: extra.secret === true,
    status: "skipped",
    reason,
    payload: { kind: "none" },
  };
}

/**
 * A secret item: ready with its value when secrets are opted in, otherwise skipped with
 * the opt-in reason and no value kept.
 */
export function secretItem(
  withSecrets: boolean,
  id: string,
  category: AgentImportCategory,
  label: string,
  payload: () => ImportPayload,
  detail?: string,
): PlannedImportItem {
  return withSecrets
    ? readyItem(id, category, label, payload(), { detail, secret: true })
    : skippedItem(id, category, label, SECRETS_OPT_IN_REASON, { detail, secret: true });
}

/** The plan without payloads, for the renderer and the CLI. */
export function toPreview(plan: ImportPlan): AgentImportPreview {
  return {
    source: plan.source,
    home: plan.home,
    found: plan.found,
    withSecrets: plan.withSecrets,
    items: plan.items.map(({ payload: _payload, ...item }) => item),
  };
}

/** Every secret value a plan holds, so error text can be scrubbed before it is shown. */
export function planSecretValues(plan: ImportPlan): string[] {
  const values: string[] = [];
  for (const item of plan.items) {
    const payload = item.payload;
    if (payload.kind === "provider_key" && payload.value) values.push(payload.value);
    if (payload.kind === "channel" && payload.tokens) {
      values.push(payload.tokens.botToken);
      if (payload.tokens.appToken) values.push(payload.tokens.appToken);
    }
  }
  return values.filter((value) => value.length >= 4);
}

export function scrubSecrets(text: string, secrets: readonly string[]): string {
  let out = text;
  for (const secret of secrets) out = out.split(secret).join("[redacted]");
  return out;
}

/** Split a comma- or whitespace-separated id list (`TELEGRAM_ALLOWED_USERS`). */
export function splitIdList(value: unknown): string[] {
  const raw = Array.isArray(value)
    ? value.map((entry) => String(entry ?? ""))
    : [String(value ?? "")];
  return Array.from(
    new Set(
      raw
        .flatMap((entry) => entry.split(/[\s,]+/))
        .map((entry) => entry.trim())
        .filter((entry) => entry.length > 0 && entry !== "*"),
    ),
  );
}
