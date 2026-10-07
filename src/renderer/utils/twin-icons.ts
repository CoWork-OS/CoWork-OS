import type { ComponentType } from "react";
import {
  Laptop,
  Search,
  BookOpen,
  FlaskConical,
  FileEdit,
  ClipboardList,
  Palette,
  BarChart3,
  Hammer,
  Zap,
  Rocket,
  Wrench,
  Lightbulb,
  Target,
  Brain,
  type LucideProps,
} from "lucide-react";
import { BotGlyph } from "../components/BotGlyph";
import { MASCOT_CATALOG } from "../components/bot-mascot/mascot-catalog";
import { getMascotGlyph } from "../components/bot-mascot/mascot-glyph";
import { resolveBotMascot } from "../../shared/bot-mascots";

/** Lucide icon keys for twin icon picker. Matches PRESET_ICONS from AgentRoleEditor. */
export const TWIN_ICON_KEYS = [
  "Bot",
  "Laptop",
  "Search",
  "BookOpen",
  "FlaskConical",
  "FileEdit",
  "ClipboardList",
  "Palette",
  "BarChart3",
  "Hammer",
  "Zap",
  "Rocket",
  "Wrench",
  "Lightbulb",
  "Target",
  "Brain",
] as const;

export type TwinIconKey = (typeof TWIN_ICON_KEYS)[number];

export const LUCIDE_TWIN_ICONS: Record<TwinIconKey, ComponentType<LucideProps>> = {
  // The bot preset uses the shared Phosphor mark so it matches every other bot
  // icon in the app; the rest of the presets stay on lucide.
  Bot: BotGlyph,
  Laptop,
  Search,
  BookOpen,
  FlaskConical,
  FileEdit,
  ClipboardList,
  Palette,
  BarChart3,
  Hammer,
  Zap,
  Rocket,
  Wrench,
  Lightbulb,
  Target,
  Brain,
};

export function isTwinIconKey(icon: string | null | undefined): icon is TwinIconKey {
  return !!icon && (TWIN_ICON_KEYS as readonly string[]).includes(icon);
}

/**
 * Resolve a bot's icon value to a Lucide-compatible React component. Every bot is
 * drawn as its character: mascots (`mascot:<id>`) as chosen, and Lucide keys or
 * legacy emoji as the closest character (see `resolveBotMascot`).
 */
export function resolveTwinIcon(icon: string | undefined): ComponentType<LucideProps> {
  return getMascotGlyph(resolveBotMascot(icon));
}

/** Human-readable name for an icon value: the character the bot is drawn as. */
export function botIconLabel(icon: string | null | undefined): string {
  return MASCOT_CATALOG[resolveBotMascot(icon)].label;
}
