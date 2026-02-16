import { describe, expect, it, vi } from 'vitest';

// Mock MentionTools to avoid DatabaseManager dependency during ToolRegistry construction.
vi.mock('../mention-tools', () => {
  return {
    MentionTools: class MockMentionTools {
      static getToolDefinitions() {
        return [];
      }
    },
  };
});

vi.mock('../../../mcp/client/MCPClientManager', () => ({
  MCPClientManager: {
    getInstance: vi.fn().mockImplementation(() => {
      throw new Error('MCP not initialized');
    }),
  },
}));

vi.mock('../../../mcp/settings', () => ({
  MCPSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn().mockReturnValue({ toolNamePrefix: 'mcp_' }),
    updateServer: vi.fn().mockReturnValue({}),
  },
}));

vi.mock('../../../mcp/registry/MCPRegistryManager', () => ({
  MCPRegistryManager: {
    installServer: vi.fn(),
  },
}));

vi.mock('../../../hooks/settings', () => ({
  HooksSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn().mockReturnValue({
      enabled: false,
      token: '',
      path: '/hooks',
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    }),
    enableHooks: vi.fn().mockReturnValue({
      enabled: true,
      token: 'token',
      path: '/hooks',
      maxBodyBytes: 256 * 1024,
      presets: [],
      mappings: [],
    }),
    updateConfig: vi.fn().mockImplementation((cfg: any) => cfg),
  },
}));

import { ToolRegistry } from '../registry';

describe('ToolRegistry tool restrictions', () => {
  it('denies all tools when restrictions include "*"', () => {
    const workspace: any = {
      id: 'test-workspace',
      name: 'Test Workspace',
      path: '/mock/workspace',
      permissions: {
        read: true,
        write: true,
        delete: true,
        network: true,
        shell: true,
      },
      createdAt: Date.now(),
    };

    const daemon: any = {
      logEvent: vi.fn(),
      registerArtifact: vi.fn(),
    };

    const registry = new ToolRegistry(workspace, daemon, 'test-task', 'private', ['*']);

    expect(registry.isToolAllowed('read_file')).toBe(false);
    expect(registry.isToolAllowed('web_search')).toBe(false);
    expect(registry.isToolAllowed('spawn_agent')).toBe(false);
  });
});
