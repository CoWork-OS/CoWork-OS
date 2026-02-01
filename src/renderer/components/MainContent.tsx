import { useState, useEffect, useRef, useCallback, useMemo, Fragment } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Task, TaskEvent, Workspace, ApprovalRequest, LLMModelInfo, SuccessCriteria, CustomSkill, EventType, TEMP_WORKSPACE_ID } from '../../shared/types';

// localStorage key for verbose mode
const VERBOSE_STEPS_KEY = 'cowork:verboseSteps';
const TASK_TITLE_MAX_LENGTH = 50;
const TITLE_ELLIPSIS_REGEX = /(\.\.\.|\u2026)$/u;

// Important event types shown in non-verbose mode
// These are high-level steps that represent meaningful progress
const IMPORTANT_EVENT_TYPES: EventType[] = [
  'task_created',
  'task_completed',
  'task_cancelled',
  'plan_created',
  'step_started',
  'step_completed',
  'step_failed',
  'assistant_message',
  'user_message',
  'file_created',
  'file_modified',
  'file_deleted',
  'error',
  'verification_started',
  'verification_passed',
  'verification_failed',
  'retry_started',
  'approval_requested',
];

// Helper to check if an event is important (shown in non-verbose mode)
const isImportantEvent = (event: TaskEvent): boolean => {
  return IMPORTANT_EVENT_TYPES.includes(event.type);
};

const buildTaskTitle = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length <= TASK_TITLE_MAX_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, TASK_TITLE_MAX_LENGTH)}...`;
};
import { ApprovalDialog } from './ApprovalDialog';
import { SkillParameterModal } from './SkillParameterModal';
import { FileViewer } from './FileViewer';
import { CommandOutput } from './CommandOutput';
import { CanvasPreview } from './CanvasPreview';

// Code block component with copy button
interface CodeBlockProps {
  children?: React.ReactNode;
  className?: string;
  node?: unknown;
}

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  // Check if this is a code block (has language class) vs inline code
  const isCodeBlock = className?.startsWith('language-');
  const language = className?.replace('language-', '') || '';

  // Get the text content for copying
  const getTextContent = (node: React.ReactNode): string => {
    if (typeof node === 'string') return node;
    if (Array.isArray(node)) return node.map(getTextContent).join('');
    if (node && typeof node === 'object' && 'props' in node) {
      return getTextContent((node as { props: { children?: React.ReactNode } }).props.children);
    }
    return '';
  };

  const handleCopy = async () => {
    const text = getTextContent(children);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  // For inline code, just render normally
  if (!isCodeBlock) {
    return <code className={className} {...props}>{children}</code>;
  }

  // For code blocks, wrap with copy button
  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        {language && <span className="code-block-language">{language}</span>}
        <button
          className={`code-block-copy ${copied ? 'copied' : ''}`}
          onClick={handleCopy}
          title={copied ? 'Copied!' : 'Copy code'}
        >
          {copied ? (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M20 6L9 17l-5-5" />
            </svg>
          ) : (
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          )}
          <span>{copied ? 'Copied!' : 'Copy'}</span>
        </button>
      </div>
      <code className={className} {...props}>{children}</code>
    </div>
  );
}

// Copy button for user messages
function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('Failed to copy:', err);
    }
  };

  return (
    <button
      className={`message-copy-btn ${copied ? 'copied' : ''}`}
      onClick={handleCopy}
      title={copied ? 'Copied!' : 'Copy message'}
    >
      {copied ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      )}
      <span>{copied ? 'Copied' : 'Copy'}</span>
    </button>
  );
}

// Custom components for ReactMarkdown
const markdownComponents = {
  code: CodeBlock,
};

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

// Clickable file path component - opens file viewer on click, shows in Finder on right-click
function ClickableFilePath({
  path,
  workspacePath,
  className = '',
  onOpenViewer
}: {
  path: string;
  workspacePath?: string;
  className?: string;
  onOpenViewer?: (path: string) => void;
}) {
  const handleClick = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // If viewer callback is provided and we have a workspace, use the in-app viewer
    if (onOpenViewer && workspacePath) {
      onOpenViewer(path);
      return;
    }

    // Fallback to external app
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
      title={`${path}\n\nClick to preview • Right-click to show in Finder`}
    >
      {fileName}
    </span>
  );
}

interface GoalModeOptions {
  successCriteria?: SuccessCriteria;
  maxAttempts?: number;
}

type SettingsTab = 'appearance' | 'llm' | 'search' | 'telegram' | 'discord' | 'updates' | 'guardrails' | 'queue' | 'skills';

interface MainContentProps {
  task: Task | undefined;
  selectedTaskId: string | null;  // Added to distinguish "no task" from "task not in list"
  workspace: Workspace | null;
  events: TaskEvent[];
  onSendMessage: (message: string) => void;
  onCreateTask?: (title: string, prompt: string, options?: GoalModeOptions) => void;
  onChangeWorkspace?: () => void;
  onSelectWorkspace?: (workspace: Workspace) => void;
  onOpenSettings?: (tab?: SettingsTab) => void;
  onStopTask?: () => void;
  selectedModel: string;
  availableModels: LLMModelInfo[];
  onModelChange: (model: string) => void;
}

// Track active command execution state
interface ActiveCommand {
  command: string;
  output: string;
  isRunning: boolean;
  exitCode: number | null;
  startTimestamp: number; // When the command started, for positioning in timeline
}

// Canvas session type
interface CanvasSession {
  id: string;
  taskId: string;
  workspaceId: string;
  sessionDir: string;
  status: 'active' | 'paused' | 'closed';
  title?: string;
  createdAt: number;
  lastUpdatedAt: number;
}

export function MainContent({ task, selectedTaskId, workspace, events, onSendMessage, onCreateTask, onChangeWorkspace, onSelectWorkspace, onOpenSettings, onStopTask, selectedModel, availableModels, onModelChange }: MainContentProps) {
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [inputValue, setInputValue] = useState('');
  // Shell permission state - tracks current workspace's shell permission
  const [shellEnabled, setShellEnabled] = useState(workspace?.permissions?.shell ?? false);
  // Active command execution state
  const [activeCommand, setActiveCommand] = useState<ActiveCommand | null>(null);
  // Track dismissed command outputs by task ID (persisted in localStorage)
  const [dismissedCommandOutputs, setDismissedCommandOutputs] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem('dismissedCommandOutputs');
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });
  // Goal Mode state
  const [goalModeEnabled, setGoalModeEnabled] = useState(false);
  const [verificationCommand, setVerificationCommand] = useState('');
  const [maxAttempts, setMaxAttempts] = useState(3);
  const [showSteps, setShowSteps] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  const [queuedMessage, setQueuedMessage] = useState<string | null>(null);
  // Track toggled events by ID for stable state across filtering
  const [toggledEvents, setToggledEvents] = useState<Set<string>>(new Set());
  const [appVersion, setAppVersion] = useState<string>('');
  const [customSkills, setCustomSkills] = useState<CustomSkill[]>([]);
  const [showSkillsMenu, setShowSkillsMenu] = useState(false);
  const [skillsSearchQuery, setSkillsSearchQuery] = useState('');
  const [selectedSkillForParams, setSelectedSkillForParams] = useState<CustomSkill | null>(null);
  const [viewerFilePath, setViewerFilePath] = useState<string | null>(null);
  // Canvas sessions state - track active canvas sessions for current task
  const [canvasSessions, setCanvasSessions] = useState<CanvasSession[]>([]);
  // Workspace dropdown state
  const [showWorkspaceDropdown, setShowWorkspaceDropdown] = useState(false);
  const [workspacesList, setWorkspacesList] = useState<Workspace[]>([]);
  // Verbose mode - when false, only show important steps
  const [verboseSteps, setVerboseSteps] = useState(() => {
    const saved = localStorage.getItem(VERBOSE_STEPS_KEY);
    return saved === 'true';
  });
  const skillsMenuRef = useRef<HTMLDivElement>(null);
  const workspaceDropdownRef = useRef<HTMLDivElement>(null);

  // Filter events based on verbose mode
  const filteredEvents = useMemo(() => {
    if (verboseSteps) {
      return events;
    }
    return events.filter(isImportantEvent);
  }, [events, verboseSteps]);

  // Find the index where command output should be inserted (after the last event before command started)
  const commandOutputInsertIndex = useMemo(() => {
    if (!activeCommand || !activeCommand.startTimestamp) return -1;
    // Find the last event that started before or at the same time as the command
    for (let i = filteredEvents.length - 1; i >= 0; i--) {
      if (filteredEvents[i].timestamp <= activeCommand.startTimestamp) {
        return i;
      }
    }
    // If no events before command, insert at beginning (index -1 means render before all events)
    return -1;
  }, [filteredEvents, activeCommand]);

  // Toggle verbose mode and persist to localStorage
  const toggleVerboseSteps = () => {
    setVerboseSteps(prev => {
      const newValue = !prev;
      localStorage.setItem(VERBOSE_STEPS_KEY, String(newValue));
      return newValue;
    });
  };

  // Load app version
  useEffect(() => {
    window.electronAPI.getAppVersion()
      .then(info => setAppVersion(info.version))
      .catch(err => console.error('Failed to load version:', err));
  }, []);

  // Load custom skills (task skills only, excludes guidelines)
  useEffect(() => {
    window.electronAPI.listTaskSkills()
      .then(skills => setCustomSkills(skills.filter(s => s.enabled !== false)))
      .catch(err => console.error('Failed to load custom skills:', err));
  }, []);

  // Load canvas sessions when task changes
  useEffect(() => {
    if (!task?.id) {
      setCanvasSessions([]);
      return;
    }

    // Load existing canvas sessions for this task
    window.electronAPI.canvasListSessions(task.id)
      .then(sessions => {
        // Filter to only active/paused sessions
        setCanvasSessions(sessions.filter(s => s.status !== 'closed'));
      })
      .catch(err => console.error('Failed to load canvas sessions:', err));
  }, [task?.id]);

  // Subscribe to canvas events
  useEffect(() => {
    const unsubscribe = window.electronAPI.onCanvasEvent((event) => {
      // Only process events for the current task
      if (task?.id && event.taskId === task.id) {
        // Don't show preview on session_created - wait until content is actually pushed
        if (event.type === 'content_pushed') {
          // Content has been pushed, now show the preview if not already showing
          // Fetch the session info and add it to the list
          window.electronAPI.canvasGetSession(event.sessionId)
            .then(session => {
              if (session && session.status !== 'closed') {
                setCanvasSessions(prev => {
                  // Only add if not already in the list
                  if (prev.some(s => s.id === session.id)) {
                    return prev;
                  }
                  return [...prev, session];
                });
              }
            })
            .catch(err => console.error('Failed to get canvas session:', err));
        } else if (event.type === 'session_updated' && event.session) {
          setCanvasSessions(prev =>
            prev.map(s => s.id === event.sessionId ? event.session! : s)
          );
        } else if (event.type === 'session_closed') {
          setCanvasSessions(prev => prev.filter(s => s.id !== event.sessionId));
        }
      }
    });

    return unsubscribe;
  }, [task?.id]);

  // Handle removing a canvas session from the UI
  const handleCanvasClose = useCallback((sessionId: string) => {
    setCanvasSessions(prev => prev.filter(s => s.id !== sessionId));
  }, []);

  // Handle dismissing command output for current task
  const handleDismissCommandOutput = useCallback(() => {
    if (!task?.id) return;
    setDismissedCommandOutputs(prev => {
      const updated = new Set(prev);
      updated.add(task.id);
      // Persist to localStorage
      localStorage.setItem('dismissedCommandOutputs', JSON.stringify([...updated]));
      return updated;
    });
    setActiveCommand(null);
  }, [task?.id]);

  // Filter skills based on search query
  const filteredSkills = useMemo(() => {
    if (!skillsSearchQuery.trim()) return customSkills;
    const query = skillsSearchQuery.toLowerCase();
    return customSkills.filter(skill =>
      skill.name.toLowerCase().includes(query) ||
      skill.description?.toLowerCase().includes(query) ||
      skill.category?.toLowerCase().includes(query)
    );
  }, [customSkills, skillsSearchQuery]);

  // Sync shell permission state when workspace changes
  useEffect(() => {
    setShellEnabled(workspace?.permissions?.shell ?? false);
  }, [workspace?.id, workspace?.permissions?.shell]);

  // Toggle shell permission for current workspace
  const handleShellToggle = async () => {
    if (!workspace) return;
    const newValue = !shellEnabled;
    setShellEnabled(newValue);
    try {
      await window.electronAPI.updateWorkspacePermissions(workspace.id, { shell: newValue });
    } catch (err) {
      console.error('Failed to update shell permission:', err);
      setShellEnabled(!newValue); // Revert on error
    }
  };

  // Close skills menu on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (skillsMenuRef.current && !skillsMenuRef.current.contains(e.target as Node)) {
        setShowSkillsMenu(false);
        setSkillsSearchQuery('');
      }
    };
    if (showSkillsMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSkillsMenu]);

  // Close workspace dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (workspaceDropdownRef.current && !workspaceDropdownRef.current.contains(e.target as Node)) {
        setShowWorkspaceDropdown(false);
      }
    };
    if (showWorkspaceDropdown) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showWorkspaceDropdown]);

  // Handle workspace dropdown toggle - load workspaces when opening
  const handleWorkspaceDropdownToggle = async () => {
    if (!showWorkspaceDropdown) {
      try {
        const workspaces = await window.electronAPI.listWorkspaces();
        // Filter out temp workspace and sort by most recently created
        const filteredWorkspaces = workspaces
          .filter((w: Workspace) => w.id !== TEMP_WORKSPACE_ID)
          .sort((a: Workspace, b: Workspace) => b.createdAt - a.createdAt);
        setWorkspacesList(filteredWorkspaces);
      } catch (error) {
        console.error('Failed to load workspaces:', error);
      }
    }
    setShowWorkspaceDropdown(!showWorkspaceDropdown);
  };

  // Handle selecting an existing workspace from dropdown
  const handleWorkspaceSelect = (selectedWorkspace: Workspace) => {
    setShowWorkspaceDropdown(false);
    onSelectWorkspace?.(selectedWorkspace);
  };

  // Handle selecting a new folder via Finder
  const handleSelectNewFolder = () => {
    setShowWorkspaceDropdown(false);
    onChangeWorkspace?.();
  };

  const handleSkillSelect = (skill: CustomSkill) => {
    setShowSkillsMenu(false);
    setSkillsSearchQuery('');
    // If skill has parameters, show the parameter modal
    if (skill.parameters && skill.parameters.length > 0) {
      setSelectedSkillForParams(skill);
    } else {
      // No parameters, just set the prompt directly
      setInputValue(skill.prompt);
    }
  };

  const handleSkillParamSubmit = (expandedPrompt: string) => {
    setSelectedSkillForParams(null);
    // Create task directly with the expanded prompt
    if (onCreateTask) {
      const title = buildTaskTitle(expandedPrompt);
      onCreateTask(title, expandedPrompt);
    }
  };

  const handleSkillParamCancel = () => {
    setSelectedSkillForParams(null);
  };

  // Toggle an event's expanded state using its ID
  const toggleEventExpanded = (eventId: string) => {
    setToggledEvents(prev => {
      const next = new Set(prev);
      if (next.has(eventId)) {
        next.delete(eventId);
      } else {
        next.add(eventId);
      }
      return next;
    });
  };

  // Check if an event has details to show
  const hasEventDetails = (event: TaskEvent): boolean => {
    return ['plan_created', 'tool_call', 'tool_result', 'assistant_message', 'error'].includes(event.type);
  };

  // Determine if an event should be expanded by default
  // Important events (plan, assistant responses, errors) should be expanded
  // Verbose events (tool calls/results) should be collapsed
  const shouldDefaultExpand = (event: TaskEvent): boolean => {
    return ['plan_created', 'assistant_message', 'error'].includes(event.type);
  };

  // Check if an event is currently expanded using its ID
  // If the event should default expand, clicking toggles it to collapsed (and vice versa)
  const isEventExpanded = (event: TaskEvent): boolean => {
    const defaultExpanded = shouldDefaultExpand(event);
    const isToggled = toggledEvents.has(event.id);
    // XOR: if toggled, invert the default state
    return defaultExpanded ? !isToggled : isToggled;
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

  // Process command_output events to track live command execution
  useEffect(() => {
    // Get the last command_output event
    const commandOutputEvents = events.filter(e => e.type === 'command_output');
    if (commandOutputEvents.length === 0) {
      setActiveCommand(null);
      return;
    }

    // Build the command state from events
    let currentCommand: string | null = null;
    let output = '';
    let isRunning = false;
    let exitCode: number | null = null;
    let startTimestamp: number = 0;

    for (const event of commandOutputEvents) {
      const payload = event.payload;
      if (payload.type === 'start') {
        // New command started
        currentCommand = payload.command;
        output = payload.output || '';
        isRunning = true;
        exitCode = null;
        startTimestamp = event.timestamp;
      } else if (payload.type === 'stdout' || payload.type === 'stderr' || payload.type === 'stdin') {
        // Append output (stdin shows what user typed)
        output += payload.output || '';
      } else if (payload.type === 'end') {
        // Command finished
        isRunning = false;
        exitCode = payload.exitCode;
      } else if (payload.type === 'error') {
        // Error output
        output += payload.output || '';
      }
    }

    // Check if this task's command output was dismissed
    const isDismissed = task?.id ? dismissedCommandOutputs.has(task.id) : false;

    // If a new command is running, clear the dismissed state for this task
    if (isRunning && task?.id && isDismissed) {
      setDismissedCommandOutputs(prev => {
        const updated = new Set(prev);
        updated.delete(task.id);
        localStorage.setItem('dismissedCommandOutputs', JSON.stringify([...updated]));
        return updated;
      });
    }

    // Show command output if:
    // 1. There's a command AND it's not dismissed, OR
    // 2. Command is currently running (always show while running)
    const shouldShowOutput = currentCommand && (isRunning || !isDismissed);

    // Limit output size in UI to prevent performance issues (keep last 50KB)
    const MAX_UI_OUTPUT = 50 * 1024;
    let truncatedOutput = output;
    if (output.length > MAX_UI_OUTPUT) {
      truncatedOutput = '[... earlier output truncated ...]\n\n' + output.slice(-MAX_UI_OUTPUT);
    }

    if (shouldShowOutput) {
      setActiveCommand({
        command: currentCommand!,
        output: truncatedOutput,
        isRunning,
        exitCode,
        startTimestamp,
      });
    } else {
      setActiveCommand(null);
    }
  }, [events, task?.id, task?.status, dismissedCommandOutputs]);

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
      // Use selectedTaskId to determine if we should follow-up or create new task
      // This fixes the bug where old tasks (beyond the 100 most recent) would create new tasks
      // instead of sending follow-up messages
      if (!selectedTaskId && onCreateTask) {
        // No task selected - create new task with optional Goal Mode options
        const trimmedInput = inputValue.trim();
        const title = buildTaskTitle(trimmedInput);
        const options: GoalModeOptions | undefined = goalModeEnabled && verificationCommand
          ? {
              successCriteria: { type: 'shell_command' as const, command: verificationCommand },
              maxAttempts,
            }
          : undefined;
        onCreateTask(title, trimmedInput, options);
        // Reset Goal Mode state
        setGoalModeEnabled(false);
        setVerificationCommand('');
        setMaxAttempts(3);
      } else {
        // Task is selected (even if not in current list) - send follow-up message
        onSendMessage(inputValue.trim());
      }
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

  // Get the last assistant message to always show the response
  const lastAssistantMessage = useMemo(() => {
    const assistantMessages = events.filter(e => e.type === 'assistant_message');
    return assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;
  }, [events]);

  // Welcome/Empty state
  if (!task) {
    return (
      <div className="main-content">
        <div className="main-body welcome-view">
          <div className="welcome-content cli-style">
            {/* Logo */}
            <div className="welcome-logo">
              <img src="./cowork-os-logo.png" alt="CoWork OS" className="welcome-logo-img" />
            </div>

            {/* ASCII Terminal Header */}
            <div className="cli-header">
              <pre className="ascii-art">{`
  ██████╗ ██████╗ ██╗    ██╗ ██████╗ ██████╗ ██╗  ██╗      ██████╗ ███████╗
 ██╔════╝██╔═══██╗██║    ██║██╔═══██╗██╔══██╗██║ ██╔╝     ██╔═══██╗██╔════╝
 ██║     ██║   ██║██║ █╗ ██║██║   ██║██████╔╝█████╔╝      ██║   ██║███████╗
 ██║     ██║   ██║██║███╗██║██║   ██║██╔══██╗██╔═██╗      ██║   ██║╚════██║
 ╚██████╗╚██████╔╝╚███╔███╔╝╚██████╔╝██║  ██║██║  ██╗     ╚██████╔╝███████║
  ╚═════╝ ╚═════╝  ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝      ╚═════╝ ╚══════╝`}</pre>
              <div className="cli-version">{appVersion ? `v${appVersion}` : ''}</div>
            </div>

            {/* Terminal Info */}
            <div className="cli-info">
              <div className="cli-line">
                <span className="cli-prompt">$</span>
                <span className="cli-text" title="Welcome to CoWork OS - let's get things done together">Welcome to CoWork OS - let's get things done together</span>
              </div>
              <div className="cli-line cli-line-disclosure">
                <span className="cli-prompt">#</span>
                <span className="cli-text cli-text-muted" title="You are interacting with an AI system. Responses are generated by AI models.">You are interacting with an AI system. Responses are generated by AI models.</span>
              </div>
              <div className="cli-line">
                <span className="cli-prompt">$</span>
                <span className="cli-text" title="What should we work on? Type below or pick a quick start">What should we work on? Type below or pick a quick start</span>
              </div>
            </div>

            {/* Quick Start */}
            <div className="cli-commands">
              <div className="cli-commands-header">
                <span className="cli-prompt">&gt;</span>
                <span>QUICK START</span>
              </div>
              <div className="quick-start-grid">
                <button className="quick-start-card" onClick={() => handleQuickAction('Let\'s organize the files in this folder together. Sort them by type and rename them with clear, consistent names.')} title="Let's sort and tidy up the workspace">
                  <span className="quick-start-icon">📁</span>
                  <span className="quick-start-title">Organize files</span>
                  <span className="quick-start-desc">Let's sort and tidy up the workspace</span>
                </button>
                <button className="quick-start-card" onClick={() => handleQuickAction('Let\'s write a document together. I\'ll describe what I need and we can create it.')} title="Co-create reports, summaries, or notes">
                  <span className="quick-start-icon">📝</span>
                  <span className="quick-start-title">Write together</span>
                  <span className="quick-start-desc">Co-create reports, summaries, or notes</span>
                </button>
                <button className="quick-start-card" onClick={() => handleQuickAction('Let\'s analyze the data files in this folder together. We\'ll summarize the key findings and create a report.')} title="Work through spreadsheets or data files">
                  <span className="quick-start-icon">📊</span>
                  <span className="quick-start-title">Analyze data</span>
                  <span className="quick-start-desc">Work through spreadsheets or data files</span>
                </button>
                <button className="quick-start-card" onClick={() => handleQuickAction('Let\'s generate documentation for this project together. We can create a README, API docs, or code comments as needed.')} title="Build documentation for the project">
                  <span className="quick-start-icon">📖</span>
                  <span className="quick-start-title">Generate docs</span>
                  <span className="quick-start-desc">Build documentation for the project</span>
                </button>
                <button className="quick-start-card" onClick={() => handleQuickAction('Let\'s research and summarize information from the files in this folder together.')} title="Dig through files and find insights">
                  <span className="quick-start-icon">🔍</span>
                  <span className="quick-start-title">Research together</span>
                  <span className="quick-start-desc">Dig through files and find insights</span>
                </button>
                <button className="quick-start-card" onClick={() => handleQuickAction('Let\'s prepare for a meeting together. We\'ll create an agenda, talking points, and organize materials needed.')} title="Get everything ready for a clean meeting">
                  <span className="quick-start-icon">📋</span>
                  <span className="quick-start-title">Meeting prep</span>
                  <span className="quick-start-desc">Get everything ready for a clean meeting</span>
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
                  placeholder="What should we work on together?"
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
                  <div className="workspace-dropdown-container" ref={workspaceDropdownRef}>
                    <button className="folder-selector" onClick={handleWorkspaceDropdownToggle}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                      </svg>
                      <span>{workspace?.id === TEMP_WORKSPACE_ID ? 'Work in a folder' : (workspace?.name || 'Work in a folder')}</span>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className={showWorkspaceDropdown ? 'chevron-up' : ''}>
                        <path d="M6 9l6 6 6-6" />
                      </svg>
                    </button>
                    {showWorkspaceDropdown && (
                      <div className="workspace-dropdown">
                        {workspacesList.length > 0 && (
                          <>
                            <div className="workspace-dropdown-header">Recent Folders</div>
                            <div className="workspace-dropdown-list">
                              {workspacesList.slice(0, 5).map((w) => (
                                <button
                                  key={w.id}
                                  className={`workspace-dropdown-item ${workspace?.id === w.id ? 'active' : ''}`}
                                  onClick={() => handleWorkspaceSelect(w)}
                                >
                                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                                  </svg>
                                  <div className="workspace-item-info">
                                    <span className="workspace-item-name">{w.name}</span>
                                    <span className="workspace-item-path">{w.path}</span>
                                  </div>
                                  {workspace?.id === w.id && (
                                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="check-icon">
                                      <path d="M20 6L9 17l-5-5" />
                                    </svg>
                                  )}
                                </button>
                              ))}
                            </div>
                            <div className="workspace-dropdown-divider" />
                          </>
                        )}
                        <button className="workspace-dropdown-item new-folder" onClick={handleSelectNewFolder}>
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <path d="M12 5v14M5 12h14" />
                          </svg>
                          <span>Work in another folder...</span>
                        </button>
                      </div>
                    )}
                  </div>
                  <button
                    className={`shell-toggle ${shellEnabled ? 'enabled' : ''}`}
                    onClick={handleShellToggle}
                    title={shellEnabled ? 'Shell commands enabled - click to disable' : 'Shell commands disabled - click to enable'}
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M4 17l6-6-6-6M12 19h8" />
                    </svg>
                    <span>Shell {shellEnabled ? 'ON' : 'OFF'}</span>
                  </button>
                </div>
                <div className="input-right-actions">
                  <ModelDropdown
                    models={availableModels}
                    selectedModel={selectedModel}
                    onModelChange={onModelChange}
                  />
                  {/* Skills Menu Button */}
                  <div className="skills-menu-container" ref={skillsMenuRef}>
                    <button
                      className={`skills-menu-btn ${showSkillsMenu ? 'active' : ''}`}
                      onClick={() => setShowSkillsMenu(!showSkillsMenu)}
                      title="Custom Skills"
                    >
                      <span>/</span>
                    </button>
                    {showSkillsMenu && (
                      <div className="skills-dropdown">
                        <div className="skills-dropdown-header">Custom Skills</div>
                        <div className="skills-dropdown-search">
                          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                            <circle cx="11" cy="11" r="8" />
                            <path d="M21 21l-4.35-4.35" />
                          </svg>
                          <input
                            type="text"
                            placeholder="Search skills..."
                            value={skillsSearchQuery}
                            onChange={(e) => setSkillsSearchQuery(e.target.value)}
                            autoFocus
                          />
                        </div>
                        {customSkills.length > 0 ? (
                          filteredSkills.length > 0 ? (
                            <div className="skills-dropdown-list">
                              {filteredSkills.map(skill => (
                                <div
                                  key={skill.id}
                                  className="skills-dropdown-item"
                                  style={{ cursor: 'pointer' }}
                                  onClick={() => handleSkillSelect(skill)}
                                >
                                  <span className="skills-dropdown-icon">{skill.icon}</span>
                                  <div className="skills-dropdown-info">
                                    <span className="skills-dropdown-name">{skill.name}</span>
                                    <span className="skills-dropdown-desc">{skill.description}</span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="skills-dropdown-empty">
                              No skills match "{skillsSearchQuery}"
                            </div>
                          )
                        ) : (
                          <div className="skills-dropdown-empty">
                            No custom skills yet.
                          </div>
                        )}
                        <div className="skills-dropdown-footer">
                          <button
                            className="skills-dropdown-create"
                            onClick={() => {
                              setShowSkillsMenu(false);
                              setSkillsSearchQuery('');
                              onOpenSettings?.('skills');
                            }}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <line x1="12" y1="5" x2="12" y2="19" />
                              <line x1="5" y1="12" x2="19" y2="12" />
                            </svg>
                            <span>Create New Skill</span>
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  <button
                    className="lets-go-btn lets-go-btn-sm"
                    onClick={handleSend}
                    disabled={!inputValue.trim()}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M12 19V5M5 12l7-7 7 7" />
                    </svg>
                  </button>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Modal for skills with parameters - Welcome View */}
        {selectedSkillForParams && (
          <SkillParameterModal
            skill={selectedSkillForParams}
            onSubmit={handleSkillParamSubmit}
            onCancel={handleSkillParamCancel}
          />
        )}

        {/* File Viewer Modal - Welcome View */}
        {viewerFilePath && workspace?.path && (
          <FileViewer
            filePath={viewerFilePath}
            workspacePath={workspace.path}
            onClose={() => setViewerFilePath(null)}
          />
        )}
      </div>
    );
  }

  const trimmedPrompt = task.prompt.trim();
  const baseTitle = task.title || buildTaskTitle(trimmedPrompt);
  const normalizedTitle = baseTitle.replace(TITLE_ELLIPSIS_REGEX, '');
  const titleMatchesPrompt = normalizedTitle.length > 0 && trimmedPrompt.startsWith(normalizedTitle);
  const isTitleTruncated = titleMatchesPrompt && trimmedPrompt.length > normalizedTitle.length;
  const headerTitle = isTitleTruncated && !TITLE_ELLIPSIS_REGEX.test(baseTitle)
    ? `${baseTitle}...`
    : baseTitle;
  const headerTooltip = isTitleTruncated ? trimmedPrompt : baseTitle;

  // Task view
  return (
    <div className="main-content">
      {/* Header */}
      <div className="main-header">
        <div className="main-header-title" title={headerTooltip}>{headerTitle}</div>
      </div>

      {/* Body */}
      <div className="main-body" ref={mainBodyRef} onScroll={handleScroll}>
        <div className="task-content">
          {/* User Prompt - Right aligned like chat */}
          <div className="chat-message user-message">
            <div className="chat-bubble user-bubble markdown-content">
              <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                {task.prompt}
              </ReactMarkdown>
            </div>
            <MessageCopyButton text={task.prompt} />
          </div>

          {/* View steps toggle - show right after original prompt */}
          {events.some(e => e.type !== 'user_message' && e.type !== 'assistant_message') && (
            <div className="timeline-controls">
              <button
                className={`view-steps-btn ${showSteps ? 'expanded' : ''}`}
                onClick={() => setShowSteps(!showSteps)}
              >
                {showSteps ? 'Hide steps' : 'View steps'}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
              {showSteps && (
                <button
                  className={`verbose-toggle-btn ${verboseSteps ? 'active' : ''}`}
                  onClick={toggleVerboseSteps}
                  title={verboseSteps ? 'Show important steps only' : 'Show all steps (verbose)'}
                >
                  {verboseSteps ? 'Verbose' : 'Summary'}
                </button>
              )}
            </div>
          )}

          {/* Conversation Flow - renders all events in order */}
          {events.length > 0 && (
            <div className="conversation-flow" ref={timelineRef}>
              {/* Render CommandOutput at beginning if it should appear before all events */}
              {activeCommand && commandOutputInsertIndex === -1 && (
                <CommandOutput
                  command={activeCommand.command}
                  output={activeCommand.output}
                  isRunning={activeCommand.isRunning}
                  exitCode={activeCommand.exitCode}
                  taskId={task?.id}
                  onClose={handleDismissCommandOutput}
                />
              )}
              {filteredEvents.map((event, index) => {
                const isUserMessage = event.type === 'user_message';
                const isAssistantMessage = event.type === 'assistant_message';
                // Check if CommandOutput should be rendered after this event
                const shouldRenderCommandOutput = activeCommand && index === commandOutputInsertIndex;

                // Render user messages as chat bubbles on the right
                if (isUserMessage) {
                  const messageText = event.payload?.message || 'User message';
                  return (
                    <Fragment key={event.id || `event-${index}`}>
                      <div className="chat-message user-message">
                        <div className="chat-bubble user-bubble markdown-content">
                          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                            {messageText}
                          </ReactMarkdown>
                        </div>
                        <MessageCopyButton text={messageText} />
                      </div>
                      {shouldRenderCommandOutput && (
                        <CommandOutput
                          command={activeCommand.command}
                          output={activeCommand.output}
                          isRunning={activeCommand.isRunning}
                          exitCode={activeCommand.exitCode}
                          taskId={task?.id}
                          onClose={handleDismissCommandOutput}
                        />
                      )}
                    </Fragment>
                  );
                }

                // Render assistant messages as chat bubbles on the left
                if (isAssistantMessage) {
                  const messageText = event.payload?.message || '';
                  const isLastAssistant = event === lastAssistantMessage;
                  return (
                    <Fragment key={event.id || `event-${index}`}>
                      <div className="chat-message assistant-message">
                        <div className="chat-bubble assistant-bubble">
                          {isLastAssistant && (
                            <div className="chat-bubble-header">
                              {task.status === 'completed' && <span className="chat-status">✅ All done!</span>}
                              {task.status === 'executing' && (
                                <span className="chat-status executing">
                                  <svg className="spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                                  </svg>
                                  Working on it...
                                </span>
                              )}
                            </div>
                          )}
                          <div className="chat-bubble-content markdown-content">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                              {messageText}
                            </ReactMarkdown>
                          </div>
                        </div>
                        <MessageCopyButton text={messageText} />
                      </div>
                      {shouldRenderCommandOutput && (
                        <CommandOutput
                          command={activeCommand.command}
                          output={activeCommand.output}
                          isRunning={activeCommand.isRunning}
                          exitCode={activeCommand.exitCode}
                          taskId={task?.id}
                          onClose={handleDismissCommandOutput}
                        />
                      )}
                    </Fragment>
                  );
                }

                // Technical events - only show when showSteps is true
                if (!showSteps) {
                  // Even if we're not showing steps, we may still need to render CommandOutput here
                  if (shouldRenderCommandOutput) {
                    return (
                      <Fragment key={event.id || `event-${index}`}>
                        <CommandOutput
                          command={activeCommand.command}
                          output={activeCommand.output}
                          isRunning={activeCommand.isRunning}
                          exitCode={activeCommand.exitCode}
                          taskId={task?.id}
                          onClose={handleDismissCommandOutput}
                        />
                      </Fragment>
                    );
                  }
                  return null;
                }

                const isExpandable = hasEventDetails(event);
                const isExpanded = isEventExpanded(event);

                return (
                  <Fragment key={event.id || `event-${index}`}>
                    <div className="timeline-event">
                      <div className="event-indicator">
                        <div className={`event-dot ${getEventDotClass(event.type)}`} />
                      </div>
                      <div className="event-content">
                        <div
                          className={`event-header ${isExpandable ? 'expandable' : ''} ${isExpanded ? 'expanded' : ''}`}
                          onClick={isExpandable ? () => toggleEventExpanded(event.id) : undefined}
                        >
                          <div className="event-header-left">
                            {isExpandable && (
                              <svg className="event-expand-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                <path d="M9 18l6-6-6-6" />
                              </svg>
                            )}
                            <div className="event-title">{renderEventTitle(event, workspace?.path, setViewerFilePath)}</div>
                          </div>
                          <div className="event-time">{formatTime(event.timestamp)}</div>
                        </div>
                        {isExpanded && renderEventDetails(event)}
                      </div>
                    </div>
                    {shouldRenderCommandOutput && (
                      <CommandOutput
                        command={activeCommand.command}
                        output={activeCommand.output}
                        isRunning={activeCommand.isRunning}
                        exitCode={activeCommand.exitCode}
                        taskId={task?.id}
                        onClose={handleDismissCommandOutput}
                      />
                    )}
                  </Fragment>
                );
              })}
            </div>
          )}

          {/* Live Canvas Previews - shown when canvas sessions are active */}
          {canvasSessions.length > 0 && (
            <div className="canvas-previews-container">
              {canvasSessions.map(session => (
                <CanvasPreview
                  key={session.id}
                  session={session}
                  onClose={() => handleCanvasClose(session.id)}
                />
              ))}
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
              placeholder={queuedMessage ? "Message queued..." : "What's next?"}
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
                  className="stop-btn-simple"
                  onClick={onStopTask}
                  title="Stop task"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          <div className="input-below-actions">
            <button
              className={`shell-toggle ${shellEnabled ? 'enabled' : ''}`}
              onClick={handleShellToggle}
              title={shellEnabled ? 'Shell commands enabled - click to disable' : 'Shell commands disabled - click to enable'}
            >
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M4 17l6-6-6-6M12 19h8" />
              </svg>
              <span>Shell {shellEnabled ? 'ON' : 'OFF'}</span>
            </button>
          </div>
        </div>
        <div className="footer-disclaimer">
          AI can make mistakes. Please double-check responses.
        </div>
      </div>

      {pendingApproval && (
        <ApprovalDialog
          approval={pendingApproval}
          onApprove={() => handleApprovalResponse(true)}
          onDeny={() => handleApprovalResponse(false)}
        />
      )}

      {selectedSkillForParams && (
        <SkillParameterModal
          skill={selectedSkillForParams}
          onSubmit={handleSkillParamSubmit}
          onCancel={handleSkillParamCancel}
        />
      )}

      {/* File Viewer Modal - Task View */}
      {viewerFilePath && workspace?.path && (
        <FileViewer
          filePath={viewerFilePath}
          workspacePath={workspace.path}
          onClose={() => setViewerFilePath(null)}
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

function renderEventTitle(
  event: TaskEvent,
  workspacePath?: string,
  onOpenViewer?: (path: string) => void
): React.ReactNode {
  switch (event.type) {
    case 'task_created':
      return 'Session started';
    case 'task_completed':
      return '✓ All done!';
    case 'plan_created':
      return 'Here\'s our approach';
    case 'step_started':
      return `Working on: ${event.payload.step?.description || 'Getting started...'}`;
    case 'step_completed':
      return `✓ ${event.payload.step?.description || event.payload.message || 'Done'}`;
    case 'tool_call':
      return `Using: ${event.payload.tool}`;
    case 'tool_result': {
      const result = event.payload.result;
      const success = result?.success !== false && !result?.error;
      const status = success ? 'done' : 'issue';

      // Extract useful info from result to show inline
      let detail = '';
      if (result) {
        if (!success && result.error) {
          // Show error message for failed tools
          const errorMsg = typeof result.error === 'string' ? result.error : 'Unknown error';
          detail = `: ${errorMsg.slice(0, 60)}${errorMsg.length > 60 ? '...' : ''}`;
        } else if (result.path) {
          detail = ` → ${result.path}`;
        } else if (result.content && typeof result.content === 'string') {
          const lines = result.content.split('\n').length;
          detail = ` → ${lines} lines`;
        } else if (result.size !== undefined) {
          detail = ` → ${result.size} bytes`;
        } else if (result.files) {
          detail = ` → ${result.files.length} items`;
        } else if (result.matches) {
          detail = ` → ${result.matches.length} matches`;
        } else if (result.exitCode !== undefined) {
          detail = result.exitCode === 0 ? '' : ` → exit ${result.exitCode}`;
        }
      }
      return `${event.payload.tool} ${status}${detail}`;
    }
    case 'assistant_message':
      return 'CoWork';
    case 'file_created':
      return (
        <span>
          Created: <ClickableFilePath path={event.payload.path} workspacePath={workspacePath} onOpenViewer={onOpenViewer} />
        </span>
      );
    case 'file_modified':
      return (
        <span>
          Updated: <ClickableFilePath path={event.payload.path || event.payload.from} workspacePath={workspacePath} onOpenViewer={onOpenViewer} />
        </span>
      );
    case 'file_deleted':
      return `Removed: ${event.payload.path}`;
    case 'error':
      return 'Hit a snag';
    case 'approval_requested':
      return `Need your input: ${event.payload.approval?.description}`;
    case 'log':
      return event.payload.message;
    // Goal Mode verification events
    case 'verification_started':
      return 'Checking our work...';
    case 'verification_passed':
      return `Verified! (attempt ${event.payload.attempt})`;
    case 'verification_failed':
      return `Not quite right (attempt ${event.payload.attempt}/${event.payload.maxAttempts})`;
    case 'retry_started':
      return `Let's try again (attempt ${event.payload.attempt}/${event.payload.maxAttempts})`;
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
        <div className="event-details assistant-message event-details-scrollable">
          <div className="markdown-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {event.payload.message}
            </ReactMarkdown>
          </div>
          <MessageCopyButton text={event.payload.message} />
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
