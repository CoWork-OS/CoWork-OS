import type Database from "better-sqlite3";
import {
  botOutcomeMetricsRequestSchema,
  type BotOutcomeMetrics,
} from "../../shared/bot-outcome-metrics";
import { BotOutcomeMetricsRepository } from "../database/repository-facades";
import { botWorkViewLatency } from "./BotWorkQueryService";

/** Read-only rollout baseline shared by the Node and Electron Control Plane. */
export class BotOutcomeMetricsService {
  private repository: BotOutcomeMetricsRepository;
  constructor(
    db: Database.Database,
    private now: () => number = Date.now,
  ) {
    this.repository = new BotOutcomeMetricsRepository(db);
  }

  async summary(raw: unknown): Promise<BotOutcomeMetrics> {
    const request = botOutcomeMetricsRequestSchema.parse(raw);
    const recorded = await this.repository.summary(request, this.now());
    return { ...recorded, workView: botWorkViewLatency() };
  }
}
