/**
 * MemoryRecall (docs/memory-engine.md §4): the memory lane runs real SQL over
 * `memory_items` (visibility, FTS, fallback); the other lanes are fakes, so fusion, privacy
 * and expansion rules are checked without the services behind them.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MemoryItemsRepository } from "../MemoryItemsRepository";
import { MemoryWriter, type MemoryCandidate } from "../MemoryWriter";
import {
  MemoryRecallService,
  lanesForScopes,
  parseRecallRef,
  type MemoryRecallDeps,
  type MemoryRepoRecallSource,
} from "../MemoryRecall";
import { MemoryRecallStore } from "../memory-recall-sql";
import { createMemoryStatementPort } from "../memory-statement-port";
import type { MemoryRecallQuery } from "../memory-engine-contracts";
import type { Memory, MemorySearchResult } from "../../database/repositories";
import { createMemoryItemsTestDb, nativeSqliteAvailable, rowsOf } from "./memory-items-test-db";

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

function archiveHit(
  id: string,
  snippet: string,
  extra: Partial<MemorySearchResult> = {},
): MemorySearchResult {
  return {
    id,
    snippet,
    type: "decision",
    relevanceScore: 1,
    createdAt: 1_000,
    source: "db",
    ...extra,
  } as MemorySearchResult;
}

function archiveRow(id: string, workspaceId: string, content: string, isPrivate = false): Memory {
  return {
    id,
    workspaceId,
    type: "decision",
    content,
    tokens: 10,
    isCompressed: false,
    isPrivate,
    createdAt: 1_000,
    updatedAt: 1_000,
  };
}

describeWithSqlite("MemoryRecall", () => {
  let db: Database.Database;
  let writer: MemoryWriter;
  let deps: MemoryRecallDeps;
  let recall: MemoryRecallService;
  let clock: number;

  const remember = async (overrides: Partial<MemoryCandidate>) => {
    const result = await writer.ingest({
      content: "placeholder",
      kind: "project_fact",
      scope: "workspace",
      workspaceId: "ws-1",
      source: "curated",
      ...overrides,
    });
    if (result.status !== "written") throw new Error(`not written: ${result.reason}`);
    return result.item;
  };

  const query = (overrides: Partial<MemoryRecallQuery> = {}): MemoryRecallQuery => ({
    text: "",
    workspaceId: "ws-1",
    taskId: "task-1",
    surface: "tool",
    lanes: ["memory"],
    ...overrides,
  });

  beforeEach(async () => {
    db = await createMemoryItemsTestDb(["ws-1", "ws-2"]);
    clock = 1_000_000;
    writer = new MemoryWriter({
      repository: new MemoryItemsRepository(db),
      now: () => (clock += 10),
    });
    const repository = new MemoryItemsRepository(db);
    deps = {
      searchItems: async (request) => new MemoryRecallStore(db).searchItems(request),
      markItemsUsed: async (ids) => {
        await repository.markUsed(ids, 42);
      },
      searchArchive: vi.fn(async () => []),
      archiveDetails: vi.fn(async () => []),
      archiveHiddenIds: vi.fn(async () => new Set<string>()),
      recordArchiveUse: vi.fn(),
      searchConversation: vi.fn(async () => []),
      describeConversation: vi.fn(async () => null),
      searchKnowledgeGraph: vi.fn(async () => []),
      getKnowledgeEntity: vi.fn(async () => null),
      searchMarkdown: vi.fn(async () => []),
      readTextFile: vi.fn(async () => ""),
      searchExternal: vi.fn(async () => []),
      externalConfigured: () => true,
      laneEnabled: () => true,
      now: () => clock,
    };
    recall = new MemoryRecallService(deps);
  });

  afterEach(() => {
    db.close();
  });

  describe("memory lane", () => {
    it("matches prefixes and Unicode text with the shared FTS builder", async () => {
      const deploy = await remember({ content: "Deployments go through the staging branch first" });
      const turkish = await remember({ content: "Çalışma saatleri hafta içi 9-18 arası" });
      await remember({ content: "Use pnpm for package management" });

      const prefix = await recall.query(query({ text: "deploy staging" }));
      expect(prefix.map((hit) => hit.ref)).toEqual([`memory:${deploy.id}`]);

      const unicode = await recall.query(query({ text: "çalışma" }));
      expect(unicode.map((hit) => hit.ref)).toEqual([`memory:${turkish.id}`]);
      // Operator words in user text are searched for, never parsed as FTS syntax.
      await expect(recall.query(query({ text: 'deploy AND "staging" NEAR(' }))).resolves.toEqual(
        expect.any(Array),
      );
    });

    it("sees this workspace, global items and the active task only", async () => {
      const own = await remember({ content: "Budget review on Fridays" });
      const global = await remember({
        content: "Budget numbers are always in euros",
        kind: "preference",
        scope: "global",
        workspaceId: null,
      });
      const ownTask = await remember({
        content: "Budget draft lives in drafts/q3.xlsx",
        scope: "task",
        scopeRef: "task-1",
      });
      await remember({ content: "Budget is confidential", workspaceId: "ws-2" });
      await remember({
        content: "Budget sheet for another task",
        scope: "task",
        scopeRef: "task-9",
      });

      const refs = (await recall.query(query({ text: "budget" }))).map((hit) => hit.ref).sort();
      expect(refs).toEqual(
        [`memory:${own.id}`, `memory:${global.id}`, `memory:${ownTask.id}`].sort(),
      );
    });

    it("hides private, third-party, contact, superseded and expired items by default", async () => {
      const visible = await remember({ content: "Invoices are sent on the 1st" });
      const privateItem = await remember({
        content: "Invoices for the clinic",
        privacy: "private",
      });
      await remember({
        content: "Invoices from Acme are late again",
        source: "third_party",
        scope: "contact",
        scopeRef: "contact-7",
        workspaceId: "ws-1",
      });
      await remember({ content: "Invoices expire soon", expiresAt: clock - 1 });
      const old = await remember({
        content: "Invoices use template A",
        subjectKey: "invoice_template",
        source: "curated",
      });
      const replacement = await remember({
        content: "Invoices use template B",
        subjectKey: "invoice_template",
        source: "user_stated",
      });

      const refs = (await recall.query(query({ text: "invoices" }))).map((hit) => hit.ref);
      expect(refs).toContain(`memory:${visible.id}`);
      expect(refs).toContain(`memory:${replacement.id}`);
      expect(refs).not.toContain(`memory:${old.id}`);
      expect(refs).not.toContain(`memory:${privateItem.id}`);
      expect(refs).toHaveLength(2);

      // The owner surface (Memory Hub) may ask for private items; a contact surface for its
      // contact's items.
      const owner = await recall.query(
        query({ text: "invoices", policy: { includePrivate: true } }),
      );
      expect(owner.map((hit) => hit.ref)).toContain(`memory:${privateItem.id}`);
      const contact = await recall.query(query({ text: "acme", contactRef: "contact-7" }));
      expect(contact).toHaveLength(1);
    });

    it("filters by kind and lists pinned, trusted items first without a query", async () => {
      await remember({
        content: "Prefers short answers",
        kind: "preference",
        scope: "global",
        workspaceId: null,
        source: "inferred",
      });
      const pinned = await remember({ content: "Never push to main", kind: "rule", pinned: true });
      await remember({ content: "Repository uses Vitest", kind: "project_fact" });

      const listing = await recall.query(query());
      expect(listing[0].ref).toBe(`memory:${pinned.id}`);
      expect(listing).toHaveLength(3);

      const rules = await recall.query(query({ kinds: ["rule"] }));
      expect(rules.map((hit) => hit.ref)).toEqual([`memory:${pinned.id}`]);
    });

    it("falls back to term matching when FTS5 is unavailable", async () => {
      const item = await remember({ content: "Staging deploys need a changelog entry" });
      db.exec("DROP TABLE memory_items_fts");
      const hits = await recall.query(query({ text: "changelog staging" }));
      expect(hits.map((hit) => hit.ref)).toEqual([`memory:${item.id}`]);
    });

    it("runs through the memory-domain unit with validated arguments", async () => {
      const item = await remember({ content: "Weekly sync is on Mondays" });
      const port = createMemoryStatementPort(db);
      const rows = await port.unit("memoryRecall_searchItems", [
        { workspaceId: "ws-1", query: "weekly sync", limit: 5, now: clock },
      ]);
      expect(rows.map((row) => row.item.id)).toEqual([item.id]);
      await expect(
        port.unit("memoryRecall_searchItems", [
          { workspaceId: "ws-1", query: "x", limit: 5, now: clock, kinds: ["nonsense"] },
        ]),
      ).rejects.toThrow();
    });
  });

  describe("fusion", () => {
    it("fuses lanes with weighted reciprocal rank and normalizes relevance", async () => {
      const fact = await remember({ content: "The API is deployed with Terraform" });
      vi.mocked(deps.searchArchive).mockResolvedValue([
        archiveHit("a-1", "Deployed the API with Terraform after the outage"),
      ]);
      vi.mocked(deps.searchConversation).mockResolvedValue([
        {
          id: "dce_5",
          taskId: "task-0",
          role: "user",
          type: "user_message",
          snippet: "can you deploy the API with terraform",
          timestamp: 2_000,
          score: 3,
        },
      ]);

      const hits = await recall.query(
        query({ text: "deploy api terraform", lanes: ["memory", "archive", "conversations"] }),
      );
      expect(hits.map((hit) => hit.ref)).toEqual([
        `memory:${fact.id}`,
        "archive:a-1",
        "event:dce_5",
      ]);
      expect(hits[0].relevance).toBe(1);
      expect(hits[1].relevance).toBeLessThan(1);
      expect(hits[2].relevance).toBeLessThan(hits[1].relevance as number);
      expect(hits[0].laneRanks).toEqual({ memory: 1 });
      expect(hits.every((hit) => hit.snippet && hit.tokenEstimate)).toBe(true);
      expect(hits[0].content).toBeUndefined();
    });

    it("damps one-term matches so a full match in a weaker lane can outrank them", async () => {
      const weak = await remember({ content: "Run the linter before every commit" });
      vi.mocked(deps.searchArchive).mockResolvedValue([
        archiveHit("a-1", "Nightly backups run at 02:00 UTC to the eu-west bucket"),
      ]);
      const hits = await recall.query(
        query({ text: "when do the nightly backups run", lanes: ["memory", "archive"] }),
      );
      expect(hits.map((hit) => hit.ref)).toEqual(["archive:a-1", `memory:${weak.id}`]);
    });

    it("merges the same text found in two lanes into one hit", async () => {
      const fact = await remember({ content: "Releases are tagged on Thursdays" });
      vi.mocked(deps.searchMarkdown).mockResolvedValue([
        {
          id: "md:1",
          snippet: "Releases are tagged on Thursdays.",
          type: "summary",
          relevanceScore: 1,
          createdAt: 0,
          source: "markdown",
          path: "MEMORY.md",
          startLine: 3,
          endLine: 3,
        },
      ]);
      const hits = await recall.query(
        query({
          text: "releases tagged",
          lanes: ["memory", "knowledge"],
          policy: { workspacePath: "/tmp/ws-1" },
        }),
      );
      expect(hits).toHaveLength(1);
      expect(hits[0].ref).toBe(`memory:${fact.id}`);
      expect(hits[0].laneRanks).toEqual({ memory: 1, knowledge: 1 });
    });

    it("never lets an imported row from another workspace tie this workspace's row", async () => {
      vi.mocked(deps.searchArchive).mockResolvedValue([
        archiveHit("imp-1", "[Imported from ChatGPT] the budget was approved"),
      ]);
      vi.mocked(deps.searchConversation).mockResolvedValue([
        {
          id: "dce_9",
          taskId: "task-0",
          role: "assistant",
          type: "assistant_message",
          snippet: "the budget was approved yesterday",
          timestamp: 1,
          score: 1,
        },
      ]);
      const hits = await recall.query(
        query({ text: "budget approved", lanes: ["archive", "conversations"] }),
      );
      // Both rank first in their lane; the import counts half.
      expect(hits.map((hit) => hit.ref)).toEqual(["event:dce_9", "archive:imp-1"]);
      expect(hits[1].provenance).toMatchObject({ imported: true });
    });

    it("leaves the active task out of the conversation lane unless asked for one task", async () => {
      vi.mocked(deps.searchConversation).mockResolvedValue([
        {
          id: "dce_1",
          taskId: "task-1",
          role: "user",
          type: "user_message",
          snippet: "deploy now",
          timestamp: 1,
          score: 1,
        },
        {
          id: "dce_2",
          taskId: "task-0",
          role: "user",
          type: "user_message",
          snippet: "deploy later",
          timestamp: 1,
          score: 1,
        },
      ]);
      const hits = await recall.query(query({ text: "deploy", lanes: ["conversations"] }));
      expect(hits.map((hit) => hit.ref)).toEqual(["event:dce_2"]);

      await recall.query(
        query({
          text: "deploy",
          lanes: ["conversations"],
          policy: { conversationTaskId: "task-0" },
        }),
      );
      expect(deps.searchConversation).toHaveBeenLastCalledWith(
        expect.objectContaining({ workspaceId: "ws-1", taskId: "task-0" }),
      );
    });

    it("queries the external provider only when the policy allows it", async () => {
      vi.mocked(deps.searchExternal).mockResolvedValue([{ id: "sm-1", text: "likes tea" }]);
      const denied = await recall.recall(query({ text: "tea", lanes: ["external"] }));
      expect(denied.lanes).toEqual([]);
      expect(deps.searchExternal).not.toHaveBeenCalled();

      const allowed = await recall.query(
        query({ text: "tea", lanes: ["external"], policy: { allowExternal: true } }),
      );
      expect(allowed.map((hit) => hit.ref)).toEqual(["external:sm-1"]);
    });

    it("reports a failed lane and still returns the others; fails when every lane fails", async () => {
      const fact = await remember({ content: "Use feature flags for risky changes" });
      vi.mocked(deps.searchArchive).mockRejectedValue(new Error("worker offline"));
      const partial = await recall.recall(
        query({ text: "feature flags", lanes: ["memory", "archive"] }),
      );
      expect(partial.hits.map((hit) => hit.ref)).toEqual([`memory:${fact.id}`]);
      expect(partial.laneErrors.archive).toContain("worker offline");

      await expect(
        recall.query(query({ text: "feature flags", lanes: ["archive"] })),
      ).rejects.toThrow(/unavailable.*worker offline/);
    });

    it("respects the limit and returns content only for detail full", async () => {
      for (let index = 0; index < 5; index += 1) {
        await remember({ content: `Meeting note ${index} about roadmap planning` });
      }
      const index = await recall.query(query({ text: "roadmap", limit: 3 }));
      expect(index).toHaveLength(3);
      expect(index[0].content).toBeUndefined();
      const full = await recall.query(query({ text: "roadmap", limit: 2, detail: "full" }));
      expect(full[0].content).toContain("roadmap planning");
    });
  });

  describe("expansion by id", () => {
    it("expands own items and refuses another workspace's item", async () => {
      const own = await remember({ content: "Staging URL is staging.example.com" });
      const foreign = await remember({ content: "Secret project codename", workspaceId: "ws-2" });
      const result = await recall.recall(
        query({ ids: [`memory:${own.id}`, `memory:${foreign.id}`, "nonsense"] }),
      );
      expect(result.hits.map((hit) => hit.ref)).toEqual([`memory:${own.id}`]);
      expect(result.hits[0].content).toBe("Staging URL is staging.example.com");
      expect(result.missing).toEqual([`memory:${foreign.id}`, "nonsense"]);
    });

    it("expands archive rows only when own or a shared non-private import, and never hidden ones", async () => {
      vi.mocked(deps.archiveDetails).mockImplementation(async ([id]) => {
        const rows: Record<string, Memory> = {
          own: archiveRow("own", "ws-1", "Chose Postgres over MySQL"),
          foreign: archiveRow("foreign", "ws-2", "Other workspace decision"),
          shared: archiveRow("shared", "ws-2", "[Imported from ChatGPT] travel plans"),
          sharedPrivate: archiveRow("sharedPrivate", "ws-2", "[Imported from ChatGPT] diary", true),
          suppressed: archiveRow("suppressed", "ws-1", "Deleted in the Inspector"),
        };
        return rows[id] ? [rows[id]] : [];
      });
      vi.mocked(deps.archiveHiddenIds).mockImplementation(
        async (ids) => new Set(ids.filter((id) => id === "suppressed")),
      );
      const result = await recall.recall(
        query({
          lanes: ["memory", "archive"],
          ids: [
            "archive:own",
            "archive:foreign",
            "archive:shared",
            "archive:sharedPrivate",
            "archive:suppressed",
          ],
        }),
      );
      expect(result.hits.map((hit) => hit.ref)).toEqual(["archive:own", "archive:shared"]);
      expect(result.missing).toEqual([
        "archive:foreign",
        "archive:sharedPrivate",
        "archive:suppressed",
      ]);
    });

    it("never reads files outside .cowork or refused by the read guard", async () => {
      vi.mocked(deps.readTextFile).mockResolvedValue("line 1\nline 2\nline 3");
      const policy = {
        workspacePath: "/tmp/ws-1",
        readGuard: (p: string) => !p.includes("secret"),
      };
      const result = await recall.recall(
        query({
          lanes: ["knowledge"],
          policy,
          ids: [
            "doc:2-3:notes/plan.md",
            "doc:1-2:../../etc/passwd.md",
            "doc:1-1:secret.md",
            "topic:../x.md",
          ],
        }),
      );
      expect(result.hits.map((hit) => hit.ref)).toEqual(["doc:2-3:notes/plan.md"]);
      expect(result.hits[0].content).toBe("line 2\nline 3");
      expect(deps.readTextFile).toHaveBeenCalledTimes(1);
      expect(deps.readTextFile).toHaveBeenCalledWith("/tmp/ws-1/.cowork/notes/plan.md");
    });

    it("refuses refs of lanes the caller did not ask for", async () => {
      const own = await remember({ content: "Office is in Espoo" });
      const result = await recall.recall(
        query({ lanes: ["conversations"], ids: [`memory:${own.id}`] }),
      );
      expect(result.hits).toEqual([]);
    });
  });

  describe("markUsed", () => {
    it("counts a use for memory items and archive rows only", async () => {
      const item = await remember({ content: "Standup at 9:30" });
      await recall.markUsed([`memory:${item.id}`, "archive:a-1", "event:dce_1", "kg:e-1"]);
      expect(rowsOf(db, "id = ?", item.id)[0].last_used_at).toBe(42);
      expect(deps.recordArchiveUse).toHaveBeenCalledWith(["a-1"]);
    });

    it("query itself never counts a use", async () => {
      const item = await remember({ content: "Standup at 9:30" });
      await recall.query(query({ text: "standup", detail: "full" }));
      expect(rowsOf(db, "id = ?", item.id)[0].last_used_at).toBeNull();
      expect(deps.recordArchiveUse).not.toHaveBeenCalled();
    });
  });
});

describe("MemoryRecall helpers", () => {
  it("maps tool scopes to lanes", () => {
    expect(lanesForScopes(undefined)).toEqual([
      "memory",
      "repo",
      "archive",
      "conversations",
      "knowledge",
    ]);
    expect(lanesForScopes(["external", "bogus"])).toEqual(["external"]);
    expect(lanesForScopes([])).toEqual(["memory", "repo", "archive", "conversations", "knowledge"]);
  });

  it("parses lane-qualified and bare refs", () => {
    expect(parseRecallRef("memory:abc")).toEqual({ lane: "memory", kind: "item", id: "abc" });
    expect(parseRecallRef("dce_12")).toEqual({
      lane: "conversations",
      kind: "event",
      id: "dce_12",
    });
    expect(parseRecallRef("doc:1-4:USER.md")).toMatchObject({ lane: "knowledge", kind: "doc" });
    expect(parseRecallRef("123e4567-e89b-12d3-a456-426614174000")).toMatchObject({ kind: "uuid" });
    expect(parseRecallRef("repo:workspaces/app.md#L7")).toEqual({
      lane: "repo",
      kind: "repo",
      id: "workspaces/app.md#L7",
    });
    expect(parseRecallRef("repo:../etc/passwd.md#L1")).toBeNull();
    // Topic packs are retired: their refs are unknown.
    expect(parseRecallRef("topic:deploy.md")).toBeNull();
    expect(parseRecallRef("repo:.git/config.md#L1")).toBeNull();
    expect(parseRecallRef("")).toBeNull();
    expect(parseRecallRef("weird")).toBeNull();
    expect(parseRecallRef("team:Platform Team:topics/ci.md#L4")).toEqual({
      lane: "repo",
      kind: "team",
      id: "Platform Team:topics/ci.md#L4",
    });
    expect(parseRecallRef("team:Platform:../secret.md#L1")).toBeNull();
    expect(parseRecallRef("team:Platform:.git/config.md#L1")).toBeNull();
    expect(parseRecallRef("team:Platform:notes.txt#L1")).toBeNull();
    expect(parseRecallRef("team:a/b:MEMORY.md#L1")).toBeNull();
    expect(parseRecallRef("team:Platform:MEMORY.md#L0")).toBeNull();
  });
});

describe("MemoryRecall repo lane", () => {
  const files: Record<string, string> = {
    "MEMORY.md": [
      "# Memory: Sam",
      "",
      "- Always deploy through the staging branch first [added: 2026-09-01]",
      "- Prefers tabs over spaces",
      "",
      "## Index",
      "- [[workspaces/app.md]]",
    ].join("\n"),
    "workspaces/app.md": [
      "# App",
      "",
      "- The deploy script lives in scripts/deploy.sh [by: agent; source: cowork://tasks/t-1; workspace: ws-1; added: 2026-09-02]",
      "- Staging API token is sk-abcdefghijklmnopqrstuvwxyz0123456789",
    ].join("\n"),
    "inbox.md": [
      "# Inbox",
      "",
      "- Always deploy on Fridays [by: agent; source: cowork://tasks/t-2]",
    ].join("\n"),
  };

  function makeRecall(
    available = true,
    teams?: Array<{ name: string; source: MemoryRepoRecallSource }>,
  ) {
    const reads: string[] = [];
    const stamps: Record<string, string> = {};
    const source = {
      listFiles: vi.fn(async () => Object.keys(files).sort()),
      readFile: vi.fn(async (relPath: string) => {
        reads.push(relPath);
        return files[relPath] ?? null;
      }),
      stamp: vi.fn(async (relPath: string) => stamps[relPath] ?? "v1"),
    };
    const deps: MemoryRecallDeps = {
      searchItems: vi.fn(async () => []),
      markItemsUsed: vi.fn(async () => undefined),
      searchArchive: vi.fn(async () => []),
      archiveDetails: vi.fn(async () => []),
      archiveHiddenIds: vi.fn(async () => new Set<string>()),
      recordArchiveUse: vi.fn(),
      searchConversation: vi.fn(async () => []),
      describeConversation: vi.fn(async () => null),
      searchKnowledgeGraph: vi.fn(async () => []),
      getKnowledgeEntity: vi.fn(async () => null),
      searchMarkdown: vi.fn(async () => []),
      readTextFile: vi.fn(async () => ""),
      searchExternal: vi.fn(async () => []),
      externalConfigured: () => false,
      memoryRepo: () => (available ? source : null),
      teamMemoryRepos: (workspaceId) => (teams && workspaceId === "ws-1" ? teams : []),
      laneEnabled: () => true,
      now: () => 1,
    };
    return { recall: new MemoryRecallService(deps), reads, stamps, source };
  }

  const query = (overrides: Partial<MemoryRecallQuery> = {}): MemoryRecallQuery => ({
    text: "",
    workspaceId: "ws-1",
    taskId: "task-1",
    surface: "tool",
    lanes: ["memory", "repo"],
    ...overrides,
  });

  it("ranks entries by term coverage with repo refs and provenance", async () => {
    const { recall } = makeRecall();
    const result = await recall.recall(query({ text: "how do we deploy to staging?" }));
    expect(result.lanes).toEqual(["memory", "repo"]);
    expect(result.hits[0]).toMatchObject({
      lane: "repo",
      ref: "repo:MEMORY.md#L3",
      snippet: "Always deploy through the staging branch first",
      source: "user_stated",
      provenance: { store: "memory_repo", file: "MEMORY.md", line: 3, by: "user" },
    });
    const refs = result.hits.map((hit) => hit.ref);
    expect(refs).toContain("repo:workspaces/app.md#L3");
    const agentHit = result.hits.find((hit) => hit.ref === "repo:workspaces/app.md#L3");
    expect(agentHit).toMatchObject({
      source: "inferred",
      provenance: { by: "agent", source: "cowork://tasks/t-1", workspace: "ws-1" },
    });
    // Headings and index links are not entries.
    expect(refs.some((ref) => ref.endsWith("#L1") || ref.endsWith("#L7"))).toBe(false);
  });

  it("tags inbox entries unreviewed", async () => {
    const { recall } = makeRecall();
    const hits = await recall.query(query({ text: "fridays" }));
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({
      ref: "repo:inbox.md#L3",
      snippet: "[unreviewed] Always deploy on Fridays",
      provenance: { unreviewed: true, by: "agent" },
    });
  });

  it("redacts hand-written secrets in hits", async () => {
    const { recall } = makeRecall();
    const [hit] = await recall.query(query({ text: "staging api token" }));
    expect(hit.ref).toBe("repo:workspaces/app.md#L4");
    expect(hit.snippet).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
  });

  it("is skipped when the repo is not ready, and caches files by stamp", async () => {
    const off = makeRecall(false);
    const offResult = await off.recall.recall(query({ text: "deploy" }));
    expect(offResult.lanes).toEqual(["memory"]);
    expect(off.source.listFiles).not.toHaveBeenCalled();

    const { recall, reads, stamps } = makeRecall();
    await recall.query(query({ text: "deploy" }));
    await recall.query(query({ text: "tabs" }));
    expect(reads.filter((file) => file === "MEMORY.md")).toHaveLength(1);
    stamps["MEMORY.md"] = "v2";
    await recall.query(query({ text: "tabs" }));
    expect(reads.filter((file) => file === "MEMORY.md")).toHaveLength(2);
  });

  it("expands a repo ref to the lines around the entry", async () => {
    const { recall } = makeRecall();
    const result = await recall.recall(query({ ids: ["repo:MEMORY.md#L4"], detail: "full" }));
    expect(result.missing).toEqual([]);
    expect(result.hits[0]).toMatchObject({ lane: "repo", ref: "repo:MEMORY.md#L4" });
    expect(result.hits[0].content).toContain("Prefers tabs over spaces");
    expect(result.hits[0].content).toContain("# Memory: Sam");

    const notEntry = await recall.recall(query({ ids: ["repo:MEMORY.md#L1"], detail: "full" }));
    expect(notEntry.missing).toEqual(["repo:MEMORY.md#L1"]);
    const notAsked = await recall.recall(
      query({ ids: ["repo:MEMORY.md#L4"], lanes: ["memory"], detail: "full" }),
    );
    expect(notAsked.missing).toEqual(["repo:MEMORY.md#L4"]);
  });

  it("returns at most 80 lines around the entry", async () => {
    const { recall } = makeRecall();
    const long = ["# Long", ...Array.from({ length: 200 }, (_, i) => `- fact number ${i + 2}`)];
    files["long.md"] = long.join("\n");
    try {
      const result = await recall.recall(query({ ids: ["repo:long.md#L100"], detail: "full" }));
      const lines = String(result.hits[0].content).split("\n");
      expect(lines.length).toBeLessThanOrEqual(80);
      expect(result.hits[0].content).toContain("fact number 100");
    } finally {
      delete files["long.md"];
    }
  });

  describe("team memory repos", () => {
    const teamFiles: Record<string, string> = {
      "MEMORY.md": [
        "# Platform",
        "",
        "- Deploy freezes start on Friday at noon [by: user; added: 2026-09-20]",
        "- The team token is sk-abcdefghijklmnopqrstuvwxyz0123456789",
      ].join("\n"),
      "topics/ci.md": [
        "# CI",
        ...Array.from({ length: 150 }, (_, i) => `- ci fact number ${i + 2}`),
      ].join("\n"),
    };
    const teamSource = (): MemoryRepoRecallSource => ({
      listFiles: vi.fn(async () => Object.keys(teamFiles)),
      readFile: vi.fn(async (relPath: string) => teamFiles[relPath] ?? null),
      stamp: vi.fn(async () => "t1"),
    });

    it("searches applicable team repos with team refs, labels and provenance", async () => {
      const { recall } = makeRecall(true, [{ name: "Platform", source: teamSource() }]);
      const hits = await recall.query(query({ text: "deploy freezes friday" }));
      const team = hits.find((hit) => hit.ref.startsWith("team:"));
      expect(team).toMatchObject({
        lane: "repo",
        ref: "team:Platform:MEMORY.md#L3",
        snippet: "[team Platform] Deploy freezes start on Friday at noon",
        source: "third_party",
        provenance: {
          store: "team_memory",
          team: "Platform",
          file: "MEMORY.md",
          line: 3,
          by: "user",
        },
      });
      const [secret] = await recall.query(query({ text: "team token" }));
      expect(secret.ref).toBe("team:Platform:MEMORY.md#L4");
      expect(secret.snippet).not.toContain("sk-abcdefghijklmnopqrstuvwxyz0123456789");
      // Another workspace: the team repo does not apply.
      const elsewhere = await recall.query(
        query({ text: "deploy freezes friday", workspaceId: "ws-9" }),
      );
      expect(elsewhere.some((hit) => hit.ref.startsWith("team:"))).toBe(false);
    });

    it("runs the repo lane on team repos alone", async () => {
      const { recall } = makeRecall(false, [{ name: "Platform", source: teamSource() }]);
      const result = await recall.recall(query({ text: "deploy freezes" }));
      expect(result.lanes).toEqual(["memory", "repo"]);
      expect(result.hits[0].ref).toBe("team:Platform:MEMORY.md#L3");
    });

    it("expands team refs up to 80 lines, only for configured repos", async () => {
      const { recall } = makeRecall(true, [{ name: "Platform", source: teamSource() }]);
      const result = await recall.recall(
        query({ ids: ["team:Platform:topics/ci.md#L100"], detail: "full" }),
      );
      expect(result.missing).toEqual([]);
      expect(result.hits[0]).toMatchObject({
        lane: "repo",
        ref: "team:Platform:topics/ci.md#L100",
        provenance: { store: "team_memory", team: "Platform" },
      });
      const content = String(result.hits[0].content);
      expect(content.startsWith("[team Platform] ")).toBe(true);
      expect(content.split("\n").length).toBeLessThanOrEqual(80);
      expect(content).toContain("ci fact number 100");

      const unknown = await recall.recall(
        query({ ids: ["team:Other:MEMORY.md#L3"], detail: "full" }),
      );
      expect(unknown.missing).toEqual(["team:Other:MEMORY.md#L3"]);
      const notHere = await recall.recall(
        query({ ids: ["team:Platform:MEMORY.md#L3"], detail: "full", workspaceId: "ws-9" }),
      );
      expect(notHere.missing).toEqual(["team:Platform:MEMORY.md#L3"]);
    });
  });
});
