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
 * consent windows and the outbox atomically. They run on the host
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
  | { kind: "incrementAttempt"; packageId: string };

export interface PulseCommitRequest {
  /** The settings row revision the host decided from; `"any"` skips the check. */
  expectedRevision: number | null | "any";
  /** New settings ciphertext, or `null` to leave the settings row as it is. */
  record: SecureSettingsRecord | null;
  ops: PulseOp[];
  /** The stored row was unreadable: back its ciphertext up before replacing it. */
  backupUnreadableAs?: string;
}

export type PulseCommitResult =
  | { status: "committed"; revision: number | null }
  | { status: "conflict" };

export interface PulseClaimRequest {
  expectedRevision: number | null;
  installationId: string;
  /** Package for today, built by the host outside any transaction; queued if unsent. */
  candidate?: { packageId: string; periodStart: string; payloadJson: string; createdAt: number };
  dayPackageId: string;
}

export interface PulseQueueHead {
  package_id: string;
  period_start: string;
  payload_json: string;
}

export type PulseClaimResult =
  | { status: "conflict" }
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
  }
}

/** Run inside an IMMEDIATE transaction. Checks everything before changing anything. */
export function pulseCommit(db: Database.Database, request: PulseCommitRequest): PulseCommitResult {
  if (
    request.expectedRevision !== "any" &&
    readSecureSettingsRevision(db, PULSE_SETTINGS_CATEGORY) !== request.expectedRevision
  ) {
    return { status: "conflict" };
  }
  for (const op of request.ops) applyPulseOp(db, op);
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
 * is still unsent, then return the oldest queued day.
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
  return { status: "claimed", head };
}
