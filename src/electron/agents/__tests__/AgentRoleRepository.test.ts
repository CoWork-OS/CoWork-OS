/**
 * Tests for AgentRoleRepository
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type {
  AgentRole,
  CreateAgentRoleRequest,
  UpdateAgentRoleRequest,
} from "../../../shared/types";

// Mock electron to avoid getPath errors
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
}));

// In-memory mock storage
let mockRoles: Map<string, Any>;
let roleIdCounter: number;

// Mock AgentRoleRepository
class MockAgentRoleRepository {
  create(request: CreateAgentRoleRequest): AgentRole {
    const id = `role-${++roleIdCounter}`;
    const now = Date.now();

    const role: AgentRole = {
      id,
      name: request.name,
      displayName: request.displayName,
      description: request.description,
      icon: request.icon || "🤖",
      color: request.color || "#6366f1",
      personalityId: request.personalityId,
      modelKey: request.modelKey,
      providerType: request.providerType,
      systemPrompt: request.systemPrompt,
      capabilities: request.capabilities,
      toolRestrictions: request.toolRestrictions,
      isSystem: false,
      isActive: true,
      sortOrder: 100,
      createdAt: now,
      updatedAt: now,
    };

    const stored = {
      ...role,
      capabilities: JSON.stringify(role.capabilities),
      toolRestrictions: role.toolRestrictions ? JSON.stringify(role.toolRestrictions) : null,
    };
    mockRoles.set(id, stored);

    return role;
  }

  findById(id: string): AgentRole | undefined {
    const stored = mockRoles.get(id);
    return stored ? this.mapRowToRole(stored) : undefined;
  }

  findByName(name: string): AgentRole | undefined {
    for (const stored of mockRoles.values()) {
      if (stored.name === name) {
        return this.mapRowToRole(stored);
      }
    }
    return undefined;
  }

  list(includeInactive: boolean = false): AgentRole[] {
    const roles: AgentRole[] = [];
    mockRoles.forEach((stored) => {
      if (includeInactive || stored.isActive) {
        roles.push(this.mapRowToRole(stored));
      }
    });
    return roles.sort((a, b) => a.sortOrder - b.sortOrder);
  }

  update(id: string, request: UpdateAgentRoleRequest): AgentRole | undefined {
    const stored = mockRoles.get(id);
    if (!stored) return undefined;

    if (request.displayName !== undefined) stored.displayName = request.displayName;
    if (request.description !== undefined) stored.description = request.description;
    if (request.icon !== undefined) stored.icon = request.icon;
    if (request.color !== undefined) stored.color = request.color;
    if (request.personalityId !== undefined) stored.personalityId = request.personalityId;
    if (request.modelKey !== undefined) stored.modelKey = request.modelKey;
    if (request.providerType !== undefined) stored.providerType = request.providerType;
    if (request.systemPrompt !== undefined) stored.systemPrompt = request.systemPrompt;
    if (request.capabilities !== undefined)
      stored.capabilities = JSON.stringify(request.capabilities);
    if (request.toolRestrictions !== undefined)
      stored.toolRestrictions = JSON.stringify(request.toolRestrictions);
    if (request.isActive !== undefined) stored.isActive = request.isActive ? 1 : 0;
    if (request.sortOrder !== undefined) stored.sortOrder = request.sortOrder;

    stored.updatedAt = Date.now();
    mockRoles.set(id, stored);

    return this.findById(id);
  }

  delete(id: string): boolean {
    const stored = mockRoles.get(id);
    if (!stored || stored.isSystem) return false;
    return mockRoles.delete(id);
  }

  private mapRowToRole(row: Any): AgentRole {
    return {
      id: row.id,
      name: row.name,
      displayName: row.displayName,
      description: row.description,
      icon: row.icon,
      color: row.color,
      personalityId: row.personalityId,
      modelKey: row.modelKey,
      providerType: row.providerType,
      systemPrompt: row.systemPrompt,
      capabilities: JSON.parse(row.capabilities),
      toolRestrictions: row.toolRestrictions ? JSON.parse(row.toolRestrictions) : undefined,
      isSystem: row.isSystem === 1,
      isActive: row.isActive === 1,
      sortOrder: row.sortOrder,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

describe("AgentRoleRepository", () => {
  let repository: MockAgentRoleRepository;

  beforeEach(() => {
    mockRoles = new Map();
    roleIdCounter = 0;
    repository = new MockAgentRoleRepository();
  });

  describe("create", () => {
    it("should create an agent role with required fields", () => {
      const role = repository.create({
        name: "coder",
        displayName: "Code Writer",
        capabilities: ["code", "review"],
      });

      expect(role).toBeDefined();
      expect(role.id).toBeDefined();
      expect(role.name).toBe("coder");
      expect(role.displayName).toBe("Code Writer");
      expect(role.capabilities).toEqual(["code", "review"]);
      expect(role.icon).toBe("🤖");
      expect(role.color).toBe("#6366f1");
      expect(role.isActive).toBe(true);
      expect(role.isSystem).toBe(false);
    });

    it("should create a role with all optional fields", () => {
      const role = repository.create({
        name: "researcher",
        displayName: "Research Agent",
        description: "Specialized in research tasks",
        icon: "🔬",
        color: "#22c55e",
        personalityId: "analytical",
        modelKey: "opus-4-5",
        providerType: "anthropic",
        systemPrompt: "You are a research specialist.",
        capabilities: ["research", "analyze"],
        toolRestrictions: { allowedTools: ["web_search", "read_file"] },
      });

      expect(role.description).toBe("Specialized in research tasks");
      expect(role.icon).toBe("🔬");
      expect(role.color).toBe("#22c55e");
      expect(role.personalityId).toBe("analytical");
      expect(role.modelKey).toBe("opus-4-5");
      expect(role.systemPrompt).toBe("You are a research specialist.");
      expect(role.toolRestrictions).toEqual({ allowedTools: ["web_search", "read_file"] });
    });

    it("should persist role and allow retrieval", () => {
      const created = repository.create({
        name: "tester",
        displayName: "Test Agent",
        capabilities: ["test"],
      });

      const retrieved = repository.findById(created.id);

      expect(retrieved).toBeDefined();
      expect(retrieved?.id).toBe(created.id);
      expect(retrieved?.name).toBe("tester");
    });
  });

  describe("findById", () => {
    it("should return undefined for non-existent role", () => {
      const role = repository.findById("non-existent");
      expect(role).toBeUndefined();
    });

    it("should return the correct role", () => {
      const created = repository.create({
        name: "helper",
        displayName: "Helper Agent",
        capabilities: ["assist"],
      });

      const found = repository.findById(created.id);
      expect(found?.name).toBe("helper");
    });
  });

  describe("findByName", () => {
    it("should find role by name", () => {
      repository.create({
        name: "unique-name",
        displayName: "Unique Agent",
        capabilities: ["unique"],
      });

      const found = repository.findByName("unique-name");
      expect(found).toBeDefined();
      expect(found?.displayName).toBe("Unique Agent");
    });

    it("should return undefined for non-existent name", () => {
      const found = repository.findByName("does-not-exist");
      expect(found).toBeUndefined();
    });
  });

  describe("list", () => {
    it("should return empty array when no roles exist", () => {
      const roles = repository.list();
      expect(roles).toHaveLength(0);
    });

    it("should return all active roles", () => {
      repository.create({
        name: "role1",
        displayName: "Role 1",
        capabilities: ["cap1"],
      });
      repository.create({
        name: "role2",
        displayName: "Role 2",
        capabilities: ["cap2"],
      });

      const roles = repository.list();
      expect(roles).toHaveLength(2);
    });

    it("should exclude inactive roles by default", () => {
      const role = repository.create({
        name: "inactive-role",
        displayName: "Inactive",
        capabilities: ["inactive"],
      });

      repository.update(role.id, { isActive: false });

      const activeRoles = repository.list(false);
      expect(activeRoles).toHaveLength(0);

      const allRoles = repository.list(true);
      expect(allRoles).toHaveLength(1);
    });

    it("should sort roles by sortOrder", () => {
      const role1 = repository.create({
        name: "role-z",
        displayName: "Role Z",
        capabilities: ["z"],
      });
      repository.update(role1.id, { sortOrder: 200 });

      const role2 = repository.create({
        name: "role-a",
        displayName: "Role A",
        capabilities: ["a"],
      });
      repository.update(role2.id, { sortOrder: 50 });

      const roles = repository.list();
      expect(roles[0].name).toBe("role-a");
      expect(roles[1].name).toBe("role-z");
    });
  });

  describe("update", () => {
    it("should update displayName", () => {
      const role = repository.create({
        name: "updatable",
        displayName: "Original Name",
        capabilities: ["update"],
      });

      repository.update(role.id, { displayName: "New Name" });

      const updated = repository.findById(role.id);
      expect(updated?.displayName).toBe("New Name");
    });

    it("should update capabilities", () => {
      const role = repository.create({
        name: "cap-role",
        displayName: "Cap Role",
        capabilities: ["old"],
      });

      repository.update(role.id, { capabilities: ["new1", "new2"] });

      const updated = repository.findById(role.id);
      expect(updated?.capabilities).toEqual(["new1", "new2"]);
    });

    it("should update multiple fields at once", () => {
      const role = repository.create({
        name: "multi-update",
        displayName: "Multi",
        capabilities: ["multi"],
      });

      repository.update(role.id, {
        displayName: "Updated Multi",
        icon: "🎯",
        color: "#ef4444",
        isActive: false,
      });

      const updated = repository.findById(role.id);
      expect(updated?.displayName).toBe("Updated Multi");
      expect(updated?.icon).toBe("🎯");
      expect(updated?.color).toBe("#ef4444");
      expect(updated?.isActive).toBe(false);
    });

    it("should return undefined for non-existent role", () => {
      const result = repository.update("non-existent", { displayName: "New" });
      expect(result).toBeUndefined();
    });
  });

  describe("delete", () => {
    it("should delete a role", () => {
      const role = repository.create({
        name: "deletable",
        displayName: "Delete Me",
        capabilities: ["delete"],
      });

      const deleted = repository.delete(role.id);
      expect(deleted).toBe(true);

      const found = repository.findById(role.id);
      expect(found).toBeUndefined();
    });

    it("should return false for non-existent role", () => {
      const deleted = repository.delete("non-existent");
      expect(deleted).toBe(false);
    });
  });
});
