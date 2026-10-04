/**
 * Which archive memories retention may remove (audit DATA-1).
 *
 * Retention honours the workspace's `retention_days` (and storage cap) only. Some rows are
 * never removed by retention or the storage cap, because deleting them loses something the
 * user cannot cheaply get back:
 *   - imported rows (a re-import pays the LLM again),
 *   - explicit saves (`memory_remember` / tool origin),
 *   - curated promotions (core-memory distiller rows, `system` origin).
 *
 * Playbook outcomes are no longer archive rows (they live in `playbook_entries`, audit
 * Phase 2 item 6), so they need no protection here; MemoryRetentionService prunes them.
 *
 * Deliberately free of runtime imports so the database worker can load it.
 */

/** Observation origins whose memories retention never removes. */
export const RETENTION_PROTECTED_ORIGINS = ["import", "tool", "system"] as const;

/** Content prefixes (after optional whitespace) of rows retention never removes. */
const PROTECTED_CONTENT_PREFIX_PATTERNS = [
  "[Imported from %",
  "[cowork:prompt_recall=ignore]%[Imported from %",
  "[core-trace:%",
] as const;

/**
 * SQL predicate that is true for memories retention must keep. `idExpr` and `contentExpr`
 * are the memories id and content columns of the enclosing query (for example `m.id`).
 */
export function buildRetentionProtectedMemorySql(idExpr: string, contentExpr: string): string {
  const prefixes = PROTECTED_CONTENT_PREFIX_PATTERNS.map(
    (pattern) => `${contentExpr} LIKE '${pattern}'`,
  ).join(" OR ");
  const origins = RETENTION_PROTECTED_ORIGINS.map((origin) => `'${origin}'`).join(", ");
  return `(${prefixes} OR EXISTS (SELECT 1 FROM memory_observation_metadata om_ret WHERE om_ret.memory_id = ${idExpr} AND om_ret.origin IN (${origins})))`;
}

/**
 * The time a memory was last useful: its creation, or its last reference (a search hit,
 * a prompt injection or a duplicate capture), whichever is later.
 */
export function buildMemoryLastActivitySql(alias = ""): string {
  const prefix = alias ? `${alias}.` : "";
  return `MAX(${prefix}created_at, COALESCE(${prefix}last_referenced_at, 0))`;
}
