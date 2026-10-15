/**
 * Lazily loaded channel adapters.
 *
 * The Teams (botbuilder), Discord (discord.js), Slack (Bolt), Telegram (grammY) and
 * WhatsApp (Baileys) adapters pull in about 12 MB of SDK code across ~1,900 module files.
 * Importing them statically made every app start read and compile all of it before the
 * first window, even with no channel configured. Their modules now load the first time a
 * channel of that type is created: call `loadChannelAdapterModule(type)` before using a
 * factory below.
 */
import type { TelegramAdapter, createTelegramAdapter as CreateTelegramAdapter } from "./telegram";
import type { DiscordAdapter } from "./discord";
import type { SlackAdapter } from "./slack";
import type { WhatsAppAdapter } from "./whatsapp";
import type { TeamsAdapter } from "./teams";
import type { DiscordConfig, SlackConfig, TeamsConfig, WhatsAppConfig } from "./types";

type TelegramModule = typeof import("./telegram");
type DiscordModule = typeof import("./discord");
type SlackModule = typeof import("./slack");
type WhatsAppModule = typeof import("./whatsapp");
type TeamsModule = typeof import("./teams");

const modules: {
  telegram?: TelegramModule;
  discord?: DiscordModule;
  slack?: SlackModule;
  whatsapp?: WhatsAppModule;
  teams?: TeamsModule;
} = {};

/** Load the adapter module for a channel type. Other channel types need no loading. */
export async function loadChannelAdapterModule(type: string): Promise<void> {
  switch (type) {
    case "telegram":
      modules.telegram ??= await import("./telegram");
      return;
    case "discord":
      modules.discord ??= await import("./discord");
      return;
    case "slack":
      modules.slack ??= await import("./slack");
      return;
    case "whatsapp":
      modules.whatsapp ??= await import("./whatsapp");
      return;
    case "teams":
      modules.teams ??= await import("./teams");
      return;
  }
}

function loaded<T>(module: T | undefined, type: string): T {
  if (!module) {
    throw new Error(`The ${type} channel adapter has not been loaded.`);
  }
  return module;
}

export function createTelegramAdapter(
  config: Parameters<typeof CreateTelegramAdapter>[0],
): TelegramAdapter {
  return loaded(modules.telegram, "telegram").createTelegramAdapter(config);
}

export function createDiscordAdapter(config: DiscordConfig): DiscordAdapter {
  return loaded(modules.discord, "discord").createDiscordAdapter(config);
}

export function createSlackAdapter(config: SlackConfig): SlackAdapter {
  return loaded(modules.slack, "slack").createSlackAdapter(config);
}

export function createWhatsAppAdapter(config: WhatsAppConfig): WhatsAppAdapter {
  return loaded(modules.whatsapp, "whatsapp").createWhatsAppAdapter(config);
}

export function createTeamsAdapter(config: TeamsConfig): TeamsAdapter {
  return loaded(modules.teams, "teams").createTeamsAdapter(config);
}

/** `instanceof TelegramAdapter` without loading grammY: no instance exists before its module. */
export function isTelegramAdapter(adapter: unknown): adapter is TelegramAdapter {
  return modules.telegram !== undefined && adapter instanceof modules.telegram.TelegramAdapter;
}
