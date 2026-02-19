import {
  LLMContent,
  LLMImageContent,
  LLMMessage,
  LLMResponse,
  LLMTool,
} from './types';
import { imageToTextFallback } from './image-utils';

export interface OpenAICompatibleMessageOptions {
  /** Set to false to replace image blocks with text fallback (default: false) */
  supportsImages?: boolean;
}

export function toOpenAICompatibleMessages(
  messages: LLMMessage[],
  system?: string,
  options?: OpenAICompatibleMessageOptions,
): Array<{ role: string; content: any; tool_call_id?: string; tool_calls?: any[] }> {
  const result: Array<{ role: string; content: any; tool_call_id?: string; tool_calls?: any[] }> = [];
  const supportsImages = options?.supportsImages === true;

  if (system) {
    result.push({ role: 'system', content: system });
  }

  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      result.push({ role: msg.role, content: msg.content });
      continue;
    }

    if (!Array.isArray(msg.content)) {
      continue;
    }

    const imageBlocks: LLMImageContent[] = [];
    const textParts: string[] = [];
    const toolCalls: any[] = [];
    const shouldInlineImages = supportsImages && msg.role === 'user';

    for (const item of msg.content) {
      if (item.type === 'tool_result') {
        result.push({
          role: 'tool',
          content: item.content,
          tool_call_id: item.tool_use_id,
        });
      } else if (item.type === 'tool_use') {
        toolCalls.push({
          id: item.id,
          type: 'function',
          function: {
            name: item.name,
            arguments: JSON.stringify(item.input),
          },
        });
      } else if (item.type === 'text') {
        textParts.push(item.text);
      } else if (item.type === 'image') {
        if (shouldInlineImages) {
          imageBlocks.push(item);
        } else {
          textParts.push(imageToTextFallback(item));
        }
      }
    }

    if (msg.role === 'assistant' && toolCalls.length > 0) {
      const assistantContent = textParts.length > 0 ? textParts.join('\n') : null;
      result.push({
        role: msg.role,
        content: assistantContent,
        tool_calls: toolCalls,
      });
      continue;
    }

    if (imageBlocks.length > 0) {
      const contentParts: any[] = [];
      if (textParts.length > 0) {
        contentParts.push({ type: 'text', text: textParts.join('\n') });
      }
      for (const img of imageBlocks) {
        contentParts.push({
          type: 'image_url',
          image_url: { url: `data:${img.mimeType};base64,${img.data}` },
        });
      }
      result.push({ role: msg.role, content: contentParts });
      continue;
    }

    if (textParts.length > 0) {
      result.push({ role: msg.role, content: textParts.join('\n') });
    }
  }

  return result;
}

export function toOpenAICompatibleTools(tools: LLMTool[]): Array<{
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: any;
  };
}> {
  return tools.map((tool) => ({
    type: 'function' as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  }));
}

export function fromOpenAICompatibleResponse(response: any): LLMResponse {
  const content: LLMContent[] = [];
  const choice = response.choices?.[0];

  if (!choice) {
    return {
      content: [{ type: 'text', text: '' }],
      stopReason: 'end_turn',
    };
  }

  const message = choice.message;

  if (message?.content) {
    content.push({
      type: 'text',
      text: message.content,
    });
  }

  if (message?.tool_calls) {
    for (const toolCall of message.tool_calls) {
      if (toolCall.type === 'function') {
        content.push({
          type: 'tool_use',
          id: toolCall.id,
          name: toolCall.function.name,
          input: JSON.parse(toolCall.function.arguments || '{}'),
        });
      }
    }
  }

  if (content.length === 0) {
    content.push({ type: 'text', text: '' });
  }

  return {
    content,
    stopReason: mapStopReason(choice.finish_reason),
    usage: response.usage
      ? {
          inputTokens: response.usage.prompt_tokens || 0,
          outputTokens: response.usage.completion_tokens || 0,
        }
      : undefined,
  };
}

export function mapStopReason(finishReason?: string): LLMResponse['stopReason'] {
  switch (finishReason) {
    case 'stop':
      return 'end_turn';
    case 'length':
      return 'max_tokens';
    case 'tool_calls':
      return 'tool_use';
    case 'content_filter':
      return 'stop_sequence';
    default:
      return 'end_turn';
  }
}
