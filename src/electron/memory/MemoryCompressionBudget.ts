/**
 * Daily token budget of the AI memory compression (audit DATA-7), mirroring Dreaming's
 * LLM budget: a rolling 24-hour window across all workspaces, counted from a ledger
 * (memory-compression-usage-sql.ts) so it holds across restarts and between the desktop
 * app and the node daemon. Without a database port (tests, tooling) an in-process ledger
 * is used.
 */

import { MemoryFeaturesManager } from "../settings/memory-features-manager";
import { createLogger } from "../utils/logger";
import type { MemoryStatementPort } from "./memory-statement-port";

const logger = createLogger("MemoryCompressionBudget");

export const MEMORY_COMPRESSION_DEFAULT_DAILY_TOKEN_BUDGET = 20_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface MemoryCompressionUsage {
  /** Tokens the AI compression used in the last 24 hours. */
  tokensLast24h: number;
  /** The configured daily budget. */
  dailyTokenBudget: number;
}

export class MemoryCompressionBudget {
  private static localLedger: Array<{ at: number; tokens: number }> = [];

  /** The configured budget (`memoryCompressionDailyTokenBudget`, default 20 000). */
  static dailyBudget(): number {
    try {
      const budget = MemoryFeaturesManager.loadSettings().memoryCompressionDailyTokenBudget;
      if (typeof budget === "number" && Number.isFinite(budget) && budget > 0) {
        return Math.floor(budget);
      }
    } catch {
      // Defaults below.
    }
    return MEMORY_COMPRESSION_DEFAULT_DAILY_TOKEN_BUDGET;
  }

  static async tokensUsed(
    port: MemoryStatementPort | undefined,
    now = Date.now(),
  ): Promise<number> {
    const since = Math.floor(now - DAY_MS);
    // The local ledger holds this process's calls when there is no port, or when a
    // ledger write failed.
    this.localLedger = this.localLedger.filter((entry) => entry.at >= since);
    const local = this.localLedger.reduce((sum, entry) => sum + entry.tokens, 0);
    if (!port) return local;
    try {
      return local + (await port.unit("memoryCompression_tokensSince", { since }));
    } catch (error) {
      // Unknown usage spends nothing: report the budget as used up.
      logger.warn("Could not read the compression token ledger:", error);
      return Number.MAX_SAFE_INTEGER;
    }
  }

  /** Tokens left in the rolling 24-hour window (never negative). */
  static async remaining(port: MemoryStatementPort | undefined, now = Date.now()): Promise<number> {
    const used = await this.tokensUsed(port, now);
    return Math.max(0, this.dailyBudget() - used);
  }

  static async record(
    port: MemoryStatementPort | undefined,
    workspaceId: string,
    tokens: number,
    now = Date.now(),
  ): Promise<void> {
    const spent = Math.max(0, Math.floor(tokens));
    if (spent === 0) return;
    if (port) {
      try {
        await port.unit("memoryCompression_recordUsage", {
          workspaceId,
          usedAt: Math.floor(now),
          tokens: spent,
        });
        return;
      } catch (error) {
        logger.warn("Could not record compression token use:", error);
      }
    }
    this.localLedger.push({ at: now, tokens: spent });
  }

  static async usage(port: MemoryStatementPort | undefined): Promise<MemoryCompressionUsage> {
    const used = await this.tokensUsed(port);
    return {
      tokensLast24h: used === Number.MAX_SAFE_INTEGER ? 0 : used,
      dailyTokenBudget: this.dailyBudget(),
    };
  }

  /** Tests only. */
  static resetLocalLedger(): void {
    this.localLedger = [];
  }
}
