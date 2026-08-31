import fs from "fs";
import os from "os";
import path from "path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  dreamingRun: vi.fn(),
  loadRecentSpans: vi.fn(),
}));

vi.mock("../DreamingRepository", () => ({
  DreamingRepository: vi.fn().mockImplementation(function DreamingRepository(
    this: { db: unknown },
    db: unknown,
  ) {
    this.db = db;
  }),
}));

vi.mock("../DreamingService", () => ({
  DreamingService: vi
    .fn()
    .mockImplementation(function DreamingService(this: { run: typeof mocks.dreamingRun }) {
      this.run = mocks.dreamingRun;
    }),
}));

vi.mock("../TranscriptStore", () => ({
  TranscriptStore: {
    loadRecentSpans: mocks.loadRecentSpans,
  },
}));

import { MemoryNudgeService } from "../MemoryNudgeService";

function writeFile(p: string, content: string): void {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, content, "utf8");
}

describe("MemoryNudgeService", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cowork-memory-nudge-"));
    MemoryNudgeService.resetForTests();
    mocks.dreamingRun.mockResolvedValue({
      run: { id: "dream-1" },
      candidates: [{ id: "candidate-1" }, { id: "candidate-2" }],
    });
    mocks.loadRecentSpans.mockResolvedValue([]);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("skips quiet workspaces and applies the cooldown", async () => {
    const first = await MemoryNudgeService.maybeRun({
      workspaceId: "ws1",
      workspacePath: tmpDir,
      taskPrompt: "Build the thing",
      db: {} as never,
      now: 1_000,
    });
    const second = await MemoryNudgeService.maybeRun({
      workspaceId: "ws1",
      workspacePath: tmpDir,
      taskPrompt: "remember this preference",
      db: {} as never,
      now: 2_000,
    });

    expect(first).toEqual({ triggered: false, reason: "no_memory_signal" });
    expect(second).toEqual({ triggered: false, reason: "cooldown" });
    expect(mocks.dreamingRun).not.toHaveBeenCalled();
  });

  it("triggers Dreaming when hot memory needs compaction", async () => {
    writeFile(path.join(tmpDir, ".cowork", "USER.md"), `${"A".repeat(1700)}\n`);

    const result = await MemoryNudgeService.maybeRun({
      workspaceId: "ws1",
      workspacePath: tmpDir,
      taskPrompt: "Build the thing",
      db: {} as never,
      now: 1_000,
    });

    expect(result).toEqual({
      triggered: true,
      reason: "memory_pressure",
      dreamingRunId: "dream-1",
      candidateCount: 2,
    });
    expect(mocks.dreamingRun).toHaveBeenCalledWith(
      expect.objectContaining({
        workspaceId: "ws1",
        workspacePath: tmpDir,
        triggerSource: "system",
        instructions: expect.stringContaining(".cowork/USER.md"),
      }),
    );
  });
});
