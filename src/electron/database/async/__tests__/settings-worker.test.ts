import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseClient } from "../DatabaseClient";
import { DATABASE_COMMANDS, requiredTablesFor } from "../commands";
import { DatabaseManager } from "../../schema";
import { SecureSettingsRepository } from "../../SecureSettingsRepository";
import { setSettingsCommitClient } from "../../secure-settings-commit-route";
import { PulseService } from "../../../telemetry/pulse-service";

// Settings and policy transactions in the real database worker (DB5): the host encrypts,
// the worker compares revisions and commits ciphertext with Pulse's table changes.

const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;

beforeAll(() => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  workerPath = path.join(BUILD_DIR, `database-worker-settings-${process.pid}.js`);
  buildSync({
    entryPoints: [path.resolve("src/electron/database/async/database-worker.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: workerPath,
    external: ["better-sqlite3", "electron"],
    logLevel: "silent",
  });
});

afterAll(() => {
  fs.rmSync(workerPath, { force: true });
});

const DAY_MS = 86_400_000;

describe("settings transactions in the database worker", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setSettingsCommitClient(null, null);
    (SecureSettingsRepository as unknown as { instance: unknown }).instance = null;
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    vi.restoreAllMocks();
  });

  const profile = async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-settings-worker-"));
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    cleanups.push(() => {
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const repository = new SecureSettingsRepository(manager.getDatabase());
    const client = await DatabaseClient.start({
      dbPath: manager.getDatabasePath(),
      requiredTables: requiredTablesFor(DATABASE_COMMANDS),
      workerPath,
    });
    cleanups.push(() => client.close(2_000).then(() => undefined));
    setSettingsCommitClient(manager.getDatabasePath(), client);
    return { manager, db: manager.getDatabase(), repository, client };
  };

  it("commits an update through the worker and re-applies it after a concurrent write", async () => {
    const { repository, client } = await profile();
    repository.save("permissions", { rules: ["base"] });
    const execute = vi.spyOn(client, "execute");
    let interfered = false;
    const result = await repository.updateAsync<{ rules: string[] }>("permissions", (current) => {
      if (!interfered) {
        interfered = true;
        repository.save("permissions", { rules: [...(current?.rules ?? []), "host"] });
      }
      return { rules: [...(current?.rules ?? []), "worker"] };
    });
    expect(result.value).toEqual({ rules: ["base", "host", "worker"] });
    expect(repository.load("permissions")).toEqual({ rules: ["base", "host", "worker"] });
    expect(result.revision).toBe(repository.getRevision("permissions"));
    expect(execute.mock.calls.map(([name]) => name)).toEqual([
      "secureSettings.commit",
      "secureSettings.commit",
    ]);
  });

  it("reports a stale revision as a conflict and rejects malformed ciphertext", async () => {
    const { repository, client } = await profile();
    repository.save("tray", { a: 1 });
    const stale = repository.getRevision("tray")!;
    repository.save("tray", { a: 2 });
    const record = repository.encryptRecord({ a: 3 });
    await expect(
      client.execute("secureSettings.commit", {
        writes: [{ category: "tray", expectedRevision: stale, record }],
      }),
    ).resolves.toMatchObject({ status: "conflict", category: "tray" });
    expect(repository.load("tray")).toEqual({ a: 2 });
    await expect(
      client.execute("secureSettings.commit", {
        writes: [
          {
            category: "tray",
            expectedRevision: "any",
            record: { encryptedData: "x", checksum: "not-a-digest" },
          },
        ],
      }),
    ).rejects.toMatchObject({ code: "invalid_request" });
  });

  it("runs Pulse decisions and deliveries through the worker, fenced by the latest decision", async () => {
    const { db, client } = await profile();
    let clock = Date.UTC(2026, 8, 20, 12);
    let release: (() => void) | null = null;
    const requests: string[] = [];
    const service = new PulseService(db, {
      version: "0.0.0",
      runtime: "desktop",
      now: () => clock,
      fetch: (async (url: string) => {
        requests.push(new URL(url).pathname);
        if (new URL(url).pathname === "/v1/daily" && release === null) {
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { ok: true, status: 202 };
      }) as unknown as typeof fetch,
    });
    cleanups.push(() => service.shutdown(100));
    const execute = vi.spyOn(client, "execute");

    expect((await service.setEnabled(true)).success).toBe(true);
    await service.flush();
    expect(execute.mock.calls.some(([name]) => name === "pulse.commit")).toBe(true);

    // Two days later the first full day is eligible; the send waits on the collector.
    clock += 2 * DAY_MS;
    const running = service.flush();
    while (!release) await new Promise((resolve) => setTimeout(resolve, 5));
    expect(execute.mock.calls.some(([name]) => name === "pulse.claim")).toBe(true);
    // The user opts out while the request is in flight; the late response cannot undo it.
    expect((await service.setEnabled(false)).success).toBe(true);
    (release as () => void)();
    expect((await running).outcome).toBe("cancelled_by_state_change");
    expect((await service.getSettings()).consentState).toBe("disabled");
    expect(db.prepare("SELECT COUNT(*) AS n FROM pulse_sent_days").get()).toEqual({ n: 0 });
    expect(requests.filter((request) => request === "/v1/daily")).toHaveLength(1);
  });
});
