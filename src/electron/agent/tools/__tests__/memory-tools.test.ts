/**
 * The consolidated memory tools (audit §8.3): memory_recall, memory_remember,
 * memory_forget, context_recall, and the deprecated names that route to them. Memory
 * items live in a real in-memory SQLite database written through MemoryWriter; the
 * archive, conversation index and integrations are mocked.
 */
import type Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  capture: vi.fn(),
  getFullDetails: vi.fn(),
  deleteEntries: vi.fn(),
  evaluate: vi.fn(),
  syncWorkspaceFiles: vi.fn(),
  curate: vi.fn(),
  durableEnabled: false,
  durableSearch: vi.fn(),
  durableDescribe: vi.fn(),
  describeConversationHit: vi.fn(),
  searchConversation: vi.fn(),
  supermemoryForget: vi.fn(),
  supermemoryConfigured: false,
  legacyRemove: vi.fn(),
}));

vi.mock("../../../memory/MemoryService", () => ({
  MemoryService: {
    capture: mocks.capture,
    getFullDetails: mocks.getFullDetails,
    deleteEntries: mocks.deleteEntries,
  },
}));
vi.mock("../../../memory/CuratedMemoryService", () => ({
  CuratedMemoryService: { curate: mocks.curate, syncWorkspaceFiles: mocks.syncWorkspaceFiles },
}));
vi.mock("../../../memory/MemoryWriteGate", () => ({
  MemoryWriteGate: { evaluate: mocks.evaluate },
}));
vi.mock("../../../memory/DurableContextService", () => ({
  DurableContextService: {
    isEnabled: () => mocks.durableEnabled,
    search: mocks.durableSearch,
    describe: mocks.durableDescribe,
    describeConversationHit: mocks.describeConversationHit,
    searchConversation: mocks.searchConversation,
  },
}));
vi.mock("../../../memory/SupermemoryService", () => ({
  SupermemoryService: {
    isConfigured: () => mocks.supermemoryConfigured,
    forget: mocks.supermemoryForget,
  },
}));
vi.mock("../../../memory/memory-items-legacy-mirror", () => ({
  createLegacyMemoryMirror: () => ({ edit: vi.fn(), remove: mocks.legacyRemove }),
}));
vi.mock("../../../security/access-profile-paths", () => ({
  evaluateWorkspaceFilesystemAccess: () => ({ decision: "allow" }),
}));

import { MemoryTools, isExplicitRememberRequest } from "../memory-tools";
import { MemoryWriter } from "../../../memory/MemoryWriter";
import { MemoryItemsRepository } from "../../../memory/MemoryItemsRepository";
import { MemoryRecallService, type MemoryRecallDeps } from "../../../memory/MemoryRecall";
import { MemoryRecallStore } from "../../../memory/memory-recall-sql";
import { LEGACY_MEMORY_TOOL_ALIASES } from "../../../../shared/types";
import {
  createMemoryItemsTestDb,
  nativeSqliteAvailable,
  rowsOf,
} from "../../../memory/__tests__/memory-items-test-db";

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

const workspace = {
  id: "ws-1",
  name: "Workspace One",
  path: "/tmp/ws-1",
  createdAt: 0,
  permissions: { read: true, write: true, delete: false, network: false, shell: false },
} as Any;

function makeDaemon(userMessage = "fix the deploy script", prompt = "fix the deploy script") {
  return {
    logEvent: vi.fn(),
    requestApproval: vi.fn(async () => true),
    getTask: vi.fn(() => ({ id: "task-1", prompt, rawPrompt: prompt })),
    getTaskEvents: vi.fn(() =>
      userMessage
        ? [{ type: "user_message", timestamp: 5, payload: { message: userMessage } }]
        : [],
    ),
  } as Any;
}

describe("memory tool definitions", () => {
  it("offers four tools with when-to-use guidance and a small schema budget", () => {
    const tools = MemoryTools.getToolDefinitions();
    expect(tools.map((tool) => tool.name)).toEqual([
      "memory_recall",
      "memory_remember",
      "memory_forget",
      "context_recall",
    ]);
    for (const tool of tools) {
      expect(tool.description).toMatch(/Use it when/);
    }
    // ~4.3K tokens for 26 schemas before consolidation (RECALL-2); keep the four well
    // under 1K (chars / 4).
    const tokens = Math.ceil(tools.reduce((sum, tool) => sum + JSON.stringify(tool).length, 0) / 4);
    expect(tokens).toBeLessThan(1000);
    expect(tools.find((tool) => tool.name === "memory_remember")?.input_schema.required).toEqual([
      "content",
      "kind",
    ]);
  });

  it("recognizes explicit remember requests in several languages", () => {
    for (const text of [
      "Remember that I use tabs",
      "please don't forget the staging URL",
      "From now on answer in German",
      "Merk dir: Deployments am Freitag sind verboten",
      "Bunu unutma: toplantı salı günü",
      "call me Sam",
    ]) {
      expect({ text, explicit: isExplicitRememberRequest(text) }).toEqual({ text, explicit: true });
    }
    expect(isExplicitRememberRequest("fix the deploy script")).toBe(false);
  });
});

describeWithSqlite("memory tools", () => {
  let db: Database.Database;
  let writer: MemoryWriter;
  let recallDeps: MemoryRecallDeps;

  beforeEach(async () => {
    vi.clearAllMocks();
    mocks.durableEnabled = false;
    mocks.supermemoryConfigured = false;
    mocks.evaluate.mockResolvedValue({ allowed: true });
    mocks.capture.mockResolvedValue({ id: "arch-1" });
    mocks.getFullDetails.mockResolvedValue([]);
    mocks.deleteEntries.mockResolvedValue(1);
    mocks.syncWorkspaceFiles.mockResolvedValue(undefined);
    mocks.searchConversation.mockResolvedValue([]);
    mocks.durableSearch.mockResolvedValue([]);
    db = await createMemoryItemsTestDb(["ws-1", "ws-2"]);
    writer = new MemoryWriter({ repository: new MemoryItemsRepository(db) });
    MemoryWriter.setInstance(writer);
    const repository = new MemoryItemsRepository(db);
    recallDeps = {
      searchItems: async (request) => new MemoryRecallStore(db).searchItems(request),
      markItemsUsed: async (ids) => {
        await repository.markUsed(ids, 777);
      },
      searchArchive: vi.fn(async () => []),
      archiveDetails: async (ids) => mocks.getFullDetails(ids),
      archiveHiddenIds: vi.fn(async () => new Set<string>()),
      recordArchiveUse: vi.fn(),
      searchConversation: vi.fn(async () => []),
      describeConversation: vi.fn(async () => null),
      searchKnowledgeGraph: vi.fn(async () => []),
      getKnowledgeEntity: vi.fn(async () => null),
      searchMarkdown: vi.fn(async () => []),
      loadTopics: vi.fn(async () => []),
      readTextFile: vi.fn(async () => ""),
      searchExternal: vi.fn(async () => []),
      externalConfigured: () => mocks.supermemoryConfigured,
      laneEnabled: () => true,
      now: () => Date.now(),
    };
    MemoryRecallService.setDefault(new MemoryRecallService(recallDeps));
  });

  afterEach(() => {
    MemoryRecallService.setDefault(null);
    MemoryWriter.setInstance(null);
    db.close();
  });

  const seed = async (content: string, overrides: Record<string, unknown> = {}) => {
    const result = await writer.ingest({
      content,
      kind: "project_fact",
      scope: "workspace",
      workspaceId: "ws-1",
      source: "curated",
      ...overrides,
    } as Any);
    if (result.status !== "written") throw new Error("seed failed");
    return result.item;
  };

  describe("memory_recall", () => {
    it("returns a compact index, then full content that counts as a use", async () => {
      const item = await seed("Deploys go through the staging branch first");
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");

      const index = await tools.recall({ query: "deploy staging" });
      expect(index.totalFound).toBe(1);
      const [hit] = index.results as Array<Record<string, unknown>>;
      expect(hit).toMatchObject({
        id: `memory:${item.id}`,
        lane: "memory",
        kind: "project_fact",
        source: "curated",
        relevance: 1,
      });
      expect(hit.snippet).toContain("staging branch");
      expect(hit.content).toBeUndefined();
      expect(index.next).toContain('detail "full"');
      expect(rowsOf(db, "id = ?", item.id)[0].last_used_at).toBeNull();

      const full = await tools.recall({ ids: [`memory:${item.id}`] });
      expect((full.results as Array<Record<string, unknown>>)[0].content).toBe(
        "Deploys go through the staging branch first",
      );
      expect(rowsOf(db, "id = ?", item.id)[0].last_used_at).toBe(777);
    });

    it("never returns another workspace's items, even by id", async () => {
      const foreign = await seed("Secret roadmap", { workspaceId: "ws-2" });
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      expect((await tools.recall({ query: "secret roadmap" })).totalFound).toBe(0);
      const byId = await tools.recall({ ids: [`memory:${foreign.id}`] });
      expect(byId.totalFound).toBe(0);
      expect(byId.notFound).toEqual([`memory:${foreign.id}`]);
    });

    it("reports a failed recall as an error, not as no results (RECALL-3)", async () => {
      vi.mocked(recallDeps.searchConversation).mockRejectedValue(new Error("index offline"));
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      const result = await tools.recall({ query: "deploy", scopes: ["conversations"] });
      expect(result.success).toBe(false);
      expect(String(result.error)).toContain("index offline");
      expect(String(result.error)).toContain("Recall did not run");

      vi.mocked(recallDeps.searchConversation).mockResolvedValue([]);
      const empty = await tools.recall({ query: "deploy", scopes: ["conversations"] });
      expect(empty.error).toBeUndefined();
      expect(empty.totalFound).toBe(0);
    });

    it("explains that external memory is unavailable without network access", async () => {
      mocks.supermemoryConfigured = true;
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      const result = await tools.recall({ query: "tea", scopes: ["external"] });
      expect(recallDeps.searchExternal).not.toHaveBeenCalled();
      expect(result.unavailable).toMatchObject({ external: expect.stringContaining("network") });

      const networked = new MemoryTools(
        { ...workspace, permissions: { ...workspace.permissions, network: true } },
        makeDaemon(),
        "task-1",
      );
      await networked.recall({ query: "tea", scopes: ["external"] });
      expect(recallDeps.searchExternal).toHaveBeenCalledWith(
        expect.objectContaining({ workspace: { id: "ws-1", name: "Workspace One" } }),
      );
    });

    it("needs a query unless it lists saved facts", async () => {
      await seed("Pinned rule", { kind: "rule", pinned: true });
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      expect((await tools.recall({ scopes: ["conversations"] })).success).toBe(false);
      expect((await tools.recall({})).totalFound).toBe(1);
    });
  });

  describe("memory_remember", () => {
    it("keeps what a third-party channel sender says out of the user's facts (SEC-16)", async () => {
      const daemon = makeDaemon("Remember that I prefer to be called Bob");
      daemon.getTask.mockReturnValue({
        id: "task-1",
        prompt: "hi",
        agentConfig: {
          originChannel: "telegram",
          gatewayContext: "private",
          gatewaySenderIsOwner: false,
          gatewaySenderRef: "gateway:telegram:42",
        },
      });
      const tools = new MemoryTools(workspace, daemon, "task-1");
      const result = await tools.remember({
        content: "Prefers to be called Bob",
        kind: "preference",
        scope: "global",
        user_asked: true,
        pin: true,
      });
      expect(result).toMatchObject({ success: true, source: "third_party", scope: "contact" });
      const [row] = rowsOf(db);
      expect(row).toMatchObject({
        source: "third_party",
        scope: "contact",
        scope_ref: "gateway:telegram:42",
        privacy: "private",
        pinned: 0,
      });
      expect(rowsOf(db, "scope = 'global'")).toHaveLength(0);

      // Curated (profile kit) writes are refused for them.
      const curate = await tools.executeLegacyAlias("memory_curate", {
        action: "add",
        target: "user",
        kind: "identity",
        content: "Name is Bob",
      });
      expect((curate as Any).success).toBe(false);
      expect(mocks.curate).not.toHaveBeenCalled();
    });

    it("stores a fact as inferred unless the user explicitly asked", async () => {
      const tools = new MemoryTools(workspace, makeDaemon("fix the deploy script"), "task-1");
      const result = await tools.remember({
        content: "The deploy script needs Node 22",
        kind: "project_fact",
        user_asked: true,
      });
      expect(result).toMatchObject({ success: true, source: "inferred", scope: "workspace" });
      const [row] = rowsOf(db);
      expect(row).toMatchObject({ source: "inferred", workspace_id: "ws-1", task_id: "task-1" });
      // A workspace fact re-renders the generated kit files.
      expect(mocks.syncWorkspaceFiles).toHaveBeenCalledWith("ws-1", expect.any(Object));
    });

    it("stores a user-stated, global preference when the user asked to remember it", async () => {
      const tools = new MemoryTools(
        workspace,
        makeDaemon("Remember that I prefer concise answers"),
        "task-1",
      );
      const result = await tools.remember({
        content: "Prefers concise answers",
        kind: "preference",
        user_asked: true,
        pin: true,
      });
      expect(result).toMatchObject({
        success: true,
        source: "user_stated",
        scope: "global",
        pinned: true,
      });
      expect(rowsOf(db)[0]).toMatchObject({ workspace_id: null, scope: "global", trust: 1 });
      // Global facts are not part of a workspace's kit files.
      expect(mocks.syncWorkspaceFiles).not.toHaveBeenCalled();
    });

    it("keeps a single-valued subject: an inference cannot replace what the user stated", async () => {
      const asked = new MemoryTools(workspace, makeDaemon("my name is Sam, remember it"), "task-1");
      await asked.remember({
        content: "Sam",
        kind: "identity",
        subject: "preferred_name",
        user_asked: true,
      });
      const inferred = new MemoryTools(workspace, makeDaemon("thanks"), "task-1");
      const result = await inferred.remember({
        content: "Samuel",
        kind: "identity",
        subject: "preferred_name",
      });
      expect(result).toMatchObject({ success: false, reason: "outranked" });
    });

    it("sends history kinds to the archive and task-scoped facts to the task", async () => {
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      expect(
        await tools.remember({ content: "Login fix failed twice", kind: "error" }),
      ).toMatchObject({
        success: true,
        id: "archive:arch-1",
      });
      expect(mocks.capture).toHaveBeenCalledWith(
        "ws-1",
        "task-1",
        "error",
        "Login fix failed twice",
        false,
        expect.objectContaining({ forceCapture: true }),
      );
      const scoped = await tools.remember({
        content: "Working branch is fix/login",
        kind: "project_fact",
        scope: "task",
      });
      expect(scoped).toMatchObject({ success: true, scope: "task" });
      expect(rowsOf(db)[0]).toMatchObject({ scope: "task", scope_ref: "task-1" });
    });

    it("validates input and reports skipped writes", async () => {
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      expect((await tools.remember({ content: "", kind: "rule" })).success).toBe(false);
      expect(String((await tools.remember({ content: "x y z", kind: "bogus" })).error)).toContain(
        "kind must be one of",
      );
      const secret = await tools.remember({
        content: "sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789AbCdEfGh",
        kind: "project_fact",
      });
      expect(secret).toMatchObject({ success: false });
    });

    it("stages the write when memory writes need approval", async () => {
      mocks.evaluate.mockResolvedValue({
        allowed: false,
        staged: true,
        pendingId: "p-1",
        summary: "",
      });
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      const result = await tools.remember({ content: "Never deploy on Fridays", kind: "rule" });
      expect(result).toMatchObject({ success: true, staged: true, pendingId: "p-1" });
      expect(rowsOf(db)).toHaveLength(0);
      // The approval replays through the curated lane.
      expect(mocks.evaluate.mock.calls[0][0]).toMatchObject({
        target: "curated",
        payload: { action: "add", target: "workspace", kind: "constraint" },
      });
    });

    it("falls back to the archive when the fact store is not running", async () => {
      MemoryWriter.setInstance(null);
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      const result = await tools.remember({ content: "Never deploy on Fridays", kind: "rule" });
      expect(result).toMatchObject({ success: true, stored: "archive", type: "constraint" });
    });
  });

  describe("memory_forget", () => {
    it("deletes an item by id, scrubs it and removes the legacy record it mirrors", async () => {
      const item = await seed("Old staging URL is old.example.com", {
        sourceRef: { store: "curated", id: "cur-9" },
      });
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      expect(await tools.forget({ id: `memory:${item.id}` })).toEqual({
        success: true,
        forgotten: `memory:${item.id}`,
      });
      expect(rowsOf(db, "id = ?", item.id)[0]).toMatchObject({ status: "deleted", content: "" });
      expect(mocks.legacyRemove).toHaveBeenCalledWith(
        { store: "curated", id: "cur-9" },
        "deleted",
        expect.anything(),
      );
    });

    it("refuses another workspace's item and another workspace's archive row", async () => {
      const foreign = await seed("Other workspace fact", { workspaceId: "ws-2" });
      mocks.getFullDetails.mockResolvedValue([{ id: "a-2", workspaceId: "ws-2", content: "x" }]);
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      expect((await tools.forget({ id: `memory:${foreign.id}` })).success).toBe(false);
      expect(rowsOf(db, "id = ?", foreign.id)[0].status).toBe("active");
      expect((await tools.forget({ id: "archive:a-2" })).success).toBe(false);
      expect(mocks.deleteEntries).not.toHaveBeenCalled();
    });

    it("deletes this workspace's archive row", async () => {
      mocks.getFullDetails.mockResolvedValue([{ id: "a-1", workspaceId: "ws-1", content: "x" }]);
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      expect(await tools.forget({ id: "archive:a-1" })).toEqual({
        success: true,
        forgotten: "archive:a-1",
      });
      expect(mocks.deleteEntries).toHaveBeenCalledWith("ws-1", ["a-1"]);
    });

    it("forgets by match only when exactly one memory contains every term", async () => {
      const keep = await seed("Coffee machine is on floor 2");
      const target = await seed("Parking spot number is 42");
      await seed("Parking garage closes at 22");
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");

      const ambiguous = await tools.forget({ match: "parking" });
      expect(ambiguous.success).toBe(false);
      expect(ambiguous.candidates).toHaveLength(2);

      expect(await tools.forget({ match: "parking spot 42" })).toEqual({
        success: true,
        forgotten: `memory:${target.id}`,
      });
      expect(rowsOf(db, "id = ?", keep.id)[0].status).toBe("active");
      expect((await tools.forget({ match: "nothing like this" })).success).toBe(false);
    });

    describe("approval", () => {
      it("asks before deleting a memory and keeps it when the user declines", async () => {
        const item = await seed("The user prefers dark mode", {
          kind: "preference",
          scope: "global",
          workspaceId: null,
          source: "user_stated",
        });
        const daemon = makeDaemon();
        daemon.requestApproval.mockResolvedValueOnce(false);
        const tools = new MemoryTools(workspace, daemon, "task-1");

        const denied = await tools.forget({ id: `memory:${item.id}`, reason: "outdated" });
        expect(denied).toMatchObject({ success: false, denied: true });
        expect(daemon.requestApproval).toHaveBeenCalledWith(
          "task-1",
          "memory_delete",
          expect.stringContaining("dark mode"),
          expect.objectContaining({
            tool: "memory_forget",
            memory: `memory:${item.id}`,
            source: "user_stated",
            reason: "outdated",
          }),
        );
        expect(rowsOf(db, "id = ?", item.id)[0].status).toBe("active");

        expect((await tools.forget({ id: `memory:${item.id}` })).success).toBe(true);
        expect(rowsOf(db, "id = ?", item.id)[0].status).toBe("deleted");
      });

      it("forgets a fact this task's agent inferred without asking", async () => {
        const daemon = makeDaemon();
        const tools = new MemoryTools(workspace, daemon, "task-1");
        const remembered = await tools.remember({
          content: "The build uses pnpm workspaces",
          kind: "project_fact",
          scope: "task",
        });
        expect(remembered).toMatchObject({ success: true });
        expect(await tools.forget({ id: String(remembered.id) })).toEqual({
          success: true,
          forgotten: remembered.id,
        });
        expect(daemon.requestApproval).not.toHaveBeenCalled();
      });

      it("asks for inferred facts of other tasks, for match deletes and for archive rows", async () => {
        const other = await seed("Release notes live in docs/releases", {
          source: "inferred",
          taskId: "task-0",
          sourceRef: { store: "agent_tool", id: "r-1", taskId: "task-0" },
        });
        mocks.getFullDetails.mockResolvedValue([
          { id: "a-1", workspaceId: "ws-1", content: "Deploy went fine" },
        ]);
        const daemon = makeDaemon();
        daemon.requestApproval.mockResolvedValue(false);
        const tools = new MemoryTools(workspace, daemon, "task-1");

        expect((await tools.forget({ id: `memory:${other.id}` })).denied).toBe(true);
        expect((await tools.forget({ match: "release notes docs" })).denied).toBe(true);
        expect((await tools.forget({ id: "archive:a-1" })).denied).toBe(true);
        expect(daemon.requestApproval).toHaveBeenCalledTimes(3);
        expect(rowsOf(db, "id = ?", other.id)[0].status).toBe("active");
        expect(mocks.deleteEntries).not.toHaveBeenCalled();
      });
    });

    it("points knowledge-graph and conversation ids to the right place", async () => {
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      expect(String((await tools.forget({ id: "kg:e-1" })).error)).toContain("kg_delete_entity");
      expect((await tools.forget({ id: "event:dce_3" })).success).toBe(false);
      expect((await tools.forget({})).success).toBe(false);
    });
  });

  describe("context_recall", () => {
    it("searches the active task's conversation index when durable context is off", async () => {
      mocks.searchConversation.mockResolvedValue([
        { id: "dce_4", kind: "event", role: "user", timestamp: 1_000, snippet: "use port 8080" },
      ]);
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      const result = await tools.contextRecall({ query: "port" });
      expect(mocks.durableSearch).not.toHaveBeenCalled();
      expect(mocks.searchConversation).toHaveBeenCalledWith(
        expect.objectContaining({ workspaceId: "ws-1", taskId: "task-1", query: "port" }),
      );
      expect(result.results).toEqual([
        expect.objectContaining({ id: "dce_4", role: "user", snippet: "use port 8080" }),
      ]);
    });

    it("searches compacted context first when durable context is on", async () => {
      mocks.durableEnabled = true;
      mocks.durableSearch.mockResolvedValue([
        { id: "dcs_1", kind: "summary", timestamp: 1_000, snippet: "deployment plan" },
      ]);
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      const result = await tools.contextRecall({ query: "deployment", limit: 1 });
      expect(mocks.durableSearch).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        taskId: "task-1",
        query: "deployment",
        limit: 1,
      });
      expect(mocks.searchConversation).not.toHaveBeenCalled();
      expect(result.results).toEqual([expect.objectContaining({ id: "dcs_1", kind: "summary" })]);
    });

    it("expands a result by id within the active task", async () => {
      mocks.describeConversationHit.mockResolvedValue({
        id: "dce_4",
        kind: "message",
        workspaceId: "ws-1",
        taskId: "task-1",
        timestamp: 1_000,
        text: "user (user_message): use port 8080",
      });
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      const result = await tools.contextRecall({ id: "dce_4" });
      expect(mocks.describeConversationHit).toHaveBeenCalledWith({
        workspaceId: "ws-1",
        taskId: "task-1",
        id: "dce_4",
      });
      expect(result.result).toMatchObject({ id: "dce_4", text: expect.stringContaining("8080") });
      expect((await tools.contextRecall({})).success).toBe(false);
    });
  });

  describe("deprecated aliases", () => {
    it("routes every old name to a working implementation with a deprecation notice", async () => {
      await seed("Deploys go through staging");
      mocks.getFullDetails.mockResolvedValue([]);
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      const inputs: Record<string, Record<string, unknown>> = {
        search_memories: { query: "deploys" },
        memory_search_index: { query: "deploys" },
        memory_timeline: { query: "deploys" },
        memory_details: { ids: ["memory:none"] },
        search_quotes: { query: "deploys" },
        search_sessions: { query: "deploys" },
        memory_topics_load: { query: "deploys" },
        memory_curated_read: {},
        supermemory_profile: { query: "deploys" },
        supermemory_search: { query: "deploys" },
        memory_save: { content: "Shipped 2.1", type: "observation" },
        memory_curate: { action: "add", target: "workspace", content: "x" },
        supermemory_remember: { content: "x" },
        supermemory_forget: { memoryId: "sm-1" },
        context_grep: { query: "deploys" },
        context_describe: { id: "dce_1" },
      };
      mocks.curate.mockResolvedValue({ success: true, entry: { id: "cur-1" } });
      for (const name of Object.keys(LEGACY_MEMORY_TOOL_ALIASES)) {
        const result = (await tools.executeLegacyAlias(name, inputs[name] as Any)) as Record<
          string,
          unknown
        >;
        expect({ name, deprecated: String(result.deprecated) }).toEqual({
          name,
          deprecated: expect.stringContaining(LEGACY_MEMORY_TOOL_ALIASES[name]),
        });
      }
    });

    it("keeps the old inputs meaningful", async () => {
      const item = await seed("Deploys go through staging");
      const tools = new MemoryTools(workspace, makeDaemon(), "task-1");
      const found = (await tools.executeLegacyAlias("search_memories", {
        query: "deploys staging",
        lane: "archive",
      })) as Record<string, unknown>;
      expect((found.results as Array<{ id: string }>)[0].id).toBe(`memory:${item.id}`);

      const details = (await tools.executeLegacyAlias("memory_details", {
        ids: [item.id],
      })) as Record<string, unknown>;
      expect((details.results as Array<{ content: string }>)[0].content).toBe(
        "Deploys go through staging",
      );

      await tools.executeLegacyAlias("search_sessions", { query: "deploy", taskId: "task-0" });
      expect(recallDeps.searchConversation).toHaveBeenCalledWith(
        expect.objectContaining({ taskId: "task-0" }),
      );

      mocks.durableEnabled = true;
      await tools.executeLegacyAlias("context_grep", { query: "x", taskId: "other" });
      await tools.executeLegacyAlias("context_grep", {
        query: "x",
        taskId: "other",
        explicitUserRequest: true,
      });
      expect(mocks.durableSearch).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ taskId: "task-1" }),
      );
      expect(mocks.durableSearch).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({ taskId: "other" }),
      );

      const saved = (await tools.executeLegacyAlias("memory_save", {
        content: "Chose Postgres for the queue",
        type: "decision",
      })) as Record<string, unknown>;
      expect(saved).toMatchObject({ success: true, kind: "decision" });
    });

    it("refuses memory_curate in a read-only workspace", async () => {
      const tools = new MemoryTools(
        { ...workspace, permissions: { ...workspace.permissions, write: false } },
        makeDaemon(),
        "task-1",
      );
      const result = (await tools.executeLegacyAlias("memory_curate", {
        action: "add",
        target: "workspace",
        content: "x",
      })) as Record<string, unknown>;
      expect(result.success).toBe(false);
      expect(mocks.curate).not.toHaveBeenCalled();
    });
  });
});
