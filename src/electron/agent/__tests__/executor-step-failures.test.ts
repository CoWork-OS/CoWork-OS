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
  executor.contextManager = {
    compactMessagesWithMeta: vi.fn((messages: any) => ({
      messages,
      meta: {
        availableTokens: 1_000_000,
        originalTokens: 0,
        truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: 0 },
        removedMessages: { didRemove: false, count: 0, tokensAfter: 0, messages: [] },
        kind: 'none',
      },
    })),
    getAvailableTokens: vi.fn().mockReturnValue(1_000_000),
  };
  executor.checkBudgets = vi.fn();
  executor.updateTracking = vi.fn();
  executor.getAvailableTools = vi.fn().mockReturnValue([
    { name: 'run_command', description: '', input_schema: { type: 'object', properties: {} } },
    { name: 'glob', description: '', input_schema: { type: 'object', properties: {} } },
    { name: 'web_search', description: '', input_schema: { type: 'object', properties: {} } },
    { name: 'write_file', description: '', input_schema: { type: 'object', properties: {} } },
    { name: 'create_document', description: '', input_schema: { type: 'object', properties: {} } },
    { name: 'edit_file', description: '', input_schema: { type: 'object', properties: {} } },
  ]);
  executor.handleCanvasPushFallback = vi.fn();
  executor.getToolTimeoutMs = vi.fn().mockReturnValue(1000);
  executor.checkFileOperation = vi.fn().mockReturnValue({ blocked: false });
  executor.recordFileOperation = vi.fn();
  executor.recordCommandExecution = vi.fn();
  executor.fileOperationTracker = {
    getKnowledgeSummary: vi.fn().mockReturnValue(''),
    getCreatedFiles: vi.fn().mockReturnValue([]),
  };
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
  executor.contextManager = {
    compactMessagesWithMeta: vi.fn((messages: any) => ({
      messages,
      meta: {
        availableTokens: 1_000_000,
        originalTokens: 0,
        truncatedToolResults: { didTruncate: false, count: 0, tokensAfter: 0 },
        removedMessages: { didRemove: false, count: 0, tokensAfter: 0, messages: [] },
        kind: 'none',
      },
    })),
    getAvailableTokens: vi.fn().mockReturnValue(1_000_000),
  };
  executor.checkBudgets = vi.fn();
  executor.updateTracking = vi.fn();
  executor.getAvailableTools = vi.fn().mockReturnValue([]);
  executor.handleCanvasPushFallback = vi.fn();
  executor.getToolTimeoutMs = vi.fn().mockReturnValue(1000);
  executor.checkFileOperation = vi.fn().mockReturnValue({ blocked: false });
  executor.recordFileOperation = vi.fn();
  executor.recordCommandExecution = vi.fn();
  executor.fileOperationTracker = {
    getKnowledgeSummary: vi.fn().mockReturnValue(''),
    getCreatedFiles: vi.fn().mockReturnValue([]),
  };
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

  it('marks step failed when only duplicate non-idempotent tool calls are attempted', async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse('run_command', { command: 'echo test' }),
      ],
      {}
    );
    (executor as any).toolCallDeduplicator.checkDuplicate = vi.fn().mockReturnValue({
      isDuplicate: true,
      reason: 'duplicate_call',
      cachedResult: null,
    });

    const step: any = { id: '1b', description: 'Execute command once', status: 'pending' };

    await (executor as any).executeStep(step);

    expect(step.status).toBe('failed');
    expect(step.error).toContain('All required tools are unavailable or failed');
  });

  it('blocks create_document for watch-skip recommendation prompts and continues with a text answer', async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse('create_document', {
          filename: 'Dan_Koe_Video_Review.docx',
          format: 'docx',
          content: [{ type: 'paragraph', text: 'placeholder' }],
        }),
        textResponse('Watch it only if you want to improve your creator-economy positioning; otherwise skip it.'),
      ],
      {}
    );
    (executor as any).task.title = 'Video review';
    (executor as any).task.prompt =
      'Transcribe this YouTube video and create a document so I can review it, then tell me if I should watch it.';

    const step: any = {
      id: 'watch-skip-1',
      description: 'Transcribe and decide watchability',
      status: 'pending',
    };

    await (executor as any).executeStep(step);

    expect(step.status).toBe('completed');
    expect(executor.daemon.logEvent).toHaveBeenCalledWith(
      'task-1',
      'tool_blocked',
      expect.objectContaining({
        tool: 'create_document',
        reason: 'watch_skip_recommendation_task',
      })
    );
    expect(executor.toolRegistry.executeTool).not.toHaveBeenCalled();
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

  it('fails executePlan when a step remains unfinished', async () => {
    executor = createExecutorWithStubs([textResponse('done')], {});
    const step: any = { id: 'plan-1', description: 'Do the work', status: 'pending' };
    (executor as any).plan = { description: 'Plan', steps: [step] };
    (executor as any).executeStep = vi.fn(async () => {
      // Simulate a broken executor path that returns without finalizing the step status.
    });

    await expect((executor as any).executePlan()).rejects.toThrow('Task incomplete');
  });

  it('emits failed-step progress instead of completed-step progress when step execution fails', async () => {
    executor = createExecutorWithStubs([textResponse('done')], {});
    const step: any = { id: 'plan-2', description: 'Fetch transcript', status: 'pending' };
    (executor as any).plan = { description: 'Plan', steps: [step] };
    (executor as any).executeStep = vi.fn(async (target: any) => {
      target.status = 'failed';
      target.error = 'All required tools are unavailable or failed. Unable to complete this step.';
      target.completedAt = Date.now();
    });

    await expect((executor as any).executePlan()).rejects.toThrow('Task failed');

    const progressMessages = (executor as any).daemon.logEvent.mock.calls
      .filter((call: any[]) => call[1] === 'progress_update')
      .map((call: any[]) => String(call[2]?.message || ''));

    expect(progressMessages.some((message: string) => message.includes('Step failed'))).toBe(true);
    expect(progressMessages.some((message: string) => message.includes('Completed step'))).toBe(false);
  });

  it('fails executePlan when a verification-labeled step fails', async () => {
    executor = createExecutorWithStubs([textResponse('done')], {});
    const step: any = { id: 'plan-verify-1', description: 'Verify: Read the created document and present recommendation', status: 'pending' };
    (executor as any).plan = { description: 'Plan', steps: [step] };
    (executor as any).executeStep = vi.fn(async (target: any) => {
      target.status = 'failed';
      target.error = 'Verification failed';
      target.completedAt = Date.now();
    });

    await expect((executor as any).executePlan()).rejects.toThrow('Task failed');
  });

  it('requires a direct answer when prompt asks for a decision and summary is artifact-only', () => {
    executor = createExecutorWithStubs([textResponse('done')], {});
    (executor as any).task.title = 'Review YouTube video';
    (executor as any).task.prompt = 'Transcribe this YouTube video and let me know if I should spend my time watching it or skip it.';
    (executor as any).fileOperationTracker.getCreatedFiles.mockReturnValue(['Dan_Koe_Video_Review.pdf']);
    (executor as any).lastNonVerificationOutput = 'Created: Dan_Koe_Video_Review.pdf';
    (executor as any).lastAssistantOutput = 'Created document successfully.';

    const guardError = (executor as any).getFinalResponseGuardError();
    expect(guardError).toContain('missing direct answer');
  });

  it('allows completion when recommendation is explicitly present for decision prompts', () => {
    executor = createExecutorWithStubs([textResponse('done')], {});
    (executor as any).task.title = 'Review YouTube video';
    (executor as any).task.prompt = 'Transcribe this YouTube video and let me know if I should spend my time watching it or skip it.';
    (executor as any).fileOperationTracker.getCreatedFiles.mockReturnValue(['Dan_Koe_Video_Review.pdf']);
    (executor as any).lastNonVerificationOutput = 'Recommendation: Skip this video unless you are new to creator-economy basics; it is likely not worth your time.';
    (executor as any).plan = { description: 'Plan', steps: [{ id: '1', description: 'Review transcript and recommend', status: 'completed' }] };

    const guardError = (executor as any).getFinalResponseGuardError();
    expect(guardError).toBeNull();
  });

  it('does not require direct answer for artifact-only tasks without question intent', () => {
    executor = createExecutorWithStubs([textResponse('done')], {});
    (executor as any).task.title = 'Generate PDF report';
    (executor as any).task.prompt = 'Create a PDF report from the attached data.';
    (executor as any).fileOperationTracker.getCreatedFiles.mockReturnValue(['report.pdf']);
    (executor as any).lastNonVerificationOutput = 'Created: report.pdf';

    const guardError = (executor as any).getFinalResponseGuardError();
    expect(guardError).toBeNull();
  });

  it('requires direct answer for non-video advisory prompts too', () => {
    executor = createExecutorWithStubs([textResponse('done')], {});
    (executor as any).task.title = 'Stack choice';
    (executor as any).task.prompt = 'Compare option A and option B and tell me which one I should choose.';
    (executor as any).lastNonVerificationOutput = 'Created: comparison.md';

    const guardError = (executor as any).getFinalResponseGuardError();
    expect(guardError).toContain('missing direct answer');
  });

  it('pauses when assistant asks blocking questions', async () => {
    executor = createExecutorWithStubs(
      [
        textResponse('1) Who is the primary user?\n2) What is the core flow?\n3) List 3 must-have features.'),
      ],
      {}
    );
    (executor as any).shouldPauseForQuestions = true;

    const step: any = { id: '3', description: 'Clarify requirements', status: 'pending' };

    await expect((executor as any).executeStep(step)).rejects.toMatchObject({
      name: 'AwaitingUserInputError',
    });
  });

  it('does not pause when user input is disabled for the task', async () => {
    executor = createExecutorWithStubs(
      [
        textResponse('1) Who is the primary user?\n2) What is the core flow?\n3) List 3 must-have features.'),
      ],
      {}
    );
    (executor as any).shouldPauseForQuestions = false;

    const step: any = { id: '3b', description: 'Clarify requirements', status: 'pending' };

    await (executor as any).executeStep(step);

    expect(step.status).toBe('completed');
  });

  it('skips workspace preflight pauses when user input is disabled', () => {
    executor = createExecutorWithStubs([textResponse('done')], {});
    (executor as any).shouldPauseForQuestions = false;
    (executor as any).classifyWorkspaceNeed = vi.fn().mockReturnValue('needs_existing');
    (executor as any).pauseForUserInput = vi.fn();

    const shouldPause = (executor as any).preflightWorkspaceCheck();

    expect(shouldPause).toBe(false);
    expect((executor as any).pauseForUserInput).not.toHaveBeenCalled();
  });

  it('treats provider cancellation messages as abort-like errors', () => {
    executor = createExecutorWithStubs([textResponse('done')], {});

    expect((executor as any).isAbortLikeError(new Error('Request cancelled'))).toBe(true);
    expect((executor as any).isAbortLikeError(new Error('Request canceled'))).toBe(true);
  });

  it('does not infer write_file content from assistant narration fallback', () => {
    executor = createExecutorWithStubs([textResponse('done')], {});
    (executor as any).lastAssistantText = 'Now let me write the full whitepaper:';
    (executor as any).lastNonVerificationOutput = 'Now let me write the full whitepaper:';
    (executor as any).lastAssistantOutput = 'Now let me write the full whitepaper:';

    const inferred = (executor as any).inferMissingParameters('write_file', { path: 'NexusChain-Whitepaper.md' });

    expect(inferred.input.content).toBeUndefined();
  });

  it('does not infer create_document content from assistant narration fallback', () => {
    executor = createExecutorWithStubs([textResponse('done')], {});
    (executor as any).lastAssistantText = 'Now let me write the full whitepaper:';
    (executor as any).lastNonVerificationOutput = 'Now let me write the full whitepaper:';
    (executor as any).lastAssistantOutput = 'Now let me write the full whitepaper:';

    const inferred = (executor as any).inferMissingParameters('create_document', {
      filename: 'spec.docx',
      format: 'docx',
    });

    expect(inferred.input.content).toBeUndefined();
  });

  it('fails write/create deliverable steps when no file mutation evidence exists', async () => {
    executor = createExecutorWithStubs(
      [
        textResponse('I wrote the complete whitepaper and it is ready.'),
      ],
      {}
    );

    const step: any = {
      id: 'artifact-1',
      description: 'Write the complete KARU founding whitepaper document',
      status: 'pending',
    };

    await (executor as any).executeStep(step);

    expect(step.status).toBe('failed');
    expect(step.error).toContain('written artifact');
  });

  it('keeps write/create deliverable steps completed when a file mutation succeeds', async () => {
    executor = createExecutorWithStubs(
      [
        toolUseResponse('write_file', { path: 'KARU_Whitepaper.md', content: '# KARU' }),
        textResponse('Saved the complete whitepaper to KARU_Whitepaper.md'),
      ],
      {
        write_file: { success: true, path: 'KARU_Whitepaper.md' },
      }
    );

    const step: any = {
      id: 'artifact-2',
      description: 'Write the complete KARU founding whitepaper document',
      status: 'pending',
    };

    await (executor as any).executeStep(step);

    expect(step.status).toBe('completed');
  });

  it('fails final verification steps unless the response is exactly OK', async () => {
    executor = createExecutorWithStubs(
      [
        textResponse('The whitepaper is missing required sections.'),
      ],
      {}
    );

    const step: any = {
      id: 'verify-1',
      description: 'Final verification: Review the completed whitepaper for completeness',
      status: 'pending',
    };
    (executor as any).plan = { description: 'Plan', steps: [step] };

    await (executor as any).executeStep(step);

    expect(step.status).toBe('failed');
    expect(step.error).toContain('Verification failed');
  });

  it('rethrows abort-like errors without marking step as failed inside executeStep', async () => {
    executor = createExecutorWithStubs([], {});
    (executor as any).callLLMWithRetry = vi.fn(async () => {
      throw new Error('Request cancelled');
    });

    const step: any = { id: 'abort-1', description: 'Generate a large document', status: 'pending' };

    await expect((executor as any).executeStep(step)).rejects.toThrow('Request cancelled');
    expect(step.status).not.toBe('failed');
    expect(step.error).toBeUndefined();
    expect((executor as any).daemon.logEvent).not.toHaveBeenCalledWith(
      'task-1',
      'step_failed',
      expect.objectContaining({ reason: 'Request cancelled' })
    );
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

  it('fails fast when tool returns unrecoverable failure (use_skill not currently executable)', async () => {
    const executorWithTools = createExecutorWithStubs(
      [
        toolUseResponse('use_skill', {
          skill_id: 'audio-transcribe',
          parameters: { inputPath: '/tmp/audio.mp3' },
        }),
      ],
      {
        use_skill: {
          success: false,
          error: 'Skill \'audio-transcribe\' is not currently executable',
          reason: 'Missing or invalid skill prerequisites.',
          missing_requirements: {
            bins: ['ffmpeg'],
          },
        },
      }
    );
    executorWithTools.getAvailableTools = vi.fn().mockReturnValue([
      { name: 'run_command', description: '', input_schema: { type: 'object', properties: {} } },
      { name: 'glob', description: '', input_schema: { type: 'object', properties: {} } },
      { name: 'use_skill', description: '', input_schema: { type: 'object', properties: {} } },
    ]);

    const step: any = { id: '7', description: 'Create transcript and summary', status: 'pending' };

    await (executorWithTools as any).executeStep(step);

    expect(step.status).toBe('failed');
    expect((executorWithTools as any).callLLMWithRetry).toHaveBeenCalledTimes(1);
    expect(step.error).toMatch(/not currently executable|All required tools are unavailable or failed/);
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

  it('detects recovery intent from user messaging in simple phrases', () => {
    const executor = createExecutorWithStubs([textResponse('done')], {});
    expect((executor as any).isRecoveryIntent('I need you to find another way')).toBe(true);
    expect((executor as any).isRecoveryIntent('Can\'t do this in this environment')).toBe(true);
    expect((executor as any).isRecoveryIntent('Please continue')).toBe(false);
  });

  it('does not treat unrelated phrases as recovery intent', () => {
    const executor = createExecutorWithStubs([textResponse('done')], {});
    expect((executor as any).isRecoveryIntent('Consider an alternative approach for this design, then resume')).toBe(false);
    expect((executor as any).isRecoveryIntent('This is not possible with the current configuration')).toBe(false);
    expect((executor as any).isRecoveryIntent('Another approach may be better later')).toBe(false);
  });

  it('resets attempt-level plan revision state on retry', () => {
    const executor = createExecutorWithStubs([textResponse('done')], {});
    (executor as any).conversationHistory = [];
    const stepOne: any = { id: '1', description: 'Step one', status: 'completed', startedAt: 1, completedAt: 2, error: 'old' };
    const stepTwo: any = { id: '2', description: 'Step two', status: 'failed', startedAt: 1, completedAt: 2, error: 'old' };
    executor.task.currentAttempt = 2;
    executor.plan = { description: 'Plan', steps: [stepOne, stepTwo] };
    executor.lastAssistantOutput = 'summary';
    executor.lastNonVerificationOutput = 'summary';
    executor.planRevisionCount = 3;

    (executor as any).resetForRetry();

    expect(executor.plan!.steps[0].status).toBe('pending');
    expect(executor.plan!.steps[0].startedAt).toBeUndefined();
    expect(executor.plan!.steps[0].error).toBeUndefined();
    expect(executor.plan!.steps[1].status).toBe('pending');
    expect(executor.toolResultMemory).toEqual([]);
    expect(executor.lastAssistantOutput).toBeNull();
    expect(executor.lastNonVerificationOutput).toBeNull();
    expect(executor.planRevisionCount).toBe(0);
    expect((executor as any).conversationHistory.at(-1)?.content).toContain('This is attempt 2');
  });

  it('does not re-run recovery plan insertion for the same failing signature twice', async () => {
    const executor = createExecutorWithStubs(
      [
        toolUseResponse('run_command', { command: 'exit 1' }),
        textResponse('done'),
        toolUseResponse('run_command', { command: 'exit 1' }),
        textResponse('done'),
      ],
      {
        run_command: { success: false, error: 'cannot complete this task without a workaround' },
      }
    );
    const handlePlanRevisionSpy = vi.spyOn(executor as any, 'handlePlanRevision');
    const failedStep: any = { id: '1', description: 'Run baseline task', status: 'pending' };
    const retainedPendingStep: any = { id: '2', description: 'Validate output', status: 'pending' };

    executor.plan = { description: 'Plan', steps: [failedStep, retainedPendingStep] };
    executor.maxPlanRevisions = 5;
    executor.planRevisionCount = 0;
    executor.recoveryRequestActive = true;

    await (executor as any).executeStep(failedStep);
    await (executor as any).executeStep(failedStep);

    expect(handlePlanRevisionSpy).toHaveBeenCalledTimes(1);
    expect(failedStep.status).toBe('failed');
    expect(executor.planRevisionCount).toBe(1);
    const planDescriptions = executor.plan.steps.map((step: any) => step.description);
    expect(planDescriptions.filter((desc: string) => desc.includes('alternative toolchain')).length).toBe(1);
    expect(planDescriptions.length).toBe(4);
  });

  it('adds recovery steps again when failure reason changes after a retry', async () => {
    const executor = createExecutorWithStubs(
      [
        toolUseResponse('run_command', { command: 'exit 1' }),
        textResponse('done'),
        toolUseResponse('run_command', { command: 'exit 1' }),
        textResponse('done'),
      ],
      {}
    );

    let runAttempt = 0;
    (executor as any).toolRegistry.executeTool = vi.fn(async () => {
      runAttempt += 1;
      return {
        success: false,
        exitCode: 1,
        error: runAttempt === 1
          ? 'cannot complete this task because of a temporary blocker'
          : 'cannot complete this task because a different blocker appeared',
      };
    });

    const handlePlanRevisionSpy = vi.spyOn(executor as any, 'handlePlanRevision');
    const failedStep: any = { id: '1', description: 'Run baseline task', status: 'pending' };
    const retainedPendingStep: any = { id: '2', description: 'Validate output', status: 'pending' };
    executor.plan = { description: 'Plan', steps: [failedStep, retainedPendingStep] };
    executor.maxPlanRevisions = 5;
    executor.planRevisionCount = 0;
    executor.recoveryRequestActive = true;

    await (executor as any).executeStep(failedStep);
    await (executor as any).executeStep(failedStep);

    expect(handlePlanRevisionSpy).toHaveBeenCalledTimes(2);
    const planDescriptions = executor.plan.steps.map((step: any) => step.description);
    expect(planDescriptions.filter((desc: string) => desc.includes('alternative toolchain')).length).toBe(2);
    expect(planDescriptions.length).toBe(6);
    expect(executor.planRevisionCount).toBe(2);
  });

  it('adds recovery plan steps without clearing unrelated pending steps', async () => {
    const executor = createExecutorWithStubs(
      [
        toolUseResponse('run_command', { command: 'exit 1' }),
        textResponse('done'),
      ],
      {
        run_command: { success: false, error: 'exit code 1' },
      }
    );

    const failedStep: any = { id: '1', description: 'Run baseline task', status: 'pending' };
    const retainedPendingStep: any = { id: '2', description: 'Validate output', status: 'pending' };
    executor.plan = { description: 'Plan', steps: [failedStep, retainedPendingStep] };
    executor.maxPlanRevisions = 5;
    executor.recoveryRequestActive = true;
    executor.planRevisionCount = 0;

    await (executor as any).executeStep(failedStep);

    expect(failedStep.status).toBe('failed');
    const planDescriptions = executor.plan.steps.map((step: any) => step.description);
    expect(planDescriptions).toContain('Try an alternative toolchain or different input strategy for: Run baseline task');
    expect(planDescriptions).toContain(
      'If normal tools are blocked, implement the smallest safe code/feature change needed to continue and complete the goal.'
    );
    expect(planDescriptions).toContain('Validate output');
    expect(planDescriptions.length).toBe(4);
  });

  it('triggers recovery on blocked-step reasons even without explicit user request', async () => {
    const executor = createExecutorWithStubs(
      [
        toolUseResponse('run_command', { command: 'exit 1' }),
        textResponse('done'),
      ],
      {
        run_command: { success: false, error: 'cannot complete this task without a workaround' },
      }
    );
    executor.recoveryRequestActive = false;
    const failedStep: any = { id: '1', description: 'Run baseline task', status: 'pending' };
    const retainedPendingStep: any = { id: '2', description: 'Validate output', status: 'pending' };
    executor.plan = { description: 'Plan', steps: [failedStep, retainedPendingStep] };
    executor.maxPlanRevisions = 5;
    executor.planRevisionCount = 0;
    (executor as any).isRecoveryIntent = vi.fn((reason: string) => reason.includes('cannot complete this task'));

    await (executor as any).executeStep(failedStep);

    const planDescriptions = executor.plan.steps.map((step: any) => step.description);
    expect(planDescriptions).toContain('Try an alternative toolchain or different input strategy for: Run baseline task');
    expect(failedStep.status).toBe('failed');
    expect(executor.planRevisionCount).toBe(1);
  });
});
