import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryRepoService } from "../MemoryRepoService";
import { runMemoryRepoExport } from "../MemoryRepoExport";
import { runMemoryItemsFactRetirement } from "../MemoryItemsFactRetirement";
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
      item("b", "Deploys go through staging", { scope: "workspace", workspaceId: "ws-1", kind: "rule" }),
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
    expect(await runMemoryItemsFactRetirement(service, deps)).toMatchObject({ ran: false, reason: "not_ready" });

    await runMemoryRepoExport(service, { listItems: async () => items, workspaceName: async () => "Billing" });
    const all = (await service.listFiles()).map((file) => fs.readFileSync(path.join(service.root, file), "utf8")).join("\n");
    expect(all).not.toContain("Call the bank");

    // One fact never reached the folder (e.g. the export skipped it): it stays.
    items.push(item("f", "Only in the old store"));
    const result = await runMemoryItemsFactRetirement(service, deps);
    expect(result).toMatchObject({ ran: true, retired: 2, kept: 1 });
    expect(deleteItem.mock.calls.map(([id]) => id).sort()).toEqual(["a", "b"]);
    const backups = fs.readdirSync(path.join(base, "backups"));
    expect(backups).toHaveLength(1);
    expect(backups[0]).toMatch(/^memory-items-facts-.*\.json$/);

    expect(await runMemoryItemsFactRetirement(service, deps)).toMatchObject({ ran: false, reason: "done" });
    expect(deleteItem).toHaveBeenCalledTimes(2);
  });
});
