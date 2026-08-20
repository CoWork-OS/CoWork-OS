import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TaskRepository } from "../../database/repositories";
import { DatabaseManager } from "../../database/schema";
import { ManagedSessionService } from "../../managed/ManagedSessionService";
import { BotCoordinatorService } from "../BotCoordinatorService";
import { BotRoomService } from "../BotRoomService";
import { BotRoomCoordinatorService } from "../BotRoomCoordinatorService";
import { BotMessageRepository } from "../repositories";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const probe = new module.default(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("BotCoordinatorService", () => {
  let tmpDir: string;
  let previousUserDataDir: string | undefined;
  let manager: DatabaseManager;
  let db: ReturnType<DatabaseManager["getDatabase"]>;
  let tasks: TaskRepository;
  let managed: ManagedSessionService;
  let bots: BotCoordinatorService;
  let daemon: Any;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-bots-"));
    previousUserDataDir = process.env.COWORK_USER_DATA_DIR;
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    manager = new DatabaseManager();
    db = manager.getDatabase();
    tasks = new TaskRepository(db);
    daemon = {
      startTask: vi.fn(async (task: Any) => {
        tasks.update(task.id, { status: "executing" });
      }),
      cancelTask: vi.fn(async () => {}),
      resumeTask: vi.fn(async () => true),
      sendMessage: vi.fn(async () => {}),
      respondToInputRequest: vi.fn(async () => {}),
      failTask: vi.fn(),
      teamOrchestrator: { tickRun: vi.fn(), cancelRun: vi.fn() },
    };
    managed = new ManagedSessionService(db, daemon);
    bots = new BotCoordinatorService(db, managed);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    manager.close();
    if (previousUserDataDir === undefined) delete process.env.COWORK_USER_DATA_DIR;
    else process.env.COWORK_USER_DATA_DIR = previousUserDataDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createFixture() {
    const workspaceId = "bot-workspace";
    const workspacePath = path.join(tmpDir, workspaceId);
    fs.mkdirSync(workspacePath, { recursive: true });
    db.prepare(
      "INSERT INTO workspaces (id, name, path, created_at, permissions) VALUES (?, ?, ?, ?, ?)",
    ).run(
      workspaceId,
      "Bots",
      workspacePath,
      Date.now(),
      JSON.stringify({ read: true, write: true, delete: true, network: true, shell: true }),
    );
    const environment = managed.createEnvironment({
      name: "Bot computer",
      config: { workspaceId, enableShell: true },
    });
    const created = managed.createAgent({
      name: "Research Bot",
      description: "Investigates durable bot tests",
      systemPrompt: "You are a careful research bot.",
      executionMode: "solo",
      metadata: { studio: { defaultEnvironmentId: environment.id } },
    });
    return { environment, agent: created.agent };
  }

  it("creates exactly one canonical chat under concurrent requests", async () => {
    const fixture = createFixture();
    const [first, second] = await Promise.all([
      bots.ensureCanonicalSession({ agentId: fixture.agent.id }),
      bots.ensureCanonicalSession({ agentId: fixture.agent.id }),
    ]);

    expect(first.id).toBe(second.id);
    expect(first.surface).toBe("bot_chat");
    expect(tasks.findById(first.backingTaskId!)?.source).toBe("managed_agent_panel");
    expect(daemon.startTask).toHaveBeenCalledTimes(1);
    expect(bots.getBinding(fixture.agent.id).canonicalSessionId).toBe(first.id);
  });

  it("delivers idempotent messages into the canonical managed session", async () => {
    const fixture = createFixture();
    const request = {
      fromAgentId: "user",
      toAgentId: fixture.agent.id,
      body: "Prepare the morning brief",
      idempotencyKey: "brief-2026-08-20",
    } as const;

    const first = await bots.sendMessage(request);
    const second = await bots.sendMessage(request);

    expect(first.id).toBe(second.id);
    expect(first.status).toBe("completed");
    expect(daemon.sendMessage).not.toHaveBeenCalled();
    expect(daemon.startTask).toHaveBeenCalledTimes(1);
    const session = managed.getSession(bots.getBinding(fixture.agent.id).canonicalSessionId!);
    expect(tasks.findById(session!.backingTaskId!)?.prompt).toContain("Prepare the morning brief");
  });

  it("recovers stale claimed messages for at-least-once redelivery", () => {
    const fixture = createFixture();
    const messages = new BotMessageRepository(db);
    const envelope = messages.create({
      fromAgentId: "user",
      toAgentId: fixture.agent.id,
      kind: "request",
      contentType: "text/plain",
      body: "Recover me",
      maxAttempts: 3,
    });
    expect(messages.claim(envelope.id)?.status).toBe("claimed");
    expect(messages.recoverStaleClaims(Date.now() + 61_000)).toBe(1);
    expect(messages.findById(envelope.id)?.status).toBe("queued");
  });

  it("rejects unbounded message bodies and invalid TTL values", async () => {
    const fixture = createFixture();
    await expect(
      bots.sendMessage({
        fromAgentId: "user",
        toAgentId: fixture.agent.id,
        body: "x".repeat(256 * 1024 + 1),
      }),
    ).rejects.toThrow("256 KiB");
    await expect(
      bots.sendMessage({
        fromAgentId: "user",
        toAgentId: fixture.agent.id,
        body: "test",
        ttlMs: Number.POSITIVE_INFINITY,
      }),
    ).rejects.toThrow("finite");
  });

  it("rotates to the selected environment instead of silently using the old session", async () => {
    const fixture = createFixture();
    await bots.sendMessage({ fromAgentId: "user", toAgentId: fixture.agent.id, body: "First" });
    const first = managed.getSession(bots.getBinding(fixture.agent.id).canonicalSessionId!)!;
    const secondEnvironment = managed.createEnvironment({
      name: "Second computer",
      config: { workspaceId: first.workspaceId, enableShell: true },
    });
    bots.updateBinding(fixture.agent.id, { defaultEnvironmentId: secondEnvironment.id });

    await bots.sendMessage({ fromAgentId: "user", toAgentId: fixture.agent.id, body: "Second" });
    const second = managed.getSession(bots.getBinding(fixture.agent.id).canonicalSessionId!)!;

    expect(second.environmentId).toBe(secondEnvironment.id);
    expect(second.resumedFromSessionId).toBe(first.id);
  });

  it("continues delivery to an already-running canonical session after suspension", async () => {
    const fixture = createFixture();
    await bots.sendMessage({ fromAgentId: "user", toAgentId: fixture.agent.id, body: "First" });
    const sessionId = bots.getBinding(fixture.agent.id).canonicalSessionId;
    db.prepare("UPDATE managed_agents SET status = 'suspended' WHERE id = ?").run(fixture.agent.id);

    await bots.sendMessage({ fromAgentId: "user", toAgentId: fixture.agent.id, body: "Continue" });

    expect(bots.getBinding(fixture.agent.id).canonicalSessionId).toBe(sessionId);
    expect(daemon.sendMessage).toHaveBeenCalledTimes(1);
  });

  it("returns the newest event window for long-running bot conversations", async () => {
    const fixture = createFixture();
    const session = await bots.ensureCanonicalSession({ agentId: fixture.agent.id });
    const insert = db.prepare(
      `INSERT INTO managed_session_events
       (id, session_id, seq, timestamp, type, payload_json, created_at)
       VALUES (?, ?, ?, ?, 'assistant.message', ?, ?)`,
    );
    for (let seq = 2; seq <= 511; seq += 1) {
      insert.run(`event-${seq}`, session.id, seq, Date.now(), JSON.stringify({ message: `event ${seq}` }), Date.now());
    }

    const events = bots.getConversation(fixture.agent.id, 500)[0].events;
    expect(events).toHaveLength(500);
    expect(events[0].seq).toBe(12);
    expect(events.at(-1)?.seq).toBe(511);
  });

  it("does not allow renderer-editable binding fields to replace runtime ownership", async () => {
    const fixture = createFixture();
    const session = await bots.ensureCanonicalSession({ agentId: fixture.agent.id });
    bots.updateBinding(fixture.agent.id, {
      canonicalSessionId: "other-session",
      runtimeKind: "cloud",
      pinned: true,
    } as Any);

    const binding = bots.getBinding(fixture.agent.id);
    expect(binding.canonicalSessionId).toBe(session.id);
    expect(binding.runtimeKind).toBe("local");
    expect(binding.pinned).toBe(true);
  });

  it("rotates a completed physical session while preserving conversation lineage", async () => {
    const fixture = createFixture();
    const first = await bots.ensureCanonicalSession({ agentId: fixture.agent.id });
    tasks.update(first.backingTaskId!, { status: "completed", completedAt: Date.now() });

    await bots.sendMessage({
      fromAgentId: "user",
      toAgentId: fixture.agent.id,
      body: "Continue with a fresh run",
    });

    const binding = bots.getBinding(fixture.agent.id);
    expect(binding.canonicalSessionId).not.toBe(first.id);
    const successor = managed.getSession(binding.canonicalSessionId!);
    expect(successor?.resumedFromSessionId).toBe(first.id);
    expect(bots.getConversation(fixture.agent.id).map((entry) => entry.session.id)).toEqual([
      first.id,
      successor?.id,
    ]);
  });

  it("bounds room runs and preserves superseded replies as late results", () => {
    const rooms = new BotRoomService(db);
    const room = rooms.create({
      name: "Engineering staff",
      memberAgentIds: ["lead", "implementer", "reviewer"],
      maxMessages: 2,
    });
    const userMessage = rooms.appendUserMessage(room.id, "Prepare the release");
    const run = rooms.startRun(room.id, "test-coordinator");
    expect(rooms.get(room.id)?.currentRound).toBe(1);
    const first = rooms.appendBotMessage({
      roomId: room.id,
      runId: run.runId,
      epoch: run.epoch,
      fromAgentId: "lead",
      body: "Implementer, prepare the patch.",
    });
    rooms.markSeen(room.id, "reviewer", first.seq);
    rooms.appendBotMessage({
      roomId: room.id,
      runId: run.runId,
      epoch: run.epoch,
      fromAgentId: "implementer",
      body: "(pass)",
    });

    expect(() =>
      rooms.appendBotMessage({
        roomId: room.id,
        runId: run.runId,
        epoch: run.epoch,
        fromAgentId: "reviewer",
        body: "Patch reviewed",
      }),
    ).toThrow("message limit reached");

    rooms.appendUserMessage(room.id, "Prioritize the security fix instead");
    const late = rooms.appendBotMessage({
      roomId: room.id,
      runId: run.runId,
      epoch: run.epoch,
      fromAgentId: "implementer",
      body: "The original patch finished late",
    });

    expect(userMessage.epoch).toBe(1);
    expect(late.status).toBe("late");
    expect(
      rooms.listMembers(room.id).find((member) => member.agentId === "reviewer")?.lastSeenSeq,
    ).toBe(first.seq);
  });

  it("enforces room round bounds and validates configured members", () => {
    const validatingRooms = new BotRoomService(db, (agentId) => agentId !== "missing");
    expect(() =>
      validatingRooms.create({ name: "Invalid", memberAgentIds: ["lead", "missing"] }),
    ).toThrow("members not found");
    const room = validatingRooms.create({
      name: "Bounded",
      memberAgentIds: ["lead", "reviewer"],
      maxRounds: 2,
    });
    validatingRooms.appendUserMessage(room.id, "Begin");
    const run = validatingRooms.startRun(room.id, "coordinator");
    expect(validatingRooms.advanceRound(room.id, run.runId)).toBe(2);
    expect(validatingRooms.advanceRound(room.id, run.runId)).toBeUndefined();
  });

  it("runs a user-operable room and records each bot response", async () => {
    const rooms = new BotRoomService(db);
    const room = rooms.create({
      name: "Release room",
      memberAgentIds: ["lead", "reviewer"],
      maxRounds: 1,
      maxMessages: 2,
    });
    const fakeBots = {
      getBinding: vi.fn((agentId: string) => ({
        agentId,
        defaultEnvironmentId: "room-env",
        runtimeKind: "local",
        pinned: false,
        sortOrder: 0,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })),
    };
    let sessionCounter = 0;
    const fakeManaged = {
      getEnvironment: vi.fn(() => ({ id: "room-env", status: "active" })),
      createSession: vi.fn(async (input: Any) => ({
        id: `room-session-${++sessionCounter}`,
        agentId: input.agentId,
        agentVersion: 1,
        environmentId: input.environmentId,
        title: input.title,
        status: "completed",
        surface: "bot_group",
        workspaceId: "bot-workspace",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })),
      listLatestSessionEvents: vi.fn((sessionId: string) => [
        {
          id: `reply-${sessionId}`,
          sessionId,
          seq: 1,
          timestamp: Date.now(),
          type: "assistant.message",
          payload: { message: `Response from ${sessionId}` },
        },
      ]),
      getSession: vi.fn(() => undefined),
    };
    const coordinator = new BotRoomCoordinatorService(
      rooms,
      fakeBots as Any,
      fakeManaged as Any,
    );

    const receipt = coordinator.sendUserMessage(room.id, "Prepare the release");
    await coordinator.waitForRun(receipt.runId);

    const messages = rooms.listMessages(room.id);
    expect(messages.filter((entry) => entry.fromAgentId)).toHaveLength(2);
    expect(rooms.get(room.id)?.activeRunId).toBeUndefined();
  });
});
