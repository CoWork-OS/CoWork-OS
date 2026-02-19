import { describe, expect, it } from 'vitest';
import { toOpenAICompatibleMessages } from '../openai-compatible';

describe('toOpenAICompatibleMessages', () => {
  it('keeps assistant text and tool calls in one ordered message block', () => {
    const input = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'Preparing your summary.' },
          {
            type: 'tool_use' as const,
            id: 'tool-1',
            name: 'search_web',
            input: { query: 'workspace status' },
          },
        ],
      },
    ];

    const result = toOpenAICompatibleMessages(input);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: 'assistant',
      content: 'Preparing your summary.',
      tool_calls: [
        {
          id: 'tool-1',
          type: 'function',
          function: {
            name: 'search_web',
            arguments: '{"query":"workspace status"}',
          },
        },
      ],
    });
  });

  it('does not drop text when image and tool_use are both present for an assistant message', () => {
    const input = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'Analyzing image and tools.' },
          {
            type: 'tool_use' as const,
            id: 'tool-2',
            name: 'scan_image',
            input: { confidence: 0.9 },
          },
          {
            type: 'image' as const,
            mimeType: 'image/png',
            data: 'AAECAw==',
          },
        ],
      },
    ];

    const result = toOpenAICompatibleMessages(input);

    expect(result[0]).toMatchObject({
      role: 'assistant',
      content: 'Analyzing image and tools.\n[Image attached: image/png, 0.0MB — this provider does not support inline images. Use the "analyze_image" tool to process this image, or switch to a vision-capable provider.]',
      tool_calls: [
        {
          id: 'tool-2',
        },
      ],
    });
    expect(result).toHaveLength(1);
    expect(result[0].content).toContain('[Image attached: image/png');
  });

  it('falls back to text for assistant image content', () => {
    const input = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'image' as const, mimeType: 'image/jpeg', data: 'AQIDBA==' },
          { type: 'text' as const, text: 'Summary from previous model.' },
        ],
      },
    ];

    const result = toOpenAICompatibleMessages(input, undefined, { supportsImages: true });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: 'assistant',
    });
    expect(result[0].content).toContain('[Image attached: image/jpeg');
    expect(result[0].content).toContain('Summary from previous model.');
    expect(result[0].content).not.toContain('image_url');
  });

  it('falls back to text for user image content by default', () => {
    const input = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'Here is an image:' },
          { type: 'image' as const, mimeType: 'image/png', data: 'AQIDBA==' },
        ],
      },
    ];

    const result = toOpenAICompatibleMessages(input);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: 'user',
      content: 'Here is an image:\n[Image attached: image/png, 0.0MB — this provider does not support inline images. Use the "analyze_image" tool to process this image, or switch to a vision-capable provider.]',
    });
  });

  it('keeps assistant text and tool calls in one block with image fallback when text is empty', () => {
    const input = [
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool_use' as const,
            id: 'tool-3',
            name: 'fetch_status',
            input: { taskId: 'task-7' },
          },
          {
            type: 'image' as const,
            mimeType: 'image/jpeg',
            data: 'AQIDBA==',
          },
        ],
      },
    ];

    const result = toOpenAICompatibleMessages(input);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: 'assistant',
      tool_calls: [
        {
          id: 'tool-3',
          type: 'function',
          function: {
            name: 'fetch_status',
            arguments: '{"taskId":"task-7"}',
          },
        },
      ],
    });
    expect(result[0].content).toContain('[Image attached: image/jpeg');
  });

  it('does not emit image_url for assistant messages with text, tool calls, and images', () => {
    const input = [
      {
        role: 'assistant' as const,
        content: [
          { type: 'text' as const, text: 'Reviewing attached screenshot.' },
          {
            type: 'tool_use' as const,
            id: 'tool-4',
            name: 'describe_image',
            input: { confidence: 0.95 },
          },
          { type: 'image' as const, mimeType: 'image/png', data: 'AQIDBA==' },
        ],
      },
    ];

    const result = toOpenAICompatibleMessages(input, undefined, { supportsImages: true });

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      role: 'assistant',
      content:
        'Reviewing attached screenshot.\n[Image attached: image/png, 0.0MB — this provider does not support inline images. Use the "analyze_image" tool to process this image, or switch to a vision-capable provider.]',
      tool_calls: [
        {
          id: 'tool-4',
          type: 'function',
          function: {
            name: 'describe_image',
            arguments: '{"confidence":0.95}',
          },
        },
      ],
    });
    expect(result[0].content).not.toContain('image_url');
  });

  it('omits image payload when provider does not support images', () => {
    const input = [
      {
        role: 'user' as const,
        content: [
          { type: 'text' as const, text: 'Here is an image:' },
          { type: 'image' as const, mimeType: 'image/png', data: 'AQIDBA==' },
        ],
      },
    ];

    const result = toOpenAICompatibleMessages(input, undefined, { supportsImages: false });

    expect(result).toHaveLength(1);
    expect(result[0].content).toBe(
      'Here is an image:\n[Image attached: image/png, 0.0MB — this provider does not support inline images. Use the "analyze_image" tool to process this image, or switch to a vision-capable provider.]'
    );
    expect(result[0].content).not.toContain('image_url');
  });
});
