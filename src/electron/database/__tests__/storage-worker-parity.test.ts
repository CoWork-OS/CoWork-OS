import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseClient } from "../async/DatabaseClient";
import { DATABASE_COMMANDS, requiredTablesFor } from "../async/commands";
import { TaskEventRepository, TaskStore, WorkspaceStore } from "../repositories";
import {
  AnnotationRepository,
  ApprovalRepository,
  ArtifactRepository,
  ChannelRepository,
  ChannelSessionRepository,
  ChannelUserRepository,
  TaskRepository,
  TaskEventReplayRepository,
  WorkspaceRepository,
  InputRequestRepository,
  MemorySettingsRepository,
  TaskLabelRepository,
  WorkspacePermissionRuleRepository,
} from "../repository-facades";
import { DatabaseManager } from "../schema";
import { setStatementClient } from "../statements/statement-route";

// Channel config is encrypted on the host; the worker bundle has no secure storage, so a
// unit that tried to encrypt or decrypt there would fail.
vi.mock("../../utils/safe-storage", () => ({
  getSafeStorage: () => ({
    isEncryptionAvailable: () => true,
    encryptString: (value: string) => Buffer.from(value, "utf8"),
    decryptString: (value: Buffer) => value.toString("utf8"),
  }),
}));

// The storage layer's leaf repositories on both backends (async SQLite migration plan,
// DB6, slices A, B and C): the same calls through the facades return the same results on the host
// and in the database worker.

const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;

beforeAll(() => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  workerPath = path.join(BUILD_DIR, `database-worker-storage-${process.pid}.js`);
  buildSync({
    entryPoints: [path.resolve("src/electron/database/async/database-worker.ts")],
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    outfile: workerPath,
    external: ["better-sqlite3", "electron"],
    logLevel: "silent",
  });
});

afterAll(() => {
  fs.rmSync(workerPath, { force: true });
});

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function stable(value: unknown, start: number): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry) => {
      if (typeof entry === "string")
        return entry.replace(UUID, "<uuid>").replace(/\/[^"]*cowork-storage-[^"/]*/g, "<dir>");
      if (typeof entry === "number" && entry >= start - 60_000 && entry < start + 3_600_000) {
        return "<now>";
      }
      return entry;
    }),
  );
}

describe("storage layer leaf repositories on the host and in the database worker", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    vi.restoreAllMocks();
  });

  async function runWorkload(backend: "host" | "worker") {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `cowork-storage-${backend}-`)),
    );
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    let calls = 0;
    let client: DatabaseClient | null = null;
    if (backend === "worker") {
      client = await DatabaseClient.start({
        dbPath: manager.getDatabasePath(),
        requiredTables: requiredTablesFor(DATABASE_COMMANDS),
        workerPath,
      });
      const execute = client.execute.bind(client);
      vi.spyOn(client, "execute").mockImplementation(((name: string, args: unknown) => {
        if (name.startsWith("statements.")) calls += 1;
        return execute(name as Parameters<typeof execute>[0], args as never);
      }) as typeof client.execute);
      setStatementClient("storage", manager.getDatabasePath(), client);
    }
    cleanups.push(async () => {
      await client?.close(2_000);
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    const start = Date.now();
    const workspaceDir = path.join(dir, "ws");
    fs.mkdirSync(workspaceDir);
    const workspace = new WorkspaceStore(db).create("Storage", workspaceDir, {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    const task = new TaskStore(db).create({
      title: "Storage parity",
      prompt: "storage",
      status: "executing",
      workspaceId: workspace.id,
    });

    new TaskEventRepository(db).create({
      id: "timeline-event",
      taskId: task.id,
      timestamp: start,
      type: "assistant_message",
      payload: { message: "Replay facade" },
    });
    new TaskEventRepository(db).create({
      id: "timeline-event-older",
      taskId: task.id,
      timestamp: start - 1,
      type: "assistant_message",
      payload: { message: "Older replay facade page" },
    });
    const taskEvents = new TaskEventReplayRepository(db);
    const mutationCursor = await taskEvents.getCommittedMutationCursor(task.id);
    const mutationPage = await taskEvents.findCommittedMutationPage({
      taskId: task.id,
      afterCursor: { taskId: task.id, position: 0 },
      limit: 10,
    });
    const timelineSnapshot = await taskEvents.findTimelinePage({ taskId: task.id, limit: 10 });
    const scopedSnapshot = await taskEvents.findScopedTimelineSnapshot({
      taskId: task.id,
      workspaceId: workspace.id,
      limit: 1,
    });
    const historyCursor =
      scopedSnapshot.outcome === "available" ? scopedSnapshot.page.nextCursor : null;
    const scopedHistory = historyCursor?.id
      ? await taskEvents.findScopedTimelineHistoryPage({
          taskId: task.id,
          workspaceId: workspace.id,
          beforeCursor: { ...historyCursor, id: historyCursor.id },
          limit: 1,
        })
      : { outcome: "unavailable" as const };
    const scopedPage = await taskEvents.findScopedMutationPage({
      taskId: task.id,
      workspaceId: workspace.id,
      afterCursor: { taskId: task.id, position: 0 },
      limit: 10,
    });

    const approvals = new ApprovalRepository(db);
    const approval = await approvals.create({
      taskId: task.id,
      type: "run_command",
      description: "Run the tests",
      details: { command: "npm test" },
      status: "pending",
      requestedAt: start,
    });
    const pendingBefore = await approvals.findPendingByTaskId(task.id);
    await approvals.update(approval.id, "approved");
    const pendingAfter = await approvals.findPendingByTaskId(task.id);

    const artifacts = new ArtifactRepository(db);
    await artifacts.create({
      taskId: task.id,
      path: path.join(workspaceDir, "report.md"),
      mimeType: "text/markdown",
      sha256: "abc",
      size: 12,
      createdAt: start,
    });

    const annotations = new AnnotationRepository(db);
    const annotation = await annotations.create({
      taskId: task.id,
      workspaceId: workspace.id,
      surfaceType: "browser",
      body: "Tighten the summary.",
      targetRef: { surfaceType: "browser", url: "http://127.0.0.1:5173" },
    } as Parameters<AnnotationRepository["create"]>[0]);
    await annotations.update(annotation.id, { status: "resolved" });

    const rules = new WorkspacePermissionRuleRepository(db);
    await rules.create({
      workspaceId: workspace.id,
      effect: "allow",
      scope: { kind: "tool", toolName: "read_file" },
    } as Parameters<WorkspacePermissionRuleRepository["create"]>[0]);

    const inputs = new InputRequestRepository(db);
    await inputs.create({
      taskId: task.id,
      questions: [{ header: "Mode", id: "mode", question: "Which mode?", options: [] }],
      requestedAt: start,
    } as Parameters<InputRequestRepository["create"]>[0]);

    const labels = new TaskLabelRepository(db);
    const label = await labels.create({
      workspaceId: workspace.id,
      name: "urgent",
      color: "#f00",
    } as never);

    const channels = new ChannelRepository(db);
    const channel = await channels.create({
      type: "telegram",
      name: "Telegram",
      enabled: false,
      config: { botToken: "token-1" },
      securityConfig: { mode: "pairing" },
      status: "disconnected",
    });
    const duplicate = await channels.createIfTypeAbsent({
      type: "telegram",
      name: "Second",
      enabled: false,
      config: {},
      securityConfig: { mode: "pairing" },
      status: "disconnected",
    });
    await channels.update(channel.id, { config: { botToken: "token-2" }, status: "connected" });
    const storedConfig = (
      db.prepare("SELECT config FROM channels WHERE id = ?").get(channel.id) as { config: string }
    ).config;

    const users = new ChannelUserRepository(db);
    const firstUsers = await Promise.all(
      [1, 2, 3].map(() =>
        users.findOrCreateByChannelUser({
          channelId: channel.id,
          channelUserId: "u-1",
          displayName: "Ada",
          allowed: false,
        }),
      ),
    );
    await users.findOrCreateByChannelUser({
      channelId: channel.id,
      channelUserId: "u-1",
      displayName: "Ada L.",
      allowed: false,
    });

    const sessions = new ChannelSessionRepository(db);
    const chatSessions = await Promise.all(
      [1, 2, 3, 4, 5].map(() =>
        sessions.findOrCreateByChat({ channelId: channel.id, chatId: "chat-1", state: "idle" }),
      ),
    );
    const sessionId = chatSessions[0].id;
    await sessions.update(sessionId, { taskId: task.id, context: { a: 1 } });
    await sessions.update(sessionId, { context: { b: 2 } });
    const linked = await sessions.findById(sessionId);
    await sessions.update(sessionId, { taskId: undefined });

    const workspaces = new WorkspaceRepository(db);
    const otherDir = path.join(dir, "other");
    fs.mkdirSync(otherDir);
    const other = await workspaces.create("Other", otherDir, {
      read: true,
      write: false,
      delete: false,
      network: false,
      shell: false,
    });
    await workspaces.updateLastUsedAt(other.id, start + 5);
    const tasks = new TaskRepository(db);
    const created = await tasks.create({
      title: "Facade task",
      prompt: "through the facade",
      status: "pending",
      workspaceId: other.id,
    });
    await tasks.update(created.id, { status: "executing", resultSummary: "halfway" });
    const pinned = await tasks.togglePin(created.id);
    const moved = await tasks.moveToColumn(created.id, "review");
    const byWorkspace = await tasks.findByWorkspace(other.id);
    const board = await tasks.getTaskBoard(other.id);
    const disposable = await tasks.create({
      title: "Deleted task",
      prompt: "gone",
      status: "pending",
      workspaceId: other.id,
    });
    await tasks.delete(disposable.id);

    const result = stable(
      {
        workspace: await workspaces.findByPath(otherDir),
        workspaceCount: (await workspaces.findAll()).length,
        task: await tasks.findById(created.id),
        eventMutationCursor: mutationCursor,
        eventMutationOutcome: mutationPage.outcome,
        eventMutationCount:
          mutationPage.outcome === "page" || mutationPage.outcome === "page_with_more"
            ? mutationPage.changes.length
            : 0,
        timelineEventIds: timelineSnapshot.events.map((event) => event.id),
        timelineHasMore: timelineSnapshot.hasMoreHistory,
        scopedSnapshotOutcome: scopedSnapshot.outcome,
        scopedSnapshotEventIds:
          scopedSnapshot.outcome === "available"
            ? scopedSnapshot.page.events.map((event) => event.id)
            : [],
        scopedHistoryOutcome: scopedHistory.outcome,
        scopedHistoryEventIds:
          scopedHistory.outcome === "available"
            ? scopedHistory.page.events.map((event) => event.id)
            : [],
        scopedHistoryHasMore:
          scopedHistory.outcome === "available" ? scopedHistory.page.hasMoreHistory : false,
        scopedPageOutcome: scopedPage.outcome,
        scopedPageEventIds:
          scopedPage.outcome === "available" &&
          (scopedPage.page.outcome === "page" || scopedPage.page.outcome === "page_with_more")
            ? scopedPage.page.changes.flatMap((change) =>
                change.operation === "upsert" ? [change.event.id] : [],
              )
            : [],
        pinned: pinned?.pinned,
        movedColumn: moved?.boardColumn,
        byWorkspace: byWorkspace.map((entry) => entry.id === created.id),
        boardColumns: Object.keys(board).sort(),
        deletedTask: (await tasks.findById(disposable.id)) ?? null,
        channel: await channels.findById(channel.id),
        duplicate: duplicate ?? null,
        storedConfigSealed: storedConfig.startsWith("enc:"),
        userIds: new Set(firstUsers.map((user) => user.id)).size,
        channelUsers: await users.findByChannelId(channel.id),
        sessionIds: new Set(chatSessions.map((session) => session.id)).size,
        linkedTaskId: linked?.taskId === task.id,
        linkedContext: linked?.context,
        unlinked: await sessions.findById(sessionId),
        pendingBefore: pendingBefore.length,
        pendingAfter: pendingAfter.length,
        approval: await approvals.findById(approval.id),
        artifacts: await artifacts.findByTaskId(task.id),
        annotations: await annotations.list({ taskId: task.id }),
        rules: await rules.listByWorkspaceId(workspace.id),
        inputs: await inputs.findPendingByTaskId(task.id),
        labels: await labels.list(workspace.id as never),
        label,
        memorySettings: await new MemorySettingsRepository(db).getOrCreate(workspace.id),
      },
      start,
    );
    await channels.delete(channel.id);
    const deleted = (await channels.findAll()).length === 0;
    // Read after the result's own reads have run.
    return { calls, result: { ...(result as object), deleted } };
  }

  it("returns the same results on either backend", async () => {
    const host = await runWorkload("host");
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    vi.restoreAllMocks();
    const worker = await runWorkload("worker");

    expect(host.calls).toBe(0);
    expect(worker.calls).toBeGreaterThan(15);
    expect(worker.result).toEqual(host.result);
    const result = host.result as Record<string, Any>;
    expect(result.pendingBefore).toBe(1);
    expect(result.pendingAfter).toBe(0);
    expect(result.approval.status).toBe("approved");
    expect(result.rules).toHaveLength(1);
    expect(result.inputs).toHaveLength(1);
    expect(result.channel.config).toEqual({ botToken: "token-2" });
    expect(result.channel.status).toBe("connected");
    expect(result.duplicate).toBeNull();
    expect(result.storedConfigSealed).toBe(true);
    expect(result.userIds).toBe(1);
    expect(result.channelUsers).toHaveLength(1);
    expect(result.channelUsers[0].displayName).toBe("Ada L.");
    expect(result.sessionIds).toBe(1);
    expect(result.linkedTaskId).toBe(true);
    expect(result.linkedContext).toEqual({ a: 1, b: 2 });
    expect(result.unlinked.taskId).toBeUndefined();
    expect(result.deleted).toBe(true);
    expect(result.workspace.name).toBe("Other");
    expect(result.task.status).toBe("executing");
    expect(result.task.resultSummary).toBe("halfway");
    expect(result.pinned).toBe(true);
    expect(result.movedColumn).toBe("review");
    expect(result.byWorkspace).toEqual([true]);
    expect(result.deletedTask).toBeNull();
  });
});
