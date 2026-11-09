import { buildRolePersonaPrompt } from "./role-persona";

export type DispatchRole = {
  displayName: string;
  description?: string | null;
  capabilities?: string[];
  systemPrompt?: string | null;
  soul?: string | null;
};

export type DispatchParentTask = {
  title: string;
  prompt: string;
};

export type DispatchPromptOptions = {
  planSummary?: string;
  workspacePath?: string | null;
  readGuard?: (candidatePath: string) => boolean;
  includeRoleProfile?: boolean;
  /**
   * When false, omit role description/systemPrompt from the dispatch prompt.
   * This is useful when the runtime already injects role context via system prompt.
   */
  includeRoleDetails?: boolean;
  /** Designated output directory for this agent to write files into. */
  fileOwnershipZone?: string;
  /** Other agents' output zones (read-only for this agent). */
  peerAgentZones?: Array<{ role: string; zone: string }>;
};

export const buildAgentDispatchPrompt = (
  role: DispatchRole,
  parentTask: DispatchParentTask,
  options?: DispatchPromptOptions,
): string => {
  const includeRoleDetails = options?.includeRoleDetails ?? true;
  const lines: string[] = [];

  const includeRoleProfile = options?.includeRoleProfile ?? true;
  if (includeRoleProfile) {
    const rolePersona = buildRolePersonaPrompt(role, options?.workspacePath, {
      includeDbFallback: true,
      readGuard: options?.readGuard,
    });
    if (rolePersona) {
      lines.push(rolePersona);
    }
  }

  if (includeRoleDetails) {
    lines.push(`You are ${role.displayName}${role.description ? ` — ${role.description}` : ""}.`);
  }

  if (includeRoleDetails && role.capabilities && role.capabilities.length > 0) {
    lines.push(`Capabilities: ${role.capabilities.join(", ")}`);
  }

  if (includeRoleDetails && role.systemPrompt) {
    lines.push("System guidance:");
    lines.push(role.systemPrompt);
  }

  if (options?.planSummary) {
    if (lines.length > 0) lines.push("");
    lines.push("Main agent plan summary (context only):");
    lines.push(options.planSummary);
  }

  if (lines.length > 0) lines.push("");
  lines.push(`Parent task: ${parentTask.title}`);
  lines.push("Request:");
  lines.push(parentTask.prompt);
  lines.push("");
  lines.push("Deliverables:");
  lines.push("- Provide a concise summary of your findings.");
  lines.push("- Call out risks or open questions.");
  lines.push("- Recommend next steps.");
  lines.push("");
  lines.push("AUTONOMOUS EXECUTION:");
  lines.push(
    "- You are a sub-agent without user interaction. NEVER ask questions or request decisions.",
  );
  lines.push(
    "- When a decision is needed, choose the most standard approach and state your rationale.",
  );
  lines.push("- Use safe defaults for any ambiguous parameters.");

  if (options?.fileOwnershipZone) {
    lines.push("");
    lines.push("FILE OWNERSHIP:");
    lines.push(`- Write output files under: ${options.fileOwnershipZone}/`);
    lines.push("- Do NOT write files to directories assigned to other agents.");
    if (options.peerAgentZones && options.peerAgentZones.length > 0) {
      lines.push("- Other agents' zones (read-only for you):");
      for (const peer of options.peerAgentZones) {
        lines.push(`  - ${peer.role}: ${peer.zone}/`);
      }
    }
  }

  return lines.join("\n");
};
