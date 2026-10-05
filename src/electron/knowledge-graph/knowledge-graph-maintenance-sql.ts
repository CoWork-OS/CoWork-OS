/**
 * Knowledge graph data-quality SQL (audit DATA-10): the schema upgrade that makes entity
 * names unique case-insensitively, the entity merge it needs, and the phases of the
 * one-time cleanup of noise the old extraction produced (KnowledgeGraphCleanup.ts runs
 * them). Plain synchronous SQL over the connection it is given, free of Electron and
 * service imports so the database worker can load it; each cleanup phase runs as one
 * memory-domain transaction unit (knowledge-graph-units.ts).
 */

import type Database from "better-sqlite3";
import { createHash } from "crypto";
import {
  canonicalTechnologyName,
  domainOrganizationLabel,
  isAutomatedSenderAddress,
  isFreeMailDomain,
  isNoisyAutoTechnologyName,
  kgSourceRank,
  KG_FREE_MAIL_ORGANIZATION_NAMES,
  normalizeEntityName,
  normalizeKgSource,
  strongerKgSource,
} from "./kg-extraction";

export const KG_CLEANUP_MIGRATION_KEY = "kg_quality_cleanup_v1";

export const KG_NORMALIZED_NAME_INDEX = "idx_kg_entities_normalized_unique";

export const KG_CLEANUP_PHASES = [
  "merge_case_duplicates",
  "noisy_technologies",
  "free_mail_organizations",
  "subdomain_organizations",
  "automated_senders",
  "dedupe_observations",
] as const;
export type KGCleanupPhase = (typeof KG_CLEANUP_PHASES)[number];

export interface KGCleanupCounts {
  /** Duplicate entities merged into a canonical one (Go/go/GO → Go). */
  caseDuplicatesMerged: number;
  /** Automatic technology entities that were ambiguous English words. */
  noisyTechnologiesDeleted: number;
  /** Free-mail / relay provider organizations deleted. */
  freeMailOrganizationsDeleted: number;
  /** Automatic `works_at` edges to free-mail organizations deleted. */
  freeMailEdgesDeleted: number;
  /** Organizations named after a mail subdomain ("News", "Accounts") renamed or merged. */
  subdomainOrganizationsFixed: number;
  /** Mailbox person entities of automated senders (noreply, notifications, ...) deleted. */
  automatedSendersDeleted: number;
  /** Duplicate observations deleted. */
  observationsDeduped: number;
}

export function emptyKGCleanupCounts(): KGCleanupCounts {
  return {
    caseDuplicatesMerged: 0,
    noisyTechnologiesDeleted: 0,
    freeMailOrganizationsDeleted: 0,
    freeMailEdgesDeleted: 0,
    subdomainOrganizationsFixed: 0,
    automatedSendersDeleted: 0,
    observationsDeduped: 0,
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────

function tableExists(db: Database.Database, name: string): boolean {
  return Boolean(
    db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name),
  );
}

function columnNames(db: Database.Database, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name?: string }>;
  return new Set(rows.map((row) => String(row.name || "")));
}

function parseJsonObject(value: unknown): Record<string, unknown> {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/** Whitespace-collapsed, lower-cased observation text, for duplicate detection. */
export function normalizeObservationContent(content: string): string {
  return String(content ?? "")
    .normalize("NFKC")
    .replace(/\s+/g, " ")
    .trim()
    .toLocaleLowerCase("en-US");
}

/**
 * The dedupe key of an observation: the caller's fingerprint (a mailbox event's) when it
 * has one, otherwise a hash of the normalized content.
 */
export function observationFingerprint(content: string, fingerprint?: string): string {
  const explicit = typeof fingerprint === "string" ? fingerprint.trim() : "";
  if (explicit) return explicit.slice(0, 200);
  return `content:${createHash("sha256").update(normalizeObservationContent(content)).digest("hex").slice(0, 32)}`;
}

// ─── Schema upgrade ────────────────────────────────────────────────────

const ensuredConnections = new WeakSet<Database.Database>();

/**
 * Add the data-quality columns (entity `normalized_name`, `description_source`,
 * `last_seen_at`; observation `fingerprint`), backfill them, merge entities that differ
 * only in case, and create the unique index on (workspace, type, normalized name).
 * Idempotent and cheap once done (cached per connection). Returns how many duplicate
 * entities were merged.
 */
export function ensureKnowledgeGraphQualitySchema(db: Database.Database): number {
  if (ensuredConnections.has(db)) return 0;
  if (!tableExists(db, "kg_entities")) return 0;
  let merged = 0;
  db.transaction(() => {
    const entityColumns = columnNames(db, "kg_entities");
    if (!entityColumns.has("normalized_name")) {
      db.exec("ALTER TABLE kg_entities ADD COLUMN normalized_name TEXT");
    }
    if (!entityColumns.has("description_source")) {
      db.exec("ALTER TABLE kg_entities ADD COLUMN description_source TEXT");
    }
    if (!entityColumns.has("last_seen_at")) {
      db.exec("ALTER TABLE kg_entities ADD COLUMN last_seen_at INTEGER");
    }
    const pending = db
      .prepare("SELECT id, name FROM kg_entities WHERE normalized_name IS NULL")
      .all() as Array<{ id: string; name: string }>;
    if (pending.length > 0) {
      const setName = db.prepare("UPDATE kg_entities SET normalized_name = ? WHERE id = ?");
      for (const row of pending) setName.run(normalizeEntityName(row.name), row.id);
    }
    // Rows from before source tracking: the description came from the entity's creator.
    db.exec(`
      UPDATE kg_entities SET description_source = COALESCE(source, 'manual')
      WHERE description_source IS NULL AND description IS NOT NULL;
      UPDATE kg_entities SET last_seen_at = COALESCE(updated_at, created_at)
      WHERE last_seen_at IS NULL;
    `);

    if (tableExists(db, "kg_observations")) {
      if (!columnNames(db, "kg_observations").has("fingerprint")) {
        db.exec("ALTER TABLE kg_observations ADD COLUMN fingerprint TEXT");
      }
      const observations = db
        .prepare("SELECT id, content FROM kg_observations WHERE fingerprint IS NULL")
        .all() as Array<{ id: string; content: string }>;
      if (observations.length > 0) {
        const setFingerprint = db.prepare(
          "UPDATE kg_observations SET fingerprint = ? WHERE id = ?",
        );
        for (const row of observations) {
          setFingerprint.run(observationFingerprint(row.content), row.id);
        }
      }
      db.exec(
        "CREATE INDEX IF NOT EXISTS idx_kg_observations_fingerprint ON kg_observations(entity_id, fingerprint)",
      );
    }

    const hasIndex = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?")
      .get(KG_NORMALIZED_NAME_INDEX);
    if (!hasIndex) {
      merged = mergeCaseDuplicates(db);
      db.exec(
        `CREATE UNIQUE INDEX IF NOT EXISTS ${KG_NORMALIZED_NAME_INDEX}
           ON kg_entities(workspace_id, entity_type_id, normalized_name)`,
      );
    }
    db.exec(
      "CREATE INDEX IF NOT EXISTS idx_kg_entities_last_seen ON kg_entities(workspace_id, source, last_seen_at)",
    );
  })();
  ensuredConnections.add(db);
  return merged;
}

// ─── Entity merge ──────────────────────────────────────────────────────

interface EntityRow {
  id: string;
  workspace_id: string;
  entity_type_id: string;
  name: string;
  description: string | null;
  description_source: string | null;
  properties: string | null;
  confidence: number | null;
  source: string | null;
  source_task_id: string | null;
  created_at: number;
  updated_at: number;
  last_seen_at: number | null;
  type_name?: string | null;
  links?: number;
}

function linkCount(db: Database.Database, entityId: string): number {
  const edges = (
    db
      .prepare(
        "SELECT COUNT(*) AS n FROM kg_edges WHERE source_entity_id = ? OR target_entity_id = ?",
      )
      .get(entityId, entityId) as { n: number }
  ).n;
  const observations = tableExists(db, "kg_observations")
    ? (
        db
          .prepare("SELECT COUNT(*) AS n FROM kg_observations WHERE entity_id = ?")
          .get(entityId) as {
          n: number;
        }
      ).n
    : 0;
  return edges + observations;
}

/** Canonical first: highest source precedence, then most linked, then oldest. */
function rankForCanonical(rows: EntityRow[]): EntityRow[] {
  return [...rows].sort(
    (a, b) =>
      kgSourceRank(b.source) - kgSourceRank(a.source) ||
      (b.links ?? 0) - (a.links ?? 0) ||
      a.created_at - b.created_at ||
      a.id.localeCompare(b.id),
  );
}

function pickDisplayName(canonical: EntityRow, rows: EntityRow[]): string {
  if (canonical.type_name === "technology") {
    const known = canonicalTechnologyName(canonical.name);
    if (known) return known;
  }
  // Prefer a cased spelling over an all-lowercase one ("Electron" over "electron").
  if (canonical.name !== canonical.name.toLowerCase()) return canonical.name;
  const cased = rows.find((row) => row.name !== row.name.toLowerCase());
  return (cased ?? canonical).name.trim();
}

function pickDescription(
  canonical: EntityRow,
  rows: EntityRow[],
): { description: string | null; source: string | null } {
  const withText = rows.filter((row) => (row.description ?? "").trim());
  if (withText.length === 0) return { description: null, source: null };
  const best = [...withText].sort(
    (a, b) =>
      kgSourceRank(b.description_source ?? b.source) -
        kgSourceRank(a.description_source ?? a.source) ||
      Number(b.id === canonical.id) - Number(a.id === canonical.id) ||
      (b.description ?? "").length - (a.description ?? "").length,
  )[0];
  return {
    description: best.description,
    source: normalizeKgSource(best.description_source ?? best.source),
  };
}

/**
 * Merge `duplicateIds` into `canonicalId` (same workspace and type): edges and
 * observations move to the canonical entity (self-loops and duplicate current edges are
 * dropped), the best description by source precedence is kept, properties merge with the
 * higher-precedence source winning, and the duplicates are deleted.
 */
export function mergeKnowledgeGraphEntities(
  db: Database.Database,
  canonicalId: string,
  duplicateIds: string[],
): void {
  const ids = [canonicalId, ...duplicateIds.filter((id) => id !== canonicalId)];
  if (ids.length < 2) return;
  const placeholders = ids.map(() => "?").join(",");
  const rows = db
    .prepare(
      `SELECT e.*, t.name AS type_name FROM kg_entities e
       LEFT JOIN kg_entity_types t ON t.id = e.entity_type_id
       WHERE e.id IN (${placeholders})`,
    )
    .all(...ids) as EntityRow[];
  const canonical = rows.find((row) => row.id === canonicalId);
  if (!canonical) return;
  const duplicates = rows.filter((row) => row.id !== canonicalId);
  if (duplicates.length === 0) return;
  const duplicateSet = new Set(duplicates.map((row) => row.id));
  const all = [canonical, ...duplicates];

  // Edges: re-point to the canonical entity.
  const edges = db
    .prepare(
      `SELECT * FROM kg_edges
       WHERE source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders})`,
    )
    .all(...ids, ...ids) as Array<{
    id: string;
    workspace_id: string;
    source_entity_id: string;
    target_entity_id: string;
    edge_type: string;
    confidence: number | null;
    valid_to: number | null;
  }>;
  const deleteEdge = db.prepare("DELETE FROM kg_edges WHERE id = ?");
  const moveEdge = db.prepare(
    "UPDATE kg_edges SET source_entity_id = ?, target_entity_id = ? WHERE id = ?",
  );
  const findCurrent = db.prepare(
    `SELECT id, confidence FROM kg_edges
     WHERE workspace_id = ? AND source_entity_id = ? AND target_entity_id = ? AND edge_type = ?
       AND valid_to IS NULL AND id != ?
     LIMIT 1`,
  );
  const raiseConfidence = db.prepare(
    "UPDATE kg_edges SET confidence = MAX(COALESCE(confidence, 0), ?) WHERE id = ?",
  );
  for (const edge of edges) {
    const source = duplicateSet.has(edge.source_entity_id) ? canonicalId : edge.source_entity_id;
    const target = duplicateSet.has(edge.target_entity_id) ? canonicalId : edge.target_entity_id;
    if (source === edge.source_entity_id && target === edge.target_entity_id) continue;
    if (source === target) {
      deleteEdge.run(edge.id);
      continue;
    }
    if (edge.valid_to === null || edge.valid_to === undefined) {
      const current = findCurrent.get(
        edge.workspace_id,
        source,
        target,
        edge.edge_type,
        edge.id,
      ) as { id: string } | undefined;
      if (current) {
        raiseConfidence.run(edge.confidence ?? 0, current.id);
        deleteEdge.run(edge.id);
        continue;
      }
    }
    moveEdge.run(source, target, edge.id);
  }

  if (tableExists(db, "kg_observations")) {
    db.prepare(
      `UPDATE kg_observations SET entity_id = ? WHERE entity_id IN (${duplicates.map(() => "?").join(",")})`,
    ).run(canonicalId, ...duplicates.map((row) => row.id));
    dedupeEntityObservations(db, canonicalId);
  }
  if (tableExists(db, "contact_identities")) {
    db.prepare(
      `UPDATE contact_identities SET kg_entity_id = ? WHERE kg_entity_id IN (${duplicates.map(() => "?").join(",")})`,
    ).run(canonicalId, ...duplicates.map((row) => row.id));
  }

  const name = pickDisplayName(canonical, all);
  const description = pickDescription(canonical, all);
  const properties: Record<string, unknown> = {};
  // Lower precedence first, so the higher-precedence source wins on conflicts.
  for (const row of [...all].sort(
    (a, b) =>
      kgSourceRank(a.source) - kgSourceRank(b.source) ||
      Number(a.id === canonicalId) - Number(b.id === canonicalId),
  )) {
    Object.assign(properties, parseJsonObject(row.properties));
  }
  const source = all.reduce<string>((acc, row) => strongerKgSource(acc, row.source), "auto");
  const confidence = Math.max(...all.map((row) => row.confidence ?? 0));
  const createdAt = Math.min(...all.map((row) => row.created_at));
  const updatedAt = Math.max(...all.map((row) => row.updated_at));
  const lastSeenAt = Math.max(...all.map((row) => row.last_seen_at ?? row.updated_at ?? 0));

  db.prepare(`DELETE FROM kg_entities WHERE id IN (${duplicates.map(() => "?").join(",")})`).run(
    ...duplicates.map((row) => row.id),
  );
  db.prepare(
    `UPDATE kg_entities
     SET name = ?, normalized_name = ?, description = ?, description_source = ?, properties = ?,
         confidence = ?, source = ?, source_task_id = COALESCE(source_task_id, ?),
         created_at = ?, updated_at = ?, last_seen_at = ?
     WHERE id = ?`,
  ).run(
    name,
    normalizeEntityName(name),
    description.description,
    description.source,
    JSON.stringify(properties),
    confidence,
    source,
    duplicates.find((row) => row.source_task_id)?.source_task_id ?? null,
    createdAt,
    updatedAt,
    lastSeenAt,
    canonicalId,
  );
}

/** Merge every group of entities with the same workspace, type and normalized name. */
export function mergeCaseDuplicates(db: Database.Database): number {
  const rows = db
    .prepare(
      `SELECT e.*, t.name AS type_name FROM kg_entities e
       LEFT JOIN kg_entity_types t ON t.id = e.entity_type_id
       ORDER BY e.workspace_id, e.entity_type_id`,
    )
    .all() as EntityRow[];
  const groups = new Map<string, EntityRow[]>();
  for (const row of rows) {
    const key = `${row.workspace_id}\u0000${row.entity_type_id}\u0000${normalizeEntityName(row.name)}`;
    const group = groups.get(key);
    if (group) group.push(row);
    else groups.set(key, [row]);
  }
  let merged = 0;
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    for (const row of group) row.links = linkCount(db, row.id);
    const [canonical, ...duplicates] = rankForCanonical(group);
    mergeKnowledgeGraphEntities(
      db,
      canonical.id,
      duplicates.map((row) => row.id),
    );
    merged += duplicates.length;
  }
  return merged;
}

// ─── Observation dedupe ────────────────────────────────────────────────

/**
 * Delete observations of `entityId` that repeat another one (same fingerprint or same
 * normalized text), keeping the highest-precedence source, then the oldest.
 */
export function dedupeEntityObservations(db: Database.Database, entityId: string): number {
  const rows = db
    .prepare("SELECT id, content, source, created_at FROM kg_observations WHERE entity_id = ?")
    .all(entityId) as Array<{
    id: string;
    content: string;
    source: string | null;
    created_at: number;
  }>;
  return deleteDuplicateObservations(db, rows);
}

function deleteDuplicateObservations(
  db: Database.Database,
  rows: Array<{ id: string; content: string; source: string | null; created_at: number }>,
): number {
  if (rows.length < 2) return 0;
  const ordered = [...rows].sort(
    (a, b) =>
      kgSourceRank(b.source) - kgSourceRank(a.source) ||
      a.created_at - b.created_at ||
      a.id.localeCompare(b.id),
  );
  const seen = new Set<string>();
  const remove: string[] = [];
  for (const row of ordered) {
    const key = normalizeObservationContent(row.content);
    if (seen.has(key)) remove.push(row.id);
    else seen.add(key);
  }
  const del = db.prepare("DELETE FROM kg_observations WHERE id = ?");
  for (const id of remove) del.run(id);
  return remove.length;
}

// ─── Cleanup phases ────────────────────────────────────────────────────

/** Entities created automatically that no manual or agent edge or observation touches. */
const UNPROTECTED_AUTO_ENTITY = `
  e.source = 'auto'
  AND NOT EXISTS (
    SELECT 1 FROM kg_edges g
    WHERE (g.source_entity_id = e.id OR g.target_entity_id = e.id)
      AND COALESCE(g.source, 'manual') != 'auto'
  )
  AND NOT EXISTS (
    SELECT 1 FROM kg_observations o
    WHERE o.entity_id = e.id AND COALESCE(o.source, 'manual') != 'auto'
  )`;

function deleteEntities(db: Database.Database, ids: string[]): number {
  if (ids.length === 0) return 0;
  const delEdges = db.prepare(
    "DELETE FROM kg_edges WHERE source_entity_id = ? OR target_entity_id = ?",
  );
  const delObs = db.prepare("DELETE FROM kg_observations WHERE entity_id = ?");
  const delEntity = db.prepare("DELETE FROM kg_entities WHERE id = ?");
  const unlink = tableExists(db, "contact_identities")
    ? db.prepare("UPDATE contact_identities SET kg_entity_id = NULL WHERE kg_entity_id = ?")
    : null;
  // Never delete a manual or agent entity, whatever the caller selected.
  const isAuto = db.prepare("SELECT 1 FROM kg_entities WHERE id = ? AND source = 'auto'");
  let deleted = 0;
  for (const id of ids) {
    if (!isAuto.get(id)) continue;
    delEdges.run(id, id);
    delObs.run(id);
    unlink?.run(id);
    deleted += delEntity.run(id).changes;
  }
  return deleted;
}

function entitiesOfType(db: Database.Database, typeName: string, where: string): EntityRow[] {
  return db
    .prepare(
      `SELECT e.*, t.name AS type_name FROM kg_entities e
       JOIN kg_entity_types t ON t.id = e.entity_type_id
       WHERE t.name = ? AND ${where}`,
    )
    .all(typeName) as EntityRow[];
}

function runNoisyTechnologies(db: Database.Database, counts: KGCleanupCounts): void {
  const noisy = entitiesOfType(db, "technology", UNPROTECTED_AUTO_ENTITY).filter((row) =>
    isNoisyAutoTechnologyName(row.name),
  );
  counts.noisyTechnologiesDeleted += deleteEntities(
    db,
    noisy.map((row) => row.id),
  );
}

function mailboxDomain(row: EntityRow): string | undefined {
  const domain = parseJsonObject(row.properties).domain;
  return typeof domain === "string" && domain.includes(".")
    ? domain.trim().toLowerCase()
    : undefined;
}

function isFreeMailOrganization(row: EntityRow): boolean {
  const domain = mailboxDomain(row);
  if (domain) return isFreeMailDomain(domain);
  return (
    parseJsonObject(row.properties).source === "mailbox" &&
    KG_FREE_MAIL_ORGANIZATION_NAMES.has(normalizeEntityName(row.name))
  );
}

function runFreeMailOrganizations(db: Database.Database, counts: KGCleanupCounts): void {
  const organizations = entitiesOfType(db, "organization", "e.source = 'auto'").filter(
    isFreeMailOrganization,
  );
  if (organizations.length === 0) return;
  const deletable = new Set(
    entitiesOfType(db, "organization", UNPROTECTED_AUTO_ENTITY).map((row) => row.id),
  );
  const delWorksAt = db.prepare(
    "DELETE FROM kg_edges WHERE target_entity_id = ? AND edge_type = 'works_at' AND source = 'auto'",
  );
  const toDelete: string[] = [];
  for (const org of organizations) {
    counts.freeMailEdgesDeleted += delWorksAt.run(org.id).changes;
    if (deletable.has(org.id)) toDelete.push(org.id);
  }
  counts.freeMailOrganizationsDeleted += deleteEntities(db, toDelete);
}

/**
 * The old ingest named organizations after the first domain label, so mail from
 * `news.acme.com` made an organization "News". Rename those to the registrable label
 * ("Acme"), merging into an existing organization of that name.
 */
function runSubdomainOrganizations(db: Database.Database, counts: KGCleanupCounts): void {
  const organizations = entitiesOfType(db, "organization", "e.source = 'auto'");
  const rename = db.prepare(
    `UPDATE kg_entities
     SET name = ?, normalized_name = ?,
         description = CASE WHEN COALESCE(description_source, source) = 'auto' THEN ? ELSE description END
     WHERE id = ?`,
  );
  const findByName = db.prepare(
    `SELECT id FROM kg_entities
     WHERE workspace_id = ? AND entity_type_id = ? AND normalized_name = ? AND id != ?
     LIMIT 1`,
  );
  for (const org of organizations) {
    const domain = mailboxDomain(org);
    if (!domain || parseJsonObject(org.properties).source !== "mailbox") continue;
    const firstLabel = domain.split(".")[0];
    const label = domainOrganizationLabel(domain);
    if (!label || label === firstLabel) continue;
    if (normalizeEntityName(org.name) !== normalizeEntityName(firstLabel)) continue;
    const name = label.charAt(0).toUpperCase() + label.slice(1);
    const key = normalizeEntityName(name);
    const existing = findByName.get(org.workspace_id, org.entity_type_id, key, org.id) as
      | { id: string }
      | undefined;
    if (existing) {
      mergeKnowledgeGraphEntities(db, existing.id, [org.id]);
    } else {
      rename.run(name, key, `Mailbox contact organization ${label}`, org.id);
    }
    counts.subdomainOrganizationsFixed += 1;
  }
}

/** The address of a mailbox person: its `email` property, else its "Email contact <x>" description. */
function mailboxPersonEmail(row: EntityRow): string | undefined {
  const email = parseJsonObject(row.properties).email;
  if (typeof email === "string" && email.includes("@")) return email.trim();
  const match = /^Email contact (\S+@\S+)$/.exec(String(row.description ?? "").trim());
  return match?.[1];
}

/**
 * The old ingest made a person of every sender, including noreply and notification
 * addresses. Delete those (automatic mailbox rows only, unprotected) with their edges and
 * observations.
 */
function runAutomatedSenders(db: Database.Database, counts: KGCleanupCounts): void {
  const senders = entitiesOfType(db, "person", UNPROTECTED_AUTO_ENTITY).filter(
    (row) =>
      parseJsonObject(row.properties).source === "mailbox" &&
      isAutomatedSenderAddress(mailboxPersonEmail(row)),
  );
  counts.automatedSendersDeleted += deleteEntities(
    db,
    senders.map((row) => row.id),
  );
}

function runDedupeObservations(db: Database.Database, counts: KGCleanupCounts): void {
  const rows = db
    .prepare(
      "SELECT id, entity_id, content, source, created_at FROM kg_observations ORDER BY entity_id",
    )
    .all() as Array<{
    id: string;
    entity_id: string;
    content: string;
    source: string | null;
    created_at: number;
  }>;
  let start = 0;
  for (let i = 1; i <= rows.length; i++) {
    if (i === rows.length || rows[i].entity_id !== rows[start].entity_id) {
      counts.observationsDeduped += deleteDuplicateObservations(db, rows.slice(start, i));
      start = i;
    }
  }
}

/** Run one cleanup phase (idempotent). */
export function runKGCleanupPhase(db: Database.Database, phase: KGCleanupPhase): KGCleanupCounts {
  const counts = emptyKGCleanupCounts();
  if (!tableExists(db, "kg_entities") || !tableExists(db, "kg_observations")) return counts;
  // Normally a no-op (the schema upgrade ran at startup); on a connection that has not
  // upgraded yet, its duplicate merge counts here.
  counts.caseDuplicatesMerged += ensureKnowledgeGraphQualitySchema(db);
  switch (phase) {
    case "merge_case_duplicates":
      counts.caseDuplicatesMerged += mergeCaseDuplicates(db);
      break;
    case "noisy_technologies":
      runNoisyTechnologies(db, counts);
      break;
    case "free_mail_organizations":
      runFreeMailOrganizations(db, counts);
      break;
    case "subdomain_organizations":
      runSubdomainOrganizations(db, counts);
      break;
    case "automated_senders":
      runAutomatedSenders(db, counts);
      break;
    case "dedupe_observations":
      runDedupeObservations(db, counts);
      break;
  }
  return counts;
}

function ensureMarkerTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

/** Whether the one-time cleanup still has to run (no marker yet). */
export function isKGCleanupPending(db: Database.Database): boolean {
  ensureMarkerTable(db);
  return !db.prepare("SELECT 1 FROM maintenance_state WHERE key = ?").get(KG_CLEANUP_MIGRATION_KEY);
}

/** Record the completion marker with the run's counts. */
export function recordKGCleanup(db: Database.Database, counts: KGCleanupCounts, now: number): void {
  ensureMarkerTable(db);
  db.prepare(
    `INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(KG_CLEANUP_MIGRATION_KEY, JSON.stringify({ counts, completedAt: now }), now);
}
