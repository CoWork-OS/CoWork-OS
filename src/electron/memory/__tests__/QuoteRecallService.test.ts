import { createRequire } from "module";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const transcriptMocks = vi.hoisted(() => ({
  searchSpans: vi.fn(),
}));

const memoryServiceMocks = vi.hoisted(() => ({
  search: vi.fn(),
  getFullDetails: vi.fn(),
  searchWorkspaceMarkdown: vi.fn(),
}));

vi.mock("../TranscriptStore", () => ({
  TranscriptStore: {
    searchSpans: transcriptMocks.searchSpans,
  },
}));

vi.mock("../MemoryService", () => ({
  MemoryService: {
    search: memoryServiceMocks.search,
    getFullDetails: memoryServiceMocks.getFullDetails,
    searchWorkspaceMarkdown: memoryServiceMocks.searchWorkspaceMarkdown,
  },
}));

import { TaskEventRepository } from "../../database/repositories";
import { QuoteRecallService } from "../QuoteRecallService";

const require = createRequire(import.meta.url);
const BetterSqlite3Module = (() => {
  try {
    return require("better-sqlite3") as typeof import("better-sqlite3");
  } catch {
    return null;
  }
})();

const BetterSqlite3 = (() => {
  if (!BetterSqlite3Module) return null;
  try {
    const probe = new BetterSqlite3Module(":memory:");
    probe.close();
    return BetterSqlite3Module;
  } catch {
    return null;
  }
})();

const describeWithNativeDb = BetterSqlite3 ? describe : describe.skip;
const databases: Array<import("better-sqlite3").Database> = [];
const tempDirs: string[] = [];

function createDb(): import("better-sqlite3").Database {
  if (!BetterSqlite3) {
    throw new Error("better-sqlite3 unavailable");
  }
  const db = new BetterSqlite3(":memory:");
  databases.push(db);
  db.exec(`
    CREATE TABLE task_events (
      id TEXT PRIMARY KEY,
      task_id TEXT NOT NULL,
      timestamp INTEGER NOT NULL,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      schema_version INTEGER NOT NULL DEFAULT 2,
      event_id TEXT,
      seq INTEGER,
      ts INTEGER,
      status TEXT,
      step_id TEXT,
      group_id TEXT,
      actor TEXT,
      legacy_type TEXT
    );
  `);
  return db;
}

async function createWorkspaceDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-quote-recall-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.clearAllMocks();
  for (const db of databases.splice(0)) {
    db.close();
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

beforeEach(() => {
  transcriptMocks.searchSpans.mockResolvedValue([]);
  memoryServiceMocks.search.mockReturnValue([]);
  memoryServiceMocks.getFullDetails.mockReturnValue([]);
  memoryServiceMocks.searchWorkspaceMarkdown.mockReturnValue([]);
});

describeWithNativeDb("QuoteRecallService", () => {
  it("ranks exact transcript spans ahead of task-message and memory hits", async () => {
    const db = createDb();
    const eventRepo = new TaskEventRepository(db);
    eventRepo.create({
      id: "event-1",
      taskId: "task-1",
      timestamp: 2_000,
      type: "assistant_message",
      payload: { message: "We should never mutate the production DB directly." },
      schemaVersion: 2,
      eventId: "event-1",
      seq: 1,
      ts: 2_000,
    });

    transcriptMocks.searchSpans.mockResolvedValue([
      {
        taskId: "task-1",
        timestamp: 3_000,
        type: "assistant_message",
        payload: { message: "We should never mutate the production DB directly." },
        eventId: "snapshot-1",
        seq: 2,
        rawLine:
          '{"taskId":"task-1","type":"assistant_message","payload":{"message":"We should never mutate the production DB directly."}}',
      },
    ]);
    memoryServiceMocks.search.mockReturnValue([
      {
        id: "memory-1",
        snippet: "Rule of thumb: never mutate the production DB directly.",
        type: "decision",
        relevanceScore: 9,
        createdAt: 1_000,
        taskId: "task-1",
        source: "db",
      },
    ]);
    memoryServiceMocks.getFullDetails.mockReturnValue([
      {
        id: "memory-1",
        workspaceId: "ws-1",
        taskId: "task-1",
        type: "decision",
        content: "Rule of thumb: never mutate the production DB directly.",
        summary: "Rule of thumb: never mutate the production DB directly.",
        tokens: 12,
        isCompressed: false,
        isPrivate: false,
        createdAt: 1_000,
        updatedAt: 1_000,
      },
    ]);

    const results = await QuoteRecallService.search({
      db,
      workspaceId: "ws-1",
      workspacePath: "/tmp/does-not-matter",
      query: "never mutate the production DB directly",
      taskId: "task-1",
      limit: 5,
    });

    expect(results[0]?.sourceType).toBe("transcript_span");
    expect(results[1]?.sourceType).toBe("task_message");
    expect(results[2]?.sourceType).toBe("memory");
    expect(results[0]?.excerpt).toContain("never mutate the production DB directly");
  });

  it("returns workspace markdown provenance with exact excerpt text", async () => {
    const db = createDb();
    const workspacePath = await createWorkspaceDir();
    const kitDir = path.join(workspacePath, ".cowork");
    await fs.mkdir(kitDir, { recursive: true });
    await fs.writeFile(
      path.join(kitDir, "USER.md"),
      [
        "# USER",
        "",
        "The release rule is simple:",
        "Never mutate the production DB directly.",
        "Always go through migrations.",
      ].join("\n"),
      "utf8",
    );

    memoryServiceMocks.searchWorkspaceMarkdown.mockReturnValue([
      {
        id: "md:1",
        snippet: "Never mutate the production DB directly.",
        type: "summary",
        relevanceScore: 7,
        createdAt: 4_000,
        source: "markdown",
        path: ".cowork/USER.md",
        startLine: 3,
        endLine: 5,
      },
    ]);

    const results = await QuoteRecallService.search({
      db,
      workspaceId: "ws-1",
      workspacePath,
      query: "Never mutate the production DB directly",
      limit: 5,
      sourceTypes: ["workspace_markdown"],
      includeWorkspaceNotes: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.sourceType).toBe("workspace_markdown");
    expect(results[0]?.path).toBe(".cowork/USER.md");
    expect(results[0]?.excerpt).toContain("Never mutate the production DB directly.");
    expect(results[0]?.startLine).toBe(3);
    expect(results[0]?.endLine).toBe(5);
  });

  it("resolves workspace markdown excerpts when the index stores paths relative to the .cowork root", async () => {
    const db = createDb();
    const workspacePath = await createWorkspaceDir();
    const kitDir = path.join(workspacePath, ".cowork");
    await fs.mkdir(kitDir, { recursive: true });
    await fs.writeFile(
      path.join(kitDir, "USER.md"),
      [
        "# USER",
        "",
        "Rules",
        "Never mutate the production DB directly.",
        "Use migrations instead.",
      ].join("\n"),
      "utf8",
    );

    memoryServiceMocks.searchWorkspaceMarkdown.mockReturnValue([
      {
        id: "md:kit-relative",
        snippet: "Never mutate the production DB directly.",
        type: "summary",
        relevanceScore: 8,
        createdAt: 5_000,
        source: "markdown",
        path: "USER.md",
        startLine: 3,
        endLine: 5,
      },
    ]);

    const results = await QuoteRecallService.search({
      db,
      workspaceId: "ws-1",
      workspacePath,
      query: "Never mutate the production DB directly",
      limit: 5,
      sourceTypes: ["workspace_markdown"],
      includeWorkspaceNotes: true,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.path).toBe("USER.md");
    expect(results[0]?.excerpt).toContain("Never mutate the production DB directly.");
    expect(results[0]?.excerpt).toContain("Use migrations instead.");
  });
});
