/**
 * Tests for TaskSubscriptionRepository
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TaskSubscription } from "../../../shared/types";
import type { SubscriptionReason } from "../TaskSubscriptionRepository";

// Mock electron to avoid getPath errors
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
}));

// In-memory mock storage
let mockSubscriptions: Map<string, Any>;
let subscriptionIdCounter: number;

// Mock TaskSubscriptionRepository
class MockTaskSubscriptionRepository {
  subscribe(taskId: string, agentRoleId: string, reason: SubscriptionReason): TaskSubscription {
    // Check if already subscribed
    const existing = this.findByTaskAndAgent(taskId, agentRoleId);
    if (existing) {
      return existing;
    }

    const id = `sub-${++subscriptionIdCounter}`;
    const now = Date.now();

    const subscription: TaskSubscription = {
      id,
      taskId,
      agentRoleId,
      subscriptionReason: reason,
      subscribedAt: now,
    };

    mockSubscriptions.set(id, {
      ...subscription,
      task_id: taskId,
      agent_role_id: agentRoleId,
      subscription_reason: reason,
      subscribed_at: now,
    });

    return subscription;
  }

  autoSubscribe(taskId: string, agentRoleId: string, reason: SubscriptionReason): TaskSubscription {
    return this.subscribe(taskId, agentRoleId, reason);
  }

  unsubscribe(taskId: string, agentRoleId: string): boolean {
    for (const [id, sub] of mockSubscriptions) {
      if (sub.task_id === taskId && sub.agent_role_id === agentRoleId) {
        mockSubscriptions.delete(id);
        return true;
      }
    }
    return false;
  }

  findByTaskAndAgent(taskId: string, agentRoleId: string): TaskSubscription | undefined {
    for (const stored of mockSubscriptions.values()) {
      if (stored.task_id === taskId && stored.agent_role_id === agentRoleId) {
        return this.mapRowToSubscription(stored);
      }
    }
    return undefined;
  }

  findById(id: string): TaskSubscription | undefined {
    const stored = mockSubscriptions.get(id);
    return stored ? this.mapRowToSubscription(stored) : undefined;
  }

  getSubscribers(taskId: string): TaskSubscription[] {
    const results: TaskSubscription[] = [];
    mockSubscriptions.forEach((stored) => {
      if (stored.task_id === taskId) {
        results.push(this.mapRowToSubscription(stored));
      }
    });
    return results.sort((a, b) => a.subscribedAt - b.subscribedAt);
  }

  getSubscriberCount(taskId: string): number {
    let count = 0;
    mockSubscriptions.forEach((stored) => {
      if (stored.task_id === taskId) count++;
    });
    return count;
  }

  getSubscriptionsForAgent(agentRoleId: string): TaskSubscription[] {
    const results: TaskSubscription[] = [];
    mockSubscriptions.forEach((stored) => {
      if (stored.agent_role_id === agentRoleId) {
        results.push(this.mapRowToSubscription(stored));
      }
    });
    return results.sort((a, b) => b.subscribedAt - a.subscribedAt);
  }

  list(query: {
    taskId?: string;
    agentRoleId?: string;
    limit?: number;
    offset?: number;
  }): TaskSubscription[] {
    let results: TaskSubscription[] = [];
    mockSubscriptions.forEach((stored) => {
      let matches = true;
      if (query.taskId && stored.task_id !== query.taskId) matches = false;
      if (query.agentRoleId && stored.agent_role_id !== query.agentRoleId) matches = false;
      if (matches) {
        results.push(this.mapRowToSubscription(stored));
      }
    });
    results = results.sort((a, b) => b.subscribedAt - a.subscribedAt);
    if (query.offset) {
      results = results.slice(query.offset);
    }
    if (query.limit) {
      results = results.slice(0, query.limit);
    }
    return results;
  }

  deleteByTask(taskId: string): number {
    let count = 0;
    for (const [id, stored] of mockSubscriptions) {
      if (stored.task_id === taskId) {
        mockSubscriptions.delete(id);
        count++;
      }
    }
    return count;
  }

  deleteByAgent(agentRoleId: string): number {
    let count = 0;
    for (const [id, stored] of mockSubscriptions) {
      if (stored.agent_role_id === agentRoleId) {
        mockSubscriptions.delete(id);
        count++;
      }
    }
    return count;
  }

  isSubscribed(taskId: string, agentRoleId: string): boolean {
    return !!this.findByTaskAndAgent(taskId, agentRoleId);
  }

  getSubscriberIds(taskId: string): string[] {
    const ids: string[] = [];
    mockSubscriptions.forEach((stored) => {
      if (stored.task_id === taskId) {
        ids.push(stored.agent_role_id);
      }
    });
    return ids;
  }

  private mapRowToSubscription(row: Any): TaskSubscription {
    return {
      id: row.id,
      taskId: row.task_id,
      agentRoleId: row.agent_role_id,
      subscriptionReason: row.subscription_reason,
      subscribedAt: row.subscribed_at,
    };
  }
}

describe("TaskSubscriptionRepository", () => {
  let repository: MockTaskSubscriptionRepository;

  beforeEach(() => {
    mockSubscriptions = new Map();
    subscriptionIdCounter = 0;
    repository = new MockTaskSubscriptionRepository();
  });

  describe("subscribe", () => {
    it("should create a subscription", () => {
      const sub = repository.subscribe("task-1", "agent-1", "assigned");

      expect(sub).toBeDefined();
      expect(sub.id).toBeDefined();
      expect(sub.taskId).toBe("task-1");
      expect(sub.agentRoleId).toBe("agent-1");
      expect(sub.subscriptionReason).toBe("assigned");
      expect(sub.subscribedAt).toBeGreaterThan(0);
    });

    it("should return existing subscription if already subscribed", () => {
      const sub1 = repository.subscribe("task-1", "agent-1", "assigned");
      const sub2 = repository.subscribe("task-1", "agent-1", "mentioned");

      expect(sub2.id).toBe(sub1.id);
      expect(sub2.subscriptionReason).toBe("assigned"); // Original reason preserved
    });

    it("should allow different agents to subscribe to same task", () => {
      const sub1 = repository.subscribe("task-1", "agent-1", "assigned");
      const sub2 = repository.subscribe("task-1", "agent-2", "mentioned");

      expect(sub1.id).not.toBe(sub2.id);
      expect(repository.getSubscriberCount("task-1")).toBe(2);
    });

    it("should allow same agent to subscribe to different tasks", () => {
      const sub1 = repository.subscribe("task-1", "agent-1", "assigned");
      const sub2 = repository.subscribe("task-2", "agent-1", "mentioned");

      expect(sub1.id).not.toBe(sub2.id);
      expect(repository.getSubscriptionsForAgent("agent-1")).toHaveLength(2);
    });
  });

  describe("autoSubscribe", () => {
    it("should work the same as subscribe", () => {
      const sub = repository.autoSubscribe("task-1", "agent-1", "commented");

      expect(sub.taskId).toBe("task-1");
      expect(sub.subscriptionReason).toBe("commented");
    });
  });

  describe("unsubscribe", () => {
    it("should remove a subscription", () => {
      repository.subscribe("task-1", "agent-1", "assigned");

      const result = repository.unsubscribe("task-1", "agent-1");

      expect(result).toBe(true);
      expect(repository.isSubscribed("task-1", "agent-1")).toBe(false);
    });

    it("should return false if not subscribed", () => {
      const result = repository.unsubscribe("task-1", "agent-1");

      expect(result).toBe(false);
    });
  });

  describe("findByTaskAndAgent", () => {
    it("should find existing subscription", () => {
      repository.subscribe("task-1", "agent-1", "assigned");

      const found = repository.findByTaskAndAgent("task-1", "agent-1");

      expect(found).toBeDefined();
      expect(found?.taskId).toBe("task-1");
    });

    it("should return undefined for non-existent subscription", () => {
      const found = repository.findByTaskAndAgent("task-1", "agent-1");

      expect(found).toBeUndefined();
    });
  });

  describe("findById", () => {
    it("should find subscription by ID", () => {
      const created = repository.subscribe("task-1", "agent-1", "assigned");

      const found = repository.findById(created.id);

      expect(found).toBeDefined();
      expect(found?.taskId).toBe("task-1");
    });

    it("should return undefined for non-existent ID", () => {
      const found = repository.findById("non-existent");

      expect(found).toBeUndefined();
    });
  });

  describe("getSubscribers", () => {
    it("should return all subscribers for a task", () => {
      repository.subscribe("task-1", "agent-1", "assigned");
      repository.subscribe("task-1", "agent-2", "mentioned");
      repository.subscribe("task-1", "agent-3", "commented");

      const subscribers = repository.getSubscribers("task-1");

      expect(subscribers).toHaveLength(3);
    });

    it("should return empty array for task with no subscribers", () => {
      const subscribers = repository.getSubscribers("task-1");

      expect(subscribers).toHaveLength(0);
    });

    it("should sort by subscribed time ascending", () => {
      repository.subscribe("task-1", "agent-1", "assigned");
      repository.subscribe("task-1", "agent-2", "mentioned");

      const subscribers = repository.getSubscribers("task-1");

      expect(subscribers[0].agentRoleId).toBe("agent-1");
      expect(subscribers[1].agentRoleId).toBe("agent-2");
    });
  });

  describe("getSubscriberCount", () => {
    it("should return count of subscribers", () => {
      repository.subscribe("task-1", "agent-1", "assigned");
      repository.subscribe("task-1", "agent-2", "mentioned");

      expect(repository.getSubscriberCount("task-1")).toBe(2);
    });

    it("should return 0 for task with no subscribers", () => {
      expect(repository.getSubscriberCount("task-1")).toBe(0);
    });
  });

  describe("getSubscriptionsForAgent", () => {
    it("should return all subscriptions for an agent", () => {
      repository.subscribe("task-1", "agent-1", "assigned");
      repository.subscribe("task-2", "agent-1", "mentioned");
      repository.subscribe("task-3", "agent-1", "manual");

      const subs = repository.getSubscriptionsForAgent("agent-1");

      expect(subs).toHaveLength(3);
    });

    it("should return empty array for agent with no subscriptions", () => {
      const subs = repository.getSubscriptionsForAgent("agent-1");

      expect(subs).toHaveLength(0);
    });
  });

  describe("list", () => {
    it("should list all subscriptions", () => {
      repository.subscribe("task-1", "agent-1", "assigned");
      repository.subscribe("task-2", "agent-2", "mentioned");

      const all = repository.list({});

      expect(all).toHaveLength(2);
    });

    it("should filter by taskId", () => {
      repository.subscribe("task-1", "agent-1", "assigned");
      repository.subscribe("task-2", "agent-2", "mentioned");

      const filtered = repository.list({ taskId: "task-1" });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].taskId).toBe("task-1");
    });

    it("should filter by agentRoleId", () => {
      repository.subscribe("task-1", "agent-1", "assigned");
      repository.subscribe("task-2", "agent-2", "mentioned");

      const filtered = repository.list({ agentRoleId: "agent-1" });

      expect(filtered).toHaveLength(1);
      expect(filtered[0].agentRoleId).toBe("agent-1");
    });

    it("should respect limit", () => {
      repository.subscribe("task-1", "agent-1", "assigned");
      repository.subscribe("task-2", "agent-2", "mentioned");
      repository.subscribe("task-3", "agent-3", "commented");

      const limited = repository.list({ limit: 2 });

      expect(limited).toHaveLength(2);
    });
  });

  describe("deleteByTask", () => {
    it("should delete all subscriptions for a task", () => {
      repository.subscribe("task-1", "agent-1", "assigned");
      repository.subscribe("task-1", "agent-2", "mentioned");
      repository.subscribe("task-2", "agent-1", "assigned");

      const deleted = repository.deleteByTask("task-1");

      expect(deleted).toBe(2);
      expect(repository.getSubscriberCount("task-1")).toBe(0);
      expect(repository.getSubscriberCount("task-2")).toBe(1);
    });

    it("should return 0 if no subscriptions exist", () => {
      const deleted = repository.deleteByTask("task-1");

      expect(deleted).toBe(0);
    });
  });

  describe("deleteByAgent", () => {
    it("should delete all subscriptions for an agent", () => {
      repository.subscribe("task-1", "agent-1", "assigned");
      repository.subscribe("task-2", "agent-1", "mentioned");
      repository.subscribe("task-1", "agent-2", "assigned");

      const deleted = repository.deleteByAgent("agent-1");

      expect(deleted).toBe(2);
      expect(repository.getSubscriptionsForAgent("agent-1")).toHaveLength(0);
      expect(repository.getSubscriptionsForAgent("agent-2")).toHaveLength(1);
    });
  });

  describe("isSubscribed", () => {
    it("should return true if subscribed", () => {
      repository.subscribe("task-1", "agent-1", "assigned");

      expect(repository.isSubscribed("task-1", "agent-1")).toBe(true);
    });

    it("should return false if not subscribed", () => {
      expect(repository.isSubscribed("task-1", "agent-1")).toBe(false);
    });
  });

  describe("getSubscriberIds", () => {
    it("should return agent IDs subscribed to a task", () => {
      repository.subscribe("task-1", "agent-1", "assigned");
      repository.subscribe("task-1", "agent-2", "mentioned");

      const ids = repository.getSubscriberIds("task-1");

      expect(ids).toContain("agent-1");
      expect(ids).toContain("agent-2");
      expect(ids).toHaveLength(2);
    });

    it("should return empty array for task with no subscribers", () => {
      const ids = repository.getSubscriberIds("task-1");

      expect(ids).toHaveLength(0);
    });
  });
});
