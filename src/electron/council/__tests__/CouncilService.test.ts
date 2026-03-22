import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describeWithSqlite("CouncilService", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let dbManager: import("../../database/schema").DatabaseManager;
  let db: ReturnType<import("../../database/schema").DatabaseManager["getDatabase"]>;
  let service: import("../CouncilService").CouncilService;
  let taskRepo: import("../../database/repositories").TaskRepository;
  let taskEventRepo: import("../../database/repositories").TaskEventRepository;
  let notifications: Array<{ title: string; message: string; taskId?: string }>;
  let buildTrigger: (councilId: string) => string;

  const cronState = {
    jobs: new Map<string, Any>(),
    lastRunTaskId: null as string | null,
  };

  const fakeCronService = {
    add: vi.fn(async (job: Any) => {
      const created = { ...job, id: `cron-${randomUUID()}` };
      cronState.jobs.set(created.id, created);
      return { ok: true, job: created };
    }),
    update: vi.fn(async (id: string, patch: Any) => {
      const existing = cronState.jobs.get(id);
      if (!existing) {
        return { ok: false, error: "not-found" };
      }
      const updated = { ...existing, ...patch, id };
      cronState.jobs.set(id, updated);
      return { ok: true, job: updated };
    }),
    remove: vi.fn(async (id: string) => {
      const removed = cronState.jobs.delete(id);
      return { ok: true, removed };
    }),
    run: vi.fn(async (id: string) => {
      if (!cronState.jobs.has(id) || !cronState.lastRunTaskId) {
        return { ok: true, ran: false as const, reason: "not-found" as const };
      }
      return { ok: true, ran: true as const, taskId: cronState.lastRunTaskId };
    }),
  };

  const insertWorkspace = (name = "main") => {
    const workspace = {
      id: randomUUID(),
      name,
      path: path.join(tmpDir, name),
      createdAt: Date.now(),
      permissions: JSON.stringify({
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: true,
      }),
    };
    fs.mkdirSync(workspace.path, { recursive: true });
    db.prepare(
      `
        INSERT INTO workspaces (id, name, path, created_at, permissions)
        VALUES (?, ?, ?, ?, ?)
      `,
    ).run(workspace.id, workspace.name, workspace.path, workspace.createdAt, workspace.permissions);
    return workspace;
  };

  beforeEach(async () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-council-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    notifications = [];
    cronState.jobs.clear();
    cronState.lastRunTaskId = null;
    fakeCronService.add.mockClear();
    fakeCronService.update.mockClear();
    fakeCronService.remove.mockClear();
    fakeCronService.run.mockClear();

    const [{ DatabaseManager }, councilModule, repositories] = await Promise.all([
      import("../../database/schema"),
      import("../CouncilService"),
      import("../../database/repositories"),
    ]);
    const { CouncilService } = councilModule;

    dbManager = new DatabaseManager();
    db = dbManager.getDatabase();
    buildTrigger = CouncilService.buildManagedTrigger;
    service = new CouncilService({
      db,
      getCronService: () => fakeCronService as Any,
      getNotificationService: () =>
        ({
          add: vi.fn(async (notification: Any) => {
            notifications.push(notification);
            return notification;
          }),
        }) as Any,
      deliverToChannel: async () => {
        throw new Error("gateway unavailable");
      },
    });
    taskRepo = new repositories.TaskRepository(db);
    taskEventRepo = new repositories.TaskEventRepository(db);
  });

  afterEach(() => {
    dbManager?.close();
    if (previousUserDataDir === undefined) {
      delete process.env.COWORK_USER_DATA_DIR;
    } else {
      process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("persists council CRUD and syncs one managed cron job", async () => {
    const workspace = insertWorkspace();

    const created = await service.create({
      workspaceId: workspace.id,
      name: "Founder R&D",
      schedule: { kind: "cron", expr: "0 9,17 * * *" },
      participants: [
        { providerType: "ollama", modelKey: "llama3.2", seatLabel: "Builder" },
        { providerType: "ollama", modelKey: "mistral", seatLabel: "Critic" },
      ],
      judgeSeatIndex: 1,
    });

    expect(created.managedCronJobId).toBeTruthy();
    expect(fakeCronService.add).toHaveBeenCalledTimes(1);
    expect(service.list(workspace.id)).toHaveLength(1);

    const updated = await service.update({
      id: created.id,
      name: "Founder R&D Daily",
      enabled: false,
    });

    expect(updated?.name).toBe("Founder R&D Daily");
    expect(updated?.enabled).toBe(false);
    expect(fakeCronService.update).toHaveBeenCalledTimes(1);

    const removed = await service.delete(created.id);
    expect(removed).toBe(true);
    expect(fakeCronService.remove).toHaveBeenCalledWith(created.managedCronJobId);
    expect(service.list(workspace.id)).toHaveLength(0);
  });

  it("rotates proposer seats and caps all-local councils to two concurrent participants", async () => {
    const workspace = insertWorkspace();
    const sourceFile = path.join(workspace.path, "roadmap.md");
    fs.writeFileSync(sourceFile, "Q2 roadmap\n- ship council memos\n- test local model debates\n", "utf8");

    const council = await service.create({
      workspaceId: workspace.id,
      name: "Local Council",
      schedule: { kind: "cron", expr: "0 9,17 * * *" },
      participants: [
        { providerType: "ollama", modelKey: "llama3.2", seatLabel: "Proposer" },
        { providerType: "ollama", modelKey: "mistral", seatLabel: "Skeptic" },
        { providerType: "ollama", modelKey: "phi4", seatLabel: "Operator" },
        { providerType: "ollama", modelKey: "qwen2.5", seatLabel: "Analyst" },
        { providerType: "ollama", modelKey: "gemma3", seatLabel: "Judge" },
      ],
      judgeSeatIndex: 4,
      rotatingIdeaSeatIndex: 0,
      sourceBundle: {
        files: [{ path: sourceFile, label: "Roadmap" }],
      },
    });

    const first = await service.prepareTaskForTrigger(buildTrigger(council.id), workspace.id);
    expect(first?.agentConfig?.multiLlmConfig?.maxParallelParticipants).toBe(2);
    expect(first?.agentConfig?.multiLlmConfig?.participants[0]?.isIdeaProposer).toBe(true);
    expect(first?.prompt).toContain("Roadmap");

    const afterFirst = service.get(council.id);
    expect(afterFirst?.nextIdeaSeatIndex).toBe(1);

    const second = await service.prepareTaskForTrigger(buildTrigger(council.id), workspace.id);
    expect(second?.agentConfig?.multiLlmConfig?.participants[1]?.isIdeaProposer).toBe(true);
    expect(service.get(council.id)?.nextIdeaSeatIndex).toBe(2);
  });

  it("finalizes memo persistence and records delivery failure without dropping the memo", async () => {
    const workspace = insertWorkspace();
    const council = await service.create({
      workspaceId: workspace.id,
      name: "Hybrid Council",
      schedule: { kind: "cron", expr: "0 9,17 * * *" },
      participants: [
        { providerType: "ollama", modelKey: "llama3.2", seatLabel: "Local" },
        { providerType: "openai", modelKey: "gpt-4o", seatLabel: "Judge" },
      ],
      judgeSeatIndex: 1,
      deliveryConfig: {
        enabled: true,
        channelType: "discord",
        channelId: "room-1",
      },
    });

    const prepared = await service.prepareTaskForTrigger(buildTrigger(council.id), workspace.id);
    expect(prepared).toBeTruthy();

    const task = taskRepo.create({
      title: prepared!.title,
      prompt: prepared!.prompt,
      rawPrompt: prepared!.prompt,
      status: "completed",
      workspaceId: workspace.id,
      resultSummary:
        "Executive Summary\n\nWhat We Reviewed\n\nBest New Idea\n\nWhere The Models Agreed\n\nWhere They Disagreed\n\nRecommended Next Actions\n\nExperiments To Run\n\nRisks / Missing Inputs",
      agentConfig: prepared!.agentConfig,
      agentType: "main",
      source: "cron",
    });
    cronState.lastRunTaskId = task.id;

    service.bindRunTask(prepared!.runId, task.id);
    taskEventRepo.create({
      taskId: task.id,
      timestamp: Date.now(),
      type: "assistant_message",
      payload: { text: "memo complete" },
    });

    const completed = await service.finalizeRunForTask(task.id);
    expect(completed?.memoId).toBeTruthy();
    expect(completed?.status).toBe("completed");

    const memo = service.getMemo(completed!.memoId!);
    expect(memo?.content).toContain("Executive Summary");
    expect(memo?.delivered).toBe(false);
    expect(memo?.deliveryError).toContain("gateway unavailable");
    expect(notifications).toHaveLength(1);
    expect(notifications[0]?.title).toContain("R&D Council memo");
  });
});
