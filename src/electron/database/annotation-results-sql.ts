import type Database from "better-sqlite3";

/**
 * Point at the result: the revisions an annotation links and its undo token. Runs inside the
 * annotation storage units (AnnotationStore methods behind the async AnnotationRepository).
 */

/** The revision of the target file the user pointed at. */
export function setAnnotationBaseRevision(
  db: Database.Database,
  id: string,
  revisionId: string,
  now: number,
): void {
  db.prepare("UPDATE annotations SET artifact_revision_id = ?, updated_at = ? WHERE id = ?").run(
    revisionId,
    now,
    id,
  );
}

/** An annotation the agent worked on becomes `addressed`; only one still `addressing` moves. */
export function recordAnnotationResult(
  db: Database.Database,
  id: string,
  result: { resultRevisionId?: string; undoToken?: string },
  now: number,
): void {
  db.prepare(`
    UPDATE annotations
    SET status = 'addressed',
        result_revision_id = ?,
        undo_token = ?,
        updated_at = ?
    WHERE id = ? AND status = 'addressing'
  `).run(result.resultRevisionId || null, result.undoToken || null, now, id);
}

/** After an undo: the token is spent, and the annotation is dismissed. */
export function clearAnnotationUndo(db: Database.Database, id: string, now: number): void {
  db.prepare(`
    UPDATE annotations
    SET undo_token = NULL,
        status = 'dismissed',
        resolved_at = COALESCE(resolved_at, ?),
        updated_at = ?
    WHERE id = ?
  `).run(now, now, id);
}
