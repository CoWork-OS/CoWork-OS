/**
 * Tests for MentionRepository
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  AgentMention,
  CreateMentionRequest,
  MentionListQuery,
  MentionType,
  MentionStatus as _MentionStatus,
} from "../../../shared/types";

// Mock electron to avoid getPath errors
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
}));

// In-memory mock storage
let mockMentions: Map<string, Any>;
let mentionIdCounter: number;

// Mock MentionRepository
class MockMentionRepository {
  create(request: CreateMentionRequest): AgentMention {
    const id = `mention-${++mentionIdCounter}`;
    const now = Date.now();

    const mention: AgentMention = {
      id,
      workspaceId: request.workspaceId,
      taskId: request.taskId,
      fromAgentRoleId: request.fromAgentRoleId,
      toAgentRoleId: request.toAgentRoleId,
      mentionType: request.mentionType,
      context: request.context,
      status: "pending",
      createdAt: now,
    };

    mockMentions.set(id, { ...mention });
    return mention;
  }

  findById(id: string): AgentMention | undefined {
    const stored = mockMentions.get(id);
    return stored ? { ...stored } : undefined;
  }

  list(query: MentionListQuery): AgentMention[] {
    const results: AgentMention[] = [];
    mockMentions.forEach((mention) => {
      let matches = true;

      if (query.workspaceId && mention.workspaceId !== query.workspaceId) matches = false;
      if (query.taskId && mention.taskId !== query.taskId) matches = false;
      if (query.toAgentRoleId && mention.toAgentRoleId !== query.toAgentRoleId) matches = false;
      if (query.fromAgentRoleId && mention.fromAgentRoleId !== query.fromAgentRoleId)
        matches = false;
      if (query.status) {
        const statuses = Array.isArray(query.status) ? query.status : [query.status];
        if (!statuses.includes(mention.status)) matches = false;
      }

      if (matches) {
        results.push({ ...mention });
      }
    });

    results.sort((a, b) => b.createdAt - a.createdAt);

    const offset = query.offset || 0;
    const limit = query.limit || results.length;
    return results.slice(offset, offset + limit);
  }

  getPendingForAgent(agentRoleId: string): AgentMention[] {
    return this.list({ toAgentRoleId: agentRoleId, status: "pending" });
  }

  acknowledge(id: string): AgentMention | undefined {
    const stored = mockMentions.get(id);
    if (!stored) return undefined;

    stored.status = "acknowledged";
    stored.acknowledgedAt = Date.now();
    mockMentions.set(id, stored);

    return { ...stored };
  }

  complete(id: string): AgentMention | undefined {
    const stored = mockMentions.get(id);
    if (!stored) return undefined;

    stored.status = "completed";
    stored.completedAt = Date.now();
    mockMentions.set(id, stored);

    return { ...stored };
  }

  dismiss(id: string): AgentMention | undefined {
    const stored = mockMentions.get(id);
    if (!stored) return undefined;

    stored.status = "dismissed";
    mockMentions.set(id, stored);

    return { ...stored };
  }

  delete(id: string): boolean {
    return mockMentions.delete(id);
  }

  countPending(agentRoleId: string): number {
    return this.getPendingForAgent(agentRoleId).length;
  }
}

describe("MentionRepository", () => {
  let repository: MockMentionRepository;

  beforeEach(() => {
    mockMentions = new Map();
    mentionIdCounter = 0;
    repository = new MockMentionRepository();
  });

  describe("create", () => {
    it("should create a mention with required fields", () => {
      const mention = repository.create({
        workspaceId: "workspace-1",
        taskId: "task-1",
        toAgentRoleId: "role-reviewer",
        mentionType: "review",
      });

      expect(mention).toBeDefined();
      expect(mention.id).toBeDefined();
      expect(mention.workspaceId).toBe("workspace-1");
      expect(mention.taskId).toBe("task-1");
      expect(mention.toAgentRoleId).toBe("role-reviewer");
      expect(mention.mentionType).toBe("review");
      expect(mention.status).toBe("pending");
      expect(mention.createdAt).toBeDefined();
    });

    it("should create a mention with optional fields", () => {
      const mention = repository.create({
        workspaceId: "workspace-1",
        taskId: "task-1",
        fromAgentRoleId: "role-coder",
        toAgentRoleId: "role-reviewer",
        mentionType: "handoff",
        context: "Please review the changes I made to the authentication module.",
      });

      expect(mention.fromAgentRoleId).toBe("role-coder");
      expect(mention.context).toBe(
        "Please review the changes I made to the authentication module.",
      );
    });

    it("should support all mention types", () => {
      const types: MentionType[] = ["request", "handoff", "review", "fyi"];

      types.forEach((type) => {
        const mention = repository.create({
          workspaceId: "workspace-1",
          taskId: "task-1",
          toAgentRoleId: "role-1",
          mentionType: type,
        });
        expect(mention.mentionType).toBe(type);
      });
    });
  });

  describe("findById", () => {
    it("should find an existing mention", () => {
      const created = repository.create({
        workspaceId: "workspace-1",
        taskId: "task-1",
        toAgentRoleId: "role-1",
        mentionType: "request",
      });

      const found = repository.findById(created.id);
      expect(found).toBeDefined();
      expect(found?.id).toBe(created.id);
    });

    it("should return undefined for non-existent mention", () => {
      const found = repository.findById("non-existent");
      expect(found).toBeUndefined();
    });
  });

  describe("list", () => {
    beforeEach(() => {
      // Create test data
      repository.create({
        workspaceId: "workspace-1",
        taskId: "task-1",
        toAgentRoleId: "role-a",
        mentionType: "request",
      });
      repository.create({
        workspaceId: "workspace-1",
        taskId: "task-2",
        toAgentRoleId: "role-b",
        mentionType: "review",
      });
      repository.create({
        workspaceId: "workspace-2",
        taskId: "task-3",
        toAgentRoleId: "role-a",
        mentionType: "handoff",
      });
    });

    it("should list all mentions without filters", () => {
      const mentions = repository.list({});
      expect(mentions).toHaveLength(3);
    });

    it("should filter by workspaceId", () => {
      const mentions = repository.list({ workspaceId: "workspace-1" });
      expect(mentions).toHaveLength(2);
      mentions.forEach((m) => expect(m.workspaceId).toBe("workspace-1"));
    });

    it("should filter by taskId", () => {
      const mentions = repository.list({ taskId: "task-1" });
      expect(mentions).toHaveLength(1);
      expect(mentions[0].taskId).toBe("task-1");
    });

    it("should filter by toAgentRoleId", () => {
      const mentions = repository.list({ toAgentRoleId: "role-a" });
      expect(mentions).toHaveLength(2);
    });

    it("should filter by status", () => {
      const m = repository.create({
        workspaceId: "workspace-1",
        taskId: "task-4",
        toAgentRoleId: "role-c",
        mentionType: "fyi",
      });
      repository.acknowledge(m.id);

      const pending = repository.list({ status: "pending" });
      const acknowledged = repository.list({ status: "acknowledged" });

      expect(pending).toHaveLength(3);
      expect(acknowledged).toHaveLength(1);
    });

    it("should support pagination", () => {
      const page1 = repository.list({ limit: 2, offset: 0 });
      const page2 = repository.list({ limit: 2, offset: 2 });

      expect(page1).toHaveLength(2);
      expect(page2).toHaveLength(1);
    });

    it("should order by createdAt desc", () => {
      const mentions = repository.list({});
      for (let i = 0; i < mentions.length - 1; i++) {
        expect(mentions[i].createdAt).toBeGreaterThanOrEqual(mentions[i + 1].createdAt);
      }
    });
  });

  describe("getPendingForAgent", () => {
    it("should return only pending mentions for an agent", () => {
      const m1 = repository.create({
        workspaceId: "workspace-1",
        taskId: "task-1",
        toAgentRoleId: "role-target",
        mentionType: "request",
      });
      repository.create({
        workspaceId: "workspace-1",
        taskId: "task-2",
        toAgentRoleId: "role-target",
        mentionType: "review",
      });
      repository.create({
        workspaceId: "workspace-1",
        taskId: "task-3",
        toAgentRoleId: "role-other",
        mentionType: "fyi",
      });

      repository.acknowledge(m1.id);

      const pending = repository.getPendingForAgent("role-target");
      expect(pending).toHaveLength(1);
      expect(pending[0].status).toBe("pending");
      expect(pending[0].toAgentRoleId).toBe("role-target");
    });
  });

  describe("acknowledge", () => {
    it("should acknowledge a pending mention", () => {
      const mention = repository.create({
        workspaceId: "workspace-1",
        taskId: "task-1",
        toAgentRoleId: "role-1",
        mentionType: "request",
      });

      const acknowledged = repository.acknowledge(mention.id);

      expect(acknowledged).toBeDefined();
      expect(acknowledged?.status).toBe("acknowledged");
      expect(acknowledged?.acknowledgedAt).toBeDefined();
    });

    it("should return undefined for non-existent mention", () => {
      const result = repository.acknowledge("non-existent");
      expect(result).toBeUndefined();
    });
  });

  describe("complete", () => {
    it("should complete a mention", () => {
      const mention = repository.create({
        workspaceId: "workspace-1",
        taskId: "task-1",
        toAgentRoleId: "role-1",
        mentionType: "request",
      });

      repository.acknowledge(mention.id);
      const completed = repository.complete(mention.id);

      expect(completed).toBeDefined();
      expect(completed?.status).toBe("completed");
      expect(completed?.completedAt).toBeDefined();
    });
  });

  describe("dismiss", () => {
    it("should dismiss a mention", () => {
      const mention = repository.create({
        workspaceId: "workspace-1",
        taskId: "task-1",
        toAgentRoleId: "role-1",
        mentionType: "fyi",
      });

      const dismissed = repository.dismiss(mention.id);

      expect(dismissed).toBeDefined();
      expect(dismissed?.status).toBe("dismissed");
    });
  });

  describe("delete", () => {
    it("should delete a mention", () => {
      const mention = repository.create({
        workspaceId: "workspace-1",
        taskId: "task-1",
        toAgentRoleId: "role-1",
        mentionType: "request",
      });

      const deleted = repository.delete(mention.id);
      expect(deleted).toBe(true);

      const found = repository.findById(mention.id);
      expect(found).toBeUndefined();
    });

    it("should return false for non-existent mention", () => {
      const deleted = repository.delete("non-existent");
      expect(deleted).toBe(false);
    });
  });

  describe("countPending", () => {
    it("should count pending mentions for an agent", () => {
      repository.create({
        workspaceId: "workspace-1",
        taskId: "task-1",
        toAgentRoleId: "role-target",
        mentionType: "request",
      });
      repository.create({
        workspaceId: "workspace-1",
        taskId: "task-2",
        toAgentRoleId: "role-target",
        mentionType: "review",
      });
      const m3 = repository.create({
        workspaceId: "workspace-1",
        taskId: "task-3",
        toAgentRoleId: "role-target",
        mentionType: "fyi",
      });

      repository.complete(m3.id);

      expect(repository.countPending("role-target")).toBe(2);
      expect(repository.countPending("role-other")).toBe(0);
    });
  });
});
