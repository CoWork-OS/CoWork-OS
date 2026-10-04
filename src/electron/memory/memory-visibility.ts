/**
 * Which archive memories the agent may see, and which rows may claim to be imported.
 *
 * One policy for every agent read path (memory_recall's archive lane, prompt recall) and
 * for the FTS worker.
 * Deliberately free of runtime imports so the database worker can load it.
 */

export type MemoryPrivacyState = "normal" | "private" | "redacted" | "suppressed";

/**
 * Privacy states hidden from the agent. `suppressed` is an Inspector delete and
 * `redacted` a user redaction (or a stripped `<private>` block): the agent must not
 * read either, whatever filters the model asks for.
 */
export const AGENT_HIDDEN_PRIVACY_STATES: readonly MemoryPrivacyState[] = [
  "suppressed",
  "redacted",
];

/** Privacy states the local agent may read. `private` means "never leaves the device". */
export const AGENT_VISIBLE_PRIVACY_STATES: readonly MemoryPrivacyState[] = ["normal", "private"];

export function isAgentVisiblePrivacyState(state: string | null | undefined): boolean {
  return !AGENT_HIDDEN_PRIVACY_STATES.includes((state || "normal") as MemoryPrivacyState);
}

/**
 * Narrow model-supplied privacy filters to the agent-visible states. A request for only
 * hidden states yields the visible default rather than an unfiltered search.
 */
export function sanitizeAgentPrivacyStates(states: unknown): MemoryPrivacyState[] {
  const requested = Array.isArray(states)
    ? states.filter((state): state is MemoryPrivacyState =>
        AGENT_VISIBLE_PRIVACY_STATES.includes(state as MemoryPrivacyState),
      )
    : [];
  return requested.length > 0 ? Array.from(new Set(requested)) : [...AGENT_VISIBLE_PRIVACY_STATES];
}

/**
 * SQL predicate keeping memories whose observation is not suppressed or redacted.
 * `idExpr` is the memories id column of the enclosing query (for example `m.id`).
 */
export function buildAgentVisibleMemorySql(idExpr: string): string {
  const states = AGENT_HIDDEN_PRIVACY_STATES.map((state) => `'${state}'`).join(", ");
  return `NOT EXISTS (SELECT 1 FROM memory_observation_metadata om_vis WHERE om_vis.memory_id = ${idExpr} AND om_vis.privacy_state IN (${states}))`;
}

const PRIVACY_RANK: Record<MemoryPrivacyState, number> = {
  normal: 0,
  private: 1,
  redacted: 2,
  suppressed: 3,
};

/** The more restrictive of two privacy states, so a regenerated row never loses one. */
export function stricterPrivacyState(
  current: string | null | undefined,
  next: string | null | undefined,
): MemoryPrivacyState {
  const a = (current && current in PRIVACY_RANK ? current : "normal") as MemoryPrivacyState;
  const b = (next && next in PRIVACY_RANK ? next : "normal") as MemoryPrivacyState;
  return PRIVACY_RANK[a] >= PRIVACY_RANK[b] ? a : b;
}

// Content prefixes that make a memory "imported" (global across workspaces) or mark an
// imported row as prompt-recall ignored. See `buildImportedMemoryFilterSql`.
const RESERVED_IMPORT_PREFIX = /^\s*(?:\[imported from |\[cowork:prompt_recall=ignore\])/i;

/**
 * Only real importers may create rows that look imported: imported rows are searched
 * across every workspace, so a model-written `[Imported from …]` would leak its text
 * everywhere. Non-import captures get a neutral marker in front of a reserved prefix.
 */
export function neutralizeReservedImportPrefix(content: string): string {
  return RESERVED_IMPORT_PREFIX.test(content) ? `(saved) ${content.trimStart()}` : content;
}

/** Whether `content` reads as an imported row (global across workspaces). */
export function hasReservedImportPrefix(content: string | null | undefined): boolean {
  return typeof content === "string" && RESERVED_IMPORT_PREFIX.test(content);
}
