import type Database from "better-sqlite3";
import {
  commitSecureSettingsWrites,
  readSecureSettingsRevision,
  type SecureSettingsRecord,
} from "../database/secure-settings-sql";

/**
 * Pulse's transaction groups as SQL only (async SQLite migration plan, DB5). The host
 * decrypts the Pulse settings, decides, re-encrypts and builds packages; these functions
 * then compare the settings row revision the host read and apply the settings row, the
 * consent windows, the outbox and the delivery lease atomically. They run on the host
 * connection inside an IMMEDIATE transaction, or in the database worker, and never call
 * the keychain, the network or a timer.
 */

export const PULSE_SETTINGS_CATEGORY = "pulse";

/** Table changes that commit together with a Pulse settings decision. */
export type PulseOp =
  | { kind: "closeConsentWindows"; now: number }
  | { kind: "openConsentWindow"; now: number }
  | { kind: "deleteConsentWindows" }
  | { kind: "clearOutbox" }
  | { kind: "deleteSentDaysExcept"; installationId: string }
  | { kind: "deleteSentDaysFor"; installationId: string }
  | {
      kind: "recordDelivered";
      packageId: string;
      installationId: string;
      periodStart: string;
      now: number;
    }
  | { kind: "incrementAttempt"; packageId: string }
  | { kind: "releaseLease"; owner: string };

export interface PulseCommitRequest {
  /** The settings row revision the host decided from; `"any"` skips the check. */
  expectedRevision: number | null | "any";
  /** New settings ciphertext, or `null` to leave the settings row as it is. */
  record: SecureSettingsRecord | null;
  ops: PulseOp[];
  /** Commit only while `owner` holds a live delivery lease; optionally renew it. */
  lease?: { owner: string; now: number; renewUntil?: number };
  /** The stored row was unreadable: back its ciphertext up before replacing it. */
  backupUnreadableAs?: string;
}

export type PulseCommitResult =
  | { status: "committed"; revision: number | null }
  | { status: "conflict" }
  | { status: "lease_lost" };

export interface PulseClaimRequest {
  expectedRevision: number | null;
  installationId: string;
  /** Package for today, built by the host outside any transaction; queued if unsent. */
  candidate?: { packageId: string; periodStart: string; payloadJson: string; createdAt: number };
  dayPackageId: string;
  owner: string;
  /** The consent revision recorded on the lease row. */
  consentRevision: number;
  now: number;
  leaseMs: number;
}

export interface PulseQueueHead {
  package_id: string;
  period_start: string;
  payload_json: string;
}

export type PulseClaimResult =
  | { status: "conflict" }
  | { status: "busy" }
  | { status: "no_eligible_day" }
  | { status: "already_sent" }
  | { status: "claimed"; head: PulseQueueHead };

export function ensurePulseSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS pulse_consent_windows (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      started_at INTEGER NOT NULL,
      ended_at INTEGER
    );
    CREATE TABLE IF NOT EXISTS pulse_outbox (
      package_id TEXT PRIMARY KEY,
      period_start TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      attempt_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE IF NOT EXISTS pulse_sent_days (
      package_id TEXT PRIMARY KEY,
      installation_id TEXT NOT NULL,
      period_start TEXT NOT NULL,
      acknowledged_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS pulse_delivery_lease (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      owner TEXT NOT NULL,
      revision INTEGER NOT NULL,
      expires_at INTEGER NOT NULL
    );
  `);
  const outboxColumns = new Set(
    (db.pragma("table_info(pulse_outbox)") as Array<{ name: string }>).map((row) => row.name),
  );
  if (!outboxColumns.has("installation_id")) {
    try {
      db.exec("ALTER TABLE pulse_outbox ADD COLUMN installation_id TEXT");
    } catch (error) {
      // Another process sharing this profile may have added it first.
      if (!/duplicate column/i.test(error instanceof Error ? error.message : String(error))) {
        throw error;
      }
    }
    // Queued rows from older builds carry their identity only inside the payload.
    db.exec(
      "UPDATE pulse_outbox SET installation_id = json_extract(payload_json, '$.installationId') WHERE installation_id IS NULL",
    );
  }
}

function applyPulseOp(db: Database.Database, op: PulseOp): void {
  switch (op.kind) {
    case "closeConsentWindows":
      db.prepare("UPDATE pulse_consent_windows SET ended_at = ? WHERE ended_at IS NULL").run(
        op.now,
      );
      return;
    case "openConsentWindow":
      db.prepare("INSERT INTO pulse_consent_windows (started_at) VALUES (?)").run(op.now);
      return;
    case "deleteConsentWindows":
      db.prepare("DELETE FROM pulse_consent_windows").run();
      return;
    case "clearOutbox":
      db.prepare("DELETE FROM pulse_outbox").run();
      return;
    case "deleteSentDaysExcept":
      db.prepare("DELETE FROM pulse_sent_days WHERE installation_id <> ?").run(op.installationId);
      return;
    case "deleteSentDaysFor":
      db.prepare("DELETE FROM pulse_sent_days WHERE installation_id = ?").run(op.installationId);
      return;
    case "recordDelivered":
      db.prepare(
        `INSERT OR IGNORE INTO pulse_sent_days
           (package_id, installation_id, period_start, acknowledged_at) VALUES (?, ?, ?, ?)`,
      ).run(op.packageId, op.installationId, op.periodStart, op.now);
      db.prepare("DELETE FROM pulse_outbox WHERE package_id = ?").run(op.packageId);
      return;
    case "incrementAttempt":
      db.prepare(
        "UPDATE pulse_outbox SET attempt_count = attempt_count + 1 WHERE package_id = ?",
      ).run(op.packageId);
      return;
    case "releaseLease":
      db.prepare("DELETE FROM pulse_delivery_lease WHERE owner = ?").run(op.owner);
      return;
  }
}

function leaseHeld(db: Database.Database, owner: string, now: number): boolean {
  const lease = db
    .prepare("SELECT owner, expires_at FROM pulse_delivery_lease WHERE id = 1")
    .get() as { owner: string; expires_at: number } | undefined;
  return Boolean(lease && lease.owner === owner && lease.expires_at > now);
}

/** Run inside an IMMEDIATE transaction. Checks everything before changing anything. */
export function pulseCommit(db: Database.Database, request: PulseCommitRequest): PulseCommitResult {
  if (request.lease && !leaseHeld(db, request.lease.owner, request.lease.now)) {
    return { status: "lease_lost" };
  }
  if (
    request.expectedRevision !== "any" &&
    readSecureSettingsRevision(db, PULSE_SETTINGS_CATEGORY) !== request.expectedRevision
  ) {
    return { status: "conflict" };
  }
  for (const op of request.ops) applyPulseOp(db, op);
  if (request.lease?.renewUntil !== undefined) {
    db.prepare("UPDATE pulse_delivery_lease SET expires_at = ? WHERE id = 1 AND owner = ?").run(
      request.lease.renewUntil,
      request.lease.owner,
    );
  }
  let revision = readSecureSettingsRevision(db, PULSE_SETTINGS_CATEGORY);
  if (request.record) {
    const result = commitSecureSettingsWrites(db, [
      {
        category: PULSE_SETTINGS_CATEGORY,
        expectedRevision: "any",
        record: request.record,
        backupUnreadableAs: request.backupUnreadableAs,
      },
    ]);
    if (result.status === "committed") revision = result.revisions[PULSE_SETTINGS_CATEGORY] ?? null;
  }
  return { status: "committed", revision };
}

/**
 * Run inside an IMMEDIATE transaction: drop unsendable rows, queue today's package if it
 * is still unsent, then claim the delivery lease for the oldest queued day.
 */
export function pulseClaim(db: Database.Database, request: PulseClaimRequest): PulseClaimResult {
  if (readSecureSettingsRevision(db, PULSE_SETTINGS_CATEGORY) !== request.expectedRevision) {
    return { status: "conflict" };
  }
  // Rows from another identity, or already acknowledged, are never sendable.
  db.prepare(
    `DELETE FROM pulse_outbox WHERE installation_id IS NOT ?
     OR package_id IN (SELECT package_id FROM pulse_sent_days)`,
  ).run(request.installationId);
  const receipt = (packageId: string) =>
    db.prepare("SELECT 1 FROM pulse_sent_days WHERE package_id = ?").get(packageId) !== undefined;
  if (request.candidate && !receipt(request.candidate.packageId)) {
    db.prepare(
      `INSERT OR IGNORE INTO pulse_outbox
         (package_id, installation_id, period_start, payload_json, created_at, attempt_count)
       VALUES (?, ?, ?, ?, ?, 0)`,
    ).run(
      request.candidate.packageId,
      request.installationId,
      request.candidate.periodStart,
      request.candidate.payloadJson,
      request.candidate.createdAt,
    );
  }
  const head = db
    .prepare(
      `SELECT package_id, period_start, payload_json FROM pulse_outbox
       WHERE installation_id = ?
       AND package_id NOT IN (SELECT package_id FROM pulse_sent_days)
       ORDER BY period_start, created_at LIMIT 1`,
    )
    .get(request.installationId) as PulseQueueHead | undefined;
  if (!head) {
    return { status: receipt(request.dayPackageId) ? "already_sent" : "no_eligible_day" };
  }
  const lease = db
    .prepare("SELECT owner, expires_at FROM pulse_delivery_lease WHERE id = 1")
    .get() as { owner: string; expires_at: number } | undefined;
  if (lease && lease.owner !== request.owner && lease.expires_at > request.now) {
    return { status: "busy" };
  }
  db.prepare(
    `INSERT INTO pulse_delivery_lease (id, owner, revision, expires_at) VALUES (1, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, revision = excluded.revision,
     expires_at = excluded.expires_at`,
  ).run(request.owner, request.consentRevision, request.now + request.leaseMs);
  return { status: "claimed", head };
}
