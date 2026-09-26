/**
 * Tests for WebSocket Control Plane Client Management
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import { WebSocket } from "ws";
import { ControlPlaneClient, ClientRegistry } from "../client";

// Mock WebSocket
const createMockSocket = (readyState: number = WebSocket.OPEN): WebSocket => {
  return {
    readyState,
    send: vi.fn(),
    close: vi.fn(),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket;
};

describe("ControlPlaneClient", () => {
  let mockSocket: WebSocket;
  let client: ControlPlaneClient;

  beforeEach(() => {
    mockSocket = createMockSocket();
    client = new ControlPlaneClient(mockSocket, "127.0.0.1", "TestAgent/1.0", "http://localhost");
  });

  describe("constructor", () => {
    it("should initialize with provided values", () => {
      expect(client.info.remoteAddress).toBe("127.0.0.1");
      expect(client.info.userAgent).toBe("TestAgent/1.0");
      expect(client.info.origin).toBe("http://localhost");
      expect(client.info.authState).toBe("pending");
      expect(client.info.scopes).toEqual([]);
    });

    it("should generate unique id", () => {
      const client2 = new ControlPlaneClient(mockSocket, "127.0.0.1");
      expect(client.id).not.toBe(client2.id);
    });

    it("should generate auth nonce", () => {
      expect(client.info.authNonce).toBeDefined();
      expect(client.info.authNonce!.length).toBeGreaterThan(0);
    });

    it("should set timestamps", () => {
      const now = Date.now();
      expect(client.info.connectedAt).toBeLessThanOrEqual(now);
      expect(client.info.lastActivityAt).toBeLessThanOrEqual(now);
      expect(client.info.lastHeartbeatAt).toBeLessThanOrEqual(now);
    });
  });

  describe("isAuthenticated", () => {
    it("should return false when pending", () => {
      expect(client.isAuthenticated).toBe(false);
    });

    it("should return true when authenticated", () => {
      client.authenticate(["admin"]);
      expect(client.isAuthenticated).toBe(true);
    });

    it("should return false when rejected", () => {
      client.reject();
      expect(client.isAuthenticated).toBe(false);
    });
  });

  describe("isConnected", () => {
    it("should return true when socket is open", () => {
      expect(client.isConnected).toBe(true);
    });

    it("should return false when socket is closed", () => {
      mockSocket = createMockSocket(WebSocket.CLOSED);
      client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      expect(client.isConnected).toBe(false);
    });

    it("should return false when socket is closing", () => {
      mockSocket = createMockSocket(WebSocket.CLOSING);
      client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      expect(client.isConnected).toBe(false);
    });
  });

  describe("hasScope", () => {
    it("should return false for unauthenticated client", () => {
      expect(client.hasScope("read")).toBe(false);
    });

    it("should return true for granted scope", () => {
      client.authenticate(["read", "write"]);
      expect(client.hasScope("read")).toBe(true);
      expect(client.hasScope("write")).toBe(true);
    });

    it("should return false for non-granted scope", () => {
      client.authenticate(["read"]);
      expect(client.hasScope("write")).toBe(false);
    });

    it("should return true for any scope when admin", () => {
      client.authenticate(["admin"]);
      expect(client.hasScope("read")).toBe(true);
      expect(client.hasScope("write")).toBe(true);
      expect(client.hasScope("operator")).toBe(true);
    });
  });

  describe("authenticate", () => {
    it("should set auth state and scopes", () => {
      client.authenticate(["read", "write"], "TestDevice");

      expect(client.info.authState).toBe("authenticated");
      expect(client.info.scopes).toEqual(["read", "write"]);
      expect(client.info.deviceName).toBe("TestDevice");
    });

    it("should update last activity", () => {
      const before = client.info.lastActivityAt;
      client.authenticate(["admin"]);

      // Activity timestamp should be updated to current time or later
      expect(client.info.lastActivityAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe("reject", () => {
    it("should set auth state to rejected", () => {
      client.reject();
      expect(client.info.authState).toBe("rejected");
    });
  });

  describe("updateActivity", () => {
    it("should update lastActivityAt", () => {
      const before = client.info.lastActivityAt;
      client.updateActivity();
      expect(client.info.lastActivityAt).toBeGreaterThanOrEqual(before);
    });
  });

  describe("updateHeartbeat", () => {
    it("should update lastHeartbeatAt and lastActivityAt", () => {
      const beforeActivity = client.info.lastActivityAt;
      const beforeHeartbeat = client.info.lastHeartbeatAt;

      client.updateHeartbeat();

      expect(client.info.lastHeartbeatAt).toBeGreaterThanOrEqual(beforeHeartbeat);
      expect(client.info.lastActivityAt).toBeGreaterThanOrEqual(beforeActivity);
    });
  });

  describe("send", () => {
    it("should send frame to socket", () => {
      const result = client.send({
        type: "res",
        id: "test",
        ok: true,
      });

      expect(result).toBe(true);
      expect(mockSocket.send).toHaveBeenCalledWith(expect.stringContaining('"type":"res"'));
    });

    it("should return false when not connected", () => {
      mockSocket = createMockSocket(WebSocket.CLOSED);
      client = new ControlPlaneClient(mockSocket, "127.0.0.1");

      const result = client.send({
        type: "res",
        id: "test",
        ok: true,
      });

      expect(result).toBe(false);
      expect(mockSocket.send).not.toHaveBeenCalled();
    });
  });

  describe("sendEvent", () => {
    it("should send event frame with sequence number", () => {
      client.sendEvent("heartbeat", { ts: 123 });

      expect(mockSocket.send).toHaveBeenCalledWith(expect.stringContaining('"event":"heartbeat"'));
      expect(mockSocket.send).toHaveBeenCalledWith(expect.stringContaining('"seq":0'));
    });

    it("should increment sequence number", () => {
      client.sendEvent("event1");
      client.sendEvent("event2");
      client.sendEvent("event3");

      const calls = (mockSocket.send as Any).mock.calls;
      expect(calls[0][0]).toContain('"seq":0');
      expect(calls[1][0]).toContain('"seq":1');
      expect(calls[2][0]).toContain('"seq":2');
    });
  });

  describe("sendChallenge", () => {
    it("should send connect.challenge event", () => {
      client.sendChallenge();

      expect(mockSocket.send).toHaveBeenCalledWith(
        expect.stringContaining('"event":"connect.challenge"'),
      );
      expect(mockSocket.send).toHaveBeenCalledWith(expect.stringContaining('"nonce"'));
    });
  });

  describe("close", () => {
    it("should close socket when connected", () => {
      client.close(1000, "Normal closure");

      expect(mockSocket.close).toHaveBeenCalledWith(1000, "Normal closure");
    });

    it("should use defaults when no args provided", () => {
      client.close();

      expect(mockSocket.close).toHaveBeenCalledWith(1000, "Connection closed");
    });

    it("should not close when already closed", () => {
      mockSocket = createMockSocket(WebSocket.CLOSED);
      client = new ControlPlaneClient(mockSocket, "127.0.0.1");

      client.close();

      expect(mockSocket.close).not.toHaveBeenCalled();
    });
  });

  describe("getSummary", () => {
    it("should return client summary", () => {
      client.authenticate(["admin"], "MyDevice");
      const summary = client.getSummary();

      expect(summary.id).toBe(client.id);
      expect(summary.remoteAddress).toBe("127.0.0.1");
      expect(summary.deviceName).toBe("MyDevice");
      expect(summary.authenticated).toBe(true);
      expect(summary.scopes).toEqual(["admin"]);
      expect(summary.connectedAt).toBeDefined();
      expect(summary.lastActivityAt).toBeDefined();
    });
  });
});

describe("ClientRegistry", () => {
  let registry: ClientRegistry;
  let mockSocket: WebSocket;

  beforeEach(() => {
    registry = new ClientRegistry();
    mockSocket = createMockSocket();
  });

  describe("add/get/remove", () => {
    it("should add and get a client", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      registry.add(client);

      expect(registry.get(client.id)).toBe(client);
    });

    it("should remove a client", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      registry.add(client);

      const removed = registry.remove(client.id);

      expect(removed).toBe(true);
      expect(registry.get(client.id)).toBeUndefined();
    });

    it("should return false when removing non-existent client", () => {
      const removed = registry.remove("non-existent");
      expect(removed).toBe(false);
    });
  });

  describe("getAll", () => {
    it("should return all clients", () => {
      const client1 = new ControlPlaneClient(mockSocket, "127.0.0.1");
      const client2 = new ControlPlaneClient(mockSocket, "192.168.1.1");
      registry.add(client1);
      registry.add(client2);

      const all = registry.getAll();

      expect(all).toHaveLength(2);
      expect(all).toContain(client1);
      expect(all).toContain(client2);
    });

    it("should return empty array when no clients", () => {
      expect(registry.getAll()).toEqual([]);
    });
  });

  describe("getAuthenticated", () => {
    it("should return only authenticated clients", () => {
      const client1 = new ControlPlaneClient(mockSocket, "127.0.0.1");
      const client2 = new ControlPlaneClient(mockSocket, "192.168.1.1");
      client1.authenticate(["admin"]);
      // client2 remains pending

      registry.add(client1);
      registry.add(client2);

      const authenticated = registry.getAuthenticated();

      expect(authenticated).toHaveLength(1);
      expect(authenticated[0]).toBe(client1);
    });
  });

  describe("count", () => {
    it("should return total client count", () => {
      expect(registry.count).toBe(0);

      registry.add(new ControlPlaneClient(mockSocket, "127.0.0.1"));
      expect(registry.count).toBe(1);

      registry.add(new ControlPlaneClient(mockSocket, "192.168.1.1"));
      expect(registry.count).toBe(2);
    });
  });

  describe("authenticatedCount", () => {
    it("should return authenticated client count", () => {
      const client1 = new ControlPlaneClient(mockSocket, "127.0.0.1");
      const client2 = new ControlPlaneClient(mockSocket, "192.168.1.1");
      client1.authenticate(["admin"]);

      registry.add(client1);
      registry.add(client2);

      expect(registry.authenticatedCount).toBe(1);
    });
  });

  describe("broadcast", () => {
    it("should broadcast to all authenticated clients", () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();
      const socket3 = createMockSocket();

      const client1 = new ControlPlaneClient(socket1, "127.0.0.1");
      const client2 = new ControlPlaneClient(socket2, "192.168.1.1");
      const client3 = new ControlPlaneClient(socket3, "10.0.0.1");

      client1.authenticate(["admin"]);
      client2.authenticate(["read"]);
      // client3 remains pending

      registry.add(client1);
      registry.add(client2);
      registry.add(client3);

      const sent = registry.broadcast("heartbeat", { ts: 123 });

      expect(sent).toBe(2);
      expect(socket1.send).toHaveBeenCalled();
      expect(socket2.send).toHaveBeenCalled();
      expect(socket3.send).not.toHaveBeenCalled();
    });

    it("should return 0 when no authenticated clients", () => {
      const client = new ControlPlaneClient(mockSocket, "127.0.0.1");
      registry.add(client);

      const sent = registry.broadcast("test");

      expect(sent).toBe(0);
    });
  });

  describe("closeAll", () => {
    it("should close all clients", () => {
      const socket1 = createMockSocket();
      const socket2 = createMockSocket();

      const client1 = new ControlPlaneClient(socket1, "127.0.0.1");
      const client2 = new ControlPlaneClient(socket2, "192.168.1.1");

      registry.add(client1);
      registry.add(client2);

      registry.closeAll(1001, "Shutdown");

      expect(socket1.close).toHaveBeenCalledWith(1001, "Shutdown");
      expect(socket2.close).toHaveBeenCalledWith(1001, "Shutdown");
      expect(registry.count).toBe(0);
    });
  });

  describe("cleanup", () => {
    it("should remove disconnected clients", () => {
      const openSocket = createMockSocket(WebSocket.OPEN);
      const closedSocket = createMockSocket(WebSocket.CLOSED);

      const client1 = new ControlPlaneClient(openSocket, "127.0.0.1");
      const client2 = new ControlPlaneClient(closedSocket, "192.168.1.1");

      registry.add(client1);
      registry.add(client2);

      const removed = registry.cleanup();

      expect(removed).toBe(1);
      expect(registry.count).toBe(1);
      expect(registry.get(client1.id)).toBe(client1);
      expect(registry.get(client2.id)).toBeUndefined();
    });
  });

  describe("getStatus", () => {
    it("should return registry status", () => {
      const client1 = new ControlPlaneClient(mockSocket, "127.0.0.1");
      const client2 = new ControlPlaneClient(mockSocket, "192.168.1.1");
      client1.authenticate(["admin"], "Device1");

      registry.add(client1);
      registry.add(client2);

      const status = registry.getStatus();

      expect(status.total).toBe(2);
      expect(status.authenticated).toBe(1);
      expect(status.pending).toBe(1);
      expect(status.clients).toHaveLength(2);
    });
  });

  describe("broadcastToOperators", () => {
    it("broadcasts to every authenticated client", () => {
      const operatorSocket = createMockSocket();
      const operator = new ControlPlaneClient(operatorSocket, "127.0.0.1");
      operator.authenticate(["admin"]);
      const pending = new ControlPlaneClient(createMockSocket(), "127.0.0.1");

      registry.add(operator);
      registry.add(pending);
      (operatorSocket.send as Any).mockClear();

      const sent = registry.broadcastToOperators("status.update", { test: true });

      expect(sent).toBe(1);
      expect(operatorSocket.send).toHaveBeenCalled();
    });
  });
});
