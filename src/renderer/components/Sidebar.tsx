import { useState, useRef, useEffect, useMemo } from 'react';
import { Task, Workspace } from '../../shared/types';

interface SidebarProps {
  workspace: Workspace | null;
  tasks: Task[];
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
  onOpenSettings: () => void;
  onTasksChanged: () => void;
}

// Tree node structure for hierarchical display
interface TaskTreeNode {
  task: Task;
  children: TaskTreeNode[];
}

export function Sidebar({
  workspace: _workspace,
  tasks,
  selectedTaskId,
  onSelectTask,
  onOpenSettings,
  onTasksChanged,
}: SidebarProps) {
  const [menuOpenTaskId, setMenuOpenTaskId] = useState<string | null>(null);
  const [renameTaskId, setRenameTaskId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [collapsedTasks, setCollapsedTasks] = useState<Set<string>>(new Set());
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

  // Build task tree from flat list
  const taskTree = useMemo(() => {
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
    const buildNode = (task: Task): TaskTreeNode => {
      const children = childrenMap.get(task.id) || [];
      // Sort children by creation time
      children.sort((a, b) => a.createdAt - b.createdAt);
      return {
        task,
        children: children.map(buildNode),
      };
    };

    // Get root tasks (no parent) and sort by creation time (newest first)
    const rootTasks = tasks
      .filter(t => !t.parentTaskId)
      .sort((a, b) => b.createdAt - a.createdAt);

    return rootTasks.map(buildNode);
  }, [tasks]);

  // Close menu when clicking outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpenTaskId(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  // Focus rename input when entering rename mode
  useEffect(() => {
    if (renameTaskId && renameInputRef.current) {
      renameInputRef.current.focus();
      renameInputRef.current.select();
    }
  }, [renameTaskId]);

  const handleMenuToggle = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation();
    setMenuOpenTaskId(menuOpenTaskId === taskId ? null : taskId);
  };

  const handleRenameClick = (e: React.MouseEvent, task: Task) => {
    e.stopPropagation();
    setMenuOpenTaskId(null);
    setRenameTaskId(task.id);
    setRenameValue(task.title);
  };

  const handleRenameSubmit = async (taskId: string) => {
    if (renameValue.trim()) {
      await window.electronAPI.renameTask(taskId, renameValue.trim());
      onTasksChanged();
    }
    setRenameTaskId(null);
    setRenameValue('');
  };

  const handleRenameKeyDown = (e: React.KeyboardEvent, taskId: string) => {
    if (e.key === 'Enter') {
      handleRenameSubmit(taskId);
    } else if (e.key === 'Escape') {
      setRenameTaskId(null);
      setRenameValue('');
    }
  };

  const handleArchiveClick = async (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation();
    setMenuOpenTaskId(null);
    await window.electronAPI.deleteTask(taskId);
    if (selectedTaskId === taskId) {
      onSelectTask(null);
    }
    onTasksChanged();
  };

  const toggleCollapse = (e: React.MouseEvent, taskId: string) => {
    e.stopPropagation();
    setCollapsedTasks(prev => {
      const next = new Set(prev);
      if (next.has(taskId)) {
        next.delete(taskId);
      } else {
        next.add(taskId);
      }
      return next;
    });
  };

  const getStatusIndicator = (status: Task['status']) => {
    switch (status) {
      case 'completed':
        return '[✓]';
      case 'failed':
      case 'cancelled':
        return '[✗]';
      case 'executing':
      case 'planning':
        return '[~]';
      default:
        return '[ ]';
    }
  };

  const getStatusClass = (status: Task['status']) => {
    switch (status) {
      case 'completed':
        return 'completed';
      case 'failed':
      case 'cancelled':
        return 'failed';
      case 'executing':
      case 'planning':
        return 'active';
      default:
        return '';
    }
  };

  const getAgentTypeIndicator = (task: Task) => {
    if (task.agentType === 'sub') {
      return <span className="cli-agent-type sub" title="Sub-agent">SUB</span>;
    }
    if (task.agentType === 'parallel') {
      return <span className="cli-agent-type parallel" title="Parallel agent">PAR</span>;
    }
    return null;
  };

  const handleNewTask = () => {
    // Deselect current task to show the welcome/new task screen
    onSelectTask(null);
  };

  // Render a task node and its children recursively
  const renderTaskNode = (
    node: TaskTreeNode,
    index: number,
    depth: number = 0,
    isLast: boolean = true
  ): React.ReactNode => {
    const { task, children } = node;
    const hasChildren = children.length > 0;
    const isCollapsed = collapsedTasks.has(task.id);
    const isSubAgent = !!task.parentTaskId;

    // Tree connector prefix based on depth
    const treePrefix = depth > 0 ? (isLast ? '└─' : '├─') : '';

    return (
      <div key={task.id} className="task-tree-node">
        <div
          className={`task-item cli-task-item ${selectedTaskId === task.id ? 'task-item-selected' : ''} ${isSubAgent ? 'task-item-subagent' : ''}`}
          onClick={() => renameTaskId !== task.id && onSelectTask(task.id)}
          style={{ paddingLeft: depth > 0 ? `${8 + depth * 16}px` : undefined }}
        >
          {/* Tree connector for sub-agents */}
          {depth > 0 && (
            <span className="cli-tree-prefix">{treePrefix}</span>
          )}

          {/* Collapse toggle for tasks with children */}
          {hasChildren ? (
            <button
              className="cli-collapse-btn"
              onClick={(e) => toggleCollapse(e, task.id)}
              title={isCollapsed ? 'Expand' : 'Collapse'}
            >
              {isCollapsed ? '▸' : '▾'}
            </button>
          ) : (
            <span className="cli-task-num">{depth === 0 ? String(index + 1).padStart(2, '0') : '··'}</span>
          )}

          <span className={`cli-task-status ${getStatusClass(task.status)}`}>
            {getStatusIndicator(task.status)}
          </span>

          {/* Agent type badge for sub-agents */}
          {getAgentTypeIndicator(task)}

          <div className="task-item-content cli-task-content">
            {renameTaskId === task.id ? (
              <input
                ref={renameInputRef}
                type="text"
                className="task-item-rename-input cli-rename-input"
                value={renameValue}
                onChange={(e) => setRenameValue(e.target.value)}
                onKeyDown={(e) => handleRenameKeyDown(e, task.id)}
                onBlur={() => handleRenameSubmit(task.id)}
                onClick={(e) => e.stopPropagation()}
              />
            ) : (
              <span className="cli-task-title" title={task.title}>
                {task.title.length > (depth > 0 ? 15 : 20)
                  ? task.title.slice(0, depth > 0 ? 15 : 20) + '...'
                  : task.title}
              </span>
            )}
          </div>

          <div className="task-item-actions cli-task-actions" ref={menuOpenTaskId === task.id ? menuRef : null}>
            <button
              className="task-item-more cli-more-btn"
              onClick={(e) => handleMenuToggle(e, task.id)}
            >
              ···
            </button>
            {menuOpenTaskId === task.id && (
              <div className="task-item-menu cli-task-menu">
                <button
                  className="task-item-menu-option cli-menu-option"
                  onClick={(e) => handleRenameClick(e, task)}
                >
                  <span className="cli-menu-prefix">&gt;</span>
                  rename
                </button>
                <button
                  className="task-item-menu-option task-item-menu-option-danger cli-menu-option cli-menu-danger"
                  onClick={(e) => handleArchiveClick(e, task.id)}
                >
                  <span className="cli-menu-prefix">&gt;</span>
                  archive
                </button>
              </div>
            )}
          </div>
        </div>

        {/* Render children if not collapsed */}
        {hasChildren && !isCollapsed && (
          <div className="task-tree-children">
            {children.map((child, childIndex) =>
              renderTaskNode(child, childIndex, depth + 1, childIndex === children.length - 1)
            )}
          </div>
        )}
      </div>
    );
  };

  return (
    <div className="sidebar cli-sidebar">
      {/* New Task Button */}
      <div className="sidebar-header">
        <button className="new-task-btn cli-new-task-btn" onClick={handleNewTask}>
          <span className="cli-btn-bracket">[</span>
          <span className="cli-btn-plus">+</span>
          <span className="cli-btn-bracket">]</span>
          <span className="cli-btn-text">new_task</span>
        </button>
      </div>

      {/* Task List */}
      <div className="task-list cli-task-list">
        <div className="task-list-header cli-list-header">
          <span className="cli-section-prompt">&gt;</span>
          <span>RECENTS</span>
        </div>
        {taskTree.length === 0 ? (
          <div className="sidebar-empty cli-empty">
            <pre className="cli-tree">{`├── (no tasks)
└── ...`}</pre>
            <p className="cli-hint"># run new_task to begin</p>
          </div>
        ) : (
          taskTree.map((node, index) =>
            renderTaskNode(node, index, 0, index === taskTree.length - 1)
          )
        )}
      </div>

      {/* Footer */}
      <div className="sidebar-footer cli-sidebar-footer">
        <div className="cli-footer-info">
          <span className="cli-footer-label">SYS:</span>
          <span className="cli-footer-value">CoWork-OSS</span>
        </div>
        <button className="settings-btn cli-settings-btn" onClick={onOpenSettings} title="Settings">
          [cfg]
        </button>
      </div>
    </div>
  );
}
