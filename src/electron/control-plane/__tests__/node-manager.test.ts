/**
 * Tests for Mobile Companion Node Manager
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { WebSocket } from 'ws';
import { NodeManager } from '../node-manager';
import { ControlPlaneClient, ClientRegistry } from '../client';

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

// Create a mock node client
const createMockNodeClient = (options: {
  id?: string;
  displayName?: string;
  platform?: 'ios' | 'android' | 'macos';
  capabilities?: string[];
  commands?: string[];
  permissions?: Record<string, boolean>;
  isForeground?: boolean;
} = {}): ControlPlaneClient => {
  const mockSocket = createMockSocket();
  const client = new ControlPlaneClient(mockSocket, '192.168.1.100', 'NodeApp/1.0');

  client.authenticateAsNode({
    deviceName: options.displayName || 'Test iPhone',
    platform: options.platform || 'ios',
    version: '1.0.0',
    deviceId: options.id || 'test-device-id',
    modelIdentifier: 'iPhone15,3',
    capabilities: (options.capabilities || ['camera', 'location']) as any,
    commands: options.commands || ['camera.snap', 'camera.clip', 'location.get'],
    permissions: options.permissions || { camera: true, location: true },
  });

  if (options.isForeground !== undefined) {
    client.setForeground(options.isForeground);
  }

  return client;
};

// Mock server with client registry
const createMockServer = (nodes: ControlPlaneClient[] = []) => {
  const registry = new ClientRegistry();
  nodes.forEach((node) => registry.add(node));

  return {
    isRunning: true,
    clients: registry,
    invokeNodeCommand: vi.fn().mockResolvedValue({ ok: true, payload: { result: 'success' } }),
  };
};

describe('NodeManager', () => {
  let nodeManager: NodeManager;

  beforeEach(() => {
    nodeManager = new NodeManager();
  });

  afterEach(() => {
    nodeManager.detach();
  });

  describe('attach/detach', () => {
    it('should not be attached by default', () => {
      expect(nodeManager.isAttached).toBe(false);
    });

    it('should be attached after calling attach()', () => {
      const server = createMockServer();
      nodeManager.attach(server as any);
      expect(nodeManager.isAttached).toBe(true);
    });

    it('should not be attached after calling detach()', () => {
      const server = createMockServer();
      nodeManager.attach(server as any);
      nodeManager.detach();
      expect(nodeManager.isAttached).toBe(false);
    });
  });

  describe('getNodes', () => {
    it('should return empty array when not attached', () => {
      const nodes = nodeManager.getNodes();
      expect(nodes).toEqual([]);
    });

    it('should return empty array when no nodes connected', () => {
      const server = createMockServer([]);
      nodeManager.attach(server as any);
      const nodes = nodeManager.getNodes();
      expect(nodes).toEqual([]);
    });

    it('should return connected nodes', () => {
      const node1 = createMockNodeClient({ displayName: 'iPhone 1' });
      const node2 = createMockNodeClient({ displayName: 'iPhone 2' });
      const server = createMockServer([node1, node2]);
      nodeManager.attach(server as any);

      const nodes = nodeManager.getNodes();
      expect(nodes).toHaveLength(2);
      expect(nodes.map((n) => n.displayName)).toContain('iPhone 1');
      expect(nodes.map((n) => n.displayName)).toContain('iPhone 2');
    });
  });

  describe('nodeCount', () => {
    it('should return 0 when not attached', () => {
      expect(nodeManager.nodeCount).toBe(0);
    });

    it('should return correct count', () => {
      const node1 = createMockNodeClient();
      const node2 = createMockNodeClient();
      const server = createMockServer([node1, node2]);
      nodeManager.attach(server as any);

      expect(nodeManager.nodeCount).toBe(2);
    });
  });

  describe('getNode', () => {
    it('should return null when not attached', () => {
      expect(nodeManager.getNode('test-id')).toBeNull();
    });

    it('should find node by ID', () => {
      const node = createMockNodeClient({ displayName: 'My iPhone' });
      const server = createMockServer([node]);
      nodeManager.attach(server as any);

      const found = nodeManager.getNode(node.id);
      expect(found).not.toBeNull();
      expect(found?.displayName).toBe('My iPhone');
    });

    it('should find node by display name', () => {
      const node = createMockNodeClient({ displayName: 'My iPhone' });
      const server = createMockServer([node]);
      nodeManager.attach(server as any);

      const found = nodeManager.getNode('My iPhone');
      expect(found).not.toBeNull();
      expect(found?.displayName).toBe('My iPhone');
    });

    it('should return null for non-existent node', () => {
      const node = createMockNodeClient({ displayName: 'My iPhone' });
      const server = createMockServer([node]);
      nodeManager.attach(server as any);

      expect(nodeManager.getNode('Non-existent')).toBeNull();
    });
  });

  describe('hasNode', () => {
    it('should return false when not attached', () => {
      expect(nodeManager.hasNode('test-id')).toBe(false);
    });

    it('should return true for existing node', () => {
      const node = createMockNodeClient({ displayName: 'My iPhone' });
      const server = createMockServer([node]);
      nodeManager.attach(server as any);

      expect(nodeManager.hasNode(node.id)).toBe(true);
      expect(nodeManager.hasNode('My iPhone')).toBe(true);
    });

    it('should return false for non-existent node', () => {
      const node = createMockNodeClient();
      const server = createMockServer([node]);
      nodeManager.attach(server as any);

      expect(nodeManager.hasNode('Non-existent')).toBe(false);
    });
  });

  describe('getNodesByCapability', () => {
    it('should filter nodes by capability', () => {
      const node1 = createMockNodeClient({
        displayName: 'iPhone with camera',
        capabilities: ['camera', 'location'],
      });
      const node2 = createMockNodeClient({
        displayName: 'iPhone no camera',
        capabilities: ['location'],
      });
      const server = createMockServer([node1, node2]);
      nodeManager.attach(server as any);

      const cameraNodes = nodeManager.getNodesByCapability('camera');
      expect(cameraNodes).toHaveLength(1);
      expect(cameraNodes[0].displayName).toBe('iPhone with camera');

      const locationNodes = nodeManager.getNodesByCapability('location');
      expect(locationNodes).toHaveLength(2);
    });
  });

  describe('getNodesByPlatform', () => {
    it('should filter nodes by platform', () => {
      const iPhoneNode = createMockNodeClient({
        displayName: 'iPhone',
        platform: 'ios',
      });
      const androidNode = createMockNodeClient({
        displayName: 'Android Phone',
        platform: 'android',
      });
      const server = createMockServer([iPhoneNode, androidNode]);
      nodeManager.attach(server as any);

      const iosNodes = nodeManager.getNodesByPlatform('ios');
      expect(iosNodes).toHaveLength(1);
      expect(iosNodes[0].displayName).toBe('iPhone');

      const androidNodes = nodeManager.getNodesByPlatform('android');
      expect(androidNodes).toHaveLength(1);
      expect(androidNodes[0].displayName).toBe('Android Phone');
    });
  });

  describe('getNodesByCommand', () => {
    it('should filter nodes by supported command', () => {
      const node1 = createMockNodeClient({
        displayName: 'Full featured',
        commands: ['camera.snap', 'location.get', 'sms.send'],
      });
      const node2 = createMockNodeClient({
        displayName: 'Limited',
        commands: ['camera.snap', 'location.get'],
      });
      const server = createMockServer([node1, node2]);
      nodeManager.attach(server as any);

      const smsNodes = nodeManager.getNodesByCommand('sms.send');
      expect(smsNodes).toHaveLength(1);
      expect(smsNodes[0].displayName).toBe('Full featured');

      const cameraNodes = nodeManager.getNodesByCommand('camera.snap');
      expect(cameraNodes).toHaveLength(2);
    });
  });

  describe('getDefaultNode', () => {
    it('should return null when no nodes', () => {
      const server = createMockServer([]);
      nodeManager.attach(server as any);
      expect(nodeManager.getDefaultNode()).toBeNull();
    });

    it('should return first node when nodes exist', () => {
      const node1 = createMockNodeClient({ displayName: 'First' });
      const node2 = createMockNodeClient({ displayName: 'Second' });
      const server = createMockServer([node1, node2]);
      nodeManager.attach(server as any);

      const defaultNode = nodeManager.getDefaultNode();
      expect(defaultNode).not.toBeNull();
    });
  });

  describe('invoke', () => {
    it('should return error when not attached', async () => {
      const result = await nodeManager.invoke({
        nodeId: 'test',
        command: 'camera.snap',
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('SERVER_NOT_RUNNING');
    });

    it('should return error when node not found', async () => {
      const server = createMockServer([]);
      nodeManager.attach(server as any);

      const result = await nodeManager.invoke({
        nodeId: 'non-existent',
        command: 'camera.snap',
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('NODE_NOT_FOUND');
    });

    it('should return error when command not supported', async () => {
      const node = createMockNodeClient({
        commands: ['location.get'],
      });
      const server = createMockServer([node]);
      nodeManager.attach(server as any);

      const result = await nodeManager.invoke({
        nodeId: node.id,
        command: 'camera.snap',
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('NODE_COMMAND_FAILED');
    });

    it('should return error when node is in background for camera commands', async () => {
      const node = createMockNodeClient({
        commands: ['camera.snap'],
        isForeground: false,
      });
      const server = createMockServer([node]);
      nodeManager.attach(server as any);

      const result = await nodeManager.invoke({
        nodeId: node.id,
        command: 'camera.snap',
      });

      expect(result.ok).toBe(false);
      expect(result.error?.code).toBe('NODE_BACKGROUND_UNAVAILABLE');
    });

    it('should invoke command when all conditions met', async () => {
      const node = createMockNodeClient({
        commands: ['camera.snap'],
        isForeground: true,
      });
      const server = createMockServer([node]);
      nodeManager.attach(server as any);

      const result = await nodeManager.invoke({
        nodeId: node.id,
        command: 'camera.snap',
        params: { facing: 'back' },
      });

      expect(result.ok).toBe(true);
      expect(server.invokeNodeCommand).toHaveBeenCalled();
    });
  });

  describe('cameraSnap', () => {
    it('should call invoke with correct parameters', async () => {
      const node = createMockNodeClient({
        commands: ['camera.snap'],
        isForeground: true,
      });
      const server = createMockServer([node]);
      nodeManager.attach(server as any);

      await nodeManager.cameraSnap(node.id, { facing: 'front', maxWidth: 640 });

      expect(server.invokeNodeCommand).toHaveBeenCalledWith(
        expect.anything(),
        'camera.snap',
        { facing: 'front', maxWidth: 640 },
        30000
      );
    });
  });

  describe('locationGet', () => {
    it('should call invoke with correct parameters', async () => {
      const node = createMockNodeClient({
        commands: ['location.get'],
        isForeground: true,
      });
      const server = createMockServer([node]);
      nodeManager.attach(server as any);

      await nodeManager.locationGet(node.id, { accuracy: 'precise' });

      expect(server.invokeNodeCommand).toHaveBeenCalledWith(
        expect.anything(),
        'location.get',
        { accuracy: 'precise' },
        30000
      );
    });
  });

  describe('screenRecord', () => {
    it('should call invoke with correct parameters', async () => {
      const node = createMockNodeClient({
        commands: ['screen.record'],
        capabilities: ['screen'],
        isForeground: true,
      });
      const server = createMockServer([node]);
      nodeManager.attach(server as any);

      await nodeManager.screenRecord(node.id, { durationMs: 5000, fps: 15 });

      expect(server.invokeNodeCommand).toHaveBeenCalledWith(
        expect.anything(),
        'screen.record',
        { durationMs: 5000, fps: 15 },
        30000
      );
    });
  });

  describe('smsSend', () => {
    it('should call invoke with correct parameters', async () => {
      const node = createMockNodeClient({
        platform: 'android',
        commands: ['sms.send'],
        capabilities: ['sms'],
        isForeground: true,
      });
      const server = createMockServer([node]);
      nodeManager.attach(server as any);

      await nodeManager.smsSend(node.id, { to: '+1234567890', message: 'Hello!' });

      expect(server.invokeNodeCommand).toHaveBeenCalledWith(
        expect.anything(),
        'sms.send',
        { to: '+1234567890', message: 'Hello!' },
        30000
      );
    });
  });
});
