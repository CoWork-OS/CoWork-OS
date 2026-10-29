import { TOOL_GROUPS, type ToolGroupName } from "./types";

/** A task's denied tools, parsed once: `*`, group names such as `group:memory`, or exact names. */
export interface ParsedToolRestrictions {
  denyAll: boolean;
  tools: Set<string>;
  groups: Set<ToolGroupName>;
}

export function parseToolRestrictions(restrictions?: readonly unknown[]): ParsedToolRestrictions {
  const parsed: ParsedToolRestrictions = { denyAll: false, tools: new Set(), groups: new Set() };
  for (const raw of restrictions || []) {
    const value = typeof raw === "string" ? raw.trim() : "";
    if (!value) continue;
    // Special marker meaning "deny all tools" (used as a safe default on corrupted policy data).
    if (value === "*") {
      parsed.denyAll = true;
      continue;
    }
    if (Object.prototype.hasOwnProperty.call(TOOL_GROUPS, value)) {
      parsed.groups.add(value as ToolGroupName);
    } else {
      parsed.tools.add(value);
    }
  }
  return parsed;
}

export function isToolDeniedByRestrictions(
  toolName: string,
  restrictions: ParsedToolRestrictions,
): boolean {
  if (restrictions.denyAll || restrictions.tools.has(toolName)) return true;
  for (const groupName of restrictions.groups) {
    const tools = TOOL_GROUPS[groupName] as readonly string[] | undefined;
    if (tools && tools.includes(toolName)) return true;
  }
  return false;
}
