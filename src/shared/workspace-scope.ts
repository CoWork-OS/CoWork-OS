/**
 * What a conversation can reach, for the Workspace section of the right panel: the
 * connectors it may call and the skills it may apply, with the ones it has used so far
 * marked. Shown from the start so the user sees the scope before anything runs.
 */

export type WorkspaceScopeConnectorInput = {
  id: string;
  name: string;
  icon: string;
  status: string;
  tools: string[];
};

export type WorkspaceScopeSkillInput = { id: string; name: string; icon: string };

export type WorkspaceScopeConnector = {
  id: string;
  name: string;
  icon: string;
  used: boolean;
};

export type WorkspaceScope = {
  /** Connected connectors this conversation may call, used ones first. */
  connectors: WorkspaceScopeConnector[];
  /** Skills applied so far, in the order first used. */
  usedSkills: string[];
  /** Enabled skills not used yet. */
  otherSkillCount: number;
};

function skillKey(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[-_\s]+/g, " ");
}

export function buildWorkspaceScope(input: {
  connectors: readonly WorkspaceScopeConnectorInput[];
  skills: readonly WorkspaceScopeSkillInput[];
  usedToolNames: ReadonlySet<string>;
  usedSkills: readonly string[];
  /** The task's tool allow-list; when set, a connector counts only if one of its tools is on it. */
  allowedTools?: readonly string[];
}): WorkspaceScope {
  const allowed = input.allowedTools?.length ? new Set(input.allowedTools) : null;
  const connectors = input.connectors
    .filter((connector) => connector.status === "connected")
    .filter((connector) => !allowed || connector.tools.some((tool) => allowed.has(tool)))
    .map((connector) => ({
      id: connector.id,
      name: connector.name,
      icon: connector.icon,
      used: connector.tools.some((tool) => input.usedToolNames.has(tool)),
    }))
    .sort((a, b) => Number(b.used) - Number(a.used) || a.name.localeCompare(b.name));

  const usedKeys = new Set(input.usedSkills.map(skillKey));
  const otherSkillCount = input.skills.filter(
    (skill) => !usedKeys.has(skillKey(skill.name)) && !usedKeys.has(skillKey(skill.id)),
  ).length;

  return { connectors, usedSkills: [...input.usedSkills], otherSkillCount };
}
