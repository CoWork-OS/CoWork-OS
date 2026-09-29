import type Database from "better-sqlite3";
import {
  clearSubconsciousHistoryData,
  clearSubconsciousTargetData,
  SubconsciousBacklogStore,
  SubconsciousTargetStore,
} from "./SubconsciousRepositories";
import type { SubconsciousTargetSummary } from "../../shared/subconscious";

// oxlint-disable-next-line typescript/no-explicit-any -- rows are mapped by the loop service
type Row = any;

/**
 * The subconscious loop's own SQL (async SQLite migration plan, DB6): the evidence it
 * reads across other domains' tables, the target rekey, and legacy vocabulary cleanup.
 * As services-domain units these run in the database worker when the domain is routed
 * there; the evidence read is a reporting unit.
 */
export class SubconsciousStore {
  constructor(private readonly db: Database.Database) {}

  private hasTable(name: string): boolean {
    return Boolean(
      this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
    );
  }

  /** Recent rows from every evidence source; a source whose table is missing is `null`. */
  evidenceRows(): Record<string, Row[] | null> {
    return {
      tasks: this.hasTable("tasks")
        ? this.db
            .prepare(
              `SELECT id, workspace_id, title, status, failure_class, result_summary, updated_at, source
         FROM tasks
         ORDER BY updated_at DESC
         LIMIT 200`,
            )
            .all()
        : null,
      memoryMarkdownFiles: this.hasTable("memory_markdown_files")
        ? this.db
            .prepare(
              `SELECT workspace_id, path, updated_at
         FROM memory_markdown_files
         WHERE path LIKE '%.cowork/%' OR path LIKE '%playbook%'
         ORDER BY updated_at DESC
         LIMIT 100`,
            )
            .all()
        : null,
      mailboxEvents: this.hasTable("mailbox_events")
        ? this.db
            .prepare(
              `SELECT thread_id, workspace_id, subject, summary_text, created_at, last_seen_at
         FROM mailbox_events
         WHERE thread_id IS NOT NULL
         ORDER BY last_seen_at DESC
         LIMIT 50`,
            )
            .all()
        : null,
      automationProfiles:
        this.hasTable("automation_profiles") && this.hasTable("agent_roles")
          ? this.db
              .prepare(
                `SELECT ap.agent_role_id AS id,
         ar.name,
         ar.display_name,
         ap.last_heartbeat_at,
         ap.heartbeat_status,
         ap.heartbeat_last_pulse_result
         FROM automation_profiles ap
         JOIN agent_roles ar ON ar.id = ap.agent_role_id
         WHERE ap.enabled = 1
         AND COALESCE(ar.is_active, 1) = 1
         AND COALESCE(ar.role_kind, 'custom') != 'persona_template'`,
              )
              .all()
          : null,
      heartbeatRuns: this.hasTable("heartbeat_runs")
        ? this.db
            .prepare(
              `SELECT id, workspace_id, agent_role_id, run_type, dispatch_kind, reason, status, summary, error, updated_at
         FROM heartbeat_runs
         ORDER BY updated_at DESC
         LIMIT 50`,
            )
            .all()
        : null,
      eventTriggers: this.hasTable("event_triggers")
        ? this.db
            .prepare(
              `SELECT id, name, workspace_id, enabled, source, updated_at
         FROM event_triggers
         ORDER BY updated_at DESC`,
            )
            .all()
        : null,
      briefingConfig: this.hasTable("briefing_config")
        ? this.db
            .prepare(
              `SELECT workspace_id, enabled, schedule_time, updated_at
         FROM briefing_config`,
            )
            .all()
        : null,
      improvementRuns: this.hasTable("improvement_runs")
        ? this.db
            .prepare(
              `SELECT id, workspace_id, status, review_status, promotion_status, promotion_error, pull_request, completed_at, created_at
         FROM improvement_runs
         WHERE pull_request IS NOT NULL AND pull_request != ''
         ORDER BY COALESCE(completed_at, created_at) DESC
         LIMIT 50`,
            )
            .all()
        : null,
    };
  }

  /**
   * Move every record of a target to its new key and merge its summary, in one
   * transaction as a unit.
   */
  rekeyTarget(oldKey: string, merged: SubconsciousTargetSummary, backlogCount: number): void {
    const targets = new SubconsciousTargetStore(this.db);
    targets.upsert({ ...merged, backlogCount });
    const updates = [
      "UPDATE subconscious_runs SET target_key = ? WHERE target_key = ?",
      "UPDATE subconscious_hypotheses SET target_key = ? WHERE target_key = ?",
      "UPDATE subconscious_critiques SET target_key = ? WHERE target_key = ?",
      "UPDATE subconscious_decisions SET target_key = ? WHERE target_key = ?",
      "UPDATE subconscious_backlog_items SET target_key = ? WHERE target_key = ?",
      "UPDATE subconscious_dispatch_records SET target_key = ? WHERE target_key = ?",
    ];
    for (const sql of updates) this.db.prepare(sql).run(merged.key, oldKey);
    this.db.prepare("DELETE FROM subconscious_targets WHERE target_key = ?").run(oldKey);
    targets.upsert({
      ...merged,
      backlogCount: new SubconsciousBacklogStore(this.db).countOpenByTarget(merged.key),
    });
  }

  clearTargetData(targetKeys: string[]): void {
    clearSubconsciousTargetData(this.db, targetKeys);
  }

  clearHistoryData(): ReturnType<typeof clearSubconsciousHistoryData> {
    return clearSubconsciousHistoryData(this.db);
  }

  normalizeLegacyOutcomeVocabulary(): void {
    const statements = [
      "UPDATE subconscious_runs SET outcome = 'dispatch' WHERE outcome = 'completed'",
      "UPDATE subconscious_runs SET outcome = 'suggest' WHERE outcome = 'completed_no_dispatch'",
      "UPDATE subconscious_decisions SET outcome = 'dispatch' WHERE outcome = 'completed'",
      "UPDATE subconscious_decisions SET outcome = 'suggest' WHERE outcome = 'completed_no_dispatch'",
      "UPDATE subconscious_targets SET last_meaningful_outcome = 'dispatch' WHERE last_meaningful_outcome = 'completed'",
      "UPDATE subconscious_targets SET last_meaningful_outcome = 'suggest' WHERE last_meaningful_outcome = 'completed_no_dispatch'",
    ];
    for (const sql of statements) this.db.prepare(sql).run();
  }
}
