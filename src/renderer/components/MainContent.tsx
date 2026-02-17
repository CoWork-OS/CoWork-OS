import { useState, useEffect, useRef, useCallback, useMemo, Fragment, Children } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import remarkBreaks from 'remark-breaks';
import { Task, TaskEvent, Workspace, LLMModelInfo, CustomSkill, EventType, DEFAULT_QUIRKS, CanvasSession, isTempWorkspaceId } from '../../shared/types';
import { isVerificationStepDescription } from '../../shared/plan-utils';
import type { AgentRoleData } from '../../electron/preload';
import { useVoiceInput } from '../hooks/useVoiceInput';
import { useVoiceTalkMode } from '../hooks/useVoiceTalkMode';
import { useAgentContext, type AgentContext } from '../hooks/useAgentContext';
import { getMessage } from '../utils/agentMessages';
import {
  ATTACHMENT_CONTENT_END_MARKER,
  ATTACHMENT_CONTENT_START_MARKER,
  MAX_IMAGE_OCR_CHARS,
  buildImageAttachmentViewerOptions,
  extractAttachmentNames,
  stripHtmlForText,
  stripPptxBubbleContent,
  truncateTextForTaskPrompt,
} from './utils/attachment-content';

// localStorage key for verbose mode
const VERBOSE_STEPS_KEY = 'cowork:verboseSteps';
const CODE_PREVIEWS_EXPANDED_KEY = 'cowork:codePreviewsExpanded';
const TASK_TITLE_MAX_LENGTH = 50;
const TITLE_ELLIPSIS_REGEX = /(\.\.\.|\u2026)$/u;
const MAX_ATTACHMENTS = 10;
const ACTIVE_WORK_SIGNAL_WINDOW_MS = 30_000;
const ACTIVE_WORK_EVENT_TYPES: EventType[] = [
  'executing',
  'step_started',
  'step_completed',
  'tool_call',
  'tool_result',
  'verification_started',
  'retry_started',
];

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
// Note: We intentionally hide most tool traffic in Summary mode, but some tools
// produce user-facing output (e.g. scheduling) that should remain visible.
const isImportantEvent = (event: TaskEvent): boolean => {
  if (IMPORTANT_EVENT_TYPES.includes(event.type)) return true;

  // Keep schedule confirmation visible even in Summary mode so users can see
  // what was created (name/schedule/next run via event title/details).
  if (event.type === 'tool_result') {
    const tool = String((event as any)?.payload?.tool || '');
    if (tool === 'schedule_task') return true;
  }

  return false;
};

// In non-verbose mode, hide verification noise (verification steps are still executed by the agent).
const isVerificationNoiseEvent = (event: TaskEvent): boolean => {
  if (event.type === 'assistant_message') {
    return event.payload?.internal === true;
  }

  if (event.type === 'step_started' || event.type === 'step_completed') {
    return isVerificationStepDescription(event.payload?.step?.description);
  }

  // Verification events are shown on failure; success is kept quiet.
  if (event.type === 'verification_started' || event.type === 'verification_passed') {
    return true;
  }

  return false;
};

const buildTaskTitle = (text: string): string => {
  const trimmed = text.trim();
  if (trimmed.length <= TASK_TITLE_MAX_LENGTH) {
    return trimmed;
  }
  return `${trimmed.slice(0, TASK_TITLE_MAX_LENGTH)}...`;
};

type SelectedFileInfo = {
  path?: string;
  name: string;
  size: number;
  mimeType?: string;
};

type PendingAttachment = SelectedFileInfo & {
  id: string;
  dataBase64?: string;
};

type ImportedAttachment = {
  relativePath: string;
  fileName: string;
  size: number;
  mimeType?: string;
};

const formatFileSize = (size: number): string => {
  if (size < 1024) return `${size} B`;
  const kb = size / 1024;
  if (kb < 1024) return `${kb.toFixed(1)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(1)} MB`;
};


const composeMessageWithAttachments = async (
  workspacePath: string | undefined,
  text: string,
  attachments: ImportedAttachment[]
): Promise<{ message: string; extractionWarnings: string[] }> => {
  const extractedByPath: Record<string, string> = {};
  const extractionWarnings: string[] = [];

  if (workspacePath && attachments.length > 0) {
    for (const attachment of attachments) {
      try {
        const options = buildImageAttachmentViewerOptions(text, attachment.fileName);
        const result = await window.electronAPI.readFileForViewer(
          attachment.relativePath,
          workspacePath,
          {
            ...options,
            imageOcrMaxChars: MAX_IMAGE_OCR_CHARS,
          }
        );

        if (!result.success || !result.data) continue;

        const fileType = result.data.fileType;
        if (fileType === 'unsupported') continue;
        if (fileType === 'image' && !result.data.ocrText?.trim()) continue;

        let content = fileType === 'image'
          ? (result.data.ocrText ?? null)
          : result.data.content;
        if (!content && result.data.htmlContent) {
          content = stripHtmlForText(result.data.htmlContent);
        }
        if ((!content || !content.trim()) && result.data.ocrText?.trim()) {
          content = result.data.ocrText;
        }
        if (!content?.trim()) continue;

        extractedByPath[attachment.relativePath] = truncateTextForTaskPrompt(content);
      } catch {
        extractionWarnings.push(attachment.fileName);
        // Continue to next attachment on extraction errors.
      }
    }
  }

  const base = text.trim() || 'Please review the attached files.';
  const attachmentSummaryLines = attachments.map((attachment) => {
    const lines = [`- ${attachment.fileName} (${attachment.relativePath})`];
    const extracted = extractedByPath[attachment.relativePath];
    if (extracted) {
      lines.push('  Extracted content:');
      lines.push(`  ${ATTACHMENT_CONTENT_START_MARKER}`);
      for (const row of extracted.split('\n')) {
        lines.push(`    ${row}`);
      }
      lines.push(`  ${ATTACHMENT_CONTENT_END_MARKER}`);
    }
    return lines.join('\n');
  });

  const summary = attachmentSummaryLines.length === 0 ? '' : `Attached files (relative to workspace):\n${attachmentSummaryLines.join('\n\n')}`;
  return {
    message: summary ? `${base}\n\n${summary}` : base,
    extractionWarnings,
  };
};

type MentionOption = {
  type: 'agent' | 'everyone';
  id: string;
  label: string;
  description?: string;
  icon?: string;
  color?: string;
};

const normalizeMentionSearch = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, '');
import { SkillParameterModal } from './SkillParameterModal';
import { FileViewer } from './FileViewer';
import { ThemeIcon } from './ThemeIcon';
import { AlertTriangleIcon, BookIcon, ChartIcon, CheckIcon, ClipboardIcon, EditIcon, FolderIcon, InfoIcon, SearchIcon, UsersIcon, XIcon } from './LineIcons';
import { CommandOutput } from './CommandOutput';
import { CanvasPreview } from './CanvasPreview';
import { InlineImagePreview } from './InlineImagePreview';

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

// Collapsible user message bubble - limits height and expands on click
function CollapsibleUserBubble({ children }: { children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (contentRef.current) {
      setNeedsCollapse(contentRef.current.scrollHeight > 220);
    }
  }, [children]);

  const collapsed = needsCollapse && !expanded;

  return (
    <>
      <div
        ref={contentRef}
        className={`chat-bubble user-bubble markdown-content${!collapsed ? ' expanded' : ''}`}
        onClick={() => { if (collapsed) setExpanded(true); }}
      >
        {children}
        {collapsed && <div className="user-bubble-fade" />}
      </div>
      {needsCollapse && (
        <button className="user-bubble-expand-btn" onClick={() => setExpanded(!expanded)}>
          {collapsed ? 'Show more' : 'Show less'}
        </button>
      )}
    </>
  );
}

// Global audio state to ensure only one audio plays at a time
let currentAudioContext: AudioContext | null = null;
let currentAudioSource: AudioBufferSourceNode | null = null;
let currentSpeakingCallback: (() => void) | null = null;

function stopCurrentAudio() {
  if (currentAudioSource) {
    try {
      currentAudioSource.stop();
    } catch {
      // Already stopped
    }
    currentAudioSource = null;
  }
  if (currentAudioContext) {
    try {
      currentAudioContext.close();
    } catch {
      // Already closed
    }
    currentAudioContext = null;
  }
  if (currentSpeakingCallback) {
    currentSpeakingCallback();
    currentSpeakingCallback = null;
  }
}

// Speak button for assistant messages
function MessageSpeakButton({ text, voiceEnabled }: { text: string; voiceEnabled: boolean }) {
  const [speaking, setSpeaking] = useState(false);
  const [loading, setLoading] = useState(false);

  const handleClick = async () => {
    if (!voiceEnabled) return;

    // If already speaking, stop the audio
    if (speaking) {
      stopCurrentAudio();
      setSpeaking(false);
      return;
    }

    try {
      setLoading(true);
      // Strip markdown for cleaner speech
      const cleanText = text
        .replace(/```[\s\S]*?```/g, '') // Remove code blocks
        .replace(/`[^`]+`/g, '') // Remove inline code
        .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // Keep link text only
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, '') // Remove images
        .replace(/^#{1,6}\s+/gm, '') // Remove headers
        .replace(/\*\*([^*]+)\*\*/g, '$1') // Remove bold
        .replace(/\*([^*]+)\*/g, '$1') // Remove italic
        .replace(/\[\[speak\]\]([\s\S]*?)\[\[\/speak\]\]/gi, '$1') // Extract speak tags
        .trim();

      if (cleanText) {
        // Stop any currently playing audio first
        stopCurrentAudio();

        const result = await window.electronAPI.voiceSpeak(cleanText);
        if (result.success && result.audioData) {
          // Convert number array back to ArrayBuffer and play
          const audioBuffer = new Uint8Array(result.audioData).buffer;
          const audioContext = new AudioContext();
          const decodedAudio = await audioContext.decodeAudioData(audioBuffer);
          const source = audioContext.createBufferSource();
          source.buffer = decodedAudio;
          source.connect(audioContext.destination);

          // Store references for stopping
          currentAudioContext = audioContext;
          currentAudioSource = source;
          currentSpeakingCallback = () => setSpeaking(false);

          source.onended = () => {
            setSpeaking(false);
            currentAudioContext = null;
            currentAudioSource = null;
            currentSpeakingCallback = null;
            try {
              audioContext.close();
            } catch {
              // Already closed
            }
          };

          setLoading(false);
          setSpeaking(true);
          source.start(0);
          return;
        } else if (!result.success) {
          console.error('TTS failed:', result.error);
        }
      }
    } catch (err) {
      console.error('Failed to speak:', err);
    } finally {
      setLoading(false);
    }
  };

  if (!voiceEnabled) return null;

  return (
    <button
      className={`message-speak-btn ${speaking ? 'speaking' : ''}`}
      onClick={handleClick}
      title={speaking ? 'Stop speaking' : loading ? 'Loading...' : 'Speak message'}
      disabled={loading}
    >
      {speaking ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" strokeWidth="2">
          <rect x="4" y="4" width="16" height="16" rx="2" />
        </svg>
      ) : loading ? (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="spin">
          <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="12" />
        </svg>
      ) : (
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
      )}
      <span>{speaking ? 'Stop' : loading ? 'Loading' : 'Speak'}</span>
    </button>
  );
}

const HEADING_EMOJI_REGEX = /^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\uFE0F\uFE0E]?)(\s+)?/u;

const getHeadingIcon = (emoji: string): React.ReactNode | null => {
  switch (emoji) {
    case '✅':
      return <CheckIcon size={16} />;
    case '❌':
      return <XIcon size={16} />;
    case '⚠️':
    case '⚠':
      return <AlertTriangleIcon size={16} />;
    case 'ℹ️':
    case 'ℹ':
      return <InfoIcon size={16} />;
    default:
      return null;
  }
};

const renderHeading = (Tag: 'h1' | 'h2' | 'h3') => {
  return ({ children, ...props }: any) => {
    const nodes = Children.toArray(children);
    let emoji: string | null = null;
    if (typeof nodes[0] === 'string') {
      const match = (nodes[0] as string).match(HEADING_EMOJI_REGEX);
      if (match) {
        emoji = match[1];
        const nextIcon = getHeadingIcon(emoji);
        if (nextIcon) {
          nodes[0] = (nodes[0] as string).slice(match[0].length);
          return (
            <Tag {...props}>
              <span className="markdown-heading-icon"><ThemeIcon emoji={emoji} icon={nextIcon} /></span>
              {nodes}
            </Tag>
          );
        }
      }
    }
    const icon = emoji ? getHeadingIcon(emoji) : null;
    return (
      <Tag {...props}>
        {icon && emoji && <span className="markdown-heading-icon"><ThemeIcon emoji={emoji} icon={icon} /></span>}
        {nodes}
      </Tag>
    );
  };
};

const isExternalHttpLink = (href: string): boolean =>
  href.startsWith('http://') || href.startsWith('https://');

const FILE_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'pdf', 'doc', 'docx', 'xls', 'xlsx', 'csv', 'tsv', 'ppt', 'pptx',
  'json', 'yaml', 'yml', 'xml', 'html', 'htm',
  'js', 'ts', 'tsx', 'jsx', 'css', 'scss', 'less', 'sass',
  'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'cpp', 'c', 'h', 'hpp',
  'sh', 'bash', 'zsh', 'ps1', 'toml', 'ini', 'env', 'lock', 'log',
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp', 'tiff',
  'mp3', 'wav', 'm4a', 'mp4', 'mov', 'avi', 'mkv',
  'zip', 'tar', 'gz', 'tgz', 'rar', '7z',
]);

const getTextContent = (node: React.ReactNode): string => {
  if (typeof node === 'string') return node;
  if (Array.isArray(node)) return node.map(getTextContent).join('');
  if (node && typeof node === 'object' && 'props' in node) {
    return getTextContent((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return '';
};

const stripHttpScheme = (value: string): string =>
  value.replace(/^https?:\/\//, '');

const looksLikeLocalFilePath = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith('#')) return false;
  if (trimmed.startsWith('file://')) return true;
  if (trimmed.startsWith('mailto:') || trimmed.startsWith('tel:')) return false;
  if (trimmed.includes('://') || trimmed.startsWith('www.')) return false;
  if (trimmed.includes('@')) return false;
  if (trimmed.startsWith('./') || trimmed.startsWith('../') || trimmed.startsWith('~/') || trimmed.startsWith('/')) return true;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.includes('/') || trimmed.includes('\\')) return true;
  const extMatch = trimmed.match(/\.([a-zA-Z0-9]{1,8})$/);
  if (!extMatch) return false;
  return FILE_EXTENSIONS.has(extMatch[1].toLowerCase());
};

const isFileLink = (href: string): boolean => {
  if (!href) return false;
  if (href.startsWith('#')) return false;
  if (isExternalHttpLink(href)) return false;
  if (href.startsWith('mailto:') || href.startsWith('tel:')) return false;
  if (href.startsWith('file://')) return true;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return false;
  return true;
};

const normalizeFileHref = (href: string): string => {
  if (!href) return href;
  if (href.startsWith('file://')) {
    const rawPath = href.replace(/^file:\/\//, '');
    const decoded = (() => {
      try {
        return decodeURIComponent(rawPath);
      } catch {
        return rawPath;
      }
    })();
    return decoded.replace(/^\/([a-zA-Z]:\/)/, '$1').split(/[?#]/)[0];
  }
  return href.split(/[?#]/)[0];
};

const resolveFileLinkTarget = (href: string, linkText: string): string | null => {
  const trimmedText = linkText.trim();
  const trimmedHref = href.trim();

  if (looksLikeLocalFilePath(trimmedText)) {
    const strippedHref = stripHttpScheme(trimmedHref).replace(/\/$/, '');
    if (trimmedHref === trimmedText || strippedHref === trimmedText) {
      return normalizeFileHref(trimmedText);
    }
  }

  if (looksLikeLocalFilePath(trimmedHref)) {
    return normalizeFileHref(trimmedHref);
  }

  return null;
};

const buildMarkdownComponents = (options: {
  workspacePath?: string;
  onOpenViewer?: (path: string) => void;
}) => {
  const { workspacePath, onOpenViewer } = options;

  const MarkdownLink = ({ href, children, ...props }: any) => {
    if (!href) {
      return <a {...props}>{children}</a>;
    }

    const linkText = getTextContent(children);
    const fileTarget = resolveFileLinkTarget(href, linkText);

    if (fileTarget || isFileLink(href)) {
      const filePath = fileTarget ?? normalizeFileHref(href);
      const handleClick = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();

        if (onOpenViewer && workspacePath) {
          onOpenViewer(filePath);
          return;
        }

        if (!workspacePath) return;

        try {
          const error = await window.electronAPI.openFile(filePath, workspacePath);
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
        if (!workspacePath) return;
        try {
          await window.electronAPI.showInFinder(filePath, workspacePath);
        } catch (err) {
          console.error('Error showing in Finder:', err);
        }
      };

      return (
        <a
          {...props}
          href={href}
          className={`clickable-file-path ${props.className || ''}`.trim()}
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          title={`${filePath}\n\nClick to preview • Right-click to show in Finder`}
        >
          {children}
        </a>
      );
    }

    if (isExternalHttpLink(href)) {
      const handleClick = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        try {
          await window.electronAPI.openExternal(href);
        } catch (err) {
          console.error('Error opening link:', err);
        }
      };
      return (
        <a {...props} href={href} onClick={handleClick}>
          {children}
        </a>
      );
    }

    return (
      <a {...props} href={href}>
        {children}
      </a>
    );
  };

  // Custom components for ReactMarkdown
  return {
    code: CodeBlock,
    h1: renderHeading('h1'),
    h2: renderHeading('h2'),
    h3: renderHeading('h3'),
    a: MarkdownLink,
  };
};

const userMarkdownPlugins = [remarkGfm, remarkBreaks];

// Searchable Model Dropdown Component
interface ModelDropdownProps {
  models: LLMModelInfo[];
  selectedModel: string;
  onModelChange: (model: string) => void;
  onOpenSettings?: (tab?: SettingsTab) => void;
}

function ModelDropdown({ models, selectedModel, onModelChange, onOpenSettings }: ModelDropdownProps) {
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

  const handleOpenProviders = () => {
    setIsOpen(false);
    setSearch('');
    onOpenSettings?.('llm');
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
          <div className="model-dropdown-footer">
            <button type="button" className="model-dropdown-provider-btn" onClick={handleOpenProviders}>
              Change provider
            </button>
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

interface CreateTaskOptions {
  autonomousMode?: boolean;
}

type SettingsTab = 'appearance' | 'llm' | 'search' | 'telegram' | 'slack' | 'whatsapp' | 'teams' | 'x' | 'morechannels' | 'integrations' | 'updates' | 'guardrails' | 'queue' | 'skills' | 'voice';

interface MainContentProps {
  task: Task | undefined;
  selectedTaskId: string | null;  // Added to distinguish "no task" from "task not in list"
  workspace: Workspace | null;
  events: TaskEvent[];
  onSendMessage: (message: string) => void;
  onCreateTask?: (title: string, prompt: string, options?: CreateTaskOptions) => void;
  onChangeWorkspace?: () => void;
  onSelectWorkspace?: (workspace: Workspace) => void;
  onOpenSettings?: (tab?: SettingsTab) => void;
  onStopTask?: () => void;
  onOpenBrowserView?: (url?: string) => void;
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

export function MainContent({ task, selectedTaskId, workspace, events, onSendMessage, onCreateTask, onChangeWorkspace, onSelectWorkspace, onOpenSettings, onStopTask, onOpenBrowserView, selectedModel, availableModels, onModelChange }: MainContentProps) {
  // Agent personality context for personalized messages
  const agentContext = useAgentContext();
  const [inputValue, setInputValue] = useState('');
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const [isPreparingMessage, setIsPreparingMessage] = useState(false);
  const [agentRoles, setAgentRoles] = useState<AgentRoleData[]>([]);
  const [mentionQuery, setMentionQuery] = useState('');
  const [mentionTarget, setMentionTarget] = useState<{ start: number; end: number } | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
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
  // Autonomous mode state
  const [autonomousModeEnabled, setAutonomousModeEnabled] = useState(false);
  const [showSteps, setShowSteps] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  // Track toggled events by ID for stable state across filtering
  const [toggledEvents, setToggledEvents] = useState<Set<string>>(new Set());
  const [appVersion, setAppVersion] = useState<string>('');
  const [customSkills, setCustomSkills] = useState<CustomSkill[]>([]);
  const [showSkillsMenu, setShowSkillsMenu] = useState(false);
  const [skillsSearchQuery, setSkillsSearchQuery] = useState('');
  const [selectedSkillForParams, setSelectedSkillForParams] = useState<CustomSkill | null>(null);

  // Voice input hook
  const [showVoiceNotConfigured, setShowVoiceNotConfigured] = useState(false);
  const voiceInput = useVoiceInput({
    onTranscript: (text) => {
      // Append transcribed text to input
      setInputValue(prev => prev ? `${prev} ${text}` : text);
    },
    onError: (error) => {
      console.error('Voice input error:', error);
    },
    onNotConfigured: () => {
      setShowVoiceNotConfigured(true);
    },
  });

  // Talk Mode hook - continuous voice conversation
  const talkMode = useVoiceTalkMode({
    onSendMessage: (text) => {
      if (!selectedTaskId && onCreateTask) {
        const title = text.length > 60 ? text.slice(0, 57) + '...' : text;
        onCreateTask(title, text);
      } else {
        onSendMessage(text);
      }
    },
    onError: (error) => {
      console.error('Talk mode error:', error);
      setShowVoiceNotConfigured(true);
    },
  });
  const [viewerFilePath, setViewerFilePath] = useState<string | null>(null);
  const markdownComponents = useMemo(
    () => buildMarkdownComponents({ workspacePath: workspace?.path, onOpenViewer: setViewerFilePath }),
    [workspace?.path, setViewerFilePath]
  );
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
  // Code previews expanded by default (true = open, false = collapsed)
  const [codePreviewsExpanded, setCodePreviewsExpanded] = useState(() => {
    const saved = localStorage.getItem(CODE_PREVIEWS_EXPANDED_KEY);
    return saved !== 'false'; // default to true (expanded)
  });
  // Voice state - track if voice is enabled
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceResponseMode, setVoiceResponseMode] = useState<'auto' | 'manual' | 'smart'>('manual');
  const lastSpokenMessageRef = useRef<string | null>(null);
  const skillsMenuRef = useRef<HTMLDivElement>(null);
  const workspaceDropdownRef = useRef<HTMLDivElement>(null);

  // Filter events based on verbose mode
  const filteredEvents = useMemo(() => {
    const baseEvents = verboseSteps ? events : events.filter(isImportantEvent);
    // Command output is rendered separately via CommandOutput component
    const visibleEvents = baseEvents.filter(event => event.type !== 'command_output');
    // Always keep explicit verification steps silent; surface failures elsewhere.
    return visibleEvents.filter(event => !isVerificationNoiseEvent(event));
  }, [events, verboseSteps]);

  const latestUserMessageTimestamp = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (events[i].type === 'user_message') {
        return events[i].timestamp;
      }
    }
    return null;
  }, [events]);

  const isTaskWorking = useMemo(() => {
    if (!task) return false;
    if (task.status === 'executing') return true;
    if (task.status === 'paused' || task.status === 'blocked' || task.status === 'failed' || task.status === 'cancelled') {
      return false;
    }

    const now = Date.now();
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.taskId !== task.id) continue;

      if (
        event.type === 'task_paused' ||
        event.type === 'approval_requested' ||
        event.type === 'task_completed' ||
        event.type === 'task_cancelled' ||
        event.type === 'error'
      ) {
        return false;
      }

      const isActiveProgressSignal = event.type === 'progress_update' && (
        event.payload?.phase === 'tool_execution' ||
        event.payload?.state === 'active' ||
        event.payload?.heartbeat === true
      );
      if (ACTIVE_WORK_EVENT_TYPES.includes(event.type) || isActiveProgressSignal) {
        return now - event.timestamp <= ACTIVE_WORK_SIGNAL_WINDOW_MS;
      }
    }

    return false;
  }, [task, events]);

  const latestCanvasSessionId = useMemo(() => {
    if (canvasSessions.length === 0) return null;
    const eligibleSessions = latestUserMessageTimestamp
      ? canvasSessions.filter(session => session.createdAt >= latestUserMessageTimestamp)
      : canvasSessions;
    const pool = eligibleSessions.length > 0 ? eligibleSessions : canvasSessions;
    return pool.reduce((latest, session) => {
      return session.createdAt > latest.createdAt ? session : latest;
    }, pool[0]).id;
  }, [canvasSessions, latestUserMessageTimestamp]);

  const timelineItems = useMemo(() => {
    const eventItems = filteredEvents.map((event, index) => ({
      kind: 'event' as const,
      event,
      eventIndex: index,
      timestamp: event.timestamp,
    }));

    const freezeBefore = latestUserMessageTimestamp;
    const canvasItems = canvasSessions
      .map((session) => ({
        kind: 'canvas' as const,
        session,
        timestamp: session.createdAt,
        forceSnapshot: Boolean(
          (freezeBefore && session.createdAt < freezeBefore) ||
          (latestCanvasSessionId && session.id !== latestCanvasSessionId)
        ),
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    if (canvasItems.length === 0) return eventItems;

    const merged: Array<typeof eventItems[number] | typeof canvasItems[number]> = [];
    let canvasIndex = 0;

    for (const eventItem of eventItems) {
      while (canvasIndex < canvasItems.length && canvasItems[canvasIndex].timestamp <= eventItem.timestamp) {
        merged.push(canvasItems[canvasIndex]);
        canvasIndex += 1;
      }
      merged.push(eventItem);
    }

    while (canvasIndex < canvasItems.length) {
      merged.push(canvasItems[canvasIndex]);
      canvasIndex += 1;
    }

    return merged;
  }, [filteredEvents, canvasSessions, latestCanvasSessionId, latestUserMessageTimestamp]);

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

  const toggleCodePreviews = () => {
    setCodePreviewsExpanded(prev => {
      const newValue = !prev;
      localStorage.setItem(CODE_PREVIEWS_EXPANDED_KEY, String(newValue));
      return newValue;
    });
  };

  // Load app version
  useEffect(() => {
    window.electronAPI.getAppVersion()
      .then(info => setAppVersion(info.version))
      .catch(err => console.error('Failed to load version:', err));
  }, []);

  // Load voice settings
  useEffect(() => {
    window.electronAPI.getVoiceSettings()
      .then(settings => {
        setVoiceEnabled(settings.enabled);
        setVoiceResponseMode(settings.responseMode);
      })
      .catch(err => console.error('Failed to load voice settings:', err));

    // Subscribe to voice state changes
    const unsubscribe = window.electronAPI.onVoiceEvent((event) => {
      if (event.type === 'voice:state-changed' && typeof event.data === 'object' && 'isActive' in event.data) {
        setVoiceEnabled(event.data.isActive);
      }
    });

    return () => unsubscribe();
  }, []);

  // Auto-speak new assistant messages based on response mode
  useEffect(() => {
    if (!voiceEnabled || voiceResponseMode === 'manual') return;

    const assistantMessages = events.filter(e => e.type === 'assistant_message' && e.payload?.internal !== true);
    if (assistantMessages.length === 0) return;

    const lastMessage = assistantMessages[assistantMessages.length - 1];
    const messageText = lastMessage.payload?.message || '';

    // Skip if already spoken
    if (lastSpokenMessageRef.current === messageText) return;

    // Check if should speak based on mode
    const hasDirective = /\[\[speak\]\]/i.test(messageText);

    if (voiceResponseMode === 'auto' || (voiceResponseMode === 'smart' && hasDirective)) {
      // Extract text to speak
      let textToSpeak = messageText;

      // If smart mode, only speak content within [[speak]] tags
      if (voiceResponseMode === 'smart' && hasDirective) {
        const matches = messageText.match(/\[\[speak\]\]([\s\S]*?)\[\[\/speak\]\]/gi);
        if (matches) {
          textToSpeak = matches
            .map((m: string) => m.replace(/\[\[speak\]\]/gi, '').replace(/\[\[\/speak\]\]/gi, ''))
            .join(' ')
            .trim();
        }
      } else {
        // Strip markdown for cleaner speech
        textToSpeak = textToSpeak
          .replace(/```[\s\S]*?```/g, '')
          .replace(/`[^`]+`/g, '')
          .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')
          .replace(/!\[([^\]]*)\]\([^)]+\)/g, '')
          .replace(/^#{1,6}\s+/gm, '')
          .replace(/\*\*([^*]+)\*\*/g, '$1')
          .replace(/\*([^*]+)\*/g, '$1')
          .trim();
      }

      if (textToSpeak) {
        lastSpokenMessageRef.current = messageText;
        window.electronAPI.voiceSpeak(textToSpeak).catch(err => {
          console.error('Failed to auto-speak:', err);
        });
      }
    }
  }, [events, voiceEnabled, voiceResponseMode]);

  // Load custom skills (task skills only, excludes guidelines)
  useEffect(() => {
    window.electronAPI.listTaskSkills()
      .then(skills => setCustomSkills(skills.filter(s => s.enabled !== false)))
      .catch(err => console.error('Failed to load custom skills:', err));
  }, []);

  // Load active agent roles for @mention autocomplete
  useEffect(() => {
    window.electronAPI.getAgentRoles()
      .then((roles) => setAgentRoles(roles.filter((role) => role.isActive)))
      .catch(err => console.error('Failed to load agent roles:', err));
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
          const updatedSession = event.session;
          setCanvasSessions(prev => {
            const exists = prev.some(s => s.id === event.sessionId);
            if (!exists && updatedSession.status !== 'closed') {
              return [...prev, updatedSession];
            }
            return prev.map(s => s.id === event.sessionId ? updatedSession : s);
          });
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
      const updatedWorkspace = await window.electronAPI.updateWorkspacePermissions(workspace.id, { shell: newValue });
      if (updatedWorkspace) {
        setShellEnabled(updatedWorkspace?.permissions?.shell ?? newValue);
        onSelectWorkspace?.(updatedWorkspace);
        setWorkspacesList(prev => prev.map((item) => item.id === updatedWorkspace.id ? updatedWorkspace : item));
      }
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
        // Filter out temp workspace and sort by most recently used
        const filteredWorkspaces = workspaces
          .filter((w: Workspace) => !w.isTemp && !isTempWorkspaceId(w.id))
          .sort((a: Workspace, b: Workspace) =>
            (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt)
          );
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

  const isImageFileEvent = (event: TaskEvent): boolean => {
    if (event.type !== 'file_created' && event.type !== 'file_modified') return false;
    const filePath = String(event.payload?.path || event.payload?.from || '');
    const mimeType = typeof event.payload?.mimeType === 'string' ? event.payload.mimeType.toLowerCase() : '';
    const imageExt = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
    return (
      event.payload?.type === 'image' ||
      mimeType.startsWith('image/') ||
      imageExt.test(filePath)
    );
  };

  // Check if an event has details to show
  const hasEventDetails = (event: TaskEvent): boolean => {
    if (isImageFileEvent(event)) return true;
    if (event.type === 'file_created' && (event.payload?.contentPreview || event.payload?.copiedFrom)) return true;
    if (event.type === 'file_modified' && (event.payload?.oldPreview || event.payload?.action === 'rename')) return true;
    return ['plan_created', 'tool_call', 'tool_result', 'assistant_message', 'error', 'step_failed'].includes(event.type);
  };

  // Determine if an event should be expanded by default
  // Important events (plan, assistant responses, errors) should be expanded
  // Verbose events (tool calls/results) should be collapsed
  const shouldDefaultExpand = (event: TaskEvent): boolean => {
    if (isImageFileEvent(event)) return true;
    // Code previews: expand by default unless user opted for collapsed
    if (codePreviewsExpanded) {
      if (event.type === 'file_created' && (event.payload?.contentPreview || event.payload?.copiedFrom)) return true;
      if (event.type === 'file_modified' && (event.payload?.oldPreview || event.payload?.action === 'rename')) return true;
    }
    return ['plan_created', 'assistant_message', 'error', 'step_failed'].includes(event.type);
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
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mentionContainerRef = useRef<HTMLDivElement>(null);
  const mentionDropdownRef = useRef<HTMLDivElement>(null);
  const placeholderMeasureRef = useRef<HTMLSpanElement>(null);
  const [cursorLeft, setCursorLeft] = useState<number>(0);

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

  // Calculate cursor position based on placeholder text width
  const placeholder = agentContext.getPlaceholder();
  useEffect(() => {
    if (placeholderMeasureRef.current) {
      // Measure the placeholder text width
      const measureEl = placeholderMeasureRef.current;
      measureEl.textContent = placeholder;
      // Get the width and add offset for: padding (16px) + prompt (~$ = ~24px) + gap (10px)
      const padding = 16; // wrapper left padding
      const promptWidth = 24; // ~$ prompt width
      const gap = 10;
      const textWidth = measureEl.offsetWidth;
      setCursorLeft(padding + promptWidth + gap + textWidth);
    }
  }, [placeholder]);

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

  const reportAttachmentError = (message: string) => {
    setAttachmentError(message);
    window.setTimeout(() => setAttachmentError(null), 5000);
  };

  const readFileAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === 'string' ? reader.result : '';
        const [, base64] = result.split(',');
        if (!base64) {
          reject(new Error('Failed to read file data.'));
          return;
        }
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error || new Error('Failed to read file data.'));
      reader.readAsDataURL(file);
    });

  const appendPendingAttachments = (files: PendingAttachment[]) => {
    if (files.length === 0) return;
    setPendingAttachments((prev) => {
      const existingKeys = new Set(
        prev.map((attachment) => attachment.path || `${attachment.name}-${attachment.size}`)
      );
      const next = [...prev];
      for (const file of files) {
        const key = file.path || `${file.name}-${file.size}`;
        if (existingKeys.has(key)) continue;
        if (next.length >= MAX_ATTACHMENTS) {
          reportAttachmentError(`You can attach up to ${MAX_ATTACHMENTS} files.`);
          break;
        }
        next.push({
          ...file,
          id: file.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        });
        existingKeys.add(key);
      }
      return next;
    });
  };

  const handleAttachFiles = async () => {
    try {
      const files = await window.electronAPI.selectFiles();
      if (!files || files.length === 0) return;
      appendPendingAttachments(
        files.map((file) => ({
          ...file,
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        }))
      );
    } catch (error) {
      console.error('Failed to select files:', error);
      reportAttachmentError('Failed to add attachments. Please try again.');
    }
  };

  const handleRemoveAttachment = (id: string) => {
    setPendingAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  };

  const isFileDrag = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types || []).includes('Files');

  const handleDragOver = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setIsDraggingFiles(true);
  };

  const handleDragLeave = (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setIsDraggingFiles(false);
  };

  const handleDrop = async (event: React.DragEvent) => {
    if (!isFileDrag(event)) return;
    event.preventDefault();
    setIsDraggingFiles(false);

    const droppedFiles = Array.from(event.dataTransfer.files || []);
    try {
      const pending = await Promise.all(
        droppedFiles.map(async (file) => {
          const filePath = (file as File & { path?: string }).path;
          if (filePath) {
            return {
              id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
              path: filePath,
              name: file.name,
              size: file.size,
              mimeType: file.type || undefined,
            } satisfies PendingAttachment;
          }
          const dataBase64 = await readFileAsBase64(file);
          return {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || `drop-${Date.now()}`,
            size: file.size,
            mimeType: file.type || undefined,
            dataBase64,
          } satisfies PendingAttachment;
        })
      );

      appendPendingAttachments(pending);
    } catch (error) {
      console.error('Failed to handle dropped files:', error);
      reportAttachmentError('Failed to attach dropped files.');
    }
  };

  const handlePaste = async (event: React.ClipboardEvent) => {
    const clipboardData = event.clipboardData;
    let clipboardFiles = Array.from(clipboardData?.files || []);
    if (clipboardFiles.length === 0 && clipboardData?.items) {
      Array.from(clipboardData.items).forEach((item: DataTransferItem) => {
        if (item.kind === 'file') {
          const file = item.getAsFile();
          if (file) clipboardFiles.push(file);
        }
      });
    }
    if (clipboardFiles.length === 0) return;
    event.preventDefault();

    try {
      const pending = await Promise.all(
        clipboardFiles.map(async (file) => {
          const dataBase64 = await readFileAsBase64(file);
          return {
            id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: file.name || `paste-${Date.now()}`,
            size: file.size,
            mimeType: file.type || undefined,
            dataBase64,
          } satisfies PendingAttachment;
        })
      );

      appendPendingAttachments(pending);
    } catch (error) {
      console.error('Failed to handle pasted files:', error);
      reportAttachmentError('Failed to attach pasted files.');
    }
  };

  const renderAttachmentPanel = () => {
    if (pendingAttachments.length === 0 && !attachmentError) return null;
    return (
      <div className="attachment-panel">
        {attachmentError && <div className="attachment-error">{attachmentError}</div>}
        {pendingAttachments.length > 0 && (
          <div className="attachment-list">
            {pendingAttachments.map((attachment) => (
              <div className="attachment-chip" key={attachment.id}>
                <span className="attachment-icon">
                  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" />
                  </svg>
                </span>
                <span className="attachment-name" title={attachment.name}>{attachment.name}</span>
                <span className="attachment-size">{formatFileSize(attachment.size)}</span>
                <button
                  className="attachment-remove"
                  onClick={() => handleRemoveAttachment(attachment.id)}
                  title="Remove attachment"
                  disabled={isUploadingAttachments}
                >
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M18 6L6 18M6 6l12 12" />
                  </svg>
                </button>
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  const importAttachmentsToWorkspace = async (): Promise<ImportedAttachment[]> => {
    if (pendingAttachments.length === 0) return [];
    if (!workspace) {
      throw new Error('Select a workspace before attaching files.');
    }
    const pathAttachments = pendingAttachments.filter((attachment) => attachment.path && !attachment.dataBase64);
    const dataAttachments = pendingAttachments.filter((attachment) => attachment.dataBase64);

    const results: ImportedAttachment[] = [];

    if (pathAttachments.length > 0) {
      const imported = await window.electronAPI.importFilesToWorkspace({
        workspaceId: workspace.id,
        files: pathAttachments.map((attachment) => attachment.path as string),
      });
      results.push(...imported);
    }

    if (dataAttachments.length > 0) {
      const imported = await window.electronAPI.importDataToWorkspace({
        workspaceId: workspace.id,
        files: dataAttachments.map((attachment) => ({
          name: attachment.name,
          data: attachment.dataBase64 as string,
          mimeType: attachment.mimeType,
        })),
      });
      results.push(...imported);
    }

    return results;
  };

  const handleSend = async () => {
    if (isUploadingAttachments || isPreparingMessage) {
      return;
    }

    const trimmedInput = inputValue.trim();
    const hasAttachments = pendingAttachments.length > 0;

    if (!trimmedInput && !hasAttachments) return;

    let importedAttachments: ImportedAttachment[] = [];
    setIsPreparingMessage(true);
    setAttachmentError(null);
    let sendFailed = false;
    if (hasAttachments) {
      setIsUploadingAttachments(true);
    }

    try {
      if (hasAttachments) {
        importedAttachments = await importAttachmentsToWorkspace();
      }

      const composeResult = await composeMessageWithAttachments(workspace?.path, trimmedInput, importedAttachments);
      const hasExtractionWarnings = composeResult.extractionWarnings.length > 0;
      if (hasExtractionWarnings) {
        const warningList = composeResult.extractionWarnings.join(', ');
        setAttachmentError(`I had trouble reading ${warningList}. They were attached, but I may not have had full content.`);
      }
      const message = composeResult.message;

      // Use selectedTaskId to determine if we should follow-up or create new task
      // This fixes the bug where old tasks (beyond the 100 most recent) would create new tasks
      // instead of sending follow-up messages
      if (!selectedTaskId && onCreateTask) {
        // No task selected - create new task with optional autonomy enabled
        const titleSource = trimmedInput || (pendingAttachments[0]?.name ? `Review ${pendingAttachments[0].name}` : 'New task');
        const title = buildTaskTitle(titleSource);
        const options: CreateTaskOptions | undefined = autonomousModeEnabled ? { autonomousMode: true } : undefined;
        onCreateTask(title, message, options);
        // Reset task mode state
        setAutonomousModeEnabled(false);
      } else {
        // Task is selected (even if not in current list) - send follow-up message
        onSendMessage(message);
      }

      setInputValue('');
      setPendingAttachments([]);
      setMentionOpen(false);
      setMentionQuery('');
      setMentionTarget(null);
    } catch (error) {
      console.error('Failed to send message:', error);
      sendFailed = true;
      const baseError = error instanceof Error ? error.message : 'Failed to send message.';
      reportAttachmentError(baseError);
    } finally {
      setIsUploadingAttachments(false);
      setIsPreparingMessage(false);
      if (!sendFailed) {
        setAttachmentError(null);
      }
    }
  };

  const findMentionAtCursor = (value: string, cursor: number | null) => {
    if (cursor === null) return null;
    const uptoCursor = value.slice(0, cursor);
    const atIndex = uptoCursor.lastIndexOf('@');
    if (atIndex === -1) return null;
    if (atIndex > 0 && /[a-zA-Z0-9]/.test(uptoCursor[atIndex - 1])) {
      return null;
    }
    const query = uptoCursor.slice(atIndex + 1);
    if (query.startsWith(' ')) return null;
    if (query.includes('\n') || query.includes('\r')) return null;
    return { query, start: atIndex, end: cursor };
  };

  const mentionOptions = useMemo<MentionOption[]>(() => {
    if (!mentionOpen) return [];
    const query = normalizeMentionSearch(mentionQuery);
    const options: MentionOption[] = [];
    const includeEveryone = query.length > 0 && ['everybody', 'everyone', 'all'].some((alias) => alias.startsWith(query));
    if (includeEveryone) {
      options.push({
        type: 'everyone',
        id: 'everyone',
        label: 'Everybody',
        description: 'Auto-pick the best agents for this task',
        icon: '👥',
        color: '#64748b',
      });
    }

    const filteredAgents = agentRoles
      .filter((role) => role.isActive)
      .filter((role) => {
        if (!query) return true;
        const haystacks = [role.displayName, role.name, role.description ?? ''];
        return haystacks.some((text) => normalizeMentionSearch(text).includes(query));
      })
      .sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) {
          return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
        }
        return a.displayName.localeCompare(b.displayName);
      });

    filteredAgents.forEach((role) => {
      options.push({
        type: 'agent',
        id: role.id,
        label: role.displayName,
        description: role.description,
        icon: role.icon,
        color: role.color,
      });
    });

    return options;
  }, [mentionOpen, mentionQuery, agentRoles]);

  useEffect(() => {
    if (mentionSelectedIndex >= mentionOptions.length) {
      setMentionSelectedIndex(0);
    }
  }, [mentionOptions, mentionSelectedIndex]);

  useEffect(() => {
    if (!mentionOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (mentionContainerRef.current && !mentionContainerRef.current.contains(e.target as Node)) {
        setMentionOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [mentionOpen]);

  const updateMentionState = useCallback((value: string, cursor: number | null) => {
    const mention = findMentionAtCursor(value, cursor);
    if (!mention) {
      setMentionOpen(false);
      setMentionQuery('');
      setMentionTarget(null);
      return;
    }
    setMentionOpen(true);
    setMentionQuery(mention.query);
    setMentionTarget({ start: mention.start, end: mention.end });
    setMentionSelectedIndex(0);
  }, []);

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInputValue(value);
    updateMentionState(value, e.target.selectionStart);
  };

  const handleInputClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    updateMentionState(inputValue, e.currentTarget.selectionStart);
  };

  const handleInputKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'].includes(e.key)) {
      updateMentionState(inputValue, (e.currentTarget as HTMLTextAreaElement).selectionStart);
    }
  };

  const handleMentionSelect = (option: MentionOption) => {
    if (!mentionTarget) return;
    const insertText = option.type === 'everyone' ? '@everybody' : `@${option.label}`;
    const before = inputValue.slice(0, mentionTarget.start);
    const after = inputValue.slice(mentionTarget.end);
    const needsSpace = after.length === 0 ? true : !after.startsWith(' ');
    const nextValue = `${before}${insertText}${needsSpace ? ' ' : ''}${after}`;
    setInputValue(nextValue);
    setMentionOpen(false);
    setMentionQuery('');
    setMentionTarget(null);

    requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        const cursorPosition = before.length + insertText.length + (needsSpace ? 1 : 0);
        textarea.focus();
        textarea.setSelectionRange(cursorPosition, cursorPosition);
      }
    });
  };

  const renderMentionDropdown = () => {
    if (!mentionOpen || mentionOptions.length === 0) return null;
    return (
      <div className="mention-autocomplete-dropdown" ref={mentionDropdownRef}>
        {mentionOptions.map((option, index) => {
          const displayLabel = option.type === 'everyone' ? '@everybody' : `@${option.label}`;
          return (
            <button
              key={`${option.type}-${option.id}`}
              className={`mention-autocomplete-item ${index === mentionSelectedIndex ? 'selected' : ''}`}
              onMouseDown={(e) => {
                e.preventDefault();
                handleMentionSelect(option);
              }}
              onMouseEnter={() => setMentionSelectedIndex(index)}
            >
              <span
                className="mention-autocomplete-icon"
                style={{ backgroundColor: option.color || '#64748b' }}
              >
                <ThemeIcon
                  emoji={option.icon || '👥'}
                  icon={<UsersIcon size={16} />}
                />
              </span>
              <div className="mention-autocomplete-details">
                <span className="mention-autocomplete-name">{displayLabel}</span>
                {option.description && (
                  <span className="mention-autocomplete-desc">{option.description}</span>
                )}
              </div>
            </button>
          );
        })}
      </div>
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (mentionOpen && mentionOptions.length > 0) {
      switch (e.key) {
        case 'ArrowDown':
          e.preventDefault();
          setMentionSelectedIndex((prev) => (prev + 1) % mentionOptions.length);
          return;
        case 'ArrowUp':
          e.preventDefault();
          setMentionSelectedIndex((prev) => (prev - 1 + mentionOptions.length) % mentionOptions.length);
          return;
        case 'Enter':
        case 'Tab':
          e.preventDefault();
          handleMentionSelect(mentionOptions[mentionSelectedIndex]);
          return;
        case 'Escape':
          e.preventDefault();
          setMentionOpen(false);
          return;
      }
    }

    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleQuickAction = (action: string) => {
    setInputValue(action);
  };

  useEffect(() => {
    if (task?.status === 'paused' && textareaRef.current) {
      const inputEl = textareaRef.current;
      window.requestAnimationFrame(() => {
        inputEl.focus();
      });
    }
  }, [task?.status]);

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  const getEventDotClass = (type: TaskEvent['type']) => {
    if (type === 'error' || type === 'step_failed' || type === 'verification_failed') return 'error';
    if (type === 'step_completed' || type === 'task_completed' || type === 'verification_passed') return 'success';
    if (type === 'step_started' || type === 'executing' || type === 'verification_started' || type === 'retry_started') return 'active';
    return '';
  };

  // Get the last assistant message to always show the response
  const lastAssistantMessage = useMemo(() => {
    const assistantMessages = events.filter(e => e.type === 'assistant_message' && e.payload?.internal !== true);
    return assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;
  }, [events]);

  // Welcome/Empty state
  if (!task) {
    return (
      <div className="main-content">
        <div className="main-body welcome-view">
          <div className="welcome-content cli-style">
            {/* Logo */}
            <div className="welcome-header-modern modern-only">
              <div className="modern-logo-container">
                <img src="./cowork-os-logo.png" alt="CoWork OS" className="modern-logo" />
                <div className="modern-title-container">
                  <h1 className="modern-title">CoWork OS</h1>
                  <span className="modern-version">{appVersion ? `v${appVersion}` : ''}</span>
                </div>
              </div>
              <p className="modern-subtitle">{agentContext.getMessage('welcomeSubtitle')}</p>
            </div>

            <div className="terminal-only">
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
                  <span className="cli-text" title={agentContext.getMessage('welcome')}>{agentContext.getMessage('welcome')}</span>
                </div>
                <div className="cli-line cli-line-secondary">
                  <span className="cli-prompt">&gt;</span>
                  <span className="cli-text">{agentContext.getMessage('welcomeSubtitle')}</span>
                </div>
                <div className="cli-line cli-line-disclosure">
                  <span className="cli-prompt">#</span>
                  <span className="cli-text cli-text-muted" title={agentContext.getMessage('disclaimer')}>{agentContext.getMessage('disclaimer')}</span>
                </div>
              </div>
            </div>

            {/* Quick Start */}
            <div className="cli-commands">
              <div className="cli-commands-header">
                <span className="cli-prompt">&gt;</span>
                <span className="terminal-only">QUICK START</span>
                <span className="modern-only">Quick start</span>
              </div>
              <div className="quick-start-grid">
                <button className="quick-start-card" onClick={() => handleQuickAction('Let\'s organize the files in this folder together. Sort them by type and rename them with clear, consistent names.')} title="Let's sort and tidy up the workspace">
                  <ThemeIcon className="quick-start-icon" emoji="📁" icon={<FolderIcon size={22} />} />
                  <span className="quick-start-title">Organize files</span>
                  <span className="quick-start-desc">Let's sort and tidy up the workspace</span>
                </button>
                <button className="quick-start-card" onClick={() => handleQuickAction('Let\'s write a document together. I\'ll describe what I need and we can create it.')} title="Co-create reports, summaries, or notes">
                  <ThemeIcon className="quick-start-icon" emoji="📝" icon={<EditIcon size={22} />} />
                  <span className="quick-start-title">Write together</span>
                  <span className="quick-start-desc">Co-create reports, summaries, or notes</span>
                </button>
                <button className="quick-start-card" onClick={() => handleQuickAction('Let\'s analyze the data files in this folder together. We\'ll summarize the key findings and create a report.')} title="Work through spreadsheets or data files">
                  <ThemeIcon className="quick-start-icon" emoji="📊" icon={<ChartIcon size={22} />} />
                  <span className="quick-start-title">Analyze data</span>
                  <span className="quick-start-desc">Work through spreadsheets or data files</span>
                </button>
                <button className="quick-start-card" onClick={() => handleQuickAction('Let\'s generate documentation for this project together. We can create a README, API docs, or code comments as needed.')} title="Build documentation for the project">
                  <ThemeIcon className="quick-start-icon" emoji="📖" icon={<BookIcon size={22} />} />
                  <span className="quick-start-title">Generate docs</span>
                  <span className="quick-start-desc">Build documentation for the project</span>
                </button>
                <button className="quick-start-card" onClick={() => handleQuickAction('Let\'s research and summarize information from the files in this folder together.')} title="Dig through files and find insights">
                  <ThemeIcon className="quick-start-icon" emoji="🔍" icon={<SearchIcon size={22} />} />
                  <span className="quick-start-title">Research together</span>
                  <span className="quick-start-desc">Dig through files and find insights</span>
                </button>
                <button className="quick-start-card" onClick={() => handleQuickAction('Let\'s prepare for a meeting together. We\'ll create an agenda, talking points, and organize materials needed.')} title="Get everything ready for a clean meeting">
                  <ThemeIcon className="quick-start-icon" emoji="📋" icon={<ClipboardIcon size={22} />} />
                  <span className="quick-start-title">Meeting prep</span>
                  <span className="quick-start-desc">Get everything ready for a clean meeting</span>
                </button>
              </div>
            </div>

            {/* Input Area */}
            {renderAttachmentPanel()}
            <div
              className={`welcome-input-container cli-input-container ${isDraggingFiles ? 'drag-over' : ''}`}
              onDragOver={handleDragOver}
              onDragEnter={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {showVoiceNotConfigured && (
                <div className="voice-not-configured-banner">
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                  <span>Voice input is not configured.</span>
                  <button
                    className="voice-settings-link"
                    onClick={() => {
                      setShowVoiceNotConfigured(false);
                      onOpenSettings?.('voice');
                    }}
                  >
                    Open Voice Settings
                  </button>
                  <button
                    className="voice-banner-close"
                    onClick={() => setShowVoiceNotConfigured(false)}
                    title="Dismiss"
                  >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              )}
              <div className="cli-input-wrapper">
                <span className="cli-input-prompt">~$</span>
                <span ref={placeholderMeasureRef} className="cli-placeholder-measure" aria-hidden="true" />
                <div className="mention-autocomplete-wrapper" ref={mentionContainerRef}>
                  <textarea
                    ref={textareaRef}
                    className="welcome-input cli-input input-textarea"
                    placeholder={placeholder}
                    value={inputValue}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    onClick={handleInputClick}
                    onKeyUp={handleInputKeyUp}
                    rows={1}
                  />
                  {renderMentionDropdown()}
                </div>
                {!inputValue && <span className="cli-cursor" style={{ left: cursorLeft }} />}
              </div>

              {/* Task mode options */}
              <div className="goal-mode-section">
                <label className="goal-mode-toggle">
                  <input
                    type="checkbox"
                    checked={autonomousModeEnabled}
                    onChange={(e) => setAutonomousModeEnabled(e.target.checked)}
                  />
                  <span className="goal-mode-label">Autonomous mode</span>
                  <span className="goal-mode-hint">Skip confirmation prompts and keep working</span>
                </label>
              </div>

              <div className="welcome-input-footer">
                <div className="input-left-actions">
                  <button
                    className="attachment-btn attachment-btn-left"
                    onClick={handleAttachFiles}
                    disabled={isUploadingAttachments}
                    title="Attach files"
                  >
                    <svg
                      width="18"
                      height="18"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                    >
                      <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
                    </svg>
                  </button>
                  <div className="workspace-dropdown-container" ref={workspaceDropdownRef}>
                    <button className="folder-selector" onClick={handleWorkspaceDropdownToggle}>
                      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                      </svg>
                      <span>{workspace?.isTemp || isTempWorkspaceId(workspace?.id) ? 'Work in a folder' : (workspace?.name || 'Work in a folder')}</span>
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
                              {workspacesList.slice(0, 10).map((w) => (
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
                    onOpenSettings={onOpenSettings}
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
                    className={`voice-input-btn ${voiceInput.state}`}
                    onClick={voiceInput.toggleRecording}
                    disabled={voiceInput.state === 'processing'}
                    title={
                      voiceInput.state === 'idle' ? 'Start voice input' :
                        voiceInput.state === 'recording' ? 'Stop recording' :
                          'Processing...'
                    }
                  >
                    {voiceInput.state === 'processing' ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="voice-processing-spin">
                        <circle cx="12" cy="12" r="10" />
                        <path d="M12 6v6l4 2" />
                      </svg>
                    ) : voiceInput.state === 'recording' ? (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                        <rect x="6" y="6" width="12" height="12" rx="2" />
                      </svg>
                    ) : (
                      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                        <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                        <line x1="12" y1="19" x2="12" y2="23" />
                        <line x1="8" y1="23" x2="16" y2="23" />
                      </svg>
                    )}
                    {voiceInput.state === 'recording' && (
                      <span className="voice-recording-indicator" style={{ width: `${voiceInput.audioLevel}%` }} />
                    )}
                  </button>
                  <button
                    className="lets-go-btn lets-go-btn-sm"
                    onClick={handleSend}
                    disabled={(!inputValue.trim() && pendingAttachments.length === 0) || isUploadingAttachments || isPreparingMessage}
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
  const latestPauseEvent = [...events].reverse().find(event => event.type === 'task_paused');
  const latestApprovalEvent = [...events].reverse().find(
    (event) => event.type === 'approval_requested' && event.payload?.autoApproved !== true
  );

  // Task view
  return (
    <div className="main-content">
      {/* Header */}
      <div className="main-header">
        <div className="main-header-title" title={headerTooltip}>{headerTitle}</div>
      </div>
      {isTaskWorking && (
        <div className="main-header-status">
          <span className="chat-status executing">
            <svg className="spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
            </svg>
            {agentContext.getMessage('taskWorking')}
          </span>
        </div>
      )}

      {/* Body */}
      <div className="main-body" ref={mainBodyRef} onScroll={handleScroll}>
        <div className="task-content">
          {/* User Prompt - Right aligned like chat */}
          <div className="chat-message user-message">
            <CollapsibleUserBubble>
              <ReactMarkdown remarkPlugins={userMarkdownPlugins} components={markdownComponents}>
                {stripPptxBubbleContent(task.prompt)}
              </ReactMarkdown>
              {extractAttachmentNames(task.prompt).length > 0 && (
                <div className="bubble-attachments">
                  {extractAttachmentNames(task.prompt).map((name, i) => (
                    <span className="bubble-attachment-chip" key={i}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <path d="M14 2v6h6" />
                      </svg>
                      <span className="bubble-attachment-name" title={name}>{name}</span>
                    </span>
                  ))}
                </div>
              )}
            </CollapsibleUserBubble>
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
                <>
                  <button
                    className={`verbose-toggle-btn ${verboseSteps ? 'active' : ''}`}
                    onClick={toggleVerboseSteps}
                    title={verboseSteps ? 'Show important steps only' : 'Show all steps (verbose)'}
                  >
                    {verboseSteps ? 'Verbose' : 'Summary'}
                  </button>
                  <button
                    className={`verbose-toggle-btn ${codePreviewsExpanded ? 'active' : ''}`}
                    onClick={toggleCodePreviews}
                    title={codePreviewsExpanded ? 'Collapse code previews by default' : 'Expand code previews by default'}
                  >
                    {codePreviewsExpanded ? 'Code: Open' : 'Code: Collapsed'}
                  </button>
                </>
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
              {timelineItems.map((item) => {
                if (item.kind === 'canvas') {
                  return (
                    <CanvasPreview
                      key={item.session.id}
                      session={item.session}
                      onClose={() => handleCanvasClose(item.session.id)}
                      forceSnapshot={item.forceSnapshot}
                      onOpenBrowser={onOpenBrowserView}
                    />
                  );
                }

                const event = item.event;
                const isUserMessage = event.type === 'user_message';
                const isAssistantMessage = event.type === 'assistant_message';
                // Check if CommandOutput should be rendered after this event
                const shouldRenderCommandOutput = activeCommand && item.eventIndex === commandOutputInsertIndex;

                // Render user messages as chat bubbles on the right
                if (isUserMessage) {
                  const rawMessage = event.payload?.message || 'User message';
                  const messageText = stripPptxBubbleContent(rawMessage);
                  const attachmentNames = extractAttachmentNames(rawMessage);
                  return (
                    <Fragment key={event.id || `event-${item.eventIndex}`}>
                      <div className="chat-message user-message">
                        <CollapsibleUserBubble>
                          <ReactMarkdown remarkPlugins={userMarkdownPlugins} components={markdownComponents}>
                            {messageText}
                          </ReactMarkdown>
                          {attachmentNames.length > 0 && (
                            <div className="bubble-attachments">
                              {attachmentNames.map((name, i) => (
                                <span className="bubble-attachment-chip" key={i}>
                                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                    <path d="M14 2v6h6" />
                                  </svg>
                                  <span className="bubble-attachment-name" title={name}>{name}</span>
                                </span>
                              ))}
                            </div>
                          )}
                        </CollapsibleUserBubble>
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
                    <Fragment key={event.id || `event-${item.eventIndex}`}>
                      <div className="chat-message assistant-message">
                        <div className="chat-bubble assistant-bubble">
                          {isLastAssistant && (
                            <div className="chat-bubble-header">
                              {task.status === 'completed' && <span className="chat-status">{agentContext.getMessage('taskComplete')}</span>}
                              {task.status === 'paused' && <span className="chat-status">Waiting for your direction</span>}
                              {task.status === 'blocked' && <span className="chat-status">{agentContext.getMessage('taskBlocked') || 'Needs approval'}</span>}
                              {isTaskWorking && (
                                <span className="chat-status executing">
                                  <svg className="spinner" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                                  </svg>
                                  {agentContext.getMessage('taskWorking')}
                                </span>
                              )}
                            </div>
                          )}
                          <div className="chat-bubble-content markdown-content">
                            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                              {messageText.replace(/\[\[speak\]\]([\s\S]*?)\[\[\/speak\]\]/gi, '$1')}
                            </ReactMarkdown>
                          </div>
                        </div>
                        <div className="message-actions">
                          <MessageCopyButton text={messageText} />
                          <MessageSpeakButton text={messageText} voiceEnabled={voiceEnabled} />
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
                }

                // Technical events - only show when showSteps is true
                const alwaysVisibleEvents = new Set([
                  'approval_requested',
                  'approval_granted',
                  'approval_denied',
                  'error',
                  'step_failed',
                  'verification_failed',
                ]);
                const showEvenWithoutSteps =
                  alwaysVisibleEvents.has(event.type) ||
                  isImageFileEvent(event) ||
                  (event.type === 'tool_result' && event.payload?.tool === 'schedule_task');
                if (!showSteps && !showEvenWithoutSteps) {
                  // Even if we're not showing steps, we may still need to render CommandOutput here
                  if (shouldRenderCommandOutput) {
                    return (
                      <Fragment key={event.id || `event-${item.eventIndex}`}>
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
                  <Fragment key={event.id || `event-${item.eventIndex}`}>
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
                            <div className="event-title">{renderEventTitle(event, workspace?.path, setViewerFilePath, agentContext)}</div>
                          </div>
                          <div className="event-time">{formatTime(event.timestamp)}</div>
                        </div>
                {isExpanded && renderEventDetails(event, voiceEnabled, markdownComponents, { workspacePath: workspace?.path, onOpenViewer: setViewerFilePath, hideVerificationSteps: true })}
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

        </div>
      </div>

      {/* Footer with Input */}
      <div className="main-footer">
        {renderAttachmentPanel()}
        <div
          className={`input-container ${isDraggingFiles ? 'drag-over' : ''}`}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {showVoiceNotConfigured && (
            <div className="voice-not-configured-banner">
              <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                <line x1="12" y1="19" x2="12" y2="23" />
                <line x1="8" y1="23" x2="16" y2="23" />
              </svg>
              <span>Voice input is not configured.</span>
              <button
                className="voice-settings-link"
                onClick={() => {
                  setShowVoiceNotConfigured(false);
                  onOpenSettings?.('voice');
                }}
              >
                Open Voice Settings
              </button>
              <button
                className="voice-banner-close"
                onClick={() => setShowVoiceNotConfigured(false)}
                title="Dismiss"
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
        {task.status === 'paused' && (
          <div className="task-status-banner task-status-banner-paused">
            <div className="task-status-banner-content">
              <strong>Quick check-in - I'm at a decision point.</strong>
              {latestPauseEvent?.payload?.message && (
                <span className="task-status-banner-detail">{latestPauseEvent.payload.message}</span>
              )}
              <span className="task-status-banner-detail">Share your next instruction below and I'll continue right away.</span>
            </div>
          </div>
        )}
          {task.status === 'blocked' && (
            <div className="task-status-banner task-status-banner-blocked">
              <div className="task-status-banner-content">
                <strong>Blocked — needs approval</strong>
                {latestApprovalEvent?.payload?.approval?.description && (
                  <span className="task-status-banner-detail">{latestApprovalEvent.payload.approval.description}</span>
                )}
              </div>
            </div>
          )}
          <div className="input-row">
            <button
              className="attachment-btn attachment-btn-left"
              onClick={handleAttachFiles}
              disabled={isUploadingAttachments}
              title="Attach files"
            >
              <svg
                width="18"
                height="18"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
              </svg>
            </button>
            <div className="mention-autocomplete-wrapper" ref={mentionContainerRef}>
              <textarea
                ref={textareaRef}
                className="input-field input-textarea"
                placeholder={agentContext.getMessage('placeholderActive')}
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onClick={handleInputClick}
                onKeyUp={handleInputKeyUp}
                rows={1}
              />
              {renderMentionDropdown()}
            </div>
            <div className="input-actions">
              <ModelDropdown
                models={availableModels}
                selectedModel={selectedModel}
                onModelChange={onModelChange}
                onOpenSettings={onOpenSettings}
              />
              <button
                className={`voice-input-btn ${voiceInput.state}`}
                onClick={voiceInput.toggleRecording}
                disabled={voiceInput.state === 'processing' || talkMode.isActive}
                title={
                  talkMode.isActive ? 'Talk Mode active' :
                    voiceInput.state === 'idle' ? 'Start voice input' :
                      voiceInput.state === 'recording' ? 'Stop recording' :
                        'Processing...'
                }
              >
                {voiceInput.state === 'processing' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" className="voice-processing-spin">
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 6v6l4 2" />
                  </svg>
                ) : voiceInput.state === 'recording' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                )}
                {voiceInput.state === 'recording' && (
                  <span className="voice-recording-indicator" style={{ width: `${voiceInput.audioLevel}%` }} />
                )}
              </button>
              <button
                className={`voice-input-btn talk-mode-btn ${talkMode.isActive ? 'active' : ''} ${talkMode.state}`}
                onClick={talkMode.toggle}
                title={
                  talkMode.isActive
                    ? `Talk Mode ON (${talkMode.inputMode === 'push_to_talk' ? 'hold Space to talk' : 'voice activity'}) — click to stop`
                    : 'Start Talk Mode — continuous voice conversation'
                }
              >
                {talkMode.state === 'listening' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <circle cx="12" cy="12" r="10" strokeDasharray="4 2" />
                  </svg>
                ) : talkMode.state === 'speaking' ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
                    <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
                    <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
                  </svg>
                ) : (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <path d="M8 21h8" />
                    <path d="M12 17v4" />
                    <circle cx="12" cy="12" r="10" strokeDasharray="4 2" />
                  </svg>
                )}
                {talkMode.isActive && talkMode.state === 'listening' && (
                  <span className="voice-recording-indicator" style={{ width: `${talkMode.audioLevel}%` }} />
                )}
              </button>
              {isTaskWorking && onStopTask ? (
                <button
                  className="stop-btn-simple"
                  onClick={onStopTask}
                  title="Stop task"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <rect x="3" y="3" width="18" height="18" rx="2" />
                  </svg>
                </button>
              ) : (
                <button
                  className="lets-go-btn lets-go-btn-sm"
                  onClick={handleSend}
                  disabled={(!inputValue.trim() && pendingAttachments.length === 0) || isUploadingAttachments || isPreparingMessage}
                  title="Send message"
                >
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          <div className="input-below-actions">
            <div className="workspace-dropdown-container" ref={workspaceDropdownRef}>
              <button
                className="folder-selector"
                onClick={handleWorkspaceDropdownToggle}
                title={workspace?.path || 'Select a workspace folder'}
              >
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                </svg>
                <span>{workspace?.isTemp || isTempWorkspaceId(workspace?.id) ? 'Work in a folder' : (workspace?.name || 'Work in a folder')}</span>
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
                        {workspacesList.slice(0, 10).map((w) => (
                          <button
                            key={w.id}
                            className={`workspace-dropdown-item ${workspace?.id === w.id ? 'active' : ''}`}
                            onClick={() => handleWorkspaceSelect(w)}
                          >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                              <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
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
            <span className="keyboard-hint">
              {isPreparingMessage ? (
                <span>Preparing your message...</span>
              ) : (
                <span><kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> for new line</span>
              )}
            </span>
          </div>
        </div>
        <div className="footer-disclaimer">
          {agentContext.getMessage('disclaimer')}
        </div>
      </div>

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
  onOpenViewer?: (path: string) => void,
  agentCtx?: AgentContext
): React.ReactNode {
  // Build message context for personalized messages
  const msgCtx = agentCtx ? {
    agentName: agentCtx.agentName,
    userName: agentCtx.userName,
    personality: agentCtx.personality,
    persona: agentCtx.persona,
    emojiUsage: agentCtx.emojiUsage,
    quirks: agentCtx.quirks,
  } : {
    agentName: 'CoWork',
    userName: undefined,
    personality: 'professional' as const,
    persona: undefined,
    emojiUsage: 'minimal' as const,
    quirks: DEFAULT_QUIRKS,
  };

  switch (event.type) {
    case 'task_created':
      return getMessage('taskStart', msgCtx);
    case 'task_completed':
      return getMessage('taskComplete', msgCtx);
    case 'plan_created':
      return getMessage('planCreated', msgCtx);
    case 'step_started':
      return getMessage('stepStarted', msgCtx, event.payload.step?.description || 'Getting started...');
    case 'step_completed':
      return getMessage('stepCompleted', msgCtx, event.payload.step?.description || event.payload.message);
    case 'step_failed':
      return `Step failed: ${event.payload.step?.description || 'Unknown step'}`;
    case 'tool_call': {
      const tcTool = event.payload.tool;
      const tcInput = event.payload.input;
      let tcDetail = '';
      if (tcTool === 'write_file' && tcInput?.path) {
        const tcLines = tcInput.content ? tcInput.content.split('\n').length : 0;
        tcDetail = ` → ${tcInput.path} (${tcLines} lines)`;
      } else if (tcTool === 'edit_file' && tcInput?.file_path) {
        tcDetail = ` → ${tcInput.file_path}`;
      } else if (tcTool === 'read_file' && tcInput?.path) {
        tcDetail = ` → ${tcInput.path}`;
      } else if (tcTool === 'run_command' && tcInput?.command) {
        const cmd = tcInput.command.length > 40 ? tcInput.command.slice(0, 40) + '...' : tcInput.command;
        tcDetail = ` → ${cmd}`;
      } else if (tcTool === 'glob' && tcInput?.pattern) {
        tcDetail = ` → ${tcInput.pattern}`;
      } else if ((tcTool === 'grep' || tcTool === 'search_files') && tcInput?.pattern) {
        tcDetail = ` → /${tcInput.pattern}/`;
      }
      return `Using: ${tcTool}${tcDetail}`;
    }
    case 'tool_result': {
      const result = event.payload.result;
      const success = result?.success !== false && !result?.error;
      const status = success ? 'done' : 'issue';

      // schedule_task is user-facing; surface a compact summary in the title.
      if (event.payload.tool === 'schedule_task') {
        const describeEvery = (ms: number): string => {
          if (!Number.isFinite(ms) || ms <= 0) return `${ms}ms`;
          const day = 24 * 60 * 60 * 1000;
          const hour = 60 * 60 * 1000;
          const minute = 60 * 1000;
          const second = 1000;

          if (ms >= day && ms % day === 0) {
            const days = ms / day;
            return `Every ${days} day${days === 1 ? '' : 's'}`;
          }
          if (ms >= hour && ms % hour === 0) {
            const hours = ms / hour;
            return `Every ${hours} hour${hours === 1 ? '' : 's'}`;
          }
          if (ms >= minute && ms % minute === 0) {
            const minutes = ms / minute;
            return `Every ${minutes} minute${minutes === 1 ? '' : 's'}`;
          }
          if (ms >= second && ms % second === 0) {
            const seconds = ms / second;
            return `Every ${seconds} second${seconds === 1 ? '' : 's'}`;
          }
          return `Every ${Math.round(ms / 1000)}s`;
        };

        const describeScheduleShort = (schedule: any): string | null => {
          if (!schedule || typeof schedule !== 'object') return null;
          if (schedule.kind === 'every' && typeof schedule.everyMs === 'number') {
            return describeEvery(schedule.everyMs);
          }
          if (schedule.kind === 'cron' && typeof schedule.expr === 'string') {
            return `Cron: ${schedule.expr}`;
          }
          if (schedule.kind === 'at' && typeof schedule.atMs === 'number') {
            return `Once at ${new Date(schedule.atMs).toLocaleString()}`;
          }
          return null;
        };

        // Error-first title for schedule failures.
        if (!success && result?.error) {
          const errorMsg = typeof result.error === 'string' ? result.error : 'Unknown error';
          const clipped = errorMsg.slice(0, 80) + (errorMsg.length > 80 ? '...' : '');
          return `schedule_task issue: ${clipped}`;
        }

        // "create"/"update" responses include { success, job }.
        const job = result?.job;
        if (job && typeof job === 'object') {
          const jobName = String((job as any).name || '').trim() || 'Scheduled task';
          const scheduleDesc = describeScheduleShort((job as any).schedule);
          const nextRunAtMs = (job as any).state?.nextRunAtMs;
          const next = typeof nextRunAtMs === 'number' ? new Date(nextRunAtMs).toLocaleString() : null;
          const parts = [scheduleDesc, next ? `Next: ${next}` : null].filter(Boolean) as string[];
          return parts.length > 0 ? `${jobName} → ${parts.join(' • ')}` : jobName;
        }

        // "list" returns an array of jobs.
        if (Array.isArray(result)) {
          const n = result.length;
          return `schedule_task ${status} → ${n} task${n === 1 ? '' : 's'}`;
        }
      }

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
      return msgCtx.agentName;
    case 'file_created': {
      const fcp = event.payload;
      let fcSuffix = '';
      if (fcp.type === 'directory') {
        fcSuffix = ' (directory)';
      } else if (fcp.type === 'screenshot') {
        fcSuffix = ' (screenshot)';
      } else if (fcp.copiedFrom) {
        fcSuffix = ' (copy)';
      } else if (fcp.lineCount && fcp.size) {
        fcSuffix = ` (${fcp.lineCount} lines, ${formatFileSize(fcp.size)})`;
      } else if (fcp.size) {
        fcSuffix = ` (${formatFileSize(fcp.size)})`;
      }
      return (
        <span>
          Created: <ClickableFilePath path={fcp.path} workspacePath={workspacePath} onOpenViewer={onOpenViewer} />
          {fcSuffix && <span className="event-title-meta">{fcSuffix}</span>}
        </span>
      );
    }
    case 'file_modified': {
      const fmp = event.payload;
      const fmPath = fmp.path || fmp.from;
      let fmSuffix = '';
      if (fmp.action === 'rename' && fmp.to) {
        const toName = fmp.to.split('/').pop();
        fmSuffix = ` → ${toName}`;
      } else if (fmp.type === 'edit' && fmp.replacements) {
        const netStr = fmp.netLines != null
          ? (fmp.netLines > 0 ? `, +${fmp.netLines} lines` : fmp.netLines < 0 ? `, ${fmp.netLines} lines` : '')
          : '';
        fmSuffix = ` (${fmp.replacements} edit${fmp.replacements > 1 ? 's' : ''}${netStr})`;
      }
      return (
        <span>
          Updated: <ClickableFilePath path={fmPath} workspacePath={workspacePath} onOpenViewer={onOpenViewer} />
          {fmSuffix && <span className="event-title-meta">{fmSuffix}</span>}
        </span>
      );
    }
    case 'file_deleted':
      return `Removed: ${event.payload.path}`;
    case 'error':
      return getMessage('error', msgCtx);
    case 'approval_requested':
      return `${getMessage('approval', msgCtx)} ${event.payload.approval?.description}`;
    case 'log':
      return event.payload.message;
    case 'verification_started':
      return getMessage('verifying', msgCtx);
    case 'verification_passed':
      return `${getMessage('verifyPassed', msgCtx)} (attempt ${event.payload.attempt})`;
    case 'verification_failed':
      return `${getMessage('verifyFailed', msgCtx)} (attempt ${event.payload.attempt}/${event.payload.maxAttempts})`;
    case 'retry_started':
      return getMessage('retrying', msgCtx, String(event.payload.attempt));
    default:
      return event.type;
  }
}

function renderEventDetails(
  event: TaskEvent,
  voiceEnabled: boolean,
  markdownComponents: any,
  options?: {
    workspacePath?: string;
    onOpenViewer?: (path: string) => void;
    hideVerificationSteps?: boolean;
  }
) {
  const workspacePath = options?.workspacePath;
  const onOpenViewer = options?.onOpenViewer;
  const imageExt = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;

  switch (event.type) {
    case 'plan_created': {
      const planSteps = Array.isArray(event.payload.plan?.steps)
        ? event.payload.plan.steps
        : [];
      const visiblePlanSteps = options?.hideVerificationSteps
        ? planSteps.filter((step: any) => !isVerificationStepDescription(step?.description))
        : planSteps;
      return (
        <div className="event-details">
          <div style={{ marginBottom: 8, fontWeight: 500 }}>{event.payload.plan?.description}</div>
          {visiblePlanSteps.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {visiblePlanSteps.map((step: any, i: number) => (
                <li key={i} style={{ marginBottom: 4 }}>{step.description}</li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    case 'tool_call': {
      const tcToolName = event.payload.tool;
      const tcInput = event.payload.input;

      // write_file: show path + code preview
      if (tcToolName === 'write_file' && tcInput?.path && tcInput?.content) {
        const tcLines = tcInput.content.split('\n');
        const tcPreview = tcLines.slice(0, 20).join('\n');
        const tcExt = (tcInput.path.split('.').pop() || 'text').toLowerCase();
        return (
          <div className="event-details event-details-scrollable event-details-code-preview">
            <div className="code-preview-header">
              <span className="code-preview-path">{tcInput.path}</span>
              <span className="code-preview-language">{tcExt}</span>
            </div>
            <pre className="code-preview-content"><code>{truncateForDisplay(tcPreview, 1500)}</code></pre>
            {tcLines.length > 20 && (
              <div className="code-preview-truncated">... {tcLines.length - 20} more lines</div>
            )}
          </div>
        );
      }

      // edit_file: show diff-like view
      if (tcToolName === 'edit_file' && tcInput?.file_path) {
        return (
          <div className="event-details event-details-scrollable event-details-code-preview">
            <div className="code-preview-header">
              <span className="code-preview-path">{tcInput.file_path}</span>
            </div>
            <div className="edit-diff-preview">
              {tcInput.old_string && (
                <div className="diff-line diff-removed">
                  <span className="diff-marker">-</span>
                  <pre><code>{truncateForDisplay(tcInput.old_string, 500)}</code></pre>
                </div>
              )}
              {tcInput.new_string && (
                <div className="diff-line diff-added">
                  <span className="diff-marker">+</span>
                  <pre><code>{truncateForDisplay(tcInput.new_string, 500)}</code></pre>
                </div>
              )}
            </div>
          </div>
        );
      }

      // Default: formatted JSON
      return (
        <div className="event-details event-details-scrollable">
          <pre>{truncateForDisplay(JSON.stringify(tcInput, null, 2))}</pre>
        </div>
      );
    }
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
              {event.payload.message.replace(/\[\[speak\]\]([\s\S]*?)\[\[\/speak\]\]/gi, '$1')}
            </ReactMarkdown>
          </div>
          <div className="message-actions">
            <MessageCopyButton text={event.payload.message} />
            <MessageSpeakButton text={event.payload.message} voiceEnabled={voiceEnabled} />
          </div>
        </div>
      );
    case 'step_failed':
      return (
        <div className="event-details" style={{ background: 'rgba(239, 68, 68, 0.1)', borderColor: 'rgba(239, 68, 68, 0.2)' }}>
          {event.payload?.reason || event.payload?.step?.error || 'Step failed.'}
        </div>
      );
    case 'file_created': {
      const fcPayload = event.payload;
      const fcPath = fcPayload?.path;
      const fcIsImage =
        fcPayload?.type === 'image' ||
        (typeof fcPayload?.mimeType === 'string' && fcPayload.mimeType.toLowerCase().startsWith('image/')) ||
        imageExt.test(String(fcPath || ''));

      if (fcIsImage && fcPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlineImagePreview filePath={fcPath} workspacePath={workspacePath} onOpenViewer={onOpenViewer} />
          </div>
        );
      }

      // Content preview for text file writes
      if (fcPayload?.contentPreview) {
        const previewLineCount = fcPayload.contentPreview.split('\n').length;
        return (
          <div className="event-details event-details-scrollable event-details-code-preview">
            <div className="code-preview-header">
              <span className="code-preview-language">{fcPayload.language || 'text'}</span>
              {fcPayload.previewTruncated && (
                <span className="code-preview-truncated">
                  showing first {previewLineCount} of {fcPayload.lineCount} lines
                </span>
              )}
            </div>
            <pre className="code-preview-content"><code>{fcPayload.contentPreview}</code></pre>
          </div>
        );
      }

      // Copy source info
      if (fcPayload?.copiedFrom) {
        return (
          <div className="event-details">
            Copied from: <ClickableFilePath path={fcPayload.copiedFrom} workspacePath={workspacePath} onOpenViewer={onOpenViewer} />
          </div>
        );
      }

      return null;
    }
    case 'file_modified': {
      const fmPayload = event.payload;
      const fmPath = fmPayload?.path || fmPayload?.from;
      const fmIsImage =
        fmPayload?.type === 'image' ||
        (typeof fmPayload?.mimeType === 'string' && fmPayload.mimeType.toLowerCase().startsWith('image/')) ||
        imageExt.test(String(fmPath || ''));

      if (fmIsImage && fmPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlineImagePreview filePath={fmPath} workspacePath={workspacePath} onOpenViewer={onOpenViewer} />
          </div>
        );
      }

      // Edit diff preview
      if (fmPayload?.type === 'edit' && (fmPayload?.oldPreview || fmPayload?.newPreview)) {
        return (
          <div className="event-details event-details-scrollable event-details-code-preview">
            <div className="edit-diff-preview">
              {fmPayload.oldPreview && (
                <div className="diff-line diff-removed">
                  <span className="diff-marker">-</span>
                  <pre><code>{fmPayload.oldPreview}</code></pre>
                </div>
              )}
              {fmPayload.newPreview && (
                <div className="diff-line diff-added">
                  <span className="diff-marker">+</span>
                  <pre><code>{fmPayload.newPreview}</code></pre>
                </div>
              )}
            </div>
          </div>
        );
      }

      // Rename info
      if (fmPayload?.action === 'rename' && fmPayload?.from && fmPayload?.to) {
        return (
          <div className="event-details">
            <ClickableFilePath path={fmPayload.from} workspacePath={workspacePath} onOpenViewer={onOpenViewer} />
            {' → '}
            <ClickableFilePath path={fmPayload.to} workspacePath={workspacePath} onOpenViewer={onOpenViewer} />
          </div>
        );
      }

      return null;
    }
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
