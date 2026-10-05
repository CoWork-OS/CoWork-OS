/**
 * Kit-writer ownership (kit-writer-lease-sql.ts, agents/kit-writer-ownership.ts): the
 * desktop app and the node daemon share one profile database, and only one of them may run
 * the workspace kit writers (CROSS_SIGNALS.md, MISTAKES.md, LORE.md). Two connections to
 * one file stand in for the two processes.
 */
import type Database from "better-sqlite3";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  KIT_WRITER_LEASE_KEY,
  acquireKitWriterLease,
  releaseKitWriterLease,
  type KitWriterRuntime,
} from "../kit-writer-lease-sql";
import { createMemoryStatementPort } from "../memory-statement-port";
import { KitWriterOwnership, type KitWriter } from "../../agents/kit-writer-ownership";
import type { AgentDaemon } from "../../agent/daemon";
import { nativeSqliteAvailable } from "./memory-items-test-db";

vi.mock("electron", () => ({ app: { getPath: () => "/tmp/cowork-test" } }));

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;
const LEASE = 60_000;

describeWithSqlite("kit-writer lease", () => {
  const cleanups: Array<() => void> = [];
  afterEach(() => {
    for (const cleanup of cleanups.splice(0).reverse()) cleanup();
  });

  async function twoConnections(): Promise<[Database.Database, Database.Database]> {
    const { default: SqliteDatabase } = await import("better-sqlite3");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-kit-lease-"));
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

  const acquire = (db: Database.Database, owner: string, runtime: KitWriterRuntime, now: number) =>
    db
      .transaction(() => acquireKitWriterLease(db, { owner, runtime, now, leaseMs: LEASE }))
      .immediate();

  const leaseRow = (db: Database.Database) =>
    JSON.parse(
      (
        db
          .prepare("SELECT value FROM maintenance_state WHERE key = ?")
          .get(KIT_WRITER_LEASE_KEY) as { value: string } | undefined
      )?.value ?? "null",
    );

  describe("lease rows", () => {
    it("lets the first of two daemons own the lease and keeps it while renewed", async () => {
      const [a, b] = await twoConnections();
      expect(acquire(a, "node-a", "node", 1_000)).toEqual({ owned: true });
      expect(acquire(b, "node-b", "node", 2_000)).toEqual({
        owned: false,
        reason: "held",
        holder: "node-a",
      });
      expect(acquire(a, "node-a", "node", 30_000)).toEqual({ owned: true });
      // Renewed at 30 s, so still held at 61 s.
      expect(acquire(b, "node-b", "node", 61_000).owned).toBe(false);
    });

    it("takes over a stale lease after its holder crashed", async () => {
      const [a, b] = await twoConnections();
      expect(acquire(a, "node-a", "node", 1_000)).toEqual({ owned: true });
      // node-a stopped renewing (crash): after the lease, node-b takes over.
      expect(acquire(b, "node-b", "node", 1_000 + LEASE)).toEqual({ owned: true });
      expect(leaseRow(b)).toMatchObject({ owner: "node-b", runtime: "node" });
      // The crashed holder's renewal, should it come back, no longer wins.
      expect(acquire(a, "node-a", "node", 1_000 + LEASE + 1)).toMatchObject({
        owned: false,
        reason: "held",
      });
    });

    it("hands the lease from a daemon to a desktop and never back while the desktop lives", async () => {
      const [desktop, daemon] = await twoConnections();
      expect(acquire(daemon, "node", "node", 1_000)).toEqual({ owned: true });
      expect(acquire(desktop, "desk", "desktop", 2_000)).toEqual({
        owned: false,
        reason: "handoff_requested",
        holder: "node",
      });
      // The daemon's next renewal is told to yield instead of renewing.
      expect(acquire(daemon, "node", "node", 3_000)).toEqual({
        owned: false,
        reason: "yield",
        holder: "desk",
      });
      // Its release passes the lease to the desktop, so the daemon cannot win it back first.
      expect(
        daemon
          .transaction(() =>
            releaseKitWriterLease(daemon, { owner: "node", now: 4_000, leaseMs: LEASE }),
          )
          .immediate(),
      ).toBe(true);
      expect(leaseRow(daemon)).toMatchObject({ owner: "desk", runtime: "desktop" });
      expect(acquire(daemon, "node", "node", 5_000).owned).toBe(false);
      expect(acquire(desktop, "desk", "desktop", 6_000)).toEqual({ owned: true });
    });

    it("lets a daemon keep the lease when the desktop's hand-off request expired", async () => {
      const [desktop, daemon] = await twoConnections();
      acquire(daemon, "node", "node", 1_000);
      acquire(desktop, "desk", "desktop", 2_000);
      // The desktop quit before the daemon renewed; the request is stale.
      expect(acquire(daemon, "node", "node", 2_000 + LEASE)).toEqual({ owned: true });
      expect(leaseRow(daemon).handoffTo).toBeUndefined();
    });

    it("does not let a desktop take the lease from another desktop", async () => {
      const [a, b] = await twoConnections();
      acquire(a, "desk-a", "desktop", 1_000);
      expect(acquire(b, "desk-b", "desktop", 2_000)).toMatchObject({ reason: "held" });
    });

    it("releases only the holder's lease", async () => {
      const [a, b] = await twoConnections();
      acquire(a, "node-a", "node", 1_000);
      expect(releaseKitWriterLease(b, { owner: "node-b", now: 2_000, leaseMs: LEASE })).toBe(false);
      expect(releaseKitWriterLease(a, { owner: "node-a", now: 2_000, leaseMs: LEASE })).toBe(true);
      expect(leaseRow(a)).toBeNull();
      expect(acquire(b, "node-b", "node", 3_000)).toEqual({ owned: true });
    });
  });

  describe("KitWriterOwnership", () => {
    function fakeWriters(log: string[], label: string): { name: string; create: () => KitWriter } {
      return {
        name: label,
        create: () => ({
          start: vi.fn(async () => {
            log.push(`${label}:start`);
          }),
          stop: vi.fn(async () => {
            log.push(`${label}:stop`);
          }),
        }),
      };
    }

    function ownership(
      db: Database.Database,
      owner: string,
      runtime: KitWriterRuntime,
      clock: { now: number },
      log: string[],
    ) {
      const controller = new KitWriterOwnership({
        port: createMemoryStatementPort(db),
        agentDaemon: {} as AgentDaemon,
        runtime,
        owner,
        writers: [fakeWriters(log, `${owner}/lore`), fakeWriters(log, `${owner}/feedback`)],
        now: () => clock.now,
        leaseMs: LEASE,
        renewMs: 15_000,
      });
      cleanups.push(() => void controller.stop());
      return controller;
    }

    it("starts the writers only in the owning process and hands them to the desktop", async () => {
      const [desktopDb, daemonDb] = await twoConnections();
      const clock = { now: 1_000 };
      const log: string[] = [];
      const daemon = ownership(daemonDb, "node", "node", clock, log);
      const desktop = ownership(desktopDb, "desk", "desktop", clock, log);

      await expect(daemon.start()).resolves.toBe(true);
      await expect(desktop.start()).resolves.toBe(false);
      expect(log).toEqual(["node/lore:start", "node/feedback:start"]);

      // Daemon heartbeat: it sees the hand-off request, stops (flushes) its writers.
      clock.now = 16_000;
      await daemon.heartbeat();
      expect(daemon.isOwner()).toBe(false);
      expect(log.slice(2)).toEqual(["node/feedback:stop", "node/lore:stop"]);

      // Desktop heartbeat: it now owns the lease and starts its writers.
      await desktop.heartbeat();
      expect(desktop.isOwner()).toBe(true);
      expect(log.slice(4)).toEqual(["desk/lore:start", "desk/feedback:start"]);

      // The daemon keeps asking but does not get the lease back.
      clock.now = 31_000;
      await daemon.heartbeat();
      expect(daemon.isOwner()).toBe(false);

      // Desktop quits: stop flushes its writers and releases; the daemon takes over.
      await desktop.stop();
      expect(log.slice(6)).toEqual(["desk/feedback:stop", "desk/lore:stop"]);
      await daemon.heartbeat();
      expect(daemon.isOwner()).toBe(true);
      expect(log.slice(8)).toEqual(["node/lore:start", "node/feedback:start"]);
    });

    it("takes over after the owner crashed, once its lease expired", async () => {
      const [first, second] = await twoConnections();
      const clock = { now: 1_000 };
      const log: string[] = [];
      const crashed = new KitWriterOwnership({
        port: createMemoryStatementPort(first),
        agentDaemon: {} as AgentDaemon,
        runtime: "node",
        owner: "crashed",
        writers: [],
        now: () => clock.now,
        leaseMs: LEASE,
      });
      await expect(crashed.start()).resolves.toBe(true);
      // Simulate the crash: the heartbeat stops and the row is never released.
      (crashed as unknown as { stopped: boolean }).stopped = true;

      const next = ownership(second, "next", "node", clock, log);
      await expect(next.start()).resolves.toBe(false);
      clock.now = 1_000 + LEASE - 1;
      await next.heartbeat();
      expect(next.isOwner()).toBe(false);
      clock.now = 1_000 + LEASE;
      await next.heartbeat();
      expect(next.isOwner()).toBe(true);
      expect(log).toEqual(["next/lore:start", "next/feedback:start"]);
    });

    it("stops its writers when another process took the lease while it was stalled", async () => {
      const [a, b] = await twoConnections();
      const clock = { now: 1_000 };
      const log: string[] = [];
      const stalled = ownership(a, "stalled", "node", clock, log);
      await stalled.start();
      // No renewal for a whole lease: another daemon takes over.
      clock.now = 1_000 + LEASE;
      const other = ownership(b, "other", "node", clock, log);
      await expect(other.start()).resolves.toBe(true);
      await stalled.heartbeat();
      expect(stalled.isOwner()).toBe(false);
      expect(log).toEqual([
        "stalled/lore:start",
        "stalled/feedback:start",
        "other/lore:start",
        "other/feedback:start",
        "stalled/feedback:stop",
        "stalled/lore:stop",
      ]);
      // It did not release the new owner's lease.
      expect(leaseRow(a)).toMatchObject({ owner: "other" });
    });

    it("keeps its state when a heartbeat fails and renews on the next one", async () => {
      const clock = { now: 1_000 };
      const unit = vi
        .fn()
        .mockResolvedValueOnce({ owned: true })
        .mockRejectedValueOnce(new Error("database busy"))
        .mockResolvedValue({ owned: true });
      const log: string[] = [];
      const controller = new KitWriterOwnership({
        port: { unit } as never,
        agentDaemon: {} as AgentDaemon,
        runtime: "desktop",
        owner: "desk",
        writers: [fakeWriters(log, "desk/lore")],
        now: () => clock.now,
      });
      await controller.start();
      await controller.heartbeat();
      expect(controller.isOwner()).toBe(true);
      await controller.heartbeat();
      expect(log).toEqual(["desk/lore:start"]);
      await controller.stop();
      expect(unit).toHaveBeenLastCalledWith("kitWriterLease_release", {
        owner: "desk",
        now: 1_000,
        leaseMs: LEASE,
      });
    });

    it("renews on its heartbeat timer", async () => {
      vi.useFakeTimers();
      try {
        const unit = vi.fn().mockResolvedValue({ owned: true });
        const controller = new KitWriterOwnership({
          port: { unit } as never,
          agentDaemon: {} as AgentDaemon,
          runtime: "node",
          owner: "node",
          writers: [],
          renewMs: 15_000,
        });
        await controller.start();
        expect(unit).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(30_000);
        expect(unit).toHaveBeenCalledTimes(3);
        await controller.stop();
        await vi.advanceTimersByTimeAsync(30_000);
        // Only the release after stop.
        expect(unit).toHaveBeenCalledTimes(4);
        expect(unit).toHaveBeenLastCalledWith(
          "kitWriterLease_release",
          expect.objectContaining({ owner: "node" }),
        );
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
