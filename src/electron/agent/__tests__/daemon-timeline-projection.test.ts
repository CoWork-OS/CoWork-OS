import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const runtime = vi.hoisted(() => ({ enabled: false, client: null as unknown }));

vi.mock("electron", () => ({ app: { getPath: vi.fn().mockReturnValue("/tmp") } }));
vi.mock("../../database/async/runtime", () => ({
  getDatabaseClient: vi.fn(async () => runtime.client),
  isTimelineProjectionWorkerEnabled: vi.fn(() => runtime.enabled),
}));

import { AgentDaemon } from "../daemon";
import { DatabaseManager } from "../../database/schema";
import { TaskEventRepository, TaskStore, WorkspaceStore } from "../../database/repositories";
import { TimelineProjectionOutboxRepository } from "../../database/TimelineProjectionOutboxRepository";

// DB3: which backend the daemon uses for timeline projections, fixed per run.
describe("AgentDaemon timeline projection backend", () => {
  let tmpDir: string;
  let manager: DatabaseManager;
  let taskId: string;
  let daemon: Any;
  let projections: {
    protocol: ReturnType<typeof vi.fn>;
    contracts: ReturnType<typeof vi.fn>;
    progress: ReturnType<typeof vi.fn>;
    reliabilityStop: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-daemon-timeline-"));
    process.env.COWORK_USER_DATA_DIR = tmpDir;
    manager = new DatabaseManager();
    const db = manager.getDatabase();
    const workspace = new WorkspaceStore(db).create("ws", path.join(tmpDir, "ws"), {
      read: true,
      write: true,
      delete: false,
      network: false,
      shell: false,
    });
    taskId = new TaskStore(db).create({
      title: "t",
      prompt: "p",
      status: "executing",
      workspaceId: workspace.id,
    }).id;
    projections = {
      protocol: vi.fn(),
      contracts: vi.fn(),
      progress: vi.fn(),
      reliabilityStop: vi.fn(),
    };
    daemon = Object.assign(Object.create(AgentDaemon.prototype), {
      dbManager: manager,
      eventRepo: new TaskEventRepository(db),
      taskRepo: new TaskStore(db),
      workSessionProtocolService: {
        recordTaskEvent: projections.protocol,
        getReliabilityService: () => ({ stop: projections.reliabilityStop }),
      },
      workSessionContractService: { recordTaskEvent: projections.contracts },
      sessionProgressService: { updateFromEvent: projections.progress },
      maybeMaterializeMailComposeInlineFrame: vi.fn(),
      logActivityForEvent: vi.fn(),
      emitTaskEvent: vi.fn(),
      maybeEmitTeamThought: vi.fn(),
      captureToMemory: vi.fn(async () => undefined),
    });
  });

  afterEach(async () => {
    await daemon.timelineWriter?.stop(100);
    await daemon.timelineProjection?.stop(100);
    runtime.enabled = false;
    runtime.client = null;
    manager.close();
    delete process.env.COWORK_USER_DATA_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const event = (id: string, seq: number) => ({
    id,
    eventId: id,
    taskId,
    timestamp: Date.now(),
    type: "timeline_step_updated",
    schemaVersion: 2,
    seq,
    payload: { message: "step", legacyType: "assistant_message" },
    legacyType: "assistant_message",
  });

  const outboxCount = () => new TimelineProjectionOutboxRepository(manager.getDatabase()).count();

  it("projects inline on the host when the worker domain is off", async () => {
    await daemon.configureTimelineProjection();
    daemon.persistTimelineEvent(event("e1", 1));

    expect(projections.protocol).toHaveBeenCalledTimes(1);
    expect(projections.contracts).toHaveBeenCalledTimes(1);
    expect(projections.progress).toHaveBeenCalledTimes(1);
    expect(outboxCount()).toBe(0);
    await expect(daemon.flushTimelineProjections(taskId)).resolves.toBeUndefined();
  });

  const startWorkerBackend = async (state = "ready") => {
    const execute = vi.fn(async (command: string) => {
      if (command === "timeline.drainProjectionOutbox") {
        return { processed: [], failures: [], exhausted: true };
      }
      if (command === "timeline.applyWrites") return { insertedEventIds: [] };
      return { ok: true };
    });
    runtime.enabled = true;
    runtime.client = { execute, getState: () => state };
    await daemon.configureTimelineProjection();
    return execute;
  };

  const eventRows = () =>
    manager.getDatabase().prepare("SELECT id FROM task_events WHERE task_id = ?").all(taskId);

  it("hands the event to the worker and shows it to reads before it is committed", async () => {
    const execute = await startWorkerBackend();
    expect(projections.reliabilityStop).toHaveBeenCalledTimes(1);

    daemon.persistTimelineEvent(event("e1", 1));

    expect(projections.protocol).not.toHaveBeenCalled();
    expect(projections.contracts).not.toHaveBeenCalled();
    expect(projections.progress).not.toHaveBeenCalled();
    expect(daemon.emitTaskEvent).toHaveBeenCalledTimes(1);
    expect(eventRows()).toEqual([]);
    expect(daemon.timelineWriter.pendingCount()).toBe(1);
    expect(daemon.timelineProjection.pendingCount(taskId)).toBe(1);

    // A host read of the task's events includes the pending row without committing it
    // (DB6): reads never write, so they never wait on another process's lock.
    expect(daemon.eventRepo.findByTaskId(taskId).map((row: { id: string }) => row.id)).toEqual([
      "e1",
    ]);
    expect(eventRows()).toEqual([]);
    expect(daemon.timelineWriter.pendingCount()).toBe(1);

    daemon.persistTimelineEvent(event("e2", 2));
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect(execute.mock.calls.map(([command]) => command)).toContain("timeline.applyWrites");
  });

  it("hands milestone events to the worker and lets boundaries await the commit", async () => {
    const execute = await startWorkerBackend();
    daemon.persistTimelineEvent({ ...event("done", 1), legacyType: "task_completed" });
    // Not committed on the host (DB6 slice C2): a foreign write lock cannot stall it.
    expect(eventRows()).toEqual([]);
    expect(daemon.timelineWriter.pendingCount()).toBe(1);

    let committed = false;
    const waiting = daemon.timelineRowsCommitted(taskId).then(() => {
      committed = true;
    });
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    await waiting;
    expect(committed).toBe(true);
    expect(execute.mock.calls.map(([command]) => command)).toContain("timeline.applyWrites");
    expect(daemon.timelineWriter.pendingCount()).toBe(0);
  });

  it("waits for a ready but blocked worker instead of committing on the host", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const execute = await startWorkerBackend();
      // The worker accepts the batch but does not finish it, as under another process's
      // write lock.
      execute.mockImplementation(((command: string) =>
        command === "timeline.applyWrites"
          ? new Promise(() => {})
          : Promise.resolve({ processed: [], failures: [], exhausted: true })) as never);
      daemon.persistTimelineEvent({ ...event("done", 1), legacyType: "task_completed" });
      let committed = false;
      void daemon.timelineRowsCommitted(taskId).then(() => {
        committed = true;
      });
      await vi.advanceTimersByTimeAsync(12_000);
      expect(committed).toBe(false);
      expect(eventRows()).toEqual([]);

      // Once the worker is no longer ready, the host takes the rows at the next timeout.
      runtime.client.getState = () => "failed";
      await vi.advanceTimersByTimeAsync(5_000);
      expect(committed).toBe(true);
      expect(eventRows()).toEqual([{ id: "done" }]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("commits on the host while the worker is not ready", async () => {
    await startWorkerBackend("restarting");
    daemon.persistTimelineEvent(event("e1", 1));
    expect(eventRows()).toEqual([{ id: "e1" }]);
    expect(daemon.timelineWriter.pendingCount()).toBe(0);
  });

  it("repairs entries left by a worker run when this run projects on the host", async () => {
    const db = manager.getDatabase();
    const stored = new TaskEventRepository(db).create(event("left-behind", 1));
    new TimelineProjectionOutboxRepository(db).enqueue(stored.id, stored.taskId);

    await daemon.configureTimelineProjection();

    expect(projections.protocol).toHaveBeenCalledWith(
      taskId,
      expect.objectContaining({ id: "left-behind" }),
    );
    expect(projections.progress).toHaveBeenCalledTimes(1);
    expect(outboxCount()).toBe(0);
  });
});
