import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AzureOpenAIProvider } from '../azure-openai-provider';
import type { LLMRequest } from '../types';

const mockFetch = vi.fn();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
(global as any).fetch = mockFetch;

const baseConfig = {
  type: 'azure' as const,
  model: '',
  azureApiKey: 'test-key',
  azureEndpoint: 'https://example.openai.azure.com/',
  azureDeployment: 'my deployment',
  azureApiVersion: '2024-05-01',
};

beforeEach(() => {
  mockFetch.mockReset();
});

function createOkResponse(data: any) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    json: vi.fn().mockResolvedValue(data),
  };
}

function createErrorResponse(status: number, statusText: string, data: any) {
  return {
    ok: false,
    status,
    statusText,
    json: vi.fn().mockResolvedValue(data),
  };
}

describe('AzureOpenAIProvider', () => {
  it('builds the request URL and payload for connection tests', async () => {
    mockFetch.mockResolvedValue(createOkResponse({ choices: [] }));

    const provider = new AzureOpenAIProvider(baseConfig);
    const result = await provider.testConnection();

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledTimes(1);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe(
      'https://example.openai.azure.com/openai/deployments/my%20deployment/chat/completions?api-version=2024-05-01'
    );

    expect(options?.headers).toMatchObject({
      'Content-Type': 'application/json',
      'api-key': 'test-key',
    });

    const body = JSON.parse(options.body);
    expect(body.model).toBe('my deployment');
    expect(body.messages).toEqual([{ role: 'user', content: 'Hi' }]);
    expect(body.max_tokens).toBe(16);
  });

  it('returns Azure error details when connection fails', async () => {
    mockFetch.mockResolvedValue(
      createErrorResponse(401, 'Unauthorized', { error: { message: 'invalid key' } })
    );

    const provider = new AzureOpenAIProvider(baseConfig);
    const result = await provider.testConnection();

    expect(result).toEqual({ success: false, error: 'invalid key' });
  });

  it('retries connection test with max_completion_tokens when max_tokens is unsupported', async () => {
    mockFetch
      .mockResolvedValueOnce(
        createErrorResponse(400, 'Bad Request', {
          error: {
            message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
          },
        })
      )
      .mockResolvedValueOnce(createOkResponse({ choices: [] }));

    const provider = new AzureOpenAIProvider(baseConfig);
    const result = await provider.testConnection();

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const firstBody = JSON.parse(mockFetch.mock.calls[0][1].body);
    const secondBody = JSON.parse(mockFetch.mock.calls[1][1].body);
    expect(firstBody.max_tokens).toBe(16);
    expect(secondBody.max_completion_tokens).toBe(16);
  });

  it('falls back to Responses API when chat completions are unsupported during connection test', async () => {
    mockFetch
      .mockResolvedValueOnce(
        createErrorResponse(400, 'Bad Request', {
          error: {
            message: 'The chatCompletion operation does not work with the specified model.',
          },
        })
      )
      .mockResolvedValueOnce(createOkResponse({ output: [] }));

    const provider = new AzureOpenAIProvider(baseConfig);
    const result = await provider.testConnection();

    expect(result).toEqual({ success: true });
    expect(mockFetch).toHaveBeenCalledTimes(2);

    const [firstUrl] = mockFetch.mock.calls[0];
    const [secondUrl, secondOptions] = mockFetch.mock.calls[1];
    expect(firstUrl).toContain('/chat/completions?api-version=2024-05-01');
    expect(secondUrl).toBe('https://example.openai.azure.com/openai/v1/responses');

    const body = JSON.parse(secondOptions.body);
    expect(body.max_output_tokens).toBe(16);
    expect(body.input[0].content[0].text).toBe('Hi');
  });

  it('sends model requests and parses responses', async () => {
    mockFetch.mockResolvedValue(
      createOkResponse({
        choices: [{ message: { content: 'hello' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 5, completion_tokens: 7 },
      })
    );

    const provider = new AzureOpenAIProvider(baseConfig);
    const request: LLMRequest = {
      model: 'gpt-4o',
      maxTokens: 20,
      system: 'system prompt',
      messages: [{ role: 'user', content: 'hi' }],
    };

    const response = await provider.createMessage(request);

    expect(response.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(response.stopReason).toBe('end_turn');
    expect(response.usage).toEqual({ inputTokens: 5, outputTokens: 7 });

    const [, options] = mockFetch.mock.calls[0];
    const body = JSON.parse(options.body);
    expect(body.model).toBe('gpt-4o');
  });

  it('falls back to Responses API when chat completions are unsupported', async () => {
    mockFetch
      .mockResolvedValueOnce(
        createErrorResponse(400, 'Bad Request', {
          error: {
            message: 'The chatCompletion operation does not work with the specified model.',
          },
        })
      )
      .mockResolvedValueOnce(
        createOkResponse({
          output: [{ type: 'message', content: [{ type: 'output_text', text: 'hello' }] }],
          usage: { input_tokens: 2, output_tokens: 3 },
        })
      );

    const provider = new AzureOpenAIProvider(baseConfig);
    const request: LLMRequest = {
      model: 'gpt-5.2-codex',
      maxTokens: 20,
      system: 'system prompt',
      messages: [{ role: 'user', content: 'hi' }],
    };

    const response = await provider.createMessage(request);

    expect(response.content).toEqual([{ type: 'text', text: 'hello' }]);
    expect(response.stopReason).toBe('end_turn');
    expect(response.usage).toEqual({ inputTokens: 2, outputTokens: 3 });

    const [responsesUrl, responsesOptions] = mockFetch.mock.calls[1];
    expect(responsesUrl).toBe('https://example.openai.azure.com/openai/v1/responses');
    const body = JSON.parse(responsesOptions.body);
    expect(body.instructions).toBe('system prompt');
    expect(body.model).toBe('gpt-5.2-codex');
    expect(body.input[0].content[0].text).toBe('hi');
  });

  it('throws a descriptive error on API failures', async () => {
    mockFetch.mockResolvedValue(
      createErrorResponse(400, 'Bad Request', { error: { message: 'bad stuff' } })
    );

    const provider = new AzureOpenAIProvider(baseConfig);
    const request: LLMRequest = {
      model: 'gpt-4o',
      maxTokens: 20,
      system: 'system prompt',
      messages: [{ role: 'user', content: 'hi' }],
    };

    await expect(provider.createMessage(request)).rejects.toThrow(
      'Azure OpenAI API error: 400 Bad Request - bad stuff'
    );
  });
});
