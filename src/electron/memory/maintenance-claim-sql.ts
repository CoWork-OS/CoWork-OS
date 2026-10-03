import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { defineUnit, type UnitCatalog } from "../database/statements/statement-catalog";
import { fields, int, str } from "../database/statements/unit-args";
import { createLogger } from "../utils/logger";
import type { MemoryStatementPort } from "./memory-statement-port";

/**
 * Cross-process claim for one-time memory maintenance (lane migration, archive cleanup).
 *
 * The desktop app and the node daemon can run on one profile database at the same time.
 * Each one-time job records a completion marker in `maintenance_state` when it finishes,
 * but the jobs run in several steps with event-loop yields between them, so both
 * processes could see "no marker" and run the job concurrently. Before starting, a
 * process claims the job: one IMMEDIATE transaction checks the completion marker and
 * the claim row `<marker>:claim` and writes its own claim, so only one process wins.
 * The claim is a lease: a process that died mid-run stops blocking the job once the lease
 * expires, and the job (idempotent by design) is resumed by whichever process runs next.
 */

const logger = createLogger("MaintenanceClaim");

/** Lease of a claim; a holder that crashed releases the job after this long. */
export const MAINTENANCE_CLAIM_LEASE_MS = 60 * 60 * 1000;

export type MaintenanceClaimResult =
  | { claimed: true }
  | { claimed: false; reason: "done" | "held"; holder?: string };

export function maintenanceClaimKey(markerKey: string): string {
  return `${markerKey}:claim`;
}

function ensureMaintenanceStateTable(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS maintenance_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

function parseClaim(value: unknown): { owner: string; expiresAt: number } | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as { owner?: unknown; expiresAt?: unknown };
    if (typeof parsed.owner !== "string" || typeof parsed.expiresAt !== "number") return null;
    return { owner: parsed.owner, expiresAt: parsed.expiresAt };
  } catch {
    return null;
  }
}

/**
 * Claim the one-time job whose completion marker is `markerKey`. Must run inside one
 * write transaction (the unit runs IMMEDIATE), so the check and the write are atomic.
 */
export function claimMaintenanceRun(
  db: Database.Database,
  request: { markerKey: string; owner: string; now: number; leaseMs: number },
): MaintenanceClaimResult {
  ensureMaintenanceStateTable(db);
  const done = db.prepare("SELECT 1 FROM maintenance_state WHERE key = ?").get(request.markerKey);
  if (done) return { claimed: false, reason: "done" };
  const claimKey = maintenanceClaimKey(request.markerKey);
  const row = db.prepare("SELECT value FROM maintenance_state WHERE key = ?").get(claimKey) as
    | { value: string }
    | undefined;
  const current = parseClaim(row?.value);
  if (current && current.owner !== request.owner && current.expiresAt > request.now) {
    return { claimed: false, reason: "held", holder: current.owner };
  }
  db.prepare(
    `INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(
    claimKey,
    JSON.stringify({ owner: request.owner, expiresAt: request.now + request.leaseMs }),
    request.now,
  );
  return { claimed: true };
}

/** Drop the claim if `owner` still holds it. Returns whether a row was removed. */
export function releaseMaintenanceRun(
  db: Database.Database,
  request: { markerKey: string; owner: string },
): boolean {
  ensureMaintenanceStateTable(db);
  const claimKey = maintenanceClaimKey(request.markerKey);
  const row = db.prepare("SELECT value FROM maintenance_state WHERE key = ?").get(claimKey) as
    | { value: string }
    | undefined;
  if (parseClaim(row?.value)?.owner !== request.owner) return false;
  return db.prepare("DELETE FROM maintenance_state WHERE key = ?").run(claimKey).changes > 0;
}

const markerKey = (value: unknown, path: string) => str(value, path, 200);

export const MAINTENANCE_CLAIM_UNITS = {
  memoryMaintenance_claim: defineUnit(
    fields({
      markerKey,
      owner: (value: unknown, path: string) => str(value, path, 200),
      now: (value: unknown, path: string) => int(value, path),
      leaseMs: (value: unknown, path: string) => int(value, path, 1, 7 * 24 * 60 * 60 * 1000),
    }),
    (db: Database.Database, args) => claimMaintenanceRun(db, args),
  ),
  memoryMaintenance_release: defineUnit(
    fields({
      markerKey,
      owner: (value: unknown, path: string) => str(value, path, 200),
    }),
    (db: Database.Database, args) => releaseMaintenanceRun(db, args),
  ),
} satisfies UnitCatalog;

/** Owner id of this process's claims: runtime, pid and a per-process nonce. */
const PROCESS_OWNER = `${process.type === "browser" ? "desktop" : "node"}:${process.pid}:${randomUUID()}`;

export function maintenanceClaimOwner(): string {
  return PROCESS_OWNER;
}

/**
 * Run `job` only if this process wins the claim for `markerKey`; release the claim
 * afterwards (also on failure, so the next start retries). Returns null when the job is
 * already done or another process is running it.
 */
export async function withMaintenanceClaim<T>(
  port: MemoryStatementPort,
  markerKey: string,
  job: () => Promise<T>,
  options: { owner?: string; now?: () => number; leaseMs?: number } = {},
): Promise<T | null> {
  const owner = options.owner ?? PROCESS_OWNER;
  const claim = await port.unit("memoryMaintenance_claim", {
    markerKey,
    owner,
    now: Math.floor(options.now?.() ?? Date.now()),
    leaseMs: options.leaseMs ?? MAINTENANCE_CLAIM_LEASE_MS,
  });
  if (!claim.claimed) {
    if (claim.reason === "held") {
      logger.info(`Skipping ${markerKey}: another process is running it (${claim.holder})`);
    }
    return null;
  }
  try {
    return await job();
  } finally {
    try {
      await port.unit("memoryMaintenance_release", { markerKey, owner });
    } catch (error) {
      // The lease expires on its own.
      logger.warn(`Could not release the ${markerKey} claim:`, error);
    }
  }
}
