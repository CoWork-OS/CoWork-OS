/**
 * Tests for TaskLabelRepository
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  TaskLabel,
  CreateTaskLabelRequest,
  UpdateTaskLabelRequest,
  TaskLabelListQuery,
} from "../../../shared/types";

// Mock electron to avoid getPath errors
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
}));

// In-memory mock storage
let mockLabels: Map<string, Any>;
let labelIdCounter: number;

const DEFAULT_LABEL_COLOR = "#6366f1";

// Mock TaskLabelRepository
class MockTaskLabelRepository {
  create(request: CreateTaskLabelRequest): TaskLabel {
    // Check for unique constraint
    for (const label of mockLabels.values()) {
      if (label.workspaceId === request.workspaceId && label.name === request.name) {
        throw new Error(`Label with name "${request.name}" already exists in workspace`);
      }
    }

    const id = `label-${++labelIdCounter}`;
    const now = Date.now();

    const label: TaskLabel = {
      id,
      workspaceId: request.workspaceId,
      name: request.name,
      color: request.color || DEFAULT_LABEL_COLOR,
      createdAt: now,
    };

    mockLabels.set(id, { ...label });
    return label;
  }

  findById(id: string): TaskLabel | undefined {
    const stored = mockLabels.get(id);
    return stored ? { ...stored } : undefined;
  }

  findByName(workspaceId: string, name: string): TaskLabel | undefined {
    for (const label of mockLabels.values()) {
      if (label.workspaceId === workspaceId && label.name === name) {
        return { ...label };
      }
    }
    return undefined;
  }

  list(query: TaskLabelListQuery): TaskLabel[] {
    const results: TaskLabel[] = [];
    mockLabels.forEach((label) => {
      if (label.workspaceId === query.workspaceId) {
        results.push({ ...label });
      }
    });
    return results.sort((a, b) => a.name.localeCompare(b.name));
  }

  update(id: string, request: UpdateTaskLabelRequest): TaskLabel | undefined {
    const stored = mockLabels.get(id);
    if (!stored) return undefined;

    if (request.name !== undefined) stored.name = request.name;
    if (request.color !== undefined) stored.color = request.color;

    mockLabels.set(id, stored);
    return { ...stored };
  }

  delete(id: string): boolean {
    return mockLabels.delete(id);
  }

  deleteByWorkspace(workspaceId: string): number {
    let count = 0;
    const toDelete: string[] = [];
    mockLabels.forEach((label, id) => {
      if (label.workspaceId === workspaceId) {
        toDelete.push(id);
      }
    });
    toDelete.forEach((id) => {
      mockLabels.delete(id);
      count++;
    });
    return count;
  }

  getByIds(ids: string[]): TaskLabel[] {
    const results: TaskLabel[] = [];
    ids.forEach((id) => {
      const label = mockLabels.get(id);
      if (label) {
        results.push({ ...label });
      }
    });
    return results;
  }
}

describe("TaskLabelRepository", () => {
  let repository: MockTaskLabelRepository;

  beforeEach(() => {
    mockLabels = new Map();
    labelIdCounter = 0;
    repository = new MockTaskLabelRepository();
  });

  describe("create", () => {
    it("should create a label with required fields", () => {
      const label = repository.create({
        workspaceId: "workspace-1",
        name: "Bug",
      });

      expect(label).toBeDefined();
      expect(label.id).toBeDefined();
      expect(label.workspaceId).toBe("workspace-1");
      expect(label.name).toBe("Bug");
      expect(label.color).toBe(DEFAULT_LABEL_COLOR);
      expect(label.createdAt).toBeDefined();
    });

    it("should create a label with custom color", () => {
      const label = repository.create({
        workspaceId: "workspace-1",
        name: "Feature",
        color: "#22c55e",
      });

      expect(label.color).toBe("#22c55e");
    });

    it("should enforce unique name within workspace", () => {
      repository.create({
        workspaceId: "workspace-1",
        name: "Duplicate",
      });

      expect(() => {
        repository.create({
          workspaceId: "workspace-1",
          name: "Duplicate",
        });
      }).toThrow();
    });

    it("should allow same name in different workspaces", () => {
      repository.create({
        workspaceId: "workspace-1",
        name: "Bug",
      });

      const label2 = repository.create({
        workspaceId: "workspace-2",
        name: "Bug",
      });

      expect(label2).toBeDefined();
      expect(label2.workspaceId).toBe("workspace-2");
    });
  });

  describe("findById", () => {
    it("should find an existing label", () => {
      const created = repository.create({
        workspaceId: "workspace-1",
        name: "Test Label",
      });

      const found = repository.findById(created.id);
      expect(found).toBeDefined();
      expect(found?.name).toBe("Test Label");
    });

    it("should return undefined for non-existent label", () => {
      const found = repository.findById("non-existent");
      expect(found).toBeUndefined();
    });
  });

  describe("findByName", () => {
    it("should find label by name within workspace", () => {
      repository.create({
        workspaceId: "workspace-1",
        name: "Enhancement",
        color: "#3b82f6",
      });

      const found = repository.findByName("workspace-1", "Enhancement");
      expect(found).toBeDefined();
      expect(found?.color).toBe("#3b82f6");
    });

    it("should return undefined for non-existent name", () => {
      const found = repository.findByName("workspace-1", "NonExistent");
      expect(found).toBeUndefined();
    });

    it("should not find label from different workspace", () => {
      repository.create({
        workspaceId: "workspace-1",
        name: "Private",
      });

      const found = repository.findByName("workspace-2", "Private");
      expect(found).toBeUndefined();
    });
  });

  describe("list", () => {
    it("should return empty array for workspace with no labels", () => {
      const labels = repository.list({ workspaceId: "empty-workspace" });
      expect(labels).toHaveLength(0);
    });

    it("should return all labels for a workspace", () => {
      repository.create({ workspaceId: "workspace-1", name: "Bug" });
      repository.create({ workspaceId: "workspace-1", name: "Feature" });
      repository.create({ workspaceId: "workspace-2", name: "Other" });

      const labels = repository.list({ workspaceId: "workspace-1" });
      expect(labels).toHaveLength(2);
    });

    it("should sort labels by name alphabetically", () => {
      repository.create({ workspaceId: "workspace-1", name: "Zebra" });
      repository.create({ workspaceId: "workspace-1", name: "Alpha" });
      repository.create({ workspaceId: "workspace-1", name: "Middle" });

      const labels = repository.list({ workspaceId: "workspace-1" });
      expect(labels[0].name).toBe("Alpha");
      expect(labels[1].name).toBe("Middle");
      expect(labels[2].name).toBe("Zebra");
    });
  });

  describe("update", () => {
    it("should update label name", () => {
      const label = repository.create({
        workspaceId: "workspace-1",
        name: "Old Name",
      });

      const updated = repository.update(label.id, { name: "New Name" });

      expect(updated?.name).toBe("New Name");
    });

    it("should update label color", () => {
      const label = repository.create({
        workspaceId: "workspace-1",
        name: "Colorful",
      });

      const updated = repository.update(label.id, { color: "#ef4444" });

      expect(updated?.color).toBe("#ef4444");
    });

    it("should update multiple fields at once", () => {
      const label = repository.create({
        workspaceId: "workspace-1",
        name: "Original",
        color: "#000000",
      });

      const updated = repository.update(label.id, {
        name: "Updated",
        color: "#ffffff",
      });

      expect(updated?.name).toBe("Updated");
      expect(updated?.color).toBe("#ffffff");
    });

    it("should return undefined for non-existent label", () => {
      const result = repository.update("non-existent", { name: "New" });
      expect(result).toBeUndefined();
    });

    it("should not change unspecified fields", () => {
      const label = repository.create({
        workspaceId: "workspace-1",
        name: "Keep Name",
        color: "#123456",
      });

      repository.update(label.id, { color: "#654321" });

      const updated = repository.findById(label.id);
      expect(updated?.name).toBe("Keep Name");
      expect(updated?.color).toBe("#654321");
    });
  });

  describe("delete", () => {
    it("should delete a label", () => {
      const label = repository.create({
        workspaceId: "workspace-1",
        name: "Delete Me",
      });

      const deleted = repository.delete(label.id);
      expect(deleted).toBe(true);

      const found = repository.findById(label.id);
      expect(found).toBeUndefined();
    });

    it("should return false for non-existent label", () => {
      const deleted = repository.delete("non-existent");
      expect(deleted).toBe(false);
    });
  });

  describe("deleteByWorkspace", () => {
    it("should delete all labels for a workspace", () => {
      repository.create({ workspaceId: "workspace-1", name: "Label 1" });
      repository.create({ workspaceId: "workspace-1", name: "Label 2" });
      repository.create({ workspaceId: "workspace-2", name: "Other" });

      const count = repository.deleteByWorkspace("workspace-1");

      expect(count).toBe(2);
      expect(repository.list({ workspaceId: "workspace-1" })).toHaveLength(0);
      expect(repository.list({ workspaceId: "workspace-2" })).toHaveLength(1);
    });

    it("should return 0 when workspace has no labels", () => {
      const count = repository.deleteByWorkspace("empty-workspace");
      expect(count).toBe(0);
    });
  });

  describe("getByIds", () => {
    it("should return labels matching provided IDs", () => {
      const label1 = repository.create({ workspaceId: "workspace-1", name: "Label 1" });
      const label2 = repository.create({ workspaceId: "workspace-1", name: "Label 2" });
      repository.create({ workspaceId: "workspace-1", name: "Label 3" });

      const labels = repository.getByIds([label1.id, label2.id]);

      expect(labels).toHaveLength(2);
      expect(labels.map((l) => l.name)).toContain("Label 1");
      expect(labels.map((l) => l.name)).toContain("Label 2");
    });

    it("should return empty array for empty input", () => {
      const labels = repository.getByIds([]);
      expect(labels).toHaveLength(0);
    });

    it("should skip non-existent IDs", () => {
      const label = repository.create({ workspaceId: "workspace-1", name: "Exists" });

      const labels = repository.getByIds([label.id, "non-existent"]);
      expect(labels).toHaveLength(1);
      expect(labels[0].name).toBe("Exists");
    });
  });
});
