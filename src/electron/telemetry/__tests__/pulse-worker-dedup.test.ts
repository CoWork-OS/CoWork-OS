import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import worker from "../../../../services/pulse-worker/src/index";

// Exercises the collector against a local SQLite stand-in for D1. No network.

const MIGRATIONS = path.resolve(__dirname, "../../../../services/pulse-worker/migrations");
const INSTALLATION_ID = "6ba7b810-9dad-41d1-80b4-00c04fd430c8";
const TOKEN = "synthetic-token-".padEnd(43, "x");
const PERIOD_START = "2026-09-03T00:00:00.000Z";

function fakeD1(db: Database.Database) {
  const statement = (query: string, values: unknown[] = []) => ({
    bind: (...next: unknown[]) => statement(query, next),
    run: async () => {
      db.prepare(query).run(...values);
      return { success: true };
    },
    all: async () => ({ success: true, results: db.prepare(query).all(...values) }),
    first: async () => db.prepare(query).get(...values) ?? null,
    exec: () => db.prepare(query).run(...values),
  });
  return {
    prepare: (query: string) => statement(query),
    batch: async (statements: Array<ReturnType<typeof statement>>) => {
      db.transaction(() => statements.forEach((item) => item.exec()))();
      return statements.map(() => ({ success: true }));
    },
  };
}

const dbs: Database.Database[] = [];
afterEach(() => {
  for (const db of dbs.splice(0)) db.close();
});

function environment() {
  const db = new Database(":memory:");
  dbs.push(db);
  for (const file of fs.readdirSync(MIGRATIONS).sort()) {
    db.exec(fs.readFileSync(path.join(MIGRATIONS, file), "utf8"));
  }
  return { db, env: { DB: fakeD1(db), INSTALLATION_HMAC_SECRET: "test-secret", ADMIN_TOKEN: "" } };
}

function dailyBody(): string {
  return JSON.stringify({
    schemaVersion: 1,
    packageId: createHash("sha256").update(`${INSTALLATION_ID}:${PERIOD_START}`).digest("hex"),
    installationId: INSTALLATION_ID,
    period: { start: PERIOD_START, end: "2026-09-04T00:00:00.000Z" },
    client: { version: "0.5.52", platform: "macos", architecture: "arm64", runtime: "desktop" },
    activity: {
      sessionsStarted: 1,
      tasksStarted: 1,
      tasksCompleted: 1,
      usefulTasks: 1,
      activeMinutesBucket: "1-15",
    },
    tools: { shell: 0, filesystem: 1, browser: 0, connector: 0, code: 0, other: 0 },
    reliability: {
      failedTasks: 0,
      cancelledTasks: 0,
      approvalRequests: 0,
      approvalDenials: 0,
      toolErrors: 0,
      llmErrors: 0,
    },
  });
}

describe("Pulse collector idempotent daily delivery", () => {
  it("acknowledges a retried identical package and keeps one daily row", async () => {
    const { db, env } = environment();
    const call = (method: string, pathname: string, body: string, authorization?: string) =>
      worker.fetch(
        new Request(`https://pulse.example.com${pathname}`, {
          method,
          body,
          headers: {
            "content-type": "application/json",
            ...(authorization ? { authorization } : {}),
          },
        }),
        env as never,
      );
    const enrolled = await call(
      "POST",
      "/v1/installations",
      JSON.stringify({
        schemaVersion: 1,
        installationId: INSTALLATION_ID,
        deletionToken: TOKEN,
        consentVersion: "2026-09-04",
      }),
    );
    expect(enrolled.status).toBe(202);
    const body = dailyBody();
    const first = await call("POST", "/v1/daily", body, `PulseWrite ${TOKEN}`);
    // A lost response: the client retries the identical bytes.
    const retry = await call("POST", "/v1/daily", body, `PulseWrite ${TOKEN}`);
    expect(first.status).toBe(202);
    expect(retry.status).toBe(202);
    expect(db.prepare("SELECT COUNT(*) AS n FROM pulse_daily_usage").get()).toEqual({ n: 1 });
  });
});
