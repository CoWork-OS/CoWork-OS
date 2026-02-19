import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { LLMProviderConfig, LLMRequest } from '../types';
import { BedrockProvider } from '../bedrock-provider';

// Keep provider initialization predictable; no profile creds needed

let capturedConverseInput: any = null;

vi.mock('@aws-sdk/client-bedrock-runtime', () => ({
  BedrockRuntimeClient: vi.fn().mockImplementation(function (this: any) {
    this.send = vi.fn(async (command: any) => {
      capturedConverseInput = command?.input ?? null;
      return {
        output: {
          message: {
            content: [{ text: 'ok' }],
          },
        },
        stopReason: 'end_turn',
        usage: {
          inputTokens: 10,
          outputTokens: 20,
        },
      };
    });
  }),
  ConverseCommand: vi.fn().mockImplementation(function (input: any) {
    return { input };
  }),
}));

const config: LLMProviderConfig = {
  type: 'bedrock',
  model: 'us.anthropic.claude-opus-4-6-v1',
  awsRegion: 'us-east-1',
};

describe('BedrockProvider', () => {
  beforeEach(() => {
    capturedConverseInput = null;
    vi.clearAllMocks();
  });

  it('rewrites terminal synthetic assistant placeholder into a user message for Bedrock', async () => {
    const provider = new BedrockProvider(config);

    const request: LLMRequest = {
      model: config.model,
      maxTokens: 10,
      system: 'system prompt',
      messages: [
        { role: 'user', content: 'start task' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'I understand. Let me continue.' }],
        },
      ],
    };

    const response = await provider.createMessage(request);

    expect(response.content).toEqual([{ type: 'text', text: 'ok' }]);
    expect(capturedConverseInput).toBeDefined();
    expect(capturedConverseInput.messages).toHaveLength(2);
    expect(capturedConverseInput.messages[1]).toMatchObject({
      role: 'user',
      content: [{ text: 'I understand. Let me continue.' }],
    });
  });

  it('does not rewrite terminal assistant messages that contain real assistant content', async () => {
    const provider = new BedrockProvider(config);

    const request: LLMRequest = {
      model: config.model,
      maxTokens: 10,
      system: 'system prompt',
      messages: [
        { role: 'user', content: 'start task' },
        {
          role: 'assistant',
          content: [{ type: 'text', text: 'I completed the step.' }],
        },
      ],
    };

    await provider.createMessage(request);

    expect(capturedConverseInput).toBeDefined();
    expect(capturedConverseInput.messages[1]).toMatchObject({
      role: 'assistant',
      content: [{ text: 'I completed the step.' }],
    });
  });
});
