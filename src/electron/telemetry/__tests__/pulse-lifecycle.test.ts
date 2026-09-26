import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PulseService, type PulsePrivateSettings, type PulseSettingsStore } from "../pulse-service";

// Synthetic identities, in-memory or temp-file SQLite and mocked HTTP only. Nothing
// here reads a real profile or contacts a collector.

const DAY_MS = 86_400_000;
const NOW = Date.UTC(2026, 8, 26, 12);
const YESTERDAY = "2026-09-25T00:00:00.000Z";
const ENDPOINT = "https://pulse.coworkosapp.com";

type Handler = (
  url: string,
  init: RequestInit & { signal?: AbortSignal },
) => Promise<{ ok: boolean; status: number }>;

interface Request {
  path: string;
  method: string;
  body?: string;
  authorization?: string;
}

/** Settings store in the same SQLite connection, so the service's transactions cover it. */
function tableStore(db: Database.Database): PulseSettingsStore {
  db.exec("CREATE TABLE IF NOT EXISTS test_settings (id INTEGER PRIMARY KEY, json TEXT)");
  return {
    load: () => {
      const row = db.prepare("SELECT json FROM test_settings WHERE id = 1").get() as
        | { json: string }
        | undefined;
      return row ? (JSON.parse(row.json) as PulsePrivateSettings) : null;
    },
    save: (settings) => {
      db.prepare(
        "INSERT INTO test_settings (id, json) VALUES (1, ?) ON CONFLICT(id) DO UPDATE SET json = excluded.json",
      ).run(JSON.stringify(settings));
    },
  };
}

function createTaskTables(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS tasks (id TEXT PRIMARY KEY, source TEXT, created_at INTEGER, completed_at INTEGER, status TEXT, terminal_status TEXT, last_run_duration_ms INTEGER, parent_task_id TEXT, eval_case_id TEXT, session_id TEXT);
    CREATE TABLE IF NOT EXISTS task_events (task_id TEXT, timestamp INTEGER, type TEXT, legacy_type TEXT, payload TEXT);
    CREATE TABLE IF NOT EXISTS llm_call_events (task_id TEXT, timestamp INTEGER, success INTEGER);
  `);
}

function deferred(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const openDbs: Database.Database[] = [];
const tempDirs: string[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) if (db.open) db.close();
  for (const dir of tempDirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function fixture(
  options: {
    handler?: Handler;
    now?: () => number;
    db?: Database.Database;
    settings?: PulsePrivateSettings | null;
    consentSince?: number | null;
    leaseMs?: number;
  } = {},
) {
  const db = options.db ?? new Database(":memory:");
  if (!options.db) openDbs.push(db);
  createTaskTables(db);
  const store = tableStore(db);
  if (options.settings !== undefined && options.settings !== null) store.save(options.settings);
  const requests: Request[] = [];
  let clock = NOW;
  const now = options.now ?? (() => clock);
  const handler: Handler = options.handler ?? (async () => ({ ok: true, status: 202 }));
  const fetchImpl = (async (url: string, init: RequestInit & { signal?: AbortSignal }) => {
    const headers = (init.headers || {}) as Record<string, string>;
    requests.push({
      path: new URL(url).pathname,
      method: String(init.method),
      body: typeof init.body === "string" ? init.body : undefined,
      authorization: headers.Authorization,
    });
    return handler(url, init);
  }) as unknown as typeof fetch;
  const service = new PulseService(db, {
    version: "0.0.0",
    runtime: "desktop",
    now,
    fetch: fetchImpl,
    settingsStore: store,
    leaseMs: options.leaseMs,
  });
  if (options.consentSince !== null && options.settings?.consentState === "enabled") {
    db.prepare("INSERT INTO pulse_consent_windows (started_at) VALUES (?)").run(
      options.consentSince ?? NOW - 3 * DAY_MS,
    );
  }
  return {
    db,
    store,
    service,
    requests,
    saved: () => store.load() as PulsePrivateSettings,
    advance: (ms: number) => {
      clock += ms;
    },
    dailyRequests: () => requests.filter((request) => request.path === "/v1/daily"),
  };
}

function enabledSettings(overrides: Partial<PulsePrivateSettings> = {}): PulsePrivateSettings {
  return {
    consentState: "enabled",
    installationId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
    deletionToken: "synthetic-token-".padEnd(43, "x"),
    enrolled: true,
    revision: 1,
    identityStartedAt: NOW - 5 * DAY_MS,
    identityEndpoint: ENDPOINT,
    ...overrides,
  };
}

describe("Pulse lifecycle: the latest decision wins", () => {
  it("disabling during enrollment is not undone by the late enrollment response", async () => {
    const gate = deferred();
    const f = fixture({
      settings: enabledSettings({ enrolled: false }),
      handler: async (url) => {
        if (new URL(url).pathname === "/v1/installations") await gate.promise;
        return { ok: true, status: 202 };
      },
    });
    const running = f.service.flush();
    await Promise.resolve();
    await f.service.setEnabled(false);
    expect(f.saved().consentState).toBe("disabled");
    gate.release();
    const result = await running;
    expect(result.outcome).toBe("cancelled_by_state_change");
    expect(f.saved().consentState).toBe("disabled");
    expect(f.saved().enrolled).toBe(false);
    expect(f.dailyRequests()).toHaveLength(0);
  });

  it("disabling during the daily upload keeps consent off and records nothing", async () => {
    const gate = deferred();
    const f = fixture({
      settings: enabledSettings(),
      handler: async (url) => {
        if (new URL(url).pathname === "/v1/daily") await gate.promise;
        return { ok: true, status: 202 };
      },
    });
    const running = f.service.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.service.setEnabled(false);
    gate.release();
    const result = await running;
    expect(result.outcome).toBe("cancelled_by_state_change");
    expect(f.saved().consentState).toBe("disabled");
    expect(f.saved().lastSentAt).toBeUndefined();
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM pulse_outbox").get()).toEqual({ n: 0 });
  });

  it("aborts this process's active delivery on disable", async () => {
    let aborted = false;
    const f = fixture({
      settings: enabledSettings(),
      handler: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    });
    const running = f.service.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.service.setEnabled(false);
    expect((await running).outcome).toBe("cancelled_by_state_change");
    expect(aborted).toBe(true);
    expect(f.saved().lastErrorCode).toBeUndefined();
  });

  it("a stale error response never overwrites a newer decision", async () => {
    const gate = deferred();
    const f = fixture({
      settings: enabledSettings(),
      handler: async () => {
        await gate.promise;
        return { ok: false, status: 500 };
      },
    });
    const running = f.service.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.service.resetIdentity();
    const rotated = f.saved();
    gate.release();
    expect((await running).outcome).toBe("cancelled_by_state_change");
    expect(f.saved()).toEqual(rotated);
    expect(f.saved().lastErrorCode).toBeUndefined();
  });

  it("reset during enrollment keeps the new identity and its own consent window", async () => {
    const gate = deferred();
    const f = fixture({
      settings: enabledSettings({ enrolled: false }),
      handler: async () => {
        await gate.promise;
        return { ok: true, status: 202 };
      },
    });
    const oldId = f.saved().installationId;
    const running = f.service.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reset = await f.service.resetIdentity();
    gate.release();
    await running;
    const latest = f.saved();
    expect(reset.success).toBe(true);
    expect(latest.installationId).not.toBe(oldId);
    expect(latest.enrolled).toBe(false);
    expect(latest.identityStartedAt).toBe(NOW);
    // Yesterday was consented only under the old identity.
    expect(f.service.getSettings().preview).toMatchObject({
      state: "ineligible",
      reason: "incomplete_consent_day",
    });
    expect((await f.service.flush()).outcome).toBe("no_eligible_day");
  });

  it("two simultaneous mutations each advance the revision", async () => {
    const f = fixture({ settings: enabledSettings({ revision: 4 }) });
    await Promise.all([f.service.setEnabled(false), f.service.resetIdentity()]);
    expect(f.saved().revision).toBe(6);
    expect(f.saved().consentState).toBe("disabled");
  });

  it("does not wait for a slow upload before persisting opt-out", async () => {
    const f = fixture({
      settings: enabledSettings(),
      handler: () => new Promise(() => undefined),
    });
    void f.service.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const started = Date.now();
    await f.service.setEnabled(false);
    expect(Date.now() - started).toBeLessThan(500);
    expect(f.saved().consentState).toBe("disabled");
  });
});

describe("Pulse remote deletion", () => {
  it("turns reporting off before the request and clears identity only on acknowledgement", async () => {
    const gate = deferred();
    let stateDuringRequest: PulsePrivateSettings | null = null;
    const f = fixture({
      settings: enabledSettings(),
      handler: async (_url, init) => {
        if (init.method === "DELETE") {
          stateDuringRequest = f.saved();
          await gate.promise;
        }
        return { ok: true, status: 200 };
      },
    });
    const deletion = f.service.deleteRemoteData();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stateDuringRequest).toMatchObject({ consentState: "disabled" });
    expect(stateDuringRequest!.pendingDeletion?.installationId).toBe(
      enabledSettings().installationId,
    );
    gate.release();
    const result = await deletion;
    expect(result.success).toBe(true);
    expect(f.saved().installationId).toBeUndefined();
    expect(f.saved().pendingDeletion).toBeUndefined();
    expect(result.settings.deletion.state).toBe("none");
    expect(result.settings.consentState).toBe("disabled");
  });

  it("delete during a pending upload does not resurrect the old identity", async () => {
    const gate = deferred();
    const f = fixture({
      settings: enabledSettings(),
      handler: async (url, init) => {
        if (new URL(url).pathname === "/v1/daily") await gate.promise;
        return { ok: true, status: init.method === "DELETE" ? 200 : 202 };
      },
    });
    const running = f.service.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    const deletion = await f.service.deleteRemoteData();
    gate.release();
    await running;
    expect(deletion.success).toBe(true);
    expect(f.saved().consentState).toBe("disabled");
    expect(f.saved().installationId).toBeUndefined();
    expect(f.saved().lastSentAt).toBeUndefined();
  });

  it("keeps the deletion target across failure and restart, blocks enable/reset, and retries", async () => {
    const db = new Database(":memory:");
    openDbs.push(db);
    const failing = fixture({
      db,
      settings: enabledSettings(),
      handler: async () => ({ ok: false, status: 503 }),
    });
    const failed = await failing.service.deleteRemoteData();
    expect(failed.success).toBe(false);
    expect(failed.error).toBe("http_503");
    expect(failed.settings.enabled).toBe(false);
    expect(failed.settings.deletion).toMatchObject({ state: "pending", lastErrorCode: "http_503" });
    expect(failed.settings.preview).toEqual({ state: "ineligible", reason: "deletion_pending" });
    await failing.service.shutdown();

    // "Restart": a new service over the same database.
    const restarted = fixture({ db, handler: async () => ({ ok: true, status: 200 }) });
    expect(restarted.service.getSettings().deletion.state).toBe("pending");
    expect((await restarted.service.setEnabled(true)).error).toBe("deletion_pending");
    expect((await restarted.service.resetIdentity()).error).toBe("deletion_pending");
    expect(restarted.saved().consentState).toBe("disabled");
    // Restart never silently resumes usage delivery.
    expect((await restarted.service.flush()).outcome).toBe("no_eligible_day");
    expect(restarted.requests).toHaveLength(0);

    const retried = await restarted.service.deleteRemoteData();
    expect(retried.success).toBe(true);
    const deleteRequest = restarted.requests.find((request) => request.method === "DELETE")!;
    expect(deleteRequest.authorization).toBe(`PulseDeletion ${enabledSettings().deletionToken}`);
    expect(JSON.parse(deleteRequest.body!)).toEqual({
      installationId: enabledSettings().installationId,
    });
    expect(restarted.saved().pendingDeletion).toBeUndefined();
    expect((await restarted.service.setEnabled(true)).success).toBe(true);
  });

  it("pins deletion to the enrolled endpoint even if the override changes", async () => {
    const hosts: string[] = [];
    const f = fixture({
      settings: enabledSettings({
        identityEndpoint: "https://collector-a.example.com",
        endpoint: "https://collector-b.example.com",
      }),
      handler: async (target) => {
        hosts.push(new URL(target).host);
        return { ok: true, status: 200 };
      },
    });
    expect((await f.service.deleteRemoteData()).success).toBe(true);
    expect(hosts).toEqual(["collector-a.example.com"]);
  });

  it("a stale deletion acknowledgement does not clear a newer identity", async () => {
    const gate = deferred();
    const f = fixture({
      settings: enabledSettings(),
      handler: async () => {
        await gate.promise;
        return { ok: true, status: 200 };
      },
    });
    const deletion = f.service.deleteRemoteData();
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Another process resolves the deletion and the user opts in with a fresh identity.
    const current = f.saved();
    delete current.pendingDeletion;
    current.installationId = "7ba7b810-9dad-41d1-80b4-00c04fd430c8";
    current.consentState = "enabled";
    current.revision = (current.revision ?? 0) + 1;
    f.store.save(current);
    gate.release();
    await deletion;
    expect(f.saved().installationId).toBe("7ba7b810-9dad-41d1-80b4-00c04fd430c8");
    expect(f.saved().consentState).toBe("enabled");
  });
});

describe("Pulse delivery: one queue, receipts, accurate preview", () => {
  it("does not resend an acknowledged day on a second flush or after restart", async () => {
    const db = new Database(":memory:");
    openDbs.push(db);
    const f = fixture({ db, settings: enabledSettings() });
    expect((await f.service.flush()).outcome).toBe("sent");
    expect((await f.service.flush()).outcome).toBe("already_sent");
    expect(f.dailyRequests()).toHaveLength(1);
    await f.service.shutdown();

    const restarted = fixture({ db });
    expect((await restarted.service.flush()).outcome).toBe("already_sent");
    expect(restarted.dailyRequests()).toHaveLength(0);
    expect(restarted.service.getSettings().preview).toMatchObject({
      state: "already_sent",
      periodStart: YESTERDAY,
    });
  });

  it("the preview is exactly the backlog package that is transmitted next", async () => {
    const f = fixture({ settings: enabledSettings() });
    const insert = f.db.prepare(
      "INSERT INTO pulse_outbox (package_id, installation_id, period_start, payload_json, created_at, attempt_count) VALUES (?, ?, ?, ?, ?, 0)",
    );
    const installationId = enabledSettings().installationId!;
    const older = JSON.stringify({
      packageId: "a".repeat(64),
      period: { start: "2026-09-22T00:00:00.000Z" },
    });
    const newer = JSON.stringify({
      packageId: "b".repeat(64),
      period: { start: "2026-09-24T00:00:00.000Z" },
    });
    insert.run("a".repeat(64), installationId, "2026-09-22T00:00:00.000Z", older, 2);
    insert.run("b".repeat(64), installationId, "2026-09-24T00:00:00.000Z", newer, 1);
    const preview = f.service.getSettings().preview;
    expect(preview.state).toBe("queued");
    await f.service.flush();
    expect(f.dailyRequests()[0].body).toBe(older);
    expect(preview.state === "queued" && preview.package.packageId).toBe("a".repeat(64));
  });

  it("opening settings has no side effect on the outbox", () => {
    const f = fixture({ settings: enabledSettings() });
    const settings = f.service.getSettings();
    expect(settings.preview.state).toBe("candidate");
    expect(settings.pendingPackage?.period.start).toBe(YESTERDAY);
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM pulse_outbox").get()).toEqual({ n: 0 });
  });

  it("a lost response retries identical bytes and package ID", async () => {
    let calls = 0;
    const f = fixture({
      settings: enabledSettings(),
      handler: async () => {
        calls++;
        if (calls === 1) throw new Error("The operation was aborted due to timeout");
        return { ok: true, status: 202 };
      },
    });
    const first = await f.service.flush();
    expect(first.outcome).toBe("error");
    expect(first.error).toBe("timeout");
    expect(first.settings.preview.state).toBe("queued");
    f.advance(60_000);
    expect((await f.service.flush()).outcome).toBe("sent");
    const [a, b] = f.dailyRequests();
    expect(b.body).toBe(a.body);
  });

  it("receipt and outbox removal survive restart as one unit", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-receipt-"));
    tempDirs.push(dir);
    const file = path.join(dir, "profile.db");
    const first = new Database(file);
    const f = fixture({ db: first, settings: enabledSettings() });
    await f.service.flush();
    await f.service.shutdown();
    first.close();
    const reopened = new Database(file);
    openDbs.push(reopened);
    expect(reopened.prepare("SELECT COUNT(*) AS n FROM pulse_outbox").get()).toEqual({ n: 0 });
    expect(reopened.prepare("SELECT period_start FROM pulse_sent_days").all()).toEqual([
      { period_start: YESTERDAY },
    ]);
  });

  it("refreshes the preview across a UTC rollover", async () => {
    let clock = NOW;
    const f = fixture({ settings: enabledSettings(), now: () => clock });
    const before = f.service.getSettings().pendingPackage!.period.start;
    clock += DAY_MS;
    const after = f.service.getSettings().pendingPackage!.period.start;
    expect(before).toBe(YESTERDAY);
    expect(after).toBe("2026-09-26T00:00:00.000Z");
  });

  it("keeps receipts across off/on for the same identity", async () => {
    const f = fixture({ settings: enabledSettings() });
    await f.service.flush();
    await f.service.setEnabled(false);
    await f.service.setEnabled(true);
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(f.db.prepare("SELECT COUNT(*) AS n FROM pulse_sent_days").get()).toEqual({ n: 1 });
    expect(f.dailyRequests()).toHaveLength(1);
  });

  it("disabled and deletion-pending previews are ineligible and Send reports why", async () => {
    const f = fixture({ settings: { consentState: "disabled" } });
    expect(f.service.getSettings().preview).toEqual({ state: "ineligible", reason: "disabled" });
    expect((await f.service.flush()).outcome).toBe("no_eligible_day");
  });

  it("reports the first eligible day after opting in", async () => {
    const f = fixture({ settings: { consentState: "unset" } });
    await f.service.setEnabled(true);
    expect(f.service.getSettings().preview).toEqual({
      state: "ineligible",
      reason: "incomplete_consent_day",
      eligibleFrom: "2026-09-27T00:00:00.000Z",
    });
  });

  it("coalesces concurrent flushes in one process", async () => {
    const gate = deferred();
    const f = fixture({
      settings: enabledSettings(),
      handler: async () => {
        await gate.promise;
        return { ok: true, status: 202 };
      },
    });
    const a = f.service.flush();
    const b = f.service.flush();
    gate.release();
    expect(await a).toBe(await b);
    expect(f.dailyRequests()).toHaveLength(1);
  });
});

describe("Pulse across processes sharing one profile", () => {
  function sharedFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pulse-shared-"));
    tempDirs.push(dir);
    return path.join(dir, "profile.db");
  }

  it("two connections cannot deliver concurrently and the second reports busy", async () => {
    const file = sharedFile();
    const dbA = new Database(file);
    const dbB = new Database(file);
    openDbs.push(dbA, dbB);
    const gate = deferred();
    const a = fixture({
      db: dbA,
      settings: enabledSettings(),
      handler: async () => {
        await gate.promise;
        return { ok: true, status: 202 };
      },
    });
    const b = fixture({ db: dbB });
    const running = a.service.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await b.service.flush()).outcome).toBe("busy");
    gate.release();
    expect((await running).outcome).toBe("sent");
    expect((await b.service.flush()).outcome).toBe("already_sent");
    expect(a.dailyRequests().length + b.dailyRequests().length).toBe(1);
  });

  it("a disable in another process fences this process's in-flight result", async () => {
    const file = sharedFile();
    const dbA = new Database(file);
    const dbB = new Database(file);
    openDbs.push(dbA, dbB);
    const gate = deferred();
    const a = fixture({
      db: dbA,
      settings: enabledSettings(),
      handler: async () => {
        await gate.promise;
        return { ok: true, status: 202 };
      },
    });
    const b = fixture({ db: dbB });
    const running = a.service.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await b.service.setEnabled(false);
    gate.release();
    expect((await running).outcome).toBe("cancelled_by_state_change");
    expect(a.saved().consentState).toBe("disabled");
    expect(dbA.prepare("SELECT COUNT(*) AS n FROM pulse_sent_days").get()).toEqual({ n: 0 });
  });

  it("an expired lease owner cannot persist its result", async () => {
    const file = sharedFile();
    const dbA = new Database(file);
    const dbB = new Database(file);
    openDbs.push(dbA, dbB);
    let clock = NOW;
    const gate = deferred();
    const a = fixture({
      db: dbA,
      now: () => clock,
      settings: enabledSettings(),
      leaseMs: 30_000,
      handler: async () => {
        await gate.promise;
        return { ok: true, status: 202 };
      },
    });
    const b = fixture({ db: dbB, now: () => clock, leaseMs: 30_000 });
    const running = a.service.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    clock += 31_000;
    // B takes over the expired lease and delivers.
    expect((await b.service.flush()).outcome).toBe("sent");
    gate.release();
    expect((await running).outcome).toBe("cancelled_by_state_change");
    expect(dbA.prepare("SELECT COUNT(*) AS n FROM pulse_sent_days").get()).toEqual({ n: 1 });
  });

  it("separate profiles operate independently", async () => {
    const a = fixture({ settings: enabledSettings() });
    const b = fixture({
      settings: enabledSettings({ installationId: "8ba7b810-9dad-41d1-80b4-00c04fd430c8" }),
    });
    const [ra, rb] = await Promise.all([a.service.flush(), b.service.flush()]);
    expect(ra.outcome).toBe("sent");
    expect(rb.outcome).toBe("sent");
  });
});

describe("Pulse start, stop and shutdown", () => {
  it("repeated start/stop leaves no timers and shutdown settles in-flight work", async () => {
    const f = fixture({
      settings: enabledSettings(),
      handler: (_url, init) =>
        new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    });
    f.service.start();
    f.service.start();
    f.service.stop();
    f.service.start();
    const running = f.service.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.service.shutdown(500);
    f.db.close();
    // The late rejection must not write to the closed database or throw.
    await expect(running).resolves.toMatchObject({ outcome: "cancelled_by_state_change" });
    await expect(f.service.flush()).resolves.toMatchObject({
      outcome: "cancelled_by_state_change",
    });
  });

  it("a response arriving after shutdown writes nothing", async () => {
    const gate = deferred();
    const f = fixture({
      settings: enabledSettings(),
      handler: async () => {
        await gate.promise;
        return { ok: true, status: 202 };
      },
    });
    const running = f.service.flush();
    await new Promise((resolve) => setTimeout(resolve, 0));
    await f.service.shutdown(10);
    f.db.close();
    gate.release();
    await expect(running).resolves.toMatchObject({ outcome: "cancelled_by_state_change" });
  });
});

describe("Pulse settings upgrade", () => {
  it("defaults revision to zero and starts identity eligibility at upgrade time", () => {
    const f = fixture({
      settings: {
        consentState: "enabled",
        installationId: "6ba7b810-9dad-41d1-80b4-00c04fd430c8",
        deletionToken: "legacy-token".padEnd(43, "x"),
        enrolled: true,
        enabledAt: NOW - 30 * DAY_MS,
      },
    });
    const settings = f.service.getSettings();
    expect(settings.revision).toBe(0);
    expect(settings.enabled).toBe(true);
    expect(f.saved().identityStartedAt).toBe(NOW);
    expect(f.saved().identityEndpoint).toBe(ENDPOINT);
    expect(settings.preview).toMatchObject({
      state: "ineligible",
      reason: "incomplete_consent_day",
    });
  });

  it("does not infer a sent day from lastSentAt", () => {
    const f = fixture({ settings: enabledSettings({ lastSentAt: NOW - 1000 }) });
    expect(f.service.getSettings().preview.state).toBe("candidate");
  });
});
