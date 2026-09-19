import Database from "better-sqlite3";
import { AgentRole, AgentTeam } from "../../shared/types";
import { AgentRoleRepository } from "./AgentRoleRepository";
import { AgentTeamMemberRepository } from "./AgentTeamMemberRepository";
import { AgentTeamRepository } from "./AgentTeamRepository";

/** The reserved team name used by the built-in Grok-style bot roster. */
export const DEFAULT_BOT_TEAM_NAME = "CoWork Bot Team";

export interface BotTeamDefinition {
  /** Stable role name used for new installs. */
  name: string;
  displayName: string;
  description: string;
  icon: string;
  color: string;
  capabilities: AgentRole["capabilities"];
  autonomyLevel: NonNullable<AgentRole["autonomyLevel"]>;
  sortOrder: number;
  aliases?: string[];
}

/**
 * A small, deliberately opinionated roster. The roles are ordinary custom
 * roles, so users can edit or remove them, while the team itself gives their
 * bot conversations a safe place to collaborate.
 */
export const DEFAULT_BOT_TEAM_DEFINITIONS: readonly BotTeamDefinition[] = [
  {
    name: "atlas-your-chief-of-staff",
    displayName: "Atlas — Your Chief of Staff",
    description: "Coordinates priorities and delegates work across the CoWork bot team.",
    icon: "Bot",
    color: "#6366f1",
    capabilities: ["manage", "plan", "communicate", "product"],
    autonomyLevel: "lead",
    sortOrder: 10,
    aliases: ["chief-of-staff", "atlas"],
  },
  {
    name: "forge",
    displayName: "Forge — CoWork OS Product Engineer",
    description: "Turns product decisions into reliable, tested implementation work.",
    icon: "Wrench",
    color: "#f97316",
    capabilities: ["code", "test", "review", "product"],
    autonomyLevel: "specialist",
    sortOrder: 20,
  },
  {
    name: "scribe",
    displayName: "Scribe — Author and Publisher",
    description: "Researches, writes, and polishes documentation and public-facing content.",
    icon: "FileEdit",
    color: "#ec4899",
    capabilities: ["write", "document", "research", "communicate"],
    autonomyLevel: "specialist",
    sortOrder: 30,
  },
  {
    name: "exec",
    displayName: "Exec",
    description: "Frames decisions, risks, and an executable plan for the team.",
    icon: "ClipboardList",
    color: "#8b5cf6",
    capabilities: ["manage", "plan", "analyze", "product"],
    autonomyLevel: "lead",
    sortOrder: 40,
  },
  {
    name: "chief-community-officer",
    displayName: "Chief Community Officer",
    description: "Owns community feedback, support patterns, and growth conversations.",
    icon: "Target",
    color: "#14b8a6",
    capabilities: ["communicate", "market", "research", "analyze"],
    autonomyLevel: "specialist",
    sortOrder: 50,
  },
  {
    name: "product-engineer",
    displayName: "Product Engineer",
    description: "Investigates technical trade-offs and helps ship focused product changes.",
    icon: "Laptop",
    color: "#22c55e",
    capabilities: ["code", "design", "product", "review"],
    autonomyLevel: "specialist",
    sortOrder: 60,
  },
];

const COLLABORATION_MARKER = "[CoWork bot team collaboration]";

function collaborationPrompt(role: BotTeamDefinition): string {
  const leadGuidance =
    role.name === "atlas-your-chief-of-staff" || role.autonomyLevel === "lead"
      ? "You may delegate focused work to teammates with send_agent_message using the bot selector, then incorporate their replies into your answer."
      : "When the lead bot or another teammate sends you a request, do the focused work, state evidence and blockers, and send a concise result back with send_agent_message using bot=atlas.";
  return [
    COLLABORATION_MARKER,
    `You are ${role.displayName}, a persistent member of the CoWork Bot Team.`,
    "Your bot conversation is a durable shared workspace channel, not a one-off task.",
    leadGuidance,
    "Never claim that a teammate completed work unless you have received a durable message or visible result from that teammate.",
  ].join("\n");
}

function roleMatchesDefinition(role: AgentRole, definition: BotTeamDefinition): boolean {
  const roleValues = [role.name, role.displayName]
    .filter(Boolean)
    .map((value) => value.toLowerCase().trim());
  const definitionValues = [definition.name, definition.displayName, ...(definition.aliases || [])]
    .filter(Boolean)
    .map((value) => value.toLowerCase().trim());
  return definitionValues.some((value) => roleValues.includes(value));
}

function findRoleForDefinition(
  roleRepo: AgentRoleRepository,
  definition: BotTeamDefinition,
): AgentRole | undefined {
  const exact = roleRepo.findByName(definition.name);
  if (exact) return exact;
  const aliases = new Set([definition.displayName.toLowerCase(), ...(definition.aliases || [])]);
  return roleRepo
    .findAll(true)
    .find(
      (role) =>
        roleMatchesDefinition(role, definition) ||
        aliases.has(role.name.toLowerCase()) ||
        aliases.has(role.displayName.toLowerCase()),
    );
}

/** Ensure the roster exists without overwriting user-edited role metadata. */
export function ensureDefaultBotRoles(db: Database.Database): AgentRole[] {
  const roleRepo = new AgentRoleRepository(db);
  const roles: AgentRole[] = [];

  for (const definition of DEFAULT_BOT_TEAM_DEFINITIONS) {
    let role = findRoleForDefinition(roleRepo, definition);
    if (!role) {
      role = roleRepo.create({
        name: definition.name,
        displayName: definition.displayName,
        description: definition.description,
        icon: definition.icon,
        color: definition.color,
        capabilities: definition.capabilities,
        autonomyLevel: definition.autonomyLevel,
        systemPrompt: collaborationPrompt(definition),
      });
      role = roleRepo.update({ id: role.id, sortOrder: definition.sortOrder }) || role;
    } else if (!role.isSystem) {
      const hasCollaborationPrompt = role.systemPrompt?.includes(COLLABORATION_MARKER) === true;
      const needsCollaborationPrompt =
        !hasCollaborationPrompt ||
        (definition.name !== "atlas-your-chief-of-staff" &&
          role.autonomyLevel !== "lead" &&
          !role.systemPrompt?.includes("bot=atlas"));
      const hasAtlasSelfRouting =
        definition.name === "atlas-your-chief-of-staff" &&
        role.systemPrompt?.includes("Use send_agent_message with bot=atlas");
      if (!needsCollaborationPrompt && !hasAtlasSelfRouting) {
        roles.push(role);
        continue;
      }
      // Preserve the user's prompt and add only the team contract needed for
      // peer messaging. This is intentionally additive and idempotent.
      const cleanedPrompt = (role.systemPrompt || "")
        .split("\n")
        .filter(
          (line) => line.trim() !== "Use send_agent_message with bot=atlas to return your result.",
        )
        .join("\n")
        .trim();
      const nextPrompt = hasCollaborationPrompt
        ? needsCollaborationPrompt
          ? `${cleanedPrompt}\nUse send_agent_message with bot=atlas to return your result.`
          : cleanedPrompt
        : [cleanedPrompt, collaborationPrompt(definition)].filter(Boolean).join("\n\n");
      role = roleRepo.update({ id: role.id, systemPrompt: nextPrompt }) || role;
    }
    roles.push(role);
  }

  return roles;
}

/**
 * Ensure a single persistent team for the requested workspace and attach the
 * whole seeded roster. Teams remain workspace-scoped, while roles are global.
 */
export function ensureDefaultBotTeam(
  db: Database.Database,
  workspaceId: string,
): { team: AgentTeam; roles: AgentRole[] } | undefined {
  const normalizedWorkspaceId = String(workspaceId || "").trim();
  if (!normalizedWorkspaceId) return undefined;

  const roles = ensureDefaultBotRoles(db);
  const lead = roles.find((role) => role.name === "atlas-your-chief-of-staff") || roles[0];
  if (!lead) return undefined;

  const teamRepo = new AgentTeamRepository(db);
  const memberRepo = new AgentTeamMemberRepository(db);
  let team = teamRepo.findByName(normalizedWorkspaceId, DEFAULT_BOT_TEAM_NAME);
  if (!team) {
    team = teamRepo.create({
      workspaceId: normalizedWorkspaceId,
      name: DEFAULT_BOT_TEAM_NAME,
      description:
        "Persistent bot conversations that can delegate focused work and exchange durable updates.",
      leadAgentRoleId: lead.id,
      maxParallelAgents: Math.max(2, roles.length),
      persistent: true,
      defaultWorkspaceId: normalizedWorkspaceId,
    });
  } else if (
    !team.persistent ||
    team.leadAgentRoleId !== lead.id ||
    team.defaultWorkspaceId !== normalizedWorkspaceId
  ) {
    team =
      teamRepo.update({
        id: team.id,
        leadAgentRoleId: lead.id,
        persistent: true,
        defaultWorkspaceId: normalizedWorkspaceId,
      }) || team;
  }

  roles.forEach((role, index) => {
    memberRepo.add({
      teamId: team!.id,
      agentRoleId: role.id,
      memberOrder: (index + 1) * 10,
      isRequired: role.id === lead.id,
    });
  });

  return { team, roles };
}

export function isDefaultBotTeamRole(roleId: string, roster: AgentRole[]): boolean {
  return roster.some((role) => role.id === roleId);
}
