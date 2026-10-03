import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptStore } from "../TranscriptStore";
import { MAX_CHECKPOINTS_PER_QUERY, SessionRecallService } from "../SessionRecallService";

const createdDirs: string[] = [];
const originalCheckpointLockRoot = process.env.COWORK_CHECKPOINT_LOCK_ROOT;

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-session-recall-"));
  const lockRoot = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-session-recall-locks-"));
  createdDirs.push(dir, lockRoot);
  process.env.COWORK_CHECKPOINT_LOCK_ROOT = lockRoot;
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalCheckpointLockRoot === undefined) {
    delete process.env.COWORK_CHECKPOINT_LOCK_ROOT;
  } else {
    process.env.COWORK_CHECKPOINT_LOCK_ROOT = originalCheckpointLockRoot;
  }
  await Promise.all(
    createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("SessionRecallService", () => {
  it("searches transcript spans and checkpoints", async () => {
    const workspacePath = await createWorkspace();

    await TranscriptStore.appendEvent(workspacePath, {
      id: "event-1",
      taskId: "task-1",
      timestamp: Date.now(),
      type: "assistant_message",
      payload: { message: "Curated memory is ready" },
      schemaVersion: 2,
    });

    await TranscriptStore.writeCheckpoint(workspacePath, "task-1", {
      explicitChatSummaryBlock: "Checkpoint summary about curated memory",
      timestamp: Date.now(),
    });

    const results = await SessionRecallService.search({
      workspacePath,
      query: "curated memory",
      includeCheckpoints: true,
      limit: 5,
    });

    expect(results.length).toBeGreaterThan(0);
    expect(results.some((result) => result.type === "assistant_message")).toBe(true);
  });

  it("returns the newest transcript hit across tasks even when readdir order is stale", async () => {
    const workspacePath = await createWorkspace();

    await TranscriptStore.appendEvent(workspacePath, {
      id: "event-old",
      taskId: "task-old",
      timestamp: 100,
      type: "assistant_message",
      payload: { message: "deploy complete" },
      schemaVersion: 2,
    });
    await TranscriptStore.appendEvent(workspacePath, {
      id: "event-new",
      taskId: "task-new",
      timestamp: 200,
      type: "assistant_message",
      payload: { message: "deploy complete" },
      schemaVersion: 2,
    });

    const realReaddir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (dir: fs.PathLike) => {
      if (String(dir).endsWith(`${path.sep}spans`)) {
        return ["task-old.jsonl", "task-new.jsonl"] as Any;
      }
      return realReaddir(dir);
    });

    const results = await SessionRecallService.search({
      workspacePath,
      query: "deploy complete",
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.taskId).toBe("task-new");
  });

  it("returns the newest checkpoint hit across tasks even when readdir order is stale", async () => {
    const workspacePath = await createWorkspace();

    await TranscriptStore.writeCheckpoint(workspacePath, "task-old", {
      explicitChatSummaryBlock: "checkpoint deploy complete",
      timestamp: 100,
    });
    await TranscriptStore.writeCheckpoint(workspacePath, "task-new", {
      explicitChatSummaryBlock: "checkpoint deploy complete",
      timestamp: 200,
    });

    const realReaddir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (dir: fs.PathLike) => {
      if (String(dir).endsWith(`${path.sep}checkpoints`)) {
        return ["task-old.json", "task-new.json"] as Any;
      }
      return realReaddir(dir);
    });

    const results = await SessionRecallService.search({
      workspacePath,
      query: "checkpoint deploy complete",
      includeCheckpoints: true,
      limit: 1,
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.taskId).toBe("task-new");
    expect(results[0]?.type).toBe("checkpoint");
  });

  it("ignores previous generations and unsigned checkpoint files", async () => {
    const workspacePath = await createWorkspace();
    await TranscriptStore.writeCheckpoint(workspacePath, "task-signed", {
      explicitChatSummaryBlock: "first rollout plan",
      timestamp: 100,
    });
    await TranscriptStore.writeCheckpoint(workspacePath, "task-signed", {
      explicitChatSummaryBlock: "second rollout plan",
      timestamp: 200,
    });
    const dir = path.join(workspacePath, ".cowork", "memory", "transcripts", "checkpoints");
    await fs.writeFile(
      path.join(dir, "task-forged.json"),
      JSON.stringify({ explicitChatSummaryBlock: "forged rollout plan", timestamp: 300 }),
    );

    const results = await SessionRecallService.search({
      workspacePath,
      query: "rollout plan",
      includeCheckpoints: true,
      limit: 10,
    });

    expect(results.map((result) => result.taskId)).toEqual(["task-signed"]);
    expect(results[0]?.snippet).toContain("second rollout plan");
  });

  it("reads only the most recent checkpoints for a workspace-wide query", async () => {
    const workspacePath = await createWorkspace();
    const dir = path.join(workspacePath, ".cowork", "memory", "transcripts", "checkpoints");
    for (let index = 0; index < MAX_CHECKPOINTS_PER_QUERY + 5; index += 1) {
      const taskId = `task-${String(index).padStart(3, "0")}`;
      await TranscriptStore.writeCheckpoint(workspacePath, taskId, {
        explicitChatSummaryBlock: "capped search",
        timestamp: 1_000 + index,
      });
      const mtime = new Date(Date.now() - (MAX_CHECKPOINTS_PER_QUERY + 5 - index) * 60_000);
      await fs.utimes(path.join(dir, `${taskId}.json`), mtime, mtime);
    }
    const loadSpy = vi.spyOn(TranscriptStore, "loadCheckpoint");

    const results = await SessionRecallService.search({
      workspacePath,
      query: "capped search",
      includeCheckpoints: true,
      limit: 100,
    });

    expect(loadSpy).toHaveBeenCalledTimes(MAX_CHECKPOINTS_PER_QUERY);
    expect(results).toHaveLength(MAX_CHECKPOINTS_PER_QUERY);
    expect(results.some((result) => result.taskId === "task-000")).toBe(false);
  });
});
