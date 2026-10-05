import type Database from "better-sqlite3";
import { defineUnit, type UnitCatalog } from "../database/statements/statement-catalog";
import { fields, int, oneOf, str } from "../database/statements/unit-args";

/**
 * Ownership lease for the workspace kit writers (CrossSignal, Feedback, Lore).
 *
 * The desktop app and the node daemon can run on one profile database at the same time,
 * and each one would otherwise rewrite the same `.cowork/*.md` files from its own
 * in-memory state. One row in `maintenance_state` names the process that owns the kit
 * writers. The owner renews the lease on a heartbeat; a process that crashed stops owning
 * them once its lease expires, and the next process to ask takes over.
 *
 * The desktop app wins: a desktop process that finds the lease held by a node daemon
 * records a hand-off request on the row. On its next renewal the daemon sees the request,
 * stops its writers (flushing what it has) and passes the lease to the desktop, which
 * starts its writers on its next heartbeat. A hand-off request expires like a lease, so a desktop that quit
 * before taking over does not keep the daemon from writing. Between two processes of the
 * same runtime, the first one keeps the lease.
 */

export const KIT_WRITER_LEASE_KEY = "kit_writer_lease";

export type KitWriterRuntime = "desktop" | "node";

export type KitWriterLeaseResult =
  | { owned: true }
  | {
      owned: false;
      /** `held`: another live owner; `handoff_requested`: this desktop asked it to yield;
       * `yield`: this process owns the lease but a desktop asked for it, so stop and release. */
      reason: "held" | "handoff_requested" | "yield";
      holder: string;
    };

interface LeaseRow {
  owner: string;
  runtime: KitWriterRuntime;
  expiresAt: number;
  handoffTo?: string;
  handoffExpiresAt?: number;
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

function parseLease(value: unknown): LeaseRow | null {
  if (typeof value !== "string") return null;
  try {
    const parsed = JSON.parse(value) as Partial<LeaseRow>;
    if (typeof parsed.owner !== "string" || typeof parsed.expiresAt !== "number") return null;
    return {
      owner: parsed.owner,
      runtime: parsed.runtime === "desktop" ? "desktop" : "node",
      expiresAt: parsed.expiresAt,
      ...(typeof parsed.handoffTo === "string" && typeof parsed.handoffExpiresAt === "number"
        ? { handoffTo: parsed.handoffTo, handoffExpiresAt: parsed.handoffExpiresAt }
        : {}),
    };
  } catch {
    return null;
  }
}

function writeLease(db: Database.Database, lease: LeaseRow, now: number): void {
  db.prepare(
    `INSERT INTO maintenance_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(KIT_WRITER_LEASE_KEY, JSON.stringify(lease), now);
}

/**
 * Acquire or renew the kit-writer lease for `owner`. Must run inside one write transaction
 * (the unit runs IMMEDIATE), so the check and the write are atomic across processes.
 */
export function acquireKitWriterLease(
  db: Database.Database,
  request: { owner: string; runtime: KitWriterRuntime; now: number; leaseMs: number },
): KitWriterLeaseResult {
  ensureMaintenanceStateTable(db);
  const row = db
    .prepare("SELECT value FROM maintenance_state WHERE key = ?")
    .get(KIT_WRITER_LEASE_KEY) as { value: string } | undefined;
  const current = parseLease(row?.value);
  const { owner, runtime, now, leaseMs } = request;
  const liveHandoff =
    current?.handoffTo && (current.handoffExpiresAt ?? 0) > now ? current.handoffTo : null;

  if (current && current.owner === owner && liveHandoff && liveHandoff !== owner) {
    // A desktop asked for the lease: do not renew; the caller stops and releases.
    return { owned: false, reason: "yield", holder: liveHandoff };
  }
  if (!current || current.owner === owner || current.expiresAt <= now) {
    writeLease(db, { owner, runtime, expiresAt: now + leaseMs }, now);
    return { owned: true };
  }
  if (runtime === "desktop" && current.runtime !== "desktop") {
    writeLease(db, { ...current, handoffTo: owner, handoffExpiresAt: now + leaseMs }, now);
    return { owned: false, reason: "handoff_requested", holder: current.owner };
  }
  return { owned: false, reason: "held", holder: current.owner };
}

/**
 * Give up the lease if `owner` holds it. With a live hand-off request the lease passes to
 * the requesting desktop (so this process cannot win it back before the desktop's next
 * heartbeat); otherwise the row is removed. Returns whether this owner held it.
 */
export function releaseKitWriterLease(
  db: Database.Database,
  request: { owner: string; now: number; leaseMs: number },
): boolean {
  ensureMaintenanceStateTable(db);
  const row = db
    .prepare("SELECT value FROM maintenance_state WHERE key = ?")
    .get(KIT_WRITER_LEASE_KEY) as { value: string } | undefined;
  const current = parseLease(row?.value);
  if (current?.owner !== request.owner) return false;
  if (
    current.handoffTo &&
    current.handoffTo !== request.owner &&
    (current.handoffExpiresAt ?? 0) > request.now
  ) {
    writeLease(
      db,
      { owner: current.handoffTo, runtime: "desktop", expiresAt: request.now + request.leaseMs },
      request.now,
    );
    return true;
  }
  return (
    db.prepare("DELETE FROM maintenance_state WHERE key = ?").run(KIT_WRITER_LEASE_KEY).changes > 0
  );
}

const ownerArg = (value: unknown, path: string) => str(value, path, 200);
const leaseMsArg = (value: unknown, path: string) => int(value, path, 1_000, 24 * 60 * 60 * 1000);

export const KIT_WRITER_LEASE_UNITS = {
  kitWriterLease_acquire: defineUnit(
    fields({
      owner: ownerArg,
      runtime: (value: unknown, path: string) =>
        oneOf<KitWriterRuntime>(value, path, ["desktop", "node"]),
      now: (value: unknown, path: string) => int(value, path),
      leaseMs: leaseMsArg,
    }),
    (db: Database.Database, args) => acquireKitWriterLease(db, args),
  ),
  kitWriterLease_release: defineUnit(
    fields({
      owner: ownerArg,
      now: (value: unknown, path: string) => int(value, path),
      leaseMs: leaseMsArg,
    }),
    (db: Database.Database, args) => releaseKitWriterLease(db, args),
  ),
} satisfies UnitCatalog;
