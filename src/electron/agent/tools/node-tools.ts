/**
 * Node Tools for AI Agent
 *
 * Tools that enable the AI agent to interact with mobile companion nodes.
 * These tools allow the agent to:
 * - List connected nodes
 * - Take photos using node cameras
 * - Get location from nodes
 * - Record screen from nodes
 * - Send SMS (Android only)
 */

import type { ToolDefinition, NodeToolResult } from '../../../shared/types';
import { getNodeManager } from '../../control-plane';

/**
 * List connected mobile companion nodes
 */
export const nodeListTool: ToolDefinition = {
  name: 'node_list',
  description: 'List connected mobile companion devices (nodes). Returns information about each connected device including its capabilities and available commands.',
  inputSchema: {
    type: 'object' as const,
    properties: {},
    required: [],
  },
  riskLevel: 'read' as const,
  groups: ['read'] as const,
  handler: async (): Promise<NodeToolResult> => {
    const nodeManager = getNodeManager();

    if (!nodeManager.isAttached) {
      return {
        type: 'text',
        content: 'No mobile companions are available. The Control Plane server is not running.',
      };
    }

    const nodes = nodeManager.getNodes();

    if (nodes.length === 0) {
      return {
        type: 'text',
        content: 'No mobile companion devices are currently connected.',
      };
    }

    const nodeList = nodes.map((n) => ({
      id: n.id,
      name: n.displayName,
      platform: n.platform,
      capabilities: n.capabilities,
      commands: n.commands,
      isForeground: n.isForeground,
    }));

    return {
      type: 'json',
      content: JSON.stringify({ nodes: nodeList }, null, 2),
    };
  },
};

/**
 * Get detailed info about a specific node
 */
export const nodeDescribeTool: ToolDefinition = {
  name: 'node_describe',
  description: 'Get detailed information about a connected mobile companion device, including its capabilities, permissions, and connection status.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      nodeId: {
        type: 'string',
        description: 'The ID or display name of the node to describe',
      },
    },
    required: ['nodeId'],
  },
  riskLevel: 'read' as const,
  groups: ['read'] as const,
  handler: async (params: { nodeId: string }): Promise<NodeToolResult> => {
    const nodeManager = getNodeManager();

    if (!nodeManager.isAttached) {
      return {
        type: 'text',
        content: 'Control Plane server is not running.',
        isError: true,
      };
    }

    const node = nodeManager.getNode(params.nodeId);

    if (!node) {
      return {
        type: 'text',
        content: `Node not found: ${params.nodeId}`,
        isError: true,
      };
    }

    return {
      type: 'json',
      content: JSON.stringify(node, null, 2),
    };
  },
};

/**
 * Take a photo using a node's camera
 */
export const nodeCameraSnapTool: ToolDefinition = {
  name: 'node_camera_snap',
  description: 'Take a photo using a mobile companion\'s camera. Returns the image as base64-encoded JPEG. The node app must be in the foreground.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      nodeId: {
        type: 'string',
        description: 'The ID or display name of the node to use. If omitted, uses the first available node.',
      },
      facing: {
        type: 'string',
        enum: ['front', 'back'],
        description: 'Which camera to use: "front" (selfie) or "back" (main camera). Defaults to "back".',
      },
      maxWidth: {
        type: 'number',
        description: 'Maximum width in pixels for resizing. If omitted, uses original resolution.',
      },
      quality: {
        type: 'number',
        description: 'JPEG quality from 0 to 1. Defaults to 0.8.',
      },
    },
    required: [],
  },
  riskLevel: 'read' as const,
  groups: ['read'] as const,
  handler: async (params: {
    nodeId?: string;
    facing?: 'front' | 'back';
    maxWidth?: number;
    quality?: number;
  }): Promise<NodeToolResult> => {
    const nodeManager = getNodeManager();

    if (!nodeManager.isAttached) {
      return {
        type: 'text',
        content: 'Control Plane server is not running.',
        isError: true,
      };
    }

    // Find the node
    let nodeId = params.nodeId;
    if (!nodeId) {
      const defaultNode = nodeManager.getDefaultNode();
      if (!defaultNode) {
        return {
          type: 'text',
          content: 'No mobile companion devices are connected.',
          isError: true,
        };
      }
      nodeId = defaultNode.id;
    }

    // Check if node supports camera
    const node = nodeManager.getNode(nodeId);
    if (!node) {
      return {
        type: 'text',
        content: `Node not found: ${nodeId}`,
        isError: true,
      };
    }

    if (!node.capabilities.includes('camera')) {
      return {
        type: 'text',
        content: `Node "${node.displayName}" does not have camera capability.`,
        isError: true,
      };
    }

    // Invoke the camera snap command
    const result = await nodeManager.cameraSnap(nodeId, {
      facing: params.facing,
      maxWidth: params.maxWidth,
      quality: params.quality,
    });

    if (!result.ok) {
      return {
        type: 'text',
        content: `Failed to take photo: ${result.error?.message || 'Unknown error'}`,
        isError: true,
      };
    }

    const payload = result.payload as { format: string; base64: string; width?: number; height?: number };

    return {
      type: 'image',
      content: payload.base64,
      mimeType: `image/${payload.format}`,
    };
  },
};

/**
 * Get location from a node
 */
export const nodeLocationTool: ToolDefinition = {
  name: 'node_location',
  description: 'Get the current GPS location from a mobile companion device. Returns latitude, longitude, and accuracy.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      nodeId: {
        type: 'string',
        description: 'The ID or display name of the node to use. If omitted, uses the first available node.',
      },
      accuracy: {
        type: 'string',
        enum: ['coarse', 'precise'],
        description: 'Desired accuracy: "coarse" (faster, less battery) or "precise" (GPS). Defaults to "precise".',
      },
    },
    required: [],
  },
  riskLevel: 'read' as const,
  groups: ['read'] as const,
  handler: async (params: {
    nodeId?: string;
    accuracy?: 'coarse' | 'precise';
  }): Promise<NodeToolResult> => {
    const nodeManager = getNodeManager();

    if (!nodeManager.isAttached) {
      return {
        type: 'text',
        content: 'Control Plane server is not running.',
        isError: true,
      };
    }

    // Find the node
    let nodeId = params.nodeId;
    if (!nodeId) {
      const defaultNode = nodeManager.getDefaultNode();
      if (!defaultNode) {
        return {
          type: 'text',
          content: 'No mobile companion devices are connected.',
          isError: true,
        };
      }
      nodeId = defaultNode.id;
    }

    // Check if node supports location
    const node = nodeManager.getNode(nodeId);
    if (!node) {
      return {
        type: 'text',
        content: `Node not found: ${nodeId}`,
        isError: true,
      };
    }

    if (!node.capabilities.includes('location')) {
      return {
        type: 'text',
        content: `Node "${node.displayName}" does not have location capability.`,
        isError: true,
      };
    }

    // Invoke the location get command
    const result = await nodeManager.locationGet(nodeId, {
      accuracy: params.accuracy,
    });

    if (!result.ok) {
      return {
        type: 'text',
        content: `Failed to get location: ${result.error?.message || 'Unknown error'}`,
        isError: true,
      };
    }

    const payload = result.payload as {
      latitude: number;
      longitude: number;
      accuracy: number;
      altitude?: number;
      timestamp: number;
    };

    return {
      type: 'json',
      content: JSON.stringify({
        latitude: payload.latitude,
        longitude: payload.longitude,
        accuracy: `${payload.accuracy.toFixed(1)} meters`,
        altitude: payload.altitude ? `${payload.altitude.toFixed(1)} meters` : undefined,
        timestamp: new Date(payload.timestamp).toISOString(),
        mapsUrl: `https://www.google.com/maps?q=${payload.latitude},${payload.longitude}`,
      }, null, 2),
    };
  },
};

/**
 * Record screen from a node
 */
export const nodeScreenRecordTool: ToolDefinition = {
  name: 'node_screen_record',
  description: 'Record the screen of a mobile companion device. Returns the video as base64-encoded MP4. The node app must be in the foreground.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      nodeId: {
        type: 'string',
        description: 'The ID or display name of the node to use. If omitted, uses the first available node.',
      },
      durationMs: {
        type: 'number',
        description: 'Recording duration in milliseconds. Maximum is 60000 (1 minute). Defaults to 5000.',
      },
      fps: {
        type: 'number',
        description: 'Frames per second. Defaults to 10.',
      },
    },
    required: [],
  },
  riskLevel: 'read' as const,
  groups: ['read'] as const,
  handler: async (params: {
    nodeId?: string;
    durationMs?: number;
    fps?: number;
  }): Promise<NodeToolResult> => {
    const nodeManager = getNodeManager();

    if (!nodeManager.isAttached) {
      return {
        type: 'text',
        content: 'Control Plane server is not running.',
        isError: true,
      };
    }

    // Find the node
    let nodeId = params.nodeId;
    if (!nodeId) {
      const defaultNode = nodeManager.getDefaultNode();
      if (!defaultNode) {
        return {
          type: 'text',
          content: 'No mobile companion devices are connected.',
          isError: true,
        };
      }
      nodeId = defaultNode.id;
    }

    // Check if node supports screen recording
    const node = nodeManager.getNode(nodeId);
    if (!node) {
      return {
        type: 'text',
        content: `Node not found: ${nodeId}`,
        isError: true,
      };
    }

    if (!node.capabilities.includes('screen')) {
      return {
        type: 'text',
        content: `Node "${node.displayName}" does not have screen recording capability.`,
        isError: true,
      };
    }

    const durationMs = Math.min(params.durationMs || 5000, 60000);

    // Invoke the screen record command
    const result = await nodeManager.screenRecord(nodeId, {
      durationMs,
      fps: params.fps,
    });

    if (!result.ok) {
      return {
        type: 'text',
        content: `Failed to record screen: ${result.error?.message || 'Unknown error'}`,
        isError: true,
      };
    }

    const payload = result.payload as { format: string; base64: string; durationMs?: number };

    return {
      type: 'video',
      content: payload.base64,
      mimeType: `video/${payload.format}`,
    };
  },
};

/**
 * Send SMS from a node (Android only)
 */
export const nodeSmsSendTool: ToolDefinition = {
  name: 'node_sms_send',
  description: 'Send an SMS message using an Android mobile companion device. Not available on iOS.',
  inputSchema: {
    type: 'object' as const,
    properties: {
      nodeId: {
        type: 'string',
        description: 'The ID or display name of the Android node to use. If omitted, uses the first Android node.',
      },
      to: {
        type: 'string',
        description: 'The phone number to send the SMS to.',
      },
      message: {
        type: 'string',
        description: 'The message content to send.',
      },
    },
    required: ['to', 'message'],
  },
  riskLevel: 'write' as const,
  groups: ['write', 'network'] as const,
  handler: async (params: {
    nodeId?: string;
    to: string;
    message: string;
  }): Promise<NodeToolResult> => {
    const nodeManager = getNodeManager();

    if (!nodeManager.isAttached) {
      return {
        type: 'text',
        content: 'Control Plane server is not running.',
        isError: true,
      };
    }

    // Find an Android node
    let nodeId = params.nodeId;
    if (!nodeId) {
      const androidNodes = nodeManager.getNodesByPlatform('android');
      if (androidNodes.length === 0) {
        return {
          type: 'text',
          content: 'No Android mobile companion devices are connected. SMS is only available on Android.',
          isError: true,
        };
      }
      nodeId = androidNodes[0].id;
    }

    // Check if node supports SMS
    const node = nodeManager.getNode(nodeId);
    if (!node) {
      return {
        type: 'text',
        content: `Node not found: ${nodeId}`,
        isError: true,
      };
    }

    if (node.platform !== 'android') {
      return {
        type: 'text',
        content: `SMS is only available on Android devices. Node "${node.displayName}" is ${node.platform}.`,
        isError: true,
      };
    }

    if (!node.capabilities.includes('sms')) {
      return {
        type: 'text',
        content: `Node "${node.displayName}" does not have SMS capability.`,
        isError: true,
      };
    }

    // Invoke the SMS send command
    const result = await nodeManager.smsSend(nodeId, {
      to: params.to,
      message: params.message,
    });

    if (!result.ok) {
      return {
        type: 'text',
        content: `Failed to send SMS: ${result.error?.message || 'Unknown error'}`,
        isError: true,
      };
    }

    const payload = result.payload as { sent: boolean; error?: string };

    if (!payload.sent) {
      return {
        type: 'text',
        content: `SMS was not sent: ${payload.error || 'Unknown error'}`,
        isError: true,
      };
    }

    return {
      type: 'text',
      content: `SMS sent successfully to ${params.to}`,
    };
  },
};

/**
 * All node tools for registration
 */
export const nodeTools = [
  nodeListTool,
  nodeDescribeTool,
  nodeCameraSnapTool,
  nodeLocationTool,
  nodeScreenRecordTool,
  nodeSmsSendTool,
];

/**
 * Register node tools with the tool registry
 */
export function registerNodeTools(registry: {
  register: (tool: ToolDefinition) => void;
}): void {
  for (const tool of nodeTools) {
    registry.register(tool);
  }
}
