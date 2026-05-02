import { isValidSlashCommandName, normalizeSlashCommandName } from "../../shared/message-shortcuts";
import { isPackAllowed } from "../admin/policies";
import { PluginRegistry } from "../extensions/registry";
import { getCustomSkillLoader } from "./custom-skill-loader";

export function resolveSkillSlashAlias(commandName: string): string | null {
  const name = normalizeSlashCommandName(commandName);
  if (!isValidSlashCommandName(name)) return null;

  const loader = getCustomSkillLoader();
  const registry = PluginRegistry.getInstance();
  for (const plugin of registry.getPluginsByType("pack")) {
    if (plugin.state === "disabled" || !isPackAllowed(plugin.manifest.name)) continue;
    const slashCommands = plugin.manifest.slashCommands || [];
    const match = slashCommands.find(
      (command) => normalizeSlashCommandName(command.name) === name,
    );
    if (!match || !isValidSlashCommandName(match.skillId)) continue;

    const skill = loader.getSkill(match.skillId);
    if (!skill || skill.enabled === false) continue;

    const packSkill = (plugin.manifest.skills || []).find((candidate) => candidate.id === match.skillId);
    if (packSkill?.enabled === false) continue;
    return match.skillId;
  }

  const directSkill = loader.getSkill(name);
  if (directSkill) return name;

  return null;
}
