import { useState, useEffect, useRef, useCallback } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Task, TaskEvent, Workspace, ApprovalRequest, LLMModelInfo, SuccessCriteria } from '../../shared/types';
import { ApprovalDialog } from './ApprovalDialog';

// Searchable Model Dropdown Component
interface ModelDropdownProps {
  models: LLMModelInfo[];
  selectedModel: string;
  onModelChange: (model: string) => void;
}

function ModelDropdown({ models, selectedModel, onModelChange }: ModelDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedModelInfo = models.find(m => m.key === selectedModel);

  const filteredModels = models.filter(model =>
    model.displayName.toLowerCase().includes(search.toLowerCase()) ||
    model.key.toLowerCase().includes(search.toLowerCase()) ||
    model.description.toLowerCase().includes(search.toLowerCase())
  );

  // Reset highlighted index when search changes
  useEffect(() => {
    setHighlightedIndex(0);
  }, [search]);

  // Scroll highlighted option into view
  useEffect(() => {
    if (isOpen && listRef.current) {
      const highlightedEl = listRef.current.querySelector(`[data-index="${highlightedIndex}"]`);
      if (highlightedEl) {
        highlightedEl.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [highlightedIndex, isOpen]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === 'Enter' || e.key === ' ' || e.key === 'ArrowDown') {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    switch (e.key) {
      case 'ArrowDown':
        e.preventDefault();
        setHighlightedIndex(i => Math.min(i + 1, filteredModels.length - 1));
        break;
      case 'ArrowUp':
        e.preventDefault();
        setHighlightedIndex(i => Math.max(i - 1, 0));
        break;
      case 'Enter':
        e.preventDefault();
        if (filteredModels[highlightedIndex]) {
          onModelChange(filteredModels[highlightedIndex].key);
          setIsOpen(false);
          setSearch('');
        }
        break;
      case 'Escape':
        e.preventDefault();
        setIsOpen(false);
        setSearch('');
        break;
    }
  };

  const handleSelect = (modelKey: string) => {
    onModelChange(modelKey);
    setIsOpen(false);
    setSearch('');
  };

  return (
    <div className="model-dropdown-container" ref={containerRef}>
      <button
        className={`model-selector ${isOpen ? 'open' : ''}`}
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) {
            setTimeout(() => inputRef.current?.focus(), 0);
          }
        }}
        onKeyDown={handleKeyDown}
      >
        {selectedModelInfo?.displayName || 'Select Model'}
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {isOpen && (
        <div className="model-dropdown">
          <div className="model-dropdown-search">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="11" cy="11" r="8" />
              <path d="M21 21l-4.35-4.35" />
            </svg>
            <input
              ref={inputRef}
              type="text"
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Search models..."
              autoFocus
            />
          </div>
          <div ref={listRef} className="model-dropdown-list">
            {filteredModels.length === 0 ? (
              <div className="model-dropdown-no-results">No models found</div>
            ) : (
              filteredModels.map((model, index) => (
                <button
                  key={model.key}
                  data-index={index}
                  className={`model-dropdown-item ${model.key === selectedModel ? 'selected' : ''} ${index === highlightedIndex ? 'highlighted' : ''}`}
                  onClick={() => handleSelect(model.key)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                >
                  <div className="model-dropdown-item-content">
                    <span className="model-dropdown-item-name">{model.displayName}</span>
                    <span className="model-dropdown-item-desc">{model.description}</span>
                  </div>
                  {model.key === selectedModel && (
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// Clickable file path component - opens file on click, shows in Finder on right-click
function ClickableFilePath({ path, workspacePath, className = '' }: { path: string; workspacePath?: string; className?: string }) {
  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      const error = await window.electronAPI.openFile(path, workspacePath);
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
      await window.electronAPI.showInFinder(path, workspacePath);
    } catch (err) {
      console.error('Error showing in Finder:', err);
    }
  };

  // Extract filename for display
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

interface GoalModeOptions {
  successCriteria?: SuccessCriteria;
  maxAttempts?: number;
}

interface MainContentProps {
  task: Task | undefined;
  workspace: Workspace | null;
  events: TaskEvent[];
  onSendMessage: (message: string) => void;
  onCreateTask?: (title: string, prompt: string, options?: GoalModeOptions) => void;
  onChangeWorkspace?: () => void;
  onStopTask?: () => void;
  selectedModel: string;
  availableModels: LLMModelInfo[];
  onModelChange: (model: string) => void;
}

export function MainContent({ task, workspace, events, onSendMessage, onCreateTask, onChangeWorkspace, onStopTask, selectedModel, availableModels, onModelChange }: MainContentProps) {
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [inputValue, setInputValue] = useState('');
  // Goal Mode state
  const [goalModeEnabled, setGoalModeEnabled] = useState(false);
  const [verificationCommand, setVerificationCommand] = useState('');
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [showSteps, setShowSteps] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null);
  const [expandedEvents, setExpandedEvents] = useState<Set<number>>(new Set());

  const toggleEventExpanded = (index: number) => {
    setExpandedEvents(prev => {
      const next = new Set(prev);
      if (next.has(index)) {
        next.delete(index);
      } else {
        next.add(index);
      }
      return next;
    });
  };

  // Check if an event has details to show
  const hasEventDetails = (event: TaskEvent): boolean => {
    return ['plan_created', 'tool_call', 'tool_result', 'assistant_message', 'error'].includes(event.type);
  };

  const timelineRef = useRef<HTMLDivElement>(null);
  const mainBodyRef = useRef<HTMLDivElement>(null);
  const prevTaskStatusRef = useRef<Task['status'] | undefined>(undefined);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-resize textarea as content changes
  const autoResizeTextarea = useCallback(() => {
    const textarea = textareaRef.current;
    if (textarea) {
      textarea.style.height = 'auto';
      textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
    }
  }, []);

  // Auto-resize when input value changes
  useEffect(() => {
    autoResizeTextarea();
  }, [inputValue, autoResizeTextarea]);

  // Check if user is near the bottom of the scroll container
  const isNearBottom = useCallback((element: HTMLElement, threshold = 100) => {
    const { scrollTop, scrollHeight, clientHeight } = element;
    return scrollHeight - scrollTop - clientHeight < threshold;
  }, []);

  // Handle scroll events to detect manual scrolling
  const handleScroll = useCallback(() => {
    const container = mainBodyRef.current;
    if (!container) return;

    // If user scrolls to near bottom, re-enable auto-scroll
    // If user scrolls away from bottom, disable auto-scroll
    setAutoScroll(isNearBottom(container));
  }, [isNearBottom]);

  // Auto-scroll to bottom when new events arrive
  useEffect(() => {
    if (autoScroll && timelineRef.current && mainBodyRef.current) {
      // Scroll the main body to show the latest event
      mainBodyRef.current.scrollTop = mainBodyRef.current.scrollHeight;
    }
  }, [events, autoScroll]);

  // Reset auto-scroll when task changes
  useEffect(() => {
    setAutoScroll(true);
  }, [task?.id]);

  // Send queued message when task finishes executing
  useEffect(() => {
    const prevStatus = prevTaskStatusRef.current;
    const currentStatus = task?.status;

    // If task was executing and now it's not, send the queued message
    if (prevStatus === 'executing' && currentStatus !== 'executing' && queuedMessage) {
      onSendMessage(queuedMessage);
      setQueuedMessage(null);
    }

    prevTaskStatusRef.current = currentStatus;
  }, [task?.status, queuedMessage, onSendMessage]);

  // Check for approval requests in events
  useEffect(() => {
    // Get all approval IDs that have been resolved (granted or denied)
    const resolvedApprovalIds = new Set(
      events
        .filter(e => e.type === 'approval_granted' || e.type === 'approval_denied')
        .map(e => e.payload?.approvalId || e.payload?.approval?.id)
        .filter(Boolean)
    );

    // Find an approval request that hasn't been resolved yet
    const pendingApprovalEvent = events.find(e => {
      if (e.type !== 'approval_requested' || !e.payload?.approval) return false;
      const approvalId = e.payload.approval.id;
      // Only show if not already resolved
      return !resolvedApprovalIds.has(approvalId);
    });

    if (pendingApprovalEvent) {
      setPendingApproval(pendingApprovalEvent.payload.approval);
    } else {
      // No pending approvals - clear the state
      setPendingApproval(null);
    }
  }, [events]);

  const handleApprovalResponse = async (approved: boolean) => {
    if (!pendingApproval) return;
    try {
      await window.electronAPI.respondToApproval({
        approvalId: pendingApproval.id,
        approved,
      });
      setPendingApproval(null);
    } catch (error) {
      console.error('Failed to respond to approval:', error);
    }
  };

  const handleSend = () => {
    if (inputValue.trim()) {
      if (!task && onCreateTask) {
        // Create new task with optional Goal Mode options
        const title = inputValue.trim().slice(0, 50);
        const options: GoalModeOptions | undefined = goalModeEnabled && verificationCommand
          ? {
              successCriteria: { type: 'shell_command' as const, command: verificationCommand },
              maxAttempts,
            }
          : undefined;
        onCreateTask(title, inputValue.trim(), options);
        // Reset Goal Mode state
        setGoalModeEnabled(false);
        setVerificationCommand('');
        setMaxAttempts(3);
      } else {
        onSendMessage(inputValue.trim());
      }
      setInputValue('');
    }
  };

  const handleQueue = () => {
    if (inputValue.trim()) {
      setQueuedMessage(inputValue.trim());
      setInputValue('');
    }
  };

  const handleClearQueue = () => {
    setQueuedMessage(null);
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handleQuickAction = (action: string) => {
    setInputValue(action);
  };

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getEventDotClass = (type: TaskEvent['type']) => {
    if (type === 'error' || type === 'verification_failed') return 'error';
    if (type === 'step_completed' || type === 'task_completed' || type === 'verification_passed') return 'success';
    if (type === 'step_started' || type === 'executing' || type === 'verification_started' || type === 'retry_started') return 'active';
    return '';
  };

  // Welcome/Empty state
  if (!task) {
    return (
      <div className="main-content">
        <div className="main-body welcome-view">
          <div className="welcome-content cli-style">
            {/* ASCII Terminal Header */}
            <div className="cli-header">
              <pre className="ascii-art">{`
  ██████╗ ██████╗ ██╗    ██╗ ██████╗ ██████╗ ██╗  ██╗       ██████╗ ███████╗███████╗
 ██╔════╝██╔═══██╗██║    ██║██╔═══██╗██╔══██╗██║ ██╔╝      ██╔═══██╗██╔════╝██╔════╝
 ██║     ██║   ██║██║ █╗ ██║██║   ██║██████╔╝█████╔╝ █████╗██║   ██║███████╗███████╗
 ██║     ██║   ██║██║███╗██║██║   ██║██╔══██╗██╔═██╗ ╚════╝██║   ██║╚════██║╚════██║
 ╚██████╗╚██████╔╝╚███╔███╔╝╚██████╔╝██║  ██║██║  ██╗      ╚██████╔╝███████║███████║
  ╚═════╝ ╚═════╝  ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝       ╚═════╝ ╚══════╝╚══════╝`}</pre>
              <div className="cli-version">v0.1.0</div>
            </div>

            {/* Terminal Info */}
            <div className="cli-info">
              <div className="cli-line">
                <span className="cli-prompt">$</span>
                <span className="cli-text">Welcome to CoWork-OSS - your AI-powered task automation assistant</span>
              </div>
              <div className="cli-line cli-line-disclosure">
                <span className="cli-prompt">#</span>
                <span className="cli-text cli-text-muted">You are interacting with an AI system. Responses are generated by AI models.</span>
              </div>
              <div className="cli-line">
                <span className="cli-prompt">$</span>
                <span className="cli-text">Type a task below or select a quick command to get started</span>
              </div>
            </div>

            {/* Quick Commands */}
            <div className="cli-commands">
              <div className="cli-commands-header">
                <span className="cli-prompt">&gt;</span>
                <span>QUICK COMMANDS</span>
              </div>
              <div className="cli-commands-grid">
                <button className="cli-command" onClick={() => handleQuickAction('Create a file')}>
                  <span className="cli-cmd-prefix">01</span>
                  <span className="cli-cmd-text">create-file</span>
                </button>
                <button className="cli-command" onClick={() => handleQuickAction('Crunch data')}>
                  <span className="cli-cmd-prefix">02</span>
                  <span className="cli-cmd-text">crunch-data</span>
                </button>
                <button className="cli-command" onClick={() => handleQuickAction('Make a prototype')}>
                  <span className="cli-cmd-prefix">03</span>
                  <span className="cli-cmd-text">prototype</span>
                </button>
                <button className="cli-command" onClick={() => handleQuickAction('Organize files')}>
                  <span className="cli-cmd-prefix">04</span>
                  <span className="cli-cmd-text">organize</span>
                </button>
                <button className="cli-command" onClick={() => handleQuickAction('Prep for a meeting')}>
                  <span className="cli-cmd-prefix">05</span>
                  <span className="cli-cmd-text">prep-meeting</span>
                </button>
                <button className="cli-command" onClick={() => handleQuickAction('Draft a message')}>
                  <span className="cli-cmd-prefix">06</span>
                  <span className="cli-cmd-text">draft-msg</span>
                </button>
              </div>
            </div>

            {/* Input Area */}
            <div className="welcome-input-container cli-input-container">
              <div className="cli-input-wrapper">
                <span className="cli-input-prompt">~$</span>
                <textarea
                  ref={textareaRef}
                  className="welcome-input cli-input input-textarea"
                  placeholder="Enter your task..."
                  value={inputValue}
                  onChange={(e) => setInputValue(e.target.value)}
                  onKeyDown={handleKeyDown}
                  rows={1}
                />
                <span className="cli-cursor"></span>
              </div>

              {/* Goal Mode Options */}
              <div className="goal-mode-section">
                <label className="goal-mode-toggle">
                  <input
                    type="checkbox"
                    checked={goalModeEnabled}
                    onChange={(e) => setGoalModeEnabled(e.target.checked)}
                  />
                  <span className="goal-mode-label">Goal Mode</span>
                  <span className="goal-mode-hint">Verify & retry until success</span>
                </label>
                {goalModeEnabled && (
                  <div className="goal-mode-options">
                    <div className="goal-mode-command">
                      <span className="goal-mode-prompt">$</span>
                      <input
                        type="text"
                        className="goal-mode-input"
                        placeholder="Verification command (e.g., npm test)"
                        value={verificationCommand}
                        onChange={(e) => setVerificationCommand(e.target.value)}
                      />
                    </div>
                    <div className="goal-mode-attempts">
                      <label>
                        Max attempts:
                        <input
                          type="number"
                          min="1"
                          max="10"
                          value={maxAttempts}
                          onChange={(e) => setMaxAttempts(Math.min(10, Math.max(1, Number(e.target.value))))}
                        />
                      </label>
                    </div>
                  </div>
                )}
              </div>

              <div className="welcome-input-footer">
                <div className="input-left-actions">
                  <button className="folder-selector" onClick={onChangeWorkspace}>
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                    </svg>
                    <span>{workspace?.name || 'Select folder'}</span>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M6 9l6 6 6-6" />
                    </svg>
                  </button>
                </div>
                <div className="input-right-actions">
                  <ModelDropdown
                    models={availableModels}
                    selectedModel={selectedModel}
                    onModelChange={onModelChange}
                  />
                  <button
                    className="lets-go-btn"
                    onClick={handleSend}
                    disabled={!inputValue.trim()}
                  >
                    <span>Let's Start</span>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 19V5M5 12l7-7 7 7" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // Task view
  return (
    <div className="main-content">
      {/* Header */}
      <div className="main-header">
        <div className="main-header-title">{task.title}</div>
        <div className="main-header-actions">
          <button className="button-secondary" style={{ padding: '6px 8px' }}>
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="3" y="3" width="18" height="18" rx="2" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body */}
      <div className="main-body" ref={mainBodyRef} onScroll={handleScroll}>
        <div className="task-content">
          {/* Task Description */}
          <div className="task-section">
            <div className="task-description">
              <p>{task.prompt}</p>
            </div>
          </div>

          {/* Timeline */}
          {events.length > 0 && (
            <div className="timeline-section">
              <button
                className={`view-steps-btn ${showSteps ? 'expanded' : ''}`}
                onClick={() => setShowSteps(!showSteps)}
              >
                View steps
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>

              {showSteps && (
                <div className="timeline-events" ref={timelineRef}>
                  {events.map((event, index) => {
                    const isExpandable = hasEventDetails(event);
                    const isExpanded = expandedEvents.has(index);
                    return (
                      <div key={`event-${index}-${event.id || 'no-id'}`} className="timeline-event">
                        <div className="event-indicator">
                          <div className={`event-dot ${getEventDotClass(event.type)}`} />
                          {index < events.length - 1 && <div className="event-line" />}
                        </div>
                        <div className="event-content">
                          <div
                            className={`event-header ${isExpandable ? 'expandable' : ''} ${isExpanded ? 'expanded' : ''}`}
                            onClick={isExpandable ? () => toggleEventExpanded(index) : undefined}
                          >
                            <div className="event-header-left">
                              {isExpandable && (
                                <svg className="event-expand-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                  <path d="M9 18l6-6-6-6" />
                                </svg>
                              )}
                              <div className="event-title">{renderEventTitle(event, workspace?.path)}</div>
                            </div>
                            <div className="event-time">{formatTime(event.timestamp)}</div>
                          </div>
                          {isExpanded && renderEventDetails(event)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Footer with Input */}
      <div className="main-footer">
        <div className="input-container">
          {/* Queued message display */}
          {queuedMessage && (
            <div className="queued-message-frame">
              <div className="queued-message-content">
                <svg className="queued-message-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M12 19V5M5 12l7-7 7 7" />
                </svg>
                <span className="queued-message-label">Queue:</span>
                <span className="queued-message-text">{queuedMessage}</span>
              </div>
              <button className="queued-message-clear" onClick={handleClearQueue} title="Remove from queue">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
          <div className="input-row">
            <textarea
              ref={textareaRef}
              className="input-field input-textarea"
              placeholder={queuedMessage ? "Message queued..." : "Reply..."}
              value={inputValue}
              onChange={(e) => setInputValue(e.target.value)}
              onKeyDown={handleKeyDown}
              rows={1}
            />
            <div className="input-actions">
              <ModelDropdown
                models={availableModels}
                selectedModel={selectedModel}
                onModelChange={onModelChange}
              />
              {task.status === 'executing' && onStopTask && (
                <button
                  className="send-btn send-btn-stop"
                  onClick={onStopTask}
                  title="Stop task"
                >
                  <span>Stop</span>
                </button>
              )}
              {task.status === 'executing' ? (
                <button
                  className="send-btn send-btn-queue"
                  onClick={handleQueue}
                  disabled={!inputValue.trim() || !!queuedMessage}
                  title={queuedMessage ? "A message is already queued" : "Add to queue"}
                >
                  <span>Queue</span>
                </button>
              ) : (
                <button
                  className="send-btn"
                  onClick={handleSend}
                  disabled={!inputValue.trim()}
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          <div className="input-disclaimer">
            AI can make mistakes. Please double-check responses.
          </div>
        </div>
      </div>

      {pendingApproval && (
        <ApprovalDialog
          approval={pendingApproval}
          onApprove={() => handleApprovalResponse(true)}
          onDeny={() => handleApprovalResponse(false)}
        />
      )}
    </div>
  );
}

/**
 * Truncate long text for display, with expand option handled via CSS
 */
function truncateForDisplay(text: string, maxLength: number = 2000): string {
  if (!text || text.length <= maxLength) return text;
  return text.slice(0, maxLength) + '\n\n... [content truncated for display]';
}

function renderEventTitle(event: TaskEvent, workspacePath?: string): React.ReactNode {
  switch (event.type) {
    case 'task_created':
      return 'Task created';
    case 'plan_created':
      return 'Execution plan created';
    case 'step_started':
      return `Started: ${event.payload.step?.description || 'Step'}`;
    case 'step_completed':
      return `Completed: ${event.payload.step?.description || event.payload.message || 'Step'}`;
    case 'tool_call':
      return `Tool: ${event.payload.tool}`;
    case 'tool_result':
      return `Result: ${event.payload.tool}`;
    case 'assistant_message':
      return 'Assistant';
    case 'file_created':
      return (
        <span>
          Created: <ClickableFilePath path={event.payload.path} workspacePath={workspacePath} />
        </span>
      );
    case 'file_modified':
      return (
        <span>
          Modified: <ClickableFilePath path={event.payload.path || event.payload.from} workspacePath={workspacePath} />
        </span>
      );
    case 'file_deleted':
      return `Deleted: ${event.payload.path}`;
    case 'error':
      return 'Error occurred';
    case 'approval_requested':
      return `Approval needed: ${event.payload.approval?.description}`;
    case 'log':
      return event.payload.message;
    // Goal Mode verification events
    case 'verification_started':
      return 'Running verification...';
    case 'verification_passed':
      return `Verification passed (attempt ${event.payload.attempt})`;
    case 'verification_failed':
      return `Verification failed (attempt ${event.payload.attempt}/${event.payload.maxAttempts})`;
    case 'retry_started':
      return `Retrying (attempt ${event.payload.attempt}/${event.payload.maxAttempts})`;
    default:
      return event.type;
  }
}

function renderEventDetails(event: TaskEvent) {
  switch (event.type) {
    case 'plan_created':
      return (
        <div className="event-details">
          <div style={{ marginBottom: 8, fontWeight: 500 }}>{event.payload.plan?.description}</div>
          {event.payload.plan?.steps && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {event.payload.plan.steps.map((step: any, i: number) => (
                <li key={i} style={{ marginBottom: 4 }}>{step.description}</li>
              ))}
            </ul>
          )}
        </div>
      );
    case 'tool_call':
      return (
        <div className="event-details event-details-scrollable">
          <pre>{truncateForDisplay(JSON.stringify(event.payload.input, null, 2))}</pre>
        </div>
      );
    case 'tool_result':
      return (
        <div className="event-details event-details-scrollable">
          <pre>{truncateForDisplay(JSON.stringify(event.payload.result, null, 2))}</pre>
        </div>
      );
    case 'assistant_message':
      return (
        <div className="event-details assistant-message event-details-scrollable markdown-content">
          <ReactMarkdown remarkPlugins={[remarkGfm]}>
            {truncateForDisplay(event.payload.message)}
          </ReactMarkdown>
        </div>
      );
    case 'error':
      return (
        <div className="event-details" style={{ background: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.2)' }}>
          {event.payload.error || event.payload.message}
        </div>
      );
    default:
      return null;
  }
}
