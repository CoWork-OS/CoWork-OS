import Database from "better-sqlite3";
import { v4 as uuidv4 } from "uuid";
import { TaskSubscription } from "../../shared/types";

/**
 * Subscription reason types
 */
export type SubscriptionReason = "assigned" | "mentioned" | "commented" | "manual";

/**
 * Query parameters for listing subscriptions
 */
export interface SubscriptionListQuery {
  taskId?: string;
  agentRoleId?: string;
  limit?: number;
  offset?: number;
}

/**
 * Repository for managing task subscriptions
 * Agents subscribed to a task receive notifications when new activities occur
 */
export class TaskSubscriptionRepository {
  constructor(private db: Database.Database) {}

  /**
   * Subscribe an agent to a task
   * If already subscribed, returns existing subscription
   */
  subscribe(taskId: string, agentRoleId: string, reason: SubscriptionReason): TaskSubscription {
    // Check if already subscribed
    const existing = this.findByTaskAndAgent(taskId, agentRoleId);
    if (existing) {
      return existing;
    }

    const now = Date.now();
    const subscription: TaskSubscription = {
      id: uuidv4(),
      taskId,
      agentRoleId,
      subscriptionReason: reason,
      subscribedAt: now,
    };

    const stmt = this.db.prepare(`
      INSERT INTO task_subscriptions (
        id, task_id, agent_role_id, subscription_reason, subscribed_at
      ) VALUES (?, ?, ?, ?, ?)
    `);

    stmt.run(
      subscription.id,
      subscription.taskId,
      subscription.agentRoleId,
      subscription.subscriptionReason,
      subscription.subscribedAt,
    );

    return subscription;
  }

  /**
   * Auto-subscribe an agent to a task (convenience method)
   * Used when agent comments, gets mentioned, or gets assigned
   */
  autoSubscribe(taskId: string, agentRoleId: string, reason: SubscriptionReason): TaskSubscription {
    return this.subscribe(taskId, agentRoleId, reason);
  }

  /**
   * Unsubscribe an agent from a task
   */
  unsubscribe(taskId: string, agentRoleId: string): boolean {
    const stmt = this.db.prepare(
      "DELETE FROM task_subscriptions WHERE task_id = ? AND agent_role_id = ?",
    );
    const result = stmt.run(taskId, agentRoleId);
    return result.changes > 0;
  }

  /**
   * Find a subscription by task and agent
   */
  findByTaskAndAgent(taskId: string, agentRoleId: string): TaskSubscription | undefined {
    const stmt = this.db.prepare(
      "SELECT * FROM task_subscriptions WHERE task_id = ? AND agent_role_id = ?",
    );
    const row = stmt.get(taskId, agentRoleId) as Any;
    return row ? this.mapRowToSubscription(row) : undefined;
  }

  /**
   * Find a subscription by ID
   */
  findById(id: string): TaskSubscription | undefined {
    const stmt = this.db.prepare("SELECT * FROM task_subscriptions WHERE id = ?");
    const row = stmt.get(id) as Any;
    return row ? this.mapRowToSubscription(row) : undefined;
  }

  /**
   * Get all subscribers for a task
   */
  getSubscribers(taskId: string): TaskSubscription[] {
    const stmt = this.db.prepare(
      "SELECT * FROM task_subscriptions WHERE task_id = ? ORDER BY subscribed_at ASC",
    );
    const rows = stmt.all(taskId) as Any[];
    return rows.map((row) => this.mapRowToSubscription(row));
  }

  /**
   * Get subscriber count for a task
   */
  getSubscriberCount(taskId: string): number {
    const stmt = this.db.prepare(
      "SELECT COUNT(*) as count FROM task_subscriptions WHERE task_id = ?",
    );
    const result = stmt.get(taskId) as { count: number };
    return result.count;
  }

  /**
   * Get all subscriptions for an agent
   */
  getSubscriptionsForAgent(agentRoleId: string): TaskSubscription[] {
    const stmt = this.db.prepare(
      "SELECT * FROM task_subscriptions WHERE agent_role_id = ? ORDER BY subscribed_at DESC",
    );
    const rows = stmt.all(agentRoleId) as Any[];
    return rows.map((row) => this.mapRowToSubscription(row));
  }

  /**
   * List subscriptions with optional filtering
   */
  list(query: SubscriptionListQuery): TaskSubscription[] {
    const conditions: string[] = [];
    const params: Any[] = [];

    if (query.taskId) {
      conditions.push("task_id = ?");
      params.push(query.taskId);
    }

    if (query.agentRoleId) {
      conditions.push("agent_role_id = ?");
      params.push(query.agentRoleId);
    }

    let sql = "SELECT * FROM task_subscriptions";
    if (conditions.length > 0) {
      sql += ` WHERE ${conditions.join(" AND ")}`;
    }
    sql += " ORDER BY subscribed_at DESC";

    if (query.limit) {
      sql += ` LIMIT ${query.limit}`;
      if (query.offset) {
        sql += ` OFFSET ${query.offset}`;
      }
    }

    const stmt = this.db.prepare(sql);
    const rows = stmt.all(...params) as Any[];
    return rows.map((row) => this.mapRowToSubscription(row));
  }

  /**
   * Delete all subscriptions for a task
   */
  deleteByTask(taskId: string): number {
    const stmt = this.db.prepare("DELETE FROM task_subscriptions WHERE task_id = ?");
    const result = stmt.run(taskId);
    return result.changes;
  }

  /**
   * Delete all subscriptions for an agent
   */
  deleteByAgent(agentRoleId: string): number {
    const stmt = this.db.prepare("DELETE FROM task_subscriptions WHERE agent_role_id = ?");
    const result = stmt.run(agentRoleId);
    return result.changes;
  }

  /**
   * Check if an agent is subscribed to a task
   */
  isSubscribed(taskId: string, agentRoleId: string): boolean {
    const stmt = this.db.prepare(
      "SELECT 1 FROM task_subscriptions WHERE task_id = ? AND agent_role_id = ? LIMIT 1",
    );
    const result = stmt.get(taskId, agentRoleId);
    return !!result;
  }

  /**
   * Get agent role IDs subscribed to a task (for efficient notification)
   */
  getSubscriberIds(taskId: string): string[] {
    const stmt = this.db.prepare("SELECT agent_role_id FROM task_subscriptions WHERE task_id = ?");
    const rows = stmt.all(taskId) as { agent_role_id: string }[];
    return rows.map((row) => row.agent_role_id);
  }

  /**
   * Map database row to TaskSubscription object
   */
  private mapRowToSubscription(row: Any): TaskSubscription {
    return {
      id: row.id,
      taskId: row.task_id,
      agentRoleId: row.agent_role_id,
      subscriptionReason: row.subscription_reason as SubscriptionReason,
      subscribedAt: row.subscribed_at,
    };
  }
}
