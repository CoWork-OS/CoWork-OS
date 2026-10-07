/**
 * Illustrated bot mascots a bot can use as its icon. A bot stores the choice in
 * its `icon` field as `mascot:<id>`, next to the lucide keys and legacy emoji
 * that field already accepts.
 */
export const BOT_MASCOT_IDS = [
  "code",
  "research",
  "write",
  "plan",
  "browse",
  "analyze",
  "create",
  "automate",
  "assist",
  "learn",
  "collaborate",
  "organize",
  "search",
  "focus",
  "reason",
  "everything",
] as const;

export type BotMascotId = (typeof BOT_MASCOT_IDS)[number];

export const BOT_MASCOT_ICON_PREFIX = "mascot:";

const MASCOT_ID_SET: ReadonlySet<string> = new Set(BOT_MASCOT_IDS);

export function isBotMascotId(value: string): value is BotMascotId {
  return MASCOT_ID_SET.has(value);
}

/** The icon value that selects a mascot. */
export function botMascotIcon(id: BotMascotId): string {
  return `${BOT_MASCOT_ICON_PREFIX}${id}`;
}

/** The mascot an icon value selects, or `null` for lucide keys, emoji and unknown mascots. */
export function parseBotMascotIcon(icon: string | null | undefined): BotMascotId | null {
  if (!icon || !icon.startsWith(BOT_MASCOT_ICON_PREFIX)) return null;
  const id = icon.slice(BOT_MASCOT_ICON_PREFIX.length);
  return isBotMascotId(id) ? id : null;
}

/** Simple icon keys and legacy emoji, mapped to the character closest in meaning. */
const ICON_MASCOTS: Readonly<Record<string, BotMascotId>> = {
  Bot: "assist",
  Laptop: "code",
  Search: "search",
  BookOpen: "learn",
  FlaskConical: "research",
  FileEdit: "write",
  ClipboardList: "plan",
  Palette: "create",
  BarChart3: "analyze",
  Hammer: "automate",
  Zap: "automate",
  Rocket: "everything",
  Wrench: "automate",
  Lightbulb: "reason",
  Target: "focus",
  Brain: "reason",
  "🤖": "assist",
  "💻": "code",
  "🧑‍💻": "code",
  "🔍": "search",
  "🔎": "search",
  "🧪": "research",
  "📚": "learn",
  "📖": "learn",
  "📝": "write",
  "📋": "plan",
  "📅": "plan",
  "🎨": "create",
  "📈": "analyze",
  "🔧": "automate",
  "🛠": "automate",
  "⚡": "automate",
  "🚀": "everything",
  "💡": "reason",
  "🧠": "reason",
  "🎯": "focus",
  "🌐": "browse",
};

/** Text that picks a stable character for icons with no meaning of their own. */
function mascotFromText(text: string): BotMascotId {
  let hash = 0;
  for (const char of text) hash = (Math.imul(hash, 31) + (char.codePointAt(0) ?? 0)) >>> 0;
  return BOT_MASCOT_IDS[hash % BOT_MASCOT_IDS.length];
}

/**
 * The character a bot is drawn as. Every bot shows one: a chosen character wins,
 * simple icon keys and legacy emoji map to the closest character, and any other
 * value gets a stable character derived from it. Stored icons are not rewritten.
 */
export function resolveBotMascot(icon: string | null | undefined): BotMascotId {
  const chosen = parseBotMascotIcon(icon);
  if (chosen) return chosen;
  // Emoji arrive with or without the presentation selector.
  const value = (icon ?? "").replace(/️/g, "").trim();
  if (!value) return "assist";
  return ICON_MASCOTS[value] ?? EMOJI_MASCOTS.get(value) ?? mascotFromText(value);
}

/** Emoji stand-ins for surfaces that can only print text, like chat channels. */
const BOT_MASCOT_EMOJI: Record<BotMascotId, string> = {
  code: "💻",
  research: "🔬",
  write: "✍️",
  plan: "🗂️",
  browse: "🦊",
  analyze: "📊",
  create: "🌸",
  automate: "⚙️",
  assist: "💧",
  learn: "🌱",
  collaborate: "🤝",
  organize: "🗃️",
  search: "🪐",
  focus: "🐱",
  reason: "💎",
  everything: "♾️",
};

/** The text stand-ins read back, so a bot printed as an emoji keeps its character. */
const EMOJI_MASCOTS: ReadonlyMap<string, BotMascotId> = new Map(
  BOT_MASCOT_IDS.map((id) => [BOT_MASCOT_EMOJI[id].replace(/️/g, ""), id]),
);

/**
 * An icon value as plain text. Mascots become an emoji; anything else (emoji,
 * lucide keys) is returned unchanged, as text surfaces printed it before.
 */
export function botIconText(icon: string | null | undefined): string {
  const mascot = parseBotMascotIcon(icon);
  return mascot ? BOT_MASCOT_EMOJI[mascot] : (icon ?? "");
}
