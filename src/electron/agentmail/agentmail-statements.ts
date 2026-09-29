import type { StatementCatalog } from "../database/statements/statement-catalog";

/**
 * Statements of the AgentMail admin and realtime services. Part of the mailbox domain
 * catalog (async SQLite migration plan, DB6); names are prefixed by service.
 */
export const AGENTMAIL_STATEMENTS = {
  // AgentMailAdminService
  agentmailAdmin_getWorkspaceBindingRow_1: `SELECT workspace_id, pod_id, pod_name, created_at, updated_at
         FROM agentmail_workspace_pods
         WHERE workspace_id = ?`,
  agentmailAdmin_persistWorkspaceBinding_1: `INSERT INTO agentmail_workspace_pods
          (workspace_id, pod_id, pod_name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(workspace_id) DO UPDATE SET
           pod_id = excluded.pod_id,
           pod_name = excluded.pod_name,
           updated_at = excluded.updated_at`,
  agentmailAdmin_persistInboxes_1: `SELECT inbox_id FROM agentmail_inboxes WHERE workspace_id = ? AND pod_id = ?`,
  agentmailAdmin_persistDomains_1: `SELECT domain_id FROM agentmail_domains WHERE workspace_id = ? AND pod_id = ?`,
  agentmailAdmin_persistDomains_2: `DELETE FROM agentmail_domains WHERE domain_id = ?`,
  agentmailAdmin_persistListEntries_1: `INSERT INTO agentmail_lists
            (id, workspace_id, pod_id, inbox_id, direction, list_type, entry_value, entry_type, reason, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             pod_id = excluded.pod_id,
             inbox_id = excluded.inbox_id,
             entry_type = excluded.entry_type,
             reason = excluded.reason,
             updated_at = excluded.updated_at`,
  agentmailAdmin_deleteListEntryRecord_1: `DELETE FROM agentmail_lists WHERE id = ?`,
  agentmailAdmin_persistApiKeys_1: `SELECT api_key_id FROM agentmail_api_keys WHERE workspace_id = ? AND inbox_id = ?`,
  agentmailAdmin_persistApiKeys_2: `DELETE FROM agentmail_api_keys WHERE api_key_id = ?`,
  agentmailAdmin_persistApiKeys_3: `INSERT INTO agentmail_api_keys
            (api_key_id, workspace_id, pod_id, inbox_id, name, prefix, permissions_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(api_key_id) DO UPDATE SET
             workspace_id = excluded.workspace_id,
             pod_id = excluded.pod_id,
             inbox_id = excluded.inbox_id,
             name = excluded.name,
             prefix = excluded.prefix,
             permissions_json = excluded.permissions_json,
             updated_at = excluded.updated_at`,
  agentmailAdmin_getStatus_1: `SELECT COUNT(*) AS count FROM agentmail_domains`,
  agentmailAdmin_getStatus_2: `SELECT COUNT(*) AS count FROM agentmail_inboxes`,
  agentmailAdmin_getStatus_3: `SELECT COUNT(*) AS count FROM agentmail_workspace_pods`,
  agentmailAdmin_listInboxes_1: `SELECT pod_id, inbox_id, email, display_name, client_id, created_at, updated_at
         FROM agentmail_inboxes
         WHERE workspace_id = ?
         ORDER BY email COLLATE NOCASE ASC`,
  agentmailAdmin_deleteInbox_1: `DELETE FROM agentmail_inboxes WHERE workspace_id = ? AND inbox_id = ?`,
  agentmailAdmin_listDomains_1: `SELECT domain_id, workspace_id, pod_id, domain, status, feedback_enabled, records_json, client_id, created_at, updated_at
         FROM agentmail_domains
         WHERE workspace_id = ?
         ORDER BY domain COLLATE NOCASE ASC`,
  agentmailAdmin_deleteInbox: `DELETE FROM agentmail_inboxes WHERE workspace_id = ? AND pod_id = ? AND inbox_id = ?`,
  agentmailAdmin_upsertInbox: `INSERT INTO agentmail_inboxes
        (workspace_id, pod_id, inbox_id, email, display_name, client_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(pod_id, inbox_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         email = excluded.email,
         display_name = excluded.display_name,
         client_id = excluded.client_id,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
  agentmailAdmin_upsertDomain: `INSERT INTO agentmail_domains
        (domain_id, workspace_id, pod_id, domain, status, feedback_enabled, records_json, client_id, metadata_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(domain_id) DO UPDATE SET
         workspace_id = excluded.workspace_id,
         pod_id = excluded.pod_id,
         domain = excluded.domain,
         status = excluded.status,
         feedback_enabled = excluded.feedback_enabled,
         records_json = excluded.records_json,
         client_id = excluded.client_id,
         metadata_json = excluded.metadata_json,
         updated_at = excluded.updated_at`,
  // AgentMailRealtimeService
  agentmailRealtime_getRuntimeStatus_1: `SELECT connection_state, last_event_at, last_error
         FROM agentmail_realtime_state
         WHERE id = 'global'`,
  agentmailRealtime_persistRuntimeState_1: `INSERT INTO agentmail_realtime_state
          (id, connection_state, last_event_at, last_error, subscribed_inboxes_json, updated_at)
         VALUES ('global', ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET
           connection_state = excluded.connection_state,
           last_event_at = excluded.last_event_at,
           last_error = excluded.last_error,
           subscribed_inboxes_json = excluded.subscribed_inboxes_json,
           updated_at = excluded.updated_at`,
  agentmailRealtime_loadSubscribedInboxIds_1: `SELECT inbox_id FROM agentmail_inboxes ORDER BY inbox_id`,
  agentmailRealtime_handleMessage_1: `SELECT workspace_id, pod_id
         FROM agentmail_inboxes
         WHERE inbox_id = ?
         LIMIT 1`,
} satisfies StatementCatalog;
