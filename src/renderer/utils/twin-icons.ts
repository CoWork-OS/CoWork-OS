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
import { getEmojiIcon } from "./emoji-icon-map";

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

/**
 * Resolve twin icon string to a Lucide React component.
 * Supports Lucide icon keys (e.g. "Laptop", "Bot") and legacy emoji for backward compatibility.
 */
export function resolveTwinIcon(icon: string | undefined): ComponentType<LucideProps> {
  if (!icon) return BotGlyph;
  const key = icon as TwinIconKey;
  if (LUCIDE_TWIN_ICONS[key]) return LUCIDE_TWIN_ICONS[key];
  return getEmojiIcon(icon);
}
