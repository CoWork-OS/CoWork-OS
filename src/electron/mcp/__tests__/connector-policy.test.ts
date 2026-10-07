/**
 * Admin policy `connectors.blocked` enforcement for MCP connectors: matching, connect refusal,
 * tool-call denial (including servers connected before the block), and restore on unblock.
 */

import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const policyState = vi.hoisted(() => ({
  blocked: [] as string[],
  subscriptions: new Map<string, string[]>(),
}));

vi.mock("../../admin/policies", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../admin/policies")>()),
  loadPolicies: vi.fn(() => ({ connectors: { blocked: [...policyState.blocked] } })),
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/mock/user/data") },
  safeStorage: {
    isEncryptionAvailable: vi.fn().mockReturnValue(false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
}));

vi.mock("../client/MCPServerConnection", () => ({
  MCPServerConnection: class MockConnection extends EventEmitter {
    private cfg: Any;
    private st = "disconnected";
    private tls: Any[] = [];

    constructor(cfg: Any) {
      super();
      this.cfg = cfg;
    }

    async connect() {
      this.st = "connected";
      this.tls = [{ name: `tool-${this.cfg.id}`, description: "Test" }];
      this.emit("status_changed", "connected");
      this.emit("tools_changed", this.tls);
    }

    async disconnect() {
      this.st = "disconnected";
      this.emit("status_changed", "disconnected");
    }

    async callTool(toolName: string, args: Record<string, Any> = {}, options: Any = {}) {
      await options.beforeSend?.();
      return { content: [{ type: "text", text: JSON.stringify({ tool: toolName, args }) }] };
    }

    getStatus() {
      return { id: this.cfg.id, name: this.cfg.name, status: this.st, tools: this.tls };
    }

    getTools() {
      return this.tls;
    }

    async syncResourceSubscriptions(uris: Iterable<string>) {
      policyState.subscriptions.set(this.cfg.id, [...uris]);
    }
  },
}));

let mockServers: Any[] = [];

vi.mock("../settings", () => ({
  MCPSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn(() => ({
      autoConnect: true,
      servers: mockServers,
      maxReconnectAttempts: 3,
      reconnectDelayMs: 1000,
    })),
    getServer: vi.fn((id: string) => mockServers.find((s) => s.id === id)),
    updateServer: vi.fn(),
    updateServerError: vi.fn(),
    updateServerTools: vi.fn(),
    beginBatch: vi.fn(),
    endBatch: vi.fn(),
  },
}));

import { MCPClientManager } from "../client/MCPClientManager";
import {
  CONNECTOR_BLOCKED_ERROR_CODE,
  ConnectorBlockedError,
  findBlockedConnectorId,
  getMcpServerConnectorIds,
} from "../connector-policy";
import type { AdminPolicies } from "../../admin/policies";

const policies = (blocked: string[]) => ({ connectors: { blocked } }) as AdminPolicies;

describe("connector policy matching", () => {
  const jira = {
    id: "8d0f5c1e-0000-4000-8000-000000000001",
    name: "Jira Cloud",
    registryId: "jira-registry",
    args: ["/app/connectors/jira-mcp/dist/index.js"],
  };

  it("collects every identity an administrator can block", () => {
    expect(getMcpServerConnectorIds(jira)).toEqual([
      jira.id,
      "jira-registry",
      "jira",
      "Jira Cloud",
    ]);
  });

  it.each([["jira"], ["JIRA "], ["jira-registry"], [jira.id], ["jira cloud"]])(
    "blocks on %j",
    (entry) => {
      expect(findBlockedConnectorId(jira, policies([entry]))).not.toBeNull();
    },
  );

  it("allows servers that match no blocked entry", () => {
    expect(findBlockedConnectorId(jira, policies([]))).toBeNull();
    expect(findBlockedConnectorId(jira, policies(["linear", "jira cloud beta"]))).toBeNull();
  });
});

describe("MCPClientManager connector policy", () => {
  let manager: MCPClientManager;

  beforeEach(() => {
    vi.clearAllMocks();
    policyState.blocked = [];
    mockServers = [
      { id: "server-1", name: "Allowed Server", enabled: true },
      { id: "server-2", name: "Blocked Server", enabled: true, registryId: "blocked-entry" },
    ];
    // @ts-expect-error - reset singleton
    MCPClientManager.instance = null;
    manager = MCPClientManager.getInstance();
  });

  afterEach(async () => {
    await manager.shutdown().catch(() => undefined);
  });

  it("does not start a blocked connector and reports it as blocked by administrator", async () => {
    policyState.blocked = ["blocked-entry"];
    await manager.initialize();

    const statuses = manager.getStatus();
    expect(statuses.find((s) => s.id === "server-1")?.status).toBe("connected");
    const blocked = statuses.find((s) => s.id === "server-2");
    expect(blocked?.status).toBe("disconnected");
    expect(blocked?.blockedByPolicy).toBe(true);
    expect(blocked?.error).toMatch(/blocked by your administrator/);
    expect(manager.hasTool("tool-server-2")).toBe(false);

    await expect(manager.connectServer("server-2")).rejects.toMatchObject({
      code: CONNECTOR_BLOCKED_ERROR_CODE,
      message: expect.stringContaining('"Blocked Server" is blocked by your administrator'),
    });
    await expect(manager.testServer("server-2")).resolves.toMatchObject({
      success: false,
      blockedByPolicy: true,
    });
    expect(manager.getServerStatus("server-2")?.blockedByPolicy).toBe(true);
  });

  it("denies tool calls on a connector blocked after it connected", async () => {
    await manager.initialize();
    await expect(manager.callTool("tool-server-2", {})).resolves.toBeDefined();

    policyState.blocked = ["Blocked Server"];

    const denied = manager.callTool("tool-server-2", {});
    await expect(denied).rejects.toBeInstanceOf(ConnectorBlockedError);
    await expect(denied).rejects.toThrow(/blocked by your administrator/);
    await expect(manager.callServerTool("server-2", "tool-server-2", {})).rejects.toBeInstanceOf(
      ConnectorBlockedError,
    );
    // Other connectors keep working.
    await expect(manager.callTool("tool-server-1", {})).resolves.toBeDefined();
  });

  it("re-checks the block right before send, after the caller's own checks", async () => {
    await manager.initialize();
    const beforeSend = vi.fn(async () => {
      // The block lands while the caller is still waiting (for example on an approval).
      policyState.blocked = ["server-2"];
    });

    await expect(manager.callTool("tool-server-2", {}, { beforeSend })).rejects.toBeInstanceOf(
      ConnectorBlockedError,
    );
    expect(beforeSend).toHaveBeenCalledTimes(1);
  });

  it("disconnects on block and restores the connector when the block is lifted", async () => {
    await manager.initialize();
    expect(manager.hasTool("tool-server-2")).toBe(true);

    policyState.blocked = ["blocked-entry"];
    await manager.reconcileConnectorPolicy();
    expect(manager.getServerStatus("server-2")?.status).toBe("disconnected");
    expect(manager.hasTool("tool-server-2")).toBe(false);

    policyState.blocked = [];
    await manager.reconcileConnectorPolicy();
    const restored = manager.getServerStatus("server-2");
    expect(restored?.status).toBe("connected");
    expect(restored?.blockedByPolicy).toBeUndefined();
    await expect(manager.callTool("tool-server-2", { q: 1 })).resolves.toMatchObject({
      content: [{ type: "text" }],
    });
  });

  it("restores a connector that was blocked at startup once unblocked", async () => {
    policyState.blocked = ["blocked-entry"];
    await manager.initialize();
    expect(manager.hasTool("tool-server-2")).toBe(false);

    policyState.blocked = [];
    await manager.reconcileConnectorPolicy();
    expect(manager.getServerStatus("server-2")?.status).toBe("connected");
    await expect(manager.callTool("tool-server-2", {})).resolves.toBeDefined();
  });

  it("drops connector events and resource subscriptions from a blocked server", async () => {
    await manager.initialize();
    const events: Any[] = [];
    manager.on("connector_event", (event) => events.push(event));
    const connection = (manager as Any).connections.get("server-2");

    policyState.blocked = ["server-2"];
    connection.emit("connector_event", { type: "resource_updated", uri: "res://b" });
    await manager.syncTriggerResourceSubscriptions([
      { serverId: "server-1", resourceUri: "res://a" },
      { serverId: "server-2", resourceUri: "res://b" },
    ]);

    expect(events).toEqual([]);
    expect(policyState.subscriptions.get("server-1")).toEqual(["res://a"]);
    expect(policyState.subscriptions.get("server-2")).toEqual([]);

    policyState.blocked = [];
    connection.emit("connector_event", { type: "resource_updated", uri: "res://b" });
    expect(events).toHaveLength(1);
  });

  it("does not reconnect a disabled server when its block is lifted", async () => {
    mockServers[1].enabled = false;
    policyState.blocked = ["blocked-entry"];
    await manager.initialize();
    policyState.blocked = [];
    await manager.reconcileConnectorPolicy();
    expect(manager.getServerStatus("server-2")?.status).toBe("disconnected");
  });
});
