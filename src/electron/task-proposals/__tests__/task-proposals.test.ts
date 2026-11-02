import { createRequire } from "module";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Task } from "../../../shared/types";
import { TASK_PROPOSAL_LIMITS } from "../../../shared/task-proposals";
import { TaskProposalService, type TaskProposalHost } from "../TaskProposalService";
import { TaskProposalStore } from "../TaskProposalStore";
import { deleteTaskProposalsForTask } from "../task-proposal-sql";

vi.mock("../../git/GitService", () => ({
  GitService: { isGitRepo: vi.fn(async () => true) },
}));

const require = createRequire(import.meta.url);
const BetterSqlite3 = (() => {
  try {
    const module = require("better-sqlite3") as typeof import("better-sqlite3");
    new module(":memory:").close();
    return module;
  } catch {
    return null;
  }
})();
const describeWithNativeDb = BetterSqlite3 ? describe : describe.skip;
const databases: Array<import("better-sqlite3").Database> = [];

afterEach(() => {
  TaskProposalStore.setDatabaseForTests(null);
  for (const db of databases.splice(0)) db.close();
});

const ORIGIN_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const BRIEF =
  "Make `AgentDaemon.recoverUnstartedUserFollowUpsOnStartup()` read only the newest user " +
  "messages per task. Done: startup no longer scans every past message; tests pass.";

function originTask(overrides: Partial<Task> = {}): Task {
  return {
    id: ORIGIN_ID,
    title: "Speed up startup",
    prompt: "Make startup faster",
    status: "completed",
    workspaceId: WORKSPACE_ID,
    createdAt: 1,
    updatedAt: 1,
    agentConfig: {
      accessProfileId: "ask-for-approval",
      accessCeilingProfileId: "read-only",
      inheritedAccessCeilingProfileIds: ["workspace-write"],
    },
    ...overrides,
  } as Task;
}

function setup(options: { now?: () => number; task?: Task } = {}) {
  const db = new BetterSqlite3!(":memory:");
  databases.push(db);
  TaskProposalStore.setDatabaseForTests(db);
  const task = options.task ?? originTask();
  const host = {
    getTask: vi.fn((id: string) => (id === task.id ? task : undefined)),
    getWorkspaceById: vi.fn((id: string) =>
      id === WORKSPACE_ID
        ? { id, name: "cowork", path: "/repo", isTemp: false, permissions: { write: true } }
        : undefined,
    ),
    logEvent: vi.fn(),
    createTask: vi.fn(async (params: { title: string }) => ({
      id: "33333333-3333-4333-8333-333333333333",
      title: params.title,
    })),
    sendMessage: vi.fn(async () => ({ queued: false })),
  };
  const service = new TaskProposalService(
    host as unknown as TaskProposalHost,
    options.now ?? (() => 1_000),
  );
  return { db, host, service };
}

async function propose(
  service: TaskProposalService,
  overrides: Record<string, unknown> = {},
  proposalsThisTurn = 0,
) {
  const result = await service.propose(
    ORIGIN_ID,
    {
      title: "Speed up follow-up recovery scan",
      summary: "The startup scan reads every past user message.",
      brief: BRIEF,
      ...overrides,
    },
    { proposalsThisTurn },
  );
  if (!result.ok) throw new Error(result.error);
  return result.proposal;
}

describeWithNativeDb("TaskProposalService", () => {
  it("keeps a valid proposal pending and shows it as a card event", async () => {
    const { host, service } = setup();
    const proposal = await propose(service, { worktree: true });

    expect(proposal).toMatchObject({
      taskId: ORIGIN_ID,
      workspaceId: WORKSPACE_ID,
      status: "pending",
      suggestedWorktree: true,
      expiresAt: 1_000 + TASK_PROPOSAL_LIMITS.ttlMs,
    });
    expect(host.logEvent).toHaveBeenCalledWith(ORIGIN_ID, "task_proposal_created", {
      proposal,
      status: "completed",
    });
    expect(await service.list(ORIGIN_ID)).toEqual([proposal]);
  });

  it("refuses incomplete, oversized, repeated and over-limit proposals", async () => {
    const { service } = setup();
    const refuse = async (input: Record<string, unknown>, proposalsThisTurn = 0) => {
      const result = await service.propose(
        ORIGIN_ID,
        { title: "Fix it", summary: "Why it matters.", brief: BRIEF, ...input },
        { proposalsThisTurn },
      );
      expect(result.ok).toBe(false);
      return result.ok ? "" : result.error;
    };

    expect(await refuse({ title: "  " })).toMatch(/title is required/);
    expect(await refuse({ title: "x".repeat(61) })).toMatch(/at most 60/);
    expect(await refuse({ summary: "" })).toMatch(/summary is required/);
    expect(await refuse({ brief: "Fix the bug." })).toMatch(/must stand alone|at least 80/);
    expect(await refuse({}, TASK_PROPOSAL_LIMITS.perTurn)).toMatch(/At most 3/);

    await propose(service, { title: "Lazy-load LLM SDK clients" });
    expect(await refuse({ title: "lazy load  LLM SDK clients!" })).toMatch(/already proposed/);
  });

  it("starts a task from the agent's brief without prompt provenance, under every origin limit", async () => {
    const { host, service } = setup();
    const proposal = await propose(service, { worktree: true });

    const task = await service.start(proposal.id);

    expect(task.id).toBe("33333333-3333-4333-8333-333333333333");
    const params = host.createTask.mock.calls[0][0] as Record<string, unknown>;
    expect(params).toMatchObject({
      title: proposal.title,
      prompt: BRIEF,
      workspaceId: WORKSPACE_ID,
      source: "suggested_task",
      agentConfig: {
        worktreeMode: "worktree",
        accessProfileId: "ask-for-approval",
        inheritedAccessCeilingProfileIds: expect.arrayContaining(["read-only", "workspace-write"]),
      },
    });
    expect(params).not.toHaveProperty("promptProvenance");
    expect(host.logEvent).toHaveBeenLastCalledWith(
      ORIGIN_ID,
      "task_proposal_updated",
      expect.objectContaining({
        proposal: expect.objectContaining({ status: "started", startedTaskId: task.id }),
      }),
    );
    expect((await service.list(ORIGIN_ID))[0]).toMatchObject({
      status: "started",
      startedTaskId: task.id,
    });
    await expect(service.start(proposal.id)).rejects.toThrow(/already handled/);
  });

  it("uses the person's Options and keeps a pinned model by default", async () => {
    const { host, service } = setup({
      task: originTask({
        agentConfig: { providerType: "anthropic", modelKey: "opus-4-5", modelPinned: true },
      }),
    });
    const first = await propose(service, { title: "First" });
    const second = await propose(service, { title: "Second" });

    await service.start(first.id, {
      worktreeMode: "local",
      providerType: "openai",
      modelKey: "gpt-5",
      accessProfileId: "full-access",
    });
    await service.start(second.id);

    expect(host.createTask.mock.calls[0][0]).toMatchObject({
      agentConfig: {
        worktreeMode: "local",
        providerType: "openai",
        modelKey: "gpt-5",
        modelPinned: true,
        accessProfileId: "full-access",
      },
    });
    expect(host.createTask.mock.calls[1][0]).toMatchObject({
      agentConfig: {
        worktreeMode: "local",
        providerType: "anthropic",
        modelKey: "opus-4-5",
        modelPinned: true,
      },
    });
  });

  it("puts the proposal back when the task cannot be created", async () => {
    const { host, service } = setup();
    const proposal = await propose(service);
    host.createTask.mockRejectedValueOnce(new Error("queue full"));

    await expect(service.start(proposal.id)).rejects.toThrow("queue full");
    expect((await service.list(ORIGIN_ID))[0].status).toBe("pending");
  });

  it("sends the brief to the same task for Do it here, never as typed text", async () => {
    const { host, service } = setup();
    const proposal = await propose(service);

    await service.doHere(proposal.id);

    expect(host.sendMessage).toHaveBeenCalledWith(ORIGIN_ID, BRIEF, undefined, undefined, {
      messageSource: "user",
      surfaceOrigin: "suggested_task",
      returnOnAccepted: true,
    });
    expect((await service.list(ORIGIN_ID))[0].status).toBe("done_here");
  });

  it("dismisses, withdraws and expires proposals", async () => {
    let now = 1_000;
    const { service } = setup({ now: () => now });
    const dismissed = await propose(service, { title: "Dismiss me" });
    const withdrawn = await propose(service, { title: "Withdraw me" });
    const expiring = await propose(service, { title: "Let me expire" });

    await service.dismiss(dismissed.id);
    expect(await service.withdraw("another-task", withdrawn.id, "x")).toMatchObject({ ok: false });
    expect(await service.withdraw(ORIGIN_ID, withdrawn.id, "fixed in this task")).toMatchObject({
      ok: true,
      proposal: { status: "withdrawn", withdrawReason: "fixed in this task" },
    });
    expect(await service.withdraw(ORIGIN_ID, dismissed.id, "")).toMatchObject({ ok: false });

    now += TASK_PROPOSAL_LIMITS.ttlMs + 1;
    const statuses = Object.fromEntries(
      (await service.list(ORIGIN_ID)).map((proposal) => [proposal.title, proposal.status]),
    );
    expect(statuses).toEqual({
      "Dismiss me": "dismissed",
      "Withdraw me": "withdrawn",
      "Let me expire": "expired",
    });
    await expect(service.start(expiring.id)).rejects.toThrow(/expired/);
  });

  it("starts every listed proposal of the task for Start all", async () => {
    const { host, service } = setup();
    const first = await propose(service, { title: "First" });
    const second = await propose(service, { title: "Second" });

    const results = await service.startAll(ORIGIN_ID, [first.id, second.id, "missing"]);

    expect(host.createTask).toHaveBeenCalledTimes(2);
    expect(results).toEqual([
      { proposalId: first.id, taskId: "33333333-3333-4333-8333-333333333333" },
      { proposalId: second.id, taskId: "33333333-3333-4333-8333-333333333333" },
      { proposalId: "missing", error: "Not a suggestion from this task." },
    ]);
  });

  it("deletes a task's proposals with the task", async () => {
    const { db, service } = setup();
    await propose(service);

    deleteTaskProposalsForTask(db, ORIGIN_ID);

    expect(await service.list(ORIGIN_ID)).toEqual([]);
  });
});
