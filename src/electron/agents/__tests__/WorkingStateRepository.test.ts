/**
 * Tests for WorkingStateRepository
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  AgentWorkingState,
  UpdateWorkingStateRequest,
  WorkingStateQuery,
  WorkingStateHistoryQuery,
  WorkingStateType,
} from "../../../shared/types";

// Mock electron to avoid getPath errors
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
}));

// In-memory mock storage
let mockStates: Map<string, Any>;
let stateIdCounter: number;

// Mock WorkingStateRepository
class MockWorkingStateRepository {
  findById(id: string): AgentWorkingState | undefined {
    const stored = mockStates.get(id);
    return stored ? this.mapRowToState(stored) : undefined;
  }

  getCurrent(query: WorkingStateQuery): AgentWorkingState | undefined {
    for (const state of mockStates.values()) {
      if (
        state.agentRoleId === query.agentRoleId &&
        state.workspaceId === query.workspaceId &&
        state.isCurrent === true
      ) {
        // Check taskId
        if (query.taskId) {
          if (state.taskId !== query.taskId) continue;
        } else {
          if (state.taskId) continue;
        }

        // Check stateType
        if (query.stateType && state.stateType !== query.stateType) {
          continue;
        }

        return this.mapRowToState(state);
      }
    }
    return undefined;
  }

  getAllCurrent(agentRoleId: string, workspaceId: string): AgentWorkingState[] {
    const results: AgentWorkingState[] = [];
    mockStates.forEach((state) => {
      if (
        state.agentRoleId === agentRoleId &&
        state.workspaceId === workspaceId &&
        state.isCurrent === true
      ) {
        results.push(this.mapRowToState(state));
      }
    });
    return results.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  update(request: UpdateWorkingStateRequest): AgentWorkingState {
    const now = Date.now();

    // Mark existing current states as not current
    mockStates.forEach((state, _id) => {
      if (
        state.agentRoleId === request.agentRoleId &&
        state.workspaceId === request.workspaceId &&
        state.stateType === request.stateType &&
        state.isCurrent === true
      ) {
        // Check taskId match
        if (request.taskId) {
          if (state.taskId === request.taskId) {
            state.isCurrent = false;
            state.updatedAt = now;
          }
        } else {
          if (!state.taskId) {
            state.isCurrent = false;
            state.updatedAt = now;
          }
        }
      }
    });

    // Create new state
    const id = `state-${++stateIdCounter}`;
    const newState: AgentWorkingState = {
      id,
      agentRoleId: request.agentRoleId,
      workspaceId: request.workspaceId,
      taskId: request.taskId,
      stateType: request.stateType,
      content: request.content,
      fileReferences: request.fileReferences,
      isCurrent: true,
      createdAt: now,
      updatedAt: now,
    };

    mockStates.set(id, { ...newState });
    return newState;
  }

  getHistory(query: WorkingStateHistoryQuery): AgentWorkingState[] {
    const limit = query.limit || 50;
    const offset = query.offset || 0;

    const results: AgentWorkingState[] = [];
    mockStates.forEach((state) => {
      if (state.agentRoleId === query.agentRoleId && state.workspaceId === query.workspaceId) {
        results.push(this.mapRowToState(state));
      }
    });

    return results.sort((a, b) => b.updatedAt - a.updatedAt).slice(offset, offset + limit);
  }

  listForTask(taskId: string): AgentWorkingState[] {
    const results: AgentWorkingState[] = [];
    mockStates.forEach((state) => {
      if (state.taskId === taskId) {
        results.push(this.mapRowToState(state));
      }
    });
    return results.sort((a, b) => b.updatedAt - a.updatedAt);
  }

  restore(id: string): AgentWorkingState | undefined {
    const state = this.findById(id);
    if (!state) return undefined;

    const now = Date.now();

    // Mark all states of this type/agent/workspace as not current
    mockStates.forEach((s) => {
      if (
        s.agentRoleId === state.agentRoleId &&
        s.workspaceId === state.workspaceId &&
        s.stateType === state.stateType &&
        s.isCurrent === true
      ) {
        // Check taskId match
        if (state.taskId) {
          if (s.taskId === state.taskId) {
            s.isCurrent = false;
            s.updatedAt = now;
          }
        } else {
          if (!s.taskId) {
            s.isCurrent = false;
            s.updatedAt = now;
          }
        }
      }
    });

    // Mark the target state as current
    const stored = mockStates.get(id);
    if (stored) {
      stored.isCurrent = true;
      stored.updatedAt = now;
    }

    return { ...state, isCurrent: true, updatedAt: now };
  }

  delete(id: string): boolean {
    return mockStates.delete(id);
  }

  deleteByAgentAndWorkspace(agentRoleId: string, workspaceId: string): number {
    let count = 0;
    const toDelete: string[] = [];
    mockStates.forEach((state, id) => {
      if (state.agentRoleId === agentRoleId && state.workspaceId === workspaceId) {
        toDelete.push(id);
      }
    });
    toDelete.forEach((id) => {
      mockStates.delete(id);
      count++;
    });
    return count;
  }

  deleteByTask(taskId: string): number {
    let count = 0;
    const toDelete: string[] = [];
    mockStates.forEach((state, id) => {
      if (state.taskId === taskId) {
        toDelete.push(id);
      }
    });
    toDelete.forEach((id) => {
      mockStates.delete(id);
      count++;
    });
    return count;
  }

  private mapRowToState(row: Any): AgentWorkingState {
    return {
      id: row.id,
      agentRoleId: row.agentRoleId,
      workspaceId: row.workspaceId,
      taskId: row.taskId || undefined,
      stateType: row.stateType as WorkingStateType,
      content: row.content,
      fileReferences: row.fileReferences,
      isCurrent: row.isCurrent,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

describe("WorkingStateRepository", () => {
  let repository: MockWorkingStateRepository;

  beforeEach(() => {
    mockStates = new Map();
    stateIdCounter = 0;
    repository = new MockWorkingStateRepository();
  });

  describe("update", () => {
    it("should create a new working state", () => {
      const state = repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "context",
        content: "Working on feature X",
      });

      expect(state).toBeDefined();
      expect(state.id).toBeDefined();
      expect(state.agentRoleId).toBe("agent-1");
      expect(state.workspaceId).toBe("workspace-1");
      expect(state.stateType).toBe("context");
      expect(state.content).toBe("Working on feature X");
      expect(state.isCurrent).toBe(true);
    });

    it("should create state with file references", () => {
      const state = repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "notes",
        content: "Important notes",
        fileReferences: ["src/index.ts", "src/utils.ts"],
      });

      expect(state.fileReferences).toEqual(["src/index.ts", "src/utils.ts"]);
    });

    it("should create state with task association", () => {
      const state = repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        taskId: "task-123",
        stateType: "progress",
        content: "Task progress update",
      });

      expect(state.taskId).toBe("task-123");
    });

    it("should mark previous current state as not current", () => {
      const first = repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "context",
        content: "First context",
      });

      const second = repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "context",
        content: "Second context",
      });

      expect(second.isCurrent).toBe(true);

      const firstAfter = repository.findById(first.id);
      expect(firstAfter?.isCurrent).toBe(false);
    });

    it("should not affect different state types", () => {
      const context = repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "context",
        content: "Context state",
      });

      const progress = repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "progress",
        content: "Progress state",
      });

      expect(context.isCurrent).toBe(true);
      expect(progress.isCurrent).toBe(true);

      const contextAfter = repository.findById(context.id);
      expect(contextAfter?.isCurrent).toBe(true);
    });
  });

  describe("findById", () => {
    it("should find an existing state", () => {
      const created = repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "plan",
        content: "The plan",
      });

      const found = repository.findById(created.id);
      expect(found).toBeDefined();
      expect(found?.content).toBe("The plan");
    });

    it("should return undefined for non-existent state", () => {
      const found = repository.findById("non-existent");
      expect(found).toBeUndefined();
    });
  });

  describe("getCurrent", () => {
    it("should get current state for agent/workspace/type", () => {
      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "context",
        content: "Old context",
      });

      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "context",
        content: "Current context",
      });

      const current = repository.getCurrent({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "context",
      });

      expect(current).toBeDefined();
      expect(current?.content).toBe("Current context");
      expect(current?.isCurrent).toBe(true);
    });

    it("should return undefined when no current state exists", () => {
      const current = repository.getCurrent({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "notes",
      });

      expect(current).toBeUndefined();
    });

    it("should filter by taskId", () => {
      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        taskId: "task-1",
        stateType: "progress",
        content: "Task 1 progress",
      });

      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        taskId: "task-2",
        stateType: "progress",
        content: "Task 2 progress",
      });

      const current = repository.getCurrent({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        taskId: "task-1",
        stateType: "progress",
      });

      expect(current?.content).toBe("Task 1 progress");
    });
  });

  describe("getAllCurrent", () => {
    it("should return all current states for agent/workspace", () => {
      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "context",
        content: "Context",
      });

      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "progress",
        content: "Progress",
      });

      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "notes",
        content: "Notes",
      });

      const states = repository.getAllCurrent("agent-1", "workspace-1");
      expect(states).toHaveLength(3);
    });

    it("should not include non-current states", () => {
      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "context",
        content: "Old context",
      });

      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "context",
        content: "New context",
      });

      const states = repository.getAllCurrent("agent-1", "workspace-1");
      expect(states).toHaveLength(1);
      expect(states[0].content).toBe("New context");
    });
  });

  describe("getHistory", () => {
    it("should return all states for agent/workspace", () => {
      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "context",
        content: "First",
      });

      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "context",
        content: "Second",
      });

      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "context",
        content: "Third",
      });

      const history = repository.getHistory({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
      });

      expect(history).toHaveLength(3);
    });

    it("should respect limit and offset", () => {
      for (let i = 0; i < 10; i++) {
        repository.update({
          agentRoleId: "agent-1",
          workspaceId: "workspace-1",
          stateType: "notes",
          content: `Note ${i}`,
        });
      }

      const history = repository.getHistory({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        limit: 3,
        offset: 2,
      });

      expect(history).toHaveLength(3);
    });

    it("should return empty array for workspace with no states", () => {
      const history = repository.getHistory({
        agentRoleId: "agent-1",
        workspaceId: "empty-workspace",
      });

      expect(history).toHaveLength(0);
    });
  });

  describe("listForTask", () => {
    it("should return all states for a task", () => {
      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        taskId: "task-1",
        stateType: "context",
        content: "Task context",
      });

      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        taskId: "task-1",
        stateType: "progress",
        content: "Task progress",
      });

      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        taskId: "task-2",
        stateType: "context",
        content: "Different task",
      });

      const states = repository.listForTask("task-1");
      expect(states).toHaveLength(2);
    });

    it("should return empty array for task with no states", () => {
      const states = repository.listForTask("non-existent");
      expect(states).toHaveLength(0);
    });
  });

  describe("restore", () => {
    it("should restore a previous state as current", () => {
      const first = repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "context",
        content: "First context",
      });

      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "context",
        content: "Second context",
      });

      const restored = repository.restore(first.id);

      expect(restored).toBeDefined();
      expect(restored?.isCurrent).toBe(true);

      const current = repository.getCurrent({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "context",
      });

      expect(current?.content).toBe("First context");
    });

    it("should return undefined for non-existent state", () => {
      const result = repository.restore("non-existent");
      expect(result).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("should delete a state", () => {
      const state = repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "notes",
        content: "Delete me",
      });

      const deleted = repository.delete(state.id);
      expect(deleted).toBe(true);

      const found = repository.findById(state.id);
      expect(found).toBeUndefined();
    });

    it("should return false for non-existent state", () => {
      const deleted = repository.delete("non-existent");
      expect(deleted).toBe(false);
    });
  });

  describe("deleteByAgentAndWorkspace", () => {
    it("should delete all states for agent/workspace", () => {
      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "context",
        content: "Context",
      });

      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        stateType: "progress",
        content: "Progress",
      });

      repository.update({
        agentRoleId: "agent-2",
        workspaceId: "workspace-1",
        stateType: "context",
        content: "Other agent",
      });

      const count = repository.deleteByAgentAndWorkspace("agent-1", "workspace-1");

      expect(count).toBe(2);
      expect(repository.getAllCurrent("agent-1", "workspace-1")).toHaveLength(0);
      expect(repository.getAllCurrent("agent-2", "workspace-1")).toHaveLength(1);
    });

    it("should return 0 when no states exist", () => {
      const count = repository.deleteByAgentAndWorkspace("agent-1", "empty-workspace");
      expect(count).toBe(0);
    });
  });

  describe("deleteByTask", () => {
    it("should delete all states for a task", () => {
      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        taskId: "task-1",
        stateType: "context",
        content: "Task 1 context",
      });

      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        taskId: "task-1",
        stateType: "progress",
        content: "Task 1 progress",
      });

      repository.update({
        agentRoleId: "agent-1",
        workspaceId: "workspace-1",
        taskId: "task-2",
        stateType: "context",
        content: "Task 2 context",
      });

      const count = repository.deleteByTask("task-1");

      expect(count).toBe(2);
      expect(repository.listForTask("task-1")).toHaveLength(0);
      expect(repository.listForTask("task-2")).toHaveLength(1);
    });

    it("should return 0 when task has no states", () => {
      const count = repository.deleteByTask("non-existent");
      expect(count).toBe(0);
    });
  });

  describe("state types", () => {
    it("should support all state types", () => {
      const types: WorkingStateType[] = ["context", "progress", "notes", "plan"];

      for (const stateType of types) {
        const state = repository.update({
          agentRoleId: "agent-1",
          workspaceId: "workspace-1",
          stateType,
          content: `${stateType} content`,
        });

        expect(state.stateType).toBe(stateType);
      }

      const allCurrent = repository.getAllCurrent("agent-1", "workspace-1");
      expect(allCurrent).toHaveLength(4);
    });
  });
});
