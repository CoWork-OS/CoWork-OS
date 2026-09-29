import { buildSync } from "esbuild";
import fs from "fs";
import os from "os";
import path from "path";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { DatabaseClient } from "../../database/async/DatabaseClient";
import { DATABASE_COMMANDS, requiredTablesFor } from "../../database/async/commands";
import { TaskStore, WorkspaceStore } from "../../database/repositories";
import { DatabaseManager } from "../../database/schema";
import { setStatementClient } from "../../database/statements/statement-route";
import { ControlPlaneCoreService } from "../ControlPlaneCoreService";
import { StrategicPlannerService } from "../StrategicPlannerService";

// The control plane on both backends (async SQLite migration plan, DB6): the same
// workload through the host connection and through the database worker returns the same
// results, and the run state machine stays atomic under concurrent callers.

const BUILD_DIR = path.resolve("node_modules/.cache/cowork-db-worker-test");
let workerPath: string;

beforeAll(() => {
  fs.mkdirSync(BUILD_DIR, { recursive: true });
  workerPath = path.join(BUILD_DIR, `database-worker-control-plane-${process.pid}.js`);
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
        return entry.replace(UUID, "<uuid>").replace(/\/tmp[^"]*/, "<dir>");
      if (typeof entry === "number" && entry >= start - 60_000 && entry < start + 3_600_000) {
        return "<now>";
      }
      return entry;
    }),
  );
}

describe("control plane on the host and in the database worker", () => {
  const cleanups: Array<() => Promise<void> | void> = [];
  const previousUserDataDir = process.env.COWORK_USER_DATA_DIR;

  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
    setStatementClient(null, null, null);
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    vi.restoreAllMocks();
  });

  async function profile(backend: "host" | "worker") {
    const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `cowork-cp-${backend}-`)));
    process.env.COWORK_USER_DATA_DIR = dir;
    const manager = new DatabaseManager();
    const db = manager.getDatabase();
    let client: DatabaseClient | null = null;
    let workerCalls = 0;
    if (backend === "worker") {
      client = await DatabaseClient.start({
        dbPath: manager.getDatabasePath(),
        requiredTables: requiredTablesFor(DATABASE_COMMANDS),
        workerPath,
      });
      const execute = client.execute.bind(client);
      vi.spyOn(client, "execute").mockImplementation(((name: string, args: unknown) => {
        if (name.startsWith("statements.")) workerCalls += 1;
        return execute(name as Parameters<typeof execute>[0], args as never);
      }) as typeof client.execute);
      setStatementClient("controlPlane", manager.getDatabasePath(), client);
    }
    cleanups.push(async () => {
      await client?.close(2_000);
      manager.close();
      fs.rmSync(dir, { recursive: true, force: true });
    });
    const workspaceDir = path.join(dir, "ws");
    fs.mkdirSync(workspaceDir);
    const workspace = new WorkspaceStore(db).create("Parity", workspaceDir, {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    return { db, workspace, calls: () => workerCalls };
  }

  async function runWorkload(backend: "host" | "worker") {
    const { db, workspace, calls } = await profile(backend);
    const start = Date.now();
    const core = new ControlPlaneCoreService(db);
    const taskRepo = new TaskStore(db);
    const company = await core.getDefaultCompany();
    const project = await core.createProject({ companyId: company.id, name: "Parity project" });
    const issue = await core.createIssue({
      companyId: company.id,
      projectId: project.id,
      workspaceId: workspace.id,
      title: "Ship the worker",
    });
    await core.createIssueComment({
      issueId: issue.id,
      authorType: "user",
      body: "Please check the parity suite first.",
    } as Parameters<ControlPlaneCoreService["createIssueComment"]>[0]);
    const checkout = await core.checkoutIssue({ issueId: issue.id, workspaceId: workspace.id });
    const second = await core
      .checkoutIssue({ issueId: issue.id, workspaceId: workspace.id })
      .catch((error: Error) => error.message);
    const task = taskRepo.create({
      title: "Execute",
      prompt: "Run the parity suite.",
      status: "planning",
      workspaceId: workspace.id,
      source: "manual",
    });
    const attached = await core.attachTaskToRun(checkout.run.id, task.id);
    await core.syncTaskLifecycle(task.id, { status: "executing" });
    taskRepo.update(task.id, { status: "completed", terminalStatus: "ok", resultSummary: "Done" });
    await core.syncTaskLifecycle(task.id);

    const planner = new StrategicPlannerService({ db });
    const config = await planner.getConfig(company.id);
    const updated = await planner.updateConfig(company.id, { enabled: true, maxIssuesPerRun: 3 });

    return {
      calls: calls(),
      result: stable(
        {
          second,
          attachedTask: { issueId: attached.task.issueId === issue.id, run: attached.run.status },
          issue: await core.getIssue(issue.id),
          runs: await core.listRuns({ issueId: issue.id }),
          events: (await core.getRunEvents(checkout.run.id)).map((event) => event.type),
          comments: await core.listIssueComments(issue.id),
          projects: await core.listProjects({ companyId: company.id }),
          costs: await core.summarizeCosts({ scopeType: "project", scopeId: project.id }),
          taskLink: taskRepo.findById(task.id)?.heartbeatRunId === checkout.run.id,
          planner: { config, updated, runs: await planner.listRuns({ companyId: company.id }) },
        },
        start,
      ),
    };
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
    expect(result.second).toMatch(/already checked out/i);
    expect(result.issue.status).toBe("done");
    expect(result.events).toEqual([
      "issue.checked_out",
      "run.task_attached",
      "task.executing",
      "task.completed",
    ]);
    expect(result.taskLink).toBe(true);
    expect(result.planner.updated.enabled).toBe(true);
  });

  it("admits exactly one of several concurrent checkouts of an issue", async () => {
    const { db, workspace } = await profile("worker");
    const core = new ControlPlaneCoreService(db);
    const company = await core.getDefaultCompany();
    const issue = await core.createIssue({
      companyId: company.id,
      workspaceId: workspace.id,
      title: "Claim me once",
    });
    const outcomes = await Promise.allSettled(
      Array.from({ length: 5 }, () =>
        new ControlPlaneCoreService(db).checkoutIssue({ issueId: issue.id }),
      ),
    );
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect((await core.listRuns({ issueId: issue.id })).length).toBe(1);
  });
});
