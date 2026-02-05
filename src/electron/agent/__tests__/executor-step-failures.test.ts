/**
 * Tests for step failure/verification behavior in TaskExecutor.executeStep
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TaskExecutor } from '../executor';
import type { LLMResponse } from '../llm';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp'),
  },
}));

vi.mock('../../settings/personality-manager', () => ({
  PersonalityManager: {
    getPersonalityPrompt: vi.fn().mockReturnValue(''),
    getIdentityPrompt: vi.fn().mockReturnValue(''),
  },
}));

vi.mock('../../memory/MemoryService', () => ({
  MemoryService: {
    getContextForInjection: vi.fn().mockReturnValue(''),
  },
}));

function toolUseResponse(name: string, input: Record<string, any>): LLMResponse {
  return {
    stopReason: 'tool_use',
    content: [
      {
        type: 'tool_use',
        id: `tool-${name}`,
        name,
        input,
      },
    ],
  };
}

function textResponse(text: string): LLMResponse {
  return {
    stopReason: 'end_turn',
    content: [
      {
        type: 'text',
        text,
      },
    ],
  };
}

function createExecutorWithStubs(responses: LLMResponse[], toolResults: Record<string, any>) {
  const executor = Object.create(TaskExecutor.prototype) as any;

  executor.task = {
    id: 'task-1',
    title: 'Test Task',
    prompt: 'Test prompt',
    createdAt: Date.now() - 1000,
  };
  executor.workspace = {
    id: 'workspace-1',
    path: '/tmp',
    permissions: { read: true, write: true, delete: true, network: true, shell: true },
  };
  executor.daemon = { logEvent: vi.fn() };
  executor.contextManager = { compactMessages: vi.fn((messages: any) => messages) };
  executor.checkBudgets = vi.fn();
  executor.updateTracking = vi.fn();
  executor.getAvailableTools = vi.fn().mockReturnValue([
    { name: 'run_command', description: '', input_schema: { type: 'object', properties: {} } },
    { name: 'glob', description: '', input_schema: { type: 'object', properties: {} } },
    { name: 'web_search', description: '', input_schema: { type: 'object', properties: {} } },
  ]);
  executor.handleCanvasPushFallback = vi.fn();
  executor.getToolTimeoutMs = vi.fn().mockReturnValue(1000);
  executor.checkFileOperation = vi.fn().mockReturnValue({ blocked: false });
  executor.recordFileOperation = vi.fn();
  executor.recordCommandExecution = vi.fn();
  executor.fileOperationTracker = { getKnowledgeSummary: vi.fn().mockReturnValue('') };
  executor.toolFailureTracker = {
    isDisabled: vi.fn().mockReturnValue(false),
    getLastError: vi.fn().mockReturnValue(''),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn().mockReturnValue(false),
  };
  executor.toolCallDeduplicator = {
    checkDuplicate: vi.fn().mockReturnValue({ isDuplicate: false }),
    recordCall: vi.fn(),
  };
  executor.toolResultMemory = [];
  executor.lastAssistantOutput = null;
  executor.toolResultMemoryLimit = 8;
  executor.toolRegistry = {
    executeTool: vi.fn(async (name: string) => {
      if (name in toolResults) return toolResults[name];
      return { success: true };
    }),
  };
  executor.callLLMWithRetry = vi.fn().mockImplementation(async () => {
    const response = responses.shift();
    if (!response) {
      throw new Error('No more LLM responses configured');
    }
    return response;
  });
  executor.abortController = new AbortController();
  executor.taskCompleted = false;
  executor.cancelled = false;

  return executor as TaskExecutor & {
    daemon: { logEvent: ReturnType<typeof vi.fn> };
    toolRegistry: { executeTool: ReturnType<typeof vi.fn> };
  };
}

function createExecutorWithLLMHandler(
  handler: (messages: any[]) => LLMResponse
) {
  const executor = Object.create(TaskExecutor.prototype) as any;

  executor.task = {
    id: 'task-1',
    title: 'Today F1 news',
    prompt: 'Search for the latest Formula 1 news from today and summarize.',
    createdAt: Date.now() - 1000,
  };
  executor.workspace = {
    id: 'workspace-1',
    path: '/tmp',
    permissions: { read: true, write: true, delete: true, network: true, shell: true },
  };
  executor.daemon = { logEvent: vi.fn() };
  executor.contextManager = { compactMessages: vi.fn((messages: any) => messages) };
  executor.checkBudgets = vi.fn();
  executor.updateTracking = vi.fn();
  executor.getAvailableTools = vi.fn().mockReturnValue([]);
  executor.handleCanvasPushFallback = vi.fn();
  executor.getToolTimeoutMs = vi.fn().mockReturnValue(1000);
  executor.checkFileOperation = vi.fn().mockReturnValue({ blocked: false });
  executor.recordFileOperation = vi.fn();
  executor.recordCommandExecution = vi.fn();
  executor.fileOperationTracker = { getKnowledgeSummary: vi.fn().mockReturnValue('') };
  executor.toolFailureTracker = {
    isDisabled: vi.fn().mockReturnValue(false),
    getLastError: vi.fn().mockReturnValue(''),
    recordSuccess: vi.fn(),
    recordFailure: vi.fn().mockReturnValue(false),
  };
  executor.toolCallDeduplicator = {
    checkDuplicate: vi.fn().mockReturnValue({ isDuplicate: false }),
    recordCall: vi.fn(),
  };
  executor.toolResultMemory = [];
  executor.lastAssistantOutput = null;
  executor.lastNonVerificationOutput = null;
  executor.toolResultMemoryLimit = 8;
  executor.toolRegistry = {
    executeTool: vi.fn(async () => ({ success: true })),
  };
  executor.provider = {
    createMessage: vi.fn(async (args: any) => handler(args.messages)),
  };
  executor.callLLMWithRetry = vi.fn().mockImplementation(async (requestFn: any) => {
    return requestFn();
  });
  executor.abortController = new AbortController();
  executor.taskCompleted = false;
  executor.cancelled = false;

  return executor as TaskExecutor & {
    daemon: { logEvent: ReturnType<typeof vi.fn> };
  };
}

describe('TaskExecutor executeStep failure handling', () => {
  let executor: ReturnType<typeof createExecutorWithStubs>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('marks step failed when run_command fails and no recovery occurs', async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse('run_command', { command: 'exit 1' }),
        textResponse('done'),
      ],
      {
        run_command: { success: false, exitCode: 1 },
      }
    );

    const step: any = { id: '1', description: 'Execute a command', status: 'pending' };

    await (executor as any).executeStep(step);

    expect(step.status).toBe('failed');
    expect(step.error).toContain('run_command');
  });

  it('marks verification step failed when no new image is found', async () => {
    const oldTimestamp = new Date(Date.now() - 60 * 60 * 1000).toISOString();
    executor = createExecutorWithStubs(
      [
        toolUseResponse('glob', { pattern: '**/*.{png,jpg,jpeg,webp}' }),
        textResponse('checked'),
      ],
      {
        glob: {
          success: true,
          matches: [{ path: 'old.png', modified: oldTimestamp }],
        },
      }
    );

    const step: any = {
      id: '2',
      description: 'Verify: Confirm the generated image file exists and report the result',
      status: 'pending',
    };

    await (executor as any).executeStep(step);

    expect(step.status).toBe('failed');
    expect(step.error).toContain('no newly generated image');
  });

  it('pauses when assistant asks blocking questions', async () => {
    executor = createExecutorWithStubs(
      [
        textResponse('1) Who is the primary user?\n2) What is the core flow?\n3) List 3 must-have features.'),
      ],
      {}
    );

    const step: any = { id: '3', description: 'Clarify requirements', status: 'pending' };

    await expect((executor as any).executeStep(step)).rejects.toMatchObject({
      name: 'AwaitingUserInputError',
    });
  });

  it('does not fail step when only web_search errors occur after a successful tool', async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse('glob', { pattern: '**/*.md' }),
        toolUseResponse('web_search', { query: 'test', searchType: 'web' }),
        textResponse('summary'),
      ],
      {
        glob: { success: true, matches: [], totalMatches: 0 },
        web_search: { success: false, error: 'timeout' },
      }
    );

    const step: any = { id: '4', description: 'Search and summarize', status: 'pending' };

    await (executor as any).executeStep(step);

    expect(step.status).toBe('completed');
  });

  it('normalizes namespaced tool names like functions.web_search', async () => {
    const toolSpy = vi.fn(async () => ({ success: true, results: [] }));
    executor = createExecutorWithStubs(
      [
        toolUseResponse('functions.web_search', { query: 'test', searchType: 'web' }),
        textResponse('summary'),
      ],
      {
        web_search: { success: true, results: [] },
      }
    );
    (executor as any).toolRegistry.executeTool = toolSpy;

    const step: any = { id: '5', description: 'Search for info', status: 'pending' };

    await (executor as any).executeStep(step);

    expect(toolSpy).toHaveBeenCalledWith('web_search', { query: 'test', searchType: 'web' });
    expect(step.status).toBe('completed');
  });

  it('includes recap context for final verify step in today news tasks', async () => {
    let callCount = 0;
    let verifyContextHasFinalStep = false;
    let verifyContextHasDeliverable = false;
    let verifyContextIncludesSummary = false;

    const executor = createExecutorWithLLMHandler((messages) => {
      callCount += 1;
      const stepContext = String(messages?.[0]?.content || '');

      if (callCount === 1) {
        return textResponse('Summary: Key F1 headlines from today.');
      }

      verifyContextHasFinalStep = stepContext.includes('FINAL step');
      verifyContextHasDeliverable = stepContext.includes('MOST RECENT DELIVERABLE');
      verifyContextIncludesSummary = stepContext.includes('Summary: Key F1 headlines from today.');

      return textResponse('Recap: Summary: Key F1 headlines from today. Verification: Sources dated today.');
    });

    const summaryStep: any = { id: '1', description: 'Write a concise summary of today’s F1 news', status: 'pending' };
    const verifyStep: any = { id: '2', description: 'Verify: Ensure all summary items are from today’s news', status: 'pending' };

    (executor as any).plan = { description: 'Plan', steps: [summaryStep, verifyStep] };

    await (executor as any).executeStep(summaryStep);
    await (executor as any).executeStep(verifyStep);

    expect((executor as any).lastNonVerificationOutput).toContain('Summary: Key F1 headlines from today.');
    expect(verifyContextHasFinalStep).toBe(true);
    expect(verifyContextHasDeliverable).toBe(true);
    expect(verifyContextIncludesSummary).toBe(true);
  });
});
