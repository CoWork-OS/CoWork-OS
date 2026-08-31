import fs from "fs/promises";
import path from "path";
import { DailyLogService } from "./DailyLogService";
import { DailyLogSummarizer } from "./DailyLogSummarizer";
import { MemoryService } from "./MemoryService";
import { CuratedMemoryService } from "./CuratedMemoryService";
import type { MemorySearchResult } from "../database/repositories";
import type { MarkdownMemoryReadGuard } from "./MarkdownMemoryIndexService";

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

type FilesystemWriteGuard = (candidatePath: string) => boolean;

function guardAllows(
  guard: ((candidatePath: string) => boolean) | undefined,
  candidatePath: string,
) {
  if (!guard) return true;
  try {
    return guard(candidatePath) === true;
  } catch {
    return false;
  }
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

function scoreTopicMatch(query: string, title: string, content: string): number {
  const tokens = String(query || "")
    .toLowerCase()
    .match(/[a-z0-9]{3,}/g);
  if (!tokens || tokens.length === 0) return 0;
  const haystack = `${title}\n${content}`.toLowerCase();
  let score = 0;
  for (const token of tokens.slice(0, 12)) {
    if (haystack.includes(token)) score += 1;
  }
  return score;
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

async function searchPromptRecallSafe(
  workspaceId: string,
  taskPrompt: string,
  limit: number,
): Promise<MemorySearchResult[]> {
  try {
    return await MemoryService.searchForPromptRecallAsync(workspaceId, taskPrompt, limit);
  } catch {
    return [];
  }
}

export class LayeredMemoryIndexService {
  static resolveMemoryIndexPath(workspacePath: string): string {
    return memoryIndexPath(workspacePath);
  }

  static resolveLockPath(workspacePath: string): string {
    return lockPath(workspacePath);
  }

  static async ensureLayout(
    workspacePath: string,
    writeGuard?: FilesystemWriteGuard,
  ): Promise<boolean> {
    const layoutPaths = [
      memoryRoot(workspacePath),
      topicsDir(workspacePath),
      locksDir(workspacePath),
    ];
    if (!layoutPaths.every((candidatePath) => guardAllows(writeGuard, candidatePath))) {
      return false;
    }
    await Promise.all([
      fs.mkdir(memoryRoot(workspacePath), { recursive: true }),
      fs.mkdir(topicsDir(workspacePath), { recursive: true }),
      fs.mkdir(locksDir(workspacePath), { recursive: true }),
    ]);
    return true;
  }

  static async refreshIndex(params: {
    workspaceId: string;
    workspacePath: string;
    taskPrompt: string;
    topicLimit?: number;
    readGuard?: MarkdownMemoryReadGuard;
    writeGuard?: FilesystemWriteGuard;
  }): Promise<LayeredMemorySnapshot> {
    const topicLimit = Math.max(1, params.topicLimit ?? 4);
    const canWriteLayout = await this.ensureLayout(params.workspacePath, params.writeGuard);

    const memoryHits = (
      await searchPromptRecallSafe(params.workspaceId, params.taskPrompt, topicLimit)
    )
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
      params.readGuard,
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
        items.findIndex(
          (candidate) => candidate.title === entry.title && candidate.content === entry.content,
        ) === index,
    );

    for (const topic of topics) {
      if (!canWriteLayout || !guardAllows(params.writeGuard, topic.path)) continue;
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

    const recentDays = await DailyLogService.listRecentDays(
      params.workspacePath,
      5,
      params.readGuard,
    );
    const recentSummaryCount = DailyLogSummarizer.countRecentSummaries(
      params.workspacePath,
      7,
      params.readGuard,
    );
    const curatedContext = CuratedMemoryService.getPromptEntries(params.workspaceId, 5)
      .map((entry) => `- [${entry.target}/${entry.kind}] ${entry.content}`)
      .join("\n");
    const archiveContext = (await searchPromptRecallSafe(params.workspaceId, params.taskPrompt, 3))
      .map((entry) => `- [${entry.type}] ${entry.snippet}`)
      .join("\n");
    const memoryContext = [curatedContext, archiveContext].filter(Boolean).join("\n");

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
        ? topics.map(
            (topic) => `- ${path.relative(params.workspacePath, topic.path)} | ${topic.source}`,
          )
        : ["- No topic files generated yet."]),
      "",
      "## Active Recall",
      memoryContext || "No high-signal memory context available.",
      "",
    ].join("\n");

    const indexPath = memoryIndexPath(params.workspacePath);
    if (canWriteLayout && guardAllows(params.writeGuard, indexPath)) {
      await fs.writeFile(indexPath, `${indexParts.trim()}\n`, "utf8");
    }

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
    readGuard?: MarkdownMemoryReadGuard;
    writeGuard?: FilesystemWriteGuard;
  }): Promise<LayeredMemoryTopicSnippet[]> {
    const topicLimit = Math.max(1, params.limit ?? 3);
    await this.ensureLayout(params.workspacePath, params.writeGuard);
    const topicDirectory = topicsDir(params.workspacePath);
    if (!guardAllows(params.readGuard, topicDirectory)) return [];
    const names = await fs.readdir(topicDirectory).catch(() => []);
    const topics: Array<LayeredMemoryTopicSnippet & { score: number }> = [];

    for (const name of names) {
      if (!name.endsWith(".md")) continue;
      const topicPathAbs = path.join(topicDirectory, name);
      if (!guardAllows(params.readGuard, topicPathAbs)) continue;
      const raw = await fs.readFile(topicPathAbs, "utf8").catch(() => "");
      if (!raw) continue;
      const lines = raw.split("\n");
      const title =
        lines
          .find((line) => line.startsWith("# "))
          ?.replace(/^#\s+/, "")
          .trim() || name;
      const sourceLine = lines.find((line) => line.startsWith("source:")) || "";
      const content = summarizeSnippet(raw.replace(/^# .*\n?/m, ""));
      const score = scoreTopicMatch(params.query, title, content);
      if (score <= 0) continue;
      topics.push({
        id: name,
        title,
        path: topicPathAbs,
        content,
        source: sourceLine.includes("markdown") ? "markdown" : "memory",
        score,
      });
    }

    topics.sort((a, b) => b.score - a.score || a.title.localeCompare(b.title));
    return topics.slice(0, topicLimit).map(({ score: _score, ...topic }) => topic);
  }
}
