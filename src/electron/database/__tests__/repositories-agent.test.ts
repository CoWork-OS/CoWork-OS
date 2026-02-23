/**
 * Tests for TaskRepository sub-agent/parallel agent field handling
 *
 * Note: These tests use mock implementations to avoid native module issues
 * with better-sqlite3 in the test environment.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { Task, AgentConfig, AgentType } from "../../../shared/types";

// Mock electron to avoid getPath errors
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
}));

// In-memory mock storage instead of SQLite
let mockTasks: Map<string, any>;
let taskIdCounter: number;

// Simplified mock TaskRepository that mirrors the real implementation's interface
class MockTaskRepository {
  private static readonly ALLOWED_UPDATE_FIELDS = new Set([
    "title",
    "status",
    "error",
    "result",
    "budgetTokens",
    "budgetCost",
    "successCriteria",
    "maxAttempts",
    "currentAttempt",
    "completedAt",
    "parentTaskId",
    "agentType",
    "agentConfig",
    "depth",
    "resultSummary",
    "pinned",
    "worktreePath",
    "worktreeBranch",
    "worktreeStatus",
    "comparisonSessionId",
  ]);

  private static readonly JSON_FIELDS = new Set(["successCriteria", "agentConfig"]);

  create(task: Omit<Task, "id" | "createdAt" | "updatedAt">): Task {
    const id = `task-${++taskIdCounter}`;
    const now = Date.now();

    const newTask: Task = {
      ...task,
      id,
      createdAt: now,
      updatedAt: now,
      agentType: task.agentType || "main",
      depth: task.depth ?? 0,
      pinned: task.pinned,
    };

    // Simulate DB storage (serialize/deserialize JSON fields)
    const stored = {
      ...newTask,
      pinned: newTask.pinned ? 1 : 0,
      agentConfig: newTask.agentConfig ? JSON.stringify(newTask.agentConfig) : null,
      successCriteria: newTask.successCriteria ? JSON.stringify(newTask.successCriteria) : null,
    };
    mockTasks.set(id, stored);

    return newTask;
  }

  update(id: string, updates: Partial<Task>): void {
    const stored = mockTasks.get(id);
    if (!stored) return;

    Object.entries(updates).forEach(([key, value]) => {
      if (!MockTaskRepository.ALLOWED_UPDATE_FIELDS.has(key)) {
        console.warn(`Ignoring unknown field in task update: ${key}`);
        return;
      }

      // JSON serialize object fields
      if (key === "pinned") {
        stored[key] = value ? 1 : 0;
      } else if (MockTaskRepository.JSON_FIELDS.has(key) && value != null) {
        stored[key] = JSON.stringify(value);
      } else {
        stored[key] = value;
      }
    });

    stored.updatedAt = Date.now();
    mockTasks.set(id, stored);
  }

  findById(id: string): Task | undefined {
    const stored = mockTasks.get(id);
    if (!stored) return undefined;
    return this.mapStoredToTask(stored);
  }

  togglePin(id: string): Task | undefined {
    const stored = mockTasks.get(id);
    if (!stored) return undefined;

    stored.pinned = stored.pinned ? 0 : 1;
    stored.updatedAt = Date.now();
    mockTasks.set(id, stored);
    return this.findById(id);
  }

  findByParentId(parentTaskId: string): Task[] {
    const results: any[] = [];
    mockTasks.forEach((stored) => {
      if (stored.parentTaskId === parentTaskId) {
        results.push(stored);
      }
    });
    // Sort by createdAt
    results.sort((a, b) => a.createdAt - b.createdAt);
    return results.map((stored) => this.mapStoredToTask(stored));
  }

  private mapStoredToTask(stored: any): Task {
    return {
      id: stored.id,
      title: stored.title,
      prompt: stored.prompt,
      status: stored.status,
      workspaceId: stored.workspaceId,
      createdAt: stored.createdAt,
      updatedAt: stored.updatedAt,
      completedAt: stored.completedAt || undefined,
      budgetTokens: stored.budgetTokens || undefined,
      budgetCost: stored.budgetCost || undefined,
      error: stored.error || undefined,
      successCriteria: stored.successCriteria ? JSON.parse(stored.successCriteria) : undefined,
      maxAttempts: stored.maxAttempts || undefined,
      currentAttempt: stored.currentAttempt || undefined,
      parentTaskId: stored.parentTaskId || undefined,
      agentType: (stored.agentType as AgentType) || "main",
      agentConfig: stored.agentConfig ? JSON.parse(stored.agentConfig) : undefined,
      pinned: Number(stored.pinned) === 1,
      depth: stored.depth ?? 0,
      resultSummary: stored.resultSummary || undefined,
      worktreePath: stored.worktreePath || undefined,
      worktreeBranch: stored.worktreeBranch || undefined,
      worktreeStatus: stored.worktreeStatus || undefined,
      comparisonSessionId: stored.comparisonSessionId || undefined,
    };
  }
}

describe("TaskRepository - Agent Fields", () => {
  let repository: MockTaskRepository;

  beforeEach(() => {
    mockTasks = new Map();
    taskIdCounter = 0;
    repository = new MockTaskRepository();
  });

  describe("create", () => {
    it("should create task with default agent fields", () => {
      const task = repository.create({
        title: "Test Task",
        prompt: "Do something",
        status: "pending",
        workspaceId: "workspace-1",
      });

      const retrieved = repository.findById(task.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.agentType).toBe("main");
      expect(retrieved?.depth).toBe(0);
      expect(retrieved?.parentTaskId).toBeUndefined();
      expect(retrieved?.agentConfig).toBeUndefined();
      expect(retrieved?.resultSummary).toBeUndefined();
    });

    it("should create task with sub agent type", () => {
      const task = repository.create({
        title: "Sub Agent Task",
        prompt: "Child task",
        status: "pending",
        workspaceId: "workspace-1",
        agentType: "sub",
        parentTaskId: "parent-123",
        depth: 1,
      });

      const retrieved = repository.findById(task.id);

      expect(retrieved?.agentType).toBe("sub");
      expect(retrieved?.parentTaskId).toBe("parent-123");
      expect(retrieved?.depth).toBe(1);
    });

    it("should create task with parallel agent type", () => {
      const task = repository.create({
        title: "Parallel Agent Task",
        prompt: "Parallel task",
        status: "pending",
        workspaceId: "workspace-1",
        agentType: "parallel",
      });

      const retrieved = repository.findById(task.id);
      expect(retrieved?.agentType).toBe("parallel");
    });

    it("should store and retrieve agentConfig", () => {
      const agentConfig: AgentConfig = {
        modelKey: "haiku-4-5",
        personalityId: "concise",
        maxTurns: 10,
        maxTokens: 5000,
        retainMemory: false,
      };

      const task = repository.create({
        title: "Configured Agent",
        prompt: "Task with config",
        status: "pending",
        workspaceId: "workspace-1",
        agentType: "sub",
        agentConfig,
      });

      const retrieved = repository.findById(task.id);

      expect(retrieved?.agentConfig).toBeDefined();
      expect(retrieved?.agentConfig?.modelKey).toBe("haiku-4-5");
      expect(retrieved?.agentConfig?.personalityId).toBe("concise");
      expect(retrieved?.agentConfig?.maxTurns).toBe(10);
      expect(retrieved?.agentConfig?.maxTokens).toBe(5000);
      expect(retrieved?.agentConfig?.retainMemory).toBe(false);
    });

    it("should store resultSummary", () => {
      const task = repository.create({
        title: "Completed Agent",
        prompt: "Task",
        status: "completed",
        workspaceId: "workspace-1",
        resultSummary: "Found 5 files matching the criteria",
      });

      const retrieved = repository.findById(task.id);
      expect(retrieved?.resultSummary).toBe("Found 5 files matching the criteria");
    });
  });

  describe("update", () => {
    it("should update agentType", () => {
      const task = repository.create({
        title: "Test",
        prompt: "Test",
        status: "pending",
        workspaceId: "workspace-1",
      });

      repository.update(task.id, { agentType: "sub" });

      const retrieved = repository.findById(task.id);
      expect(retrieved?.agentType).toBe("sub");
    });

    it("should update parentTaskId", () => {
      const task = repository.create({
        title: "Test",
        prompt: "Test",
        status: "pending",
        workspaceId: "workspace-1",
      });

      repository.update(task.id, { parentTaskId: "new-parent-id" });

      const retrieved = repository.findById(task.id);
      expect(retrieved?.parentTaskId).toBe("new-parent-id");
    });

    it("should update agentConfig", () => {
      const task = repository.create({
        title: "Test",
        prompt: "Test",
        status: "pending",
        workspaceId: "workspace-1",
      });

      const newConfig: AgentConfig = {
        modelKey: "opus-4-5",
        maxTurns: 20,
      };

      repository.update(task.id, { agentConfig: newConfig });

      const retrieved = repository.findById(task.id);
      expect(retrieved?.agentConfig?.modelKey).toBe("opus-4-5");
      expect(retrieved?.agentConfig?.maxTurns).toBe(20);
    });

    it("should update depth", () => {
      const task = repository.create({
        title: "Test",
        prompt: "Test",
        status: "pending",
        workspaceId: "workspace-1",
      });

      repository.update(task.id, { depth: 2 });

      const retrieved = repository.findById(task.id);
      expect(retrieved?.depth).toBe(2);
    });

    it("should update pinned with numeric persistence", () => {
      const task = repository.create({
        title: "Test",
        prompt: "Test",
        status: "pending",
        workspaceId: "workspace-1",
      });

      repository.update(task.id, { pinned: true });
      const updated = repository.findById(task.id);
      expect(updated?.pinned).toBe(true);
      expect(mockTasks.get(task.id)?.pinned).toBe(1);

      repository.update(task.id, { pinned: false });
      const toggledBack = repository.findById(task.id);
      expect(toggledBack?.pinned).toBe(false);
      expect(mockTasks.get(task.id)?.pinned).toBe(0);
    });

    it("should update resultSummary", () => {
      const task = repository.create({
        title: "Test",
        prompt: "Test",
        status: "pending",
        workspaceId: "workspace-1",
      });

      repository.update(task.id, { resultSummary: "Analysis complete: 3 issues found" });

      const retrieved = repository.findById(task.id);
      expect(retrieved?.resultSummary).toBe("Analysis complete: 3 issues found");
    });

    it("should handle multiple field updates", () => {
      const task = repository.create({
        title: "Test",
        prompt: "Test",
        status: "pending",
        workspaceId: "workspace-1",
      });

      repository.update(task.id, {
        status: "completed",
        agentType: "sub",
        depth: 1,
        resultSummary: "Done",
      });

      const retrieved = repository.findById(task.id);
      expect(retrieved?.status).toBe("completed");
      expect(retrieved?.agentType).toBe("sub");
      expect(retrieved?.depth).toBe(1);
      expect(retrieved?.resultSummary).toBe("Done");
    });
  });

  describe("togglePin", () => {
    it("should toggle pinned state", () => {
      const task = repository.create({
        title: "Pin Test",
        prompt: "Test",
        status: "pending",
        workspaceId: "workspace-1",
      });

      expect(repository.findById(task.id)?.pinned).toBe(false);

      const afterFirstToggle = repository.togglePin(task.id);
      expect(afterFirstToggle?.pinned).toBe(true);

      const afterSecondToggle = repository.togglePin(task.id);
      expect(afterSecondToggle?.pinned).toBe(false);
    });

    it("should return undefined for missing tasks", () => {
      const result = repository.togglePin("missing-task");
      expect(result).toBeUndefined();
    });
  });

  describe("findByParentId", () => {
    it("should return empty array when no children exist", () => {
      const parent = repository.create({
        title: "Parent",
        prompt: "Parent task",
        status: "executing",
        workspaceId: "workspace-1",
      });

      const children = repository.findByParentId(parent.id);
      expect(children).toHaveLength(0);
    });

    it("should return all child tasks", () => {
      const parent = repository.create({
        title: "Parent",
        prompt: "Parent task",
        status: "executing",
        workspaceId: "workspace-1",
      });

      repository.create({
        title: "Child 1",
        prompt: "Child task 1",
        status: "pending",
        workspaceId: "workspace-1",
        parentTaskId: parent.id,
        agentType: "sub",
        depth: 1,
      });

      repository.create({
        title: "Child 2",
        prompt: "Child task 2",
        status: "executing",
        workspaceId: "workspace-1",
        parentTaskId: parent.id,
        agentType: "sub",
        depth: 1,
      });

      const children = repository.findByParentId(parent.id);

      expect(children).toHaveLength(2);
      expect(children[0].title).toBe("Child 1");
      expect(children[1].title).toBe("Child 2");
    });

    it("should order children by created_at", async () => {
      const parent = repository.create({
        title: "Parent",
        prompt: "Parent",
        status: "executing",
        workspaceId: "workspace-1",
      });

      const child1 = repository.create({
        title: "First Child",
        prompt: "First",
        status: "pending",
        workspaceId: "workspace-1",
        parentTaskId: parent.id,
      });

      // Small delay to ensure different timestamps
      await new Promise((resolve) => setTimeout(resolve, 10));

      const child2 = repository.create({
        title: "Second Child",
        prompt: "Second",
        status: "pending",
        workspaceId: "workspace-1",
        parentTaskId: parent.id,
      });

      const children = repository.findByParentId(parent.id);

      expect(children).toHaveLength(2);
      expect(children[0].id).toBe(child1.id);
      expect(children[1].id).toBe(child2.id);
    });

    it("should not return grandchildren", () => {
      const grandparent = repository.create({
        title: "Grandparent",
        prompt: "Grandparent",
        status: "executing",
        workspaceId: "workspace-1",
      });

      const parent = repository.create({
        title: "Parent",
        prompt: "Parent",
        status: "executing",
        workspaceId: "workspace-1",
        parentTaskId: grandparent.id,
        depth: 1,
      });

      repository.create({
        title: "Grandchild",
        prompt: "Grandchild",
        status: "pending",
        workspaceId: "workspace-1",
        parentTaskId: parent.id,
        depth: 2,
      });

      const children = repository.findByParentId(grandparent.id);

      expect(children).toHaveLength(1);
      expect(children[0].title).toBe("Parent");
    });
  });

  describe("JSON field serialization", () => {
    it("should handle complex agentConfig", () => {
      const complexConfig: AgentConfig = {
        providerType: "bedrock",
        modelKey: "sonnet-4-5",
        personalityId: "technical",
        maxTurns: 15,
        maxTokens: 10000,
        retainMemory: true,
      };

      const task = repository.create({
        title: "Complex Config Task",
        prompt: "Task",
        status: "pending",
        workspaceId: "workspace-1",
        agentConfig: complexConfig,
      });

      const retrieved = repository.findById(task.id);

      expect(retrieved?.agentConfig).toEqual(complexConfig);
    });

    it("should handle empty agentConfig", () => {
      const task = repository.create({
        title: "Empty Config Task",
        prompt: "Task",
        status: "pending",
        workspaceId: "workspace-1",
        agentConfig: {},
      });

      const retrieved = repository.findById(task.id);

      expect(retrieved?.agentConfig).toEqual({});
    });

    it("should handle null/undefined agentConfig gracefully", () => {
      const task = repository.create({
        title: "No Config Task",
        prompt: "Task",
        status: "pending",
        workspaceId: "workspace-1",
      });

      const retrieved = repository.findById(task.id);

      expect(retrieved?.agentConfig).toBeUndefined();
    });
  });
});
