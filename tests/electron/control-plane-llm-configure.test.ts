import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockFactory = vi.hoisted(() => ({
  loadSettings: vi.fn(),
  saveSettings: vi.fn(),
  clearCache: vi.fn(),
  applyModelSelection: vi.fn(),
  getConfigStatus: vi.fn(),
}));

vi.mock('../../src/electron/agent/llm', () => ({
  LLMProviderFactory: mockFactory,
}));

import { configureLlmFromControlPlaneParams, getControlPlaneLlmStatus } from '../../src/electron/control-plane/llm-configure';

describe('control-plane llm-configure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFactory.loadSettings.mockReturnValue({
      providerType: 'openai',
      modelKey: 'gpt-4o-mini',
      openai: {
        apiKey: 'old-key',
        authMethod: 'oauth',
        accessToken: 'old-token',
        refreshToken: 'old-refresh',
        tokenExpiresAt: 123,
      },
    });
    mockFactory.applyModelSelection.mockImplementation((settings: any, model: string) => ({
      ...settings,
      modelKey: model,
    }));
    mockFactory.getConfigStatus.mockReturnValue({
      currentProvider: 'openai',
      currentModel: 'gpt-4o-mini',
      providers: [
        { type: 'openai', name: 'OpenAI', configured: true },
      ],
    });
  });

  it('returns sanitized LLM status', () => {
    const status = getControlPlaneLlmStatus();
    expect(status.currentProvider).toBe('openai');
    expect(status.providers).toHaveLength(1);
  });

  it('configures openai api key and model', () => {
    const result = configureLlmFromControlPlaneParams({
      providerType: 'openai',
      apiKey: 'sk-new',
      model: 'gpt-4.1-mini',
    });

    expect(mockFactory.applyModelSelection).toHaveBeenCalledWith(expect.any(Object), 'gpt-4.1-mini');
    expect(mockFactory.saveSettings).toHaveBeenCalledWith(expect.objectContaining({
      providerType: 'openai',
      modelKey: 'gpt-4.1-mini',
      openai: expect.objectContaining({
        apiKey: 'sk-new',
        authMethod: 'api_key',
      }),
    }));
    expect(mockFactory.clearCache).toHaveBeenCalled();
    expect(result.llm.currentProvider).toBe('openai');
  });

  it('rejects unsupported provider types', () => {
    try {
      configureLlmFromControlPlaneParams({
        providerType: 'not-a-provider',
      });
      throw new Error('Expected unsupported provider to throw');
    } catch (error: any) {
      expect(error).toMatchObject({
        code: 'INVALID_PARAMS',
      });
      expect(String(error.message)).toContain('Unsupported providerType');
    }
  });

  it('rejects bedrock apiKey parameter usage', () => {
    try {
      configureLlmFromControlPlaneParams({
        providerType: 'bedrock',
        apiKey: 'bad-key',
      });
      throw new Error('Expected bedrock configuration to throw');
    } catch (error: any) {
      expect(error).toMatchObject({
        code: 'INVALID_PARAMS',
      });
      expect(String(error.message)).toContain('providerType=bedrock');
    }
  });
});
