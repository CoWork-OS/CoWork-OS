import { z } from "zod";
import type { BotDesktopNetwork, BotWorksOn, ComputerToolKind } from "./bot-computer";
import type { BotFileAccess } from "./bot-containment";
import type { ExplicitConsentKind } from "./explicit-consent";
import type { BotWorkPage, IntegrationMentionSource } from "./types";

/**
 * "What it can do" in a bot's details panel: a read-only summary of the bot's live
 * configuration, derived in the main process from the same checks that enforce it.
 */
export const botCapabilitiesRequestSchema = z
  .object({
    workspaceId: z.string().trim().min(1).max(256),
    agentRoleId: z.string().trim().min(1).max(128),
  })
  .strict();
export type BotCapabilitiesRequest = z.infer<typeof botCapabilitiesRequestSchema>;

/**
 * Whether the bot's tasks may use a connected service.
 * - yes: in every run
 * - chats_you_start_only: refused in runs nobody started by hand (its own folder)
 * - denied_for_bot: the bot's denied tools cover it
 * - not_in_computer_mode: refused while its work runs in a task computer
 * - not_with_works_on: its "Works on" setting takes it away
 */
export type BotServiceUse =
  | "yes"
  | "chats_you_start_only"
  | "denied_for_bot"
  | "not_in_computer_mode"
  | "not_with_works_on";

export interface BotServiceCapability {
  id: string;
  label: string;
  source: IntegrationMentionSource;
  connected: boolean;
  use: BotServiceUse;
  /** Some of the service's tools are refused for this bot, the rest work. */
  limited: boolean;
}

export interface BotLinkedChannel {
  id: string;
  label: string;
  /** default: the channel hands its messages to this bot; allowed: one of the bots it may use. */
  link: "default" | "allowed";
}

export type BotCapabilitySection = "services" | "schedules" | "memory" | "safeguards";

export interface BotCapabilitySummary {
  workspaceId: string;
  agentRoleId: string;
  where: {
    worksOn: BotWorksOn;
    /** Which computers its tools may act on (this Mac, the in-app browser, its own desktop, a take-over request). */
    reach: Record<ComputerToolKind, boolean>;
    /** Set when it works on its own desktop. */
    desktop?: { host?: string; group?: string; network: BotDesktopNetwork };
    /** Set when all its work runs in a task computer. */
    computer?: { backend: "bot-desktop" | "cua"; lifetime: "task" | "persistent" };
  };
  files: {
    fileAccess: BotFileAccess;
    /** Where runs nobody started by hand work. */
    onItsOwn: "own_folder" | "desktop_folder" | "workspace";
  };
  services: { items: BotServiceCapability[]; channels: BotLinkedChannel[] };
  schedules: {
    runtime: BotWorkPage["scheduleRuntime"];
    scheduled: number;
    nextRunAt?: number;
    responsibilities: { active: number; paused: number };
    checkIns: { enabled: boolean; everyMinutes?: number; nextAt?: number };
  };
  memory: { available: boolean; saved: number; recallPastChats: boolean };
  safeguards: {
    /** The bot's "May do alone" limit; no id means no limit. */
    mayDoAlone: { id?: string; label: string };
    /** In chats you start, a step that needs your OK asks you, or is refused when its access never asks. */
    inChats: "asks" | "refuses";
    needsOk: readonly ExplicitConsentKind[];
    deniedTools: string[];
    denyAll: boolean;
  };
  /** Sections whose reads failed; they hold defaults and are shown as unavailable. */
  partial: BotCapabilitySection[];
}

/** Plain words for each reason a step needs your OK. */
export const EXPLICIT_CONSENT_LABELS: Record<ExplicitConsentKind, string> = {
  dangerous_shell: "risky commands like rm or killall",
  risk_gate: "steps flagged as risky",
  delete: "deleting files or memories",
  data_export: "sending files or data out",
  external_service: "actions in connected apps and services",
  location: "reading your location",
  protected_credential: "using saved credentials",
  app_action: "actions in connected apps and services",
  voice_call: "phone calls",
  unconfigured_connector: "actions in connected apps and services",
};
