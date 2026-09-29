import type { StatementCatalog } from "../database/statements/statement-catalog";
import { AGENTMAIL_STATEMENTS } from "../agentmail/agentmail-statements";
import { MAILBOX_SUPPORT_STATEMENTS } from "./mailbox-support-statements";

/**
 * Every SQL statement of the mailbox domain (async SQLite migration plan, DB6). The
 * mailbox services run these by name through their statement port, on the host
 * connection or in the database worker; the worker runs nothing that is not listed here.
 * Names follow the method that first used the statement.
 */
import {
  placeholders,
  requireShapeEnum,
  requireShapeInteger,
  StatementCatalogError,
  type StatementShape,
} from "../database/statements/statement-catalog";

/**
 * The inbox visibility filter: hidden threads, sent-only threads, AgentMail inboxes of
 * other workspaces, threads only in views hidden from the inbox, and obsolete duplicate
 * accounts are excluded. Shape: `alias` ("mailbox_threads" or "mt"), `withWorkspace`
 * (three workspace parameters follow), `obsoleteAccounts` (that many account ids follow).
 */
export function inboxVisibleThreadFilterSql(shape: StatementShape): string {
  const alias = requireShapeEnum(shape, "alias", ["mailbox_threads", "mt"] as const);
  const withWorkspace = shape.withWorkspace === true;
  const obsoleteAccounts = requireShapeInteger(shape, "obsoleteAccounts");
  const threadRef = `${alias}.id`;
  const conditions = [
    `${alias}.local_inbox_hidden = 0`,
    `EXISTS (
        SELECT 1
        FROM mailbox_messages m
        WHERE m.thread_id = ${threadRef}
          AND m.direction = 'incoming'
      )`,
  ];
  if (withWorkspace) {
    conditions.push(
      `(
          ${alias}.provider != 'agentmail'
          OR EXISTS (
            SELECT 1
            FROM agentmail_inboxes ai
            WHERE ai.workspace_id = ?
              AND ('agentmail:' || ai.pod_id || ':' || ai.inbox_id) = ${alias}.account_id
          )
        )`,
    );
    // A thread is hidden from inbox if it belongs to at least one view with
    // show_in_inbox=0, but does NOT also belong to any view with show_in_inbox=1.
    conditions.push(
      `NOT (
          EXISTS (
            SELECT 1
            FROM mailbox_saved_view_threads svt
            INNER JOIN mailbox_saved_views sv ON sv.id = svt.view_id
            WHERE svt.thread_id = ${threadRef}
              AND sv.workspace_id = ?
              AND sv.show_in_inbox = 0
          )
          AND NOT EXISTS (
            SELECT 1
            FROM mailbox_saved_view_threads svt2
            INNER JOIN mailbox_saved_views sv2 ON sv2.id = svt2.view_id
            WHERE svt2.thread_id = ${threadRef}
              AND sv2.workspace_id = ?
              AND sv2.show_in_inbox != 0
          )
        )`,
    );
  }
  if (obsoleteAccounts > 0) {
    conditions.push(`${alias}.account_id NOT IN (${placeholders(obsoleteAccounts)})`);
  }
  return conditions.join(" AND ");
}

const visible = (shape: StatementShape, alias: "mailbox_threads" | "mt") =>
  inboxVisibleThreadFilterSql({ ...shape, alias });

/** `listThreads` conditions, by key, in the order the host lists them. */
const THREAD_LIST_CONDITIONS: Readonly<
  Record<string, string | ((shape: StatementShape) => string)>
> = {
  account: "account_id = ?",
  category: "category = ?",
  todayBucket: "today_bucket = ?",
  domainCategory: "domain_category = ?",
  folder: "(labels_json LIKE ? OR metadata_json LIKE ?)",
  label: "(labels_json LIKE ? OR metadata_json LIKE ?)",
  scheduledOnly: `EXISTS (
          SELECT 1 FROM mailbox_compose_drafts mcd
          WHERE mcd.thread_id = mailbox_threads.id
            AND mcd.status = 'scheduled'
        )`,
  draftOnly: `EXISTS (
          SELECT 1 FROM mailbox_compose_drafts mcd
          WHERE mcd.thread_id = mailbox_threads.id
            AND mcd.status NOT IN ('discarded', 'sent')
        )`,
  queuedOnly: `EXISTS (
          SELECT 1 FROM mailbox_queued_actions mqa
          WHERE mqa.thread_id = mailbox_threads.id
            AND mqa.status IN ('queued', 'running', 'failed')
        )`,
  inboxVisible: (shape) => visible(shape, "mailbox_threads"),
  sentOnly: `NOT EXISTS (
          SELECT 1
          FROM mailbox_messages m
          WHERE m.thread_id = mailbox_threads.id
            AND m.direction = 'incoming'
        )`,
  unread: "unread_count > 0",
  read: "unread_count = 0",
  needsReply: "needs_reply = ?",
  hasSuggestedProposal: `EXISTS (
              SELECT 1
              FROM mailbox_action_proposals map
              WHERE map.thread_id = mailbox_threads.id
                AND map.status = 'suggested'
            )`,
  noSuggestedProposal: `NOT EXISTS (
              SELECT 1
              FROM mailbox_action_proposals map
              WHERE map.thread_id = mailbox_threads.id
                AND map.status = 'suggested'
            )`,
  hasOpenCommitment: `EXISTS (
              SELECT 1
              FROM mailbox_commitments mc
              WHERE mc.thread_id = mailbox_threads.id
                AND mc.state IN ('suggested', 'accepted')
            )`,
  noOpenCommitment: `NOT EXISTS (
              SELECT 1
              FROM mailbox_commitments mc
              WHERE mc.thread_id = mailbox_threads.id
                AND mc.state IN ('suggested', 'accepted')
            )`,
  cleanupCandidate: "cleanup_candidate = ?",
  hasAttachment:
    "EXISTS (SELECT 1 FROM mailbox_attachments ma WHERE ma.thread_id = mailbox_threads.id)",
  noAttachment:
    "NOT EXISTS (SELECT 1 FROM mailbox_attachments ma WHERE ma.thread_id = mailbox_threads.id)",
  savedView: `EXISTS (
          SELECT 1 FROM mailbox_saved_view_threads svt
          WHERE svt.view_id = ? AND svt.thread_id = mailbox_threads.id
        )`,
};

function listThreadsSql(shape: StatementShape): string {
  const keys =
    typeof shape.conditions === "string" && shape.conditions ? shape.conditions.split(",") : [];
  const conditions = keys.map((key) => {
    const fragment = Object.prototype.hasOwnProperty.call(THREAD_LIST_CONDITIONS, key)
      ? THREAD_LIST_CONDITIONS[key]
      : undefined;
    if (fragment === undefined) throw new StatementCatalogError(`Unknown thread condition: ${key}`);
    return typeof fragment === "string" ? fragment : fragment(shape);
  });
  const sortBy = requireShapeEnum(shape, "sortBy", ["recent", "priority"] as const);
  const orderBy =
    sortBy === "recent"
      ? "last_message_at DESC, priority_score DESC, urgency_score DESC"
      : "priority_score DESC, urgency_score DESC, last_message_at DESC";
  return `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           today_bucket,
           domain_category,
           classification_rationale,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           local_inbox_hidden,
           unread_count,
           message_count,
           last_message_at,
           sensitive_content_json,
           classification_state
         FROM mailbox_threads
         ${conditions.length ? `WHERE ${conditions.join(" AND ")}` : ""}
         ORDER BY ${orderBy}${shape.limit === true ? " LIMIT ?" : ""}`;
}

export const MAILBOX_STATEMENTS = {
  ...MAILBOX_SUPPORT_STATEMENTS,
  ...AGENTMAIL_STATEMENTS,
  getExistingMailboxAccounts_1: `SELECT id, provider, address, display_name, status, capabilities_json, sync_cursor, classification_initial_batch_at, last_synced_at
         FROM mailbox_accounts
         WHERE provider = ?
         ORDER BY updated_at DESC`,
  getObsoleteDuplicateMailboxAccountIds_1: `SELECT id, provider, address, display_name, status, capabilities_json, sync_cursor, classification_initial_batch_at, last_synced_at
           FROM mailbox_accounts`,
  getSyncStatus_1: `SELECT id, provider, address, display_name, status, capabilities_json, sync_cursor, classification_initial_batch_at, last_synced_at
         FROM mailbox_accounts
         ORDER BY updated_at DESC`,
  createMailboxDraft_1: `INSERT INTO mailbox_compose_drafts
          (id, account_id, thread_id, provider_draft_id, mode, status, subject, body_text, body_html, to_json, cc_json, bcc_json, identity_id, signature_id, attachments_json, scheduled_at, send_after, latest_error, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, NULL, ?, 'local', ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?, ?)`,
  updateMailboxDraft_1: `UPDATE mailbox_compose_drafts
         SET subject = ?, body_text = ?, body_html = ?, to_json = ?, cc_json = ?, bcc_json = ?,
             identity_id = ?, signature_id = ?, scheduled_at = ?, updated_at = ?
         WHERE id = ?`,
  addMailboxDraftAttachment_1: `UPDATE mailbox_compose_drafts
         SET attachments_json = ?, updated_at = ?
         WHERE id = ?`,
  updateMailboxClientSettings_1: `INSERT INTO mailbox_client_settings
          (id, remote_content_policy, send_delay_seconds, sync_recent_days, attachment_cache, notifications, updated_at)
         VALUES ('default', ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           remote_content_policy = excluded.remote_content_policy,
           send_delay_seconds = excluded.send_delay_seconds,
           sync_recent_days = excluded.sync_recent_days,
           attachment_cache = excluded.attachment_cache,
           notifications = excluded.notifications,
           updated_at = excluded.updated_at`,
  sendMailboxDraft_1: `INSERT INTO mailbox_outgoing_messages
          (id, draft_id, account_id, status, provider_message_id, scheduled_at, send_after, latest_error, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, 'queued', NULL, ?, ?, NULL, ?, ?, ?)`,
  sendMailboxDraft_2: `UPDATE mailbox_compose_drafts SET status = ?, send_after = ?, updated_at = ? WHERE id = ?`,
  discardMailboxDraft_1: `UPDATE mailbox_compose_drafts SET status = 'discarded', updated_at = ? WHERE id = ? AND status != 'sent'`,
  discardMailboxDraft_2: `UPDATE mailbox_queued_actions SET status = 'cancelled', updated_at = ? WHERE draft_id = ? AND status IN ('queued', 'failed')`,
  discardMailboxDraft_3: `UPDATE mailbox_outgoing_messages SET status = 'cancelled', updated_at = ? WHERE draft_id = ? AND status IN ('queued', 'failed')`,
  undoMailboxAction_1: `UPDATE mailbox_queued_actions SET status = 'cancelled', updated_at = ? WHERE id = ? AND status IN ('queued', 'failed')`,
  retryMailboxAction_1: `UPDATE mailbox_queued_actions
         SET status = 'queued', next_attempt_at = ?, latest_error = NULL, updated_at = ?
         WHERE id = ?`,
  processMailboxQueue_1: `SELECT id, account_id, thread_id, draft_id, action_type, status, payload_json, attempts, next_attempt_at,
                  latest_error, undo_of_action_id, created_at, updated_at
           FROM mailbox_queued_actions
           WHERE status = 'queued'
             AND COALESCE(next_attempt_at, 0) <= ?
           ORDER BY next_attempt_at ASC, created_at ASC
           LIMIT ?`,
  listMailboxEvents_1: `SELECT
           id,
           fingerprint,
           workspace_id,
           event_type,
           account_id,
           thread_id,
           provider,
           subject,
           summary_text,
           evidence_refs_json,
           payload_json,
           duplicate_count,
           created_at,
           last_seen_at
         FROM mailbox_events
         WHERE workspace_id = ?
           AND (? IS NULL OR thread_id = ?)
         ORDER BY last_seen_at DESC
         LIMIT ?`,
  listMissionControlHandoffs_1: `SELECT
           id,
           thread_id,
           workspace_id,
           company_id,
           company_name,
           operator_role_id,
           operator_display_name,
           issue_id,
           issue_title,
           source,
           latest_outcome,
           latest_wake_at,
           created_at,
           updated_at
         FROM mailbox_mission_control_handoffs
         WHERE thread_id = ?
         ORDER BY updated_at DESC`,
  getMailboxDigest_1: `SELECT COUNT(*) AS count
         FROM mailbox_events
         WHERE workspace_id = ?`,
  getMailboxDigest_2: `SELECT event_type, COUNT(*) AS count
         FROM mailbox_events
         WHERE workspace_id = ?
         GROUP BY event_type
         ORDER BY MAX(last_seen_at) DESC
         LIMIT 6`,
  getMailboxDigest_3: `SELECT MAX(last_synced_at) AS last_synced_at
         FROM mailbox_accounts`,
  getMailboxTodayDigest_1: `SELECT domain_category, COUNT(*) AS count
         FROM mailbox_threads
         WHERE local_inbox_hidden = 0
         GROUP BY domain_category
         ORDER BY count DESC`,
  getMailboxSenderCleanupDigest_1: `SELECT
           LOWER(COALESCE(m.from_email, '')) AS email,
           MAX(m.from_name) AS name,
           COUNT(DISTINCT t.id) AS thread_count,
           SUM(t.unread_count) AS unread_count,
           SUM(CASE WHEN t.cleanup_candidate = 1 THEN 1 ELSE 0 END) AS cleanup_count,
           SUM(CASE WHEN t.needs_reply = 1 THEN 1 ELSE 0 END) AS needs_reply_count,
           MAX(t.last_message_at) AS last_message_at
         FROM mailbox_messages m
         JOIN mailbox_threads t ON t.id = m.thread_id
         WHERE m.direction = 'incoming'
           AND m.from_email IS NOT NULL
           AND t.local_inbox_hidden = 0
         GROUP BY LOWER(m.from_email)
         HAVING thread_count >= 2 OR cleanup_count > 0
         ORDER BY cleanup_count DESC, thread_count DESC, last_message_at DESC
         LIMIT ?`,
  getMailboxSenderCleanupDigest_2: `SELECT DISTINCT t.*
           FROM mailbox_threads t
           JOIN mailbox_messages m ON m.thread_id = t.id
           WHERE LOWER(m.from_email) = ?
             AND t.local_inbox_hidden = 0
           ORDER BY t.cleanup_candidate DESC, t.last_message_at DESC
           LIMIT 4`,
  searchMailboxRows_1: `SELECT thread_id, attachment_id, snippet(mailbox_search_records_fts, 7, '[', ']', ' … ', 16) AS snippet,
                    subject, sender, body, attachment_filename, attachment_text, bm25(mailbox_search_records_fts) AS fts_score
             FROM mailbox_search_records_fts
             WHERE mailbox_search_records_fts MATCH ?
             ORDER BY fts_score ASC
             LIMIT ?`,
  searchMailboxRows_2: `SELECT DISTINCT t.id AS thread_id, ma.id AS attachment_id,
                COALESCE(ma.filename, t.snippet) AS snippet,
                0 AS score
         FROM mailbox_threads t
         LEFT JOIN mailbox_messages m ON m.thread_id = t.id
         LEFT JOIN mailbox_attachments ma ON ma.thread_id = t.id
         LEFT JOIN mailbox_attachment_text mat ON mat.attachment_id = ma.id
         WHERE LOWER(t.subject || ' ' || t.snippet || ' ' || COALESCE(m.body_text, '') || ' ' || COALESCE(ma.filename, '') || ' ' || COALESCE(mat.text_content, '')) LIKE ?
         ORDER BY t.last_message_at DESC
         LIMIT ?`,
  createSentFollowupDrafts_1: `SELECT
           t.id,
           t.account_id,
           t.provider,
           t.provider_thread_id,
           t.subject,
           t.snippet,
           t.participants_json,
           t.labels_json,
           t.category,
           t.today_bucket,
           t.domain_category,
           t.classification_rationale,
           t.priority_score,
           t.urgency_score,
           t.needs_reply,
           t.stale_followup,
           t.cleanup_candidate,
           t.handled,
           t.local_inbox_hidden,
           t.unread_count,
           t.message_count,
           t.last_message_at,
           t.sensitive_content_json,
           t.classification_state,
           m.id AS latest_outbound_message_id,
           m.subject AS latest_outbound_subject,
           m.to_json AS latest_outbound_to_json,
           m.cc_json AS latest_outbound_cc_json,
           m.received_at AS latest_outbound_at
         FROM mailbox_threads t
         JOIN mailbox_messages m ON m.thread_id = t.id
         WHERE m.direction = 'outgoing'
           AND m.received_at = (
             SELECT MAX(m2.received_at)
             FROM mailbox_messages m2
             WHERE m2.thread_id = t.id
               AND m2.direction = 'outgoing'
           )
           AND m.received_at <= ?
           AND NOT EXISTS (
             SELECT 1
             FROM mailbox_messages mi
             WHERE mi.thread_id = t.id
               AND mi.direction = 'incoming'
               AND mi.received_at > m.received_at
           )
         ORDER BY t.priority_score DESC, t.urgency_score DESC, m.received_at ASC
         LIMIT ?`,
  createSentFollowupDrafts_2: `SELECT id FROM mailbox_drafts WHERE thread_id = ?
           UNION
           SELECT id
           FROM mailbox_compose_drafts
           WHERE thread_id = ?
             AND status NOT IN ('discarded', 'sent')
           LIMIT 1`,
  createSentFollowupDrafts_3: `INSERT INTO mailbox_drafts
            (id, thread_id, subject, body_text, tone, rationale, schedule_notes, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'concise', ?, NULL, ?, ?, ?)`,
  extractCandidateAttachmentsForAsk_1: `SELECT *
         FROM mailbox_attachments
         WHERE extraction_status IN ('not_indexed', 'error')
           AND (? = 1 OR LOWER(filename) LIKE ?)
         ORDER BY updated_at DESC
         LIMIT 3`,
  getMailboxAttachment_1: `SELECT ma.*, mat.text_content, mat.extraction_mode
         FROM mailbox_attachments ma
         LEFT JOIN mailbox_attachment_text mat ON mat.attachment_id = ma.id
         WHERE ma.id = ?`,
  extractMailboxAttachmentText_1: `SELECT * FROM mailbox_attachments WHERE id = ?`,
  extractMailboxAttachmentText_2: `UPDATE mailbox_attachments SET extraction_status = 'unsupported', extraction_error = NULL, updated_at = ? WHERE id = ?`,
  extractMailboxAttachmentText_3: `UPDATE mailbox_attachments SET extraction_status = 'error', extraction_error = ?, updated_at = ? WHERE id = ?`,
  extractMailboxAttachmentText_4: `UPDATE mailbox_attachments SET extraction_status = 'pending', extraction_error = NULL, updated_at = ? WHERE id = ?`,
  extractMailboxAttachmentText_5: `INSERT INTO mailbox_attachment_text (attachment_id, text_content, extraction_mode, extracted_at)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(attachment_id) DO UPDATE SET
             text_content = excluded.text_content,
             extraction_mode = excluded.extraction_mode,
             extracted_at = excluded.extracted_at`,
  extractMailboxAttachmentText_6: `UPDATE mailbox_attachments SET extraction_status = 'indexed', extraction_error = NULL, updated_at = ? WHERE id = ?`,
  pruneMailboxTriageFeedback_1: `DELETE FROM mailbox_triage_feedback WHERE workspace_id = ? AND created_at < ?`,
  pruneMailboxTriageFeedback_2: `SELECT COUNT(*) AS c FROM mailbox_triage_feedback WHERE workspace_id = ?`,
  pruneMailboxTriageFeedback_3: `DELETE FROM mailbox_triage_feedback WHERE rowid IN (
              SELECT rowid FROM mailbox_triage_feedback
              WHERE workspace_id = ?
              ORDER BY created_at ASC
              LIMIT ?
            )`,
  buildMailboxEventRecord_1: `SELECT id, duplicate_count
         FROM mailbox_events
         WHERE fingerprint = ?`,
  buildMailboxEventRecord_2: `UPDATE mailbox_events
           SET duplicate_count = ?, last_seen_at = ?
           WHERE id = ?`,
  buildMailboxEventRecord_3: `INSERT INTO mailbox_events
          (id, fingerprint, workspace_id, event_type, account_id, thread_id, provider, subject, summary_text, evidence_refs_json, payload_json, duplicate_count, created_at, last_seen_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  listMailboxAccountIds_1: `SELECT id FROM mailbox_accounts ORDER BY updated_at DESC`,
  getAgentMailBindings_1: `SELECT workspace_id, pod_id
         FROM agentmail_workspace_pods
         ORDER BY updated_at DESC`,
  normalizeAgentMailThread_1: `SELECT address FROM mailbox_accounts WHERE id = ?`,
  ingestAgentMailThread_1: `SELECT email, display_name
             FROM agentmail_inboxes
             WHERE pod_id = ? AND inbox_id = ?`,
  ingestAgentMailThread_2: `UPDATE mailbox_accounts SET last_synced_at = ?, updated_at = ? WHERE id = ?`,
  reclassifyThread_1: `SELECT account_id FROM mailbox_threads WHERE id = ?`,
  reclassifyAccount_1: `UPDATE mailbox_accounts
           SET classification_initial_batch_at = COALESCE(classification_initial_batch_at, ?),
               updated_at = ?
           WHERE id = ?`,
  getThread_1: `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           today_bucket,
           domain_category,
           classification_rationale,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           local_inbox_hidden,
           unread_count,
           message_count,
           last_message_at,
           sensitive_content_json,
           classification_state
         FROM mailbox_threads
         WHERE id = ?`,
  summarizeThread_1: `INSERT INTO mailbox_summaries
          (thread_id, summary_text, key_asks_json, extracted_questions_json, suggested_next_action, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(thread_id) DO UPDATE SET
           summary_text = excluded.summary_text,
           key_asks_json = excluded.key_asks_json,
           extracted_questions_json = excluded.extracted_questions_json,
           suggested_next_action = excluded.suggested_next_action,
           updated_at = excluded.updated_at`,
  generateDraft_1: `SELECT m.body_text
               FROM mailbox_messages m
               JOIN mailbox_threads t ON t.id = m.thread_id
               WHERE t.account_id = ? AND t.participants_json LIKE ? AND m.direction = 'outgoing'
               ORDER BY m.received_at ASC`,
  generateDraft_2: `INSERT INTO mailbox_drafts
          (id, thread_id, subject, body_text, tone, rationale, schedule_notes, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  extractCommitments_1: `INSERT INTO mailbox_commitments
            (id, thread_id, message_id, title, due_at, state, owner_email, source_excerpt, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  updateCommitmentState_1: `SELECT
             id,
             thread_id,
             message_id,
             title,
             due_at,
             state,
             owner_email,
             source_excerpt,
             metadata_json,
             created_at,
             updated_at
           FROM mailbox_commitments
           WHERE id = ?`,
  updateCommitmentState_2: `UPDATE mailbox_commitments
           SET state = ?, metadata_json = ?, updated_at = ?
           WHERE id = ?`,
  updateCommitmentDetails_1: `SELECT
           id,
           thread_id,
           message_id,
           title,
           due_at,
           state,
           owner_email,
           source_excerpt,
           metadata_json,
           created_at,
           updated_at
         FROM mailbox_commitments
         WHERE id = ?`,
  updateCommitmentDetails_2: `UPDATE mailbox_commitments
         SET title = ?, due_at = ?, state = ?, owner_email = ?, source_excerpt = ?, updated_at = ?
         WHERE id = ?`,
  proposeCleanup_1: `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           today_bucket,
           domain_category,
           classification_rationale,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           local_inbox_hidden,
           unread_count,
           message_count,
           last_message_at,
           sensitive_content_json,
           classification_state
         FROM mailbox_threads
         WHERE local_inbox_hidden = 0
           AND (cleanup_candidate = 1 OR (handled = 1 AND category IN ('promotions', 'updates')))
         ORDER BY last_message_at ASC
         LIMIT ?`,
  proposeFollowups_1: `SELECT
           id,
           account_id,
           provider,
           provider_thread_id,
           subject,
           snippet,
           participants_json,
           labels_json,
           category,
           today_bucket,
           domain_category,
           classification_rationale,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           local_inbox_hidden,
           unread_count,
           message_count,
           last_message_at,
           sensitive_content_json,
           classification_state
         FROM mailbox_threads
         WHERE local_inbox_hidden = 0
           AND needs_reply = 1
           AND stale_followup = 1
         ORDER BY urgency_score DESC, last_message_at ASC
         LIMIT ?`,
  applyAction_1: `UPDATE mailbox_threads SET handled = 1, updated_at = ? WHERE id = ?`,
  applyAction_2: `UPDATE mailbox_threads SET needs_reply = 0, handled = 1, today_bucket = 'good_to_know', updated_at = ? WHERE id = ?`,
  syncGmail_1: `SELECT classification_initial_batch_at
         FROM mailbox_accounts
         WHERE id = ?`,
  syncGmail_2: `SELECT id, provider, address, display_name, status, capabilities_json, classification_initial_batch_at, last_synced_at
             FROM mailbox_accounts WHERE id = ?`,
  syncImap_1: `SELECT classification_initial_batch_at
           FROM mailbox_accounts
           WHERE id = ?`,
  syncImap_2: `SELECT id, provider, address, display_name, status, capabilities_json, classification_initial_batch_at, last_synced_at
               FROM mailbox_accounts WHERE id = ?`,
  upsertAccount_1: `INSERT INTO mailbox_accounts
          (id, provider, address, display_name, status, capabilities_json, sync_cursor, last_synced_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           provider = excluded.provider,
           address = excluded.address,
           display_name = excluded.display_name,
           status = excluded.status,
           capabilities_json = excluded.capabilities_json,
           last_synced_at = excluded.last_synced_at,
           updated_at = excluded.updated_at`,
  reconcileMailboxMessageIdentity_1: `SELECT m.id, m.thread_id
           FROM mailbox_messages m
           JOIN mailbox_threads t ON t.id = m.thread_id
          WHERE t.account_id = ?
            AND m.provider_message_id = ?
            AND m.id != ?`,
  reconcileMailboxMessageIdentity_2: `DELETE FROM mailbox_messages WHERE id = ?`,
  deleteThreadIfEmpty_1: `SELECT COUNT(*) AS count FROM mailbox_messages WHERE thread_id = ?`,
  deleteThreadIfEmpty_2: `DELETE FROM mailbox_summaries WHERE thread_id = ?`,
  deleteThreadIfEmpty_3: `DELETE FROM mailbox_drafts WHERE thread_id = ?`,
  deleteThreadIfEmpty_4: `DELETE FROM mailbox_action_proposals WHERE thread_id = ?`,
  deleteThreadIfEmpty_5: `DELETE FROM mailbox_commitments WHERE thread_id = ?`,
  deleteThreadIfEmpty_6: `DELETE FROM mailbox_events WHERE thread_id = ?`,
  deleteThreadIfEmpty_7: `DELETE FROM mailbox_automations WHERE thread_id = ?`,
  deleteThreadIfEmpty_8: `DELETE FROM mailbox_mission_control_handoffs WHERE thread_id = ?`,
  deleteThreadIfEmpty_9: `DELETE FROM mailbox_threads WHERE id = ?`,
  upsertThread_1: `SELECT
           category,
           priority_score,
           urgency_score,
           needs_reply,
           stale_followup,
           cleanup_candidate,
           handled,
           local_inbox_hidden,
           unread_count,
           last_message_at,
           message_count,
           classification_state,
           classification_fingerprint,
           classification_model_key,
           classification_prompt_version,
           classification_confidence,
           classification_updated_at,
           classification_error,
           classification_json /* raw LLM response — debug/replay only, not used in runtime logic */
           ,
           today_bucket,
           domain_category,
           classification_rationale
         FROM mailbox_threads
         WHERE id = ?`,
  upsertThread_2: `SELECT id, is_unread FROM mailbox_messages WHERE thread_id = ?`,
  upsertThread_3: `INSERT INTO mailbox_threads
          (id, account_id, provider_thread_id, provider, subject, snippet, participants_json, labels_json, category, today_bucket, domain_category, classification_rationale, priority_score, urgency_score, needs_reply, stale_followup, cleanup_candidate, handled, local_inbox_hidden, unread_count, message_count, last_message_at, last_synced_at, classification_state, classification_fingerprint, classification_model_key, classification_prompt_version, classification_confidence, classification_updated_at, classification_error, classification_json, sensitive_content_json, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           account_id = excluded.account_id,
           provider_thread_id = excluded.provider_thread_id,
           provider = excluded.provider,
           subject = excluded.subject,
           snippet = excluded.snippet,
           participants_json = excluded.participants_json,
           labels_json = excluded.labels_json,
           category = excluded.category,
           today_bucket = excluded.today_bucket,
           domain_category = excluded.domain_category,
           classification_rationale = excluded.classification_rationale,
           priority_score = excluded.priority_score,
           urgency_score = excluded.urgency_score,
           needs_reply = excluded.needs_reply,
           stale_followup = excluded.stale_followup,
           cleanup_candidate = excluded.cleanup_candidate,
           handled = excluded.handled,
           local_inbox_hidden = excluded.local_inbox_hidden,
           unread_count = excluded.unread_count,
           message_count = excluded.message_count,
           last_message_at = excluded.last_message_at,
           last_synced_at = excluded.last_synced_at,
           classification_state = excluded.classification_state,
           classification_fingerprint = excluded.classification_fingerprint,
           classification_model_key = excluded.classification_model_key,
           classification_prompt_version = excluded.classification_prompt_version,
           classification_confidence = excluded.classification_confidence,
           classification_updated_at = excluded.classification_updated_at,
           classification_error = excluded.classification_error,
           classification_json = excluded.classification_json,
           sensitive_content_json = excluded.sensitive_content_json,
           metadata_json = excluded.metadata_json,
           updated_at = excluded.updated_at`,
  upsertThread_4: `SELECT thread_id FROM mailbox_messages WHERE id = ?`,
  upsertThread_5: `INSERT INTO mailbox_messages
            (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, body_html, received_at, is_unread, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             thread_id = excluded.thread_id,
             provider_message_id = excluded.provider_message_id,
             direction = excluded.direction,
             from_name = excluded.from_name,
             from_email = excluded.from_email,
             to_json = excluded.to_json,
             cc_json = excluded.cc_json,
             bcc_json = excluded.bcc_json,
             subject = excluded.subject,
             snippet = excluded.snippet,
             body_text = excluded.body_text,
             body_html = excluded.body_html,
             received_at = excluded.received_at,
             is_unread = excluded.is_unread,
             metadata_json = excluded.metadata_json,
             updated_at = excluded.updated_at`,
  upsertThread_6: `DELETE FROM mailbox_action_proposals
           WHERE thread_id = ?
             AND status = 'suggested'
             AND proposal_type IN ('reply', 'cleanup', 'follow_up', 'schedule')`,
  upsertMessageSearchIndex_1: `DELETE FROM mailbox_search_records WHERE record_type = 'message' AND record_id = ?`,
  upsertMessageSearchIndex_2: `INSERT INTO mailbox_search_records
             (record_type, record_id, thread_id, message_id, attachment_id, subject, sender, body, attachment_filename, attachment_text)
           VALUES ('message', ?, ?, ?, NULL, ?, ?, ?, '', '')
           ON CONFLICT (record_type, record_id) DO UPDATE SET
             thread_id = excluded.thread_id,
             message_id = excluded.message_id,
             attachment_id = excluded.attachment_id,
             subject = excluded.subject,
             sender = excluded.sender,
             body = excluded.body,
             attachment_filename = excluded.attachment_filename,
             attachment_text = excluded.attachment_text`,
  ensureMailboxSearchIndexBackfilled_1: `SELECT
             m.id,
             m.thread_id,
             m.from_name,
             m.from_email,
             m.subject,
             m.snippet,
             m.body_text,
             m.body_html,
             t.subject AS thread_subject
           FROM mailbox_messages m
           INNER JOIN mailbox_threads t ON t.id = m.thread_id
           WHERE NOT EXISTS (
             SELECT 1
             FROM mailbox_search_records f
             WHERE f.record_type = 'message'
               AND f.record_id = m.id
           )`,
  ensureMailboxSearchIndexBackfilled_2: `SELECT ma.*, mat.text_content, mat.extraction_mode
           FROM mailbox_attachments ma
           INNER JOIN mailbox_attachment_text mat ON mat.attachment_id = ma.id
           WHERE NOT EXISTS (
             SELECT 1
             FROM mailbox_search_records f
             WHERE f.record_type = 'attachment'
               AND f.record_id = ma.id
           )`,
  upsertMessageAttachments_1: `SELECT id FROM mailbox_attachments WHERE message_id = ?`,
  upsertMessageAttachments_2: `DELETE FROM mailbox_search_records WHERE record_type = 'attachment' AND record_id = ?`,
  upsertMessageAttachments_3: `DELETE FROM mailbox_search_embeddings WHERE record_type = 'attachment' AND record_id = ?`,
  upsertMessageAttachments_4: `DELETE FROM mailbox_attachment_text WHERE attachment_id = ?`,
  upsertMessageAttachments_5: `DELETE FROM mailbox_attachments WHERE id = ?`,
  upsertMessageAttachments_6: `INSERT INTO mailbox_attachments
            (id, thread_id, message_id, provider, provider_message_id, provider_attachment_id, filename, mime_type, size, extraction_status, extraction_error, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'not_indexed', NULL, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             thread_id = excluded.thread_id,
             message_id = excluded.message_id,
             provider = excluded.provider,
             provider_message_id = excluded.provider_message_id,
             provider_attachment_id = excluded.provider_attachment_id,
             filename = excluded.filename,
             mime_type = excluded.mime_type,
             size = excluded.size,
             metadata_json = excluded.metadata_json,
             updated_at = excluded.updated_at`,
  upsertAttachmentSearchIndex_1: `INSERT INTO mailbox_search_records
             (record_type, record_id, thread_id, message_id, attachment_id, subject, sender, body, attachment_filename, attachment_text)
           VALUES ('attachment', ?, ?, ?, ?, '', '', '', ?, ?)
           ON CONFLICT (record_type, record_id) DO UPDATE SET
             thread_id = excluded.thread_id,
             message_id = excluded.message_id,
             attachment_id = excluded.attachment_id,
             subject = excluded.subject,
             sender = excluded.sender,
             body = excluded.body,
             attachment_filename = excluded.attachment_filename,
             attachment_text = excluded.attachment_text`,
  classifyThreadWithLLM_1: `SELECT classification_state, classification_fingerprint, classification_prompt_version
         FROM mailbox_threads
         WHERE id = ?`,
  persistThreadClassification_1: `UPDATE mailbox_threads
         SET category = ?,
             today_bucket = ?,
             domain_category = ?,
             classification_rationale = ?,
             priority_score = ?,
             urgency_score = ?,
             needs_reply = ?,
             stale_followup = ?,
             cleanup_candidate = ?,
             handled = ?,
             classification_state = 'classified',
             classification_fingerprint = ?,
             classification_model_key = ?,
             classification_prompt_version = ?,
             classification_confidence = ?,
             classification_updated_at = ?,
             classification_error = NULL,
             classification_json = ?,
             metadata_json = ?,
             updated_at = ?
         WHERE id = ?`,
  classifyMailboxThreadsForAccount_1: `SELECT id, classification_initial_batch_at
         FROM mailbox_accounts
         WHERE id = ?`,
  classifyMailboxThreadsForAccount_2: `SELECT id
             FROM mailbox_threads
             WHERE account_id = ?
             ORDER BY unread_count DESC, last_message_at DESC
             LIMIT ?`,
  refreshThreadProposals_1: `DELETE FROM mailbox_action_proposals
         WHERE thread_id = ?
           AND status = 'suggested'
           AND proposal_type IN ('reply', 'cleanup', 'follow_up', 'schedule')`,
  upsertPrimaryContact_1: `INSERT INTO mailbox_contacts
          (id, account_id, email, name, company, role, encryption_preference, policy_flags_json, crm_links_json, learned_facts_json, response_tendency, last_interaction_at, open_commitments, updated_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(email) DO UPDATE SET
           account_id = excluded.account_id,
           name = COALESCE(excluded.name, mailbox_contacts.name),
           company = COALESCE(excluded.company, mailbox_contacts.company),
           encryption_preference = CASE
             WHEN mailbox_contacts.encryption_preference IS NULL THEN excluded.encryption_preference
             ELSE mailbox_contacts.encryption_preference
           END,
           policy_flags_json = CASE
             WHEN mailbox_contacts.policy_flags_json IS NULL THEN excluded.policy_flags_json
             ELSE mailbox_contacts.policy_flags_json
           END,
           learned_facts_json = excluded.learned_facts_json,
           last_interaction_at = excluded.last_interaction_at,
           updated_at = excluded.updated_at`,
  getSummaryForThread_1: `SELECT
           thread_id,
           summary_text,
           key_asks_json,
           extracted_questions_json,
           suggested_next_action,
           updated_at
         FROM mailbox_summaries
         WHERE thread_id = ?`,
  getMessagesForThread_1: `SELECT
           id,
           thread_id,
           provider_message_id,
           direction,
           from_name,
           from_email,
           to_json,
           cc_json,
           bcc_json,
           subject,
           snippet,
           body_text,
           body_html,
           received_at,
           is_unread,
           metadata_json
         FROM mailbox_messages
         WHERE thread_id = ?
         ORDER BY received_at ASC`,
  getDraftsForThread_1: `SELECT
           id,
           thread_id,
           subject,
           body_text,
           tone,
           rationale,
           schedule_notes,
           created_at,
           updated_at
         FROM mailbox_drafts
         WHERE thread_id = ?
         ORDER BY updated_at DESC`,
  getProposalsForThread_1: `SELECT
           id,
           thread_id,
           proposal_type,
           title,
           reasoning,
           preview_json,
           status,
           created_at,
           updated_at
         FROM mailbox_action_proposals
         WHERE thread_id = ?
         ORDER BY updated_at DESC`,
  getCommitmentsForThread_1: `SELECT
           id,
           thread_id,
           message_id,
           title,
           due_at,
           state,
           owner_email,
           source_excerpt,
           metadata_json,
           created_at,
           updated_at
         FROM mailbox_commitments
         WHERE thread_id = ?
         ORDER BY updated_at DESC`,
  getPrimaryContactMemory_1: `SELECT account_id, participants_json FROM mailbox_threads WHERE id = ?`,
  getPrimaryContactMemory_2: `SELECT
           id,
           account_id,
           email,
           name,
           company,
           role,
           encryption_preference,
           policy_flags_json,
           crm_links_json,
           learned_facts_json,
           response_tendency,
           last_interaction_at,
           open_commitments
         FROM mailbox_contacts
         WHERE email = ?`,
  getContactInsights_1: `SELECT id, subject, last_message_at
         FROM mailbox_threads
         WHERE account_id = ? AND participants_json LIKE ?
         ORDER BY last_message_at DESC`,
  getContactInsights_2: `SELECT
           m.thread_id,
           m.direction,
           m.body_text,
           m.received_at
         FROM mailbox_messages m
         JOIN mailbox_threads t ON t.id = m.thread_id
         WHERE t.account_id = ? AND t.participants_json LIKE ?
         ORDER BY m.received_at ASC`,
  resolveThreadWorkspaceId_1: `SELECT workspace_id
           FROM agentmail_inboxes
           WHERE pod_id = ? AND inbox_id = ?
           LIMIT 1`,
  persistMissionControlHandoff_1: `INSERT INTO mailbox_mission_control_handoffs (
           id,
           thread_id,
           workspace_id,
           company_id,
           company_name,
           operator_role_id,
           operator_display_name,
           issue_id,
           issue_title,
           source,
           latest_outcome,
           latest_wake_at,
           created_at,
           updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'mailbox_handoff', ?, ?, ?, ?)`,
  persistMissionControlHandoff_2: `SELECT * FROM mailbox_mission_control_handoffs WHERE id = ?`,
  findActiveMissionControlHandoff_1: `SELECT *
         FROM mailbox_mission_control_handoffs
         WHERE thread_id = ?
           AND company_id = ?
           AND operator_role_id = ?
         ORDER BY updated_at DESC`,
  applyArchive_1: `UPDATE mailbox_threads SET handled = 1, cleanup_candidate = 0, local_inbox_hidden = 1, updated_at = ? WHERE id = ?`,
  applyMarkDone_1: `SELECT id
         FROM mailbox_commitments
         WHERE thread_id = ?
           AND state IN ('suggested', 'accepted')`,
  applyMarkDone_2: `UPDATE mailbox_threads
         SET needs_reply = 0,
             stale_followup = 0,
             handled = 1,
             today_bucket = CASE WHEN today_bucket = 'needs_action' THEN 'good_to_know' ELSE today_bucket END,
             updated_at = ?
         WHERE id = ?`,
  markThreadReadLocally_1: `UPDATE mailbox_messages SET is_unread = 0, updated_at = ? WHERE thread_id = ?`,
  markThreadReadLocally_2: `UPDATE mailbox_threads SET unread_count = 0, handled = CASE WHEN needs_reply = 0 THEN 1 ELSE handled END, updated_at = ? WHERE id = ?`,
  applyMarkUnread_1: `UPDATE mailbox_messages SET is_unread = CASE WHEN id = ? THEN 1 ELSE is_unread END, updated_at = ? WHERE thread_id = ?`,
  applyMarkUnread_2: `UPDATE mailbox_threads SET unread_count = 1, handled = 0, updated_at = ? WHERE id = ?`,
  applyMicrosoftGraphReadState_1: `SELECT
           id,
           provider_message_id,
           metadata_json
         FROM mailbox_messages
         WHERE thread_id = ?
         ORDER BY is_unread DESC, received_at DESC`,
  persistResolvedMicrosoftGraphMessageId_1: `UPDATE mailbox_messages SET metadata_json = ?, updated_at = ? WHERE id = ?`,
  applyLabel_1: `UPDATE mailbox_threads SET labels_json = ?, updated_at = ? WHERE id = ?`,
  applySendDraft_1: `UPDATE mailbox_drafts
           SET subject = ?,
               body_text = ?,
               updated_at = ?
           WHERE id = ?`,
  applySendDraft_2: `DELETE FROM mailbox_drafts WHERE id = ?`,
  applySendDraft_3: `UPDATE mailbox_threads
         SET needs_reply = 0,
             handled = 1,
             today_bucket = CASE WHEN today_bucket = 'needs_action' THEN 'good_to_know' ELSE today_bucket END,
             updated_at = ?
         WHERE id = ?`,
  applySendMessage_1: `UPDATE mailbox_threads
           SET needs_reply = 0,
               handled = 1,
               today_bucket = CASE WHEN today_bucket = 'needs_action' THEN 'good_to_know' ELSE today_bucket END,
               updated_at = ?
           WHERE id = ?`,
  updateProposalStatus_1: `UPDATE mailbox_action_proposals
         SET status = ?, updated_at = ?
         WHERE id = ?`,
  updateProposalStatusByThreadAndType_1: `UPDATE mailbox_action_proposals
         SET status = ?, updated_at = ?
         WHERE thread_id = ? AND proposal_type = ?`,
  threadIdFromProposal_1: `SELECT thread_id FROM mailbox_action_proposals WHERE id = ?`,
  updateContactOpenCommitments_1: `UPDATE mailbox_contacts
         SET open_commitments = ?, updated_at = ?
         WHERE email = ?`,
  upsertProposal_1: `SELECT id
         FROM mailbox_action_proposals
         WHERE thread_id = ? AND proposal_type = ? AND status = 'suggested'
         LIMIT 1`,
  upsertProposal_2: `UPDATE mailbox_action_proposals
           SET title = ?, reasoning = ?, preview_json = ?, updated_at = ?
           WHERE id = ?`,
  upsertProposal_3: `INSERT INTO mailbox_action_proposals
          (id, thread_id, proposal_type, title, reasoning, preview_json, status, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  getMailboxSyncHealth_1: `SELECT account_id, status, COUNT(*) AS count
         FROM mailbox_queued_actions
         GROUP BY account_id, status`,
  getMailboxSyncHealth_2: `SELECT account_id, status, COUNT(*) AS count
         FROM mailbox_compose_drafts
         WHERE status NOT IN ('discarded', 'sent')
         GROUP BY account_id, status`,
  listMailboxFolders_1: `SELECT id, account_id, provider_folder_id, name, role, unread_count, total_count, created_at, updated_at
         FROM mailbox_folders
         ORDER BY account_id, role, name`,
  listMailboxFolders_2: `SELECT id, provider, address, display_name, status, capabilities_json, sync_cursor, classification_initial_batch_at, last_synced_at FROM mailbox_accounts`,
  listMailboxLabels_1: `SELECT id, account_id, provider_label_id, name, color, unread_count, total_count, created_at, updated_at
         FROM mailbox_labels
         ORDER BY account_id, name`,
  listMailboxIdentities_1: `SELECT id, account_id, provider_identity_id, email, display_name, signature_id, is_default, created_at, updated_at
         FROM mailbox_identities
         ORDER BY account_id, is_default DESC, email`,
  listMailboxSignatures_1: `SELECT id, account_id, name, body_html, body_text, is_default, created_at, updated_at
         FROM mailbox_signatures
         ORDER BY account_id, is_default DESC, name`,
  listMailboxComposeDrafts_1: `SELECT id, account_id, thread_id, provider_draft_id, mode, status, subject, body_text, body_html,
                to_json, cc_json, bcc_json, identity_id, signature_id, attachments_json, scheduled_at,
                send_after, latest_error, metadata_json, created_at, updated_at
         FROM mailbox_compose_drafts
         WHERE status != 'discarded'
         ORDER BY updated_at DESC
         LIMIT 100`,
  listMailboxQueuedActions_1: `SELECT id, account_id, thread_id, draft_id, action_type, status, payload_json, attempts, next_attempt_at,
                latest_error, undo_of_action_id, created_at, updated_at
         FROM mailbox_queued_actions
         WHERE status IN ('queued', 'running', 'failed')
         ORDER BY updated_at DESC
         LIMIT 100`,
  listMailboxOutgoingMessages_1: `SELECT id, draft_id, account_id, status, provider_message_id, scheduled_at, send_after, latest_error, created_at, updated_at
         FROM mailbox_outgoing_messages
         WHERE status IN ('queued', 'sending', 'running', 'failed')
         ORDER BY updated_at DESC
         LIMIT 100`,
  getMailboxClientSettings_1: `SELECT remote_content_policy, send_delay_seconds, sync_recent_days, attachment_cache, notifications
         FROM mailbox_client_settings
         WHERE id = 'default'`,
  getMailboxComposeDraft_1: `SELECT id, account_id, thread_id, provider_draft_id, mode, status, subject, body_text, body_html,
                to_json, cc_json, bcc_json, identity_id, signature_id, attachments_json, scheduled_at,
                send_after, latest_error, metadata_json, created_at, updated_at
         FROM mailbox_compose_drafts
         WHERE id = ?`,
  getMailboxOutgoingMessage_1: `SELECT id, draft_id, account_id, status, provider_message_id, scheduled_at, send_after, latest_error, created_at, updated_at
         FROM mailbox_outgoing_messages
         WHERE id = ?`,
  getMailboxQueuedAction_1: `SELECT id, account_id, thread_id, draft_id, action_type, status, payload_json, attempts, next_attempt_at,
                latest_error, undo_of_action_id, created_at, updated_at
         FROM mailbox_queued_actions
         WHERE id = ?`,
  enqueueMailboxAction_1: `INSERT INTO mailbox_queued_actions
          (id, account_id, thread_id, draft_id, action_type, status, payload_json, attempts, next_attempt_at, latest_error, undo_of_action_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, NULL, ?, ?, ?)`,
  processMailboxQueuedAction_1: `UPDATE mailbox_queued_actions SET status = 'running', attempts = attempts + 1, updated_at = ? WHERE id = ? AND status = 'queued'`,
  processMailboxQueuedAction_2: `UPDATE mailbox_queued_actions SET status = 'succeeded', latest_error = NULL, updated_at = ? WHERE id = ?`,
  markMailboxQueuedActionFailed_1: `UPDATE mailbox_queued_actions
         SET status = ?, attempts = ?, next_attempt_at = ?, latest_error = ?, updated_at = ?
         WHERE id = ?`,
  markMailboxQueuedActionFailed_2: `UPDATE mailbox_compose_drafts
           SET status = 'failed', latest_error = ?, updated_at = ?
           WHERE id = ?`,
  markMailboxQueuedActionFailed_3: `UPDATE mailbox_outgoing_messages
           SET status = 'failed', latest_error = ?, updated_at = ?
           WHERE draft_id = ?
             AND status IN ('queued', 'sending', 'running', 'failed')`,
  executeQueuedDraftSend_1: `UPDATE mailbox_compose_drafts SET status = 'sending', latest_error = NULL, updated_at = ? WHERE id = ?`,
  executeQueuedDraftSend_2: `UPDATE mailbox_outgoing_messages SET status = 'sending', latest_error = NULL, updated_at = ? WHERE id = ?`,
  executeQueuedDraftSend_3: `UPDATE mailbox_compose_drafts
         SET status = 'sent', provider_draft_id = COALESCE(?, provider_draft_id), latest_error = NULL, updated_at = ?
         WHERE id = ?`,
  executeQueuedDraftSend_4: `UPDATE mailbox_outgoing_messages
           SET status = 'sent', provider_message_id = ?, latest_error = NULL, updated_at = ?
           WHERE id = ?`,
  getMailboxAccount_1: `SELECT id, provider, address, display_name, status, capabilities_json, sync_cursor, classification_initial_batch_at, last_synced_at
         FROM mailbox_accounts
         WHERE id = ?`,
  getProviderThreadId_1: `SELECT provider_thread_id FROM mailbox_threads WHERE id = ?`,
  upsertMailboxFolder_1: `INSERT INTO mailbox_folders
          (id, account_id, provider_folder_id, name, role, unread_count, total_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, provider_folder_id) DO UPDATE SET
           name = excluded.name,
           role = excluded.role,
           unread_count = excluded.unread_count,
           total_count = excluded.total_count,
           updated_at = excluded.updated_at`,
  upsertMailboxLabel_1: `INSERT INTO mailbox_labels
          (id, account_id, provider_label_id, name, color, unread_count, total_count, created_at, updated_at)
         VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?)
         ON CONFLICT(account_id, provider_label_id) DO UPDATE SET
           name = excluded.name,
           unread_count = excluded.unread_count,
           total_count = excluded.total_count,
           updated_at = excluded.updated_at`,
  applyPostSendLocalState_1: `INSERT INTO mailbox_messages
            (id, thread_id, provider_message_id, direction, from_name, from_email, to_json, cc_json, bcc_json, subject, snippet, body_text, received_at, is_unread, metadata_json, created_at, updated_at)
           VALUES (?, ?, ?, 'outgoing', NULL, ?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?)`,
  applyPostSendLocalState_2: `UPDATE mailbox_threads
           SET message_count = message_count + 1,
               last_message_at = ?,
               updated_at = ?,
               needs_reply = CASE WHEN ? = 1 THEN needs_reply ELSE 0 END,
               handled = CASE WHEN ? = 1 THEN handled ELSE 1 END,
               today_bucket = CASE
                 WHEN ? = 1 THEN today_bucket
                 WHEN today_bucket = 'needs_action' THEN 'good_to_know'
                 ELSE today_bucket
               END
           WHERE id = ?`,
  resolveComposeAccountId_1: `SELECT id FROM mailbox_accounts ORDER BY updated_at DESC LIMIT 1`,
  threadMatchesQuery_1: `SELECT ma.filename, mat.text_content
         FROM mailbox_attachments ma
         LEFT JOIN mailbox_attachment_text mat ON mat.attachment_id = ma.id
         WHERE ma.thread_id = ?`,
  getAttachmentSummariesForThread_1: `SELECT id, message_id, filename, mime_type, size, extraction_status
         FROM mailbox_attachments
         WHERE thread_id = ?
         ORDER BY updated_at DESC
         LIMIT ?`,
  ensureFollowUpTaskForCommitment_1: `SELECT id, subject, participants_json
         FROM mailbox_threads
         WHERE id = ?`,
  ensureFollowUpTaskForCommitment_2: `UPDATE mailbox_commitments
         SET metadata_json = ?, updated_at = ?
         WHERE id = ?`,
  recordMailboxTriageFeedback_1: `INSERT INTO mailbox_triage_feedback (id, workspace_id, thread_id, feedback_kind, payload_json, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
  listMailboxSnippets_1: `SELECT id, workspace_id, shortcut, body_text, subject_hint, created_at, updated_at
         FROM mailbox_snippets
         WHERE workspace_id = ?
         ORDER BY updated_at DESC`,
  upsertMailboxSnippet_1: `SELECT id FROM mailbox_snippets WHERE id = ? AND workspace_id = ?`,
  upsertMailboxSnippet_2: `UPDATE mailbox_snippets
             SET shortcut = ?, body_text = ?, subject_hint = ?, updated_at = ?
             WHERE id = ? AND workspace_id = ?`,
  upsertMailboxSnippet_3: `INSERT INTO mailbox_snippets (id, workspace_id, shortcut, body_text, subject_hint, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
  upsertMailboxSnippet_4: `SELECT * FROM mailbox_snippets WHERE id = ? AND workspace_id = ?`,
  deleteMailboxSnippet_1: `DELETE FROM mailbox_snippets WHERE id = ? AND workspace_id = ?`,
  listMailboxSavedViews_1: `SELECT id, workspace_id, name, instructions, seed_thread_id, show_in_inbox, created_at, updated_at
         FROM mailbox_saved_views
         WHERE workspace_id = ?
         ORDER BY updated_at DESC`,
  previewMailboxLabelSimilar_1: `SELECT id, subject, snippet, last_message_at
         FROM mailbox_threads
         WHERE account_id = ?
           AND id != ?
         ORDER BY last_message_at DESC
         LIMIT 300`,
  createMailboxSavedView_1: `INSERT INTO mailbox_saved_views
          (id, workspace_id, name, instructions, seed_thread_id, show_in_inbox, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  deleteMailboxSavedView_1: `DELETE FROM mailbox_saved_views WHERE id = ? AND workspace_id = ?`,
  createReviewScheduleForSavedView_1: `SELECT id, name, instructions FROM mailbox_saved_views WHERE id = ? AND workspace_id = ?`,
  // Statements with a shape (builders); see the helpers above.
  syncStatusThreadCounts: (shape: StatementShape) => `SELECT
           COUNT(*) AS thread_count,
           COALESCE(SUM(unread_count), 0) AS unread_count,
           COALESCE(SUM(CASE WHEN needs_reply = 1 THEN 1 ELSE 0 END), 0) AS needs_reply_count,
           COALESCE(
             SUM(CASE WHEN classification_state IN ('pending', 'backfill_pending') THEN 1 ELSE 0 END),
             0
           ) AS classification_pending_count
         FROM mailbox_threads
         WHERE ${visible(shape, "mailbox_threads")}`,
  visibleSuggestedProposalCount: (shape: StatementShape) => `SELECT COUNT(*) AS count
         FROM mailbox_action_proposals map
         JOIN mailbox_threads mt ON mt.id = map.thread_id
         WHERE map.status = 'suggested'
           AND ${visible(shape, "mt")}`,
  visibleOpenCommitmentCount: (shape: StatementShape) => `SELECT COUNT(*) AS count
         FROM mailbox_commitments mc
         JOIN mailbox_threads mt ON mt.id = mc.thread_id
         WHERE mc.state IN ('suggested', 'accepted')
           AND ${visible(shape, "mt")}`,
  digestThreadCounts: (shape: StatementShape) => `SELECT
           COALESCE(COUNT(*), 0) AS thread_count,
           COALESCE(SUM(message_count), 0) AS message_count,
           COALESCE(SUM(unread_count), 0) AS unread_count,
           COALESCE(SUM(CASE WHEN needs_reply = 1 THEN 1 ELSE 0 END), 0) AS needs_reply_count,
           COALESCE(
             SUM(CASE WHEN classification_state IN ('pending', 'backfill_pending') THEN 1 ELSE 0 END),
             0
           ) AS classification_pending_count,
           COALESCE(SUM(CASE WHEN sensitive_content_json IS NOT NULL AND sensitive_content_json != '' THEN 1 ELSE 0 END), 0) AS sensitive_thread_count
         FROM mailbox_threads
         WHERE ${visible(shape, "mailbox_threads")}`,
  visibleDraftCount: (shape: StatementShape) => `SELECT COUNT(*) AS count
         FROM mailbox_drafts md
         JOIN mailbox_threads mt ON mt.id = md.thread_id
         WHERE ${visible(shape, "mt")}`,
  visibleOverdueCommitmentCount: (shape: StatementShape) => `SELECT COUNT(*) AS count
         FROM mailbox_commitments mc
         JOIN mailbox_threads mt ON mt.id = mc.thread_id
         WHERE mc.state IN ('suggested', 'accepted')
           AND mc.due_at IS NOT NULL
           AND mc.due_at < ?
           AND ${visible(shape, "mt")}`,
  visibleTodayBucketCount: (shape: StatementShape) =>
    `SELECT COUNT(*) AS count FROM mailbox_threads WHERE today_bucket = ? AND ${visible(shape, "mailbox_threads")}`,
  listThreads: listThreadsSql,
  // Lists as a JSON array parameter instead of a variable number of placeholders.
  existingThreadIds: `SELECT id FROM mailbox_threads
         WHERE id IN (SELECT value FROM json_each(?))
           AND (? IS NULL OR account_id = ?)`,
  pendingClassificationCountForAccounts: `SELECT COUNT(*) AS count
         FROM mailbox_threads
         WHERE account_id IN (SELECT value FROM json_each(?))
           AND classification_state IN ('pending', 'backfill_pending')`,
  classificationCandidatesInStates: `SELECT id
             FROM mailbox_threads
             WHERE account_id = ?
               AND classification_state IN (SELECT value FROM json_each(?))
             ORDER BY unread_count DESC, last_message_at DESC
             LIMIT ?`,
  hideMicrosoftGraphJunkThread: `UPDATE mailbox_threads
       SET local_inbox_hidden = 1,
           handled = 1,
           cleanup_candidate = 0,
           updated_at = ?
       WHERE account_id = ?
         AND provider = 'outlook_graph'
         AND id = ?`,
  insertMessageSearchRow: `INSERT INTO mailbox_search_records
           (record_type, record_id, thread_id, message_id, attachment_id, subject, sender, body, attachment_filename, attachment_text)
         VALUES ('message', ?, ?, ?, NULL, ?, ?, ?, '', '')
           ON CONFLICT (record_type, record_id) DO UPDATE SET
             thread_id = excluded.thread_id,
             message_id = excluded.message_id,
             attachment_id = excluded.attachment_id,
             subject = excluded.subject,
             sender = excluded.sender,
             body = excluded.body,
             attachment_filename = excluded.attachment_filename,
             attachment_text = excluded.attachment_text`,
  addSavedViewThread: `INSERT OR REPLACE INTO mailbox_saved_view_threads (view_id, thread_id, score) VALUES (?, ?, ?)`,
} satisfies StatementCatalog;

export type MailboxStatementName = keyof typeof MAILBOX_STATEMENTS;
