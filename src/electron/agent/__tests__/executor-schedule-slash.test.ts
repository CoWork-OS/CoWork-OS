import { describe, it, expect, vi } from 'vitest';
import { TaskExecutor } from '../executor';

describe('TaskExecutor /schedule slash command handling', () => {
  function createExecutor(prompt: string, toolImpl: (input: any) => any) {
    const executor = Object.create(TaskExecutor.prototype) as any;

    executor.task = {
      id: 'task-1',
      title: 'Test Task',
      prompt,
      createdAt: Date.now() - 1000,
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
      completeTask: vi.fn(),
    };

    executor.toolRegistry = {
      executeTool: vi.fn(async (name: string, input: any) => {
        expect(name).toBe('schedule_task');
        return toolImpl(input);
      }),
    };

    // Avoid pulling in the full snapshot dependencies.
    executor.saveConversationSnapshot = vi.fn();

    executor.conversationHistory = [];
    executor.lastAssistantOutput = null;
    executor.lastNonVerificationOutput = null;
    executor.taskCompleted = false;

    return executor as TaskExecutor & {
      daemon: {
        logEvent: ReturnType<typeof vi.fn>;
        updateTaskStatus: ReturnType<typeof vi.fn>;
        completeTask: ReturnType<typeof vi.fn>;
      };
      toolRegistry: { executeTool: ReturnType<typeof vi.fn> };
      saveConversationSnapshot: ReturnType<typeof vi.fn>;
    };
  }

  it('creates a scheduled task for `/schedule every <interval> <prompt>`', async () => {
    const calls: any[] = [];
    const executor = createExecutor('/schedule every 6h Check price.', (input) => {
      calls.push(input);
      if (input.action === 'list') return [];
      if (input.action === 'create') {
        return {
          success: true,
          job: {
            id: 'job-1',
            name: input.name,
            enabled: true,
            schedule: { kind: 'every', everyMs: 6 * 60 * 60 * 1000 },
            state: { nextRunAtMs: Date.now() + 123_000 },
          },
        };
      }
      throw new Error(`Unexpected action: ${input.action}`);
    });

    const handled = await (TaskExecutor as any).prototype.maybeHandleScheduleSlashCommand.call(executor);
    expect(handled).toBe(true);
    expect(executor.taskCompleted).toBe(true);

    // Upsert logic: list then create
    expect(calls[0]).toEqual({ action: 'list', includeDisabled: true });
    expect(calls[1]).toMatchObject({
      action: 'create',
      name: 'Check price.',
      prompt: 'Check price.',
      schedule: { type: 'interval', every: '6h' },
      enabled: true,
    });

    expect(executor.daemon.completeTask).toHaveBeenCalledTimes(1);
    const summary = executor.daemon.completeTask.mock.calls[0][1];
    expect(String(summary)).toContain('Scheduled "Check price."');
  });

  it('lists scheduled tasks for `/schedule list`', async () => {
    const executor = createExecutor('/schedule list', (input) => {
      if (input.action === 'list') {
        return [
          {
            id: 'job-1',
            name: 'Job A',
            enabled: true,
            updatedAtMs: 2,
            schedule: { kind: 'cron', expr: '0 9 * * *' },
            state: { nextRunAtMs: Date.now() + 1000 },
          },
        ];
      }
      throw new Error(`Unexpected action: ${input.action}`);
    });

    const handled = await (TaskExecutor as any).prototype.maybeHandleScheduleSlashCommand.call(executor);
    expect(handled).toBe(true);
    expect(executor.daemon.completeTask).toHaveBeenCalledWith('task-1', 'Listed 1 scheduled task(s).');
  });

  it('rejects too-small intervals for `/schedule every`', async () => {
    const executor = createExecutor('/schedule every 10s Too fast', (input) => {
      if (input.action === 'list') return [];
      return { success: true };
    });

    await expect((TaskExecutor as any).prototype.maybeHandleScheduleSlashCommand.call(executor)).rejects.toThrow(
      /Invalid interval/i
    );
  });
});

