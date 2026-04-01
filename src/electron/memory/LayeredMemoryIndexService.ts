import fs from "fs/promises";
import path from "path";
import { DailyLogService } from "./DailyLogService";
import { DailyLogSummarizer } from "./DailyLogSummarizer";
import { MemoryService } from "./MemoryService";
import type { MemorySearchResult } from "../database/repositories";

export interface LayeredMemoryTopicSnippet {
  id: string;
  title: string;
  path: string;
  content: string;
  source: "memory" | "markdown";
}

export interface LayeredMemorySnapshot {
  indexPath: string;
  indexContent: string;
  topics: LayeredMemoryTopicSnippet[];
  lockPath: string;
}

function memoryRoot(workspacePath: string): string {
  return path.join(workspacePath, ".cowork", "memory");
}

function topicsDir(workspacePath: string): string {
  return path.join(memoryRoot(workspacePath), "topics");
}

function locksDir(workspacePath: string): string {
  return path.join(memoryRoot(workspacePath), "locks");
}

function memoryIndexPath(workspacePath: string): string {
  return path.join(memoryRoot(workspacePath), "MEMORY.md");
}

function lockPath(workspacePath: string): string {
  return path.join(locksDir(workspacePath), "consolidation.lock");
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function summarizeSnippet(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/\s+/g, " ").trim().slice(0, 500);
}

function topicTitleFromResult(entry: MemorySearchResult, fallback: string): string {
  if (entry.source === "markdown") {
    return entry.path || fallback;
  }
  return fallback;
}

function topicPath(workspacePath: string, title: string): string {
  const slug = slugify(title || "topic") || "topic";
  return path.join(topicsDir(workspacePath), `${slug}.md`);
}

export class LayeredMemoryIndexService {
  static resolveMemoryIndexPath(workspacePath: string): string {
    return memoryIndexPath(workspacePath);
  }

  static resolveLockPath(workspacePath: string): string {
    return lockPath(workspacePath);
  }

  static async ensureLayout(workspacePath: string): Promise<void> {
    await Promise.all([
      fs.mkdir(memoryRoot(workspacePath), { recursive: true }),
      fs.mkdir(topicsDir(workspacePath), { recursive: true }),
      fs.mkdir(locksDir(workspacePath), { recursive: true }),
    ]);
  }

  static async refreshIndex(params: {
    workspaceId: string;
    workspacePath: string;
    taskPrompt: string;
    topicLimit?: number;
  }): Promise<LayeredMemorySnapshot> {
    const topicLimit = Math.max(1, params.topicLimit ?? 4);
    await this.ensureLayout(params.workspacePath);

    const memoryHits = MemoryService.searchForPromptRecall(params.workspaceId, params.taskPrompt, topicLimit)
      .slice(0, topicLimit)
      .map((entry, index) => {
        const title = topicTitleFromResult(entry, `memory-${index + 1}`);
        return {
          id: entry.id,
          title,
          path: topicPath(params.workspacePath, title),
          content: summarizeSnippet(entry.snippet),
          source: "memory" as const,
        };
      });

    const markdownHits = MemoryService.searchWorkspaceMarkdown(
      params.workspaceId,
      params.workspacePath,
      params.taskPrompt,
      topicLimit,
    )
      .slice(0, topicLimit)
      .map((entry, index) => {
        const title = topicTitleFromResult(entry, `markdown-${index + 1}`);
        return {
          id: entry.id,
          title,
          path: topicPath(params.workspacePath, title),
          content: summarizeSnippet(entry.snippet),
          source: "markdown" as const,
        };
      });

    const topics = [...memoryHits, ...markdownHits].filter(
      (entry, index, items) =>
        entry.content &&
        items.findIndex((candidate) => candidate.title === entry.title && candidate.content === entry.content) ===
          index,
    );

    for (const topic of topics) {
      const body = [
        `# ${topic.title}`,
        "",
        `source: ${topic.source}`,
        `topicId: ${topic.id}`,
        "",
        topic.content,
        "",
      ].join("\n");
      await fs.writeFile(topic.path, body, "utf8");
    }

    const recentDays = await DailyLogService.listRecentDays(params.workspacePath, 5);
    const recentSummaryCount = DailyLogSummarizer.countRecentSummaries(params.workspacePath, 7);
    const memoryContext = MemoryService.getContextForInjection(params.workspaceId, params.taskPrompt).trim();

    const indexParts = [
      "# MEMORY",
      "",
      "## Index",
      `- Updated: ${new Date().toISOString()}`,
      `- Recent daily logs: ${recentDays.length}`,
      `- Recent summaries: ${recentSummaryCount}`,
      `- Topic files available: ${topics.length}`,
      "",
      "## Topic Files",
      ...(topics.length > 0
        ? topics.map((topic) => `- ${path.relative(params.workspacePath, topic.path)} | ${topic.source}`)
        : ["- No topic files generated yet."]),
      "",
      "## Active Recall",
      memoryContext || "No high-signal memory context available.",
      "",
    ].join("\n");

    const indexPath = memoryIndexPath(params.workspacePath);
    await fs.writeFile(indexPath, `${indexParts.trim()}\n`, "utf8");

    return {
      indexPath,
      indexContent: indexParts.trim(),
      topics,
      lockPath: lockPath(params.workspacePath),
    };
  }

  static async readMemoryIndex(workspacePath: string): Promise<string> {
    try {
      return await fs.readFile(memoryIndexPath(workspacePath), "utf8");
    } catch {
      return "";
    }
  }

  static async loadRelevantTopicSnippets(params: {
    workspaceId: string;
    workspacePath: string;
    query: string;
    limit?: number;
  }): Promise<LayeredMemoryTopicSnippet[]> {
    const topicLimit = Math.max(1, params.limit ?? 3);
    const snapshot = await this.refreshIndex({
      workspaceId: params.workspaceId,
      workspacePath: params.workspacePath,
      taskPrompt: params.query,
      topicLimit,
    });
    return snapshot.topics.slice(0, topicLimit);
  }
}
