import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepoService } from "../MemoryRepoService";
import { runMemoryRepoExport } from "../MemoryRepoExport";
import {
  runMemoryItemsFactRetirement,
  runMemoryRepoExportChain,
  type MemoryRepoRerunRequests,
} from "../MemoryItemsFactRetirement";
import { hashMemoryItemContent, type MemoryItem } from "../../memory-items-types";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeWithGit = hasGit() ? describe : describe.skip;

function item(id: string, content: string, overrides: Partial<MemoryItem> = {}): MemoryItem {
  return {
    id,
    workspaceId: null,
    scope: "global",
    scopeRef: null,
    kind: "preference",
    subjectKey: `preference:${id}`,
    content,
    source: "inferred",
    sourceRef: {},
    trust: 0.5,
    confidence: 0.7,
    status: "active",
    pinned: false,
    reinforcedCount: 0,
    lastUsedAt: null,
    supersedesId: null,
    contentHash: hashMemoryItemContent(content),
    privacy: "normal",
    taskId: null,
    expiresAt: null,
    createdAt: Date.UTC(2026, 8, 18),
    updatedAt: Date.UTC(2026, 8, 18),
    ...overrides,
  } as MemoryItem;
}

describeWithGit("runMemoryItemsFactRetirement", () => {
  let base: string;
  let service: MemoryRepoService;

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-fact-retire-"));
    service = new MemoryRepoService({ root: path.join(base, "repo"), runtime: "desktop" });
    await service.start();
  });

  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it("waits for the export, backs up and deletes only rows the folder holds, once", async () => {
    const items = [
      item("a", "Prefers bullet points"),
      item("b", "Deploys go through staging", {
        scope: "workspace",
        workspaceId: "ws-1",
        kind: "rule",
      }),
      item("c", "Call the bank on Friday", { kind: "commitment" }),
      item("d", "Bob wants the invoice", { scope: "contact", source: "third_party" }),
      item("e", "Secret project codename", { privacy: "private" }),
    ];
    const deleteItem = vi.fn(async () => []);
    const deps = {
      listItems: async () => items,
      deleteItem,
      encryption: null,
      backupDir: path.join(base, "backups"),
    };
    expect(await runMemoryItemsFactRetirement(service, deps)).toMatchObject({
      ran: false,
      reason: "not_ready",
    });

    await runMemoryRepoExport(service, {
      listItems: async () => items,
      workspaceName: async () => "Billing",
    });
    const all = (await service.listFiles())
      .map((file) => fs.readFileSync(path.join(service.root, file), "utf8"))
      .join("\n");
    expect(all).not.toContain("Call the bank");

    // One fact never reached the folder (e.g. the export skipped it): it stays.
    items.push(item("f", "Only in the old store"));
    const result = await runMemoryItemsFactRetirement(service, deps);
    expect(result).toMatchObject({ ran: true, retired: 2, kept: 1 });
    expect(deleteItem.mock.calls.map(([id]) => id).sort()).toEqual(["a", "b"]);
    const backups = fs.readdirSync(path.join(base, "backups"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^memory-items-facts-.*\.json$/);

    expect(await runMemoryItemsFactRetirement(service, deps)).toMatchObject({
      ran: false,
      reason: "done",
    });
    expect(deleteItem).toHaveBeenCalledTimes(2);
  });

  describe("re-run after a downgrade", () => {
    const folderText = async () =>
      (await service.listFiles())
        .map((file) => fs.readFileSync(path.join(service.root, file), "utf8"))
        .join("\n");

    function setup() {
      const items = [
        item("a", "Prefers bullet points", { sourceRef: { store: "user_profile", id: "f-a" } }),
      ];
      const deleteItem = vi.fn(async (id: string) => {
        const index = items.findIndex((entry) => entry.id === id);
        if (index >= 0) items.splice(index, 1);
        return [];
      });
      const deps = {
        listItems: async () => items.slice(),
        workspaceName: async () => "Billing",
        deleteItem,
        encryption: null,
        backupDir: path.join(base, "backups"),
      };
      return { items, deleteItem, deps };
    }

    function requests(request: Awaited<ReturnType<MemoryRepoRerunRequests["request"]>>) {
      const consume = vi.fn(async () => true);
      const rerun: MemoryRepoRerunRequests = {
        request: async () => request,
        consume,
        stores: new Set(["curated", "user_profile", "relationship"]),
      };
      return { rerun, consume };
    }

    it("does nothing again without a request", async () => {
      const { items, deleteItem, deps } = setup();
      await runMemoryRepoExportChain(service, { ...deps, rerun: requests(null).rerun });
      expect(deleteItem).toHaveBeenCalledTimes(1);
      items.push(
        item("n", "Prefers tabs over spaces", { sourceRef: { store: "curated", id: "c-n" } }),
      );
      const { exported, retired } = await runMemoryRepoExportChain(service, {
        ...deps,
        rerun: requests(null).rerun,
      });
      expect(exported).toMatchObject({ ran: false, reason: "done" });
      expect(retired).toMatchObject({ ran: false, reason: "done" });
      expect(await folderText()).not.toContain("tabs over spaces");
    });

    it("exports and retires only the reappeared lanes once, then consumes the request", async () => {
      const { items, deleteItem, deps } = setup();
      await runMemoryRepoExportChain(service, deps);
      expect(deleteItem.mock.calls.map(([id]) => id)).toEqual(["a"]);
      // Kept in memory_items on purpose (not a re-run lane), and the re-run lanes' new fact.
      items.push(
        item("k", "Kept outside the folder", { sourceRef: { store: "awareness", id: "b-k" } }),
      );
      items.push(
        item("n", "Prefers tabs over spaces", { sourceRef: { store: "curated", id: "c-n" } }),
      );
      // The same fact as an earlier export: deduped, not written twice.
      items.push(
        item("d", "Prefers bullet points", { sourceRef: { store: "user_profile", id: "f-d" } }),
      );
      await new Promise((resolve) => setTimeout(resolve, 5));
      const requestedAt = Date.now();

      // Not before the lane migration has run again.
      const early = requests({ token: "t1", requestedAt, laneMigrationDone: false });
      await runMemoryRepoExportChain(service, { ...deps, rerun: early.rerun });
      expect(early.consume).not.toHaveBeenCalled();
      expect(await folderText()).not.toContain("tabs over spaces");

      const ready = requests({ token: "t1", requestedAt, laneMigrationDone: true });
      const { exported, retired } = await runMemoryRepoExportChain(service, {
        ...deps,
        rerun: ready.rerun,
      });
      // The duplicate resolves to the existing line (a dedupe reports it as written).
      expect(exported).toMatchObject({ ran: true, written: 2, skipped: 0 });
      expect(retired).toMatchObject({ ran: true, retired: 2, kept: 0 });
      expect(ready.consume).toHaveBeenCalledWith("t1");
      const text = await folderText();
      expect(text).toContain("tabs over spaces");
      expect(text).not.toContain("Kept outside the folder");
      expect(text.split("Prefers bullet points").length - 1).toBe(1);
      expect(items.map((entry) => entry.id)).toEqual(["k"]);
      expect(fs.readdirSync(path.join(base, "backups"))).toHaveLength(2);

      // Markers are newer than the request: a repeated request finds the work done.
      const again = requests({ token: "t1", requestedAt, laneMigrationDone: true });
      const second = await runMemoryRepoExportChain(service, { ...deps, rerun: again.rerun });
      expect(second.exported).toMatchObject({ ran: false, reason: "done" });
      expect(second.retired).toMatchObject({ ran: false, reason: "done" });
      expect(deleteItem).toHaveBeenCalledTimes(3);
    });

    it("keeps the request while the folder cannot be written", async () => {
      const readOnly = new MemoryRepoService({
        root: service.root,
        runtime: "cli",
        readOnly: true,
      });
      await readOnly.start();
      const { deps } = setup();
      const { rerun, consume } = requests({
        token: "t1",
        requestedAt: Date.now(),
        laneMigrationDone: true,
      });
      const { exported } = await runMemoryRepoExportChain(readOnly, { ...deps, rerun });
      expect(exported).toMatchObject({ ran: false, reason: "not_writable" });
      expect(consume).not.toHaveBeenCalled();
    });
  });
});
