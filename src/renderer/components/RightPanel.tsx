import { useState, useMemo, ReactElement } from 'react';
import { Task, Workspace, TaskEvent, PlanStep } from '../../shared/types';

// Clickable file path component
function ClickableFilePath({ path, className = '' }: { path: string; className?: string }) {
  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const error = await window.electronAPI.openFile(path);
      if (error) {
        console.error('Failed to open file:', error);
      }
    } catch (err) {
      console.error('Error opening file:', err);
    }
  };

  const handleContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await window.electronAPI.showInFinder(path);
    } catch (err) {
      console.error('Error showing in Finder:', err);
    }
  };

  const fileName = path.split('/').pop() || path;

  return (
    <span
      className={`clickable-file-path ${className}`}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      title={`${path}\n\nClick to open • Right-click to show in Finder`}
    >
      {fileName}
    </span>
  );
}

interface RightPanelProps {
  task: Task | undefined;
  workspace: Workspace | null;
  events: TaskEvent[];
}

interface FileInfo {
  path: string;
  action: 'created' | 'modified' | 'deleted';
  timestamp: number;
}

interface ToolUsage {
  name: string;
  count: number;
  lastUsed: number;
}

export function RightPanel({ task, workspace, events }: RightPanelProps) {
  const [expandedSections, setExpandedSections] = useState({
    progress: true,
    folder: true,
    context: true,
  });

  const toggleSection = (section: keyof typeof expandedSections) => {
    setExpandedSections(prev => ({
      ...prev,
      [section]: !prev[section],
    }));
  };

  // Extract plan steps from events
  const planSteps = useMemo((): PlanStep[] => {
    const planEvent = events.find(e => e.type === 'plan_created');
    if (!planEvent?.payload?.plan?.steps) return [];

    // Get the base steps from the plan
    const steps = [...planEvent.payload.plan.steps];

    // Update step statuses based on step events
    events.forEach(event => {
      if (event.type === 'step_started' && event.payload.step) {
        const step = steps.find(s => s.id === event.payload.step.id);
        if (step) step.status = 'in_progress';
      }
      if (event.type === 'step_completed' && event.payload.step) {
        const step = steps.find(s => s.id === event.payload.step.id);
        if (step) step.status = 'completed';
      }
    });

    return steps;
  }, [events]);

  // Extract files from events
  const files = useMemo((): FileInfo[] => {
    const fileMap = new Map<string, FileInfo>();

    events.forEach(event => {
      if (event.type === 'file_created' && event.payload.path) {
        fileMap.set(event.payload.path, {
          path: event.payload.path,
          action: 'created',
          timestamp: event.timestamp,
        });
      }
      if (event.type === 'file_modified' && (event.payload.path || event.payload.from)) {
        const path = event.payload.path || event.payload.from;
        fileMap.set(path, {
          path,
          action: 'modified',
          timestamp: event.timestamp,
        });
      }
      if (event.type === 'file_deleted' && event.payload.path) {
        fileMap.set(event.payload.path, {
          path: event.payload.path,
          action: 'deleted',
          timestamp: event.timestamp,
        });
      }
    });

    return Array.from(fileMap.values()).sort((a, b) => b.timestamp - a.timestamp);
  }, [events]);

  // Extract tool usage from events
  const toolUsage = useMemo((): ToolUsage[] => {
    const toolMap = new Map<string, ToolUsage>();

    events.forEach(event => {
      if (event.type === 'tool_call' && event.payload.tool) {
        const existing = toolMap.get(event.payload.tool);
        if (existing) {
          existing.count++;
          existing.lastUsed = event.timestamp;
        } else {
          toolMap.set(event.payload.tool, {
            name: event.payload.tool,
            count: 1,
            lastUsed: event.timestamp,
          });
        }
      }
    });

    return Array.from(toolMap.values()).sort((a, b) => b.lastUsed - a.lastUsed);
  }, [events]);

  // Extract referenced files from tool results (files that were read)
  const referencedFiles = useMemo((): string[] => {
    const files = new Set<string>();

    events.forEach(event => {
      if (event.type === 'tool_call') {
        // Check if it's a read_file or list_directory call
        if (event.payload.tool === 'read_file' && event.payload.input?.path) {
          files.add(event.payload.input.path);
        }
        if (event.payload.tool === 'search_files' && event.payload.input?.path) {
          files.add(event.payload.input.path);
        }
      }
    });

    return Array.from(files).slice(0, 10); // Limit to 10 most recent
  }, [events]);

  const getStepStatusIcon = (status: PlanStep['status']) => {
    switch (status) {
      case 'completed':
        return (
          <svg viewBox="0 0 36 36" className="step-icon completed">
            <circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M12 18l4 4 8-8" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        );
      case 'in_progress':
        return (
          <svg viewBox="0 0 36 36" className="step-icon in-progress">
            <circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" strokeWidth="2" strokeDasharray="20 80" strokeDashoffset="0">
              <animateTransform attributeName="transform" type="rotate" from="0 18 18" to="360 18 18" dur="1s" repeatCount="indefinite" />
            </circle>
          </svg>
        );
      case 'failed':
        return (
          <svg viewBox="0 0 36 36" className="step-icon failed">
            <circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" strokeWidth="2" />
            <path d="M13 13l10 10M23 13l-10 10" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
          </svg>
        );
      default:
        return (
          <svg viewBox="0 0 36 36" className="step-icon pending">
            <circle cx="18" cy="18" r="16" fill="none" stroke="currentColor" strokeWidth="2" />
          </svg>
        );
    }
  };

  const getFileIcon = (action: FileInfo['action']) => {
    switch (action) {
      case 'created':
        return (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-success)" strokeWidth="2">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M12 18v-6M9 15h6" />
          </svg>
        );
      case 'modified':
        return (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-accent)" strokeWidth="2">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M12 11l-2 6 6-2-4-4z" />
          </svg>
        );
      case 'deleted':
        return (
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="var(--color-error)" strokeWidth="2">
            <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
            <path d="M14 2v6h6" />
            <path d="M9 15h6" />
          </svg>
        );
    }
  };

  const getToolIcon = (toolName: string) => {
    const iconMap: Record<string, ReactElement> = {
      read_file: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6M16 13H8M16 17H8M10 9H8" />
        </svg>
      ),
      write_file: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z" />
          <path d="M14 2v6h6M12 18v-6M9 15h6" />
        </svg>
      ),
      list_directory: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
        </svg>
      ),
      search_files: (
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <circle cx="11" cy="11" r="8" />
          <path d="M21 21l-4.35-4.35" />
        </svg>
      ),
    };

    return iconMap[toolName] || (
      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M14.7 6.3a1 1 0 000 1.4l1.6 1.6a1 1 0 001.4 0l3.77-3.77a6 6 0 01-7.94 7.94l-6.91 6.91a2.12 2.12 0 01-3-3l6.91-6.91a6 6 0 017.94-7.94l-3.76 3.76z" />
      </svg>
    );
  };

  const formatToolName = (name: string) => {
    return name.replace(/_/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
  };

  const getFileName = (path: string) => {
    return path.split('/').pop() || path;
  };

  // Get status indicator for CLI style
  const getStatusIndicator = (status: string) => {
    switch (status) {
      case 'completed': return '[✓]';
      case 'in_progress': return '[~]';
      case 'failed': return '[✗]';
      default: return '[ ]';
    }
  };

  const getFileActionSymbol = (action: FileInfo['action']) => {
    switch (action) {
      case 'created': return '+';
      case 'modified': return '~';
      case 'deleted': return '-';
    }
  };

  return (
    <div className="right-panel cli-panel">
      {/* Terminal Header */}
      <div className="cli-panel-header">
        <span className="cli-panel-title">SYSTEM MONITOR</span>
        <div className="cli-panel-dots">
          <span className="cli-dot"></span>
          <span className="cli-dot"></span>
          <span className="cli-dot active"></span>
        </div>
      </div>

      {/* Progress Section */}
      <div className="right-panel-section cli-section">
        <div className="cli-section-header" onClick={() => toggleSection('progress')}>
          <span className="cli-section-prompt">&gt;</span>
          <span className="cli-section-title">PROGRESS</span>
          <span className="cli-section-toggle">{expandedSections.progress ? '[-]' : '[+]'}</span>
        </div>
        {expandedSections.progress && (
          <div className="cli-section-content">
            {planSteps.length > 0 ? (
              <div className="cli-progress-list">
                {planSteps.map((step, index) => (
                  <div key={step.id || index} className={`cli-progress-item ${step.status}`}>
                    <span className="cli-progress-num">{String(index + 1).padStart(2, '0')}</span>
                    <span className={`cli-progress-status ${step.status}`}>{getStatusIndicator(step.status)}</span>
                    <span className="cli-progress-text">
                      {step.description.length > 30 ? step.description.slice(0, 30) + '...' : step.description}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <div className="cli-empty-state">
                <div className="cli-ascii-box">
                  ┌─────────────────────┐
                  │   {task?.status === 'executing' ? '◉ EXECUTING...' : task?.status === 'completed' ? '✓ COMPLETED' : '○ WAITING'}{'     '}│
                  └─────────────────────┘
                </div>
                <p className="cli-hint"># awaiting task steps...</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Working Folder Section */}
      <div className="right-panel-section cli-section">
        <div className="cli-section-header" onClick={() => toggleSection('folder')}>
          <span className="cli-section-prompt">&gt;</span>
          <span className="cli-section-title">FILES</span>
          <span className="cli-section-toggle">{expandedSections.folder ? '[-]' : '[+]'}</span>
        </div>
        {expandedSections.folder && (
          <div className="cli-section-content">
            {files.length > 0 ? (
              <div className="cli-file-list">
                {files.map((file, index) => (
                  <div key={`${file.path}-${index}`} className={`cli-file-item ${file.action}`}>
                    <span className={`cli-file-action ${file.action}`}>{getFileActionSymbol(file.action)}</span>
                    <ClickableFilePath path={file.path} className="cli-file-name" />
                  </div>
                ))}
              </div>
            ) : (
              <div className="cli-empty-state">
                <pre className="cli-tree">
{`├── (empty)
└── ...`}
                </pre>
                <p className="cli-hint"># no file changes yet</p>
              </div>
            )}
            {workspace && (
              <div className="cli-workspace-path">
                <span className="cli-label">PWD:</span>
                <span className="cli-path" title={workspace.path}>{workspace.name}/</span>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Context Section */}
      <div className="right-panel-section cli-section">
        <div className="cli-section-header" onClick={() => toggleSection('context')}>
          <span className="cli-section-prompt">&gt;</span>
          <span className="cli-section-title">CONTEXT</span>
          <span className="cli-section-toggle">{expandedSections.context ? '[-]' : '[+]'}</span>
        </div>
        {expandedSections.context && (
          <div className="cli-section-content">
            {toolUsage.length > 0 || referencedFiles.length > 0 ? (
              <div className="cli-context-list">
                {toolUsage.length > 0 && (
                  <div className="cli-context-group">
                    <div className="cli-context-label"># tools_used:</div>
                    {toolUsage.map((tool, index) => (
                      <div key={`${tool.name}-${index}`} className="cli-context-item">
                        <span className="cli-context-key">{tool.name}</span>
                        <span className="cli-context-sep">:</span>
                        <span className="cli-context-val">{tool.count}x</span>
                      </div>
                    ))}
                  </div>
                )}
                {referencedFiles.length > 0 && (
                  <div className="cli-context-group">
                    <div className="cli-context-label"># files_read:</div>
                    {referencedFiles.map((file, index) => (
                      <div key={`${file}-${index}`} className="cli-context-item">
                        <ClickableFilePath path={file} className="cli-context-file" />
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ) : (
              <div className="cli-empty-state">
                <div className="cli-context-empty">
                  tools: 0
                  files: 0
                </div>
                <p className="cli-hint"># no context loaded</p>
              </div>
            )}
          </div>
        )}
      </div>

      {/* Empty space filler */}
      <div style={{ flex: 1 }} />

      {/* Footer note */}
      <div className="cli-panel-footer">
        <span className="cli-footer-prompt">$</span>
        <span className="cli-footer-text">local execution only</span>
      </div>
    </div>
  );
}
