import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseClient } from "../async/DatabaseClient";
import { DATABASE_COMMANDS, requiredTablesFor } from "../async/commands";
import { DatabaseManager } from "../schema";
import { serviceStatements } from "../service-statements";
import { setStatementClient } from "../statements/statement-route";
import { TaskRepository } from "../repository-facades";
import { CouncilConfigRepository } from "../../council/council-repository-facades";
import { EventTriggerService } from "../../triggers/EventTriggerService";
import { HookSessionRepository } from "../../hooks/hook-session-repository-facades";
import { ensureFirstTaskTables } from "../../first-task/attempt-schema";
import { FirstTaskRepository } from "../../first-task/first-task-repository-facades";
import { ContextPolicyManager } from "../../gateway/context-policy-repository-facades";
import { RecurringApprovalService } from "../../security/recurring-approval-repository-facades";
import { AgentSecurityRepository } from "../../security/numbat/agent-security-repository-facades";
import { OrchestrationRepository } from "../../agent/orchestration-repository-facades";
import { YouTubeTranscriptStore } from "../../youtube/YouTubeTranscriptStore";
import { pruneTempWorkspaces } from "../../utils/temp-workspace";
import { TEMP_WORKSPACE_ID_PREFIX } from "../../../shared/types";

// The services areas moved while closing DB6 (async SQLite migration plan): the same calls
// return the same results on the host and in the database worker, and every data call
// runs in the worker when the services domain is routed there.

const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;

beforeAll(() => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  workerPath = path.join(BUILD_DIR, `database-worker-closeout-${process.pid}.js`);
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

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

function stable(value: unknown, start: number): unknown {
  return JSON.parse(
    JSON.stringify(value, (_key, entry) => {
      if (typeof entry === "string") {
        return entry
          .replace(UUID, "<uuid>")
          .replace(/\/[^"]*cowork-closeout-[^"/]*/g, "<dir>")
          .replace(/\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z/g, "<iso>");
      }
      if (typeof entry === "number" && entry >= start - 60_000 && entry < start + 3_600_000) {
        return "<now>";
      }
      return entry;
    }),
  );
}

const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => "resolved",
    (error: Error) => error.message,
  );

describe("DB6 close-out services on the host and in the database worker", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    YouTubeTranscriptStore.setDatabaseForTests(null);
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    vi.restoreAllMocks();
  });

  async function runWorkload(backend: "host" | "worker") {
    const dir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), `cowork-closeout-${backend}-`)),
    );
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    const start = Date.now();
    db.prepare(
      `INSERT INTO workspaces (id, name, path, created_at, permissions)
       VALUES (?, ?, ?, ?, ?)`,
    ).run("ws-1", "Workspace", path.join(dir, "workspace"), 1, "{}");
    db.prepare(
      `INSERT INTO channels (id, type, name, enabled, config, security_config, created_at, updated_at)
       VALUES ('channel-1', 'slack', 'Team', 1, '{}', '{}', 1, 1)`,
    ).run();
    for (const taskId of ["task-a", "task-b"]) {
      db.prepare(
        `INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at)
         VALUES (?, 'Hooked', 'Hooked', 'completed', 'ws-1', 1, 1)`,
      ).run(taskId);
    }
    // Schema the services create on the host at construction.
    ensureFirstTaskTables(db);
    YouTubeTranscriptStore.setDatabaseForTests(db);
    const triggers = new EventTriggerService(
      {
        createTask: async () => ({ id: "task-from-trigger" }),
        getDefaultWorkspaceId: () => "ws-1",
        log: () => undefined,
      } as never,
      db,
    );
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
      setStatementClient("services", manager.getDatabasePath(), client);
      setStatementClient("storage", manager.getDatabasePath(), client);
    }
    cleanups.push(async () => {
      await triggers.stop();
      await client?.close(2_000);
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });

    // Councils.
    const councils = new CouncilConfigRepository(db);
    const council = await councils.create({
      workspaceId: "ws-1",
      name: "Weekly council",
      schedule: { kind: "every", everyMs: 3_600_000 },
      participants: [
        { providerType: "openai", modelKey: "gpt-5", seatLabel: "Proposer" },
        { providerType: "anthropic", modelKey: "sonnet", seatLabel: "Judge" },
      ],
      judgeSeatIndex: 1,
    } as never);
    const councilIds = await councils.allIds();

    // Event triggers: kept in memory, persisted through units.
    await triggers.start();
    const trigger = await triggers.addTrigger({
      name: "Invoices",
      enabled: true,
      source: "channel_message",
      conditions: [],
      action: { type: "create_task", config: { prompt: "Handle it" } },
      workspaceId: "ws-1",
    } as never);
    await triggers.updateTrigger(trigger.id, { name: "Invoices (renamed)" });
    const storedTriggers = (
      await serviceStatements(db).unit("eventTrigger_loadTriggerRows", [])
    ).map((row: { name: string }) => row.name);
    const removed = await triggers.removeTrigger(trigger.id);

    // Hook sessions: idempotent creation and a single lock holder.
    const hooks = new HookSessionRepository(db);
    const hookCreated = [
      await hooks.create("hook:1", "task-a"),
      await hooks.create("hook:1", "task-b"),
    ];
    const hookSession = await hooks.findBySessionKey("hook:1");
    const locks = [await hooks.acquireLock("hook:1"), await hooks.acquireLock("hook:1")];
    await hooks.releaseLock("hook:1");
    const relocked = await hooks.acquireLock("hook:1");

    // First task: setup choice, and a sample task created with its attempt in one unit.
    const firstTask = new FirstTaskRepository(db);
    await firstTask.setSetupChoice("ready", start);
    const setup = await firstTask.getSetup();
    const sample = await firstTask.createSampleAttempt({
      attemptId: "attempt-1",
      missionId: "release-brief-v1",
      workspaceId: "ws-1",
      now: start,
      task: {
        title: "Sample",
        prompt: "Sample prompt",
        status: "pending",
        workspaceId: "ws-1",
        source: "sample",
      } as never,
    });
    const attempt = await firstTask.findAttempt("attempt-1");
    const attemptTaskIds = await firstTask.attemptTaskIds();
    const sampleTask = await new TaskRepository(db).findById(sample.id);

    // Context policies: the group default restricts memory tools; DMs do not.
    const policies = new ContextPolicyManager(db);
    const toolChecks = [
      await policies.isToolAllowed("channel-1", "group", "memory_remember", ["group:memory"]),
      await policies.isToolAllowed("channel-1", "dm", "memory_remember", ["group:memory"]),
    ];
    const channelPolicies = (await policies.getPoliciesForChannel("channel-1")).map(
      (policy) => policy.contextType,
    );

    // Recurring approvals: a revoked rule no longer matches.
    const approvals = new RecurringApprovalService(db);
    const approvalInput = {
      workspaceId: "ws-1",
      toolName: "http_request",
      toolInput: { url: "https://api.example.com/items" },
      approvalType: "network_access",
      command: null,
      path: null,
      serverName: null,
      scope: { kind: "domain" as const, domain: "api.example.com", toolName: "http_request" },
    };
    const rule = await approvals.create(
      {
        ...approvalInput,
        effect: "allow",
        scopePreview: "api.example.com",
        expiresAt: start + 60_000,
      },
      start,
    );
    const activeBefore =
      (await approvals.findActive(approvalInput, start + 1))?.summary.id === rule.id;
    await approvals.revoke(rule.id, start + 2);
    const activeAfter = await approvals.findActive(approvalInput, start + 3);

    // Agent security: one record file's writes in one unit.
    const security = new AgentSecurityRepository(db);
    const ingestedDiagnostics = await security.applyIngest([
      {
        kind: "finding",
        finding: {
          findingId: "finding-1",
          schemaVersion: "1",
          sourceAgent: "numbat",
          sourceType: "scan",
          ruleId: "rule-1",
          ruleVersion: "1",
          severity: "high",
          title: "Secret in output",
          status: "open",
          detectedAt: new Date(start).toISOString(),
          record: {},
          createdAt: start,
          updatedAt: start,
        },
      },
      {
        kind: "diagnostic",
        diagnostic: { level: "warn", code: "invalid_ndjson", message: "Invalid record" },
      },
    ] as never);
    const findings = (await security.listFindings()).map((finding) => finding.findingId);
    const diagnostics = (await security.listDiagnostics()).map((diagnostic) => diagnostic.code);

    // Orchestration runs.
    const orchestration = new OrchestrationRepository(db);
    const run = await orchestration.create({
      rootTaskId: "root-1",
      workspaceId: "ws-1",
      tasks: [],
      status: "running",
    } as never);
    await orchestration.update(run.id, { status: "completed" } as never);
    const reloadedRun = await orchestration.findById(run.id);

    // YouTube transcripts: segments replace in one unit, then search.
    await YouTubeTranscriptStore.saveVideo("ws-1", {
      videoId: "video-1",
      url: "https://youtu.be/video-1",
      title: "Planning talk",
      fetchedAt: start,
    } as never);
    await YouTubeTranscriptStore.saveSegments("ws-1", "video-1", [
      { startMs: 0, text: "Welcome to the planning talk", source: "captions" },
      { startMs: 5_000, text: "Quarterly roadmap review", source: "captions" },
    ] as never);
    const hits = (
      await YouTubeTranscriptStore.search({ workspaceId: "ws-1", query: "roadmap" })
    ).map((hit) => hit.startMs);

    // Temp workspace prune: an old unused temp workspace goes, a referenced one stays.
    const tempRoot = path.join(dir, "temp-root");
    fs.mkdirSync(tempRoot, { recursive: true });
    for (const [suffix, withTask] of [
      ["old", false],
      ["busy", true],
    ] as const) {
      const id = `${TEMP_WORKSPACE_ID_PREFIX}${suffix}`;
      const workspacePath = path.join(tempRoot, suffix);
      fs.mkdirSync(workspacePath, { recursive: true });
      db.prepare(
        `INSERT INTO workspaces (id, name, path, created_at, last_used_at, permissions)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, "Temp", workspacePath, 1, 1, "{}");
      if (withTask) {
        db.prepare(
          `INSERT INTO tasks (id, title, prompt, status, workspace_id, created_at, updated_at)
           VALUES (?, 'Busy', 'Busy', 'executing', ?, 1, 1)`,
        ).run(`task-${suffix}`, id);
      }
    }
    const pruned = await pruneTempWorkspaces({
      db,
      tempWorkspaceRoot: tempRoot,
      keepRecent: 0,
      nowMs: start,
    });
    const remainingTemp = (
      db
        .prepare("SELECT id FROM workspaces WHERE substr(id, 1, ?) = ? ORDER BY id")
        .all(TEMP_WORKSPACE_ID_PREFIX.length, TEMP_WORKSPACE_ID_PREFIX) as Array<{ id: string }>
    ).map((row) => row.id);

    const result = stable(
      {
        council: { name: council.name, ids: councilIds.length },
        triggers: { storedTriggers, removed },
        hooks: { hookCreated, taskId: hookSession?.taskId, locks, relocked },
        firstTask: {
          choice: setup?.choice,
          attemptTask: attempt?.task_id === sample.id,
          attemptTaskIds: attemptTaskIds.length,
          sampleSource: sampleTask?.source,
        },
        policies: { toolChecks, channelPolicies: channelPolicies.sort() },
        approvals: { activeBefore, activeAfter },
        security: { ingestedDiagnostics: ingestedDiagnostics.length, findings, diagnostics },
        orchestration: reloadedRun?.status,
        youtube: hits,
        temp: {
          removedRows: pruned.removedRows,
          remainingTemp,
          missingRejection: await rejection(Promise.resolve()),
        },
      },
      start,
    );
    return { calls, result };
  }

  it("returns the same results on either backend", async () => {
    const host = await runWorkload("host");
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    vi.restoreAllMocks();
    const worker = await runWorkload("worker");

    expect(host.calls).toBe(0);
    expect(worker.calls).toBeGreaterThan(40);
    expect(worker.result).toEqual(host.result);
    const result = host.result as Record<string, Any>;
    expect(result.triggers).toEqual({ storedTriggers: ["Invoices (renamed)"], removed: true });
    expect(result.hooks).toEqual({
      hookCreated: [true, false],
      taskId: "task-a",
      locks: [true, false],
      relocked: true,
    });
    expect(result.firstTask).toMatchObject({
      choice: "ready",
      attemptTask: true,
      sampleSource: "sample",
    });
    expect(result.policies.toolChecks).toEqual([false, true]);
    expect(result.approvals).toEqual({ activeBefore: true, activeAfter: null });
    expect(result.security.findings).toEqual(["finding-1"]);
    expect(result.orchestration).toBe("completed");
    expect(result.youtube).toEqual([5_000]);
    expect(result.temp.remainingTemp).toEqual([`${TEMP_WORKSPACE_ID_PREFIX}busy`]);
  });
});
