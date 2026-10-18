import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../schema";

vi.mock("../../utils/safe-storage", () => ({
  getSafeStorage: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  }),
}));

const Database = await import("better-sqlite3")
  .then((module) => {
    try {
      new module.default(":memory:").close();
      return module.default;
    } catch {
      return null;
    }
  })
  .catch(() => null);

const describeWithSqlite = Database ? describe : describe.skip;

describeWithSqlite("work_session_evidence upgrade", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-evidence-upgrade-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
  });

  afterEach(() => {
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("adds basis and data_as_of to an evidence table created before them", () => {
    // The table as it existed before WP5, with one row.
    const legacy = new Database!(path.join(tmpDir, "cowork-os.db"));
    legacy.exec(`
      CREATE TABLE work_session_evidence (
        id TEXT PRIMARY KEY,
        session_id TEXT NOT NULL,
        contract_id TEXT,
        claim TEXT NOT NULL,
        source_type TEXT NOT NULL,
        source_ref TEXT NOT NULL,
        snippet TEXT,
        captured_at INTEGER NOT NULL,
        freshness_expires_at INTEGER,
        confidence REAL NOT NULL DEFAULT 0.5,
        status TEXT NOT NULL DEFAULT 'supporting',
        contradiction_group TEXT,
        item_id TEXT,
        artifact_revision_id TEXT,
        idempotency_key TEXT,
        created_at INTEGER NOT NULL,
        UNIQUE (session_id, idempotency_key)
      );
      INSERT INTO work_session_evidence (id, session_id, claim, source_type, source_ref, captured_at, created_at)
        VALUES ('e1', 's1', 'old claim', 'url', 'https://example.test', 1, 1);
    `);
    legacy.close();

    const manager = new DatabaseManager();
    try {
      const columns = (
        manager.getDatabase().pragma("table_info(work_session_evidence)") as Array<{
          name: string;
        }>
      ).map((column) => column.name);
      expect(columns).toEqual(expect.arrayContaining(["basis", "data_as_of"]));
      const row = manager
        .getDatabase()
        .prepare("SELECT claim, basis, data_as_of FROM work_session_evidence WHERE id = 'e1'")
        .get() as Record<string, unknown>;
      expect(row).toEqual({ claim: "old claim", basis: null, data_as_of: null });
    } finally {
      manager.close();
    }
  });
});
