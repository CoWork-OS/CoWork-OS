import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONSOLIDATION_LOCK_STALE_MS, MemoryConsolidator } from "../MemoryConsolidator";
import { DailyLogSummarizer } from "../DailyLogSummarizer";
import { LayeredMemoryIndexService } from "../LayeredMemoryIndexService";
import { DurableContextService } from "../DurableContextService";

describe("MemoryConsolidator", () => {
  let workspacePath: string;

  beforeEach(() => {
    workspacePath = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-consolidator-"));
    vi.spyOn(LayeredMemoryIndexService, "refreshIndex").mockResolvedValue({
      indexPath: path.join(workspacePath, ".cowork", "memory", "MEMORY.md"),
      topics: [],
    } as unknown as Awaited<ReturnType<typeof LayeredMemoryIndexService.refreshIndex>>);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(workspacePath, { recursive: true, force: true });
  });

  const spans = (taskId: string) =>
    [
      {
        id: "dce_1",
        kind: "event",
        workspaceId: "ws-1",
        taskId,
        timestamp: Date.now(),
        type: "tool_result",
        role: "tool",
        snippet: 'RAW_SPAN_PAYLOAD_SHOULD_NOT_APPEAR {"json":true}',
        score: 0,
      },
      {
        id: "dce_2",
        kind: "event",
        workspaceId: "ws-1",
        taskId,
        timestamp: Date.now(),
        type: "assistant_message",
        role: "assistant",
        snippet: "hello",
        score: 0,
      },
    ] as Awaited<ReturnType<typeof DurableContextService.recentConversation>>;

  const today = () => new Date().toISOString().slice(0, 10);
  const readSummary = () =>
    fs.readFileSync(DailyLogSummarizer.resolveSummaryPath(workspacePath, today()), "utf8");

  it("appends one compact line per task and never copies raw span payloads", async () => {
    vi.spyOn(DurableContextService, "recentConversation").mockImplementation(async (params) =>
      spans(params.taskId),
    );

    const first = await MemoryConsolidator.run({
      workspaceId: "ws-1",
      workspacePath,
      taskId: "task-a",
      taskPrompt: "Fix the login\nbug in auth",
    });
    expect(first).toMatchObject({ ok: true });
    await MemoryConsolidator.run({
      workspaceId: "ws-1",
      workspacePath,
      taskId: "task-b",
      taskPrompt: "Write release notes",
    });
    await MemoryConsolidator.run({
      workspaceId: "ws-1",
      workspacePath,
      taskId: "task-a",
      taskPrompt: "Fix the login bug again",
    });

    const summary = readSummary();
    expect(summary).not.toContain("RAW_SPAN_PAYLOAD_SHOULD_NOT_APPEAR");
    expect(summary).not.toContain("{");
    expect(summary).toContain("## Task Activity");
    const taskLines = summary.split("\n").filter((line) => line.startsWith("- [task:"));
    expect(taskLines).toHaveLength(2);
    expect(taskLines[0]).toContain("[task:task-b] ");
    expect(taskLines[1]).toContain("[task:task-a] ");
    expect(taskLines[1]).toContain("Fix the login bug again");
    expect(taskLines[1]).toContain("(2 transcript events)");
  });

  it("does not write a boilerplate summary when the task has no transcript events", async () => {
    vi.spyOn(DurableContextService, "recentConversation").mockResolvedValue([]);
    await MemoryConsolidator.run({
      workspaceId: "ws-1",
      workspacePath,
      taskId: "task-a",
      taskPrompt: "Something",
    });
    expect(fs.existsSync(DailyLogSummarizer.resolveSummaryPath(workspacePath, today()))).toBe(
      false,
    );
  });

  it("replaces a legacy raw-span summary and bounds the number of lines", async () => {
    const summaryPath = DailyLogSummarizer.resolveSummaryPath(workspacePath, today());
    fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
    fs.writeFileSync(
      summaryPath,
      '---\nday: x\n---\n\n## Consolidated Signals\n- [tool_result] {"raw":"LEGACY"}\n',
    );
    for (let index = 0; index < 5; index += 1) {
      await DailyLogSummarizer.appendTaskLine(
        workspacePath,
        today(),
        `task-${index}`,
        `line ${index}`,
        undefined,
        3,
      );
    }
    const summary = readSummary();
    expect(summary).not.toContain("LEGACY");
    const taskLines = summary.split("\n").filter((line) => line.startsWith("- [task:"));
    expect(taskLines.map((line) => line.slice(0, 15))).toEqual([
      "- [task:task-2]",
      "- [task:task-3]",
      "- [task:task-4]",
    ]);
  });

  it("skips while a fresh lock is held and removes a stale lock", async () => {
    vi.spyOn(DurableContextService, "recentConversation").mockImplementation(async (params) =>
      spans(params.taskId),
    );
    await LayeredMemoryIndexService.ensureLayout(workspacePath);
    const lockPath = LayeredMemoryIndexService.resolveLockPath(workspacePath);
    fs.writeFileSync(lockPath, "");

    const locked = await MemoryConsolidator.run({
      workspaceId: "ws-1",
      workspacePath,
      taskId: "task-a",
      taskPrompt: "p",
    });
    expect(locked).toMatchObject({ skipped: true, reason: "consolidation_locked" });

    const staleTime = new Date(Date.now() - CONSOLIDATION_LOCK_STALE_MS - 60_000);
    fs.utimesSync(lockPath, staleTime, staleTime);
    const recovered = await MemoryConsolidator.run({
      workspaceId: "ws-1",
      workspacePath,
      taskId: "task-a",
      taskPrompt: "p",
    });
    expect(recovered.skipped).toBeUndefined();
    expect(recovered.ok).toBe(true);
    expect(fs.existsSync(lockPath)).toBe(false);
  });
});
