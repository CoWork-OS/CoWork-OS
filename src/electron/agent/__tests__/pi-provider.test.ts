/**
 * Tests for PiProvider: constructor validation, model resolution,
 * message conversion, and response conversion.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock @mariozechner/pi-ai before importing PiProvider
vi.mock('@mariozechner/pi-ai', () => ({
  getModel: vi.fn(),
  getModels: vi.fn(() => [
    { id: 'claude-sonnet-4-5-20250514', name: 'Claude Sonnet 4.5', reasoning: false, contextWindow: 200000 },
    { id: 'gpt-4o', name: 'GPT-4o', reasoning: false, contextWindow: 128000 },
  ]),
  getProviders: vi.fn(() => ['anthropic', 'openai']),
  complete: vi.fn(),
}));

import { PiProvider } from '../llm/pi-provider';
import { getModels } from '@mariozechner/pi-ai';
import type { LLMProviderConfig, LLMMessage, LLMResponse } from '../llm/types';

function createConfig(overrides: Partial<LLMProviderConfig> = {}): LLMProviderConfig {
  return {
    type: 'pi',
    model: 'claude-sonnet-4-5-20250514',
    piProvider: 'anthropic',
    piApiKey: 'test-key',
    ...overrides,
  };
}

// Access private methods for unit testing
function getPrivate(provider: PiProvider): any {
  return provider as any;
}

describe('PiProvider', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('constructor validation', () => {
    it('should construct successfully with valid config', () => {
      const provider = new PiProvider(createConfig());
      expect(provider.type).toBe('pi');
    });

    it('should throw for unknown backend provider', () => {
      expect(() => new PiProvider(createConfig({ piProvider: 'invalid-provider' }))).toThrow(
        /Unknown Pi backend provider: "invalid-provider"/
      );
    });

    it('should throw when API key is missing', () => {
      expect(() => new PiProvider(createConfig({ piApiKey: '' }))).toThrow(
        /Pi provider requires an API key/
      );
    });

    it('should throw when API key is undefined', () => {
      expect(() => new PiProvider(createConfig({ piApiKey: undefined }))).toThrow(
        /Pi provider requires an API key/
      );
    });

    it('should default to anthropic when piProvider is not set', () => {
      const provider = new PiProvider(createConfig({ piProvider: undefined }));
      expect(getPrivate(provider).piProvider).toBe('anthropic');
    });
  });

  describe('resolveModel', () => {
    it('should return model on exact match', () => {
      const provider = new PiProvider(createConfig());
      const model = getPrivate(provider).resolveModel('claude-sonnet-4-5-20250514');
      expect(model.id).toBe('claude-sonnet-4-5-20250514');
    });

    it('should throw when model is not found (no partial matching)', () => {
      const provider = new PiProvider(createConfig());
      expect(() => getPrivate(provider).resolveModel('nonexistent-model')).toThrow(
        /Model "nonexistent-model" not found for provider anthropic/
      );
    });

    it('should throw for partial model ID match (no fuzzy fallback)', () => {
      const provider = new PiProvider(createConfig());
      // "claude" is a substring of "claude-sonnet-4-5-20250514" but should NOT match
      expect(() => getPrivate(provider).resolveModel('claude')).toThrow(
        /Model "claude" not found/
      );
    });

    it('should list available models in error message', () => {
      const provider = new PiProvider(createConfig());
      try {
        getPrivate(provider).resolveModel('missing');
        expect.fail('Should have thrown');
      } catch (e: any) {
        expect(e.message).toContain('claude-sonnet-4-5-20250514');
        expect(e.message).toContain('gpt-4o');
      }
    });
  });

  describe('convertMessagesToPiAi', () => {
    it('should convert a simple user string message', () => {
      const provider = new PiProvider(createConfig());
      const messages: LLMMessage[] = [
        { role: 'user', content: 'Hello' },
      ];

      const result = getPrivate(provider).convertMessagesToPiAi(messages);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('user');
      expect(result[0].content).toEqual([{ type: 'text', text: 'Hello' }]);
    });

    it('should convert an assistant string message with placeholder usage', () => {
      const provider = new PiProvider(createConfig());
      const messages: LLMMessage[] = [
        { role: 'assistant', content: 'Hi there' },
      ];

      const result = getPrivate(provider).convertMessagesToPiAi(messages);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('assistant');
      expect(result[0].content).toEqual([{ type: 'text', text: 'Hi there' }]);
      // Verify placeholder usage is zeroed
      expect(result[0].usage.input).toBe(0);
      expect(result[0].usage.output).toBe(0);
      expect(result[0].usage.totalTokens).toBe(0);
    });

    it('should convert tool_use blocks and track tool names', () => {
      const provider = new PiProvider(createConfig());
      const messages: LLMMessage[] = [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call-1', name: 'read_file', input: { path: '/tmp/test' } } as any,
          ],
        },
      ];

      const result = getPrivate(provider).convertMessagesToPiAi(messages);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('assistant');
      expect(result[0].content[0]).toEqual({
        type: 'toolCall',
        id: 'call-1',
        name: 'read_file',
        arguments: { path: '/tmp/test' },
      });
    });

    it('should populate toolName on tool results from preceding tool calls', () => {
      const provider = new PiProvider(createConfig());
      const messages: LLMMessage[] = [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'call-1', name: 'read_file', input: {} } as any,
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call-1', content: 'file contents' },
          ] as any,
        },
      ];

      const result = getPrivate(provider).convertMessagesToPiAi(messages);
      const toolResult = result.find((m: any) => m.role === 'toolResult');
      expect(toolResult).toBeDefined();
      expect(toolResult.toolName).toBe('read_file');
    });

    it('should handle tool results with no matching preceding tool call', () => {
      const provider = new PiProvider(createConfig());
      const messages: LLMMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'orphan-id', content: 'data' },
          ] as any,
        },
      ];

      const result = getPrivate(provider).convertMessagesToPiAi(messages);
      const toolResult = result.find((m: any) => m.role === 'toolResult');
      expect(toolResult.toolName).toBe('');
    });

    it('should convert user array content (text only)', () => {
      const provider = new PiProvider(createConfig());
      const messages: LLMMessage[] = [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'Part 1' } as any,
            { type: 'text', text: 'Part 2' } as any,
          ],
        },
      ];

      const result = getPrivate(provider).convertMessagesToPiAi(messages);
      expect(result).toHaveLength(1);
      expect(result[0].role).toBe('user');
      expect(result[0].content).toHaveLength(2);
    });
  });

  describe('convertPiAiResponse', () => {
    it('should convert text response', () => {
      const provider = new PiProvider(createConfig());
      const piResponse = {
        role: 'assistant',
        content: [{ type: 'text', text: 'Hello world' }],
        stopReason: 'stop',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        api: 'openai-completions',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250514',
        timestamp: Date.now(),
      };

      const result: LLMResponse = getPrivate(provider).convertPiAiResponse(piResponse);
      expect(result.content).toEqual([{ type: 'text', text: 'Hello world' }]);
      expect(result.stopReason).toBe('end_turn');
      expect(result.usage).toEqual({ inputTokens: 10, outputTokens: 5 });
    });

    it('should convert tool call response', () => {
      const provider = new PiProvider(createConfig());
      const piResponse = {
        role: 'assistant',
        content: [
          { type: 'toolCall', id: 'tc-1', name: 'bash', arguments: { cmd: 'ls' } },
        ],
        stopReason: 'toolUse',
        usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        api: 'openai-completions',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250514',
        timestamp: Date.now(),
      };

      const result: LLMResponse = getPrivate(provider).convertPiAiResponse(piResponse);
      expect(result.content).toEqual([
        { type: 'tool_use', id: 'tc-1', name: 'bash', input: { cmd: 'ls' } },
      ]);
      expect(result.stopReason).toBe('tool_use');
    });

    it('should map length stop reason to max_tokens', () => {
      const provider = new PiProvider(createConfig());
      const piResponse = {
        role: 'assistant',
        content: [{ type: 'text', text: 'truncated' }],
        stopReason: 'length',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        api: 'openai-completions',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250514',
        timestamp: Date.now(),
      };

      const result: LLMResponse = getPrivate(provider).convertPiAiResponse(piResponse);
      expect(result.stopReason).toBe('max_tokens');
    });

    it('should skip thinking blocks', () => {
      const provider = new PiProvider(createConfig());
      const piResponse = {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me reason...' },
          { type: 'text', text: 'Answer' },
        ],
        stopReason: 'stop',
        usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
        api: 'openai-completions',
        provider: 'anthropic',
        model: 'claude-sonnet-4-5-20250514',
        timestamp: Date.now(),
      };

      const result: LLMResponse = getPrivate(provider).convertPiAiResponse(piResponse);
      expect(result.content).toEqual([{ type: 'text', text: 'Answer' }]);
    });
  });
});
