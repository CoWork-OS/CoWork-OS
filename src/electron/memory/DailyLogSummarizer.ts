/**
 * DailyLogSummarizer — Produces ranked MemoryFragments from daily log summaries.
 *
 * Directory layout:
 *   .cowork/memory/daily/<YYYY-MM-DD>.md    — raw operational log (written by DailyLogService)
 *   .cowork/memory/summaries/<YYYY-MM-DD>.md — synthesized summary (written here)
 *
 * Retrieval rule:
 *   - Prefers existing summaries over raw daily logs.
 *   - Returns fragments ranked lower than user_profile / relationship memory,
 *     but higher than raw daily log snippets.
 *   - Raw daily log content is NEVER returned by this service (use DailyLogService directly
 *     only for low-level journaling; never inject raw logs into prompts).
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
    await fs.mkdir(dir, { recursive: true });
    const absPath = this.resolveSummaryPath(workspacePath, dayIso);
    const header = `---\nupdated: ${new Date().toISOString().slice(0, 10)}\nsource: daily_log_synthesizer\nday: ${dayIso}\n---\n\n`;
    await fs.writeFile(absPath, header + summaryContent.trim() + "\n", "utf8");
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
