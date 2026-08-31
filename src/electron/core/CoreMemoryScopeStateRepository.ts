import Database from "better-sqlite3";
import type { CoreMemoryScopeKind, CoreMemoryScopeState } from "../../shared/types";

type Any = any;

export class CoreMemoryScopeStateRepository {
  constructor(private readonly db: Database.Database) {}

  get(scopeKind: CoreMemoryScopeKind, scopeRef: string): CoreMemoryScopeState | undefined {
    const row = this.db
      .prepare("SELECT * FROM core_memory_scope_state WHERE scope_kind = ? AND scope_ref = ?")
      .get(scopeKind, scopeRef) as Any;
    return row ? this.mapRow(row) : undefined;
  }

  upsert(input: CoreMemoryScopeState): CoreMemoryScopeState {
    this.db
      .prepare(
        `INSERT INTO core_memory_scope_state (
          scope_kind, scope_ref, last_trace_at, last_distill_at, last_prune_at, stability_version, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(scope_kind, scope_ref) DO UPDATE SET
          last_trace_at = excluded.last_trace_at,
          last_distill_at = excluded.last_distill_at,
          last_prune_at = excluded.last_prune_at,
          stability_version = excluded.stability_version,
          updated_at = excluded.updated_at`,
      )
      .run(
        input.scopeKind,
        input.scopeRef,
        input.lastTraceAt || null,
        input.lastDistillAt || null,
        input.lastPruneAt || null,
        input.stabilityVersion,
        input.updatedAt,
      );
    return this.get(input.scopeKind, input.scopeRef)!;
  }

  touchTrace(scopeKind: CoreMemoryScopeKind, scopeRef: string, at: number): CoreMemoryScopeState {
    const existing = this.get(scopeKind, scopeRef);
    return this.upsert({
      scopeKind,
      scopeRef,
      lastTraceAt: at,
      lastDistillAt: existing?.lastDistillAt,
      lastPruneAt: existing?.lastPruneAt,
      stabilityVersion: existing?.stabilityVersion ?? 1,
      updatedAt: at,
    });
  }

  touchDistill(scopeKind: CoreMemoryScopeKind, scopeRef: string, at: number): CoreMemoryScopeState {
    const existing = this.get(scopeKind, scopeRef);
    return this.upsert({
      scopeKind,
      scopeRef,
      lastTraceAt: existing?.lastTraceAt,
      lastDistillAt: at,
      lastPruneAt: existing?.lastPruneAt,
      stabilityVersion: existing?.stabilityVersion ?? 1,
      updatedAt: at,
    });
  }

  touchPrune(scopeKind: CoreMemoryScopeKind, scopeRef: string, at: number): CoreMemoryScopeState {
    const existing = this.get(scopeKind, scopeRef);
    return this.upsert({
      scopeKind,
      scopeRef,
      lastTraceAt: existing?.lastTraceAt,
      lastDistillAt: existing?.lastDistillAt,
      lastPruneAt: at,
      stabilityVersion: existing?.stabilityVersion ?? 1,
      updatedAt: at,
    });
  }

  private mapRow(row: Any): CoreMemoryScopeState {
    return {
      scopeKind: row.scope_kind,
      scopeRef: String(row.scope_ref),
      lastTraceAt: row.last_trace_at ? Number(row.last_trace_at) : undefined,
      lastDistillAt: row.last_distill_at ? Number(row.last_distill_at) : undefined,
      lastPruneAt: row.last_prune_at ? Number(row.last_prune_at) : undefined,
      stabilityVersion: Number(row.stability_version || 1),
      updatedAt: Number(row.updated_at),
    };
  }
}
