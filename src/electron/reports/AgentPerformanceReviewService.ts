import type Database from "better-sqlite3";
import type {
  AgentAutonomyLevel,
  AgentPerformanceReview,
  AgentReviewGenerateRequest,
  AgentReviewRating,
} from "../../shared/types";
import type { AsyncStore } from "../database/statements/store-units";
import type { AgentPerformanceReviewStore } from "./agent-performance-review-sql";
import { reportsFacade } from "./reports-statement-port";

type ReviewMethod = "generate" | "getLatest" | "list" | "delete";

/**
 * Agent performance reviews (async SQLite migration plan, DB6): each operation is one
 * reports-domain unit over `AgentPerformanceReviewStore`; reads run on the reporting
 * reader when one is running.
 */
export class AgentPerformanceReviewService {
  private readonly store: AsyncStore<AgentPerformanceReviewStore, ReviewMethod>;

  constructor(db: Database.Database) {
    this.store = reportsFacade<AgentPerformanceReviewStore, ReviewMethod>(db, "review_", [
      "generate",
      "getLatest",
      "list",
      "delete",
    ]);
  }

  generate(request: AgentReviewGenerateRequest): Promise<AgentPerformanceReview> {
    return this.store.generate(request);
  }

  getLatest(workspaceId: string, agentRoleId: string): Promise<AgentPerformanceReview | undefined> {
    return this.store.getLatest(workspaceId, agentRoleId);
  }

  list(workspaceId: string, agentRoleId?: string, limit = 30): Promise<AgentPerformanceReview[]> {
    return this.store.list(workspaceId, agentRoleId, limit);
  }

  delete(reviewId: string): Promise<boolean> {
    return this.store.delete(reviewId);
  }
}
