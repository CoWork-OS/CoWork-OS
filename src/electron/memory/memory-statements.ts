import type { StatementCatalog } from "../database/statements/statement-catalog";

/**
 * Every SQL statement of the memory domain (async SQLite migration plan, DB6): memory
 * tiers, observations, dreaming, durable context, transcripts, the markdown index,
 * playbook evidence, the box brain and the knowledge graph. Services run these by name
 * through the memory statement port; names are prefixed by service. Multi-statement
 * transactions are units, in `memory-units.ts`.
 */
export const MEMORY_STATEMENTS = {
  // MemoryTierService
  tier_recordReference: `UPDATE memories
         SET reference_count = COALESCE(reference_count, 0) + 1,
             last_referenced_at = ?
         WHERE id = ?`,
  tier_recordReferenceBatch: `UPDATE memories
         SET reference_count = COALESCE(reference_count, 0) + 1,
             last_referenced_at = ?
         WHERE id IN (SELECT value FROM json_each(?))`,
  tier_getByTier: `SELECT id, content, COALESCE(reference_count, 0) AS reference_count, created_at
             FROM memories
             WHERE workspace_id = ?
               AND COALESCE(tier, 'short') = ?
             ORDER BY reference_count DESC, created_at DESC
             LIMIT ?`,
  // ChatGPTImporter: conversations already imported and visible in a workspace (its own
  // rows, and non-private imports of any workspace, which every workspace sees)
  chatgpt_importedContents: `SELECT content
             FROM memories
             WHERE (workspace_id = ? OR is_private = 0)
               AND (
                 content LIKE '[Imported from ChatGPT %'
                 OR content LIKE '[cowork:prompt_recall=ignore]%[Imported from ChatGPT %'
               )
             LIMIT 100000`,
  // MemoryService import sessions: imported rows visible in a workspace, for dedupe across
  // re-imports and workspaces (non-private imports are visible everywhere)
  import_visibleImportedContents: `SELECT content
             FROM memories
             WHERE (workspace_id = ? OR is_private = 0)
               AND (
                 content LIKE '[Imported from %'
                 OR content LIKE '[cowork:prompt_recall=ignore]%[Imported from %'
               )
             LIMIT 200000`,
  // TranscriptStore: legacy span rows, removed with their task until the migration ran
  transcript_workspacePaths: `SELECT path FROM workspaces`,
  transcript_taskRetention: `SELECT status, created_at FROM tasks WHERE id = ?`,
} satisfies StatementCatalog;

export type MemoryStatementName = keyof typeof MEMORY_STATEMENTS;
