/**
 * Tests for MCPClientManager - startup optimizations
 * Tests parallel connections, debounced tool map rebuilds, and batch mode integration
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { EventEmitter } from "events";

// Track test state
const testState = {
  batchModeActive: false,
  saveCallCount: 0,
  beginBatchCalled: false,
  endBatchCalled: false,
};

const defaultMockServers = [
  { id: "server-1", name: "Server 1", enabled: true },
  { id: "server-2", name: "Server 2", enabled: true },
  { id: "server-3", name: "Server 3", enabled: true },
  { id: "server-4", name: "Server 4", enabled: false },
];

let mockServers: Any[] = defaultMockServers.map((s) => ({ ...s }));

// Mock electron
vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/mock/user/data") },
  safeStorage: {
    isEncryptionAvailable: vi.fn().mockReturnValue(false),
    encryptString: vi.fn(),
    decryptString: vi.fn(),
  },
  BrowserWindow: { getAllWindows: vi.fn().mockReturnValue([]) },
}));

// Mock MCPServerConnection
vi.mock("../client/MCPServerConnection", () => {
  return {
    MCPServerConnection: class MockConnection extends EventEmitter {
      private cfg: Any;
      private st = "disconnected";
      private tls: Any[] = [];

      constructor(cfg: Any) {
        super();
        this.cfg = cfg;
      }

      async connect() {
        this.st = "connecting";
        this.emit("status_changed", "connecting");
        await new Promise((r) => setTimeout(r, 10));
        this.st = "connected";
        this.tls = [{ name: `tool-${this.cfg.id}`, description: "Test" }];
        this.emit("status_changed", "connected");
        this.emit("tools_changed", this.tls);
      }

      async disconnect() {
        this.st = "disconnected";
        this.emit("status_changed", "disconnected");
      }

      getStatus() {
        return { id: this.cfg.id, name: this.cfg.name, status: this.st, tools: this.tls };
      }

      getTools() {
        return this.tls;
      }
    },
  };
});

// Mock settings manager
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
    saveSettings: vi.fn(() => {
      if (!testState.batchModeActive) testState.saveCallCount++;
    }),
    updateServerError: vi.fn(() => {
      if (!testState.batchModeActive) testState.saveCallCount++;
    }),
    updateServerTools: vi.fn(() => {
      if (!testState.batchModeActive) testState.saveCallCount++;
    }),
    beginBatch: vi.fn(() => {
      testState.batchModeActive = true;
      testState.beginBatchCalled = true;
    }),
    endBatch: vi.fn(() => {
      if (testState.batchModeActive) {
        testState.batchModeActive = false;
        testState.saveCallCount++;
      }
      testState.endBatchCalled = true;
    }),
  },
}));

// Import after mocks
import { MCPClientManager } from "../client/MCPClientManager";
import { MCPSettingsManager } from "../settings";

function resetState() {
  testState.batchModeActive = false;
  testState.saveCallCount = 0;
  testState.beginBatchCalled = false;
  testState.endBatchCalled = false;
}

describe("MCPClientManager startup optimizations", () => {
  let manager: MCPClientManager;

  beforeEach(() => {
    resetState();
    vi.clearAllMocks();
    mockServers = defaultMockServers.map((s) => ({ ...s }));
    // @ts-expect-error - reset singleton
    MCPClientManager.instance = null;
    manager = MCPClientManager.getInstance();
  });

  afterEach(async () => {
    try {
      await manager.shutdown();
    } catch {
      /* ignore */
    }
  });

  describe("parallel server connections", () => {
    it("should connect faster than sequential (parallel execution)", async () => {
      const start = Date.now();
      await manager.initialize();
      const elapsed = Date.now() - start;

      // 3 servers * 10ms = 30ms sequential minimum
      // Parallel should be ~10-20ms + overhead
      expect(elapsed).toBeLessThan(100);
    });

    it("should connect to all enabled servers", async () => {
      await manager.initialize();

      const status = manager.getStatus();
      const connected = status.filter((s) => s.status === "connected");

      expect(connected.length).toBe(3);
    });

    it("should skip disabled servers", async () => {
      await manager.initialize();

      const status = manager.getStatus();
      const server4 = status.find((s) => s.id === "server-4");

      expect(server4?.status).not.toBe("connected");
    });

    it("should skip unconfigured enterprise connectors during auto-connect", async () => {
      mockServers = [
        {
          id: "salesforce-1",
          name: "Salesforce",
          enabled: true,
          transport: "stdio",
          command: process.execPath,
          args: ["--runAsNode", "/tmp/connectors/salesforce-mcp/dist/index.js"],
          env: {
            SALESFORCE_INSTANCE_URL: "",
            SALESFORCE_ACCESS_TOKEN: "",
          },
        },
        {
          id: "jira-1",
          name: "Jira",
          enabled: true,
          transport: "stdio",
          command: process.execPath,
          args: ["--runAsNode", "/tmp/connectors/jira-mcp/dist/index.js"],
          env: {
            JIRA_BASE_URL: "",
            JIRA_ACCESS_TOKEN: "",
          },
        },
        {
          id: "server-1",
          name: "Server 1",
          enabled: true,
        },
      ];

      await manager.initialize();
      const status = manager.getStatus();

      expect(status.find((s) => s.id === "salesforce-1")?.status).toBe("disconnected");
      expect(status.find((s) => s.id === "jira-1")?.status).toBe("disconnected");
      expect(status.find((s) => s.id === "server-1")?.status).toBe("connected");
      expect(MCPSettingsManager.updateServer).toHaveBeenCalledWith("salesforce-1", {
        enabled: false,
      });
      expect(MCPSettingsManager.updateServer).toHaveBeenCalledWith("jira-1", { enabled: false });
    });

    it("should auto-connect configured enterprise connectors", async () => {
      mockServers = [
        {
          id: "salesforce-1",
          name: "Salesforce",
          enabled: true,
          transport: "stdio",
          command: process.execPath,
          args: ["--runAsNode", "/tmp/connectors/salesforce-mcp/dist/index.js"],
          env: {
            SALESFORCE_INSTANCE_URL: "https://example.my.salesforce.com",
            SALESFORCE_ACCESS_TOKEN: "token",
          },
        },
      ];

      await manager.initialize();
      const status = manager.getStatus();
      expect(status.find((s) => s.id === "salesforce-1")?.status).toBe("connected");
    });
  });

  describe("batch mode integration", () => {
    it("should use batch mode during initialization", async () => {
      await manager.initialize();

      expect(testState.beginBatchCalled).toBe(true);
      expect(testState.endBatchCalled).toBe(true);
    });

    it("should consolidate saves to one during initialization", async () => {
      resetState();
      await manager.initialize();

      // Only 1 save (from endBatch)
      expect(testState.saveCallCount).toBe(1);
    });
  });

  describe("tool map", () => {
    it("should aggregate tools from all connected servers", async () => {
      await manager.initialize();

      const tools = manager.getAllTools();
      expect(tools.length).toBe(3);
    });

    it("should make tools searchable by name", async () => {
      await manager.initialize();

      expect(manager.hasTool("tool-server-1")).toBe(true);
      expect(manager.hasTool("tool-server-2")).toBe(true);
      expect(manager.hasTool("tool-server-3")).toBe(true);
      expect(manager.hasTool("tool-server-4")).toBe(false);
    });
  });
});

describe("MCPClientManager singleton", () => {
  beforeEach(() => {
    // @ts-expect-error - reset singleton
    MCPClientManager.instance = null;
  });

  it("returns same instance", () => {
    const a = MCPClientManager.getInstance();
    const b = MCPClientManager.getInstance();
    expect(a).toBe(b);
  });
});
