import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TaskExecutor } from '../executor';

type HarnessOptions = {
  prompt: string;
  title?: string;
  lastOutput: string;
  createdFiles?: string[];
  planStepDescription?: string;
};

function createExecuteHarness(options: HarnessOptions) {
  const executor = Object.create(TaskExecutor.prototype) as any;
  const stepDescription = options.planStepDescription || 'Do the task';

  executor.task = {
    id: 'task-1',
    title: options.title || 'Test task',
    prompt: options.prompt,
    createdAt: Date.now() - 1000,
    currentAttempt: 0,
    maxAttempts: 1,
  };
  executor.workspace = {
    id: 'workspace-1',
    path: '/tmp',
    isTemp: false,
    permissions: { read: true, write: true, delete: true, network: true, shell: true },
  };
  executor.daemon = {
    logEvent: vi.fn(),
    updateTaskStatus: vi.fn(),
    updateTask: vi.fn(),
    completeTask: vi.fn(),
    handleTransientTaskFailure: vi.fn().mockReturnValue(false),
    dispatchMentionedAgents: vi.fn(),
    getAgentRoleById: vi.fn().mockReturnValue(null),
  };
  executor.toolRegistry = {
    cleanup: vi.fn(async () => undefined),
  };
  executor.fileOperationTracker = {
    getCreatedFiles: vi.fn().mockReturnValue(options.createdFiles || []),
    getKnowledgeSummary: vi.fn().mockReturnValue(''),
  };
  executor.contextManager = {
    getAvailableTokens: vi.fn().mockReturnValue(1000000),
    compactMessagesWithMeta: vi.fn((messages: any) => ({ messages, meta: { kind: 'none' } })),
  };
  executor.provider = { createMessage: vi.fn() };
  executor.abortController = new AbortController();
  executor.cancelled = false;
  executor.waitingForUserInput = false;
  executor.requiresTestRun = false;
  executor.testRunObserved = false;
  executor.taskCompleted = false;
  executor.lastAssistantOutput = options.lastOutput;
  executor.lastNonVerificationOutput = options.lastOutput;
  executor.lastAssistantText = options.lastOutput;
  executor.saveConversationSnapshot = vi.fn();
  executor.maybeHandleScheduleSlashCommand = vi.fn(async () => false);
  executor.isCompanionPrompt = vi.fn().mockReturnValue(false);
  executor.analyzeTask = vi.fn(async () => ({}));
  executor.dispatchMentionedAgentsAfterPlanning = vi.fn(async () => undefined);
  executor.verifySuccessCriteria = vi.fn(async () => ({ success: true, message: 'ok' }));
  executor.isTransientProviderError = vi.fn().mockReturnValue(false);
  executor.executePlan = vi.fn(async function executePlanStub(this: any) {
    const current = this.plan?.steps?.[0];
    if (current) {
      current.status = 'completed';
      current.completedAt = Date.now();
    }
  });
  executor.createPlan = vi.fn(async function createPlanStub(this: any) {
    this.plan = {
      description: 'Plan',
      steps: [
        {
          id: '1',
          description: stepDescription,
          status: 'pending',
        },
      ],
    };
  });

  return executor as TaskExecutor & {
    daemon: {
      logEvent: ReturnType<typeof vi.fn>;
      updateTaskStatus: ReturnType<typeof vi.fn>;
      updateTask: ReturnType<typeof vi.fn>;
      completeTask: ReturnType<typeof vi.fn>;
    };
  };
}

describe('TaskExecutor completion contract integration', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('does not complete the task when a direct answer is required but missing', async () => {
    const executor = createExecuteHarness({
      title: 'Video decision',
      prompt: 'Transcribe this video and let me know if I should spend my time watching it or skip it.',
      lastOutput: 'Created: Dan_Koe_Video_Review.pdf',
      createdFiles: ['Dan_Koe_Video_Review.pdf'],
      planStepDescription: 'Transcribe the video',
    });

    await (executor as any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('missing direct answer'),
      })
    );
  });

  it('does not complete the task when artifact evidence is required but missing', async () => {
    const executor = createExecuteHarness({
      title: 'Generate report',
      prompt: 'Create a PDF report from the attached data.',
      lastOutput: 'Created: report.pdf',
      createdFiles: [],
      planStepDescription: 'Generate the report',
    });

    await (executor as any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('missing artifact evidence'),
      })
    );
  });

  it('does not complete the task when verification evidence is required but missing', async () => {
    const executor = createExecuteHarness({
      title: 'Video decision',
      prompt: 'Transcribe this video and then let me know if I should spend my time watching it or skip it.',
      lastOutput: 'You should skip it because it repeats beginner concepts.',
      planStepDescription: 'Transcribe the video',
    });

    await (executor as any).execute();

    expect(executor.daemon.completeTask).not.toHaveBeenCalled();
    expect(executor.daemon.updateTask).toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('missing verification evidence'),
      })
    );
  });

  it('accepts reasoned recommendations when evidence tools were used', async () => {
    const executor = createExecuteHarness({
      title: 'Video decision',
      prompt: 'Transcribe this video and then let me know if I should spend my time watching it or skip it.',
      lastOutput: 'You should skip it because it repeats beginner concepts.',
      planStepDescription: 'Transcribe the video',
    });
    (executor as any).toolResultMemory = [
      { tool: 'web_fetch', summary: 'https://example.com/transcript', timestamp: Date.now() },
    ];

    await (executor as any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({
        status: 'failed',
        error: expect.stringContaining('missing verification evidence'),
      })
    );
  });

  it('completes only when the completion contract requirements are satisfied', async () => {
    const executor = createExecuteHarness({
      title: 'Video review',
      prompt:
        'Create a PDF review document for this video and let me know whether I should watch it.',
      lastOutput:
        'Based on my review, recommendation: You should skip this unless you need beginner-level context.',
      createdFiles: ['video_review.pdf'],
      planStepDescription: 'Verify: review transcript and provide recommendation',
    });

    await (executor as any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'failed' })
    );
  });

  it('allows watch/skip recommendation tasks without creating an artifact when no file is generated', async () => {
    const executor = createExecuteHarness({
      title: 'Video review',
      prompt: 'Transcribe this YouTube video and create a document for me to review, then tell me if I should watch it.',
      lastOutput: 'You should watch this only if you specifically need practical examples of creator-income positioning.',
      createdFiles: [],
      planStepDescription: 'Review transcript and recommend',
    });

    await (executor as any).execute();

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'failed' })
    );
  });

  it('routes provider request-cancelled errors through timeout recovery instead of failing', async () => {
    const executor = createExecuteHarness({
      title: 'Draft whitepaper',
      prompt: 'Create a detailed whitepaper draft.',
      lastOutput: 'Initial summary',
      planStepDescription: 'Write the draft',
    });
    const recoverySpy = vi.fn(async () => true);

    (executor as any).executePlan = vi.fn(async () => {
      throw new Error('Request cancelled');
    });
    (executor as any).finalizeWithTimeoutRecovery = recoverySpy;

    await (executor as any).execute();

    expect(recoverySpy).toHaveBeenCalledTimes(1);
    expect(executor.daemon.updateTask).not.toHaveBeenCalledWith(
      'task-1',
      expect.objectContaining({ status: 'failed' })
    );
  });
});
