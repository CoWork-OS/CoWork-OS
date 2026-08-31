import fs from "fs/promises";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CuratedMemoryService } from "../CuratedMemoryService";
import { DailyLogService } from "../DailyLogService";
import { DailyLogSummarizer } from "../DailyLogSummarizer";
import { LayeredMemoryIndexService } from "../LayeredMemoryIndexService";
import { MemoryService } from "../MemoryService";

const createdDirs: string[] = [];

async function createWorkspace(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "cowork-layered-memory-"));
  createdDirs.push(dir);
  return dir;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    createdDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

describe("LayeredMemoryIndexService", () => {
  it("writes MEMORY.md and topic files from existing memory sources", async () => {
    const workspacePath = await createWorkspace();

    vi.spyOn(MemoryService, "searchForPromptRecallAsync").mockResolvedValue([
      {
        id: "mem-1",
        snippet: "Remember to keep the prompt stack deterministic.",
        type: "summary",
        relevanceScore: 0.9,
        createdAt: Date.now(),
        source: "memory",
      },
    ] as Any);
    vi.spyOn(MemoryService, "searchWorkspaceMarkdown").mockReturnValue([
      {
        id: "md-1",
        snippet: "Workspace conventions live in docs/agent.md.",
        type: "summary",
        relevanceScore: 0.8,
        createdAt: Date.now(),
        source: "markdown",
        path: "docs/agent.md",
      },
    ] as Any);
    vi.spyOn(CuratedMemoryService, "getPromptEntries").mockReturnValue([
      {
        id: "curated-1",
        workspaceId: "workspace-1",
        target: "workspace",
        kind: "workflow_rule",
        content: "Keep prompts deterministic.",
        confidence: 0.9,
        status: "active",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      },
    ] as Any);
    vi.spyOn(DailyLogService, "listRecentDays").mockResolvedValue(["2026-03-31"]);
    vi.spyOn(DailyLogSummarizer, "countRecentSummaries").mockReturnValue(2);

    const snapshot = await LayeredMemoryIndexService.refreshIndex({
      workspaceId: "workspace-1",
      workspacePath,
      taskPrompt: "prompt stack",
    });

    const memoryIndex = await fs.readFile(snapshot.indexPath, "utf8");
    expect(memoryIndex).toContain("# MEMORY");
    expect(memoryIndex).toContain("Topic files available: 2");
    expect(snapshot.topics).toHaveLength(2);

    const topicFile = await fs.readFile(snapshot.topics[0]!.path, "utf8");
    expect(topicFile).toContain(snapshot.topics[0]!.title);
  });

  it("reads existing topic files without rebuilding them", async () => {
    const workspacePath = await createWorkspace();
    const topicsDir = path.join(workspacePath, ".cowork", "memory", "topics");
    await fs.mkdir(topicsDir, { recursive: true });
    const topicPath = path.join(topicsDir, "prompts.md");
    await fs.writeFile(
      topicPath,
      "# Prompt Patterns\n\nsource: memory\n\ntopicId: mem-1\n\nKeep prompts deterministic.\n",
      "utf8",
    );

    const refreshSpy = vi.spyOn(LayeredMemoryIndexService, "refreshIndex");
    const topics = await LayeredMemoryIndexService.loadRelevantTopicSnippets({
      workspaceId: "workspace-1",
      workspacePath,
      query: "deterministic prompts",
      limit: 3,
    });

    expect(refreshSpy).not.toHaveBeenCalled();
    expect(topics).toHaveLength(1);
    expect(topics[0]?.title).toBe("Prompt Patterns");
  });
});
