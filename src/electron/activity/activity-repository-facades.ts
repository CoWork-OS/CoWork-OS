import type Database from "better-sqlite3";
import type { Activity, ActivityListQuery, CreateActivityRequest } from "../../shared/types";
import { serviceStatements, type ServiceStatementPort } from "../database/service-statements";
import { pendingTimelineActivities } from "../database/timeline-write-registry";
import { ActivityStore } from "./ActivityRepository";

/**
 * Async facade for the activity feed (async SQLite migration plan, DB6). Every method
 * runs one services-domain unit over `ActivityStore`, passing the activity rows the host's
 * timeline writer has accepted but not committed yet. `create` builds the activity on the
 * host, so its id and time are known before the insert commits.
 */
export class ActivityRepository {
  private readonly sql: ServiceStatementPort;

  constructor(private readonly db: Database.Database) {
    this.sql = serviceStatements(db);
  }

  static prepareForInsert(request: CreateActivityRequest): Activity {
    return ActivityStore.prepareForInsert(request);
  }

  private pending(): Activity[] {
    return pendingTimelineActivities(this.db);
  }

  async create(request: CreateActivityRequest): Promise<Activity> {
    const activity = ActivityStore.prepareForInsert(request);
    await this.sql.unit("activity_insertIfAbsent", [[], activity]);
    return activity;
  }

  findById(id: string): Promise<Activity | undefined> {
    return this.sql.unit("activity_findById", [this.pending(), id]);
  }

  list(query: ActivityListQuery): Promise<Activity[]> {
    return this.sql.unit("activity_list", [this.pending(), query]);
  }

  /** Term search over the whole feed of a workspace (`ActivityStore.search`). */
  search(query: {
    workspaceId: string;
    terms: string[];
    minMatched?: number;
    limit?: number;
  }): Promise<Activity[]> {
    return this.sql.unit("activity_search", [this.pending(), query]);
  }

  getUnreadCount(workspaceId: string): Promise<number> {
    return this.sql.unit("activity_getUnreadCount", [this.pending(), workspaceId]);
  }

  markRead(id: string): Promise<boolean> {
    return this.sql.unit("activity_markRead", [this.pending(), id]);
  }

  markAllRead(workspaceId: string): Promise<number> {
    return this.sql.unit("activity_markAllRead", [this.pending(), workspaceId]);
  }

  togglePin(id: string): Promise<Activity | undefined> {
    return this.sql.unit("activity_togglePin", [this.pending(), id]);
  }

  delete(id: string): Promise<boolean> {
    return this.sql.unit("activity_delete", [this.pending(), id]);
  }

  deleteOld(workspaceId: string, olderThanMs?: number): Promise<number> {
    return this.sql.unit("activity_deleteOld", [this.pending(), workspaceId, olderThanMs] as never);
  }
}
