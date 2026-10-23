import { isValidSlashCommandName, normalizeSlashCommandName } from "../../shared/message-shortcuts";
import { isPackAllowed } from "../admin/policies";
import { PluginRegistry } from "../extensions/registry";
import { type CustomSkillLoader, getCustomSkillLoader } from "./custom-skill-loader";

/**
 * Resolve a slash command to a skill id. Tasks pass their workspace view of the loader so
 * the workspace's own skills resolve too.
 */
export function resolveSkillSlashAlias(
  commandName: string,
  loader: Pick<CustomSkillLoader, "getSkill"> = getCustomSkillLoader(),
): string | null {
  const name = normalizeSlashCommandName(commandName);
  if (!isValidSlashCommandName(name)) return null;

  const registry = PluginRegistry.getInstance();
  for (const plugin of registry.getPluginsByType("pack")) {
    if (plugin.state === "disabled" || !isPackAllowed(plugin.manifest.name)) continue;
    const slashCommands = plugin.manifest.slashCommands || [];
    const match = slashCommands.find((command) => normalizeSlashCommandName(command.name) === name);
    if (!match || !isValidSlashCommandName(match.skillId)) continue;

    const skill = loader.getSkill(match.skillId);
    if (!skill || skill.enabled === false) continue;

    const packSkill = (plugin.manifest.skills || []).find(
      (candidate) => candidate.id === match.skillId,
    );
    const directorySkill = (plugin.manifest.skillDirectories || []).find(
      (candidate) => candidate.id === match.skillId,
    );
    if (packSkill?.enabled === false || directorySkill?.enabled === false) continue;
    return match.skillId;
  }

  if (name === "review") return null;

  const directSkill = loader.getSkill(name);
  if (directSkill) return name;

  return null;
}
