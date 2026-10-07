import type Database from "better-sqlite3";

/** Prepared statements used only inside storage/service database transaction units. */
export function prepareScheduledRunRecoveryLookup(db: Database.Database) {
  return db.prepare(`
      SELECT * FROM tasks
      WHERE workspace_id = ? AND source = 'cron'
        AND json_valid(agent_config)
        AND json_extract(CASE WHEN json_valid(agent_config) THEN agent_config END, '$.scheduledJobId') = ?
        AND json_extract(CASE WHEN json_valid(agent_config) THEN agent_config END, '$.scheduledRunAtMs') = ?
      LIMIT 2
    `);
}

export function prepareApprovalResponsibilityReviewGate(db: Database.Database) {
  return db.prepare("SELECT type, details FROM approvals WHERE id = ?");
}

export function prepareApprovalInputLinkForResolution(db: Database.Database) {
  return db.prepare(`
            SELECT l.approval_id, l.task_id, l.revision_hash,
                    i.task_id AS input_task_id, i.questions, i.status AS input_status
             FROM approval_input_links l
             JOIN input_requests i ON i.id = l.input_id
             WHERE l.input_id = ?
          `);
}

export function preparePendingApprovalResolution(db: Database.Database) {
  return db.prepare(`UPDATE approvals SET status = ?, resolved_at = ?,
      resolved_by_principal_id = ?, resolved_by_role = ?
      WHERE id = ? AND status = 'pending' AND task_id = ? AND type = ?
      AND description = ? AND details = ? AND requested_at = ?
      AND (? = 'denied' OR requested_at + ? > ?)`);
}

export function prepareResponsibilityActionDecisionInsert(db: Database.Database) {
  return db.prepare(`
            INSERT INTO responsibility_action_review_decisions
              (approval_id, task_id, request_revision_hash, action, decided_at)
             VALUES (?, ?, ?, ?, ?)
          `);
}

export function prepareLinkedInputResolution(db: Database.Database) {
  return db.prepare(`
             UPDATE input_requests
             SET status = ?, answers = ?, resolved_at = ?
             WHERE id = ? AND task_id = ? AND status = 'pending'
          `);
}

export function prepareApprovalInputLinkInsert(db: Database.Database) {
  return db.prepare(
    "INSERT INTO approval_input_links (input_id,approval_id,task_id,revision_hash) VALUES (?,?,?,?)",
  );
}

export function prepareApprovalInputLinkLookup(db: Database.Database) {
  return db.prepare(
    "SELECT approval_id,task_id,revision_hash FROM approval_input_links WHERE input_id = ?",
  );
}
