import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Task, TaskEvent, Workspace, ApprovalRequest, LLMModelInfo, SuccessCriteria, CustomSkill, EventType } from '../../shared/types';

// localStorage key for verbose mode
const VERBOSE_STEPS_KEY = 'cowork:verboseSteps';

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
import { ApprovalDialog } from './ApprovalDialog';
import { SkillParameterModal } from './SkillParameterModal';
import { FileViewer } from './FileViewer';

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
  workspace: Workspace | null;
  events: TaskEvent[];
  onSendMessage: (message: string) => void;
  onCreateTask?: (title: string, prompt: string, options?: GoalModeOptions) => void;
  onChangeWorkspace?: () => void;
  onOpenSettings?: (tab?: SettingsTab) => void;
  onStopTask?: () => void;
  selectedModel: string;
  availableModels: LLMModelInfo[];
  onModelChange: (model: string) => void;
}

export function MainContent({ task, workspace, events, onSendMessage, onCreateTask, onChangeWorkspace, onOpenSettings, onStopTask, selectedModel, availableModels, onModelChange }: MainContentProps) {
  const [pendingApproval, setPendingApproval] = useState<ApprovalRequest | null>(null);
  const [inputValue, setInputValue] = useState('');
  // Shell permission state - tracks current workspace's shell permission
  const [shellEnabled, setShellEnabled] = useState(workspace?.permissions?.shell ?? false);
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
  const [selectedSkillForParams, setSelectedSkillForParams] = useState<CustomSkill | null>(null);
  const [viewerFilePath, setViewerFilePath] = useState<string | null>(null);
  // Verbose mode - when false, only show important steps
  const [verboseSteps, setVerboseSteps] = useState(() => {
    const saved = localStorage.getItem(VERBOSE_STEPS_KEY);
    return saved === 'true';
  });
  const skillsMenuRef = useRef<HTMLDivElement>(null);

  // Filter events based on verbose mode
  const filteredEvents = useMemo(() => {
    if (verboseSteps) {
      return events;
    }
    return events.filter(isImportantEvent);
  }, [events, verboseSteps]);

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
      }
    };
    if (showSkillsMenu) {
      document.addEventListener('mousedown', handleClickOutside);
    }
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [showSkillsMenu]);

  const handleSkillSelect = (skill: CustomSkill) => {
    setShowSkillsMenu(false);
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
      const title = expandedPrompt.trim().slice(0, 50);
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
              <img src="./cowork-oss-logo.png" alt="CoWork-OSS" className="welcome-logo-img" />
            </div>

            {/* ASCII Terminal Header */}
            <div className="cli-header">
              <pre className="ascii-art">{`
  ██████╗ ██████╗ ██╗    ██╗ ██████╗ ██████╗ ██╗  ██╗       ██████╗ ███████╗███████╗
 ██╔════╝██╔═══██╗██║    ██║██╔═══██╗██╔══██╗██║ ██╔╝      ██╔═══██╗██╔════╝██╔════╝
 ██║     ██║   ██║██║ █╗ ██║██║   ██║██████╔╝█████╔╝ █████╗██║   ██║███████╗███████╗
 ██║     ██║   ██║██║███╗██║██║   ██║██╔══██╗██╔═██╗ ╚════╝██║   ██║╚════██║╚════██║
 ╚██████╗╚██████╔╝╚███╔███╔╝╚██████╔╝██║  ██║██║  ██╗      ╚██████╔╝███████║███████║
  ╚═════╝ ╚═════╝  ╚══╝╚══╝  ╚═════╝ ╚═╝  ╚═╝╚═╝  ╚═╝       ╚═════╝ ╚══════╝╚══════╝`}</pre>
              <div className="cli-version">{appVersion ? `v${appVersion}` : ''}</div>
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

            {/* Quick Start */}
            <div className="cli-commands">
              <div className="cli-commands-header">
                <span className="cli-prompt">&gt;</span>
                <span>QUICK START</span>
              </div>
              <div className="quick-start-grid">
                <button className="quick-start-card" onClick={() => handleQuickAction('Help me organize the files in this folder. Sort them by type and rename them with clear, consistent names.')}>
                  <span className="quick-start-icon">📁</span>
                  <span className="quick-start-title">Organize files</span>
                  <span className="quick-start-desc">Sort and rename files in the workspace</span>
                </button>
                <button className="quick-start-card" onClick={() => handleQuickAction('Help me write a document. I\'ll describe what I need and you can create it for me.')}>
                  <span className="quick-start-icon">📝</span>
                  <span className="quick-start-title">Write a document</span>
                  <span className="quick-start-desc">Create reports, summaries, or notes</span>
                </button>
                <button className="quick-start-card" onClick={() => handleQuickAction('Help me analyze the data files in this folder. Summarize the key findings and create a report.')}>
                  <span className="quick-start-icon">📊</span>
                  <span className="quick-start-title">Analyze data</span>
                  <span className="quick-start-desc">Process spreadsheets or data files</span>
                </button>
                <button className="quick-start-card" onClick={() => handleQuickAction('Generate documentation for this project. Create a README, API docs, or code comments as needed.')}>
                  <span className="quick-start-icon">📖</span>
                  <span className="quick-start-title">Generate docs</span>
                  <span className="quick-start-desc">Create documentation for the project</span>
                </button>
                <button className="quick-start-card" onClick={() => handleQuickAction('Help me research and summarize information from the files in this folder.')}>
                  <span className="quick-start-icon">🔍</span>
                  <span className="quick-start-title">Research & summarize</span>
                  <span className="quick-start-desc">Gather info from multiple files</span>
                </button>
                <button className="quick-start-card" onClick={() => handleQuickAction('Help me prepare for a meeting. Create an agenda, talking points, gather relevant documents, and organize materials needed to run a clean meeting.')}>
                  <span className="quick-start-icon">📋</span>
                  <span className="quick-start-title">Meeting Preparation</span>
                  <span className="quick-start-desc">Prepare everything needed to run a clean meeting</span>
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
                        {customSkills.length > 0 ? (
                          <div className="skills-dropdown-list">
                            {customSkills.map(skill => (
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
                            No custom skills yet.
                          </div>
                        )}
                        <div className="skills-dropdown-footer">
                          <button
                            className="skills-dropdown-create"
                            onClick={() => {
                              setShowSkillsMenu(false);
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

  // Task view
  return (
    <div className="main-content">
      {/* Header */}
      <div className="main-header">
        <div className="main-header-title">{task.title}</div>
      </div>

      {/* Body */}
      <div className="main-body" ref={mainBodyRef} onScroll={handleScroll}>
        <div className="task-content">
          {/* User Prompt - Right aligned like chat */}
          <div className="chat-message user-message">
            <div className="chat-bubble user-bubble">
              <p>{task.prompt}</p>
            </div>
          </div>

          {/* Timeline (View steps) */}
          {events.length > 0 && (
            <div className="timeline-section">
              <div className="timeline-controls">
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
                  <button
                    className={`verbose-toggle-btn ${verboseSteps ? 'active' : ''}`}
                    onClick={toggleVerboseSteps}
                    title={verboseSteps ? 'Show important steps only' : 'Show all steps (verbose)'}
                  >
                    {verboseSteps ? 'Verbose' : 'Summary'}
                  </button>
                )}
              </div>

              {showSteps && (
                <div className="timeline-events" ref={timelineRef}>
                  {filteredEvents.map((event, index) => {
                    const isExpandable = hasEventDetails(event);
                    const isExpanded = isEventExpanded(event);
                    const isUserMessage = event.type === 'user_message';

                    // Render user messages as chat bubbles on the right (same style as original prompt)
                    if (isUserMessage) {
                      return (
                        <div key={event.id || `event-${index}`} className="chat-message user-message">
                          <div className="chat-bubble user-bubble">
                            <p>{event.payload?.message || 'User message'}</p>
                          </div>
                        </div>
                      );
                    }

                    return (
                      <div key={event.id || `event-${index}`} className="timeline-event">
                        <div className="event-indicator">
                          <div className={`event-dot ${getEventDotClass(event.type)}`} />
                          {index < filteredEvents.length - 1 && <div className="event-line" />}
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
                    );
                  })}
                </div>
              )}
            </div>
          )}

          {/* Assistant response - Always visible below steps */}
          {lastAssistantMessage && (
            <div className="chat-message assistant-message">
              <div className="chat-bubble assistant-bubble">
                <div className="chat-bubble-header">
                  {task.status === 'completed' && <span className="chat-status">✅ Task Done!</span>}
                  {task.status === 'executing' && <span className="chat-status executing">⏳ Working...</span>}
                </div>
                <div className="chat-bubble-content markdown-content">
                  <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                    {lastAssistantMessage.payload.message}
                  </ReactMarkdown>
                </div>
              </div>
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
      return 'Task created';
    case 'task_completed':
      return '✓ Task completed successfully';
    case 'plan_created':
      return 'Execution plan created';
    case 'step_started':
      return `Step: ${event.payload.step?.description || 'Starting...'}`;
    case 'step_completed':
      return `✓ ${event.payload.step?.description || event.payload.message || 'Step done'}`;
    case 'tool_call':
      return `Tool: ${event.payload.tool}`;
    case 'tool_result': {
      const result = event.payload.result;
      const success = result?.success !== false && !result?.error;
      const status = success ? 'succeeded' : 'failed';

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
      return 'Assistant';
    case 'file_created':
      return (
        <span>
          Created: <ClickableFilePath path={event.payload.path} workspacePath={workspacePath} onOpenViewer={onOpenViewer} />
        </span>
      );
    case 'file_modified':
      return (
        <span>
          Modified: <ClickableFilePath path={event.payload.path || event.payload.from} workspacePath={workspacePath} onOpenViewer={onOpenViewer} />
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
          <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
            {event.payload.message}
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
