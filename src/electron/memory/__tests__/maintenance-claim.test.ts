/**
 * One-time memory maintenance claims (maintenance-claim-sql.ts): the desktop app and the
 * node daemon share one profile database, so a one-time job (lane migration, archive
 * cleanup) must be claimed atomically before it runs. Two connections to one file stand in
 * for the two processes.
 */
import type Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  claimMaintenanceRun,
  maintenanceClaimKey,
  releaseMaintenanceRun,
  withMaintenanceClaim,
} from "../maintenance-claim-sql";
import { createMemoryStatementPort } from "../memory-statement-port";
import { MemoryItemsRepository } from "../MemoryItemsRepository";
import { MemoryWriter } from "../MemoryWriter";
import { MEMORY_ITEMS_LANE_MIGRATION_KEY } from "../memory-items-sql";
import { runMemoryItemsLaneMigrationNow } from "../memory-engine-bootstrap";
import { createMemoryItemsTestDb, nativeSqliteAvailable } from "./memory-items-test-db";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cowork-test" } }));

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;
const HOUR = 60 * 60 * 1000;

describeWithSqlite("maintenance claims", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  async function twoConnections(): Promise<[Database.Database, Database.Database]> {
    const { default: SqliteDatabase } = await import("better-sqlite3");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-claim-"));
    const file = path.join(dir, "profile.db");
    const desktop = new SqliteDatabase(file);
    desktop.pragma("journal_mode = WAL");
    const daemon = new SqliteDatabase(file);
    cleanups.push(() => {
      desktop.close();
      daemon.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    return [desktop, daemon];
  }

  const claim = (db: Database.Database, owner: string, now = 1_000, markerKey = "job_v1") =>
    db
      .transaction(() => claimMaintenanceRun(db, { markerKey, owner, now, leaseMs: HOUR }))
      .immediate();

  it("lets only one process claim a job until it is released", async () => {
    const [desktop, daemon] = await twoConnections();
    expect(claim(desktop, "desktop")).toEqual({ claimed: true });
    expect(claim(daemon, "daemon")).toEqual({ claimed: false, reason: "held", holder: "desktop" });
    // The holder may re-claim (a retry inside one process).
    expect(claim(desktop, "desktop")).toEqual({ claimed: true });

    expect(releaseMaintenanceRun(daemon, { markerKey: "job_v1", owner: "daemon" })).toBe(false);
    expect(releaseMaintenanceRun(desktop, { markerKey: "job_v1", owner: "desktop" })).toBe(true);
    expect(claim(daemon, "daemon")).toEqual({ claimed: true });
  });

  it("refuses a finished job and takes over an expired lease", async () => {
    const [desktop, daemon] = await twoConnections();
    expect(claim(desktop, "desktop", 1_000)).toEqual({ claimed: true });
    // The desktop crashed mid-run: after the lease the daemon resumes the job.
    expect(claim(daemon, "daemon", 1_000 + HOUR + 1)).toEqual({ claimed: true });

    desktop
      .prepare("INSERT INTO maintenance_state (key, value, updated_at) VALUES ('job_v1', '{}', 1)")
      .run();
    expect(claim(desktop, "desktop", 5 * HOUR)).toEqual({ claimed: false, reason: "done" });
  });

  it("runs a claimed job once and releases the claim, also on failure", async () => {
    const [desktop, daemon] = await twoConnections();
    const desktopPort = createMemoryStatementPort(desktop);
    const daemonPort = createMemoryStatementPort(daemon);

    let release!: () => void;
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const runs: string[] = [];
    const first = withMaintenanceClaim(
      desktopPort,
      "job_v1",
      async () => {
        runs.push("desktop");
        await blocked;
        return "desktop-result";
      },
      { owner: "desktop" },
    );
    await new Promise((resolve) => setImmediate(resolve));
    const second = await withMaintenanceClaim(
      daemonPort,
      "job_v1",
      async () => {
        runs.push("daemon");
        return "daemon-result";
      },
      { owner: "daemon" },
    );
    expect(second).toBeNull();
    release();
    await expect(first).resolves.toBe("desktop-result");
    expect(runs).toEqual(["desktop"]);
    expect(
      daemon
        .prepare("SELECT 1 FROM maintenance_state WHERE key = ?")
        .get(maintenanceClaimKey("job_v1")),
    ).toBeUndefined();

    await expect(
      withMaintenanceClaim(
        daemonPort,
        "job_v1",
        async () => {
          throw new Error("boom");
        },
        { owner: "daemon" },
      ),
    ).rejects.toThrow("boom");
    expect(
      daemon
        .prepare("SELECT 1 FROM maintenance_state WHERE key = ?")
        .get(maintenanceClaimKey("job_v1")),
    ).toBeUndefined();
  });

  it("skips the lane migration while another process holds its claim", async () => {
    const db = await createMemoryItemsTestDb(["ws-1"]);
    cleanups.push(() => db.close());
    db.prepare(
      `INSERT INTO curated_memory_entries (id, workspace_id, target, kind, content, normalized_key,
         source, created_at, updated_at) VALUES ('c1', 'ws-1', 'workspace', 'project_fact',
         'Releases are cut on Thursdays', 'releases', 'user', 1, 1)`,
    ).run();
    const writer = new MemoryWriter({ repository: new MemoryItemsRepository(db) });
    const port = createMemoryStatementPort(db);
    // The other process holds the claim.
    db.transaction(() =>
      claimMaintenanceRun(db, {
        markerKey: MEMORY_ITEMS_LANE_MIGRATION_KEY,
        owner: "other-process",
        now: Date.now(),
        leaseMs: HOUR,
      }),
    ).immediate();

    await runMemoryItemsLaneMigrationNow(writer, port);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_items").get()).toEqual({ n: 0 });

    releaseMaintenanceRun(db, {
      markerKey: MEMORY_ITEMS_LANE_MIGRATION_KEY,
      owner: "other-process",
    });
    await runMemoryItemsLaneMigrationNow(writer, port);
    expect(db.prepare("SELECT COUNT(*) AS n FROM memory_items").get()).toEqual({ n: 1 });
    // The claim is released after the run (the settings lanes are unreadable here, so the
    // marker itself is not written and the next start retries).
    expect(
      db
        .prepare("SELECT 1 FROM maintenance_state WHERE key = ?")
        .get(maintenanceClaimKey(MEMORY_ITEMS_LANE_MIGRATION_KEY)),
    ).toBeUndefined();
  });
});
