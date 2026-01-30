import { useState, useRef, useEffect } from 'react';
import { Task, Workspace } from '../../shared/types';

interface SidebarProps {
  workspace: Workspace | null;
  tasks: Task[];
  selectedTaskId: string | null;
  onSelectTask: (id: string | null) => void;
  onOpenSettings: () => void;
  onTasksChanged: () => void;
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
  const menuRef = useRef<HTMLDivElement>(null);
  const renameInputRef = useRef<HTMLInputElement>(null);

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

  const handleNewTask = () => {
    // Deselect current task to show the welcome/new task screen
    onSelectTask(null);
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
        {tasks.length === 0 ? (
          <div className="sidebar-empty cli-empty">
            <pre className="cli-tree">{`├── (no tasks)
└── ...`}</pre>
            <p className="cli-hint"># run new_task to begin</p>
          </div>
        ) : (
          tasks.map((task, index) => (
            <div
              key={task.id}
              className={`task-item cli-task-item ${selectedTaskId === task.id ? 'task-item-selected' : ''}`}
              onClick={() => renameTaskId !== task.id && onSelectTask(task.id)}
            >
              <span className="cli-task-num">{String(index + 1).padStart(2, '0')}</span>
              <span className={`cli-task-status ${getStatusClass(task.status)}`}>
                {getStatusIndicator(task.status)}
              </span>
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
                  <span className="cli-task-title">
                    {task.title.length > 20 ? task.title.slice(0, 20) + '...' : task.title}
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
          ))
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
