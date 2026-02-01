/**
 * Node Manager
 *
 * High-level interface for managing mobile companion nodes.
 * Provides methods for listing, describing, and invoking commands on nodes.
 */

import { EventEmitter } from 'events';
import type { ControlPlaneServer } from './server';
import type { ControlPlaneClient, NodeCapabilityType, NodePlatform } from './client';
import type { NodeInfo, NodeInvokeParams, NodeInvokeResult } from '../../shared/types';
import { Events, Methods, ErrorCodes, createRequestFrame, createResponseFrame } from './protocol';

/**
 * Node Manager event types
 */
export interface NodeManagerEvents {
  node_connected: (node: NodeInfo) => void;
  node_disconnected: (node: NodeInfo) => void;
  node_capabilities_changed: (node: NodeInfo) => void;
  node_foreground_changed: (nodeId: string, isForeground: boolean) => void;
}

/**
 * Node Manager class
 *
 * Provides high-level operations for mobile companion nodes.
 */
export class NodeManager extends EventEmitter {
  private server: ControlPlaneServer | null = null;
  private eventHandlersRegistered = false;

  constructor() {
    super();
  }

  /**
   * Attach to a Control Plane server
   */
  attach(server: ControlPlaneServer): void {
    this.server = server;
    this.setupEventHandlers();
  }

  /**
   * Detach from the Control Plane server
   */
  detach(): void {
    this.server = null;
    this.eventHandlersRegistered = false;
  }

  /**
   * Check if attached to a server
   */
  get isAttached(): boolean {
    return this.server !== null && this.server.isRunning;
  }

  /**
   * Set up event handlers for node events
   */
  private setupEventHandlers(): void {
    if (this.eventHandlersRegistered || !this.server) return;

    // The server broadcasts events through the client registry
    // We don't need to do anything special here since the server
    // handles broadcasting node events to operators

    this.eventHandlersRegistered = true;
  }

  /**
   * Get all connected nodes
   */
  getNodes(): NodeInfo[] {
    if (!this.server) return [];
    return (this.server as any).clients.getNodeInfoList();
  }

  /**
   * Get node count
   */
  get nodeCount(): number {
    if (!this.server) return 0;
    return (this.server as any).clients.nodeCount;
  }

  /**
   * Get a node by ID or display name
   */
  getNode(idOrName: string): NodeInfo | null {
    if (!this.server) return null;
    const client = (this.server as any).clients.getNodeByIdOrName(idOrName);
    return client?.getNodeInfo() || null;
  }

  /**
   * Check if a node exists
   */
  hasNode(idOrName: string): boolean {
    return this.getNode(idOrName) !== null;
  }

  /**
   * Get nodes by capability
   */
  getNodesByCapability(capability: NodeCapabilityType): NodeInfo[] {
    return this.getNodes().filter((n) => n.capabilities.includes(capability));
  }

  /**
   * Get nodes by platform
   */
  getNodesByPlatform(platform: NodePlatform): NodeInfo[] {
    return this.getNodes().filter((n) => n.platform === platform);
  }

  /**
   * Get nodes that support a specific command
   */
  getNodesByCommand(command: string): NodeInfo[] {
    return this.getNodes().filter((n) => n.commands.includes(command));
  }

  /**
   * Get the first available node (for single-node setups)
   */
  getDefaultNode(): NodeInfo | null {
    const nodes = this.getNodes();
    return nodes.length > 0 ? nodes[0] : null;
  }

  /**
   * Invoke a command on a node
   */
  async invoke(params: NodeInvokeParams): Promise<NodeInvokeResult> {
    if (!this.server) {
      return {
        ok: false,
        error: { code: 'SERVER_NOT_RUNNING', message: 'Control Plane server is not running' },
      };
    }

    const { nodeId, command, params: commandParams, timeoutMs = 30000 } = params;

    // Find the node
    const client = (this.server as any).clients.getNodeByIdOrName(nodeId) as ControlPlaneClient | undefined;
    if (!client) {
      return {
        ok: false,
        error: { code: ErrorCodes.NODE_NOT_FOUND, message: `Node not found: ${nodeId}` },
      };
    }

    const nodeInfo = client.getNodeInfo();
    if (!nodeInfo) {
      return {
        ok: false,
        error: { code: ErrorCodes.NODE_NOT_FOUND, message: `Node not found: ${nodeId}` },
      };
    }

    // Check if node supports the command
    if (!nodeInfo.commands.includes(command)) {
      return {
        ok: false,
        error: {
          code: ErrorCodes.NODE_COMMAND_FAILED,
          message: `Node does not support command: ${command}`,
        },
      };
    }

    // Check foreground requirement for certain commands
    const foregroundRequiredCommands = ['camera.snap', 'camera.clip', 'screen.record'];
    if (!nodeInfo.isForeground && foregroundRequiredCommands.includes(command)) {
      return {
        ok: false,
        error: {
          code: ErrorCodes.NODE_BACKGROUND_UNAVAILABLE,
          message: 'Node app must be in foreground for this command',
        },
      };
    }

    // Forward to the server's internal method
    try {
      const result = await (this.server as any).invokeNodeCommand(
        client,
        command,
        commandParams,
        timeoutMs
      );
      return result;
    } catch (error: any) {
      return {
        ok: false,
        error: {
          code: ErrorCodes.NODE_COMMAND_FAILED,
          message: error.message || 'Command invocation failed',
        },
      };
    }
  }

  /**
   * Take a photo using a node's camera
   */
  async cameraSnap(
    nodeId: string,
    options?: { facing?: 'front' | 'back'; maxWidth?: number; quality?: number }
  ): Promise<NodeInvokeResult> {
    return this.invoke({
      nodeId,
      command: 'camera.snap',
      params: options,
    });
  }

  /**
   * Record video using a node's camera
   */
  async cameraClip(
    nodeId: string,
    options: { durationMs: number; facing?: 'front' | 'back'; noAudio?: boolean }
  ): Promise<NodeInvokeResult> {
    return this.invoke({
      nodeId,
      command: 'camera.clip',
      params: options,
    });
  }

  /**
   * Get location from a node
   */
  async locationGet(
    nodeId: string,
    options?: { accuracy?: 'coarse' | 'precise'; maxAge?: number; timeout?: number }
  ): Promise<NodeInvokeResult> {
    return this.invoke({
      nodeId,
      command: 'location.get',
      params: options,
    });
  }

  /**
   * Record screen from a node
   */
  async screenRecord(
    nodeId: string,
    options: { durationMs: number; fps?: number; noAudio?: boolean }
  ): Promise<NodeInvokeResult> {
    return this.invoke({
      nodeId,
      command: 'screen.record',
      params: options,
    });
  }

  /**
   * Send SMS from a node (Android only)
   */
  async smsSend(
    nodeId: string,
    options: { to: string; message: string }
  ): Promise<NodeInvokeResult> {
    return this.invoke({
      nodeId,
      command: 'sms.send',
      params: options,
    });
  }

  /**
   * Send system notification to a node
   */
  async systemNotify(
    nodeId: string,
    options: { title: string; message: string; sound?: boolean }
  ): Promise<NodeInvokeResult> {
    return this.invoke({
      nodeId,
      command: 'system.notify',
      params: options,
    });
  }
}

// Singleton instance
let nodeManagerInstance: NodeManager | null = null;

/**
 * Get the global NodeManager instance
 */
export function getNodeManager(): NodeManager {
  if (!nodeManagerInstance) {
    nodeManagerInstance = new NodeManager();
  }
  return nodeManagerInstance;
}

/**
 * Initialize the NodeManager with a Control Plane server
 */
export function initNodeManager(server: ControlPlaneServer): NodeManager {
  const manager = getNodeManager();
  manager.attach(server);
  return manager;
}

/**
 * Shutdown the NodeManager
 */
export function shutdownNodeManager(): void {
  if (nodeManagerInstance) {
    nodeManagerInstance.detach();
    nodeManagerInstance = null;
  }
}
