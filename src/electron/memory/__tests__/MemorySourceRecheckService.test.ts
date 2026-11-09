import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
const workspaceLookup = vi.hoisted(() => ({ value: null as Any }));
vi.mock("../../database/repository-facades", async () => ({
  ...(await vi.importActual<typeof import("../../database/repository-facades")>(
    "../../database/repository-facades",
  )),
  WorkspaceRepository: class {
    async findById() {
      return workspaceLookup.value;
    }
  },
}));
import { MemoryService } from "../MemoryService";
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
    resolveSourceRoot: async () => fs.realpath(workspace),
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
  MemorySourceRecheckService.setDefault(null);
  vi.restoreAllMocks();
  db?.close();
  await fs.rm(dir, { recursive: true, force: true });
});

describeWithSqlite("MemorySourceRecheckService", () => {
  it("reauthorizes default-service evidence against current workspace root, privacy and read policy", async () => {
    workspaceLookup.value = {
      id: "ws-1",
      path: workspace,
      permissions: { read: true, write: true, delete: true, shell: false, network: false },
    };
    const settings = { enabled: true, privacyMode: "normal" };
    vi.spyOn(MemoryService, "getDatabase").mockReturnValue(db);
    vi.spyOn(MemoryService, "getSettings").mockImplementation(async () => settings as Any);
    vi.spyOn(MemoryService, "getStatements").mockReturnValue({
      unit: async (name: string, args: unknown[]) => {
        const unit = MEMORY_SOURCE_UNITS[name as keyof typeof MEMORY_SOURCE_UNITS];
        return db.transaction(() => unit.run(db, unit.validate(args) as never))();
      },
    } as Any);
    const recheck = MemorySourceRecheckService.getDefault();
    const file = path.join(workspace, "docs/default.md");
    await fs.writeFile(file, "initial");
    await recheck.trackFile({
      workspaceId: "ws-1",
      workspaceRoot: workspace,
      file,
      memoryRef: repoEntrySourceRef("me.md", "default"),
    });
    await fs.writeFile(file, "changed");
    await recheck.onFileChanged({
      workspaceId: "ws-1",
      relPath: "docs/default.md",
      absolutePath: file,
    });
    const available = async () => (await recheck.pendingForDream())[0].evidenceAvailable;
    expect(await available()).toBe(true);
    for (const mode of ["disabled", "strict"]) {
      settings.privacyMode = mode;
      expect(await available()).toBe(false);
    }
    settings.privacyMode = "normal";
    settings.enabled = false;
    expect(await available()).toBe(false);
    settings.enabled = true;
    workspaceLookup.value.permissions.read = false;
    expect(await available()).toBe(false);
    workspaceLookup.value.permissions.read = true;
    expect(await available()).toBe(true);
    workspaceLookup.value.path = dir;
    expect(await available()).toBe(false);
  });
  it("withholds evidence and review clearing when current workspace authority is revoked", async () => {
    let allowed = true;
    const recheck = new MemorySourceRecheckService({
      run: async (name, args) => {
        const unit = MEMORY_SOURCE_UNITS[name as keyof typeof MEMORY_SOURCE_UNITS];
        return db.transaction(() => unit.run(db, unit.validate(args) as never))();
      },
      resolveSourceRoot: async () => (allowed ? fs.realpath(workspace) : null),
    });
    const file = path.join(workspace, "docs/source.md");
    await fs.writeFile(file, "initial");
    await recheck.trackFile({
      workspaceId: "ws-1",
      workspaceRoot: workspace,
      file,
      memoryRef: repoEntrySourceRef("me.md", "fixture"),
    });
    await fs.writeFile(file, "changed");
    await recheck.onFileChanged({
      workspaceId: "ws-1",
      relPath: "docs/source.md",
      absolutePath: file,
    });
    const [before] = await recheck.pendingForDream();
    expect(before.evidenceAvailable).toBe(true);
    allowed = false;
    expect((await recheck.pendingForDream())[0].evidenceAvailable).toBe(false);
    await recheck.markReviewed([before]);
    expect(await recheck.pendingForDream()).toHaveLength(1);
  });
  it.each(["leaf", "ancestor"])(
    "does not hash or excerpt a tracked source replaced by a %s link",
    async (kind) => {
      const file = path.join(workspace, "docs/source.md");
      await fs.writeFile(file, "initial");
      const recheck = service();
      await recheck.trackFile({
        workspaceId: "ws-1",
        workspaceRoot: workspace,
        file,
        memoryRef: repoEntrySourceRef("me.md", "fixture"),
      });
      const outside = path.join(dir, "outside");
      await fs.mkdir(outside);
      await fs.writeFile(path.join(outside, "source.md"), "PRIVATE_SENTINEL");
      if (kind === "ancestor") {
        await fs.rm(path.join(workspace, "docs"), { recursive: true });
        await fs.symlink(outside, path.join(workspace, "docs"));
      } else {
        await fs.unlink(file);
        await fs.symlink(path.join(outside, "source.md"), file);
      }
      expect(
        await recheck.onFileChanged({
          workspaceId: "ws-1",
          relPath: "docs/source.md",
          absolutePath: file,
        }),
      ).toBe(1);
      const pending = await recheck.pendingForDream();
      expect(pending).toHaveLength(1);
      expect(pending[0].evidenceAvailable).toBe(false);
      expect(pending[0].excerpt).not.toContain("PRIVATE_SENTINEL");
      await recheck.markReviewed(pending);
      expect(await recheck.pendingForDream()).toHaveLength(1);
    },
  );
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
      evidenceAvailable: true,
      observedContentHash: createHash("sha256")
        .update(`Pro is $25 ${"x".repeat(3_000)}`)
        .digest("hex"),
    });
    expect(pending[0].excerpt.startsWith("Pro is $25")).toBe(true);
    expect(pending[0].excerpt.length).toBeLessThanOrEqual(1_501);

    await recheck.markReviewed(pending);
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

  async function changedFile(
    recheck: MemorySourceRecheckService,
    file = "docs/a.md",
    memoryRef = repoEntrySourceRef("workspaces/acme.md", "abc123"),
  ) {
    const absolutePath = path.join(workspace, file);
    await fs.writeFile(absolutePath, "original");
    await recheck.trackFile({ workspaceId: "ws-1", workspaceRoot: workspace, file, memoryRef });
    await fs.writeFile(absolutePath, "changed");
    const event = { workspaceId: "ws-1", relPath: file, absolutePath };
    await recheck.onFileChanged(event);
    return event;
  }

  it("keeps a flag when the file changes after the dream snapshot even before a notification", async () => {
    const recheck = service();
    const event = await changedFile(recheck);
    const pending = await recheck.pendingForDream();
    await fs.writeFile(event.absolutePath, "changed again while dreaming");

    await recheck.markReviewed(pending);

    expect(recheck.flagForRepoEntry("workspaces/acme.md", "abc123")).toBeDefined();
    const remaining = await recheck.pendingForDream();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].excerpt).toBe("changed again while dreaming");
    expect(remaining[0].row.contentHash).toBe(pending[0].row.contentHash);
  });

  it("does not clear a newer source notification from the same clock tick", async () => {
    const recheck = service();
    const event = await changedFile(recheck);
    const pending = await recheck.pendingForDream();
    // The bytes still match the evidence, but a later notification is a newer revision.
    await recheck.onFileChanged(event);
    const latest = await recheck.pendingForDream();
    expect(latest[0].row.changedAt).toBeGreaterThan(pending[0].row.changedAt!);

    await recheck.markReviewed(pending);
    expect(recheck.flagForRepoEntry("workspaces/acme.md", "abc123")).toBeDefined();
    expect(await recheck.pendingForDream()).toHaveLength(1);

    await recheck.markReviewed(latest);
    expect(recheck.flagForRepoEntry("workspaces/acme.md", "abc123")).toBeUndefined();
    expect(await recheck.pendingForDream()).toEqual([]);
  });

  it("keeps unavailable connector and deleted-file evidence unresolved", async () => {
    const recheck = service();
    const event = await changedFile(recheck);
    await fs.rm(event.absolutePath);
    await recheck.onFileChanged(event);
    await recheck.trackConnector({
      resourceUri: "jira://issue/OPS-1",
      memoryRef: repoEntrySourceRef("workspaces/acme.md", "connector"),
    });
    await recheck.onConnectorRecordChanged("jira://issue/OPS-1");
    const pending = await recheck.pendingForDream();
    expect(pending).toHaveLength(2);
    for (const entry of pending) {
      expect(entry.evidenceAvailable).toBe(false);
      expect(entry.observedContentHash).toBeNull();
    }

    await recheck.markReviewed(pending);

    expect(await recheck.pendingForDream()).toHaveLength(2);
    expect(recheck.flagForRepoEntry("workspaces/acme.md", "abc123")).toBeDefined();
    expect(recheck.flagForRepoEntry("workspaces/acme.md", "connector")).toBeDefined();
  });

  it("requires evidence availability and a matching snapshot hash to confirm a recheck", async () => {
    const recheck = service();
    await changedFile(recheck);
    const [pending] = await recheck.pendingForDream();
    await recheck.markReviewed([{ ...pending, evidenceAvailable: false }]);
    await recheck.markReviewed([{ ...pending, observedContentHash: null }]);
    await recheck.markReviewed([{ ...pending, observedContentHash: "different" }]);
    expect(await recheck.pendingForDream()).toHaveLength(1);
    await recheck.markReviewed([pending]);
    expect(await recheck.pendingForDream()).toEqual([]);
  });

  it("redacts source evidence while hashing all original bytes of the same snapshot", async () => {
    const recheck = service();
    const event = await changedFile(recheck);
    const source = `Plan remains Pro.\napi_key=sk-proj-abcdefghijklmnopqrstuvwxyz123456\n${"tail".repeat(2_000)}`;
    await fs.writeFile(event.absolutePath, source);
    await recheck.onFileChanged(event);

    const [pending] = await recheck.pendingForDream();

    expect(pending.evidenceAvailable).toBe(true);
    expect(pending.excerpt).toContain("Plan remains Pro.");
    expect(pending.excerpt).not.toContain("sk-proj-abcdefghijklmnopqrstuvwxyz123456");
    expect(pending.observedContentHash).toBe(createHash("sha256").update(source).digest("hex"));
    expect(pending.observedContentHash).not.toBe(
      createHash("sha256").update(pending.excerpt).digest("hex"),
    );
  });

  it("keeps another source's flag when one source is reviewed, restored, re-saved or removed", async () => {
    const recheck = service();
    const ref = repoEntrySourceRef("workspaces/acme.md", "abc123");
    await changedFile(recheck);
    await recheck.trackConnector({ resourceUri: "jira://issue/OPS-1", memoryRef: ref });
    await recheck.onConnectorRecordChanged("jira://issue/OPS-1");
    const fileEvidence = (await recheck.pendingForDream()).filter(
      (entry) => entry.row.sourceKind === "file",
    );
    await recheck.markReviewed(fileEvidence);
    expect(recheck.flagForRepoEntry("workspaces/acme.md", "abc123")).toMatchObject({
      sourceKind: "connector",
    });

    const event = await changedFile(recheck);
    await fs.writeFile(event.absolutePath, "original");
    await recheck.onFileChanged(event);
    expect(recheck.flagForRepoEntry("workspaces/acme.md", "abc123")).toMatchObject({
      sourceKind: "connector",
    });

    await changedFile(recheck);
    await recheck.trackFile({
      workspaceId: "ws-1",
      workspaceRoot: workspace,
      file: "docs/a.md",
      memoryRef: ref,
    });
    expect(recheck.flagForRepoEntry("workspaces/acme.md", "abc123")).toMatchObject({
      sourceKind: "connector",
    });

    await changedFile(recheck);
    const latest = await recheck.pendingForDream();
    await recheck.forget(
      latest.filter((entry) => entry.row.sourceKind === "file").map((entry) => entry.row),
    );
    expect(recheck.flagForRepoEntry("workspaces/acme.md", "abc123")).toMatchObject({
      sourceKind: "connector",
    });
    const loaded = service();
    await loaded.load();
    expect(loaded.flagForRepoEntry("workspaces/acme.md", "abc123")).toMatchObject({
      sourceKind: "connector",
    });
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
