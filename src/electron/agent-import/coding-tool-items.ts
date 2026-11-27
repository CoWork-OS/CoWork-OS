/**
 * Plan items the Claude Code and Cursor readers share: skills folders, standing
 * instructions and shell allow rules.
 */

import { readyItem, skippedItem, type PlannedImportItem } from "./plan";
import {
  commandPrefixFromShellRule,
  countLinkedSkillDirs,
  findSkillBundles,
  looksLikeSecret,
  shortDescription,
} from "./source-files";

/** Response guidance shares the workspace instructions' budget. */
export const MAX_CUSTOM_INSTRUCTIONS_CHARS = 12_000;
const MAX_COMMAND_RULES = 500;

/** A rule's text for display: quoted parts and token-looking words are hidden. */
function displayRule(text: string): string {
  return text
    .replace(/"[^"]*"|'[^']*'/g, '"…"')
    .split(" ")
    .map((word) => (looksLikeSecret(word) ? "…" : word))
    .join(" ");
}

/** Every skill under each folder, once per name, plus a line for linked folders. */
export function skillFolderItems(
  dirs: readonly string[],
  sourceLabel: string,
): PlannedImportItem[] {
  const items: PlannedImportItem[] = [];
  const seen = new Set<string>();
  let linked = 0;
  for (const dir of dirs) {
    linked += countLinkedSkillDirs(dir);
    for (const skill of findSkillBundles(dir)) {
      const key = skill.name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      items.push(
        readyItem(
          `skill:${key}`,
          "skill",
          `Skill: ${skill.name}`,
          { kind: "skill", bundleDir: skill.dir, name: skill.name },
          { detail: shortDescription(skill.description) },
        ),
      );
    }
  }
  if (linked > 0) {
    // Linked skill folders point somewhere else (often another tool's skills); the
    // scanner never follows links, so the user imports them from where they live.
    items.push(
      skippedItem(
        "skill:linked",
        "skill",
        `${linked} linked ${linked === 1 ? "skill" : "skills"} in ${sourceLabel}`,
        "Linked from another folder; import them from where they live.",
      ),
    );
  }
  return items;
}

/** Standing guidance for every session (Settings > Personality > Response guidance). */
export function customInstructionsItem(
  id: string,
  label: string,
  raw: string | null,
): PlannedImportItem | null {
  const text = raw?.trim();
  if (!text) return null;
  if (text.length > MAX_CUSTOM_INSTRUCTIONS_CHARS) {
    return skippedItem(
      id,
      "custom_instructions",
      label,
      `${text.length} characters; CoWork's limit is ${MAX_CUSTOM_INSTRUCTIONS_CHARS}. Copy the parts you need into Settings > Personality.`,
    );
  }
  return readyItem(
    id,
    "custom_instructions",
    label,
    { kind: "custom_instructions", text },
    { detail: "Settings > Personality > Response guidance" },
  );
}

/**
 * Shell allow rules (`Bash(npm test:*)` in Claude Code, `Shell(git)` in Cursor) as
 * CoWork command rules. `wrapper` is the rule's tool name; other tools' rules are not
 * commands and are left out without a line.
 */
export function shellRuleItems(rules: unknown, wrapper: string): PlannedImportItem[] {
  if (!Array.isArray(rules)) return [];
  const items: PlannedImportItem[] = [];
  const prefixes = new Set<string>();
  const pattern = new RegExp(`^${wrapper}(?:\\((.*)\\))?$`, "s");
  for (const raw of rules.slice(0, MAX_COMMAND_RULES)) {
    if (typeof raw !== "string") continue;
    const match = pattern.exec(raw.trim());
    if (!match) continue;
    const inner = match[1] ?? "";
    const label = `Always allow: ${displayRule(inner.trim()) || "every command"}`;
    const id = `command:${raw.trim()}`;
    const mapped = commandPrefixFromShellRule(inner);
    if ("reason" in mapped) {
      items.push(skippedItem(id, "command_rule", label, mapped.reason));
      continue;
    }
    if (prefixes.has(mapped.prefix)) continue;
    prefixes.add(mapped.prefix);
    items.push(
      readyItem(
        id,
        "command_rule",
        label,
        { kind: "command_rule", prefix: mapped.prefix },
        { detail: `commands starting with "${mapped.prefix}"` },
      ),
    );
  }
  return items;
}
