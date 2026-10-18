import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DatabaseManager } from "../schema";
import { LifecycleMetaRepository } from "../repository-facades";
import { LifecycleMetaStore } from "../lifecycle-meta-sql";

vi.mock("../../utils/safe-storage", () => ({
  getSafeStorage: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  }),
}));

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      new module.default(":memory:").close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("lifecycle metadata store", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-lifecycle-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    manager = new DatabaseManager();
  });

  afterEach(() => {
    manager?.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("counts uses and never moves the last-used time back", () => {
    const store = new LifecycleMetaStore(manager.getDatabase());
    store.recordUse({ kind: "skill", id: "code-reviewer", at: 2_000 });
    store.recordUse({ kind: "skill", id: "code-reviewer", at: 1_000 });
    expect(store.get("skill", "code-reviewer")).toMatchObject({
      useCount: 2,
      lastUsedAt: 2_000,
      dependsOn: [],
      createdAt: 2_000,
    });
    expect(store.get("skill", "other")).toBeUndefined();
  });

  it("edits owner, dependencies and a rule's protects/evidence, and clears with null", () => {
    const store = new LifecycleMetaStore(manager.getDatabase());
    store.setMeta({
      kind: "rule",
      id: "rule-1",
      owner: "  Almarion ",
      protects: "constraint-7",
      evidence: "eval:invoice-totals",
      dependsOn: [
        { kind: "workspace", id: "ws-1" },
        { kind: "workspace", id: "ws-1" },
        { kind: "skill", id: "pdf" },
        { kind: "nonsense" as never, id: "x" },
      ],
      at: 10,
    });
    expect(store.get("rule", "rule-1")).toMatchObject({
      owner: "Almarion",
      protects: "constraint-7",
      evidence: "eval:invoice-totals",
      dependsOn: [
        { kind: "workspace", id: "ws-1" },
        { kind: "skill", id: "pdf" },
      ],
      useCount: 0,
    });
    store.setMeta({ kind: "rule", id: "rule-1", owner: null, at: 20 });
    const cleared = store.get("rule", "rule-1")!;
    expect(cleared.owner).toBeUndefined();
    expect(cleared.evidence).toBe("eval:invoice-totals");
  });

  it("retires and keeps; keep clears the retired mark and restarts the timer", () => {
    const store = new LifecycleMetaStore(manager.getDatabase());
    store.retire({ kind: "playbook", id: "entry-1", at: 100 });
    store.retire({ kind: "automation", id: "job-1", at: 100 });
    expect(store.listRetiredIds("playbook")).toEqual(["entry-1"]);

    const kept = store.keep({ kind: "playbook", id: "entry-1", at: 200 });
    expect(kept.retiredAt).toBeUndefined();
    expect(kept.keptAt).toBe(200);
    expect(store.listRetiredIds("playbook")).toEqual([]);
    expect(store.list({ kinds: ["automation"] }).map((meta) => meta.id)).toEqual(["job-1"]);
  });

  it("refuses unknown kinds and empty ids", () => {
    const store = new LifecycleMetaStore(manager.getDatabase());
    expect(() => store.recordUse({ kind: "artifact" as never, id: "a", at: 1 })).toThrow(
      "Unknown lifecycle kind",
    );
    expect(() => store.recordUse({ kind: "skill", id: " ", at: 1 })).toThrow("id is required");
  });

  it("runs through the async repository facade", async () => {
    const repository = new LifecycleMetaRepository(manager.getDatabase());
    await repository.recordUse({ kind: "playbook", id: "entry-2", at: 5 });
    await repository.retire({ kind: "playbook", id: "entry-2", at: 6 });
    expect(await repository.listRetiredIds("playbook")).toEqual(["entry-2"]);
    expect((await repository.get("playbook", "entry-2"))?.useCount).toBe(1);
  });
});
