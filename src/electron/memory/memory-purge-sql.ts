/**
 * Row-level deletion for memory stores derived from a task or a workspace (audit SEC-15,
 * LIFE-4). These helpers are plain synchronous SQL over a connection the caller owns:
 * `purgeTaskDerivedRows` runs inside `TaskStore.delete`'s transaction (host or database
 * worker), and `purgeWorkspaceMemoryRows` runs in one transaction for "Clear All Memories".
 *
 * Optional tables (created lazily by their services) are skipped when absent.
 * Free of static runtime imports so the database worker can load it; only
 * the `*OnHost` helpers load MemoryService, lazily, and only on the host.
 */
import type Database from "better-sqlite3";
import { purgeTaskMemoryItems, purgeWorkspaceMemoryItems } from "./memory-items-sql";

/**
 * Observation origins whose task-attributed memories survive a task delete. These are
 * explicit saves (`tool` = memory_remember) and imports; the user asked for them to be
 * kept independently of the conversation, so only their task link is cleared.
 */
const TASK_DELETE_KEPT_ORIGINS = ["import", "tool"] as const;

export interface TaskDerivedPurgeCounts {
  memories: number;
  durableContext: number;
  transcriptSpans: number;
  knowledgeGraph: number;
  playbookEvidence: number;
  playbookEntries: number;
  suggestions: number;
  /** memory_items rows (task-scoped, or inferred/third-party items learned in the task). */
  memoryItems: number;
  dreamingRunsUnlinked: number;
  pendingMemoryWritesUnlinked: number;
}

export interface WorkspaceMemoryRowPurgeCounts {
  curatedEntries: number;
  knowledgeGraph: number;
  dreaming: number;
  coreMemoryCandidates: number;
  playbookEvidence: number;
  playbookEntries: number;
  /** Suggestions plus suggestion feedback rows. */
  suggestions: number;
  memoryItems: number;
  pendingMemoryWrites: number;
  transcriptSpans: number;
}

function tableExists(db: Database.Database, name: string): boolean {
  const row = db
    .prepare("SELECT 1 AS present FROM sqlite_master WHERE type IN ('table', 'view') AND name = ?")
    .get(name) as { present?: number } | undefined;
  return row?.present === 1;
}

function run(db: Database.Database, sql: string, ...params: unknown[]): number {
  return db.prepare(sql).run(...params).changes;
}

/**
 * Delete or unlink rows derived from `taskId` in memory-side stores. Must be called inside
 * the task-delete transaction, before the `tasks` row is removed, so foreign keys to the
 * task never block the delete. Durable context and transcript span rows are always
 * removed; archive memories, KG facts, Playbook entries and evidence, and suggestions raised
 * from the task (with their feedback) only with `purgeDerivedMemory`.
 */
export function purgeTaskDerivedRows(
  db: Database.Database,
  taskId: string,
  options: { purgeDerivedMemory?: boolean; preserveExplicitSaves?: boolean } = {},
): TaskDerivedPurgeCounts {
  const purgeDerivedMemory = options.purgeDerivedMemory === true;
  const counts: TaskDerivedPurgeCounts = {
    memories: 0,
    durableContext: 0,
    transcriptSpans: 0,
    knowledgeGraph: 0,
    playbookEvidence: 0,
    playbookEntries: 0,
    suggestions: 0,
    memoryItems: 0,
    dreamingRunsUnlinked: 0,
    pendingMemoryWritesUnlinked: 0,
  };

  if (purgeDerivedMemory && tableExists(db, "memories")) {
    const hasObservationMetadata = tableExists(db, "memory_observation_metadata");
    const keptOrigins = TASK_DELETE_KEPT_ORIGINS.map((origin) => `'${origin}'`).join(", ");
    const keptClause =
      hasObservationMetadata && options.preserveExplicitSaves !== false
        ? `AND NOT EXISTS (
           SELECT 1 FROM memory_observation_metadata kept
           WHERE kept.memory_id = memories.id AND kept.origin IN (${keptOrigins})
         )`
        : "";
    const derivedIds = `SELECT id FROM memories WHERE task_id = ? ${keptClause}`;
    if (tableExists(db, "memory_embeddings")) {
      run(db, `DELETE FROM memory_embeddings WHERE memory_id IN (${derivedIds})`, taskId);
    }
    if (hasObservationMetadata) {
      run(db, `DELETE FROM memory_observation_metadata WHERE memory_id IN (${derivedIds})`, taskId);
    }
    counts.memories = run(db, `DELETE FROM memories WHERE id IN (${derivedIds})`, taskId);
  }

  if (tableExists(db, "durable_context_conversations")) {
    run(
      db,
      `DELETE FROM durable_context_summary_parents
       WHERE summary_id IN (SELECT id FROM durable_context_summaries WHERE task_id = ?)
          OR parent_summary_id IN (SELECT id FROM durable_context_summaries WHERE task_id = ?)`,
      taskId,
      taskId,
    );
    run(
      db,
      `DELETE FROM durable_context_summary_messages
       WHERE summary_id IN (SELECT id FROM durable_context_summaries WHERE task_id = ?)
          OR message_id IN (SELECT id FROM durable_context_messages WHERE task_id = ?)`,
      taskId,
      taskId,
    );
    if (tableExists(db, "durable_context_fts")) {
      run(db, "DELETE FROM durable_context_fts WHERE task_id = ?", taskId);
    }
    for (const table of [
      "durable_context_large_payloads",
      "durable_context_summaries",
      "durable_context_messages",
      "durable_context_conversations",
    ]) {
      if (tableExists(db, table)) {
        counts.durableContext += run(db, `DELETE FROM ${table} WHERE task_id = ?`, taskId);
      }
    }
  }

  // The conversation index; its FTS rows go with it through the table's triggers.
  if (tableExists(db, "durable_context_events")) {
    counts.durableContext += run(
      db,
      "DELETE FROM durable_context_events WHERE task_id = ?",
      taskId,
    );
  }

  if (tableExists(db, "transcript_spans")) {
    counts.transcriptSpans = run(db, "DELETE FROM transcript_spans WHERE task_id = ?", taskId);
  }

  // Legacy curated entries (retired by LegacyMemoryRetirement.ts) are kept, only unlinked,
  // so their task foreign key cannot block the delete.
  if (tableExists(db, "curated_memory_entries")) {
    run(db, "UPDATE curated_memory_entries SET task_id = NULL WHERE task_id = ?", taskId);
  }

  if (purgeDerivedMemory && tableExists(db, "kg_entities")) {
    if (tableExists(db, "kg_observations")) {
      counts.knowledgeGraph += run(
        db,
        "DELETE FROM kg_observations WHERE source_task_id = ?",
        taskId,
      );
    }
    if (tableExists(db, "kg_edges")) {
      counts.knowledgeGraph += run(db, "DELETE FROM kg_edges WHERE source_task_id = ?", taskId);
    }
    // An entity first seen in this task is removed only when nothing from other tasks
    // still hangs off it; otherwise deleting it would cascade into their facts.
    const orphanChecks = [
      tableExists(db, "kg_observations")
        ? "NOT EXISTS (SELECT 1 FROM kg_observations o WHERE o.entity_id = kg_entities.id)"
        : "",
      tableExists(db, "kg_edges")
        ? "NOT EXISTS (SELECT 1 FROM kg_edges e WHERE e.source_entity_id = kg_entities.id OR e.target_entity_id = kg_entities.id)"
        : "",
    ].filter(Boolean);
    counts.knowledgeGraph += run(
      db,
      `DELETE FROM kg_entities WHERE source_task_id = ?${orphanChecks.map((check) => ` AND ${check}`).join("")}`,
      taskId,
    );
    run(db, "UPDATE kg_entities SET source_task_id = NULL WHERE source_task_id = ?", taskId);
  }

  if (purgeDerivedMemory && tableExists(db, "playbook_success_evidence")) {
    if (tableExists(db, "playbook_success_links")) {
      run(
        db,
        `DELETE FROM playbook_success_links
         WHERE evidence_id IN (SELECT id FROM playbook_success_evidence WHERE task_id = ?)
            OR reinforces_evidence_id IN (SELECT id FROM playbook_success_evidence WHERE task_id = ?)`,
        taskId,
        taskId,
      );
    }
    counts.playbookEvidence = run(
      db,
      "DELETE FROM playbook_success_evidence WHERE task_id = ?",
      taskId,
    );
  }

  if (purgeDerivedMemory && tableExists(db, "playbook_entries")) {
    counts.playbookEntries = run(db, "DELETE FROM playbook_entries WHERE task_id = ?", taskId);
  }

  if (purgeDerivedMemory && tableExists(db, "suggestions")) {
    if (tableExists(db, "suggestion_feedback")) {
      counts.suggestions += run(
        db,
        `DELETE FROM suggestion_feedback
         WHERE suggestion_id IN (SELECT id FROM suggestions WHERE source_task_id = ?)`,
        taskId,
      );
    }
    counts.suggestions += run(db, "DELETE FROM suggestions WHERE source_task_id = ?", taskId);
  }

  // memory_items: task-scoped items always; with purgeDerivedMemory also items inferred from
  // the task. User-stated and curated items keep living with their task link cleared.
  counts.memoryItems = purgeTaskMemoryItems(
    db,
    taskId,
    purgeDerivedMemory,
    options.preserveExplicitSaves !== false,
  );

  // LIFE-4: these columns reference tasks(id) without ON DELETE on older databases.
  if (tableExists(db, "dreaming_runs")) {
    counts.dreamingRunsUnlinked = run(
      db,
      "UPDATE dreaming_runs SET source_task_id = NULL WHERE source_task_id = ?",
      taskId,
    );
  }
  if (tableExists(db, "pending_memory_writes")) {
    counts.pendingMemoryWritesUnlinked = run(
      db,
      "UPDATE pending_memory_writes SET task_id = NULL WHERE task_id = ?",
      taskId,
    );
  }

  return counts;
}

/**
 * Delete the workspace's rows in memory-side stores that `MemoryService.clearWorkspace`
 * and `DurableContextService.clearWorkspace` do not cover. One transaction.
 */
export function purgeWorkspaceMemoryRows(
  db: Database.Database,
  workspaceId: string,
): WorkspaceMemoryRowPurgeCounts {
  const counts: WorkspaceMemoryRowPurgeCounts = {
    curatedEntries: 0,
    knowledgeGraph: 0,
    dreaming: 0,
    coreMemoryCandidates: 0,
    playbookEvidence: 0,
    playbookEntries: 0,
    suggestions: 0,
    memoryItems: 0,
    pendingMemoryWrites: 0,
    transcriptSpans: 0,
  };
  db.transaction(() => {
    if (tableExists(db, "curated_memory_entries")) {
      counts.curatedEntries = run(
        db,
        "DELETE FROM curated_memory_entries WHERE workspace_id = ?",
        workspaceId,
      );
    }

    if (tableExists(db, "kg_entities")) {
      if (tableExists(db, "kg_observations")) {
        counts.knowledgeGraph += run(
          db,
          "DELETE FROM kg_observations WHERE entity_id IN (SELECT id FROM kg_entities WHERE workspace_id = ?)",
          workspaceId,
        );
      }
      if (tableExists(db, "kg_edges")) {
        counts.knowledgeGraph += run(
          db,
          "DELETE FROM kg_edges WHERE workspace_id = ?",
          workspaceId,
        );
      }
      counts.knowledgeGraph += run(
        db,
        "DELETE FROM kg_entities WHERE workspace_id = ?",
        workspaceId,
      );
    }

    if (tableExists(db, "dreaming_runs")) {
      if (tableExists(db, "dreaming_candidates")) {
        counts.dreaming += run(
          db,
          "DELETE FROM dreaming_candidates WHERE workspace_id = ? OR run_id IN (SELECT id FROM dreaming_runs WHERE workspace_id = ?)",
          workspaceId,
          workspaceId,
        );
      }
      counts.dreaming += run(db, "DELETE FROM dreaming_runs WHERE workspace_id = ?", workspaceId);
    }

    if (tableExists(db, "core_memory_candidates")) {
      counts.coreMemoryCandidates = run(
        db,
        `DELETE FROM core_memory_candidates
         WHERE workspace_id = ? OR (scope_kind = 'workspace' AND scope_ref = ?)`,
        workspaceId,
        workspaceId,
      );
    }

    if (tableExists(db, "playbook_success_evidence")) {
      if (tableExists(db, "playbook_success_links")) {
        run(
          db,
          `DELETE FROM playbook_success_links
           WHERE evidence_id IN (SELECT id FROM playbook_success_evidence WHERE workspace_id = ?)
              OR reinforces_evidence_id IN (SELECT id FROM playbook_success_evidence WHERE workspace_id = ?)`,
          workspaceId,
          workspaceId,
        );
      }
      counts.playbookEvidence = run(
        db,
        "DELETE FROM playbook_success_evidence WHERE workspace_id = ?",
        workspaceId,
      );
    }

    if (tableExists(db, "playbook_entries")) {
      counts.playbookEntries = run(
        db,
        "DELETE FROM playbook_entries WHERE workspace_id = ?",
        workspaceId,
      );
    }

    for (const table of ["suggestion_feedback", "suggestions"]) {
      if (tableExists(db, table)) {
        counts.suggestions += run(db, `DELETE FROM ${table} WHERE workspace_id = ?`, workspaceId);
      }
    }

    counts.memoryItems = purgeWorkspaceMemoryItems(db, workspaceId);

    if (tableExists(db, "pending_memory_writes")) {
      counts.pendingMemoryWrites = run(
        db,
        "DELETE FROM pending_memory_writes WHERE workspace_id = ?",
        workspaceId,
      );
    }

    if (tableExists(db, "transcript_spans") && tableExists(db, "tasks")) {
      counts.transcriptSpans = run(
        db,
        "DELETE FROM transcript_spans WHERE task_id IN (SELECT id FROM tasks WHERE workspace_id = ?)",
        workspaceId,
      );
    }
  })();
  return counts;
}

export interface ClearScopeTask {
  id: string;
  title: string;
  parentTaskId: string | null;
}

/** Every session task in the workspace, newest first: what a workspace clear affects. */
export function listWorkspaceClearScope(
  db: Database.Database,
  workspaceId: string,
): ClearScopeTask[] {
  return db
    .prepare(
      "SELECT id, title, parent_task_id AS parentTaskId FROM tasks WHERE workspace_id = ? ORDER BY created_at DESC",
    )
    .all(workspaceId) as ClearScopeTask[];
}

export interface SessionMemoryRowPurge {
  /** The session root and its descendants, with each task's workspace folder. */
  tasks: Array<{ id: string; workspacePath: string | null }>;
  counts: Pick<
    TaskDerivedPurgeCounts,
    | "memories"
    | "durableContext"
    | "knowledgeGraph"
    | "playbookEvidence"
    | "playbookEntries"
    | "suggestions"
    | "memoryItems"
  > &
    Pick<WorkspaceMemoryRowPurgeCounts, "curatedEntries" | "dreaming" | "pendingMemoryWrites">;
}

/**
 * Clear the memory rows of one session family (the task and its descendants) in one
 * transaction, and turn off capture for each of those tasks so a resumed session does not
 * recreate them. Task rows, task events and deliverables are kept. Returns null when the
 * task does not belong to the workspace.
 */
export function purgeSessionMemoryRows(
  db: Database.Database,
  workspaceId: string,
  taskId: string,
  invalidateTaskRowReads: (db: Database.Database) => void,
): SessionMemoryRowPurge | null {
  const root = db
    .prepare("SELECT id FROM tasks WHERE id = ? AND workspace_id = ?")
    .get(taskId, workspaceId);
  if (!root) return null;
  const family = db
    .prepare(
      `WITH RECURSIVE family(id) AS (
        SELECT id FROM tasks WHERE id = ?
        UNION SELECT child.id FROM tasks child JOIN family ON child.parent_task_id = family.id
      )
      SELECT tasks.id, tasks.agent_config AS agentConfig, workspaces.path AS workspacePath
      FROM tasks JOIN family ON tasks.id = family.id
      LEFT JOIN workspaces ON workspaces.id = tasks.workspace_id`,
    )
    .all(taskId) as Array<{ id: string; agentConfig: string | null; workspacePath: string | null }>;
  const counts: SessionMemoryRowPurge["counts"] = {
    memories: 0,
    curatedEntries: 0,
    durableContext: 0,
    knowledgeGraph: 0,
    dreaming: 0,
    playbookEvidence: 0,
    playbookEntries: 0,
    suggestions: 0,
    memoryItems: 0,
    pendingMemoryWrites: 0,
  };
  db.transaction(() => {
    for (const task of family) {
      let config: Record<string, unknown> = {};
      try {
        config = JSON.parse(task.agentConfig || "{}");
      } catch {
        // Exclusion still persists for malformed legacy configuration.
      }
      const excluded = JSON.stringify({ ...config, retainMemory: false });
      db.prepare("UPDATE tasks SET agent_config = ? WHERE id = ?").run(excluded, task.id);
      if (tableExists(db, "pending_memory_writes")) {
        counts.pendingMemoryWrites += run(
          db,
          "DELETE FROM pending_memory_writes WHERE task_id = ?",
          task.id,
        );
      }
      if (tableExists(db, "curated_memory_entries")) {
        counts.curatedEntries += run(
          db,
          "DELETE FROM curated_memory_entries WHERE task_id = ?",
          task.id,
        );
      }
      if (tableExists(db, "dreaming_runs")) {
        if (tableExists(db, "dreaming_candidates")) {
          counts.dreaming += run(
            db,
            "DELETE FROM dreaming_candidates WHERE run_id IN (SELECT id FROM dreaming_runs WHERE source_task_id = ?)",
            task.id,
          );
        }
        counts.dreaming += run(db, "DELETE FROM dreaming_runs WHERE source_task_id = ?", task.id);
      }
      const removed = purgeTaskDerivedRows(db, task.id, {
        purgeDerivedMemory: true,
        preserveExplicitSaves: false,
      });
      for (const field of [
        "memories",
        "durableContext",
        "knowledgeGraph",
        "playbookEvidence",
        "playbookEntries",
        "suggestions",
        "memoryItems",
      ] as const) {
        counts[field] += removed[field];
      }
    }
  })();
  invalidateTaskRowReads(db);
  return {
    tasks: family.map(({ id, workspacePath }) => ({ id, workspacePath })),
    counts,
  };
}

/** `listWorkspaceClearScope` on the host connection; throws when memory is unavailable. */
export async function listWorkspaceClearScopeOnHost(
  workspaceId: string,
): Promise<ClearScopeTask[]> {
  const { MemoryService } = await import("./MemoryService");
  const db = MemoryService.getDatabase();
  if (!db) throw new Error("Memory database is unavailable; deletion scope cannot be determined.");
  return listWorkspaceClearScope(db, workspaceId);
}

/** `purgeSessionMemoryRows` on the host connection; throws when memory is unavailable. */
export async function purgeSessionMemoryRowsOnHost(
  workspaceId: string,
  taskId: string,
): Promise<SessionMemoryRowPurge | null> {
  const { MemoryService } = await import("./MemoryService");
  const { invalidateTaskRowReads } = await import("../database/repositories");
  const db = MemoryService.getDatabase();
  if (!db) throw new Error("Memory database is unavailable.");
  return purgeSessionMemoryRows(db, workspaceId, taskId, invalidateTaskRowReads);
}

/**
 * Run `purgeWorkspaceMemoryRows` as the memory domain's `memoryPurge_workspace` unit.
 * Returns null when memory is not initialized.
 */
export async function purgeWorkspaceMemoryRowsOnHost(
  workspaceId: string,
): Promise<WorkspaceMemoryRowPurgeCounts | null> {
  const { MemoryService } = await import("./MemoryService");
  // Through the memory statement port (memory-purge-units.ts): on the database worker's
  // write connection when memory is routed there, so it does not race the worker's writes.
  const sql = MemoryService.getStatements();
  return sql ? sql.unit("memoryPurge_workspace", { workspaceId }) : null;
}

/** The workspace's folder from the profile database, or null when unknown. */
export async function resolveWorkspacePathOnHost(workspaceId: string): Promise<string | null> {
  const { MemoryService } = await import("./MemoryService");
  const db = MemoryService.getDatabase();
  if (!db) return null;
  const row = db.prepare("SELECT path FROM workspaces WHERE id = ?").get(workspaceId) as
    | { path?: unknown }
    | undefined;
  return typeof row?.path === "string" && row.path ? row.path : null;
}
