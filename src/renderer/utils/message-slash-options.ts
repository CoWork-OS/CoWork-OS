import type { CustomSkill } from "../../shared/types";
import {
  MESSAGE_APP_SHORTCUTS,
  isValidSlashCommandName,
  type MessageAppShortcut,
} from "../../shared/message-shortcuts";
import { ONBOARDING_COMMAND_OPTIONS } from "../../shared/onboarding";

export const MESSAGE_SHORTCUTS_UPDATED_EVENT = "cowork:message-shortcuts-updated";

/** Tells open composers to reload their "/" commands after skills or packs change. */
export function announceMessageShortcutsChanged(): void {
  window.dispatchEvent(new Event(MESSAGE_SHORTCUTS_UPDATED_EVENT));
}

export type PluginSlashCommandAlias = {
  name: string;
  description?: string;
  skillId: string;
};

export type SkillSlashCommandOption = {
  kind: "skill";
  id: string;
  commandName: string;
  name: string;
  description: string;
  icon: string;
  hasRequiredParams: boolean;
  hasOptionalParams: boolean;
  skill: CustomSkill;
};

export type AppSlashCommandOption = {
  kind: "app";
  id: string;
  commandName: string;
  name: string;
  description: string;
  icon: string;
  shortcut: MessageAppShortcut;
};

export type BuiltinSlashCommandOption = {
  kind: "builtin";
  id: string;
  commandName: string;
  name: string;
  description: string;
  icon: string;
  command: string;
};

export type SlashCommandOption =
  | AppSlashCommandOption
  | SkillSlashCommandOption
  | BuiltinSlashCommandOption;

export type SlashCommandTextTarget = {
  start: number;
  end: number;
};

export function applySlashCommandSelection(params: {
  value: string;
  target: SlashCommandTextTarget;
  commandName: string;
}): { nextValue: string; cursorPosition: number } {
  const before = params.value.slice(0, params.target.start);
  const after = params.value.slice(params.target.end);
  const commandText = `/${params.commandName}`;
  if (/^[ \t]/.test(after)) {
    return {
      nextValue: `${before}${commandText}${after}`,
      cursorPosition: before.length + commandText.length + 1,
    };
  }
  const insertText = `${commandText} `;
  return {
    nextValue: `${before}${insertText}${after}`,
    cursorPosition: before.length + insertText.length,
  };
}

function skillHasRequiredParams(skill: CustomSkill): boolean {
  return skill.parameters?.some((parameter) => parameter.required === true) === true;
}

function skillHasOptionalParams(skill: CustomSkill): boolean {
  return skill.parameters?.some((parameter) => parameter.required !== true) === true;
}

export function buildMessageSlashOptions(params: {
  query: string;
  customSkills: CustomSkill[];
  pluginSlashCommands: PluginSlashCommandAlias[];
  includeOnboarding: boolean;
  limit?: number;
}): SlashCommandOption[] {
  const query = params.query.trim().toLowerCase();
  const limit = params.limit ?? 10;
  const skillById = new Map(params.customSkills.map((skill) => [skill.id, skill]));

  const appOptions: SlashCommandOption[] = MESSAGE_APP_SHORTCUTS.filter((shortcut) => {
    if (!query) return true;
    return `${shortcut.name} ${shortcut.description}`.toLowerCase().includes(query);
  }).map((shortcut) => ({
    kind: "app",
    id: `app-${shortcut.name}`,
    commandName: shortcut.name,
    name: shortcut.name,
    description: shortcut.description,
    icon: shortcut.icon,
    shortcut,
  }));

  const builtinOptions: SlashCommandOption[] = params.includeOnboarding
    ? ONBOARDING_COMMAND_OPTIONS.filter((option) => {
        if (!query) return true;
        return `${option.name} ${option.description}`.toLowerCase().includes(query);
      }).map((option) => ({
        kind: "builtin",
        id: `builtin-${option.name}`,
        commandName: option.name,
        name: option.name,
        description: option.description,
        icon: option.icon,
        command: `/${option.name}`,
      }))
    : [];

  const validPluginAliases = params.pluginSlashCommands
    .filter((command) => isValidSlashCommandName(command.name))
    .flatMap((command) => {
      const skill = skillById.get(command.skillId);
      if (!skill) return [];
      return [{ command, skill }];
    });

  const pluginAliasOptions: SlashCommandOption[] = validPluginAliases
    .flatMap(({ command, skill }) => {
      if (!query) return [{ command, skill }];
      const haystack =
        `${command.name} ${command.description || ""} ${skill.name} ${skill.description || ""}`.toLowerCase();
      return haystack.includes(query) ? [{ command, skill }] : [];
    })
    .slice(0, limit)
    .map(({ command, skill }) => ({
      kind: "skill",
      id: `alias-${command.name}`,
      commandName: command.name,
      name: command.name,
      description: command.description || skill.description || "",
      icon: skill.icon || "✨",
      hasRequiredParams: skillHasRequiredParams(skill),
      hasOptionalParams: skillHasOptionalParams(skill),
      skill,
    }));

  const aliasCommandNames = new Set(validPluginAliases.map(({ command }) => command.name));
  const aliasSkillIds = new Set(validPluginAliases.map(({ skill }) => skill.id));

  const skillOptions: SlashCommandOption[] = params.customSkills
    .filter((skill) => {
      if (
        !isValidSlashCommandName(skill.id) ||
        aliasCommandNames.has(skill.id) ||
        aliasSkillIds.has(skill.id)
      ) {
        return false;
      }
      if (!query) return true;
      return (
        skill.name.toLowerCase().includes(query) ||
        skill.id.toLowerCase().includes(query) ||
        (skill.description || "").toLowerCase().includes(query)
      );
    })
    .slice(0, limit)
    .map((skill) => ({
      kind: "skill",
      id: skill.id,
      commandName: skill.id,
      name: skill.id,
      description: skill.description || "",
      icon: skill.icon || "✨",
      hasRequiredParams: skillHasRequiredParams(skill),
      hasOptionalParams: skillHasOptionalParams(skill),
      skill,
    }));

  return [...appOptions, ...builtinOptions, ...pluginAliasOptions, ...skillOptions].slice(0, limit);
}

export function resolveSlashSelectedIndex(optionCount: number, requestedIndex: number): number {
  if (optionCount <= 0) return 0;
  return Math.min(Math.max(0, requestedIndex), optionCount - 1);
}
