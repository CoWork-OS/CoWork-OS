import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { registerACPMethods, getACPRegistry, shutdownACP, type ACPHandlerDeps } from "../handler";
import { ACPMethods } from "../types";
import { RemoteAgentInvoker } from "../remote-invoker";

/**
 * Mock ControlPlaneServer that captures registered method handlers
 */
class MockControlPlaneServer {
  handlers = new Map<string, (client: Any, params?: unknown) => Promise<unknown>>();

  registerMethod(method: string, handler: (client: Any, params?: unknown) => Promise<unknown>) {
    this.handlers.set(method, handler);
  }

  broadcast = vi.fn().mockReturnValue(1);

  async invoke(method: string, params?: unknown, client?: Any) {
    const handler = this.handlers.get(method);
    if (!handler) throw new Error(`No handler for method: ${method}`);
    return handler(client || mockClient, params);
  }
}

const mockClient = {
  id: "test-client",
  isAuthenticated: true,
  hasScope: () => true,
  isNode: false,
};

const unauthClient = {
  id: "unauth-client",
  isAuthenticated: false,
  hasScope: () => false,
  isNode: false,
};

function createScopedClient(id: string, scopes: Array<"admin" | "read" | "write" | "operator">) {
  const set = new Set(scopes);
  return {
    id,
    isAuthenticated: true,
    hasScope: (scope: "admin" | "read" | "write" | "operator") => set.has(scope),
    isNode: false,
  };
}

const defaultRoles = [
  {
    id: "role-coder",
    name: "coder",
    displayName: "Coder",
    description: "Writes code",
    icon: "💻",
    capabilities: ["code", "document"],
    isActive: true,
  },
  {
    id: "role-reviewer",
    name: "code-reviewer",
    displayName: "Code Reviewer",
    description: "Reviews code",
    icon: "🔍",
    capabilities: ["review"],
    isActive: true,
  },
];

class FakeDatabase {
  acpAgents: Array<Record<string, unknown>> = [];
  acpTasks: Array<Record<string, unknown>> = [];

  prepare(sql: string) {
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    return {
      all: (...args: unknown[]) => {
        if (normalized.includes("from acp_agents")) {
          return this.acpAgents
            .filter((row) => row.origin === "remote")
            .sort((a, b) => Number(b.registered_at || 0) - Number(a.registered_at || 0))
            .map((row) => ({ id: row.id, card_json: row.card_json }));
        }
        if (normalized.includes("from acp_tasks")) {
          return [...this.acpTasks].sort(
            (a, b) => Number(b.created_at || 0) - Number(a.created_at || 0),
          );
        }
        throw new Error(`Unsupported all() SQL in test: ${sql} :: ${args.length}`);
      },
      run: (...args: unknown[]) => {
        if (normalized.startsWith("insert into acp_agents")) {
          const [id, origin, endpoint, name, provider, status, registeredAt, updatedAt, cardJson] =
            args;
          const next = {
            id,
            origin,
            endpoint,
            name,
            provider,
            status,
            registered_at: registeredAt,
            updated_at: updatedAt,
            card_json: cardJson,
          };
          const index = this.acpAgents.findIndex((row) => row.id === id);
          if (index >= 0) this.acpAgents[index] = next;
          else this.acpAgents.push(next);
          return { changes: 1 };
        }
        if (normalized.startsWith("delete from acp_agents")) {
          const [id] = args;
          this.acpAgents = this.acpAgents.filter((row) => row.id !== id);
          return { changes: 1 };
        }
        if (normalized.startsWith("insert into acp_tasks")) {
          const [
            id,
            requesterId,
            assigneeId,
            title,
            prompt,
            status,
            result,
            error,
            coworkTaskId,
            remoteTaskId,
            workspaceId,
            createdAt,
            updatedAt,
            completedAt,
          ] = args;
          const next = {
            id,
            requester_id: requesterId,
            assignee_id: assigneeId,
            title,
            prompt,
            status,
            result,
            error,
            cowork_task_id: coworkTaskId,
            remote_task_id: remoteTaskId,
            workspace_id: workspaceId,
            created_at: createdAt,
            updated_at: updatedAt,
            completed_at: completedAt,
          };
          const index = this.acpTasks.findIndex((row) => row.id === id);
          if (index >= 0) this.acpTasks[index] = next;
          else this.acpTasks.push(next);
          return { changes: 1 };
        }
        throw new Error(`Unsupported run() SQL in test: ${sql} :: ${args.length}`);
      },
    };
  }

  close() {
    this.acpAgents = [];
    this.acpTasks = [];
  }
}

describe("ACP Handler", () => {
  let server: MockControlPlaneServer;
  let deps: ACPHandlerDeps;
  let db: FakeDatabase;

  beforeEach(() => {
    shutdownACP(); // Clean state between tests
    db = new FakeDatabase();
    server = new MockControlPlaneServer();
    deps = {
      db: db as Any,
      requireScope: (client, scope) => {
        if (!client?.hasScope?.(scope)) {
          throw { code: "UNAUTHORIZED", message: `Missing required scope: ${scope}` };
        }
      },
      getActiveRoles: () => defaultRoles,
      createTask: vi.fn().mockResolvedValue({ taskId: "task-123" }),
      getTask: vi.fn().mockReturnValue({ id: "task-123", status: "running" }),
      cancelTask: vi.fn().mockResolvedValue(undefined),
    };
    registerACPMethods(server as Any, deps);
  });

  afterEach(() => {
    db.close();
  });

  describe("acp.discover", () => {
    it("returns all agents with no filters", async () => {
      const result = (await server.invoke(ACPMethods.DISCOVER, {})) as Any;
      expect(result.agents).toHaveLength(2);
      expect(result.agents[0].origin).toBe("local");
    });

    it("filters by capability", async () => {
      const result = (await server.invoke(ACPMethods.DISCOVER, { capability: "review" })) as Any;
      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].name).toBe("Code Reviewer");
    });

    it("filters by query", async () => {
      const result = (await server.invoke(ACPMethods.DISCOVER, { query: "coder" })) as Any;
      expect(result.agents).toHaveLength(1);
    });

    it("rejects unauthenticated clients", async () => {
      await expect(server.invoke(ACPMethods.DISCOVER, {}, unauthClient)).rejects.toMatchObject({
        code: "UNAUTHORIZED",
      });
    });
  });

  describe("acp.agent.register", () => {
    it("registers a remote agent", async () => {
      const result = (await server.invoke(ACPMethods.AGENT_REGISTER, {
        name: "External Bot",
        description: "Does stuff",
        capabilities: [{ id: "analyze", name: "Analyze" }],
      })) as Any;

      expect(result.agent.id).toMatch(/^remote:/);
      expect(result.agent.name).toBe("External Bot");
      expect(server.broadcast).toHaveBeenCalledWith("acp.agent.registered", expect.any(Object));
    });

    it("rejects missing name", async () => {
      await expect(
        server.invoke(ACPMethods.AGENT_REGISTER, { description: "No name" }),
      ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    });
  });

  describe("acp.agent.get", () => {
    it("retrieves local agent by ID", async () => {
      const result = (await server.invoke(ACPMethods.AGENT_GET, { agentId: "local:coder" })) as Any;
      expect(result.agent.name).toBe("Coder");
    });

    it("retrieves remote agent by ID", async () => {
      const reg = (await server.invoke(ACPMethods.AGENT_REGISTER, {
        name: "Bot",
        description: "Test",
      })) as Any;
      const result = (await server.invoke(ACPMethods.AGENT_GET, { agentId: reg.agent.id })) as Any;
      expect(result.agent.name).toBe("Bot");
    });

    it("rejects unknown agent ID", async () => {
      await expect(
        server.invoke(ACPMethods.AGENT_GET, { agentId: "local:nonexistent" }),
      ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    });
  });

  describe("acp.agent.unregister", () => {
    it("unregisters a remote agent", async () => {
      const reg = (await server.invoke(ACPMethods.AGENT_REGISTER, {
        name: "Bot",
        description: "Test",
      })) as Any;
      const result = (await server.invoke(ACPMethods.AGENT_UNREGISTER, {
        agentId: reg.agent.id,
      })) as Any;
      expect(result.ok).toBe(true);
      expect(server.broadcast).toHaveBeenCalledWith("acp.agent.unregistered", {
        agentId: reg.agent.id,
      });
    });

    it("rejects unregistering local agents", async () => {
      await expect(
        server.invoke(ACPMethods.AGENT_UNREGISTER, { agentId: "local:coder" }),
      ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    });
  });

  describe("acp.message.send", () => {
    it("sends a message to an agent", async () => {
      const result = (await server.invoke(ACPMethods.MESSAGE_SEND, {
        to: "local:coder",
        body: "Hello agent",
      })) as Any;
      expect(result.messageId).toBeDefined();
      expect(result.delivered).toBe(true);
      expect(server.broadcast).toHaveBeenCalledWith("acp.message.received", expect.any(Object));
    });

    it("rejects messages to unknown agents", async () => {
      await expect(
        server.invoke(ACPMethods.MESSAGE_SEND, { to: "local:nonexistent", body: "Hi" }),
      ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    });
  });

  describe("acp.message.list", () => {
    it("retrieves messages for an agent", async () => {
      await server.invoke(ACPMethods.MESSAGE_SEND, {
        to: "local:coder",
        body: "Message 1",
      });
      await server.invoke(ACPMethods.MESSAGE_SEND, {
        to: "local:coder",
        body: "Message 2",
      });
      const result = (await server.invoke(ACPMethods.MESSAGE_LIST, {
        agentId: "local:coder",
      })) as Any;
      expect(result.messages).toHaveLength(2);
    });

    it("drains messages when requested", async () => {
      await server.invoke(ACPMethods.MESSAGE_SEND, {
        to: "local:coder",
        body: "Message 1",
      });
      const result = (await server.invoke(ACPMethods.MESSAGE_LIST, {
        agentId: "local:coder",
        drain: true,
      })) as Any;
      expect(result.messages).toHaveLength(1);
      const after = (await server.invoke(ACPMethods.MESSAGE_LIST, {
        agentId: "local:coder",
      })) as Any;
      expect(after.messages).toHaveLength(0);
    });
  });

  describe("acp.task.create", () => {
    it("creates a task for a local agent", async () => {
      const result = (await server.invoke(ACPMethods.TASK_CREATE, {
        assigneeId: "local:coder",
        title: "Write tests",
        prompt: "Write unit tests for the ACP module",
        workspaceId: "ws-1",
      })) as Any;

      expect(result.task.id).toBeDefined();
      expect(result.task.assigneeId).toBe("local:coder");
      expect(result.task.status).toBe("running");
      expect(result.task.coworkTaskId).toBe("task-123");
      expect(deps.createTask).toHaveBeenCalled();
    });

    it("rejects unknown assignee", async () => {
      await expect(
        server.invoke(ACPMethods.TASK_CREATE, {
          assigneeId: "local:nonexistent",
          title: "Test",
          prompt: "Test",
        }),
      ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    });
  });

  describe("acp.task.get", () => {
    it("retrieves a task", async () => {
      const created = (await server.invoke(ACPMethods.TASK_CREATE, {
        assigneeId: "local:coder",
        title: "Test task",
        prompt: "Test prompt",
        workspaceId: "ws-1",
      })) as Any;

      const result = (await server.invoke(ACPMethods.TASK_GET, {
        taskId: created.task.id,
      })) as Any;

      expect(result.task.id).toBe(created.task.id);
    });

    it("rejects unknown task ID", async () => {
      await expect(
        server.invoke(ACPMethods.TASK_GET, { taskId: "nonexistent" }),
      ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    });
  });

  describe("acp.task.list", () => {
    it("lists tasks filtered by assignee", async () => {
      await server.invoke(ACPMethods.TASK_CREATE, {
        assigneeId: "local:coder",
        title: "Task 1",
        prompt: "Prompt 1",
        workspaceId: "ws-1",
      });
      await server.invoke(ACPMethods.TASK_CREATE, {
        assigneeId: "local:code-reviewer",
        title: "Task 2",
        prompt: "Prompt 2",
        workspaceId: "ws-1",
      });

      const result = (await server.invoke(ACPMethods.TASK_LIST, {
        assigneeId: "local:coder",
      })) as Any;

      expect(result.tasks).toHaveLength(1);
      expect(result.tasks[0].assigneeId).toBe("local:coder");
    });

    it("limits non-operator task listings to the caller's requester id", async () => {
      const clientA = createScopedClient("client-a", ["read", "write"]);
      const clientB = createScopedClient("client-b", ["read", "write"]);

      await server.invoke(
        ACPMethods.TASK_CREATE,
        {
          assigneeId: "local:coder",
          title: "Task A",
          prompt: "Prompt A",
        },
        clientA,
      );

      const result = (await server.invoke(ACPMethods.TASK_LIST, {}, clientB)) as Any;
      expect(result.tasks).toHaveLength(0);
    });
  });

  describe("acp.task.cancel", () => {
    it("cancels a running task", async () => {
      const created = (await server.invoke(ACPMethods.TASK_CREATE, {
        assigneeId: "local:coder",
        title: "Cancel me",
        prompt: "Test",
        workspaceId: "ws-1",
      })) as Any;

      const result = (await server.invoke(ACPMethods.TASK_CANCEL, {
        taskId: created.task.id,
      })) as Any;

      expect(result.task.status).toBe("cancelled");
      expect(deps.cancelTask).toHaveBeenCalledWith("task-123");
    });

    it("rejects cancelling completed tasks", async () => {
      const created = (await server.invoke(ACPMethods.TASK_CREATE, {
        assigneeId: "local:coder",
        title: "Done task",
        prompt: "Test",
        workspaceId: "ws-1",
      })) as Any;

      // Manually mark as completed
      const _reg = getACPRegistry();
      // Access via task.get to force status sync
      (deps.getTask as Any).mockReturnValue({ id: "task-123", status: "completed" });
      await server.invoke(ACPMethods.TASK_GET, { taskId: created.task.id });

      await expect(
        server.invoke(ACPMethods.TASK_CANCEL, { taskId: created.task.id }),
      ).rejects.toMatchObject({ code: "INVALID_PARAMS" });
    });

    it("cancels remote ACP tasks through the remote invoker", async () => {
      vi.spyOn(RemoteAgentInvoker.prototype, "invoke").mockResolvedValue({
        status: "running",
        remoteTaskId: "remote-task-1",
      });
      const cancelSpy = vi.spyOn(RemoteAgentInvoker.prototype, "cancel").mockResolvedValue({
        status: "cancelled",
      });

      const registered = (await server.invoke(ACPMethods.AGENT_REGISTER, {
        name: "Remote Bot",
        description: "Remote worker",
        endpoint: "https://example.com/acp",
      })) as Any;

      const created = (await server.invoke(ACPMethods.TASK_CREATE, {
        assigneeId: registered.agent.id,
        title: "Remote task",
        prompt: "Handle this remotely",
      })) as Any;

      const result = (await server.invoke(ACPMethods.TASK_CANCEL, {
        taskId: created.task.id,
      })) as Any;

      expect(result.task.status).toBe("cancelled");
      expect(cancelSpy).toHaveBeenCalledWith(
        expect.objectContaining({ id: registered.agent.id }),
        "remote-task-1",
      );
    });
  });

  describe("persistence", () => {
    it("reloads persisted ACP tasks after handler restart", async () => {
      const created = (await server.invoke(ACPMethods.TASK_CREATE, {
        assigneeId: "local:coder",
        title: "Persist me",
        prompt: "Survive restart",
      })) as Any;

      shutdownACP();
      server = new MockControlPlaneServer();
      registerACPMethods(server as Any, deps);

      const fetched = (await server.invoke(ACPMethods.TASK_GET, {
        taskId: created.task.id,
      })) as Any;

      expect(fetched.task.id).toBe(created.task.id);
      expect(fetched.task.title).toBe("Persist me");
    });
  });

  describe("method registration", () => {
    it("registers all 10 ACP methods", () => {
      expect(server.handlers.size).toBe(10);
      expect(server.handlers.has(ACPMethods.DISCOVER)).toBe(true);
      expect(server.handlers.has(ACPMethods.AGENT_GET)).toBe(true);
      expect(server.handlers.has(ACPMethods.AGENT_REGISTER)).toBe(true);
      expect(server.handlers.has(ACPMethods.AGENT_UNREGISTER)).toBe(true);
      expect(server.handlers.has(ACPMethods.MESSAGE_SEND)).toBe(true);
      expect(server.handlers.has(ACPMethods.MESSAGE_LIST)).toBe(true);
      expect(server.handlers.has(ACPMethods.TASK_CREATE)).toBe(true);
      expect(server.handlers.has(ACPMethods.TASK_GET)).toBe(true);
      expect(server.handlers.has(ACPMethods.TASK_LIST)).toBe(true);
      expect(server.handlers.has(ACPMethods.TASK_CANCEL)).toBe(true);
    });
  });
});
