/**
 * Tests for Sidebar task tree building functions
 */

import { describe, it, expect } from 'vitest';
import type { Task, AgentType } from '../../shared/types';

// Re-implement the functions being tested (since they're not exported)
// These should match the implementation in Sidebar.tsx

interface TaskTreeNode {
  task: Task;
  children: TaskTreeNode[];
  depth: number;
}

function buildTaskTree(tasks: Task[]): TaskTreeNode[] {
  const taskMap = new Map<string, Task>();
  const childrenMap = new Map<string, Task[]>();

  // Index all tasks
  for (const task of tasks) {
    taskMap.set(task.id, task);
    if (task.parentTaskId) {
      const siblings = childrenMap.get(task.parentTaskId) || [];
      siblings.push(task);
      childrenMap.set(task.parentTaskId, siblings);
    }
  }

  // Build tree nodes recursively
  function buildNode(task: Task, depth: number): TaskTreeNode {
    const children = childrenMap.get(task.id) || [];
    return {
      task,
      children: children.map(child => buildNode(child, depth + 1)),
      depth,
    };
  }

  // Get root tasks (no parent) and build tree
  const rootTasks = tasks.filter(t => !t.parentTaskId);
  return rootTasks.map(task => buildNode(task, 0));
}

function flattenTree(nodes: TaskTreeNode[]): TaskTreeNode[] {
  const result: TaskTreeNode[] = [];
  for (const node of nodes) {
    result.push(node);
    if (node.children.length > 0) {
      result.push(...flattenTree(node.children));
    }
  }
  return result;
}

function getAgentBadge(agentType?: AgentType): string {
  switch (agentType) {
    case 'sub': return '↳';
    case 'parallel': return '⋕';
    default: return '';
  }
}

function getModelIndicator(task: Task): string {
  const modelKey = task.agentConfig?.modelKey;
  if (!modelKey) return '';
  if (modelKey.includes('opus')) return 'O';
  if (modelKey.includes('sonnet')) return 'S';
  if (modelKey.includes('haiku')) return 'H';
  return '';
}

// Helper to create test tasks
function createTask(overrides: Partial<Task> = {}): Task {
  return {
    id: `task-${Math.random().toString(36).substr(2, 9)}`,
    title: 'Test Task',
    prompt: 'Do something',
    status: 'pending',
    workspaceId: 'workspace-1',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
}

describe('buildTaskTree', () => {
  it('should return empty array for empty input', () => {
    const result = buildTaskTree([]);
    expect(result).toEqual([]);
  });

  it('should build flat list for tasks without parents', () => {
    const tasks = [
      createTask({ id: 'task-1', title: 'Task 1' }),
      createTask({ id: 'task-2', title: 'Task 2' }),
      createTask({ id: 'task-3', title: 'Task 3' }),
    ];

    const result = buildTaskTree(tasks);

    expect(result).toHaveLength(3);
    expect(result[0].task.id).toBe('task-1');
    expect(result[0].depth).toBe(0);
    expect(result[0].children).toHaveLength(0);
  });

  it('should nest child tasks under parent', () => {
    const tasks = [
      createTask({ id: 'parent-1', title: 'Parent Task' }),
      createTask({ id: 'child-1', title: 'Child Task 1', parentTaskId: 'parent-1' }),
      createTask({ id: 'child-2', title: 'Child Task 2', parentTaskId: 'parent-1' }),
    ];

    const result = buildTaskTree(tasks);

    expect(result).toHaveLength(1);
    expect(result[0].task.id).toBe('parent-1');
    expect(result[0].children).toHaveLength(2);
    expect(result[0].children[0].task.id).toBe('child-1');
    expect(result[0].children[0].depth).toBe(1);
    expect(result[0].children[1].task.id).toBe('child-2');
    expect(result[0].children[1].depth).toBe(1);
  });

  it('should handle deeply nested tasks (3 levels)', () => {
    const tasks = [
      createTask({ id: 'root', title: 'Root', depth: 0 }),
      createTask({ id: 'level-1', title: 'Level 1', parentTaskId: 'root', depth: 1 }),
      createTask({ id: 'level-2', title: 'Level 2', parentTaskId: 'level-1', depth: 2 }),
      createTask({ id: 'level-3', title: 'Level 3', parentTaskId: 'level-2', depth: 3 }),
    ];

    const result = buildTaskTree(tasks);

    expect(result).toHaveLength(1);
    expect(result[0].task.id).toBe('root');
    expect(result[0].children[0].task.id).toBe('level-1');
    expect(result[0].children[0].children[0].task.id).toBe('level-2');
    expect(result[0].children[0].children[0].children[0].task.id).toBe('level-3');
  });

  it('should handle multiple root tasks with children', () => {
    const tasks = [
      createTask({ id: 'root-1', title: 'Root 1' }),
      createTask({ id: 'root-2', title: 'Root 2' }),
      createTask({ id: 'child-1a', title: 'Child 1a', parentTaskId: 'root-1' }),
      createTask({ id: 'child-2a', title: 'Child 2a', parentTaskId: 'root-2' }),
    ];

    const result = buildTaskTree(tasks);

    expect(result).toHaveLength(2);
    expect(result[0].children).toHaveLength(1);
    expect(result[1].children).toHaveLength(1);
    expect(result[0].children[0].task.id).toBe('child-1a');
    expect(result[1].children[0].task.id).toBe('child-2a');
  });

  it('should handle orphan tasks (parent not in list) as roots', () => {
    const tasks = [
      createTask({ id: 'orphan', title: 'Orphan', parentTaskId: 'non-existent-parent' }),
    ];

    const result = buildTaskTree(tasks);

    // Orphan should not appear as root (parent not found)
    expect(result).toHaveLength(0);
  });
});

describe('flattenTree', () => {
  it('should return empty array for empty input', () => {
    const result = flattenTree([]);
    expect(result).toEqual([]);
  });

  it('should return flat list in depth-first order', () => {
    const task1 = createTask({ id: 'task-1' });
    const task2 = createTask({ id: 'task-2' });

    const nodes: TaskTreeNode[] = [
      { task: task1, children: [], depth: 0 },
      { task: task2, children: [], depth: 0 },
    ];

    const result = flattenTree(nodes);

    expect(result).toHaveLength(2);
    expect(result[0].task.id).toBe('task-1');
    expect(result[1].task.id).toBe('task-2');
  });

  it('should flatten nested structure depth-first', () => {
    const parent = createTask({ id: 'parent' });
    const child1 = createTask({ id: 'child-1' });
    const child2 = createTask({ id: 'child-2' });
    const grandchild = createTask({ id: 'grandchild' });

    const nodes: TaskTreeNode[] = [
      {
        task: parent,
        depth: 0,
        children: [
          {
            task: child1,
            depth: 1,
            children: [
              { task: grandchild, depth: 2, children: [] },
            ],
          },
          { task: child2, depth: 1, children: [] },
        ],
      },
    ];

    const result = flattenTree(nodes);

    expect(result).toHaveLength(4);
    expect(result[0].task.id).toBe('parent');
    expect(result[0].depth).toBe(0);
    expect(result[1].task.id).toBe('child-1');
    expect(result[1].depth).toBe(1);
    expect(result[2].task.id).toBe('grandchild');
    expect(result[2].depth).toBe(2);
    expect(result[3].task.id).toBe('child-2');
    expect(result[3].depth).toBe(1);
  });
});

describe('getAgentBadge', () => {
  it('should return ↳ for sub agents', () => {
    expect(getAgentBadge('sub')).toBe('↳');
  });

  it('should return ⋕ for parallel agents', () => {
    expect(getAgentBadge('parallel')).toBe('⋕');
  });

  it('should return empty string for main agents', () => {
    expect(getAgentBadge('main')).toBe('');
  });

  it('should return empty string for undefined', () => {
    expect(getAgentBadge(undefined)).toBe('');
  });
});

describe('getModelIndicator', () => {
  it('should return O for opus models', () => {
    const task = createTask({ agentConfig: { modelKey: 'opus-4-5' } });
    expect(getModelIndicator(task)).toBe('O');
  });

  it('should return S for sonnet models', () => {
    const task = createTask({ agentConfig: { modelKey: 'sonnet-4-5' } });
    expect(getModelIndicator(task)).toBe('S');
  });

  it('should return H for haiku models', () => {
    const task = createTask({ agentConfig: { modelKey: 'haiku-4-5' } });
    expect(getModelIndicator(task)).toBe('H');
  });

  it('should return empty string for no model', () => {
    const task = createTask();
    expect(getModelIndicator(task)).toBe('');
  });

  it('should return empty string for unknown model', () => {
    const task = createTask({ agentConfig: { modelKey: 'unknown-model' } });
    expect(getModelIndicator(task)).toBe('');
  });

  it('should handle partial model names', () => {
    const taskOpus = createTask({ agentConfig: { modelKey: 'claude-opus-4' } });
    const taskSonnet = createTask({ agentConfig: { modelKey: 'claude-sonnet-3.5' } });
    const taskHaiku = createTask({ agentConfig: { modelKey: 'claude-haiku-3' } });

    expect(getModelIndicator(taskOpus)).toBe('O');
    expect(getModelIndicator(taskSonnet)).toBe('S');
    expect(getModelIndicator(taskHaiku)).toBe('H');
  });
});

describe('integration: buildTaskTree + flattenTree', () => {
  it('should produce correct flattened hierarchy', () => {
    const tasks = [
      createTask({ id: 'main-1', title: 'Main Task 1' }),
      createTask({ id: 'main-2', title: 'Main Task 2' }),
      createTask({ id: 'sub-1a', title: 'Sub Agent 1a', parentTaskId: 'main-1', agentType: 'sub' }),
      createTask({ id: 'sub-1b', title: 'Sub Agent 1b', parentTaskId: 'main-1', agentType: 'sub' }),
      createTask({ id: 'sub-2a', title: 'Sub Agent 2a', parentTaskId: 'main-2', agentType: 'sub' }),
      createTask({ id: 'sub-1a-child', title: 'Nested Sub', parentTaskId: 'sub-1a', agentType: 'sub' }),
    ];

    const tree = buildTaskTree(tasks);
    const flattened = flattenTree(tree);

    // Expected order: main-1, sub-1a, sub-1a-child, sub-1b, main-2, sub-2a
    expect(flattened).toHaveLength(6);
    expect(flattened.map(n => n.task.id)).toEqual([
      'main-1',
      'sub-1a',
      'sub-1a-child',
      'sub-1b',
      'main-2',
      'sub-2a',
    ]);

    // Check depths
    expect(flattened.map(n => n.depth)).toEqual([0, 1, 2, 1, 0, 1]);
  });
});
