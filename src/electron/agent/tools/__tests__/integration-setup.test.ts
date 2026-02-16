import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Workspace } from '../../../../shared/types';

const mocks = vi.hoisted(() => {
  const mcpState: { servers: Array<any> } = { servers: [] };
  const hooksState: any = {
    enabled: false,
    token: '',
    path: '/hooks',
    maxBodyBytes: 256 * 1024,
    presets: [],
    mappings: [],
    resend: undefined,
  };

  const installServer = vi.fn(async () => {
    const existing = mcpState.servers.find((s) => s.name === 'Resend');
    if (existing) throw new Error('Server Resend is already installed');
    const server = {
      id: 'resend-server',
      name: 'Resend',
      description: 'Resend connector',
      enabled: false,
      transport: 'stdio',
      command: process.execPath,
      args: ['--runAsNode', '/tmp/connectors/resend-mcp/dist/index.js'],
      env: {
        RESEND_API_KEY: '',
        RESEND_BASE_URL: 'https://api.resend.com',
      },
    };
    mcpState.servers.push(server);
    return server;
  });

  return {
    mcpState,
    hooksState,
    connectServer: vi.fn().mockResolvedValue(undefined),
    getServerStatus: vi.fn().mockReturnValue({ status: 'disconnected' }),
    callTool: vi.fn().mockResolvedValue({
      content: [{ type: 'text', text: 'ok' }],
    }),
    getAllTools: vi.fn().mockReturnValue([]),
    installServer,
  };
});

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp'),
  },
}));

vi.mock('../../../mcp/client/MCPClientManager', () => ({
  MCPClientManager: {
    getInstance: vi.fn().mockReturnValue({
      connectServer: mocks.connectServer,
      getServerStatus: mocks.getServerStatus,
      callTool: mocks.callTool,
      getAllTools: mocks.getAllTools,
    }),
  },
}));

vi.mock('../../../mcp/settings', () => ({
  MCPSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn().mockImplementation(() => ({
      servers: mocks.mcpState.servers,
      autoConnect: true,
      toolNamePrefix: 'mcp_',
      maxReconnectAttempts: 5,
      reconnectDelayMs: 1000,
      registryEnabled: true,
      registryUrl: 'https://registry.modelcontextprotocol.io/servers.json',
      hostEnabled: false,
    })),
    updateServer: vi.fn().mockImplementation((id: string, updates: any) => {
      const idx = mocks.mcpState.servers.findIndex((s) => s.id === id);
      if (idx === -1) return null;
      mocks.mcpState.servers[idx] = { ...mocks.mcpState.servers[idx], ...updates };
      return mocks.mcpState.servers[idx];
    }),
  },
}));

vi.mock('../../../mcp/registry/MCPRegistryManager', () => ({
  MCPRegistryManager: {
    installServer: mocks.installServer,
  },
}));

vi.mock('../../../hooks/settings', () => ({
  HooksSettingsManager: {
    initialize: vi.fn(),
    loadSettings: vi.fn().mockImplementation(() => ({ ...mocks.hooksState })),
    enableHooks: vi.fn().mockImplementation(() => {
      mocks.hooksState.enabled = true;
      if (!mocks.hooksState.token) mocks.hooksState.token = 'hooks-token';
      return { ...mocks.hooksState };
    }),
    updateConfig: vi.fn().mockImplementation((updates: any) => {
      Object.assign(mocks.hooksState, updates);
      return { ...mocks.hooksState };
    }),
  },
}));

vi.mock('../../../settings/personality-manager', () => ({
  PersonalityManager: {
    loadSettings: vi.fn().mockReturnValue({}),
    saveSettings: vi.fn(),
    setUserName: vi.fn(),
    getUserName: vi.fn(),
    getAgentName: vi.fn().mockReturnValue('CoWork'),
    setActivePersona: vi.fn(),
    setResponseStyle: vi.fn(),
    setQuirks: vi.fn(),
    clearCache: vi.fn(),
  },
}));

vi.mock('../../custom-skill-loader', () => ({
  getCustomSkillLoader: vi.fn().mockReturnValue({
    getSkill: vi.fn(),
    listModelInvocableSkills: vi.fn().mockReturnValue([]),
    expandPrompt: vi.fn().mockReturnValue(''),
    getSkillDescriptionsForModel: vi.fn().mockReturnValue(''),
  }),
}));

vi.mock('../../../security/policy-manager', () => ({
  isToolAllowedQuick: vi.fn().mockReturnValue(true),
}));

vi.mock('../builtin-settings', () => ({
  BuiltinToolsSettingsManager: {
    isToolEnabled: vi.fn().mockReturnValue(true),
    getToolCategory: vi.fn().mockReturnValue('meta'),
    getToolPriority: vi.fn().mockReturnValue('normal'),
  },
}));

vi.mock('../../search', () => ({
  SearchProviderFactory: {
    isAnyProviderConfigured: vi.fn().mockReturnValue(false),
    getAvailableProviders: vi.fn().mockReturnValue([]),
  },
}));

vi.mock('../mention-tools', () => ({
  MentionTools: class MockMentionTools {
    static getToolDefinitions() {
      return [];
    }
  },
}));

import { ToolRegistry } from '../registry';

function createWorkspace(): Workspace {
  return {
    id: 'ws-1',
    name: 'Test',
    path: '/tmp',
    createdAt: Date.now(),
    permissions: { read: true, write: true, delete: true, shell: false, network: true },
  };
}

describe('integration_setup tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getServerStatus.mockReturnValue({ status: 'disconnected' });
    mocks.mcpState.servers = [];
    mocks.hooksState.enabled = false;
    mocks.hooksState.token = '';
    mocks.hooksState.path = '/hooks';
    mocks.hooksState.maxBodyBytes = 256 * 1024;
    mocks.hooksState.presets = [];
    mocks.hooksState.mappings = [];
    mocks.hooksState.resend = undefined;
  });

  it('is exposed in tool list', () => {
    const registry = new ToolRegistry(createWorkspace(), { logEvent: vi.fn() } as any, 'task-1');
    const tool = registry.getTools().find((t) => t.name === 'integration_setup');
    expect(tool).toBeDefined();
  });

  it('returns missing api_key guidance when configuring without key', async () => {
    const registry = new ToolRegistry(createWorkspace(), { logEvent: vi.fn() } as any, 'task-1');
    const result = await registry.executeTool('integration_setup', {
      action: 'configure',
      provider: 'resend',
    });

    expect(mocks.installServer).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(false);
    expect(result.installed).toBe(true);
    expect(result.configured).toBe(false);
    expect(result.missing_inputs).toHaveLength(1);
    expect(result.missing_inputs[0].field).toBe('api_key');
    expect(result.links.create_api_key).toContain('resend.com');
  });

  it('inspect mode reports readiness without failing when connector is missing', async () => {
    const registry = new ToolRegistry(createWorkspace(), { logEvent: vi.fn() } as any, 'task-1');
    const result = await registry.executeTool('integration_setup', {
      action: 'inspect',
      provider: 'resend',
    });

    expect(result.success).toBe(true);
    expect(result.installed).toBe(false);
    expect(result.configured).toBe(false);
    expect(result.missing_inputs).toHaveLength(1);
    expect(result.missing_inputs[0].field).toBe('api_key');
  });

  it('configures resend sending and inbound setup when key is provided', async () => {
    const registry = new ToolRegistry(createWorkspace(), { logEvent: vi.fn() } as any, 'task-1');
    const result = await registry.executeTool('integration_setup', {
      action: 'configure',
      provider: 'resend',
      api_key: 're_test_key',
      enable_inbound: true,
      webhook_secret: 'whsec_test_secret',
    });

    expect(result.success).toBe(true);
    expect(result.email_sending_ready).toBe(true);
    expect(result.connected).toBe(true);
    expect(result.inbound.requested).toBe(true);
    expect(result.inbound.preset_enabled).toBe(true);
    expect(result.inbound.hooks_enabled).toBe(true);
    expect(result.inbound.signing_secret_configured).toBe(true);
    expect(mocks.connectServer).toHaveBeenCalledTimes(1);
    expect(mocks.callTool).toHaveBeenCalledWith('resend.health', {});
  });

  it('keeps existing connected session when connect_now is false', async () => {
    mocks.mcpState.servers.push({
      id: 'resend-server',
      name: 'Resend',
      description: 'Resend connector',
      enabled: true,
      transport: 'stdio',
      command: process.execPath,
      args: ['--runAsNode', '/tmp/connectors/resend-mcp/dist/index.js'],
      env: {
        RESEND_API_KEY: 're_existing_key',
        RESEND_BASE_URL: 'https://api.resend.com',
      },
    });
    mocks.getServerStatus.mockReturnValue({ status: 'connected' });

    const registry = new ToolRegistry(createWorkspace(), { logEvent: vi.fn() } as any, 'task-1');
    const result = await registry.executeTool('integration_setup', {
      action: 'configure',
      provider: 'resend',
      connect_now: false,
    });

    expect(result.success).toBe(true);
    expect(result.connected).toBe(true);
    expect(result.email_sending_ready).toBe(true);
    expect(mocks.connectServer).not.toHaveBeenCalled();
    expect(mocks.callTool).toHaveBeenCalledWith('resend.health', {});
  });
});
