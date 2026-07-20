import { beforeEach, describe, expect, it, vi } from "vitest";
import type { HooksConfig } from "../../hooks/types";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Database = module.default;
      const probe = new Database(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("RoutineService", () => {
  let db: import("better-sqlite3").Database;
  let RoutineServiceCtor: typeof import("../service").RoutineService;
  let EventTriggerServiceCtor: typeof import("../../triggers/EventTriggerService").EventTriggerService;
  let routineService: import("../service").RoutineService;
  let eventTriggerService: import("../../triggers/EventTriggerService").EventTriggerService;
  let hooksSettings: HooksConfig;
  let cronService: {
    add: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    const Database = (await import("better-sqlite3")).default;
    db = new Database(":memory:");

    ({ RoutineService: RoutineServiceCtor } = await import("../service"));
    ({ EventTriggerService: EventTriggerServiceCtor } = await import(
      "../../triggers/EventTriggerService"
    ));

    hooksSettings = {
      enabled: true,
      token: "global-token",
      path: "/hooks",
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    };

    cronService = {
      add: vi.fn().mockImplementation(async (job) => ({
        ok: true,
        job: { id: "cron-1", ...job, state: {} },
      })),
      update: vi.fn().mockImplementation(async (_id, patch) => ({
        ok: true,
        job: { id: "cron-1", ...patch, state: {} },
      })),
      remove: vi.fn().mockResolvedValue({ ok: true, removed: true }),
    };

    eventTriggerService = new EventTriggerServiceCtor({
      createTask: vi.fn().mockResolvedValue({ id: "task-1" }),
      getDefaultWorkspaceId: () => "ws-default",
      log: vi.fn(),
    });
    eventTriggerService.start();

    routineService = new RoutineServiceCtor({
      db,
      getCronService: () => cronService as Any,
      getEventTriggerService: () => eventTriggerService,
      loadHooksSettings: () => hooksSettings,
      saveHooksSettings: (settings) => {
        hooksSettings = settings;
      },
    });
  });

  it("upgrades a legacy routine_runs table before creating workflow indexes", () => {
    db.exec(`
      DROP TABLE routine_runs;
      CREATE TABLE routine_runs (
        id TEXT PRIMARY KEY,
        routine_id TEXT NOT NULL,
        trigger_id TEXT NOT NULL,
        trigger_type TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at INTEGER NOT NULL,
        finished_at INTEGER,
        source_event_summary TEXT,
        backing_task_id TEXT,
        backing_managed_session_id TEXT,
        output_status TEXT NOT NULL DEFAULT 'none',
        error_summary TEXT,
        artifacts_summary TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
    `);

    expect(
      () =>
        new RoutineServiceCtor({
          db,
          getCronService: () => cronService as Any,
          getEventTriggerService: () => eventTriggerService,
          loadHooksSettings: () => hooksSettings,
          saveHooksSettings: (settings) => {
            hooksSettings = settings;
          },
        }),
    ).not.toThrow();

    const columns = db.prepare("PRAGMA table_info(routine_runs)").all() as Array<{
      name: string;
    }>;
    const indexes = db.prepare("PRAGMA index_list(routine_runs)").all() as Array<{
      name: string;
    }>;

    expect(columns.map((column) => column.name)).toEqual(
      expect.arrayContaining(["run_key", "dedupe_key", "workflow_run_id"]),
    );
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "idx_routine_runs_run_key",
        "idx_routine_runs_workflow",
        "idx_routine_runs_dedupe_key",
      ]),
    );
  });

  it("creates managed schedule, api, and connector-event triggers", async () => {
    const routine = await routineService.create({
      name: "PR Triage",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Review the incoming signal and draft the next action.",
      connectors: ["github", "linear"],
      triggers: [
        {
          id: "schedule-1",
          type: "schedule",
          enabled: true,
          schedule: { kind: "cron", expr: "0 2 * * *" },
        },
        {
          id: "api-1",
          type: "api",
          enabled: true,
        },
        {
          id: "connector-1",
          type: "connector_event",
          enabled: true,
          connectorId: "github",
          changeType: "resource_updated",
        },
      ],
    });

    expect(cronService.add).toHaveBeenCalledTimes(1);
    expect(hooksSettings.mappings).toHaveLength(1);
    expect(hooksSettings.mappings[0]?.match?.path).toContain(`routines/${routine.id}/api-1`);
    expect(hooksSettings.mappings[0]?.token).toBeTruthy();
    expect(eventTriggerService.listTriggers()).toHaveLength(1);
    expect(
      routine.triggers.find((trigger) => trigger.type === "schedule" && trigger.managedCronJobId),
    ).toBeTruthy();
    expect(
      routine.triggers.find((trigger) => trigger.type === "api" && trigger.token),
    ).toBeTruthy();
    expect(
      routine.triggers.find(
        (trigger) => trigger.type === "connector_event" && trigger.managedEventTriggerId,
      ),
    ).toBeTruthy();
  });

  it("syncs task-session routines as thread follow-ups across schedule, api, and event triggers", async () => {
    await routineService.create({
      name: "Task Follow-up",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Continue the existing task.",
      connectors: ["github"],
      contextBindings: {
        metadata: {
          runMode: "thread_follow_up",
          targetTaskId: "task-existing",
          sourceTaskTitle: "Original Task",
          sourceLink: "cowork://tasks/task-existing",
          threadAutomation: "true",
        },
      },
      triggers: [
        {
          id: "schedule-1",
          type: "schedule",
          enabled: true,
          schedule: { kind: "cron", expr: "0 2 * * *" },
        },
        {
          id: "api-1",
          type: "api",
          enabled: true,
        },
        {
          id: "connector-1",
          type: "connector_event",
          enabled: true,
          connectorId: "github",
          changeType: "resource_updated",
        },
      ],
    });

    expect(cronService.add).toHaveBeenCalledWith(
      expect.objectContaining({
        runMode: "thread_follow_up",
        targetTaskId: "task-existing",
        threadAutomation: expect.objectContaining({
          sourceTaskId: "task-existing",
          sourceTaskTitle: "Original Task",
          sourceLink: "cowork://tasks/task-existing",
        }),
      }),
    );
    expect(hooksSettings.mappings[0]).toMatchObject({
      action: "task_message",
      targetTaskId: "task-existing",
    });
    expect(eventTriggerService.listTriggers()[0]?.action.config).toMatchObject({
      runMode: "thread_follow_up",
      targetTaskId: "task-existing",
    });
  });

  it("removes managed resources when a routine is deleted", async () => {
    const routine = await routineService.create({
      name: "Deploy Alerts",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Triage deployment alerts.",
      connectors: [],
      triggers: [
        {
          id: "schedule-1",
          type: "schedule",
          enabled: true,
          schedule: { kind: "cron", expr: "*/15 * * * *" },
        },
        {
          id: "api-1",
          type: "api",
          enabled: true,
        },
        {
          id: "connector-1",
          type: "connector_event",
          enabled: true,
          connectorId: "github",
        },
      ],
    });

    const removed = await routineService.remove(routine.id);

    expect(removed).toBe(true);
    expect(cronService.remove).toHaveBeenCalledTimes(1);
    expect(hooksSettings.mappings).toHaveLength(0);
    expect(eventTriggerService.listTriggers()).toHaveLength(0);
  });

  it("queues manual task-session routine runs into the existing thread", async () => {
    const sendTaskMessage = vi.fn().mockResolvedValue({ queued: true });
    routineService = new RoutineServiceCtor({
      db,
      getCronService: () => cronService as Any,
      getEventTriggerService: () => eventTriggerService,
      loadHooksSettings: () => hooksSettings,
      saveHooksSettings: (settings) => {
        hooksSettings = settings;
      },
      createTask: vi.fn().mockResolvedValue({ id: "new-task" }),
      sendTaskMessage,
      now: () => 1_779_000_000_000,
    });

    const routine = await routineService.create({
      name: "Task Follow-up",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Continue the existing task.",
      connectors: [],
      contextBindings: {
        metadata: {
          runMode: "thread_follow_up",
          targetTaskId: "task-existing",
          threadAutomation: "true",
        },
      },
      triggers: [{ id: "manual-1", type: "manual", enabled: true }],
    });

    await routineService.runNow(routine.id);

    expect(sendTaskMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "task-existing",
        message: expect.stringContaining("Continue the existing task."),
      }),
    );
    const runs = await routineService.listRuns(routine.id, 10);
    expect(runs[0]?.backingTaskId).toBe("task-existing");
    expect(runs[0]?.status).toBe("queued");
  });

  it("refreshes a manual run without creating duplicate run rows", async () => {
    let now = 1_779_000_000_000;
    routineService = new RoutineServiceCtor({
      db,
      getCronService: () => cronService as Any,
      getEventTriggerService: () => eventTriggerService,
      loadHooksSettings: () => hooksSettings,
      saveHooksSettings: (settings) => {
        hooksSettings = settings;
      },
      createTask: vi.fn().mockResolvedValue({ id: "task-1" }),
      getTaskSnapshot: vi.fn().mockReturnValue({
        status: "failed",
        terminalStatus: "failed",
        error: "Task missing verification evidence",
        completedAt: now + 100,
      }),
      now: () => now++,
    });

    const routine = await routineService.create({
      name: "Build Health",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Check build health.",
      connectors: [],
      triggers: [{ id: "manual-1", type: "manual", enabled: true }],
    });

    await routineService.runNow(routine.id);
    await routineService.listRuns(routine.id, 10);
    await routineService.listRuns(routine.id, 10);

    const rowCount = db
      .prepare("SELECT COUNT(*) AS count FROM routine_runs WHERE routine_id = ?")
      .get(routine.id) as { count: number };
    const runs = await routineService.listRuns(routine.id, 10);

    expect(rowCount.count).toBe(1);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.backingTaskId).toBe("task-1");
  });

  it("updates an existing execution run when a duplicate dispatch returns the same backing task", async () => {
    let now = 1_779_000_000_000;
    routineService = new RoutineServiceCtor({
      db,
      getCronService: () => cronService as Any,
      getEventTriggerService: () => eventTriggerService,
      loadHooksSettings: () => hooksSettings,
      saveHooksSettings: (settings) => {
        hooksSettings = settings;
      },
      createTask: vi.fn().mockResolvedValue({ id: "task-duplicate" }),
      now: () => now++,
    });

    const routine = await routineService.create({
      name: "Build Health",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Check build health.",
      connectors: [],
      triggers: [{ id: "manual-1", type: "manual", enabled: true }],
    });

    await routineService.runNow(routine.id);
    await routineService.runNow(routine.id);

    const rowCount = db
      .prepare("SELECT COUNT(*) AS count FROM routine_runs WHERE routine_id = ?")
      .get(routine.id) as { count: number };
    const run = db
      .prepare("SELECT backing_task_id, run_key, dedupe_key FROM routine_runs WHERE routine_id = ?")
      .get(routine.id) as { backing_task_id: string; run_key: string; dedupe_key: string };

    expect(rowCount.count).toBe(1);
    expect(run.backing_task_id).toBe("task-duplicate");
    expect(run.dedupe_key).toBe(`task:${routine.id}:task-duplicate`);
    expect(run.run_key).toContain(`manual:${routine.id}:`);
  });

  it("does not merge distinct thread follow-up runs that target the same task", async () => {
    let now = 1_779_000_000_000;
    const sendTaskMessage = vi.fn().mockResolvedValue({ queued: true });
    routineService = new RoutineServiceCtor({
      db,
      getCronService: () => cronService as Any,
      getEventTriggerService: () => eventTriggerService,
      loadHooksSettings: () => hooksSettings,
      saveHooksSettings: (settings) => {
        hooksSettings = settings;
      },
      sendTaskMessage,
      now: () => now++,
    });

    const routine = await routineService.create({
      name: "Task Follow-up",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Continue the existing task.",
      connectors: [],
      contextBindings: {
        metadata: {
          runMode: "thread_follow_up",
          targetTaskId: "task-existing",
          threadAutomation: "true",
        },
      },
      triggers: [{ id: "manual-1", type: "manual", enabled: true }],
    });

    await routineService.runNow(routine.id);
    await routineService.runNow(routine.id);

    const rowCount = db
      .prepare("SELECT COUNT(*) AS count FROM routine_runs WHERE routine_id = ?")
      .get(routine.id) as { count: number };

    expect(sendTaskMessage).toHaveBeenCalledTimes(2);
    expect(rowCount.count).toBe(2);
  });

  it("refreshes a task-backed routine run when the backing task finishes", async () => {
    let taskStatus = "executing";
    const getTaskSnapshot = vi.fn(() => ({
      status: taskStatus,
      terminalStatus: taskStatus === "completed" ? "ok" : undefined,
      resultSummary: taskStatus === "completed" ? "Build checks passed." : undefined,
      completedAt: taskStatus === "completed" ? 1_779_000_000_100 : undefined,
    }));
    routineService = new RoutineServiceCtor({
      db,
      getCronService: () => cronService as Any,
      getEventTriggerService: () => eventTriggerService,
      loadHooksSettings: () => hooksSettings,
      saveHooksSettings: (settings) => {
        hooksSettings = settings;
      },
      createTask: vi.fn().mockResolvedValue({ id: "task-1" }),
      getTaskSnapshot,
      now: () => 1_779_000_000_000,
    });

    const routine = await routineService.create({
      name: "Build Health",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Check build health.",
      connectors: [],
      triggers: [{ id: "manual-1", type: "manual", enabled: true }],
    });
    await routineService.runNow(routine.id);

    taskStatus = "completed";
    await routineService.refreshRunsForTask("task-1");

    const runs = await routineService.listRuns(routine.id, 10);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("completed");
    expect(runs[0]?.finishedAt).toBe(1_779_000_000_100);
    expect(runs[0]?.artifactsSummary).toBe("Build checks passed.");
  });

  it("keeps a cron polling timeout non-terminal while its backing task is still running", async () => {
    const routine = await routineService.create({
      name: "Daily Plan",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Build a daily plan.",
      connectors: [],
      triggers: [
        {
          id: "schedule-1",
          type: "schedule",
          enabled: true,
          schedule: { kind: "every", everyMs: 86_400_000 },
        },
      ],
    });
    const trigger = routine.triggers.find((candidate) => candidate.type === "schedule");
    expect(trigger?.managedCronJobId).toBe("cron-1");

    routineService.recordScheduledEvent({
      jobId: "cron-1",
      action: "started",
      runAtMs: 1_779_000_000_000,
      taskId: "task-running",
    });
    routineService.recordScheduledEvent({
      jobId: "cron-1",
      action: "finished",
      runAtMs: 1_779_000_000_000,
      durationMs: 1_800_000,
      status: "timeout",
      error: "Timed out after 1800s",
      taskId: "task-running",
      taskStillRunning: true,
    });

    const runs = await routineService.listRuns(routine.id, 10);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("running");
    expect(runs[0]?.outputStatus).toBe("queued");
    expect(runs[0]?.finishedAt).toBeUndefined();
    expect(runs[0]?.errorSummary).toBe("Timed out after 1800s");
  });

  it("repairs a stale cron timeout failure when the backing task later completes", async () => {
    const getTaskSnapshot = vi.fn().mockReturnValue({
      status: "completed",
      terminalStatus: "partial_success",
      resultSummary: "Daily plan completed with calendar unavailable.",
      completedAt: 1_779_000_123_000,
    });
    routineService = new RoutineServiceCtor({
      db,
      getCronService: () => cronService as Any,
      getEventTriggerService: () => eventTriggerService,
      loadHooksSettings: () => hooksSettings,
      saveHooksSettings: (settings) => {
        hooksSettings = settings;
      },
      getTaskSnapshot,
      now: () => 1_779_000_200_000,
    });
    const routine = await routineService.create({
      name: "Daily Plan",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Build a daily plan.",
      connectors: [],
      triggers: [{ id: "manual-1", type: "manual", enabled: true }],
    });

    db.prepare(
      `INSERT INTO routine_runs
       (id, routine_id, trigger_id, trigger_type, status, started_at, finished_at,
        source_event_summary, backing_task_id, backing_managed_session_id, output_status,
        error_summary, artifacts_summary, run_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-timeout",
      routine.id,
      "manual-1",
      "manual",
      "failed",
      1_779_000_000_000,
      1_779_001_800_000,
      "Scheduled run finished: timeout",
      "task-late-success",
      null,
      "failed",
      "Timed out after 1800s",
      null,
      null,
      1_779_000_000_000,
      1_779_001_800_000,
    );

    const runs = await routineService.listRuns(routine.id, 10);

    expect(getTaskSnapshot).toHaveBeenCalledWith("task-late-success");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("partial_success");
    expect(runs[0]?.outputStatus).toBe("none");
    expect(runs[0]?.errorSummary).toBeUndefined();
    expect(runs[0]?.artifactsSummary).toBe("Daily plan completed with calendar unavailable.");
    expect(runs[0]?.finishedAt).toBe(1_779_000_123_000);
  });

  it("prefers backing task reconciliation over a stale managed session for timeout rows", async () => {
    const getTaskSnapshot = vi.fn().mockReturnValue({
      status: "completed",
      terminalStatus: "ok",
      resultSummary: "Daily plan finished.",
      completedAt: 1_779_000_123_000,
    });
    const getManagedSessionSnapshot = vi.fn().mockReturnValue({
      status: "failed",
      latestSummary: "Timed out after 1800s",
      completedAt: 1_779_001_800_000,
      backingTaskId: "task-late-success",
    });
    routineService = new RoutineServiceCtor({
      db,
      getCronService: () => cronService as Any,
      getEventTriggerService: () => eventTriggerService,
      loadHooksSettings: () => hooksSettings,
      saveHooksSettings: (settings) => {
        hooksSettings = settings;
      },
      getTaskSnapshot,
      getManagedSessionSnapshot,
      now: () => 1_779_000_200_000,
    });
    const routine = await routineService.create({
      name: "Daily Plan",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Build a daily plan.",
      connectors: [],
      triggers: [{ id: "manual-1", type: "manual", enabled: true }],
    });

    db.prepare(
      `INSERT INTO routine_runs
       (id, routine_id, trigger_id, trigger_type, status, started_at, finished_at,
        source_event_summary, backing_task_id, backing_managed_session_id, output_status,
        error_summary, artifacts_summary, run_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-timeout-managed",
      routine.id,
      "manual-1",
      "manual",
      "failed",
      1_779_000_000_000,
      1_779_001_800_000,
      "Scheduled run finished: timeout",
      "task-late-success",
      "session-stale",
      "failed",
      "Timed out after 1800s",
      null,
      null,
      1_779_000_000_000,
      1_779_001_800_000,
    );

    const runs = await routineService.listRuns(routine.id, 10);

    expect(getTaskSnapshot).toHaveBeenCalledWith("task-late-success");
    expect(getManagedSessionSnapshot).not.toHaveBeenCalled();
    expect(runs[0]?.status).toBe("completed");
    expect(runs[0]?.errorSummary).toBeUndefined();
    expect(runs[0]?.artifactsSummary).toBe("Daily plan finished.");
  });

  it("can proactively reconcile stale timeout rows without listing runs", async () => {
    routineService = new RoutineServiceCtor({
      db,
      getCronService: () => cronService as Any,
      getEventTriggerService: () => eventTriggerService,
      loadHooksSettings: () => hooksSettings,
      saveHooksSettings: (settings) => {
        hooksSettings = settings;
      },
      getTaskSnapshot: vi.fn().mockReturnValue({
        status: "completed",
        terminalStatus: "ok",
        resultSummary: "Daily plan finished.",
        completedAt: 1_779_000_123_000,
      }),
      now: () => 1_779_000_200_000,
    });
    const routine = await routineService.create({
      name: "Daily Plan",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Build a daily plan.",
      connectors: [],
      triggers: [{ id: "manual-1", type: "manual", enabled: true }],
    });

    db.prepare(
      `INSERT INTO routine_runs
       (id, routine_id, trigger_id, trigger_type, status, started_at, finished_at,
        source_event_summary, backing_task_id, backing_managed_session_id, output_status,
        error_summary, artifacts_summary, run_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-timeout-backfill",
      routine.id,
      "manual-1",
      "manual",
      "failed",
      1_779_000_000_000,
      1_779_001_800_000,
      "Scheduled run finished: timeout",
      "task-late-success",
      null,
      "failed",
      "Timed out after 1800s",
      null,
      null,
      1_779_000_000_000,
      1_779_001_800_000,
    );

    await routineService.reconcileStaleTimeoutRuns();

    const row = db
      .prepare("SELECT status, output_status, error_summary, artifacts_summary FROM routine_runs WHERE id = ?")
      .get("run-timeout-backfill") as {
      status: string;
      output_status: string;
      error_summary: string | null;
      artifacts_summary: string | null;
    };
    expect(row.status).toBe("completed");
    expect(row.output_status).toBe("none");
    expect(row.error_summary).toBeNull();
    expect(row.artifacts_summary).toBe("Daily plan finished.");
  });

  it("keeps a stale cron timeout failure failed when the backing task failed", async () => {
    routineService = new RoutineServiceCtor({
      db,
      getCronService: () => cronService as Any,
      getEventTriggerService: () => eventTriggerService,
      loadHooksSettings: () => hooksSettings,
      saveHooksSettings: (settings) => {
        hooksSettings = settings;
      },
      getTaskSnapshot: vi.fn().mockReturnValue({
        status: "failed",
        terminalStatus: "failed",
        error: "fetch failed",
        completedAt: 1_779_000_100_000,
      }),
      now: () => 1_779_000_200_000,
    });
    const routine = await routineService.create({
      name: "Daily Plan",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Build a daily plan.",
      connectors: [],
      triggers: [{ id: "manual-1", type: "manual", enabled: true }],
    });

    db.prepare(
      `INSERT INTO routine_runs
       (id, routine_id, trigger_id, trigger_type, status, started_at, finished_at,
        source_event_summary, backing_task_id, backing_managed_session_id, output_status,
        error_summary, artifacts_summary, run_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-hard-failure",
      routine.id,
      "manual-1",
      "manual",
      "failed",
      1_779_000_000_000,
      1_779_001_800_000,
      "Scheduled run finished: timeout",
      "task-failed",
      null,
      "failed",
      "Timed out after 1800s",
      null,
      null,
      1_779_000_000_000,
      1_779_001_800_000,
    );

    const runs = await routineService.listRuns(routine.id, 10);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.outputStatus).toBe("failed");
    expect(runs[0]?.errorSummary).toBe("fetch failed");
  });

  it("collapses historical duplicate run rows that point at the same backing task", async () => {
    const routine = await routineService.create({
      name: "Build Health",
      enabled: true,
      workspaceId: "ws-1",
      prompt: "Check build health.",
      connectors: [],
      triggers: [{ id: "manual-1", type: "manual", enabled: true }],
    });

    const base = 1_779_000_000_000;
    db.prepare(
      `INSERT INTO routine_runs
       (id, routine_id, trigger_id, trigger_type, status, started_at, finished_at,
        source_event_summary, backing_task_id, backing_managed_session_id, output_status,
        error_summary, artifacts_summary, run_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-1",
      routine.id,
      "manual-1",
      "manual",
      "running",
      base,
      null,
      "Manual run",
      "task-1",
      null,
      "none",
      null,
      null,
      null,
      base,
      base,
    );
    db.prepare(
      `INSERT INTO routine_runs
       (id, routine_id, trigger_id, trigger_type, status, started_at, finished_at,
        source_event_summary, backing_task_id, backing_managed_session_id, output_status,
        error_summary, artifacts_summary, run_key, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      "run-2",
      routine.id,
      "manual-1",
      "manual",
      "failed",
      base,
      base + 1,
      "Manual run",
      "task-1",
      null,
      "failed",
      "Task missing verification evidence",
      null,
      null,
      base + 1,
      base + 1,
    );

    const runs = await routineService.listRuns(routine.id, 10);

    expect(runs).toHaveLength(1);
    expect(runs[0]?.id).toBe("run-2");
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.errorSummary).toBe("Task missing verification evidence");
  });
});
