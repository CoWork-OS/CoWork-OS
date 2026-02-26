/**
 * Tests for ContextPolicyManager
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ContextPolicy, SecurityMode, ContextType } from "../../../shared/types";

// Mock electron to avoid getPath errors
vi.mock("electron", () => ({
  app: {
    getPath: vi.fn().mockReturnValue("/tmp/test-cowork"),
  },
}));

// In-memory mock storage
let mockPolicies: Map<string, Any>;
let policyIdCounter: number;

// Default tool restrictions for group contexts
const DEFAULT_GROUP_TOOL_RESTRICTIONS = ["group:memory"];

// Mock ContextPolicyManager
class MockContextPolicyManager {
  getPolicy(channelId: string, contextType: ContextType): ContextPolicy {
    const existing = this.findPolicy(channelId, contextType);
    if (existing) {
      return existing;
    }
    return this.createDefaultPolicy(channelId, contextType);
  }

  getPolicyForChat(channelId: string, _chatId: string, isGroup: boolean): ContextPolicy {
    const contextType: ContextType = isGroup ? "group" : "dm";
    return this.getPolicy(channelId, contextType);
  }

  findPolicy(channelId: string, contextType: ContextType): ContextPolicy | null {
    for (const stored of mockPolicies.values()) {
      if (stored.channelId === channelId && stored.contextType === contextType) {
        return this.mapRowToPolicy(stored);
      }
    }
    return null;
  }

  getPoliciesForChannel(channelId: string): ContextPolicy[] {
    const policies: ContextPolicy[] = [];
    mockPolicies.forEach((stored) => {
      if (stored.channelId === channelId) {
        policies.push(this.mapRowToPolicy(stored));
      }
    });
    return policies;
  }

  create(options: {
    channelId: string;
    contextType: ContextType;
    securityMode?: SecurityMode;
    toolRestrictions?: string[];
  }): ContextPolicy {
    const now = Date.now();
    const id = `policy-${++policyIdCounter}`;

    const securityMode = options.securityMode || "pairing";
    const toolRestrictions =
      options.toolRestrictions ||
      (options.contextType === "group" ? DEFAULT_GROUP_TOOL_RESTRICTIONS : []);

    const policy: ContextPolicy = {
      id,
      channelId: options.channelId,
      contextType: options.contextType,
      securityMode,
      toolRestrictions,
      createdAt: now,
      updatedAt: now,
    };

    mockPolicies.set(id, { ...policy });
    return policy;
  }

  update(
    id: string,
    options: { securityMode?: SecurityMode; toolRestrictions?: string[] },
  ): ContextPolicy | null {
    const stored = mockPolicies.get(id);
    if (!stored) {
      return null;
    }

    const now = Date.now();
    const updated = {
      ...stored,
      securityMode: options.securityMode ?? stored.securityMode,
      toolRestrictions: options.toolRestrictions ?? stored.toolRestrictions,
      updatedAt: now,
    };

    mockPolicies.set(id, updated);
    return this.mapRowToPolicy(updated);
  }

  updateByContext(
    channelId: string,
    contextType: ContextType,
    options: { securityMode?: SecurityMode; toolRestrictions?: string[] },
  ): ContextPolicy {
    const policy = this.findPolicy(channelId, contextType);

    if (!policy) {
      return this.create({
        channelId,
        contextType,
        securityMode: options.securityMode,
        toolRestrictions: options.toolRestrictions,
      });
    }

    const updated = this.update(policy.id, options);
    return updated || policy;
  }

  delete(id: string): boolean {
    return mockPolicies.delete(id);
  }

  deleteByChannel(channelId: string): number {
    let count = 0;
    const toDelete: string[] = [];
    mockPolicies.forEach((stored, id) => {
      if (stored.channelId === channelId) {
        toDelete.push(id);
      }
    });
    toDelete.forEach((id) => {
      mockPolicies.delete(id);
      count++;
    });
    return count;
  }

  isToolAllowed(
    channelId: string,
    contextType: ContextType,
    toolName: string,
    toolGroups: string[],
  ): boolean {
    const policy = this.getPolicy(channelId, contextType);
    const restrictions = policy.toolRestrictions || [];

    // Check if tool is directly restricted
    if (restrictions.includes(toolName)) {
      return false;
    }

    // Check if any of the tool's groups are restricted
    for (const group of toolGroups) {
      if (restrictions.includes(group)) {
        return false;
      }
    }

    return true;
  }

  getDeniedTools(channelId: string, contextType: ContextType): string[] {
    const policy = this.getPolicy(channelId, contextType);
    return policy.toolRestrictions || [];
  }

  createDefaultPolicies(channelId: string): void {
    this.createDefaultPolicy(channelId, "dm");
    this.createDefaultPolicy(channelId, "group");
  }

  private createDefaultPolicy(channelId: string, contextType: ContextType): ContextPolicy {
    const existing = this.findPolicy(channelId, contextType);
    if (existing) {
      return existing;
    }

    const toolRestrictions = contextType === "group" ? DEFAULT_GROUP_TOOL_RESTRICTIONS : [];

    return this.create({
      channelId,
      contextType,
      securityMode: "pairing",
      toolRestrictions,
    });
  }

  private mapRowToPolicy(row: Any): ContextPolicy {
    return {
      id: row.id,
      channelId: row.channelId,
      contextType: row.contextType as ContextType,
      securityMode: row.securityMode as SecurityMode,
      toolRestrictions: row.toolRestrictions || [],
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    };
  }
}

describe("ContextPolicyManager", () => {
  let manager: MockContextPolicyManager;

  beforeEach(() => {
    mockPolicies = new Map();
    policyIdCounter = 0;
    manager = new MockContextPolicyManager();
  });

  describe("create", () => {
    it("should create a DM policy with no restrictions", () => {
      const policy = manager.create({
        channelId: "channel-1",
        contextType: "dm",
      });

      expect(policy).toBeDefined();
      expect(policy.id).toBeDefined();
      expect(policy.channelId).toBe("channel-1");
      expect(policy.contextType).toBe("dm");
      expect(policy.securityMode).toBe("pairing");
      expect(policy.toolRestrictions).toEqual([]);
    });

    it("should create a group policy with default memory restrictions", () => {
      const policy = manager.create({
        channelId: "channel-1",
        contextType: "group",
      });

      expect(policy.contextType).toBe("group");
      expect(policy.toolRestrictions).toEqual(["group:memory"]);
    });

    it("should allow custom security mode", () => {
      const policy = manager.create({
        channelId: "channel-1",
        contextType: "dm",
        securityMode: "open",
      });

      expect(policy.securityMode).toBe("open");
    });

    it("should allow custom tool restrictions", () => {
      const policy = manager.create({
        channelId: "channel-1",
        contextType: "dm",
        toolRestrictions: ["clipboard_read", "clipboard_write"],
      });

      expect(policy.toolRestrictions).toEqual(["clipboard_read", "clipboard_write"]);
    });
  });

  describe("findPolicy", () => {
    it("should find an existing policy", () => {
      manager.create({
        channelId: "channel-1",
        contextType: "dm",
      });

      const found = manager.findPolicy("channel-1", "dm");
      expect(found).toBeDefined();
      expect(found?.channelId).toBe("channel-1");
      expect(found?.contextType).toBe("dm");
    });

    it("should return null for non-existent policy", () => {
      const found = manager.findPolicy("non-existent", "dm");
      expect(found).toBeNull();
    });

    it("should distinguish between DM and group policies", () => {
      manager.create({
        channelId: "channel-1",
        contextType: "dm",
        securityMode: "open",
      });

      manager.create({
        channelId: "channel-1",
        contextType: "group",
        securityMode: "pairing",
      });

      const dmPolicy = manager.findPolicy("channel-1", "dm");
      const groupPolicy = manager.findPolicy("channel-1", "group");

      expect(dmPolicy?.securityMode).toBe("open");
      expect(groupPolicy?.securityMode).toBe("pairing");
    });
  });

  describe("getPolicy", () => {
    it("should return existing policy if found", () => {
      const created = manager.create({
        channelId: "channel-1",
        contextType: "dm",
        securityMode: "allowlist",
      });

      const policy = manager.getPolicy("channel-1", "dm");
      expect(policy.id).toBe(created.id);
      expect(policy.securityMode).toBe("allowlist");
    });

    it("should create default policy if not found", () => {
      const policy = manager.getPolicy("channel-1", "dm");

      expect(policy).toBeDefined();
      expect(policy.channelId).toBe("channel-1");
      expect(policy.contextType).toBe("dm");
      expect(policy.securityMode).toBe("pairing");
    });

    it("should create group policy with default restrictions", () => {
      const policy = manager.getPolicy("channel-1", "group");

      expect(policy.contextType).toBe("group");
      expect(policy.toolRestrictions).toEqual(["group:memory"]);
    });
  });

  describe("getPolicyForChat", () => {
    it("should return DM policy for non-group chat", () => {
      manager.create({
        channelId: "channel-1",
        contextType: "dm",
        securityMode: "open",
      });

      const policy = manager.getPolicyForChat("channel-1", "chat-123", false);
      expect(policy.contextType).toBe("dm");
      expect(policy.securityMode).toBe("open");
    });

    it("should return group policy for group chat", () => {
      manager.create({
        channelId: "channel-1",
        contextType: "group",
        securityMode: "pairing",
      });

      const policy = manager.getPolicyForChat("channel-1", "chat-123", true);
      expect(policy.contextType).toBe("group");
    });
  });

  describe("getPoliciesForChannel", () => {
    it("should return all policies for a channel", () => {
      manager.create({ channelId: "channel-1", contextType: "dm" });
      manager.create({ channelId: "channel-1", contextType: "group" });
      manager.create({ channelId: "channel-2", contextType: "dm" });

      const policies = manager.getPoliciesForChannel("channel-1");
      expect(policies).toHaveLength(2);
    });

    it("should return empty array for channel with no policies", () => {
      const policies = manager.getPoliciesForChannel("non-existent");
      expect(policies).toHaveLength(0);
    });
  });

  describe("update", () => {
    it("should update security mode", () => {
      const created = manager.create({
        channelId: "channel-1",
        contextType: "dm",
        securityMode: "pairing",
      });

      const updated = manager.update(created.id, { securityMode: "open" });

      expect(updated).toBeDefined();
      expect(updated?.securityMode).toBe("open");
    });

    it("should update tool restrictions", () => {
      const created = manager.create({
        channelId: "channel-1",
        contextType: "dm",
        toolRestrictions: [],
      });

      const updated = manager.update(created.id, {
        toolRestrictions: ["clipboard_read"],
      });

      expect(updated?.toolRestrictions).toEqual(["clipboard_read"]);
    });

    it("should return null for non-existent policy", () => {
      const result = manager.update("non-existent", { securityMode: "open" });
      expect(result).toBeNull();
    });

    it("should preserve unchanged fields", () => {
      const created = manager.create({
        channelId: "channel-1",
        contextType: "dm",
        securityMode: "pairing",
        toolRestrictions: ["some_tool"],
      });

      const updated = manager.update(created.id, { securityMode: "open" });

      expect(updated?.securityMode).toBe("open");
      expect(updated?.toolRestrictions).toEqual(["some_tool"]);
    });
  });

  describe("updateByContext", () => {
    it("should update existing policy", () => {
      manager.create({
        channelId: "channel-1",
        contextType: "dm",
        securityMode: "pairing",
      });

      const updated = manager.updateByContext("channel-1", "dm", {
        securityMode: "allowlist",
      });

      expect(updated.securityMode).toBe("allowlist");
    });

    it("should create new policy if not exists", () => {
      const policy = manager.updateByContext("channel-1", "dm", {
        securityMode: "open",
      });

      expect(policy).toBeDefined();
      expect(policy.channelId).toBe("channel-1");
      expect(policy.securityMode).toBe("open");
    });
  });

  describe("delete", () => {
    it("should delete a policy", () => {
      const created = manager.create({
        channelId: "channel-1",
        contextType: "dm",
      });

      const deleted = manager.delete(created.id);
      expect(deleted).toBe(true);

      const found = manager.findPolicy("channel-1", "dm");
      expect(found).toBeNull();
    });

    it("should return false for non-existent policy", () => {
      const deleted = manager.delete("non-existent");
      expect(deleted).toBe(false);
    });
  });

  describe("deleteByChannel", () => {
    it("should delete all policies for a channel", () => {
      manager.create({ channelId: "channel-1", contextType: "dm" });
      manager.create({ channelId: "channel-1", contextType: "group" });
      manager.create({ channelId: "channel-2", contextType: "dm" });

      const count = manager.deleteByChannel("channel-1");

      expect(count).toBe(2);
      expect(manager.getPoliciesForChannel("channel-1")).toHaveLength(0);
      expect(manager.getPoliciesForChannel("channel-2")).toHaveLength(1);
    });

    it("should return 0 when no policies exist", () => {
      const count = manager.deleteByChannel("non-existent");
      expect(count).toBe(0);
    });
  });

  describe("isToolAllowed", () => {
    it("should allow tool not in restrictions", () => {
      manager.create({
        channelId: "channel-1",
        contextType: "dm",
        toolRestrictions: [],
      });

      const allowed = manager.isToolAllowed("channel-1", "dm", "read_file", []);
      expect(allowed).toBe(true);
    });

    it("should deny tool in restrictions", () => {
      manager.create({
        channelId: "channel-1",
        contextType: "dm",
        toolRestrictions: ["clipboard_read"],
      });

      const allowed = manager.isToolAllowed("channel-1", "dm", "clipboard_read", []);
      expect(allowed).toBe(false);
    });

    it("should deny tool if any group is restricted", () => {
      manager.create({
        channelId: "channel-1",
        contextType: "group",
        toolRestrictions: ["group:memory"],
      });

      const allowed = manager.isToolAllowed("channel-1", "group", "clipboard_read", [
        "group:memory",
        "group:system",
      ]);
      expect(allowed).toBe(false);
    });

    it("should allow tool if none of its groups are restricted", () => {
      manager.create({
        channelId: "channel-1",
        contextType: "group",
        toolRestrictions: ["group:network"],
      });

      const allowed = manager.isToolAllowed("channel-1", "group", "read_file", ["group:file"]);
      expect(allowed).toBe(true);
    });

    it("should use default restrictions for new group policy", () => {
      // Don't create policy, let getPolicy create default
      const allowed = manager.isToolAllowed("channel-1", "group", "clipboard_read", [
        "group:memory",
      ]);
      expect(allowed).toBe(false);
    });
  });

  describe("getDeniedTools", () => {
    it("should return tool restrictions", () => {
      manager.create({
        channelId: "channel-1",
        contextType: "dm",
        toolRestrictions: ["tool_a", "tool_b"],
      });

      const denied = manager.getDeniedTools("channel-1", "dm");
      expect(denied).toEqual(["tool_a", "tool_b"]);
    });

    it("should return default restrictions for group", () => {
      const denied = manager.getDeniedTools("channel-1", "group");
      expect(denied).toEqual(["group:memory"]);
    });

    it("should return empty array for DM with no restrictions", () => {
      const denied = manager.getDeniedTools("channel-1", "dm");
      expect(denied).toEqual([]);
    });
  });

  describe("createDefaultPolicies", () => {
    it("should create both DM and group policies", () => {
      manager.createDefaultPolicies("channel-1");

      const dmPolicy = manager.findPolicy("channel-1", "dm");
      const groupPolicy = manager.findPolicy("channel-1", "group");

      expect(dmPolicy).toBeDefined();
      expect(groupPolicy).toBeDefined();
    });

    it("should set correct defaults for each context", () => {
      manager.createDefaultPolicies("channel-1");

      const dmPolicy = manager.findPolicy("channel-1", "dm");
      const groupPolicy = manager.findPolicy("channel-1", "group");

      expect(dmPolicy?.toolRestrictions).toEqual([]);
      expect(groupPolicy?.toolRestrictions).toEqual(["group:memory"]);
    });

    it("should not overwrite existing policies", () => {
      manager.create({
        channelId: "channel-1",
        contextType: "dm",
        securityMode: "open",
      });

      manager.createDefaultPolicies("channel-1");

      const dmPolicy = manager.findPolicy("channel-1", "dm");
      expect(dmPolicy?.securityMode).toBe("open");
    });
  });

  describe("security modes", () => {
    it("should support open mode", () => {
      const policy = manager.create({
        channelId: "channel-1",
        contextType: "dm",
        securityMode: "open",
      });

      expect(policy.securityMode).toBe("open");
    });

    it("should support allowlist mode", () => {
      const policy = manager.create({
        channelId: "channel-1",
        contextType: "dm",
        securityMode: "allowlist",
      });

      expect(policy.securityMode).toBe("allowlist");
    });

    it("should support pairing mode", () => {
      const policy = manager.create({
        channelId: "channel-1",
        contextType: "dm",
        securityMode: "pairing",
      });

      expect(policy.securityMode).toBe("pairing");
    });
  });
});
