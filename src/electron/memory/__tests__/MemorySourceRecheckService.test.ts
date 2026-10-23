import Database from "better-sqlite3";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MEMORY_SOURCE_UNITS, ensureMemorySourcesSchema } from "../memory-source-sql";
import {
  MemorySourceRecheckService,
  itemSourceRef,
  parseRepoEntrySourceRef,
  repoEntrySourceRef,
} from "../MemorySourceRecheckService";

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

let dir: string;
let workspace: string;
let db: Database.Database;
let clock: number;

function service() {
  return new MemorySourceRecheckService({
    // The units run as they would in a transaction, with their arguments validated.
    run: async (name, args) => {
      const unit = MEMORY_SOURCE_UNITS[name as keyof typeof MEMORY_SOURCE_UNITS];
      return db.transaction(() => unit.run(db, unit.validate(args) as never))();
    },
    now: () => clock,
  });
}

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "memory-sources-"));
  workspace = path.join(dir, "ws");
  await fs.mkdir(path.join(workspace, "docs"), { recursive: true });
  db = new Database(":memory:");
  ensureMemorySourcesSchema(db);
  clock = Date.UTC(2026, 9, 19);
});

afterEach(async () => {
  db?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describeWithSqlite("MemorySourceRecheckService", () => {
  it("flags a memory when its file changes, and unflags it when the file is back", async () => {
    await fs.writeFile(path.join(workspace, "docs/pricing.md"), "Pro is $20");
    const recheck = service();
    const ref = repoEntrySourceRef("workspaces/acme.md", "abc123");
    expect(
      await recheck.trackFile({
        workspaceId: "ws-1",
        workspaceRoot: workspace,
        file: "./docs/pricing.md",
        memoryRef: ref,
      }),
    ).toEqual({ sourceKey: "docs/pricing.md" });

    const version = recheck.version();
    await fs.writeFile(path.join(workspace, "docs/pricing.md"), "Pro is $25");
    clock += 1_000;
    const event = {
      workspaceId: "ws-1",
      relPath: path.join("docs", "pricing.md"),
      absolutePath: path.join(workspace, "docs/pricing.md"),
    };
    expect(await recheck.onFileChanged(event)).toBe(1);
    expect(recheck.flagForRepoEntry("workspaces/acme.md", "abc123")).toEqual({
      sourceKind: "file",
      sourceKey: "docs/pricing.md",
      changedAt: clock,
    });
    expect(recheck.version()).not.toBe(version);

    // Another workspace's file of the same name is not this source.
    expect(await recheck.onFileChanged({ ...event, workspaceId: "ws-2" })).toBe(0);

    await fs.writeFile(path.join(workspace, "docs/pricing.md"), "Pro is $20");
    expect(await recheck.onFileChanged(event)).toBe(0);
    expect(recheck.flagForRepoEntry("workspaces/acme.md", "abc123")).toBeUndefined();
  });

  it("flags when the file is deleted, and keeps flags across a reload", async () => {
    await fs.writeFile(path.join(workspace, "docs/a.md"), "a");
    const recheck = service();
    await recheck.trackFile({
      workspaceId: "ws-1",
      workspaceRoot: workspace,
      file: "docs/a.md",
      memoryRef: itemSourceRef("item-1"),
    });
    await fs.rm(path.join(workspace, "docs/a.md"));
    await recheck.onFileChanged({
      workspaceId: "ws-1",
      relPath: "docs/a.md",
      absolutePath: path.join(workspace, "docs/a.md"),
    });

    const fresh = service();
    expect(fresh.flagForItem("item-1")).toBeUndefined();
    await fresh.load();
    expect(fresh.flagForItem("item-1")).toMatchObject({ sourceKey: "docs/a.md" });
  });

  it("links only existing files inside the workspace", async () => {
    await fs.writeFile(path.join(dir, "outside.md"), "secret");
    const recheck = service();
    const track = (file: string) =>
      recheck.trackFile({
        workspaceId: "ws-1",
        workspaceRoot: workspace,
        file,
        memoryRef: itemSourceRef("item-1"),
      });
    expect(await track("../outside.md")).toBeUndefined();
    expect(await track(path.join(dir, "outside.md"))).toBeUndefined();
    expect(await track("docs/missing.md")).toBeUndefined();
    expect(await track("docs")).toBeUndefined();
  });

  it("flags memories of an updated connector record", async () => {
    const recheck = service();
    await recheck.trackConnector({
      resourceUri: "jira://issue/OPS-1",
      memoryRef: itemSourceRef("item-9"),
    });
    expect(await recheck.onConnectorRecordChanged("jira://issue/OPS-2")).toBe(0);
    expect(await recheck.onConnectorRecordChanged("jira://issue/OPS-1")).toBe(1);
    expect(recheck.flagForItem("item-9")).toMatchObject({ sourceKind: "connector" });
  });

  it("gives the dream flagged folder entries with the current source, then clears them", async () => {
    await fs.writeFile(path.join(workspace, "docs/pricing.md"), "Pro is $20");
    const recheck = service();
    const ref = repoEntrySourceRef("workspaces/acme.md", "abc123");
    await recheck.trackFile({
      workspaceId: "ws-1",
      workspaceRoot: workspace,
      file: "docs/pricing.md",
      memoryRef: ref,
    });
    await recheck.trackFile({
      workspaceId: "ws-1",
      workspaceRoot: workspace,
      file: "docs/pricing.md",
      memoryRef: itemSourceRef("item-1"),
    });
    await fs.writeFile(path.join(workspace, "docs/pricing.md"), `Pro is $25 ${"x".repeat(3_000)}`);
    await recheck.onFileChanged({
      workspaceId: "ws-1",
      relPath: "docs/pricing.md",
      absolutePath: path.join(workspace, "docs/pricing.md"),
    });

    // Items are not in the memory folder: only the folder entry goes to the dream.
    const pending = await recheck.pendingForDream(10);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      file: "workspaces/acme.md",
      entryHash: "abc123",
      source: "docs/pricing.md",
    });
    expect(pending[0].excerpt.startsWith("Pro is $25")).toBe(true);
    expect(pending[0].excerpt.length).toBeLessThanOrEqual(1_501);

    await recheck.markReviewed(pending.map((entry) => entry.row));
    expect(recheck.flagForRepoEntry("workspaces/acme.md", "abc123")).toBeUndefined();
    expect(await recheck.pendingForDream(10)).toEqual([]);
    // Reviewed against the new content: an unrelated touch does not flag it again.
    expect(
      await recheck.onFileChanged({
        workspaceId: "ws-1",
        relPath: "docs/pricing.md",
        absolutePath: path.join(workspace, "docs/pricing.md"),
      }),
    ).toBe(1); // the item, still saved from the old content
    expect(recheck.flagForRepoEntry("workspaces/acme.md", "abc123")).toBeUndefined();
  });

  it("re-saving a memory from its source clears the flag", async () => {
    await fs.writeFile(path.join(workspace, "docs/a.md"), "v1");
    const recheck = service();
    const link = () =>
      recheck.trackFile({
        workspaceId: "ws-1",
        workspaceRoot: workspace,
        file: "docs/a.md",
        memoryRef: itemSourceRef("item-1"),
      });
    await link();
    await fs.writeFile(path.join(workspace, "docs/a.md"), "v2");
    await recheck.onFileChanged({
      workspaceId: "ws-1",
      relPath: "docs/a.md",
      absolutePath: path.join(workspace, "docs/a.md"),
    });
    expect(recheck.flagForItem("item-1")).toBeDefined();
    await link();
    expect(recheck.flagForItem("item-1")).toBeUndefined();
  });

  it("parses folder entry refs", () => {
    expect(parseRepoEntrySourceRef(repoEntrySourceRef("workspaces\\a.md", "f00"))).toEqual({
      file: "workspaces/a.md",
      entryHash: "f00",
    });
    expect(parseRepoEntrySourceRef("memory:item-1")).toBeNull();
    expect(parseRepoEntrySourceRef("repo-entry:no-hash#")).toBeNull();
  });
});
