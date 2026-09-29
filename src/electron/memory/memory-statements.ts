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
  // ChatGPTImporter: conversations already imported into a workspace
  chatgpt_importedContents: `SELECT content
             FROM memories
             WHERE workspace_id = ?
               AND (
                 content LIKE '[Imported from ChatGPT %'
                 OR content LIKE '[cowork:prompt_recall=ignore]%[Imported from ChatGPT %'
               )
             LIMIT 100000`,
  // TranscriptStore
  transcript_indexSpan: `INSERT OR IGNORE INTO transcript_spans (
          id, workspace_path, task_id, timestamp, type, payload_json,
          event_id, seq, raw_line, search_text, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  transcript_searchSpans: `SELECT s.task_id, s.timestamp, s.type, s.payload_json, s.event_id, s.seq, s.raw_line
           FROM transcript_spans_fts f
           JOIN transcript_spans s ON s.rowid = f.rowid
           WHERE transcript_spans_fts MATCH ?
             AND s.workspace_path = ?
             AND (? IS NULL OR s.task_id = ?)
           ORDER BY bm25(transcript_spans_fts), s.timestamp DESC
           LIMIT ?`,
} satisfies StatementCatalog;

export type MemoryStatementName = keyof typeof MEMORY_STATEMENTS;
