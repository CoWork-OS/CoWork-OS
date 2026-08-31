/**
 * DailyLogService — Operational journaling for summary-first memory growth.
 *
 * Writes structured log entries to per-day markdown files under:
 *   .cowork/memory/daily/<YYYY-MM-DD>.md
 *
 * These files are NOT injected raw into prompts. They serve as input
 * for DailyLogSummarizer, which produces ranked summary fragments.
 */

import fs from "fs/promises";
import path from "path";

export type DailyLogSource = "user" | "assistant" | "system" | "tool";
export type DailyLogCategory = "task" | "feedback" | "decision" | "observation";

export interface DailyLogEntry {
  timestamp: string; // ISO-8601
  source: DailyLogSource;
  category: DailyLogCategory;
  text: string;
  taskId?: string;
  tags?: string[];
}

export class DailyLogService {
  static resolveDailyLogPath(workspacePath: string, dayIso: string): string {
    return path.join(workspacePath, ".cowork", "memory", "daily", `${dayIso}.md`);
  }

  static resolveLogDir(workspacePath: string): string {
    return path.join(workspacePath, ".cowork", "memory", "daily");
  }

  static async appendEntry(workspacePath: string, entry: DailyLogEntry): Promise<void> {
    const dayIso = entry.timestamp.slice(0, 10);
    const absPath = this.resolveDailyLogPath(workspacePath, dayIso);
    await fs.mkdir(path.dirname(absPath), { recursive: true });

    const lines: string[] = [
      `## ${entry.timestamp}`,
      `source: ${entry.source}`,
      `category: ${entry.category}`,
    ];
    if (entry.taskId) lines.push(`taskId: ${entry.taskId}`);
    if (entry.tags?.length) lines.push(`tags: ${entry.tags.join(", ")}`);
    lines.push("", entry.text.trim(), "");

    await fs.appendFile(absPath, lines.join("\n") + "\n", "utf8");
  }

  static async readDay(
    workspacePath: string,
    dayIso: string,
    readGuard?: (candidatePath: string) => boolean,
  ): Promise<string | null> {
    const absPath = this.resolveDailyLogPath(workspacePath, dayIso);
    if (readGuard) {
      try {
        if (!readGuard(absPath)) return null;
      } catch {
        return null;
      }
    }
    try {
      return await fs.readFile(absPath, "utf8");
    } catch {
      return null;
    }
  }

  /**
   * Returns the ISO day strings (YYYY-MM-DD) that have log files,
   * sorted descending (most recent first), limited to `maxDays`.
   */
  static async listRecentDays(
    workspacePath: string,
    maxDays = 7,
    readGuard?: (candidatePath: string) => boolean,
  ): Promise<string[]> {
    const dir = this.resolveLogDir(workspacePath);
    if (readGuard) {
      try {
        if (!readGuard(dir)) return [];
      } catch {
        return [];
      }
    }
    try {
      const entries = await fs.readdir(dir);
      return entries
        .filter((f) => /^\d{4}-\d{2}-\d{2}\.md$/.test(f))
        .filter((f) => {
          if (!readGuard) return true;
          try {
            return readGuard(path.join(dir, f)) === true;
          } catch {
            return false;
          }
        })
        .map((f) => f.replace(".md", ""))
        .sort()
        .reverse()
        .slice(0, maxDays);
    } catch {
      return [];
    }
  }
}
