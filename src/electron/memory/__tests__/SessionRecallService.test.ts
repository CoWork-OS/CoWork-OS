import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TranscriptStore } from "../TranscriptStore";
import { SessionRecallService } from "../SessionRecallService";

const createdDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-session-recall-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
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
});
