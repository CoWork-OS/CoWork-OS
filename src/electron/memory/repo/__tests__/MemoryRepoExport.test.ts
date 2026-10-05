import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MemoryRepoService } from "../MemoryRepoService";
import { runMemoryRepoExport } from "../MemoryRepoExport";
import { memoryRepoPathProblem } from "../memory-repo-paths";
import type { MemoryItem } from "../../memory-items-types";

function hasGit(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

const describeWithGit = hasGit() ? describe : describe.skip;

function item(overrides: Partial<MemoryItem>): MemoryItem {
  return {
    id: "id",
    workspaceId: null,
    scope: "global",
    scopeRef: null,
    kind: "preference",
    subjectKey: "preference:0123456789abcdef",
    content: "x",
    source: "inferred",
    sourceRef: { store: "x", id: "y" },
    trust: 0.5,
    confidence: 0.7,
    status: "active",
    pinned: false,
    reinforcedCount: 0,
    lastUsedAt: null,
    supersedesId: null,
    contentHash: "h",
    privacy: "normal",
    taskId: null,
    expiresAt: null,
    createdAt: Date.UTC(2026, 8, 18),
    updatedAt: Date.UTC(2026, 8, 18),
    ...overrides,
  } as MemoryItem;
}

describeWithGit("runMemoryRepoExport", () => {
  let base: string;
  let service: MemoryRepoService;

  beforeEach(async () => {
    base = fs.mkdtempSync(path.join(os.tmpdir(), "memory-repo-export-"));
    service = new MemoryRepoService({ root: path.join(base, "repo"), runtime: "desktop" });
    await service.start();
  });

  afterEach(() => fs.rmSync(base, { recursive: true, force: true }));

  it("exports user-owned facts once and leaves third-party, private and contact items out", async () => {
    const items = [
      item({ content: "Sam", kind: "identity", subjectKey: "preferred_name", source: "user_confirmed", pinned: true }),
      item({ content: "Prefers bullet points", source: "inferred" }),
      item({ content: "Deploys go through staging", kind: "rule", scope: "workspace", workspaceId: "ws-1", source: "curated" }),
      item({ content: "Mail from Bob about invoices", scope: "contact", source: "third_party" }),
      item({ content: "Private note", privacy: "private" }),
    ];
    const deps = {
      listItems: async () => items,
      workspaceName: async () => "Billing",
    };
    expect(await runMemoryRepoExport(service, deps)).toEqual({ ran: true, written: 3, skipped: 0 });
    const read = (rel: string) => fs.readFileSync(path.join(service.root, rel), "utf8");
    expect(read("MEMORY.md")).toContain("- Sam [by: user; kind: identity; subject: preferred_name; added: 2026-09-18]");
    expect(read("me.md")).toContain("- Prefers bullet points [by: agent; kind: preference; added: 2026-09-18]");
    expect(read("workspaces/billing.md")).toContain("Deploys go through staging [by: user; kind: rule;");
    const all = (await service.listFiles()).map(read).join("\n");
    expect(all).not.toMatch(/Bob|Private note/);
    expect(await runMemoryRepoExport(service, deps)).toEqual({ ran: false, written: 0, skipped: 0 });
  });
});

describe("memoryRepoPathProblem", () => {
  const home = os.homedir();
  it("refuses roots, home, relative paths and project workspaces, but not a home-folder workspace", () => {
    expect(memoryRepoPathProblem("relative/dir")).toMatch(/absolute/);
    expect(memoryRepoPathProblem("/")).toMatch(/root/);
    expect(memoryRepoPathProblem(home)).toMatch(/home folder/);
    expect(memoryRepoPathProblem(path.join(home, "code", "app", "memory"), [path.join(home, "code", "app")])).toMatch(
      /outside your workspaces/,
    );
    expect(memoryRepoPathProblem(path.join(home, "CoWork Memory"), [home, path.join(home, "code", "app")])).toBeNull();
  });
});
