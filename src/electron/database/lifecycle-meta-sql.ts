import type Database from "better-sqlite3";
import type { LifecycleKind, LifecycleMeta, LifecycleRef } from "../../shared/types";

/**
 * Lifecycle metadata of generated software (agent-first roadmap WP9): who owns an item, what it
 * depends on, when it was last used, and whether it was retired or kept. One row per
 * (kind, item id), created on first use or first edit. Nothing here deletes an item. Runs only as
 * storage-domain units behind `LifecycleMetaRepository`.
 */
export interface LifecycleMetaPatch {
  kind: LifecycleKind;
  id: string;
  /** `null` clears; `undefined` leaves the stored value. */
  owner?: string | null;
  createdByTask?: string | null;
  dependsOn?: LifecycleRef[];
  protects?: string | null;
  evidence?: string | null;
  at: number;
}

const LIFECYCLE_KINDS: readonly LifecycleKind[] = [
  "skill",
  "playbook",
  "automation",
  "trigger",
  "rule",
];
const MAX_LIST = 5_000;
const MAX_ID = 300;
const MAX_TEXT = 500;
const MAX_DEPENDENCIES = 20;

type Row = Record<string, unknown>;

function assertKind(kind: unknown): asserts kind is LifecycleKind {
  if (!LIFECYCLE_KINDS.includes(kind as LifecycleKind)) {
    throw new Error(`Unknown lifecycle kind: ${String(kind)}`);
  }
}

function itemId(id: unknown): string {
  const value = typeof id === "string" ? id.trim() : "";
  if (!value || value.length > MAX_ID) throw new Error("A lifecycle item id is required");
  return value;
}

function optionalText(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** `undefined` keeps the column, `null` or "" clears it, text is trimmed and bounded. */
function textPatch(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  const trimmed = (value ?? "").trim();
  return trimmed ? trimmed.slice(0, MAX_TEXT) : null;
}

function normalizeRefs(refs: LifecycleRef[]): LifecycleRef[] {
  const seen = new Set<string>();
  const out: LifecycleRef[] = [];
  for (const ref of refs) {
    if (ref?.kind !== "workspace" && !LIFECYCLE_KINDS.includes(ref?.kind as LifecycleKind))
      continue;
    const id = typeof ref.id === "string" ? ref.id.trim().slice(0, MAX_ID) : "";
    const key = `${ref.kind}:${id}`;
    if (!id || seen.has(key)) continue;
    seen.add(key);
    out.push({ kind: ref.kind, id });
    if (out.length >= MAX_DEPENDENCIES) break;
  }
  return out;
}

function parseRefs(value: unknown): LifecycleRef[] {
  if (typeof value !== "string" || !value) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? normalizeRefs(parsed) : [];
  } catch {
    return [];
  }
}

function mapRow(row: Row): LifecycleMeta {
  return {
    kind: String(row.kind) as LifecycleKind,
    id: String(row.item_id),
    ...(optionalText(row.owner) ? { owner: String(row.owner) } : {}),
    ...(optionalText(row.created_by_task) ? { createdByTask: String(row.created_by_task) } : {}),
    ...(typeof row.last_used_at === "number" ? { lastUsedAt: row.last_used_at } : {}),
    useCount: Number(row.use_count) || 0,
    dependsOn: parseRefs(row.depends_on_json),
    ...(optionalText(row.protects) ? { protects: String(row.protects) } : {}),
    ...(optionalText(row.evidence) ? { evidence: String(row.evidence) } : {}),
    ...(typeof row.retired_at === "number" ? { retiredAt: row.retired_at } : {}),
    ...(typeof row.kept_at === "number" ? { keptAt: row.kept_at } : {}),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

export class LifecycleMetaStore {
  constructor(private readonly db: Database.Database) {}

  /** One use of an item: count it and move its last-used time forward (never back). */
  recordUse(input: { kind: LifecycleKind; id: string; at: number }): void {
    assertKind(input.kind);
    this.db
      .prepare(
        `INSERT INTO lifecycle_meta (kind, item_id, use_count, last_used_at, created_at, updated_at)
         VALUES (?, ?, 1, ?, ?, ?)
         ON CONFLICT(kind, item_id) DO UPDATE SET
           use_count = use_count + 1,
           last_used_at = MAX(COALESCE(last_used_at, 0), excluded.last_used_at),
           updated_at = excluded.updated_at`,
      )
      .run(input.kind, itemId(input.id), input.at, input.at, input.at);
  }

  get(kind: LifecycleKind, id: string): LifecycleMeta | undefined {
    assertKind(kind);
    const row = this.db
      .prepare("SELECT * FROM lifecycle_meta WHERE kind = ? AND item_id = ?")
      .get(kind, itemId(id)) as Row | undefined;
    return row ? mapRow(row) : undefined;
  }

  /** Every row (bounded), optionally of some kinds only. */
  list(input: { kinds?: LifecycleKind[] } = {}): LifecycleMeta[] {
    const kinds = (input.kinds ?? []).filter((kind) => LIFECYCLE_KINDS.includes(kind));
    const rows = (
      kinds.length > 0
        ? this.db
            .prepare(
              `SELECT * FROM lifecycle_meta WHERE kind IN (${kinds.map(() => "?").join(", ")})
               ORDER BY updated_at DESC LIMIT ?`,
            )
            .all(...kinds, MAX_LIST)
        : this.db
            .prepare("SELECT * FROM lifecycle_meta ORDER BY updated_at DESC LIMIT ?")
            .all(MAX_LIST)
    ) as Row[];
    return rows.map(mapRow);
  }

  /** Ids of retired items of one kind, for callers that must skip them (playbook recall). */
  listRetiredIds(kind: LifecycleKind): string[] {
    assertKind(kind);
    return (
      this.db
        .prepare(
          "SELECT item_id FROM lifecycle_meta WHERE kind = ? AND retired_at IS NOT NULL LIMIT ?",
        )
        .all(kind, MAX_LIST) as Row[]
    ).map((row) => String(row.item_id));
  }

  /** Set owner, origin task, dependencies, or a rule's protects/evidence. */
  setMeta(patch: LifecycleMetaPatch): LifecycleMeta {
    assertKind(patch.kind);
    const id = itemId(patch.id);
    this.ensureRow(patch.kind, id, patch.at);
    const sets: string[] = ["updated_at = ?"];
    const values: unknown[] = [patch.at];
    const text: Array<[string, string | null | undefined]> = [
      ["owner", textPatch(patch.owner)],
      ["created_by_task", textPatch(patch.createdByTask)],
      ["protects", textPatch(patch.protects)],
      ["evidence", textPatch(patch.evidence)],
    ];
    for (const [column, value] of text) {
      if (value === undefined) continue;
      sets.push(`${column} = ?`);
      values.push(value);
    }
    if (patch.dependsOn !== undefined) {
      sets.push("depends_on_json = ?");
      values.push(JSON.stringify(normalizeRefs(patch.dependsOn)));
    }
    this.db
      .prepare(`UPDATE lifecycle_meta SET ${sets.join(", ")} WHERE kind = ? AND item_id = ?`)
      .run(...values, patch.kind, id);
    return this.get(patch.kind, id)!;
  }

  /** Mark an item retired. The item's own archive or disable is the caller's job. */
  retire(input: { kind: LifecycleKind; id: string; at: number }): LifecycleMeta {
    assertKind(input.kind);
    const id = itemId(input.id);
    this.ensureRow(input.kind, id, input.at);
    this.db
      .prepare(
        "UPDATE lifecycle_meta SET retired_at = ?, updated_at = ? WHERE kind = ? AND item_id = ?",
      )
      .run(input.at, input.at, input.kind, id);
    return this.get(input.kind, id)!;
  }

  /** Keep an item: the idle timer restarts now, and a retired mark is cleared. */
  keep(input: { kind: LifecycleKind; id: string; at: number }): LifecycleMeta {
    assertKind(input.kind);
    const id = itemId(input.id);
    this.ensureRow(input.kind, id, input.at);
    this.db
      .prepare(
        `UPDATE lifecycle_meta SET kept_at = ?, retired_at = NULL, updated_at = ?
         WHERE kind = ? AND item_id = ?`,
      )
      .run(input.at, input.at, input.kind, id);
    return this.get(input.kind, id)!;
  }

  private ensureRow(kind: LifecycleKind, id: string, at: number): void {
    this.db
      .prepare(
        `INSERT OR IGNORE INTO lifecycle_meta (kind, item_id, use_count, created_at, updated_at)
         VALUES (?, ?, 0, ?, ?)`,
      )
      .run(kind, id, at, at);
  }
}
