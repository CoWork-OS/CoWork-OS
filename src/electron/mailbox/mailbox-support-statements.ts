import type { StatementCatalog } from "../database/statements/statement-catalog";

/**
 * Statements of the mailbox support services: agent search embeddings, forwarding scan
 * state and the automation registry. Part of the mailbox domain catalog (async SQLite
 * migration plan, DB6); names are prefixed by service.
 */
export const MAILBOX_SUPPORT_STATEMENTS = {
  // MailboxAgentSearchService
  search_upsertEmbeddingForPlainText_1: `SELECT source_text_hash FROM mailbox_search_embeddings WHERE record_type = ? AND record_id = ?`,
  search_upsertEmbeddingForPlainText_2: `INSERT INTO mailbox_search_embeddings
        (record_type, record_id, account_id, thread_id, message_id, attachment_id, source_text_hash, embedding_json, snippet, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(record_type, record_id) DO UPDATE SET
         account_id = excluded.account_id,
         thread_id = excluded.thread_id,
         message_id = excluded.message_id,
         attachment_id = excluded.attachment_id,
         source_text_hash = excluded.source_text_hash,
         embedding_json = excluded.embedding_json,
         snippet = excluded.snippet,
         updated_at = excluded.updated_at`,
  search_backfillEmbeddingsFromFts_1: `SELECT f.record_type, f.record_id, t.account_id, f.thread_id, f.message_id, f.attachment_id,
                  f.subject, f.sender, f.body, f.attachment_filename, f.attachment_text
           FROM mailbox_search_records f
           LEFT JOIN mailbox_threads t ON t.id = f.thread_id
           LEFT JOIN mailbox_search_embeddings e
             ON e.record_type = f.record_type
            AND e.record_id = f.record_id
           WHERE e.record_id IS NULL
           LIMIT ?`,
  search_searchLocalFts_1: `SELECT record_type, record_id, thread_id, message_id, attachment_id,
                  snippet(mailbox_search_records_fts, 7, '[', ']', ' ... ', 18) AS snippet,
                  subject, sender, body, attachment_filename, attachment_text,
                  bm25(mailbox_search_records_fts) AS fts_score
           FROM mailbox_search_records_fts
           WHERE mailbox_search_records_fts MATCH ?
           ORDER BY fts_score ASC
           LIMIT ?`,
  search_searchLocalVectors_1: `SELECT record_type, record_id, thread_id, message_id, attachment_id, snippet, embedding_json, updated_at
         FROM mailbox_search_embeddings
         ORDER BY updated_at DESC
         LIMIT ?`,
  search_findBestAttachmentForThread_1: `SELECT record_id, attachment_id, attachment_filename, attachment_text
         FROM mailbox_search_records
         WHERE record_type = 'attachment'
           AND thread_id = ?`,
  // MailboxForwardingService
  forwarding_getLastSuccessfulScanAt_1: `SELECT last_successful_scan_at
         FROM mailbox_forwarding_run_state
         WHERE automation_id = ?`,
  forwarding_setLastSuccessfulScanAt_1: `INSERT INTO mailbox_forwarding_run_state
           (automation_id, last_successful_scan_at, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(automation_id) DO UPDATE SET
           last_successful_scan_at = excluded.last_successful_scan_at,
           updated_at = excluded.updated_at`,
  forwarding_forwardMessage_1: `SELECT status FROM mailbox_forwarding_message_runs WHERE automation_id = ? AND message_id = ?`,
  forwarding_forwardMessage_2: `INSERT INTO mailbox_forwarding_message_runs
             (automation_id, message_id, thread_id, status, error, created_at, updated_at)
           VALUES (?, ?, ?, 'sent', NULL, ?, ?)
           ON CONFLICT(automation_id, message_id) DO UPDATE SET
             status = 'sent',
             error = NULL,
             thread_id = excluded.thread_id,
             updated_at = excluded.updated_at`,
  forwarding_forwardMessage_3: `INSERT INTO mailbox_forwarding_message_runs
             (automation_id, message_id, thread_id, status, error, created_at, updated_at)
           VALUES (?, ?, ?, 'error', ?, ?, ?)
           ON CONFLICT(automation_id, message_id) DO UPDATE SET
             status = 'error',
             error = excluded.error,
             thread_id = excluded.thread_id,
             updated_at = excluded.updated_at`,
  // MailboxAutomationRegistry
  automation_listAutomations: `SELECT
           id,
           workspace_id,
           kind,
           status,
           name,
           description,
           thread_id,
           source,
           recipe_json,
           backing_trigger_id,
           backing_cron_job_id,
           latest_outcome,
           latest_fire_at,
           latest_run_at,
           next_run_at,
           latest_error,
           created_at,
           updated_at
         FROM mailbox_automations
         WHERE status != 'deleted'
           AND (? IS NULL OR workspace_id = ?)
           AND (? IS NULL OR thread_id = ? OR thread_id IS NULL)
         ORDER BY updated_at DESC`,
  automation_listAutomationHistory_1: `SELECT id, automation_id, workspace_id, event_type, detail_json, created_at
         FROM mailbox_automation_audit
         WHERE automation_id = ?
         ORDER BY created_at DESC
         LIMIT ?`,
  automation_updateRule_1: `UPDATE mailbox_automations
         SET name = ?, description = ?, status = ?, thread_id = ?, recipe_json = ?, updated_at = ?
         WHERE id = ?`,
  automation_updateForward_1: `UPDATE mailbox_automations
         SET name = ?, description = ?, status = ?, thread_id = ?, recipe_json = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`,
  automation_recordTriggerFire_1: `SELECT * FROM mailbox_automations WHERE backing_trigger_id = ? LIMIT 1`,
  automation_recordTriggerFire_2: `UPDATE mailbox_automations
         SET latest_outcome = ?, latest_fire_at = ?, latest_error = NULL, updated_at = ?
         WHERE id = ?`,
  automation_recordCronEvent_1: `SELECT * FROM mailbox_automations WHERE backing_cron_job_id = ? LIMIT 1`,
  automation_recordCronEvent_2: `UPDATE mailbox_automations SET status = ?, updated_at = ? WHERE id = ?`,
  automation_recordCronEvent_3: `UPDATE mailbox_automations
         SET latest_outcome = ?, latest_run_at = COALESCE(?, latest_run_at), next_run_at = ?, latest_error = ?, status = ?, updated_at = ?
         WHERE id = ?`,
  automation_fetchRow_1: `SELECT
           id,
           workspace_id,
           kind,
           status,
           name,
           description,
           thread_id,
           source,
           recipe_json,
           backing_trigger_id,
           backing_cron_job_id,
           latest_outcome,
           latest_fire_at,
           latest_run_at,
           next_run_at,
           latest_error,
           created_at,
           updated_at
         FROM mailbox_automations
         WHERE id = ?`,
  automation_insertRecord_1: `INSERT INTO mailbox_automations
          (id, workspace_id, kind, status, name, description, thread_id, source, recipe_json, backing_trigger_id, backing_cron_job_id, latest_outcome, latest_fire_at, latest_run_at, next_run_at, latest_error, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  automation_appendAudit_1: `INSERT INTO mailbox_automation_audit
          (id, automation_id, workspace_id, event_type, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
  automation_markDeleted_1: `UPDATE mailbox_automations
         SET status = 'deleted', updated_at = ?
         WHERE id = ?`,
  automation_markForwardRunStarted_1: `UPDATE mailbox_automations
         SET latest_run_at = ?, latest_error = NULL, updated_at = ?
         WHERE id = ?`,
  automation_markForwardRunFinished_1: `UPDATE mailbox_automations
         SET status = ?, latest_outcome = ?, latest_error = ?, latest_fire_at = ?, next_run_at = ?, updated_at = ?
         WHERE id = ?`,
  automation_setForwardNextRun_1: `UPDATE mailbox_automations
         SET next_run_at = ?, updated_at = ?
         WHERE id = ?`,
} satisfies StatementCatalog;
