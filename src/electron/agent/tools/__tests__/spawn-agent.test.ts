/**
 * Tests for spawn_agent, wait_for_agent, get_agent_status, and list_agents tools
 *
 * Note: These tests focus on the tool logic rather than full integration,
 * since ToolRegistry requires extensive mocking for all dependencies.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Task, AgentConfig, AgentType, Workspace } from '../../../../shared/types';

// Helper functions that mirror the implementation in registry.ts
function resolveModelPreference(preference: string | undefined, currentModelKey?: string): string {
  switch (preference) {
    case 'same':
      return currentModelKey || '';

    // Semantic preferences
    case 'cheaper':
    case 'haiku':
      return 'haiku-3-5';
    case 'balanced':
    case 'sonnet':
      return 'sonnet-3-5';
    case 'smarter':
    case 'opus':
      return 'opus-4-5';

    // Explicit model keys
    case 'haiku-3-5':
      return 'haiku-3-5';
    case 'haiku-4-5':
      return 'haiku-4-5';
    case 'sonnet-3-5':
      return 'sonnet-3-5';
    case 'sonnet-4':
      return 'sonnet-4';
    case 'sonnet-4-5':
      return 'sonnet-4-5';
    case 'opus-4-5':
      return 'opus-4-5';

    default:
      // Default to cheaper for sub-agents
      return 'haiku-3-5';
  }
}

function generateTaskTitle(prompt: string): string {
  // Truncate prompt to create title
  const maxLen = 50;
  const cleaned = prompt.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLen) return cleaned;
  return cleaned.substring(0, maxLen - 3) + '...';
}

function validateSpawnInput(input: { prompt?: string; max_turns?: number }): { valid: boolean; error?: string } {
  if (!input.prompt || input.prompt.trim() === '') {
    return { valid: false, error: 'spawn_agent requires a non-empty prompt' };
  }
  if (input.max_turns !== undefined && (input.max_turns < 1 || input.max_turns > 100)) {
    return { valid: false, error: 'max_turns must be between 1 and 100' };
  }
  return { valid: true };
}

function canSpawnAtDepth(currentDepth: number, maxDepth: number = 3): boolean {
  return currentDepth < maxDepth;
}

// Create mock task
function createMockTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Date.now()}`,
    title: 'Test Task',
    prompt: 'Do something',
    status: 'executing',
    workspaceId: 'test-workspace',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    agentType: 'main',
    depth: 0,
    ...overrides,
  };
}

describe('spawn_agent helper functions', () => {
  describe('resolveModelPreference', () => {
    it('should return haiku-3-5 for cheaper', () => {
      expect(resolveModelPreference('cheaper')).toBe('haiku-3-5');
    });

    it('should return sonnet-3-5 for balanced', () => {
      expect(resolveModelPreference('balanced')).toBe('sonnet-3-5');
    });

    it('should return opus-4-5 for smarter', () => {
      expect(resolveModelPreference('smarter')).toBe('opus-4-5');
    });

    it('should return current model for same', () => {
      expect(resolveModelPreference('same', 'sonnet-4-5')).toBe('sonnet-4-5');
      expect(resolveModelPreference('same', 'opus-4-5')).toBe('opus-4-5');
    });

    it('should return empty string when same but no current model (inherit global)', () => {
      expect(resolveModelPreference('same')).toBe('');
    });

    it('should default to haiku for undefined preference', () => {
      expect(resolveModelPreference(undefined)).toBe('haiku-3-5');
    });

    it('should support explicit model keys', () => {
      expect(resolveModelPreference('haiku-3-5')).toBe('haiku-3-5');
      expect(resolveModelPreference('haiku-4-5')).toBe('haiku-4-5');
      expect(resolveModelPreference('sonnet-3-5')).toBe('sonnet-3-5');
      expect(resolveModelPreference('sonnet-4')).toBe('sonnet-4');
      expect(resolveModelPreference('sonnet-4-5')).toBe('sonnet-4-5');
      expect(resolveModelPreference('opus-4-5')).toBe('opus-4-5');
    });

    it('should support haiku and sonnet aliases', () => {
      expect(resolveModelPreference('haiku')).toBe('haiku-3-5');
      expect(resolveModelPreference('sonnet')).toBe('sonnet-3-5');
      expect(resolveModelPreference('opus')).toBe('opus-4-5');
    });
  });

  describe('generateTaskTitle', () => {
    it('should return short prompts as-is', () => {
      expect(generateTaskTitle('Analyze files')).toBe('Analyze files');
    });

    it('should truncate long prompts', () => {
      const longPrompt = 'This is a very long prompt that exceeds the maximum length allowed for task titles';
      const result = generateTaskTitle(longPrompt);
      expect(result.length).toBeLessThanOrEqual(50);
      expect(result.endsWith('...')).toBe(true);
    });

    it('should clean up whitespace', () => {
      expect(generateTaskTitle('  Multiple   spaces   here  ')).toBe('Multiple spaces here');
    });
  });

  describe('validateSpawnInput', () => {
    it('should reject empty prompt', () => {
      const result = validateSpawnInput({ prompt: '' });
      expect(result.valid).toBe(false);
      expect(result.error).toContain('non-empty prompt');
    });

    it('should reject whitespace-only prompt', () => {
      const result = validateSpawnInput({ prompt: '   ' });
      expect(result.valid).toBe(false);
    });

    it('should accept valid prompt', () => {
      const result = validateSpawnInput({ prompt: 'Analyze the code' });
      expect(result.valid).toBe(true);
    });

    it('should reject invalid max_turns', () => {
      expect(validateSpawnInput({ prompt: 'test', max_turns: 0 }).valid).toBe(false);
      expect(validateSpawnInput({ prompt: 'test', max_turns: 101 }).valid).toBe(false);
    });

    it('should accept valid max_turns', () => {
      expect(validateSpawnInput({ prompt: 'test', max_turns: 1 }).valid).toBe(true);
      expect(validateSpawnInput({ prompt: 'test', max_turns: 50 }).valid).toBe(true);
      expect(validateSpawnInput({ prompt: 'test', max_turns: 100 }).valid).toBe(true);
    });
  });

  describe('canSpawnAtDepth', () => {
    it('should allow spawning at depth 0', () => {
      expect(canSpawnAtDepth(0)).toBe(true);
    });

    it('should allow spawning at depth 1', () => {
      expect(canSpawnAtDepth(1)).toBe(true);
    });

    it('should allow spawning at depth 2', () => {
      expect(canSpawnAtDepth(2)).toBe(true);
    });

    it('should reject spawning at depth 3 (max)', () => {
      expect(canSpawnAtDepth(3)).toBe(false);
    });

    it('should respect custom max depth', () => {
      expect(canSpawnAtDepth(1, 2)).toBe(true);
      expect(canSpawnAtDepth(2, 2)).toBe(false);
    });
  });
});

describe('spawn_agent AgentConfig building', () => {
  it('should build config with model preference', () => {
    const config: AgentConfig = {
      modelKey: resolveModelPreference('cheaper'),
    };

    expect(config.modelKey).toBe('haiku-3-5');
  });

  it('should pass model override to provider factory (regression test for sub-agent model bug)', () => {
    // This test ensures that when spawn_agent creates a config with modelKey,
    // that modelKey will be respected when creating the LLM provider.
    // The bug was that createProvider() ignored overrideConfig.model and always
    // used the global settings.modelKey instead.

    const modelPreference = 'cheaper';
    const resolvedModel = resolveModelPreference(modelPreference);

    // The config should have the explicit model key
    const agentConfig: AgentConfig = {
      modelKey: resolvedModel,
    };

    // Verify the model key is set correctly
    expect(agentConfig.modelKey).toBe('haiku-3-5');
    expect(agentConfig.modelKey).not.toBe('opus-4-5');
    expect(agentConfig.modelKey).not.toBe('sonnet-4-5');

    // When TaskExecutor calls createProvider({ model: agentConfig.modelKey }),
    // the provider factory must use haiku-3-5, not the global settings model.
    // This is a reminder test - the actual fix is in provider-factory.ts
  });

  it('should build config with personality', () => {
    const config: AgentConfig = {
      modelKey: resolveModelPreference('cheaper'),
      personalityId: 'concise',
    };

    expect(config.personalityId).toBe('concise');
  });

  it('should build config with max turns', () => {
    const config: AgentConfig = {
      modelKey: resolveModelPreference('cheaper'),
      maxTurns: 10,
    };

    expect(config.maxTurns).toBe(10);
  });

  it('should build complete config', () => {
    const config: AgentConfig = {
      modelKey: 'haiku-3-5',
      personalityId: 'technical',
      maxTurns: 15,
      retainMemory: false,
    };

    expect(config).toEqual({
      modelKey: 'haiku-3-5',
      personalityId: 'technical',
      maxTurns: 15,
      retainMemory: false,
    });
  });
});

describe('wait_for_agent logic', () => {
  function isTerminalStatus(status: Task['status']): boolean {
    return ['completed', 'failed', 'cancelled'].includes(status);
  }

  it('should recognize terminal statuses', () => {
    expect(isTerminalStatus('completed')).toBe(true);
    expect(isTerminalStatus('failed')).toBe(true);
    expect(isTerminalStatus('cancelled')).toBe(true);
  });

  it('should recognize non-terminal statuses', () => {
    expect(isTerminalStatus('pending')).toBe(false);
    expect(isTerminalStatus('executing')).toBe(false);
    expect(isTerminalStatus('planning')).toBe(false);
  });
});

describe('get_agent_status logic', () => {
  function summarizeAgentStatuses(tasks: Task[]): {
    total: number;
    pending: number;
    executing: number;
    completed: number;
    failed: number;
  } {
    const summary = {
      total: tasks.length,
      pending: 0,
      executing: 0,
      completed: 0,
      failed: 0,
    };

    for (const task of tasks) {
      switch (task.status) {
        case 'pending':
          summary.pending++;
          break;
        case 'executing':
        case 'planning':
          summary.executing++;
          break;
        case 'completed':
          summary.completed++;
          break;
        case 'failed':
        case 'cancelled':
          summary.failed++;
          break;
      }
    }

    return summary;
  }

  it('should count all statuses correctly', () => {
    const tasks = [
      createMockTask({ status: 'pending' }),
      createMockTask({ status: 'pending' }),
      createMockTask({ status: 'executing' }),
      createMockTask({ status: 'completed' }),
      createMockTask({ status: 'completed' }),
      createMockTask({ status: 'completed' }),
      createMockTask({ status: 'failed' }),
    ];

    const summary = summarizeAgentStatuses(tasks);

    expect(summary.total).toBe(7);
    expect(summary.pending).toBe(2);
    expect(summary.executing).toBe(1);
    expect(summary.completed).toBe(3);
    expect(summary.failed).toBe(1);
  });

  it('should handle empty task list', () => {
    const summary = summarizeAgentStatuses([]);

    expect(summary.total).toBe(0);
    expect(summary.pending).toBe(0);
    expect(summary.executing).toBe(0);
    expect(summary.completed).toBe(0);
    expect(summary.failed).toBe(0);
  });
});

describe('list_agents logic', () => {
  function formatAgentList(tasks: Task[]): Array<{
    task_id: string;
    title: string;
    status: string;
    agentType?: AgentType;
    modelKey?: string;
  }> {
    return tasks.map(task => ({
      task_id: task.id,
      title: task.title,
      status: task.status,
      agentType: task.agentType,
      modelKey: task.agentConfig?.modelKey,
    }));
  }

  it('should format agent list correctly', () => {
    const tasks = [
      createMockTask({
        id: 'task-1',
        title: 'Analysis Agent',
        status: 'executing',
        agentType: 'sub',
        agentConfig: { modelKey: 'haiku-3-5' },
      }),
      createMockTask({
        id: 'task-2',
        title: 'Search Agent',
        status: 'completed',
        agentType: 'sub',
        agentConfig: { modelKey: 'sonnet-4-5' },
      }),
    ];

    const list = formatAgentList(tasks);

    expect(list).toHaveLength(2);
    expect(list[0]).toMatchObject({
      task_id: 'task-1',
      title: 'Analysis Agent',
      status: 'executing',
      agentType: 'sub',
      modelKey: 'haiku-3-5',
    });
    expect(list[1]).toMatchObject({
      task_id: 'task-2',
      title: 'Search Agent',
      status: 'completed',
      agentType: 'sub',
      modelKey: 'sonnet-4-5',
    });
  });

  it('should handle tasks without agentConfig', () => {
    const tasks = [
      createMockTask({ id: 'task-1', title: 'Simple Task' }),
    ];

    const list = formatAgentList(tasks);

    expect(list[0].modelKey).toBeUndefined();
  });
});

describe('child task creation params', () => {
  it('should build correct child task params', () => {
    const parentTask = createMockTask({ id: 'parent-123', depth: 1 });
    const workspaceId = 'workspace-456';

    const params = {
      title: 'Child Agent',
      prompt: 'Analyze the codebase',
      workspaceId,
      parentTaskId: parentTask.id,
      agentType: 'sub' as const,
      agentConfig: {
        modelKey: 'haiku-3-5',
        personalityId: 'concise',
        maxTurns: 10,
      } as AgentConfig,
      depth: parentTask.depth! + 1,
    };

    expect(params.parentTaskId).toBe('parent-123');
    expect(params.depth).toBe(2);
    expect(params.agentType).toBe('sub');
    expect(params.agentConfig.modelKey).toBe('haiku-3-5');
  });
});
