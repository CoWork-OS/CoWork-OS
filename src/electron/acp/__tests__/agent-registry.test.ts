import { describe, it, expect, beforeEach } from "vitest";
import { ACPAgentRegistry } from "../agent-registry";

const makeRole = (
  overrides: Partial<{
    id: string;
    name: string;
    displayName: string;
    description: string;
    icon: string;
    capabilities: string[];
    isActive: boolean;
  }> = {},
) => ({
  id: overrides.id ?? "role-1",
  name: overrides.name ?? "coder",
  displayName: overrides.displayName ?? "Coder",
  description: overrides.description ?? "Writes code",
  icon: overrides.icon ?? "💻",
  capabilities: overrides.capabilities ?? ["code", "document"],
  isActive: overrides.isActive ?? true,
});

describe("ACPAgentRegistry", () => {
  let registry: ACPAgentRegistry;

  beforeEach(() => {
    registry = new ACPAgentRegistry();
  });

  describe("local agents", () => {
    it("converts active roles to agent cards", () => {
      const roles = [
        makeRole(),
        makeRole({ name: "reviewer", displayName: "Reviewer", capabilities: ["review"] }),
      ];
      const agents = registry.getLocalAgents(roles);
      expect(agents).toHaveLength(2);
      expect(agents[0].id).toBe("local:coder");
      expect(agents[0].name).toBe("Coder");
      expect(agents[0].origin).toBe("local");
      expect(agents[0].capabilities).toEqual([
        { id: "code", name: "Code" },
        { id: "document", name: "Document" },
      ]);
    });

    it("excludes inactive roles", () => {
      const roles = [makeRole({ isActive: false })];
      const agents = registry.getLocalAgents(roles);
      expect(agents).toHaveLength(0);
    });
  });

  describe("remote agents", () => {
    it("registers and retrieves remote agents", () => {
      const card = registry.registerRemoteAgent({
        name: "External Bot",
        description: "An external agent",
        capabilities: [{ id: "analyze", name: "Analyze" }],
      });

      expect(card.id).toMatch(/^remote:/);
      expect(card.name).toBe("External Bot");
      expect(card.origin).toBe("remote");
      expect(card.status).toBe("available");
      expect(registry.remoteAgentCount).toBe(1);
    });

    it("unregisters remote agents", () => {
      const card = registry.registerRemoteAgent({
        name: "Bot",
        description: "Test",
      });
      expect(registry.unregisterRemoteAgent(card.id)).toBe(true);
      expect(registry.remoteAgentCount).toBe(0);
    });

    it("returns false when unregistering unknown agent", () => {
      expect(registry.unregisterRemoteAgent("remote:unknown")).toBe(false);
    });

    it("updates agent status", () => {
      const card = registry.registerRemoteAgent({
        name: "Bot",
        description: "Test",
      });
      expect(registry.updateAgentStatus(card.id, "busy")).toBe(true);
      const retrieved = registry.getAgent(card.id, []);
      expect(retrieved?.status).toBe("busy");
    });

    it("rejects nested inline secrets and endpoint user-info", () => {
      expect(() =>
        registry.registerRemoteAgent({
          name: "Unsafe",
          description: "Nested secret",
          metadata: { headers: { authorization: "Bearer plaintext" } },
        }),
      ).toThrow("metadata.credentialRef");
      expect(() =>
        registry.registerRemoteAgent({
          name: "Unsafe URL",
          description: "URL secret",
          endpoint: "https://user:password@example.com/a2a",
        }),
      ).toThrow("cannot contain credentials");
    });
  });

  describe("discover", () => {
    it("returns all agents with no filters", () => {
      registry.registerRemoteAgent({ name: "Remote", description: "Remote agent" });
      const roles = [makeRole()];
      const agents = registry.discover({}, roles);
      expect(agents).toHaveLength(2); // 1 local + 1 remote
    });

    it("filters by capability", () => {
      const roles = [
        makeRole({ name: "coder", capabilities: ["code"] }),
        makeRole({ name: "reviewer", displayName: "Reviewer", capabilities: ["review"] }),
      ];
      const agents = registry.discover({ capability: "review" }, roles);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("Reviewer");
    });

    it("filters by origin", () => {
      registry.registerRemoteAgent({ name: "Remote", description: "Remote agent" });
      const roles = [makeRole()];
      const agents = registry.discover({ origin: "remote" }, roles);
      expect(agents).toHaveLength(1);
      expect(agents[0].origin).toBe("remote");
    });

    it("filters by status", () => {
      const card = registry.registerRemoteAgent({ name: "Remote", description: "Remote agent" });
      registry.updateAgentStatus(card.id, "offline");
      const roles = [makeRole()];
      const agents = registry.discover({ status: "available" }, roles);
      expect(agents.every((a) => a.status === "available")).toBe(true);
    });

    it("filters by query", () => {
      registry.registerRemoteAgent({
        name: "Data Analyst",
        description: "Analyzes data",
        skills: ["pandas"],
      });
      const roles = [makeRole()];
      const agents = registry.discover({ query: "data" }, roles);
      expect(agents).toHaveLength(1);
      expect(agents[0].name).toBe("Data Analyst");
    });
  });

  describe("getAgent", () => {
    it("retrieves local agent by ID", () => {
      const roles = [makeRole()];
      const agent = registry.getAgent("local:coder", roles);
      expect(agent).toBeDefined();
      expect(agent?.localRoleId).toBe("role-1");
    });

    it("retrieves remote agent by ID", () => {
      const card = registry.registerRemoteAgent({ name: "Remote", description: "Test" });
      const agent = registry.getAgent(card.id, []);
      expect(agent).toBeDefined();
      expect(agent?.name).toBe("Remote");
    });

    it("returns undefined for unknown ID", () => {
      expect(registry.getAgent("local:nonexistent", [])).toBeUndefined();
    });
  });

  describe("messaging", () => {
    it("pushes and retrieves messages", () => {
      const msg = {
        id: "msg-1",
        from: "client:abc",
        to: "local:coder",
        contentType: "text/plain" as const,
        body: "Hello",
        timestamp: Date.now(),
      };
      registry.pushMessage("local:coder", msg);
      const messages = registry.getMessages("local:coder");
      expect(messages).toHaveLength(1);
      expect(messages[0].body).toBe("Hello");
    });

    it("drains messages when requested", () => {
      const msg = {
        id: "msg-1",
        from: "client:abc",
        to: "local:coder",
        contentType: "text/plain" as const,
        body: "Hello",
        timestamp: Date.now(),
      };
      registry.pushMessage("local:coder", msg);
      const messages = registry.getMessages("local:coder", true);
      expect(messages).toHaveLength(1);
      const after = registry.getMessages("local:coder");
      expect(after).toHaveLength(0);
    });

    it("returns empty array for unknown agent", () => {
      expect(registry.getMessages("unknown")).toEqual([]);
    });
  });

  describe("clear", () => {
    it("removes all remote agents and messages", () => {
      registry.registerRemoteAgent({ name: "Bot", description: "Test" });
      registry.pushMessage("test", {
        id: "msg",
        from: "a",
        to: "test",
        contentType: "text/plain",
        body: "Hi",
        timestamp: Date.now(),
      });
      registry.clear();
      expect(registry.remoteAgentCount).toBe(0);
      expect(registry.getMessages("test")).toEqual([]);
    });
  });
});
