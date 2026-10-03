import { ensureWorkspaceDirectory } from "../utils/workspace-directory";
/**
 * DailyLogSummarizer — Produces ranked MemoryFragments from daily log summaries.
 *
 * Directory layout:
 *   .cowork/memory/summaries/<YYYY-MM-DD>.md — daily summary (written here)
 *
 * Retrieval rule:
 *   - Returns fragments ranked lower than user_profile / relationship memory.
 */

import fs from "fs/promises";
import fsSync from "fs";
import path from "path";
import type { MemoryFragment } from "./MemorySynthesizer";

const CHARS_PER_TOKEN = 4;
const SUMMARY_BASE_RELEVANCE = 0.55; // below user_profile (0.7) but above raw snippets
const SUMMARY_CONFIDENCE = 0.75;

function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

const TASK_ACTIVITY_HEADING = "## Task Activity";
const DAILY_SUMMARY_MAX_TASK_LINES = 40;
const DAILY_SUMMARY_LINE_MAX_CHARS = 200;

/** Collapse text to one bounded line with no control characters. */
function toSingleLine(text: string, maxChars: number): string {
  const collapsed = String(text || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1).trimEnd()}…` : collapsed;
}

function fingerprint(text: string): string {
  return text.toLowerCase().replace(/\s+/g, " ").trim().slice(0, 120);
}

export class DailyLogSummarizer {
  static resolveSummaryPath(workspacePath: string, dayIso: string): string {
    return path.join(workspacePath, ".cowork", "memory", "summaries", `${dayIso}.md`);
  }

  static resolveSummaryDir(workspacePath: string): string {
    return path.join(workspacePath, ".cowork", "memory", "summaries");
  }

  /**
   * Writes a synthesized daily summary to .cowork/memory/summaries/<day>.md.
   * Called externally (e.g. by a cron job or after task completion).
   */
  static async writeSummary(
    workspacePath: string,
    dayIso: string,
    summaryContent: string,
    writeGuard?: (candidatePath: string) => boolean,
  ): Promise<void> {
    const dir = this.resolveSummaryDir(workspacePath);
    if (
      writeGuard &&
      (() => {
        try {
          return !writeGuard(dir) || !writeGuard(this.resolveSummaryPath(workspacePath, dayIso));
        } catch {
          return true;
        }
      })()
    ) {
      return;
    }
    await ensureWorkspaceDirectory(workspacePath, dir);
    const absPath = this.resolveSummaryPath(workspacePath, dayIso);
    const header = `---\nupdated: ${new Date().toISOString().slice(0, 10)}\nsource: daily_log_synthesizer\nday: ${dayIso}\n---\n\n`;
    await fs.writeFile(absPath, header + summaryContent.trim() + "\n", "utf8");
  }

  /**
   * Adds (or replaces) one compact line for a task in the day's summary, keeping at most
   * `maxLines` lines so the file stays small. Lines carry a `[task:<id>]` marker so a task
   * re-consolidated later the same day replaces its earlier line instead of duplicating it.
   * Legacy summaries in the older "Consolidated Signals" layout are discarded on first
   * append because they could contain raw transcript payloads.
   */
  static async appendTaskLine(
    workspacePath: string,
    dayIso: string,
    taskId: string,
    line: string,
    writeGuard?: (candidatePath: string) => boolean,
    maxLines = DAILY_SUMMARY_MAX_TASK_LINES,
  ): Promise<boolean> {
    const dir = this.resolveSummaryDir(workspacePath);
    const absPath = this.resolveSummaryPath(workspacePath, dayIso);
    if (writeGuard) {
      try {
        if (!writeGuard(dir) || !writeGuard(absPath)) return false;
      } catch {
        return false;
      }
    }
    const safeTaskId = String(taskId || "")
      .replace(/[^A-Za-z0-9_-]/g, "")
      .slice(0, 64);
    const text = toSingleLine(line, DAILY_SUMMARY_LINE_MAX_CHARS);
    if (!safeTaskId || !text) return false;

    await ensureWorkspaceDirectory(workspacePath, dir);
    let existing = "";
    try {
      existing = await fs.readFile(absPath, "utf8");
    } catch {
      existing = "";
    }
    const marker = `[task:${safeTaskId}]`;
    const body = existing.replace(/^---[\s\S]*?---\n/, "");
    const previousLines = body.includes(TASK_ACTIVITY_HEADING)
      ? body
          .split("\n")
          .filter((entry) => /^- \[task:[A-Za-z0-9_-]+\] /.test(entry))
          .filter((entry) => !entry.startsWith(`- ${marker} `))
      : [];
    const lines = [...previousLines, `- ${marker} ${text}`].slice(-Math.max(1, maxLines));
    const header = `---\nupdated: ${new Date().toISOString().slice(0, 10)}\nsource: daily_log_synthesizer\nday: ${dayIso}\n---\n\n`;
    await fs.writeFile(absPath, `${header}${TASK_ACTIVITY_HEADING}\n${lines.join("\n")}\n`, "utf8");
    return true;
  }

  /**
   * Returns MemoryFragments from recent daily summaries, ordered by recency.
   * Skips days with no summary file (never falls back to raw logs).
   */
  static getRecentSummaryFragments(
    workspacePath: string,
    _taskPrompt: string,
    maxDays = 7,
    readGuard?: (candidatePath: string) => boolean,
  ): MemoryFragment[] {
    const now = Date.now();
    const fragments: MemoryFragment[] = [];

    for (let i = 0; i < maxDays; i++) {
      const d = new Date(now - i * 86_400_000);
      const dayIso = d.toISOString().slice(0, 10);
      const absPath = this.resolveSummaryPath(workspacePath, dayIso);

      if (readGuard) {
        try {
          if (!readGuard(absPath)) continue;
        } catch {
          continue;
        }
      }

      if (!fsSync.existsSync(absPath)) continue;

      let content: string;
      try {
        content = fsSync.readFileSync(absPath, "utf8");
      } catch {
        continue;
      }

      // Strip YAML frontmatter
      const body = content.replace(/^---[\s\S]*?---\n/, "").trim();
      if (!body) continue;

      // Recency decay: today = full relevance, 7 days ago = ~half
      const ageDays = i;
      const recencyFactor = Math.exp((-Math.LN2 * ageDays) / 7);

      fragments.push({
        key: fingerprint(`daily_summary:${dayIso}:${body}`),
        source: "memory" as const, // grouped under "Recalled Memories" in synthesizer output
        text: `[Daily Summary ${dayIso}]\n${body}`,
        relevance: SUMMARY_BASE_RELEVANCE * recencyFactor,
        confidence: SUMMARY_CONFIDENCE,
        updatedAt: d.getTime(),
        estimatedTokens: estimateTokens(body) + 6,
        category: "daily_summary",
      });
    }

    return fragments;
  }

  /**
   * Returns a simple count of summary files in the last N days.
   * Used for the Improvement Signals card.
   */
  static countRecentSummaries(
    workspacePath: string,
    days = 7,
    readGuard?: (candidatePath: string) => boolean,
  ): number {
    const now = Date.now();
    let count = 0;
    for (let i = 0; i < days; i++) {
      const d = new Date(now - i * 86_400_000);
      const dayIso = d.toISOString().slice(0, 10);
      const summaryPath = this.resolveSummaryPath(workspacePath, dayIso);
      if (
        (!readGuard ||
          (() => {
            try {
              return readGuard(summaryPath) === true;
            } catch {
              return false;
            }
          })()) &&
        fsSync.existsSync(summaryPath)
      ) {
        count++;
      }
    }
    return count;
  }
}
