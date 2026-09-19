/**
 * Presentation helpers for sub-agent lifecycle rows in the transcript.
 *
 * The transcript shows a generic "Created an agent" headline plus a muted
 * one-line recap naming the agent and previewing the instructions it was given,
 * then a single roster line once a burst of agents is running. Both the main
 * process (which stamps the preview into the event payload) and the renderer
 * (which formats the lines) read these helpers, so they live in shared.
 */

import type { WorkerRoleKind } from "./types";

/**
 * The closed vocabulary of sub-agent call-signs. Only a trailing parenthetical
 * drawn from this list counts as a call-sign, so a task title that merely ends
 * in brackets — "Audit deps (npm, yarn)" — keeps them.
 */
export const SUBAGENT_CALLSIGNS = [
  "agent",
  "builder",
  "designer",
  "explorer",
  "inspector",
  "planner",
  "synthesizer",
  "writer",
] as const;

export type SubagentCallsign = (typeof SUBAGENT_CALLSIGNS)[number];

const CALLSIGN_LOOKUP = new Set<string>(SUBAGENT_CALLSIGNS);

/** Short call-sign appended after a sub-agent's name, e.g. "Anansi (explorer)". */
export const WORKER_ROLE_CALLSIGN: Record<WorkerRoleKind, SubagentCallsign> = {
  researcher: "explorer",
  implementer: "builder",
  verifier: "inspector",
  synthesizer: "synthesizer",
};

/** Instructions are recapped on one line, so the stored preview stays short. */
export const SPAWN_INSTRUCTIONS_PREVIEW_LIMIT = 400;

const ROLE_SUFFIX_REGEX = /\s*\(([^()]+)\)\s*$/;

/** True only when the trailing parenthetical is a known call-sign. */
function hasCallsignSuffix(value: string): boolean {
  const match = ROLE_SUFFIX_REGEX.exec(value);
  return match ? CALLSIGN_LOOKUP.has(match[1].trim().toLowerCase()) : false;
}

function collapseWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

/** Collapse a delegated prompt into the single-line preview stored on the event. */
export function buildSpawnInstructionsPreview(
  prompt: unknown,
  limit: number = SPAWN_INSTRUCTIONS_PREVIEW_LIMIT,
): string {
  if (typeof prompt !== "string") return "";
  const normalized = collapseWhitespace(prompt);
  if (normalized.length <= limit) return normalized;
  return `${normalized.slice(0, limit).trimEnd()}…`;
}

/**
 * Name a spawned agent as "Title (call-sign)". Titles that already carry a
 * parenthesised call-sign (collaborative runs name agents that way) are left
 * alone so the suffix is never doubled.
 */
export function formatSpawnedAgentLabel(input: {
  title?: unknown;
  workerRole?: unknown;
  /** Used when the event carries no title — "an agent" when creating, "the agent" after. */
  fallback?: string;
}): string {
  const title = collapseWhitespace(typeof input.title === "string" ? input.title : "");
  if (!title) return input.fallback ?? "an agent";
  if (hasCallsignSuffix(title)) return title;
  const workerRole = typeof input.workerRole === "string" ? input.workerRole : "";
  const callsign = WORKER_ROLE_CALLSIGN[workerRole as WorkerRoleKind];
  return callsign ? `${title} (${callsign})` : title;
}

/** Drop the "(explorer)" suffix so roster lines read as bare names. */
export function stripAgentRoleSuffix(label: string): string {
  if (!hasCallsignSuffix(label)) return collapseWhitespace(label);
  return collapseWhitespace(label.replace(ROLE_SUFFIX_REGEX, "")) || collapseWhitespace(label);
}

/**
 * The muted recap under "Created an agent":
 * `Created Anansi (explorer) with the instructions: <preview>`.
 */
export function formatSpawnRecapLine(input: {
  label: string;
  instructions?: string;
  pending?: boolean;
}): string {
  const verb = input.pending ? "Creating" : "Created";
  const instructions = collapseWhitespace(input.instructions || "");
  if (!instructions) return `${verb} ${input.label}`;
  return `${verb} ${input.label} with the instructions: ${instructions}`;
}

export type AgentRosterState = "working" | "finished";

/** "Anansi, Ares and 2 more" — first two names, then a count. */
export function formatAgentNameList(names: string[], maxNamed: number = 2): string {
  const cleaned = names.map((name) => collapseWhitespace(name)).filter(Boolean);
  if (cleaned.length === 0) return "";
  if (cleaned.length <= maxNamed) {
    if (cleaned.length === 1) return cleaned[0];
    return `${cleaned.slice(0, -1).join(", ")} and ${cleaned[cleaned.length - 1]}`;
  }
  const remaining = cleaned.length - maxNamed;
  return `${cleaned.slice(0, maxNamed).join(", ")} and ${remaining} more`;
}

/** "Anansi, Ares and 2 more started working" / "… finished". */
export function formatAgentRosterLine(input: { names: string[]; state: AgentRosterState }): string {
  const list = formatAgentNameList(input.names);
  if (!list) return input.state === "finished" ? "Agents finished" : "Agents started working";
  return `${list} ${input.state === "finished" ? "finished" : "started working"}`;
}
