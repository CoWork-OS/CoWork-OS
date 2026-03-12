import { memo, useState, useEffect, useRef, useCallback, useMemo, Fragment, Children } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkBreaks from "remark-breaks";
import hljs from "highlight.js";
import mermaid from "mermaid";
import {
  Task,
  TaskEvent,
  Workspace,
  LLMModelInfo,
  CustomSkill,
  EventType,
  DEFAULT_QUIRKS,
  CanvasSession,
  isTempWorkspaceId,
  ImageAttachment,
  AgentTeamRun,
  MultiLlmConfig,
  StepFeedbackAction,
  ExecutionMode,
  TaskDomain,
  InputRequest,
} from "../../shared/types";
import { parseLeadingSkillSlashCommand } from "../../shared/skill-slash-commands";
import { CollaborativeThoughtsPanel } from "./CollaborativeThoughtsPanel";
import { DispatchedAgentsPanel } from "./DispatchedAgentsPanel";
import { MultiLlmSelectionPanel } from "./MultiLlmSelectionPanel";
import { isVerificationStepDescription } from "../../shared/plan-utils";
import type { AgentRoleData } from "../../electron/preload";
import { useVoiceInput } from "../hooks/useVoiceInput";
import { useVoiceTalkMode } from "../hooks/useVoiceTalkMode";
import { useAgentContext, type AgentContext } from "../hooks/useAgentContext";
import { getMessage } from "../utils/agentMessages";
import {
  hasTaskOutputs,
  resolveTaskOutputSummaryFromCompletionEvent,
} from "../utils/task-outputs";
import {
  ALWAYS_VISIBLE_TECHNICAL_EVENT_TYPES,
  shouldShowTaskEventInSummaryMode,
} from "../utils/task-event-visibility";
import { normalizeEventsForTimelineUi } from "../utils/timeline-projection";
import { getEffectiveTaskEventType } from "../utils/task-event-compat";
import {
  ATTACHMENT_CONTENT_END_MARKER,
  ATTACHMENT_CONTENT_START_MARKER,
  MAX_IMAGE_OCR_CHARS,
  buildImageAttachmentViewerOptions,
  extractAttachmentNames,
  stripHtmlForText,
  stripPptxBubbleContent,
  truncateTextForTaskPrompt,
} from "./utils/attachment-content";
import { sanitizeToolCallTextFromAssistant } from "../../shared/tool-call-text-sanitizer";

const CODE_PREVIEWS_EXPANDED_KEY = "cowork:codePreviewsExpanded";
const TASK_TITLE_MAX_LENGTH = 50;
const TITLE_ELLIPSIS_REGEX = /(\.\.\.|\u2026)$/u;
const MAX_ATTACHMENTS = 10;
const ACTIVE_WORK_SIGNAL_WINDOW_MS = 30_000;
const ACTIVE_WORK_EVENT_TYPES: EventType[] = [
  "executing",
  "step_started",
  "step_completed",
  "progress_update",
  "tool_call",
  "tool_result",
  "verification_started",
  "retry_started",
  "llm_streaming",
];

// In non-verbose mode, hide verification noise (verification steps are still executed by the agent).
const isVerificationNoiseEvent = (event: TaskEvent): boolean => {
  const effectiveType = getEffectiveTaskEventType(event);
  if (effectiveType === "assistant_message") {
    return event.payload?.internal === true;
  }

  if (
    event.type === "timeline_step_started" ||
    event.type === "timeline_step_finished" ||
    effectiveType === "step_started" ||
    effectiveType === "step_completed"
  ) {
    return isVerificationStepDescription(event.payload?.step?.description);
  }

  // Verification events are shown on failure; success is kept quiet.
  if (effectiveType === "verification_started" || effectiveType === "verification_passed") {
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
  attachments: ImportedAttachment[],
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
          },
        );

        if (!result.success || !result.data) continue;

        const fileType = result.data.fileType;
        if (fileType === "unsupported") continue;
        if (fileType === "image" && !result.data.ocrText?.trim()) continue;

        let content = fileType === "image" ? (result.data.ocrText ?? null) : result.data.content;
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

  const base = text.trim() || "Please review the attached files.";
  const attachmentSummaryLines = attachments.map((attachment) => {
    const lines = [`- ${attachment.fileName} (${attachment.relativePath})`];
    const extracted = extractedByPath[attachment.relativePath];
    if (extracted) {
      lines.push("  Extracted content:");
      lines.push(`  ${ATTACHMENT_CONTENT_START_MARKER}`);
      for (const row of extracted.split("\n")) {
        lines.push(`    ${row}`);
      }
      lines.push(`  ${ATTACHMENT_CONTENT_END_MARKER}`);
    }
    return lines.join("\n");
  });

  const summary =
    attachmentSummaryLines.length === 0
      ? ""
      : `Attached files (relative to workspace):\n${attachmentSummaryLines.join("\n\n")}`;
  return {
    message: summary ? `${base}\n\n${summary}` : base,
    extractionWarnings,
  };
};

type MentionOption = {
  type: "agent" | "everyone";
  id: string;
  label: string;
  description?: string;
  icon?: string;
  color?: string;
};

type SlashCommandOption = {
  id: string;
  name: string;
  description: string;
  icon: string;
  hasParams: boolean;
  skill: CustomSkill;
};

const normalizeMentionSearch = (value: string): string =>
  value.toLowerCase().replace(/[^a-z0-9]/g, "");
import { SkillParameterModal } from "./SkillParameterModal";
import { FileViewer } from "./FileViewer";
import { ThemeIcon } from "./ThemeIcon";
import {
  BookIcon,
  CalendarIcon,
  ChartIcon,
  ClipboardIcon,
  CodeIcon,
  EditIcon,
  FileTextIcon,
  FolderIcon,
  GlobeIcon,
  MessageIcon,
  SearchIcon,
  ShieldIcon,
  SlidersIcon,
  UsersIcon,
  ZapIcon,
} from "./LineIcons";
import { getEmojiIcon } from "../utils/emoji-icon-map";
import { replaceEmojisInChildren } from "../utils/emoji-replacer";
import { CitationBadge } from "./CitationPanel";
import { CommandOutput } from "./CommandOutput";
import { CanvasPreview } from "./CanvasPreview";
import { InlineImagePreview } from "./InlineImagePreview";
import { InlineSpreadsheetPreview } from "./InlineSpreadsheetPreview";
import { InlineDocumentPreview } from "./InlineDocumentPreview";
import { StepFeed } from "./timeline/StepFeed";
import { ParallelGroupFeed } from "./timeline/ParallelGroupFeed";
import { buildParallelGroupProjection } from "./timeline/parallel-group-projection";
import {
  resolveTimelineIndicator,
  shouldShowTimelineBranchStub,
} from "./timeline/timeline-indicators";
import { getStepCompletionPreviewPath } from "../utils/step-document-preview";

// Mermaid diagram component
let mermaidInitialized = false;
function initMermaid() {
  if (!mermaidInitialized) {
    mermaid.initialize({
      startOnLoad: false,
      theme: "dark",
      securityLevel: "strict",
      fontFamily: "inherit",
    });
    mermaidInitialized = true;
  }
}

function sanitizeMermaidSvg(svgMarkup: string): SVGSVGElement | null {
  const parser = new DOMParser();
  const doc = parser.parseFromString(svgMarkup, "image/svg+xml");
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== "svg") {
    return null;
  }

  for (const element of Array.from(root.querySelectorAll("*"))) {
    const tagName = element.tagName.toLowerCase();
    if (tagName === "script" || tagName === "foreignobject") {
      element.remove();
      continue;
    }
    for (const attr of Array.from(element.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.trim();
      if (name.startsWith("on")) {
        element.removeAttribute(attr.name);
        continue;
      }
      if ((name === "href" || name === "xlink:href") && /^javascript:/i.test(value)) {
        element.removeAttribute(attr.name);
      }
    }
  }

  return root as unknown as SVGSVGElement;
}

function MermaidDiagram({ chart }: { chart: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [svg, setSvg] = useState<string | null>(null);
  const idRef = useRef(`mermaid-${Math.random().toString(36).slice(2)}`);

  useEffect(() => {
    initMermaid();
    let cancelled = false;
    setError(null);
    setSvg(null);
    mermaid
      .render(idRef.current, chart)
      .then(({ svg: rendered }) => {
        if (!cancelled) setSvg(rendered);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || "Failed to render diagram");
      });
    return () => {
      cancelled = true;
    };
  }, [chart]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    container.replaceChildren();
    if (!svg) return;
    const sanitizedSvg = sanitizeMermaidSvg(svg);
    if (!sanitizedSvg) {
      setError("Failed to render diagram");
      return;
    }
    container.appendChild(document.importNode(sanitizedSvg, true));
  }, [svg]);

  if (error) {
    return (
      <div className="mermaid-error">
        <span>Diagram error: {error}</span>
      </div>
    );
  }

  return (
    svg ? (
      <div className="mermaid-diagram" ref={containerRef} />
    ) : (
      <div className="mermaid-diagram">
        <span className="mermaid-loading">Rendering diagram…</span>
      </div>
    )
  );
}

// Code block component with copy button
interface CodeBlockProps {
  children?: React.ReactNode;
  className?: string;
  node?: unknown;
}

function CodeBlock({ children, className, ...props }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  // Check if this is a code block (has language class) vs inline code
  const isCodeBlock = className?.startsWith("language-");
  const language = className?.replace("language-", "") || "";

  // Get the text content for copying
  const getTextContent = (node: React.ReactNode): string => {
    if (typeof node === "string") return node;
    if (Array.isArray(node)) return node.map(getTextContent).join("");
    if (node && typeof node === "object" && "props" in node) {
      return getTextContent((node as { props: { children?: React.ReactNode } }).props.children);
    }
    return "";
  };

  const handleCopy = async () => {
    const text = getTextContent(children);
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  // For inline code, just render normally
  if (!isCodeBlock) {
    return (
      <code className={className} {...props}>
        {children}
      </code>
    );
  }

  // Render mermaid diagrams inline
  const codeText = getTextContent(children);
  if (language === "mermaid") {
    return <MermaidDiagram chart={codeText} />;
  }

  // Compute highlighted HTML
  const highlightedHtml = useMemo(() => highlightCode(codeText, language), [codeText, language]);

  // For code blocks, wrap with copy button
  return (
    <div className="code-block-wrapper">
      <div className="code-block-header">
        {language && <span className="code-block-language">{language}</span>}
        <button
          className={`code-block-copy ${copied ? "copied" : ""}`}
          onClick={handleCopy}
          title={copied ? "Copied!" : "Copy code"}
        >
          {copied ? (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <path d="M20 6L9 17l-5-5" />
            </svg>
          ) : (
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
              <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
            </svg>
          )}
          <span>{copied ? "Copied!" : "Copy"}</span>
        </button>
      </div>
      {highlightedHtml ? (
        <code
          className={`hljs ${className || ""}`}
          {...props}
          dangerouslySetInnerHTML={{ __html: highlightedHtml }}
        />
      ) : (
        <code className={className} {...props}>
          {children}
        </code>
      )}
    </div>
  );
}

// Utility: highlight a code string with hljs (pure function, no hooks)
function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function sanitizeHighlightedHtml(html: string): string {
  if (!html) return "";
  if (typeof DOMParser === "undefined") {
    return escapeHtml(html);
  }

  const parser = new DOMParser();
  const parsed = parser.parseFromString(`<div>${html}</div>`, "text/html");
  const sourceRoot = parsed.body.firstElementChild;
  if (!sourceRoot) {
    return "";
  }

  const outputDoc = parser.parseFromString("<div></div>", "text/html");
  const outputRoot = outputDoc.body.firstElementChild as HTMLElement;

  const appendSanitized = (node: ChildNode, parent: HTMLElement): void => {
    if (node.nodeType === 3) {
      parent.appendChild(outputDoc.createTextNode(node.textContent || ""));
      return;
    }
    if (node.nodeType !== 1) return;

    const element = node as HTMLElement;
    const tag = element.tagName.toLowerCase();

    if (tag === "span") {
      const span = outputDoc.createElement("span");
      const classes = (element.getAttribute("class") || "")
        .split(/\s+/)
        .map((name) => name.trim())
        .filter((name) => /^hljs(?:-[a-z0-9_-]+)?$/i.test(name));
      if (classes.length > 0) {
        span.setAttribute("class", classes.join(" "));
      }
      for (const child of Array.from(element.childNodes)) {
        appendSanitized(child, span);
      }
      parent.appendChild(span);
      return;
    }

    if (tag === "br") {
      parent.appendChild(outputDoc.createElement("br"));
      return;
    }

    for (const child of Array.from(element.childNodes)) {
      appendSanitized(child, parent);
    }
  };

  for (const child of Array.from(sourceRoot.childNodes)) {
    appendSanitized(child, outputRoot);
  }

  return outputRoot.innerHTML;
}

function highlightCode(code: string, language?: string): string | null {
  if (!code) return null;
  if (language && hljs.getLanguage(language)) {
    try {
      return sanitizeHighlightedHtml(hljs.highlight(code, { language }).value);
    } catch {
      // fall through
    }
  }
  try {
    return sanitizeHighlightedHtml(hljs.highlightAuto(code).value);
  } catch {
    return null;
  }
}

// Highlighted code preview for file creation/modification events
function HighlightedCodePreview({ code, language }: { code: string; language?: string }) {
  const html = useMemo(() => highlightCode(code, language), [code, language]);
  if (html) {
    return (
      <pre className="code-preview-content">
        <code className="hljs" dangerouslySetInnerHTML={{ __html: html }} />
      </pre>
    );
  }
  return (
    <pre className="code-preview-content">
      <code>{code}</code>
    </pre>
  );
}

// Copy button for user messages
const MessageCopyButton = memo(function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  return (
    <button
      className={`message-copy-btn ${copied ? "copied" : ""}`}
      onClick={handleCopy}
      title={copied ? "Copied!" : "Copy message"}
    >
      {copied ? (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <path d="M20 6L9 17l-5-5" />
        </svg>
      ) : (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
          <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
        </svg>
      )}
      <span>{copied ? "Copied" : "Copy"}</span>
    </button>
  );
});

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
        className={`chat-bubble user-bubble markdown-content${!collapsed ? " expanded" : ""}`}
        onClick={() => {
          if (collapsed) setExpanded(true);
        }}
      >
        {children}
        {collapsed && <div className="user-bubble-fade" />}
      </div>
      {needsCollapse && (
        <button className="user-bubble-expand-btn" onClick={() => setExpanded(!expanded)}>
          {collapsed ? "Show more" : "Show less"}
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
const MessageSpeakButton = memo(function MessageSpeakButton({
  text,
  voiceEnabled,
}: {
  text: string;
  voiceEnabled: boolean;
}) {
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
        .replace(/```[\s\S]*?```/g, "") // Remove code blocks
        .replace(/`[^`]+`/g, "") // Remove inline code
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1") // Keep link text only
        .replace(/!\[([^\]]*)\]\([^)]+\)/g, "") // Remove images
        .replace(/^#{1,6}\s+/gm, "") // Remove headers
        .replace(/\*\*([^*]+)\*\*/g, "$1") // Remove bold
        .replace(/\*([^*]+)\*/g, "$1") // Remove italic
        .replace(/\[\[speak\]\]([\s\S]*?)\[\[\/speak\]\]/gi, "$1") // Extract speak tags
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
          console.error("TTS failed:", result.error);
        }
      }
    } catch (err) {
      console.error("Failed to speak:", err);
    } finally {
      setLoading(false);
    }
  };

  if (!voiceEnabled) return null;

  return (
    <button
      className={`message-speak-btn ${speaking ? "speaking" : ""}`}
      onClick={handleClick}
      title={speaking ? "Stop speaking" : loading ? "Loading..." : "Speak message"}
      disabled={loading}
    >
      {speaking ? (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="currentColor"
          stroke="currentColor"
          strokeWidth="2"
        >
          <rect x="4" y="4" width="16" height="16" rx="2" />
        </svg>
      ) : loading ? (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className="spin"
        >
          <circle cx="12" cy="12" r="10" strokeDasharray="32" strokeDashoffset="12" />
        </svg>
      ) : (
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <polygon points="11 5 6 9 2 9 2 15 6 15 11 19 11 5" />
          <path d="M15.54 8.46a5 5 0 0 1 0 7.07" />
          <path d="M19.07 4.93a10 10 0 0 1 0 14.14" />
        </svg>
      )}
      <span>{speaking ? "Stop" : loading ? "Loading" : "Speak"}</span>
    </button>
  );
});

const HEADING_EMOJI_REGEX = /^([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}][\uFE0F\uFE0E]?)(\s+)?/u;

const normalizeCommitmentText = (value: unknown): string | null => {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }

  if (!value || typeof value !== "object") return null;
  const entry = value as { text?: unknown; title?: unknown; name?: unknown };
  const textValue =
    typeof entry.text === "string"
      ? entry.text
      : typeof entry.title === "string"
        ? entry.title
        : typeof entry.name === "string"
          ? entry.name
          : null;

  if (!textValue) return null;
  const trimmed = textValue.trim();
  return trimmed.length > 0 ? trimmed : null;
};

const getHeadingIcon = (emoji: string): React.ReactNode | null => {
  const Icon = getEmojiIcon(emoji);
  if (!Icon) return null;
  return <Icon size={16} strokeWidth={1.8} />;
};

const renderHeading = (Tag: "h1" | "h2" | "h3") => {
  return ({ children, ...props }: Any) => {
    const nodes = Children.toArray(children);
    if (typeof nodes[0] === "string") {
      const match = (nodes[0] as string).match(HEADING_EMOJI_REGEX);
      if (match) {
        const emoji = match[1];
        const icon = getHeadingIcon(emoji);
        if (icon) {
          nodes[0] = (nodes[0] as string).slice(match[0].length);
          return (
            <Tag {...props}>
              <span className="markdown-heading-icon">{icon}</span>
              {nodes}
            </Tag>
          );
        }
      }
    }
    return <Tag {...props}>{nodes}</Tag>;
  };
};

const isExternalHttpLink = (href: string): boolean =>
  href.startsWith("http://") || href.startsWith("https://");

const FILE_EXTENSIONS = new Set([
  "txt",
  "md",
  "markdown",
  "pdf",
  "doc",
  "docx",
  "xls",
  "xlsx",
  "csv",
  "tsv",
  "ppt",
  "pptx",
  "json",
  "yaml",
  "yml",
  "xml",
  "html",
  "htm",
  "js",
  "ts",
  "tsx",
  "jsx",
  "css",
  "scss",
  "less",
  "sass",
  "py",
  "rb",
  "go",
  "rs",
  "java",
  "kt",
  "swift",
  "cpp",
  "c",
  "h",
  "hpp",
  "sh",
  "bash",
  "zsh",
  "ps1",
  "toml",
  "ini",
  "env",
  "lock",
  "log",
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "svg",
  "bmp",
  "tiff",
  "mp3",
  "wav",
  "m4a",
  "mp4",
  "mov",
  "avi",
  "mkv",
  "zip",
  "tar",
  "gz",
  "tgz",
  "rar",
  "7z",
]);

const getTextContent = (node: React.ReactNode): string => {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(getTextContent).join("");
  if (node && typeof node === "object" && "props" in node) {
    return getTextContent((node as { props: { children?: React.ReactNode } }).props.children);
  }
  return "";
};

const stripHttpScheme = (value: string): string => value.replace(/^https?:\/\//, "");
const HTML_TAG_REGEX = /<[^>]*>/g;
const URLISH_TEXT_REGEX = /^(?:https?:\/\/|www\.|(?:[a-z0-9-]+\.)+[a-z]{2,}\/)/i;

const stripHtmlTags = (value: string): string =>
  String(value || "")
    .replace(HTML_TAG_REGEX, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/\s+/g, " ")
    .trim();

const extractDomainFromUrl = (raw: string): string => {
  const trimmed = String(raw || "").trim();
  if (!trimmed) return "";
  try {
    const parsed = new URL(trimmed.startsWith("http://") || trimmed.startsWith("https://") ? trimmed : `https://${trimmed}`);
    return parsed.hostname.replace(/^www\./i, "");
  } catch {
    return stripHttpScheme(trimmed).split("/")[0].replace(/^www\./i, "");
  }
};

const isUrlLikeLabel = (value: string): boolean => URLISH_TEXT_REGEX.test(String(value || "").trim());

const looksLikeLocalFilePath = (value: string): boolean => {
  const trimmed = value.trim();
  if (!trimmed) return false;
  if (trimmed.startsWith("#")) return false;
  if (trimmed.startsWith("file://")) return true;
  if (trimmed.startsWith("mailto:") || trimmed.startsWith("tel:")) return false;
  if (trimmed.includes("://") || trimmed.startsWith("www.")) return false;
  if (trimmed.includes("@")) return false;
  if (
    trimmed.startsWith("./") ||
    trimmed.startsWith("../") ||
    trimmed.startsWith("~/") ||
    trimmed.startsWith("/")
  )
    return true;
  if (/^[a-zA-Z]:[\\/]/.test(trimmed)) return true;
  if (trimmed.includes("/") || trimmed.includes("\\")) return true;
  const extMatch = trimmed.match(/\.([a-zA-Z0-9]{1,8})$/);
  if (!extMatch) return false;
  return FILE_EXTENSIONS.has(extMatch[1].toLowerCase());
};

const isFileLink = (href: string): boolean => {
  if (!href) return false;
  if (href.startsWith("#")) return false;
  if (isExternalHttpLink(href)) return false;
  if (href.startsWith("mailto:") || href.startsWith("tel:")) return false;
  if (href.startsWith("file://")) return true;
  if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) return false;
  return true;
};

const normalizeFileHref = (href: string): string => {
  if (!href) return href;
  if (href.startsWith("file://")) {
    const rawPath = href.replace(/^file:\/\//, "");
    const decoded = (() => {
      try {
        return decodeURIComponent(rawPath);
      } catch {
        return rawPath;
      }
    })();
    return decoded.replace(/^\/([a-zA-Z]:\/)/, "$1").split(/[?#]/)[0];
  }
  return href.split(/[?#]/)[0];
};

const resolveFileLinkTarget = (href: string, linkText: string): string | null => {
  const trimmedText = linkText.trim();
  const trimmedHref = href.trim();

  if (looksLikeLocalFilePath(trimmedText)) {
    const strippedHref = stripHttpScheme(trimmedHref).replace(/\/$/, "");
    if (trimmedHref === trimmedText || strippedHref === trimmedText) {
      return normalizeFileHref(trimmedText);
    }
  }

  if (looksLikeLocalFilePath(trimmedHref)) {
    return normalizeFileHref(trimmedHref);
  }

  return null;
};

const CITATION_REF_REGEX = /\[(\d+)\]/g;

/**
 * Matches bare domain URLs (e.g. "example.com/path") that are NOT already
 * inside a markdown link. Only targets strings that look like domain.tld/...
 */
const BARE_URL_REGEX =
  /(?<!\(|\[)(?:^|(?<=\s))((?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}\/[^\s)\]]+)/gi;
const GLOB_TOKEN_REGEX = /(?<![`\\])\*\*\/\*[^\s,;()]+/g;
const FENCED_CODE_BLOCK_REGEX = /(```[\s\S]*?```)/g;
const JSON_PATH_PAYLOAD_LINE_REGEX = /^(\s*)\{\s*"path"\s*:\s*"((?:\\.|[^"\\])*)"\s*\}(\s*)$/;
const SOURCES_HEADING_REGEX = /(^|\n)(?:#{1,6}\s*)?sources\b[^\n]*(?:\n|$)/i;
const SOURCE_ENTRY_INLINE_SPLIT_REGEX =
  /\s+(\[\d+\]\s*(?:(?:\[[^\]]+\]\([^)]+\))|https?:\/\/))/gi;
const SOURCE_ENTRY_DETECT_REGEX =
  /\[\d+\]\s*(?:(?:\[[^\]]+\]\([^)]+\))|https?:\/\/\S+)/i;

/**
 * Pre-process assistant message text to convert bare domain URLs into markdown links.
 * e.g. "spectrum.ieee.org/quantum" → "[spectrum.ieee.org/quantum](https://spectrum.ieee.org/quantum)"
 */
function autolinkBareUrls(text: string): string {
  return text.replace(BARE_URL_REGEX, (_match, url) => {
    return `[${url}](https://${url})`;
  });
}

/** Keep glob-style path patterns literal when rendering markdown. */
function protectGlobTokens(text: string): string {
  return text.replace(GLOB_TOKEN_REGEX, (token) => `\`${token}\``);
}

function transformOutsideFencedCodeBlocks(text: string, transform: (segment: string) => string): string {
  return text
    .split(FENCED_CODE_BLOCK_REGEX)
    .map((segment, index) => (index % 2 === 1 ? segment : transform(segment)))
    .join("");
}

function escapeMarkdownLinkText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function escapeMarkdownHref(href: string): string {
  return encodeURI(href).replace(/\(/g, "%28").replace(/\)/g, "%29");
}

function autolinkJsonPathPayloadLines(text: string): string {
  return transformOutsideFencedCodeBlocks(text, (segment) =>
    segment
      .split("\n")
      .map((line) => {
        const match = line.match(JSON_PATH_PAYLOAD_LINE_REGEX);
        if (!match) return line;

        const [, leadingWhitespace, encodedPath, trailingWhitespace] = match;
        let pathValue: string;
        try {
          pathValue = JSON.parse(`"${encodedPath}"`);
        } catch {
          return line;
        }
        const normalizedPath = pathValue.trim();
        if (!normalizedPath || !looksLikeLocalFilePath(normalizedPath)) return line;

        return `${leadingWhitespace}[${escapeMarkdownLinkText(normalizedPath)}](${escapeMarkdownHref(normalizedPath)})${trailingWhitespace}`;
      })
      .join("\n"),
  );
}

/**
 * In a "Sources" section, force each numbered source entry onto its own line.
 * Example: "[1] ... [2] ..." -> "[1] ...  \n[2] ..."
 */
function normalizeSourcesSection(text: string): string {
  const heading = SOURCES_HEADING_REGEX.exec(text);
  if (!heading) return text;

  const headingStart = heading.index + (heading[1] ? heading[1].length : 0);
  const headingLineEnd = text.indexOf("\n", headingStart);
  if (headingLineEnd === -1) return text;

  const sectionStart = headingLineEnd + 1;
  const remainder = text.slice(sectionStart);
  const nextHeading = /\n#{1,6}\s+\S/.exec(remainder);
  const sectionEnd = nextHeading ? sectionStart + nextHeading.index + 1 : text.length;
  const sectionBody = text.slice(sectionStart, sectionEnd);
  if (!SOURCE_ENTRY_DETECT_REGEX.test(sectionBody)) return text;

  const normalizedSectionBody = sectionBody
    .replace(SOURCE_ENTRY_INLINE_SPLIT_REGEX, "  \n$1")
    .trimStart();

  return `${text.slice(0, sectionStart)}${normalizedSectionBody}${text.slice(sectionEnd)}`;
}

function normalizeMarkdownForDisplay(text: string): string {
  const sanitized = sanitizeToolCallTextFromAssistant(text).text;
  return normalizeSourcesSection(autolinkJsonPathPayloadLines(protectGlobTokens(sanitized)));
}

function normalizeTimelineTitleMarkdownForDisplay(text: string): string {
  // Timeline titles should stay compact inline text; escape ATX headings so
  // shell comments like "# route check ..." are not rendered as <h1>.
  return normalizeMarkdownForDisplay(text).replace(
    /^( {0,3})(#{1,6})(?=\s)/gm,
    (_match: string, indent: string, hashes: string) =>
      `${indent}${hashes.replace(/#/g, "\\#")}`,
  );
}

function cleanAssistantMessageForDisplay(message: string): string {
  return normalizeMarkdownForDisplay(
    String(message || "")
      .replace(/\[\[speak\]\]([\s\S]*?)\[\[\/speak\]\]/gi, "$1")
      .replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, "")
      .replace(/<tool_result>[\s\S]*?<\/tool_result>/gi, "")
      .trim(),
  );
}

const buildMarkdownComponents = (options: {
  workspacePath?: string;
  onOpenViewer?: (path: string) => void;
  citations?: Array<{ index: number; url: string; title: string; snippet: string; domain: string; accessedAt: number; sourceTool: string }>;
}) => {
  const { workspacePath, onOpenViewer, citations } = options;

  /** Map citation index → citation for O(1) lookup */
  const citationMap = new Map(
    (citations || []).map((c) => [c.index, c]),
  );

  /** Map normalised citation URL → citation for enriched link rendering */
  const citationUrlMap = new Map(
    (citations || []).map((c) => [c.url.replace(/\/+$/, "").toLowerCase(), c]),
  );

  const MarkdownLink = ({ href, children, ...props }: Any) => {
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
            console.error("Failed to open file:", error);
          }
        } catch (err) {
          console.error("Error opening file:", err);
        }
      };

      const handleContextMenu = async (e: React.MouseEvent) => {
        e.preventDefault();
        e.stopPropagation();
        if (!workspacePath) return;
        try {
          await window.electronAPI.showInFinder(filePath, workspacePath);
        } catch (err) {
          console.error("Error showing in Finder:", err);
        }
      };

      return (
        <a
          {...props}
          href={href}
          className={`clickable-file-path ${props.className || ""}`.trim()}
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
          console.error("Error opening link:", err);
        }
      };

      // Check if this link matches a citation — render an enriched card
      const normHref = href.replace(/\/+$/, "").toLowerCase();
      const matchedCitation = citationUrlMap.get(normHref);
      const matchedCitationUrl =
        matchedCitation && typeof matchedCitation.url === "string" ? matchedCitation.url : href;
      const matchedCitationTitle =
        matchedCitation && typeof matchedCitation.title === "string"
          ? stripHtmlTags(matchedCitation.title)
          : "";
      const matchedCitationDomain =
        matchedCitation && typeof matchedCitation.domain === "string"
          ? stripHtmlTags(matchedCitation.domain)
          : "";
      const shouldRenderCitationCard =
        !!matchedCitation &&
        matchedCitationTitle.length > 0 &&
        matchedCitationTitle !== matchedCitationUrl &&
        !isUrlLikeLabel(linkText);

      if (shouldRenderCitationCard) {
        const citationDomain = matchedCitationDomain || extractDomainFromUrl(matchedCitationUrl);
        return (
          <a
            {...props}
            href={href}
            onClick={handleClick}
            className="citation-source-link"
            title={matchedCitationUrl}
            style={{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              padding: "3px 8px",
              borderRadius: 6,
              background: "var(--surface-secondary, #1a1a1a)",
              border: "1px solid var(--border-color, #333)",
              textDecoration: "none",
              color: "inherit",
              transition: "background 0.15s, border-color 0.15s",
              maxWidth: "100%",
            }}
            onMouseEnter={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.background =
                "var(--surface-hover, rgba(255,255,255,0.08))";
              (e.currentTarget as HTMLAnchorElement).style.borderColor =
                "var(--accent-color, #60a5fa)";
            }}
            onMouseLeave={(e) => {
              (e.currentTarget as HTMLAnchorElement).style.background =
                "var(--surface-secondary, #1a1a1a)";
              (e.currentTarget as HTMLAnchorElement).style.borderColor =
                "var(--border-color, #333)";
            }}
          >
            <img
              src={`https://www.google.com/s2/favicons?domain=${citationDomain}&sz=16`}
              alt=""
              width={14}
              height={14}
              style={{ borderRadius: 2, flexShrink: 0 }}
              onError={(e) => {
                (e.target as HTMLImageElement).style.display = "none";
              }}
            />
            <span style={{ minWidth: 0 }}>
              <span
                style={{
                  display: "block",
                  fontSize: 12,
                  fontWeight: 500,
                  color: "var(--text-primary, #e5e5e5)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {matchedCitationTitle}
              </span>
              <span
                style={{
                  display: "block",
                  fontSize: 10,
                  color: "var(--text-tertiary, #666)",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {citationDomain}
              </span>
            </span>
          </a>
        );
      }

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

  /**
   * Replace citation references like [1], [2] in text children with
   * interactive CitationBadge components.
   */
  const replaceCitationsInChildren = (children: React.ReactNode): React.ReactNode => {
    if (citationMap.size === 0) return replaceEmojisInChildren(children);

    return Children.map(children, (child) => {
      if (typeof child === "string") {
        const parts: React.ReactNode[] = [];
        let lastIndex = 0;

        CITATION_REF_REGEX.lastIndex = 0;
        let match: RegExpExecArray | null;
        while ((match = CITATION_REF_REGEX.exec(child)) !== null) {
          const idx = parseInt(match[1], 10);
          const citation = citationMap.get(idx);
          if (!citation) continue;

          if (match.index > lastIndex) {
            parts.push(child.slice(lastIndex, match.index));
          }
          parts.push(
            <CitationBadge key={`cite-${idx}-${match.index}`} index={idx} citation={citation} />,
          );
          lastIndex = match.index + match[0].length;
        }

        if (parts.length === 0) return replaceEmojisInChildren(child);

        if (lastIndex < child.length) {
          parts.push(child.slice(lastIndex));
        }
        return <>{parts.map((p) => (typeof p === "string" ? replaceEmojisInChildren(p) : p))}</>;
      }
      return child;
    });
  };

  // Custom components for ReactMarkdown
  return {
    code: CodeBlock,
    h1: renderHeading("h1"),
    h2: renderHeading("h2"),
    h3: renderHeading("h3"),
    table: ({ children, ...props }: Any) => (
      <div className="markdown-table-wrapper">
        <table {...props}>{children}</table>
      </div>
    ),
    a: MarkdownLink,
    p: ({ children, ...props }: Any) => <p {...props}>{replaceCitationsInChildren(children)}</p>,
    li: ({ children, ...props }: Any) => <li {...props}>{replaceCitationsInChildren(children)}</li>,
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

function ModelDropdown({
  models,
  selectedModel,
  onModelChange,
  onOpenSettings,
}: ModelDropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [highlightedIndex, setHighlightedIndex] = useState(0);
  const containerRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const selectedModelInfo = models.find((m) => m.key === selectedModel);

  const filteredModels = models.filter(
    (model) =>
      model.displayName.toLowerCase().includes(search.toLowerCase()) ||
      model.key.toLowerCase().includes(search.toLowerCase()) ||
      model.description.toLowerCase().includes(search.toLowerCase()),
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
        highlightedEl.scrollIntoView({ block: "nearest" });
      }
    }
  }, [highlightedIndex, isOpen]);

  // Close on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setIsOpen(false);
        setSearch("");
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (!isOpen) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown") {
        e.preventDefault();
        setIsOpen(true);
      }
      return;
    }

    switch (e.key) {
      case "ArrowDown":
        e.preventDefault();
        setHighlightedIndex((i) => Math.min(i + 1, filteredModels.length - 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setHighlightedIndex((i) => Math.max(i - 1, 0));
        break;
      case "Enter":
        e.preventDefault();
        if (filteredModels[highlightedIndex]) {
          onModelChange(filteredModels[highlightedIndex].key);
          setIsOpen(false);
          setSearch("");
        }
        break;
      case "Escape":
        e.preventDefault();
        setIsOpen(false);
        setSearch("");
        break;
    }
  };

  const handleSelect = (modelKey: string) => {
    onModelChange(modelKey);
    setIsOpen(false);
    setSearch("");
  };

  const handleOpenProviders = () => {
    setIsOpen(false);
    setSearch("");
    onOpenSettings?.("llm");
  };

  return (
    <div className="model-dropdown-container" ref={containerRef}>
      <button
        className={`model-selector ${isOpen ? "open" : ""}`}
        onClick={() => {
          setIsOpen(!isOpen);
          if (!isOpen) {
            setTimeout(() => inputRef.current?.focus(), 0);
          }
        }}
        onKeyDown={handleKeyDown}
      >
        <svg
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M12 3l1.5 4.5L18 9l-4.5 1.5L12 15l-1.5-4.5L6 9l4.5-1.5L12 3z" />
          <path d="M18 14l1 3 3 1-3 1-1 3-1-3-3-1 3-1 1-3z" />
        </svg>
        <span>{selectedModelInfo?.displayName || "Select Model"}</span>
        <svg
          width="12"
          height="12"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          className={isOpen ? "chevron-up" : ""}
        >
          <path d="M6 9l6 6 6-6" />
        </svg>
      </button>
      {isOpen && (
        <div className="model-dropdown">
          <div className="model-dropdown-search">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
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
                  className={`model-dropdown-item ${model.key === selectedModel ? "selected" : ""} ${index === highlightedIndex ? "highlighted" : ""}`}
                  onClick={() => handleSelect(model.key)}
                  onMouseEnter={() => setHighlightedIndex(index)}
                >
                  <div className="model-dropdown-item-content">
                    <span className="model-dropdown-item-name">{model.displayName}</span>
                    <span className="model-dropdown-item-desc">{model.description}</span>
                  </div>
                  {model.key === selectedModel && (
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M20 6L9 17l-5-5" />
                    </svg>
                  )}
                </button>
              ))
            )}
          </div>
          <div className="model-dropdown-footer">
            <button
              type="button"
              className="model-dropdown-provider-btn"
              onClick={handleOpenProviders}
            >
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
  className = "",
  onOpenViewer,
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
        console.error("Failed to open file:", error);
      }
    } catch (err) {
      console.error("Error opening file:", err);
    }
  };

  const handleContextMenu = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      await window.electronAPI.showInFinder(path, workspacePath);
    } catch (err) {
      console.error("Error showing in Finder:", err);
    }
  };

  // Extract filename for display
  const fileName = path.split("/").pop() || path;

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

type InputRequestAnswers = Record<string, { optionLabel?: string; otherText?: string }>;

interface StructuredInputPromptCardProps {
  request: InputRequest;
  onSubmit: (answers: InputRequestAnswers) => void;
  onDismiss: () => void;
}

function StructuredInputPromptCard({ request, onSubmit, onDismiss }: StructuredInputPromptCardProps) {
  const questions = Array.isArray(request.questions) ? request.questions : [];
  const [selectedOptionByQuestion, setSelectedOptionByQuestion] = useState<Record<string, number>>({});
  const [otherTextByQuestion, setOtherTextByQuestion] = useState<Record<string, string>>({});
  const [activeQuestionIndex, setActiveQuestionIndex] = useState(0);

  useEffect(() => {
    const nextSelected: Record<string, number> = {};
    for (const question of questions) {
      if (typeof question?.id === "string" && question.id.trim()) {
        nextSelected[question.id] = 0;
      }
    }
    setSelectedOptionByQuestion(nextSelected);
    setOtherTextByQuestion({});
    setActiveQuestionIndex(0);
  }, [request.id, questions]);

  const updateSelection = useCallback(
    (questionId: string, nextIndex: number) => {
      setSelectedOptionByQuestion((prev) => ({
        ...prev,
        [questionId]: Math.max(0, nextIndex),
      }));
    },
    [],
  );

  const isQuestionAnswered = useCallback(
    (question: InputRequest["questions"][number]) => {
      if (!question || typeof question?.id !== "string") return false;
      const selected = selectedOptionByQuestion[question.id];
      if (typeof selected !== "number") return false;
      const options = Array.isArray(question.options) ? question.options : [];
      const isOther = selected === options.length;
      if (!isOther) return true;
      return (otherTextByQuestion[question.id] || "").trim().length > 0;
    },
    [otherTextByQuestion, selectedOptionByQuestion],
  );

  const activeQuestion = useMemo(() => {
    if (!questions.length) return null;
    const safeIndex = Math.max(0, Math.min(questions.length - 1, activeQuestionIndex));
    return questions[safeIndex] ?? null;
  }, [activeQuestionIndex, questions]);

  const activeOptions = useMemo(
    () => (activeQuestion && Array.isArray(activeQuestion.options) ? activeQuestion.options : []),
    [activeQuestion],
  );
  const activeSelected =
    activeQuestion && typeof selectedOptionByQuestion[activeQuestion.id] === "number"
      ? selectedOptionByQuestion[activeQuestion.id]
      : 0;
  const activeOtherSelected = activeSelected === activeOptions.length;

  const getActiveOptionCount = useCallback(() => activeOptions.length + 1, [activeOptions.length]);

  const goToNextQuestion = useCallback(() => {
    setActiveQuestionIndex((prev) => Math.min(questions.length - 1, prev + 1));
  }, [questions.length]);

  const goToPreviousQuestion = useCallback(() => {
    setActiveQuestionIndex((prev) => Math.max(0, prev - 1));
  }, []);

  const currentQuestionAnswered = useMemo(
    () => (activeQuestion ? isQuestionAnswered(activeQuestion) : false),
    [activeQuestion, isQuestionAnswered],
  );

  const canSubmit = useMemo(
    () => questions.length > 0 && questions.every((question) => isQuestionAnswered(question)),
    [isQuestionAnswered, questions],
  );

  const buildAnswers = useCallback((): InputRequestAnswers => {
    const answers: InputRequestAnswers = {};
    for (const question of questions) {
      const selected = selectedOptionByQuestion[question.id];
      if (typeof selected !== "number") continue;
      if (selected < question.options.length) {
        answers[question.id] = {
          optionLabel: question.options[selected]?.label,
        };
      } else {
        answers[question.id] = {
          otherText: (otherTextByQuestion[question.id] || "").trim(),
        };
      }
    }
    return answers;
  }, [otherTextByQuestion, questions, selectedOptionByQuestion]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (!questions.length || !activeQuestion) return;

      if (event.key === "Escape") {
        event.preventDefault();
        onDismiss();
        return;
      }

      const activeElement = document.activeElement as HTMLElement | null;
      const activeTag = activeElement?.tagName?.toLowerCase();
      const typingInInput = activeTag === "textarea" || activeTag === "input";
      const selected = selectedOptionByQuestion[activeQuestion.id] ?? 0;
      const optionCount = getActiveOptionCount();

      if (/^[1-4]$/.test(event.key) && !typingInInput) {
        const nextIndex = Number(event.key) - 1;
        if (nextIndex < optionCount) {
          event.preventDefault();
          updateSelection(activeQuestion.id, nextIndex);
        }
        return;
      }

      if (event.key === "ArrowUp" && !typingInInput) {
        event.preventDefault();
        updateSelection(activeQuestion.id, Math.max(0, selected - 1));
        return;
      }
      if (event.key === "ArrowDown" && !typingInInput) {
        event.preventDefault();
        updateSelection(activeQuestion.id, Math.min(optionCount - 1, selected + 1));
        return;
      }

      if (event.key === "ArrowLeft" && !typingInInput) {
        event.preventDefault();
        goToPreviousQuestion();
        return;
      }
      if (event.key === "ArrowRight" && !typingInInput) {
        event.preventDefault();
        if (activeQuestionIndex < questions.length - 1 && currentQuestionAnswered) {
          goToNextQuestion();
        }
        return;
      }

      if (event.key === "Enter" && !typingInInput) {
        event.preventDefault();
        if (activeQuestionIndex < questions.length - 1) {
          if (currentQuestionAnswered) {
            goToNextQuestion();
          }
          return;
        }
        if (canSubmit) {
          onSubmit(buildAnswers());
        }
      }
    };

    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [
    activeQuestion,
    activeQuestionIndex,
    buildAnswers,
    canSubmit,
    currentQuestionAnswered,
    getActiveOptionCount,
    goToNextQuestion,
    goToPreviousQuestion,
    onDismiss,
    onSubmit,
    questions,
    selectedOptionByQuestion,
    updateSelection,
  ]);

  if (!activeQuestion) {
    return null;
  }

  return (
    <div className="input-request-composer-shell" role="dialog" aria-modal="true" aria-label="Structured input required">
      <div className="input-request-card input-request-card-inline">
        <div className="input-request-progress">
          <span className="input-request-header">{activeQuestion.header || "Question"}</span>
          <span className="input-request-progress-index">
            {Math.min(activeQuestionIndex + 1, questions.length)} / {questions.length}
          </span>
        </div>
        <div className="input-request-title">{activeQuestion.question}</div>
        <div className="input-request-options">
          {activeOptions.map((option, optionIndex) => (
            <button
              key={`${activeQuestion.id}-option-${optionIndex}`}
              className={`input-request-option ${activeSelected === optionIndex ? "selected" : ""}`}
              onClick={() => {
                updateSelection(activeQuestion.id, optionIndex);
              }}
            >
              <span className="input-request-option-index">{optionIndex + 1}.</span>
              <span className="input-request-option-copy">
                <span className="input-request-option-label">{option.label}</span>
                <span className="input-request-option-description">{option.description}</span>
              </span>
            </button>
          ))}
          <button
            className={`input-request-option ${activeOtherSelected ? "selected" : ""}`}
            onClick={() => {
              updateSelection(activeQuestion.id, activeOptions.length);
            }}
          >
            <span className="input-request-option-index">{activeOptions.length + 1}.</span>
            <span className="input-request-option-copy">
              <span className="input-request-option-label">Other</span>
              <span className="input-request-option-description">Type a custom response</span>
            </span>
          </button>
        </div>
        {activeOtherSelected && (
          <textarea
            className="input-request-other"
            placeholder="Tell Codex what to do differently..."
            value={otherTextByQuestion[activeQuestion.id] || ""}
            onChange={(event) =>
              setOtherTextByQuestion((prev) => ({
                ...prev,
                [activeQuestion.id]: event.target.value,
              }))
            }
          />
        )}
        <div className="input-request-hint">Use 1-4 to choose, Enter to continue, Esc to dismiss.</div>
        <div className="input-request-actions">
          <button className="input-request-dismiss" onClick={onDismiss}>
            Dismiss
          </button>
          <button
            className="input-request-dismiss"
            onClick={goToPreviousQuestion}
            disabled={activeQuestionIndex === 0}
          >
            Back
          </button>
          {activeQuestionIndex < questions.length - 1 ? (
            <button
              className="input-request-submit"
              onClick={goToNextQuestion}
              disabled={!currentQuestionAnswered}
            >
              Next
            </button>
          ) : (
            <button
              className="input-request-submit"
              onClick={() => onSubmit(buildAnswers())}
              disabled={!canSubmit}
            >
              Submit
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

interface CreateTaskOptions {
  autonomousMode?: boolean;
  collaborativeMode?: boolean;
  multiLlmMode?: boolean;
  multiLlmConfig?: import("../../shared/types").MultiLlmConfig;
  verificationAgent?: boolean;
  executionMode?: ExecutionMode;
  taskDomain?: TaskDomain;
}

const EXECUTION_MODE_ORDER: ExecutionMode[] = ["execute", "propose", "analyze", "verified"];
const TASK_DOMAIN_ORDER: TaskDomain[] = [
  "auto",
  "code",
  "research",
  "operations",
  "writing",
  "general",
];
const EXECUTION_MODE_LABEL: Record<ExecutionMode, string> = {
  execute: "Execute",
  propose: "Propose",
  analyze: "Analyze",
  verified: "Verified",
};
const EXECUTION_MODE_HINT: Record<ExecutionMode, string> = {
  execute: "Allows full tool execution",
  propose: "Planning mode, no mutating tools",
  analyze: "Read-only analysis mode",
  verified: "Execute with external verification after each step",
};
const TASK_DOMAIN_LABEL: Record<TaskDomain, string> = {
  auto: "Auto",
  code: "Code",
  research: "Research",
  operations: "Operations",
  writing: "Writing",
  general: "General",
};
const TASK_DOMAIN_HINT: Record<TaskDomain, string> = {
  auto: "Adapts orchestration automatically",
  code: "Optimized for coding and refactors",
  research: "Optimized for research and synthesis",
  operations: "Optimized for infra and operational workflows",
  writing: "Optimized for writing and editing output",
  general: "Balanced behavior for mixed tasks",
};
type OverflowSubmenu = "mode" | "domain";

type SettingsTab =
  | "appearance"
  | "llm"
  | "search"
  | "telegram"
  | "slack"
  | "whatsapp"
  | "teams"
  | "x"
  | "morechannels"
  | "integrations"
  | "updates"
  | "guardrails"
  | "queue"
  | "skills"
  | "voice"
  | "scheduled"
  | "mcp";

// ---- Focused mode card pool ----
interface FocusedCard {
  id: string;
  emoji: string;
  iconName: string;
  title: string;
  desc: string;
  action: { type: "prompt"; prompt: string } | { type: "settings"; tab: SettingsTab };
  category: "task" | "setup" | "discover";
}

const FOCUSED_CARD_POOL: FocusedCard[] = [
  // --- Task starters ---
  {
    id: "write",
    emoji: "✏️",
    iconName: "edit",
    title: "Write something",
    desc: "Emails, reports, documents, or creative content",
    action: {
      type: "prompt",
      prompt:
        "I have a writing task for you. Let me describe what I need and let's create it together.",
    },
    category: "task",
  },
  {
    id: "research",
    emoji: "🔍",
    iconName: "search",
    title: "Research a topic",
    desc: "Deep-dive into any subject and get a summary",
    action: {
      type: "prompt",
      prompt: "I need help researching a topic. Let me tell you what I'm looking into.",
    },
    category: "task",
  },
  {
    id: "analyze",
    emoji: "📊",
    iconName: "chart",
    title: "Analyze data",
    desc: "Crunch numbers, find patterns, build reports",
    action: {
      type: "prompt",
      prompt:
        "I have some data I'd like to analyze. Let me share the files and tell you what I'm looking for.",
    },
    category: "task",
  },
  {
    id: "files",
    emoji: "📁",
    iconName: "folder",
    title: "Work with files",
    desc: "Sort, rename, convert, or organize anything",
    action: {
      type: "prompt",
      prompt:
        "I need help working with some files. Let me point you to the folder and explain what I need.",
    },
    category: "task",
  },
  {
    id: "build",
    emoji: "⚡",
    iconName: "zap",
    title: "Build something",
    desc: "Code, automate, or create from scratch",
    action: {
      type: "prompt",
      prompt: "I need help building or coding something. Let me describe the project.",
    },
    category: "task",
  },
  {
    id: "chat",
    emoji: "💬",
    iconName: "message",
    title: "Just chat",
    desc: "Think out loud, brainstorm, or ask me anything",
    action: {
      type: "prompt",
      prompt: "Let's just chat. I have something on my mind I'd like to talk through.",
    },
    category: "task",
  },
  {
    id: "meeting",
    emoji: "📋",
    iconName: "clipboard",
    title: "Prep for a meeting",
    desc: "Create agendas, talking points, and notes",
    action: {
      type: "prompt",
      prompt: "Help me prepare for a meeting. I need an agenda and talking points.",
    },
    category: "task",
  },
  {
    id: "document",
    emoji: "📄",
    iconName: "filetext",
    title: "Create a document",
    desc: "Word docs, PDFs, presentations, or spreadsheets",
    action: {
      type: "prompt",
      prompt: "I need to create a document. Let me describe the format and content I need.",
    },
    category: "task",
  },
  {
    id: "email",
    emoji: "✉️",
    iconName: "edit",
    title: "Draft an email",
    desc: "Professional, clear, and on-point every time",
    action: {
      type: "prompt",
      prompt: "Help me draft an email. Here's the context and who it's for.",
    },
    category: "task",
  },
  {
    id: "summarize",
    emoji: "📝",
    iconName: "filetext",
    title: "Summarize something",
    desc: "Condense long texts, articles, or meeting notes",
    action: {
      type: "prompt",
      prompt: "I have something I need summarized. Let me share it with you.",
    },
    category: "task",
  },
  {
    id: "code",
    emoji: "💻",
    iconName: "code",
    title: "Debug or review code",
    desc: "Find bugs, explain code, or suggest improvements",
    action: {
      type: "prompt",
      prompt: "I have some code I need help with. Let me share it and explain the issue.",
    },
    category: "task",
  },
  {
    id: "translate",
    emoji: "🌐",
    iconName: "globe",
    title: "Translate content",
    desc: "Translate text between any languages",
    action: {
      type: "prompt",
      prompt: "I need something translated. Let me share the text and the target language.",
    },
    category: "task",
  },

  // --- Setup & integration suggestions ---
  {
    id: "setup-whatsapp",
    emoji: "📱",
    iconName: "message",
    title: "Connect WhatsApp",
    desc: "Chat with your AI from WhatsApp",
    action: { type: "settings", tab: "whatsapp" },
    category: "setup",
  },
  {
    id: "setup-telegram",
    emoji: "✈️",
    iconName: "message",
    title: "Connect Telegram",
    desc: "Send tasks from Telegram anytime",
    action: { type: "settings", tab: "telegram" },
    category: "setup",
  },
  {
    id: "setup-slack",
    emoji: "💼",
    iconName: "message",
    title: "Connect Slack",
    desc: "Bring your AI into your team workspace",
    action: { type: "settings", tab: "slack" },
    category: "setup",
  },
  {
    id: "setup-voice",
    emoji: "🎙️",
    iconName: "sliders",
    title: "Set up voice",
    desc: "Talk to your AI using your microphone",
    action: { type: "settings", tab: "voice" },
    category: "setup",
  },
  {
    id: "setup-skills",
    emoji: "🧩",
    iconName: "zap",
    title: "Explore skills",
    desc: "Add custom skills to extend capabilities",
    action: { type: "settings", tab: "skills" },
    category: "setup",
  },
  {
    id: "setup-schedule",
    emoji: "⏰",
    iconName: "calendar",
    title: "Schedule a task",
    desc: "Set up recurring tasks that run automatically",
    action: { type: "settings", tab: "scheduled" },
    category: "setup",
  },
  {
    id: "setup-mcp",
    emoji: "🔌",
    iconName: "sliders",
    title: "Connect tools",
    desc: "Add external tools and services",
    action: { type: "settings", tab: "mcp" },
    category: "setup",
  },
  {
    id: "setup-guardrails",
    emoji: "🛡️",
    iconName: "shield",
    title: "Set safety limits",
    desc: "Control what your AI can and cannot do",
    action: { type: "settings", tab: "guardrails" },
    category: "setup",
  },

  {
    id: "competitors",
    emoji: "🏁",
    iconName: "search",
    title: "Research competitors",
    desc: "Analyze a market and find opportunities",
    action: {
      type: "prompt",
      prompt:
        "Research the top 3-5 competitors in a market I'll describe. For each, find their positioning, key features, pricing, strengths, and weaknesses. Then identify gaps I could exploit.",
    },
    category: "task",
  },
  {
    id: "validate-idea",
    emoji: "💡",
    iconName: "zap",
    title: "Validate an idea",
    desc: "Market size, competitors, and a go/no-go call",
    action: {
      type: "prompt",
      prompt:
        "Help me validate a business idea. I'll describe the concept, and you'll assess the market size, competitors, unique angle, and give a go/no-go recommendation.",
    },
    category: "task",
  },
  {
    id: "weekly-plan",
    emoji: "📅",
    iconName: "calendar",
    title: "Plan my week",
    desc: "Build a day-by-day schedule with priorities",
    action: {
      type: "prompt",
      prompt:
        "Help me create a weekly plan. Ask about my goals, deadlines, and priorities, then build a day-by-day schedule with clear deliverables.",
    },
    category: "task",
  },

  // --- Feature discovery ---
  {
    id: "discover-memory",
    emoji: "🧠",
    iconName: "book",
    title: "I remember things",
    desc: "I learn your preferences over time",
    action: { type: "prompt", prompt: "What do you remember about me and my preferences?" },
    category: "discover",
  },
  {
    id: "discover-browse",
    emoji: "🌍",
    iconName: "globe",
    title: "I can browse the web",
    desc: "Search, read pages, and fetch live data",
    action: {
      type: "prompt",
      prompt: "Search the web for the latest news on a topic I'll describe.",
    },
    category: "discover",
  },
  {
    id: "discover-files",
    emoji: "📂",
    iconName: "folder",
    title: "I can read your files",
    desc: "Drop files here or point me to a folder",
    action: { type: "prompt", prompt: "Show me what files are in my current workspace." },
    category: "discover",
  },
  {
    id: "discover-agents",
    emoji: "🤖",
    iconName: "zap",
    title: "I work autonomously",
    desc: "Give me a goal and I'll figure out the steps",
    action: {
      type: "prompt",
      prompt:
        "I have a complex task that needs multiple steps. Let me describe the goal and you plan it out.",
    },
    category: "discover",
  },
  {
    id: "discover-multimodel",
    emoji: "🔄",
    iconName: "sliders",
    title: "Switch AI models",
    desc: "Use Claude, GPT, Gemini, or local models",
    action: { type: "settings", tab: "llm" },
    category: "discover",
  },
];

const CARDS_TO_SHOW = 6;

function shuffleArray<T>(arr: T[]): T[] {
  const shuffled = [...arr];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled;
}

function pickFocusedCards(pool: FocusedCard[], count: number): FocusedCard[] {
  // Ensure a good mix: at least 3 tasks, 1-2 setup, 1 discover
  const tasks = shuffleArray(pool.filter((c) => c.category === "task"));
  const setup = shuffleArray(pool.filter((c) => c.category === "setup"));
  const discover = shuffleArray(pool.filter((c) => c.category === "discover"));
  const picked: FocusedCard[] = [
    ...tasks.slice(0, 3),
    ...setup.slice(0, 1),
    ...discover.slice(0, 1),
  ];
  // Fill remaining from the rest
  const usedIds = new Set(picked.map((c) => c.id));
  const remaining = shuffleArray(pool.filter((c) => !usedIds.has(c.id)));
  picked.push(...remaining.slice(0, count - picked.length));
  // Shuffle final order so categories aren't grouped
  return shuffleArray(picked);
}

interface MainContentProps {
  task: Task | undefined;
  selectedTaskId: string | null; // Added to distinguish "no task" from "task not in list"
  workspace: Workspace | null;
  events: TaskEvent[];
  childTasks?: Task[];
  childEvents?: TaskEvent[];
  onSelectChildTask?: (taskId: string) => void;
  onSendMessage: (message: string, images?: ImageAttachment[]) => void;
  onCreateTask?: (
    title: string,
    prompt: string,
    options?: CreateTaskOptions,
    images?: ImageAttachment[],
  ) => void;
  onChangeWorkspace?: () => void;
  onSelectWorkspace?: (workspace: Workspace) => void;
  onOpenSettings?: (tab?: SettingsTab) => void;
  onStopTask?: () => void;
  onWrapUpTask?: () => void;
  inputRequest?: InputRequest | null;
  onSubmitInputRequest?: (
    requestId: string,
    answers: Record<string, { optionLabel?: string; otherText?: string }>,
  ) => void;
  onDismissInputRequest?: (requestId: string) => void;
  onOpenBrowserView?: (url?: string) => void;
  onViewTaskOutputs?: (taskId: string, primaryOutputPath?: string) => void;
  selectedModel: string;
  availableModels: LLMModelInfo[];
  onModelChange: (model: string) => void;
  availableProviders?: Array<{ type: string; name: string; configured: boolean }>;
  uiDensity?: "focused" | "full" | "power";
}

// Track command execution sessions for timeline rendering
interface CommandOutputSession {
  id: string;
  command: string;
  output: string;
  isRunning: boolean;
  exitCode: number | null;
  startTimestamp: number; // When the command started, for positioning in timeline
}

export function MainContent({
  task,
  selectedTaskId,
  workspace,
  events: rawEvents,
  childTasks = [],
  childEvents: rawChildEvents = [],
  onSelectChildTask,
  onSendMessage,
  onCreateTask,
  onChangeWorkspace,
  onSelectWorkspace,
  onOpenSettings,
  onStopTask,
  onWrapUpTask,
  inputRequest = null,
  onSubmitInputRequest,
  onDismissInputRequest,
  onOpenBrowserView,
  onViewTaskOutputs,
  selectedModel,
  availableModels,
  onModelChange,
  availableProviders = [],
  uiDensity = "focused",
}: MainContentProps) {
  const events = useMemo(() => normalizeEventsForTimelineUi(rawEvents), [rawEvents]);
  const childEvents = useMemo(() => normalizeEventsForTimelineUi(rawChildEvents), [rawChildEvents]);
  // Agent personality context for personalized messages
  const agentContext = useAgentContext();
  const [inputValue, setInputValue] = useState("");
  const [pendingAttachments, setPendingAttachments] = useState<PendingAttachment[]>([]);
  const [attachmentError, setAttachmentError] = useState<string | null>(null);
  const [isDraggingFiles, setIsDraggingFiles] = useState(false);
  const [isUploadingAttachments, setIsUploadingAttachments] = useState(false);
  const [isPreparingMessage, setIsPreparingMessage] = useState(false);
  const [agentRoles, setAgentRoles] = useState<AgentRoleData[]>([]);
  const [mentionQuery, setMentionQuery] = useState("");
  const [mentionTarget, setMentionTarget] = useState<{ start: number; end: number } | null>(null);
  const [mentionOpen, setMentionOpen] = useState(false);
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0);
  const [slashOpen, setSlashOpen] = useState(false);
  const [slashQuery, setSlashQuery] = useState("");
  const [slashTarget, setSlashTarget] = useState<{ start: number; end: number } | null>(null);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);
  // Focused mode card pool - pick random 6 on mount
  const focusedCards = useMemo(() => pickFocusedCards(FOCUSED_CARD_POOL, CARDS_TO_SHOW), []);

  // ── Rotating placeholder prompts (persona-aware engine) ──────────────
  const [rotatingPlaceholders, setRotatingPlaceholders] = useState<string[]>([]);
  const [rotatingIndex, setRotatingIndex] = useState(0);
  const [placeholderFading, setPlaceholderFading] = useState(false);
  const placeholderTimeoutRef = useRef<number | null>(null);
  const placeholderDebounceRef = useRef<number | null>(null);
  const placeholderPlaylistCacheRef = useRef<Map<string, string[]>>(new Map());
  const placeholderRequestIdRef = useRef(0);

  // Gather all user signals, run persona detection, and build the playlist
  useEffect(() => {
    let cancelled = false;
    const workspaceId = workspace?.id;
    const cacheKey = workspaceId ?? "global";
    const requestId = ++placeholderRequestIdRef.current;

    const cachedPlaylist = placeholderPlaylistCacheRef.current.get(cacheKey);
    if (cachedPlaylist !== undefined) {
      setRotatingIndex(0);
      setRotatingPlaceholders(cachedPlaylist);
      return;
    }

    setRotatingPlaceholders([]);

    if (placeholderDebounceRef.current !== null) {
      clearTimeout(placeholderDebounceRef.current);
    }

    placeholderDebounceRef.current = window.setTimeout(() => {
      (async () => {
        const { detectPersonas, buildPlaceholders, buildDynamicPrompts } =
          await import("../utils/placeholderEngine");
        type UserSignals = import("../utils/placeholderEngine").UserSignals;

        const [profileFacts, recentTaskTitles, topSkills, pluginPrompts, openCommitments] =
          await Promise.all([
            // 1. User profile facts
            (async () => {
              try {
                const p = await window.electronAPI.getUserProfile();
                return (p?.facts ?? []).map((f) => ({ category: f.category, value: f.value }));
              } catch {
                return [];
              }
            })(),
            // 2. Recent completed task titles
            (async () => {
              try {
                const wsId = workspaceId;
                if (!wsId || wsId.startsWith("__temp_workspace__")) return [];
                const acts = await window.electronAPI.listActivities({
                  workspaceId: wsId,
                  activityType: "task_completed",
                  limit: 15,
                });
                return Array.isArray(acts)
                  ? acts.map((a) => (typeof a?.title === "string" ? a.title : "")).filter(Boolean)
                  : [];
              } catch {
                return [];
              }
            })(),
            // 3. Top skills from usage insights
            (async () => {
              try {
                const wsId = workspaceId;
                if (!wsId || wsId.startsWith("__temp_workspace__")) return [];
                const insights = await window.electronAPI.getUsageInsights(wsId, 30);
                return Array.isArray(insights?.topSkills)
                  ? insights.topSkills.map((s: { skill: string }) => s.skill)
                  : [];
              } catch {
                return [];
              }
            })(),
            // 4. Plugin pack "try asking" prompts
            (async () => {
              try {
                const packs = await window.electronAPI.listPluginPacks();
                if (!Array.isArray(packs)) return [];
                const out: string[] = [];
                for (const p of packs) {
                  if (p?.enabled && Array.isArray(p.tryAsking) && p.tryAsking.length > 0) {
                    for (const prompt of p.tryAsking) {
                      if (typeof prompt === "string") out.push(prompt);
                    }
                  }
                }
                return out;
              } catch {
                return [];
              }
            })(),
            // 5. Open commitments
            (async () => {
              try {
                const items = await window.electronAPI.getOpenCommitments(5);
                if (!Array.isArray(items)) return [];
                return items.map(normalizeCommitmentText).filter((c): c is string => c !== null);
              } catch {
                return [];
              }
            })(),
          ]);

        if (cancelled || requestId !== placeholderRequestIdRef.current) return;

        const signals: UserSignals = {
          profileFacts,
          recentTaskTitles,
          topSkills,
          pluginPrompts,
          openCommitments,
        };

        const personaResult = detectPersonas(signals);
        const dynamicPrompts = buildDynamicPrompts(signals);
        const playlist = buildPlaceholders(personaResult, dynamicPrompts, pluginPrompts);
        placeholderPlaylistCacheRef.current.set(cacheKey, playlist);
        setRotatingIndex(0);
        setRotatingPlaceholders(playlist);
      })();
    }, 150);

    return () => {
      cancelled = true;
      if (placeholderDebounceRef.current !== null) {
        clearTimeout(placeholderDebounceRef.current);
        placeholderDebounceRef.current = null;
      }
    };
  }, [workspace?.id]);

  // Cycle placeholder every 4s with fade transition (only when input is empty)
  useEffect(() => {
    if (rotatingPlaceholders.length <= 1 || inputValue) return;
    const interval = setInterval(() => {
      setPlaceholderFading(true);
      placeholderTimeoutRef.current = window.setTimeout(() => {
        setRotatingIndex((prev) => (prev + 1) % rotatingPlaceholders.length);
        setPlaceholderFading(false);
      }, 300);
    }, 4000);
    return () => {
      clearInterval(interval);
      if (placeholderTimeoutRef.current !== null) {
        clearTimeout(placeholderTimeoutRef.current);
        placeholderTimeoutRef.current = null;
      }
    };
  }, [rotatingPlaceholders.length, inputValue]);

  // Shell permission state - tracks current workspace's shell permission
  const [shellEnabled, setShellEnabled] = useState(workspace?.permissions?.shell ?? false);
  // Track dismissed command outputs by command session ID (persisted in localStorage)
  const [dismissedCommandOutputs, setDismissedCommandOutputs] = useState<Set<string>>(() => {
    try {
      const saved = localStorage.getItem("dismissedCommandOutputs");
      return saved ? new Set(JSON.parse(saved)) : new Set();
    } catch {
      return new Set();
    }
  });
  // Autonomous mode state
  const [autonomousModeEnabled, setAutonomousModeEnabled] = useState(false);
  const [collaborativeModeEnabled, setCollaborativeModeEnabled] = useState(false);
  const [multiLlmModeEnabled, setMultiLlmModeEnabled] = useState(false);
  const [executionMode, setExecutionMode] = useState<ExecutionMode>("execute");
  const [taskDomain, setTaskDomain] = useState<TaskDomain>("auto");
  const [multiLlmConfig, setMultiLlmConfig] = useState<MultiLlmConfig | null>(null);
  const [verificationAgentEnabled, setVerificationAgentEnabled] = useState(false);
  const setAutonomousModeSelection = useCallback((enabled: boolean) => {
    setAutonomousModeEnabled(enabled);
    if (enabled) {
      setCollaborativeModeEnabled(false);
      setMultiLlmModeEnabled(false);
    }
  }, []);
  const setCollaborativeModeSelection = useCallback((enabled: boolean) => {
    setCollaborativeModeEnabled(enabled);
    if (enabled) {
      setAutonomousModeEnabled(false);
      setMultiLlmModeEnabled(false);
    }
  }, []);
  const setMultiLlmModeSelection = useCallback((enabled: boolean) => {
    setMultiLlmModeEnabled(enabled);
    if (enabled) {
      setAutonomousModeEnabled(false);
      setCollaborativeModeEnabled(false);
    }
    if (!enabled) {
      setMultiLlmConfig(null);
    }
  }, []);
  // Collaborative team run detection for current task
  const [collaborativeRun, setCollaborativeRun] = useState<AgentTeamRun | null>(null);
  const [showSteps, setShowSteps] = useState(true);
  const [autoScroll, setAutoScroll] = useState(true);
  // Track toggled events by ID for stable state across filtering
  const [toggledEvents, setToggledEvents] = useState<Set<string>>(new Set());
  const [appVersion, setAppVersion] = useState<string>("");
  const [customSkills, setCustomSkills] = useState<CustomSkill[]>([]);
  const [showSkillsMenu, setShowSkillsMenu] = useState(false);
  const [skillsSearchQuery, setSkillsSearchQuery] = useState("");
  const [selectedSkillForParams, setSelectedSkillForParams] = useState<CustomSkill | null>(null);
  // Track wrap-up requested state for button feedback
  const [wrappingUp, setWrappingUp] = useState(false);

  // Detect if the current task is a collaborative team run
  useEffect(() => {
    if (!task?.id) {
      setCollaborativeRun(null);
      return;
    }

    const unsubRun = window.electronAPI.onTeamRunEvent((event: Any) => {
      if (event.run?.rootTaskId === task.id && event.run?.collaborativeMode) {
        setCollaborativeRun(event.run as AgentTeamRun);
      }
    });

    window.electronAPI
      .findTeamRunByRootTask(task.id)
      .then((run: AgentTeamRun | null) => {
        if (run?.collaborativeMode) setCollaborativeRun(run);
        else setCollaborativeRun(null);
      })
      .catch(() => setCollaborativeRun(null));

    return () => {
      unsubRun();
    };
  }, [task?.id]);

  // Voice input hook
  const [showVoiceNotConfigured, setShowVoiceNotConfigured] = useState(false);
  const voiceInput = useVoiceInput({
    onTranscript: (text) => {
      // Append transcribed text to input
      setInputValue((prev) => (prev ? `${prev} ${text}` : text));
    },
    onError: (error) => {
      console.error("Voice input error:", error);
    },
    onNotConfigured: () => {
      setShowVoiceNotConfigured(true);
    },
  });

  // Talk Mode hook - continuous voice conversation
  const talkMode = useVoiceTalkMode({
    onSendMessage: (text) => {
      if (!selectedTaskId && onCreateTask) {
        const title = text.length > 60 ? text.slice(0, 57) + "..." : text;
        onCreateTask(title, text);
      } else {
        onSendMessage(text);
      }
    },
    onError: (error) => {
      console.error("Talk mode error:", error);
      setShowVoiceNotConfigured(true);
    },
  });
  const [viewerFilePath, setViewerFilePath] = useState<string | null>(null);
  // Extract citations from task events for inline badge rendering
  const citations = useMemo(() => {
    const evidenceEvent = [...events]
      .reverse()
      .find((event) => event.type === "timeline_evidence_attached");
    if (!evidenceEvent) return [];
    const refs = Array.isArray(evidenceEvent.payload?.evidenceRefs)
      ? (evidenceEvent.payload.evidenceRefs as Array<Record<string, unknown>>)
      : [];
    if (refs.length > 0) {
      return refs
        .map((ref, index) => {
          const source = typeof ref?.sourceUrlOrPath === "string" ? ref.sourceUrlOrPath : "";
          if (!source) return null;
          const domain = extractDomainFromUrl(source);
          const snippet = typeof ref?.snippet === "string" ? stripHtmlTags(ref.snippet) : "";
          const sourceTool =
            typeof ref?.sourceTool === "string" && ref.sourceTool.trim().length > 0
              ? stripHtmlTags(ref.sourceTool)
              : "timeline_evidence";
          return {
            index: index + 1,
            url: source,
            snippet,
            title: domain || source,
            domain,
            accessedAt: 0,
            sourceTool,
          };
        })
        .filter(
          (
            entry,
          ): entry is {
            index: number;
            url: string;
            title: string;
            snippet: string;
            domain: string;
            accessedAt: number;
            sourceTool: string;
          } => entry !== null,
        );
    }
    const rawCitations = Array.isArray(evidenceEvent.payload?.citations)
      ? (evidenceEvent.payload.citations as Array<Record<string, unknown>>)
      : [];
    return rawCitations
      .map((citation, index) => {
        const url = typeof citation?.url === "string" ? citation.url : "";
        if (!url) return null;
        const domain =
          typeof citation?.domain === "string" && citation.domain.trim().length > 0
            ? stripHtmlTags(citation.domain)
            : extractDomainFromUrl(url);
        const title =
          typeof citation?.title === "string" && citation.title.trim().length > 0
            ? stripHtmlTags(citation.title)
            : domain || url;
        const snippet =
          typeof citation?.snippet === "string" && citation.snippet.trim().length > 0
            ? stripHtmlTags(citation.snippet)
            : "";
        const sourceTool =
          typeof citation?.sourceTool === "string" && citation.sourceTool.trim().length > 0
            ? stripHtmlTags(citation.sourceTool)
            : typeof citation?.source === "string" && citation.source.trim().length > 0
              ? stripHtmlTags(citation.source)
              : "unknown";
        const accessedAt = typeof citation?.accessedAt === "number" ? citation.accessedAt : 0;
        return {
          index: typeof citation?.index === "number" ? citation.index : index + 1,
          url,
          domain,
          title,
          snippet,
          accessedAt,
          sourceTool,
        };
      })
      .filter(
        (
          entry,
        ): entry is {
          index: number;
          url: string;
          title: string;
          snippet: string;
          domain: string;
          accessedAt: number;
          sourceTool: string;
        } => entry !== null,
      );
  }, [events]);

  const markdownComponents = useMemo(
    () =>
      buildMarkdownComponents({ workspacePath: workspace?.path, onOpenViewer: setViewerFilePath, citations }),
    [workspace?.path, setViewerFilePath, citations],
  );
  const eventTitleMarkdownComponents = useMemo(
    () => ({
      ...markdownComponents,
      // Keep timeline titles inline; avoid wrapping plain text in <p> blocks.
      p: ({ children }: Any) => <>{children}</>,
    }),
    [markdownComponents],
  );
  // Canvas sessions state - track active canvas sessions for current task
  const [canvasSessions, setCanvasSessions] = useState<CanvasSession[]>([]);
  // Workspace dropdown state
  const [showWorkspaceDropdown, setShowWorkspaceDropdown] = useState(false);
  const [workspacesList, setWorkspacesList] = useState<Workspace[]>([]);
  // Verbose mode - default to summary and persist per user profile.
  const [verboseSteps, setVerboseSteps] = useState(false);
  // Code previews expanded by default (true = open, false = collapsed)
  const [codePreviewsExpanded, setCodePreviewsExpanded] = useState(() => {
    const saved = localStorage.getItem(CODE_PREVIEWS_EXPANDED_KEY);
    return saved !== "false"; // default to true (expanded)
  });
  // Voice state - track if voice is enabled
  const [voiceEnabled, setVoiceEnabled] = useState(false);
  const [voiceResponseMode, setVoiceResponseMode] = useState<"auto" | "manual" | "smart">("manual");
  const lastSpokenMessageRef = useRef<string | null>(null);
  const skillsMenuRef = useRef<HTMLDivElement>(null);
  const workspaceDropdownRef = useRef<HTMLDivElement>(null);
  // Focused mode overflow menu state
  const [showOverflowMenu, setShowOverflowMenu] = useState(false);
  const [overflowSubmenu, setOverflowSubmenu] = useState<OverflowSubmenu | null>(null);
  const overflowMenuRef = useRef<HTMLDivElement>(null);
  const overflowToggleBtnRef = useRef<HTMLButtonElement>(null);
  const [showModelDropdownFromLabel, setShowModelDropdownFromLabel] = useState(false);
  const modelLabelRef = useRef<HTMLDivElement>(null);
  const [guardrailDefaultMaxAutoContinuations, setGuardrailDefaultMaxAutoContinuations] =
    useState<number | null>(null);

  // Filter events based on verbose mode
  const filteredEvents = useMemo(() => {
    const baseEvents = verboseSteps
      ? events
      : events.filter((event) => shouldShowTaskEventInSummaryMode(event, task?.status));
    // Command output is rendered separately via CommandOutput component
    const visibleEvents = baseEvents.filter(
      (event) => event.type !== "command_output" && event.type !== "timeline_command_output",
    );
    const terminalErrorDedupWindowMs = 10_000;
    const lastErrorByFingerprint = new Map<string, number>();
    const dedupedEvents = visibleEvents.filter((event) => {
      if (getEffectiveTaskEventType(event) !== "error") return true;
      const payload =
        event.payload && typeof event.payload === "object"
          ? (event.payload as Record<string, unknown>)
          : {};
      const fingerprint =
        (typeof payload.terminal_failure_fingerprint === "string"
          ? payload.terminal_failure_fingerprint
          : typeof payload.terminalFailureFingerprint === "string"
            ? payload.terminalFailureFingerprint
            : typeof payload.errorFingerprint === "string"
              ? payload.errorFingerprint
              : typeof payload.message === "string"
                ? payload.message
                : typeof payload.error === "string"
                  ? payload.error
                  : "")
          .trim();
      if (!fingerprint) return true;
      const previousTimestamp = lastErrorByFingerprint.get(fingerprint);
      if (
        typeof previousTimestamp === "number" &&
        event.timestamp - previousTimestamp <= terminalErrorDedupWindowMs
      ) {
        return false;
      }
      lastErrorByFingerprint.set(fingerprint, event.timestamp);
      return true;
    });
    // Always keep explicit verification steps silent; surface failures elsewhere.
    return dedupedEvents.filter((event) => !isVerificationNoiseEvent(event));
  }, [events, verboseSteps, task?.status]);

  const parallelGroupProjection = useMemo(
    () => buildParallelGroupProjection(filteredEvents),
    [filteredEvents],
  );
  const parallelGroupsByAnchorEventId = parallelGroupProjection.groupsByAnchorEventId;
  const suppressedParallelEventIds = parallelGroupProjection.suppressedEventIds;

  const latestUserMessageTimestamp = useMemo(() => {
    for (let i = events.length - 1; i >= 0; i--) {
      if (getEffectiveTaskEventType(events[i]) === "user_message") {
        return events[i].timestamp;
      }
    }
    return null;
  }, [events]);

  const isTaskWorking = useMemo(() => {
    if (!task) return false;
    if (task.status === "executing" || task.status === "interrupted") return true;
    if (
      task.status === "completed" ||
      task.status === "paused" ||
      task.status === "blocked" ||
      task.status === "failed" ||
      task.status === "cancelled"
    ) {
      return false;
    }

    const now = Date.now();
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.taskId !== task.id) continue;
      const effectiveType = getEffectiveTaskEventType(event);

      if (
        effectiveType === "task_paused" ||
        effectiveType === "approval_requested" ||
        effectiveType === "task_completed" ||
        effectiveType === "task_cancelled" ||
        effectiveType === "follow_up_completed" ||
        effectiveType === "error"
      ) {
        return false;
      }

      const isActiveProgressSignal =
        effectiveType === "progress_update" &&
        (event.payload?.phase === "tool_execution" ||
          event.payload?.state === "active" ||
          event.payload?.heartbeat === true);
      const isTimelineActiveLifecycle =
        event.type === "timeline_group_started" ||
        event.type === "timeline_step_started" ||
        event.type === "timeline_step_updated";
      if (
        isTimelineActiveLifecycle ||
        ACTIVE_WORK_EVENT_TYPES.includes(effectiveType as EventType) ||
        isActiveProgressSignal
      ) {
        return now - event.timestamp <= ACTIVE_WORK_SIGNAL_WINDOW_MS;
      }
    }

    return false;
  }, [task, events]);

  // Reset wrappingUp state when task stops working or task changes
  useEffect(() => {
    if (!isTaskWorking) setWrappingUp(false);
  }, [isTaskWorking]);
  useEffect(() => {
    setWrappingUp(false);
  }, [task?.id]);

  // Derive current in-progress step from events (for step feedback)
  const currentStep = useMemo(() => {
    if (!task || !isTaskWorking) return null;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.taskId !== task.id) continue;
      if (e.type === "timeline_step_started" || e.type === "timeline_step_updated") {
        const step = (e.payload?.step || {}) as Record<string, unknown>;
        const id =
          typeof e.stepId === "string" && e.stepId.length > 0
            ? e.stepId
            : typeof step?.id === "string" && step.id.length > 0
              ? step.id
              : "";
        if (!id) continue;
        const description =
          (typeof step?.description === "string" && step.description) ||
          (typeof e.payload?.message === "string" && e.payload.message) ||
          "Working";
        return { id, description };
      }
      const effectiveType = getEffectiveTaskEventType(e);
      if (
        e.type === "timeline_step_finished" ||
        effectiveType === "step_completed" ||
        effectiveType === "step_skipped"
      ) {
        break;
      }
    }
    return null;
  }, [task, events, isTaskWorking]);

  // Step feedback UI state
  const [stepFeedbackOpen, setStepFeedbackOpen] = useState(false);
  const [stepFeedbackText, setStepFeedbackText] = useState("");
  const [stepFeedbackSending, setStepFeedbackSending] = useState(false);

  // Close feedback panel when step changes
  useEffect(() => {
    setStepFeedbackOpen(false);
    setStepFeedbackText("");
    setStepFeedbackSending(false);
  }, [currentStep?.id]);

  const handleStepFeedback = useCallback(
    async (action: StepFeedbackAction, message?: string) => {
      if (!task || !currentStep?.id) return;
      const stepId = currentStep.id;
      setStepFeedbackSending(true);
      try {
        await window.electronAPI.sendStepFeedback(task.id, stepId, action, message);
        setStepFeedbackOpen(false);
        setStepFeedbackText("");
      } catch {
        // Silently handle — executor may have moved on
      } finally {
        setStepFeedbackSending(false);
      }
    },
    [task, currentStep],
  );

  // Extract latest streaming progress for the live token counter
  const streamingProgress = useMemo(() => {
    if (!task || !isTaskWorking) return null;
    for (let i = events.length - 1; i >= 0; i--) {
      const e = events[i];
      if (e.taskId !== task.id) continue;
      const isStreamingEvent =
        (e.type === "timeline_step_updated" && e.payload?.legacyType === "llm_streaming") ||
        e.type === "llm_streaming";
      if (isStreamingEvent && e.payload?.streaming === true) {
        // Only show if the event is recent (within 2s)
        return Date.now() - e.timestamp <= 2000 ? e.payload : null;
      }
      // Any non-streaming event means streaming has ended
      if (!isStreamingEvent) return null;
    }
    return null;
  }, [task, events, isTaskWorking]);

  const continuationStatusChip = useMemo(() => {
    if (!task || !isTaskWorking) return null;
    const continuationWindow =
      typeof task.continuationWindow === "number" && task.continuationWindow > 0
        ? task.continuationWindow
        : typeof task.continuationCount === "number"
          ? Math.max(1, task.continuationCount + 1)
          : 1;

    let latestDecisionEvent: TaskEvent | undefined;
    for (let i = events.length - 1; i >= 0; i--) {
      const event = events[i];
      if (event.taskId !== task.id) continue;
      const type = getEffectiveTaskEventType(event);
      if (type === "continuation_decision" || type === "auto_continuation_started") {
        latestDecisionEvent = event;
        break;
      }
    }

    if (continuationWindow <= 1 && !latestDecisionEvent && typeof task.lastProgressScore !== "number") {
      return null;
    }

    const payload =
      latestDecisionEvent?.payload && typeof latestDecisionEvent.payload === "object"
        ? (latestDecisionEvent.payload as Record<string, unknown>)
        : {};
    const deepWorkMode = task.agentConfig?.deepWorkMode === true;
    const configuredMaxContinuations = task.agentConfig?.maxAutoContinuations;
    const eventMaxAutoContinuations =
      typeof payload.maxAutoContinuations === "number"
        ? Math.max(0, Math.floor(payload.maxAutoContinuations))
        : null;
    const maxAutoContinuations =
      typeof configuredMaxContinuations === "number"
        ? Math.max(0, Math.floor(configuredMaxContinuations))
        : typeof eventMaxAutoContinuations === "number"
          ? eventMaxAutoContinuations
          : !deepWorkMode && typeof guardrailDefaultMaxAutoContinuations === "number"
            ? Math.max(0, Math.floor(guardrailDefaultMaxAutoContinuations))
            : deepWorkMode
          ? 7
          : 3;
    const maxWindow = Math.max(1, maxAutoContinuations + 1, continuationWindow);
    const progressScoreRaw =
      typeof payload.progressScore === "number"
        ? payload.progressScore
        : typeof task.lastProgressScore === "number"
          ? task.lastProgressScore
          : null;
    const loopRiskRaw = typeof payload.loopRiskIndex === "number" ? payload.loopRiskIndex : null;

    return {
      window: `Window ${continuationWindow}/${maxWindow}`,
      progress:
        typeof progressScoreRaw === "number"
          ? `Progress ${formatSignedScore(progressScoreRaw)}`
          : undefined,
      loopRisk:
        typeof loopRiskRaw === "number" ? `Loop risk ${describeLoopRisk(loopRiskRaw)}` : undefined,
    };
  }, [events, guardrailDefaultMaxAutoContinuations, isTaskWorking, task]);

  const latestCanvasSessionId = useMemo(() => {
    if (canvasSessions.length === 0) return null;
    const eligibleSessions = latestUserMessageTimestamp
      ? canvasSessions.filter((session) => session.createdAt >= latestUserMessageTimestamp)
      : canvasSessions;
    const pool = eligibleSessions.length > 0 ? eligibleSessions : canvasSessions;
    return pool.reduce((latest, session) => {
      return session.createdAt > latest.createdAt ? session : latest;
    }, pool[0]).id;
  }, [canvasSessions, latestUserMessageTimestamp]);

  const timelineItems = useMemo(() => {
    type EventItem = {
      kind: "event";
      event: (typeof filteredEvents)[number];
      eventIndex: number;
      timestamp: number;
    };
    type CanvasItem = {
      kind: "canvas";
      session: (typeof canvasSessions)[number];
      timestamp: number;
      forceSnapshot: boolean;
    };
    type DispatchedItem = { kind: "dispatched-agents"; timestamp: number };
    type TimelineItem = EventItem | CanvasItem | DispatchedItem;

    const eventItems: EventItem[] = filteredEvents.map((event, index) => ({
      kind: "event" as const,
      event,
      eventIndex: index,
      timestamp: event.timestamp,
    }));

    const freezeBefore = latestUserMessageTimestamp;
    const canvasItems: CanvasItem[] = canvasSessions
      .map((session) => ({
        kind: "canvas" as const,
        session,
        timestamp: session.createdAt,
        forceSnapshot: Boolean(
          (freezeBefore && session.createdAt < freezeBefore) ||
          (latestCanvasSessionId && session.id !== latestCanvasSessionId),
        ),
      }))
      .sort((a, b) => a.timestamp - b.timestamp);

    // Build a sorted list of special items (canvas + dispatched agents) to merge in
    const specialItems: TimelineItem[] = [...canvasItems];

    // Insert dispatched agents panel at the chronological position of the first child task
    if (!collaborativeRun && childTasks.length > 0) {
      const firstChildTimestamp = Math.min(...childTasks.map((t) => t.createdAt));
      specialItems.push({ kind: "dispatched-agents" as const, timestamp: firstChildTimestamp });
    }

    specialItems.sort((a, b) => a.timestamp - b.timestamp);

    if (specialItems.length === 0) return eventItems;

    const merged: TimelineItem[] = [];
    let specialIndex = 0;

    for (const eventItem of eventItems) {
      while (
        specialIndex < specialItems.length &&
        specialItems[specialIndex].timestamp <= eventItem.timestamp
      ) {
        merged.push(specialItems[specialIndex]);
        specialIndex += 1;
      }
      merged.push(eventItem);
    }

    while (specialIndex < specialItems.length) {
      merged.push(specialItems[specialIndex]);
      specialIndex += 1;
    }

    return merged;
  }, [
    filteredEvents,
    canvasSessions,
    latestCanvasSessionId,
    latestUserMessageTimestamp,
    collaborativeRun,
    childTasks,
  ]);

  // Build all command output sessions so previous command windows remain visible.
  const commandOutputSessions = useMemo<CommandOutputSession[]>(() => {
    const commandOutputEvents = events.filter(
      (event) => getEffectiveTaskEventType(event) === "command_output",
    );
    if (commandOutputEvents.length === 0) return [];

    const sessions: CommandOutputSession[] = [];
    let currentSession: CommandOutputSession | null = null;
    let syntheticIdCounter = 0;

    const finalizeCurrentSession = () => {
      if (!currentSession) return;
      sessions.push(currentSession);
      currentSession = null;
    };

    for (const event of commandOutputEvents) {
      const payload =
        event.payload && typeof event.payload === "object" && !Array.isArray(event.payload)
          ? (event.payload as Record<string, unknown>)
          : {};
      const payloadType = typeof payload.type === "string" ? payload.type : "";
      const payloadCommand = typeof payload.command === "string" ? payload.command : "";
      const payloadOutput = typeof payload.output === "string" ? payload.output : "";

      if (payloadType === "start") {
        // Previous session did not emit an end event; keep it visible in timeline.
        finalizeCurrentSession();
        currentSession = {
          id: event.id || `command-${event.timestamp}-${syntheticIdCounter++}`,
          command: payloadCommand,
          output: payloadOutput,
          isRunning: true,
          exitCode: null,
          startTimestamp: event.timestamp,
        };
        continue;
      }

      if (!currentSession) {
        currentSession = {
          id: event.id || `command-${event.timestamp}-${syntheticIdCounter++}`,
          command: payloadCommand,
          output: "",
          isRunning: payloadType !== "end",
          exitCode: null,
          startTimestamp: event.timestamp,
        };
      } else if (!currentSession.command && payloadCommand) {
        currentSession.command = payloadCommand;
      }

      if (
        payloadType === "stdout" ||
        payloadType === "stderr" ||
        payloadType === "stdin" ||
        payloadType === "error"
      ) {
        currentSession.output += payloadOutput;
        continue;
      }

      if (payloadType === "end") {
        currentSession.isRunning = false;
        currentSession.exitCode = typeof payload.exitCode === "number" ? payload.exitCode : null;
        finalizeCurrentSession();
      }
    }

    if (currentSession) {
      sessions.push(currentSession);
    }

    const maxUiOutputChars = 50 * 1024;
    return sessions.map((session) => {
      if (session.output.length <= maxUiOutputChars) return session;
      return {
        ...session,
        output: "[... earlier output truncated ...]\n\n" + session.output.slice(-maxUiOutputChars),
      };
    });
  }, [events]);

  const visibleCommandOutputSessions = useMemo(
    () =>
      commandOutputSessions.filter(
        (session) => session.isRunning || !dismissedCommandOutputs.has(session.id),
      ),
    [commandOutputSessions, dismissedCommandOutputs],
  );

  // Group command outputs by insertion point in the timeline.
  const commandOutputSessionsByInsertIndex = useMemo(() => {
    const grouped = new Map<number, CommandOutputSession[]>();
    for (const session of visibleCommandOutputSessions) {
      let insertIndex = -1;
      for (let i = filteredEvents.length - 1; i >= 0; i--) {
        if (filteredEvents[i].timestamp <= session.startTimestamp) {
          insertIndex = i;
          break;
        }
      }
      const existing = grouped.get(insertIndex);
      if (existing) {
        existing.push(session);
      } else {
        grouped.set(insertIndex, [session]);
      }
    }
    return grouped;
  }, [filteredEvents, visibleCommandOutputSessions]);

  // Toggle verbose mode and persist to appearance settings
  const toggleVerboseSteps = () => {
    const nextVerbose = !verboseSteps;
    setVerboseSteps(nextVerbose);
    void window.electronAPI
      .saveAppearanceSettings({
        timelineVerbosity: nextVerbose ? "verbose" : "summary",
      })
      .catch((error) => {
        console.error("Failed to save timeline verbosity:", error);
      });
  };

  const toggleCodePreviews = () => {
    setCodePreviewsExpanded((prev) => {
      const newValue = !prev;
      localStorage.setItem(CODE_PREVIEWS_EXPANDED_KEY, String(newValue));
      return newValue;
    });
  };

  // Load app version
  useEffect(() => {
    window.electronAPI
      .getAppVersion()
      .then((info) => setAppVersion(info.version))
      .catch((err) => console.error("Failed to load version:", err));
  }, []);

  // Load summary/verbose timeline preference from persisted appearance settings.
  useEffect(() => {
    window.electronAPI
      .getAppearanceSettings()
      .then((settings) => {
        setVerboseSteps(settings.timelineVerbosity === "verbose");
      })
      .catch(() => {
        // Keep summary default on load failure
      });
  }, []);

  useEffect(() => {
    let disposed = false;
    window.electronAPI
      .getGuardrailSettings()
      .then((settings) => {
        if (disposed) return;
        setGuardrailDefaultMaxAutoContinuations(settings.defaultMaxAutoContinuations);
      })
      .catch(() => {
        // Keep built-in fallback when settings are unavailable.
      });
    return () => {
      disposed = true;
    };
  }, []);

  // Load voice settings
  useEffect(() => {
    window.electronAPI
      .getVoiceSettings()
      .then((settings) => {
        setVoiceEnabled(settings.enabled);
        setVoiceResponseMode(settings.responseMode);
      })
      .catch((err) => console.error("Failed to load voice settings:", err));

    // Subscribe to voice state changes
    const unsubscribe = window.electronAPI.onVoiceEvent((event) => {
      if (
        event.type === "voice:state-changed" &&
        typeof event.data === "object" &&
        "isActive" in event.data
      ) {
        setVoiceEnabled(event.data.isActive);
      }
    });

    return () => unsubscribe();
  }, []);

  // Auto-speak new assistant messages based on response mode
  useEffect(() => {
    if (!voiceEnabled || voiceResponseMode === "manual") return;

    const assistantMessages = events.filter(
      (e) => getEffectiveTaskEventType(e) === "assistant_message" && e.payload?.internal !== true,
    );
    if (assistantMessages.length === 0) return;

    const lastMessage = assistantMessages[assistantMessages.length - 1];
    const messageText = lastMessage.payload?.message || "";

    // Skip if already spoken
    if (lastSpokenMessageRef.current === messageText) return;

    // Check if should speak based on mode
    const hasDirective = /\[\[speak\]\]/i.test(messageText);

    if (voiceResponseMode === "auto" || (voiceResponseMode === "smart" && hasDirective)) {
      // Extract text to speak
      let textToSpeak = messageText;

      // If smart mode, only speak content within [[speak]] tags
      if (voiceResponseMode === "smart" && hasDirective) {
        const matches = messageText.match(/\[\[speak\]\]([\s\S]*?)\[\[\/speak\]\]/gi);
        if (matches) {
          textToSpeak = matches
            .map((m: string) => m.replace(/\[\[speak\]\]/gi, "").replace(/\[\[\/speak\]\]/gi, ""))
            .join(" ")
            .trim();
        }
      } else {
        // Strip markdown for cleaner speech
        textToSpeak = textToSpeak
          .replace(/```[\s\S]*?```/g, "")
          .replace(/`[^`]+`/g, "")
          .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
          .replace(/!\[([^\]]*)\]\([^)]+\)/g, "")
          .replace(/^#{1,6}\s+/gm, "")
          .replace(/\*\*([^*]+)\*\*/g, "$1")
          .replace(/\*([^*]+)\*/g, "$1")
          .trim();
      }

      if (textToSpeak) {
        lastSpokenMessageRef.current = messageText;
        window.electronAPI.voiceSpeak(textToSpeak).catch((err) => {
          console.error("Failed to auto-speak:", err);
        });
      }
    }
  }, [events, voiceEnabled, voiceResponseMode]);

  // Load custom skills (task skills only, excludes guidelines)
  useEffect(() => {
    window.electronAPI
      .listTaskSkills()
      .then((skills) => setCustomSkills(skills.filter((s) => s.enabled !== false)))
      .catch((err) => console.error("Failed to load custom skills:", err));
  }, []);

  // Load active agent roles for @mention autocomplete
  useEffect(() => {
    window.electronAPI
      .getAgentRoles()
      .then((roles) => setAgentRoles(roles.filter((role) => role.isActive)))
      .catch((err) => console.error("Failed to load agent roles:", err));
  }, []);

  // Pre-normalize agent role search strings once when roles change (avoids per-keystroke string ops)
  const normalizedRoleIndex = useMemo(() => {
    const index = new Map<string, string>();
    for (const role of agentRoles) {
      const haystack = normalizeMentionSearch(
        `${role.displayName} ${role.name} ${role.description ?? ""}`,
      );
      index.set(role.id, haystack);
    }
    return index;
  }, [agentRoles]);

  // Load canvas sessions when task changes
  useEffect(() => {
    if (!task?.id) {
      setCanvasSessions([]);
      return;
    }

    // Load existing canvas sessions for this task
    window.electronAPI
      .canvasListSessions(task.id)
      .then((sessions) => {
        // Filter to only active/paused sessions
        setCanvasSessions(sessions.filter((s) => s.status !== "closed"));
      })
      .catch((err) => console.error("Failed to load canvas sessions:", err));
  }, [task?.id]);

  // Subscribe to canvas events
  useEffect(() => {
    const unsubscribe = window.electronAPI.onCanvasEvent((event) => {
      // Only process events for the current task
      if (task?.id && event.taskId === task.id) {
        // Don't show preview on session_created - wait until content is actually pushed
        if (event.type === "content_pushed") {
          // Content has been pushed, now show the preview if not already showing
          // Fetch the session info and add it to the list
          window.electronAPI
            .canvasGetSession(event.sessionId)
            .then((session) => {
              if (session && session.status !== "closed") {
                setCanvasSessions((prev) => {
                  // Only add if not already in the list
                  if (prev.some((s) => s.id === session.id)) {
                    return prev;
                  }
                  return [...prev, session];
                });
              }
            })
            .catch((err) => console.error("Failed to get canvas session:", err));
        } else if (event.type === "session_updated" && event.session) {
          const updatedSession = event.session;
          setCanvasSessions((prev) => {
            const exists = prev.some((s) => s.id === event.sessionId);
            if (!exists && updatedSession.status !== "closed") {
              return [...prev, updatedSession];
            }
            return prev.map((s) => (s.id === event.sessionId ? updatedSession : s));
          });
        } else if (event.type === "session_closed") {
          setCanvasSessions((prev) => prev.filter((s) => s.id !== event.sessionId));
        }
      }
    });

    return unsubscribe;
  }, [task?.id]);

  // Handle removing a canvas session from the UI
  const handleCanvasClose = useCallback((sessionId: string) => {
    setCanvasSessions((prev) => prev.filter((s) => s.id !== sessionId));
  }, []);

  // Handle dismissing a specific command output window
  const handleDismissCommandOutput = useCallback((commandOutputId: string) => {
    setDismissedCommandOutputs((prev) => {
      const updated = new Set(prev);
      updated.add(commandOutputId);
      // Persist to localStorage
      localStorage.setItem("dismissedCommandOutputs", JSON.stringify([...updated]));
      return updated;
    });
  }, []);

  const renderCommandOutputs = useCallback(
    (sessions: CommandOutputSession[] | undefined) => {
      if (!sessions || sessions.length === 0) return null;
      return sessions.map((session) => (
        <CommandOutput
          key={session.id}
          command={session.command}
          output={session.output}
          isRunning={session.isRunning}
          exitCode={session.exitCode}
          taskId={task?.id}
          onClose={() => handleDismissCommandOutput(session.id)}
        />
      ));
    },
    [handleDismissCommandOutput, task?.id],
  );

  // Filter skills based on search query
  const filteredSkills = useMemo(() => {
    if (!skillsSearchQuery.trim()) return customSkills;
    const query = skillsSearchQuery.toLowerCase();
    return customSkills.filter(
      (skill) =>
        skill.name.toLowerCase().includes(query) ||
        skill.description?.toLowerCase().includes(query) ||
        skill.category?.toLowerCase().includes(query),
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
      const updatedWorkspace = await window.electronAPI.updateWorkspacePermissions(workspace.id, {
        shell: newValue,
      });
      if (updatedWorkspace) {
        setShellEnabled(updatedWorkspace?.permissions?.shell ?? newValue);
        onSelectWorkspace?.(updatedWorkspace);
        setWorkspacesList((prev) =>
          prev.map((item) => (item.id === updatedWorkspace.id ? updatedWorkspace : item)),
        );
      }
    } catch (err) {
      console.error("Failed to update shell permission:", err);
      setShellEnabled(!newValue); // Revert on error
    }
  };

  // Close skills menu on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (skillsMenuRef.current && !skillsMenuRef.current.contains(e.target as Node)) {
        setShowSkillsMenu(false);
        setSkillsSearchQuery("");
      }
    };
    if (showSkillsMenu) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showSkillsMenu]);

  // Close workspace dropdown on click outside
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (
        workspaceDropdownRef.current &&
        !workspaceDropdownRef.current.contains(e.target as Node)
      ) {
        setShowWorkspaceDropdown(false);
      }
    };
    if (showWorkspaceDropdown) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showWorkspaceDropdown]);

  // Close overflow menu on click outside (focused mode)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (overflowMenuRef.current && !overflowMenuRef.current.contains(e.target as Node)) {
        setShowOverflowMenu(false);
      }
    };
    if (showOverflowMenu) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showOverflowMenu]);

  const getOverflowMenuItems = useCallback((): HTMLElement[] => {
    if (!overflowMenuRef.current) return [];
    return Array.from(
      overflowMenuRef.current.querySelectorAll<HTMLElement>(
        "[data-overflow-menu-item]:not([disabled])",
      ),
    );
  }, []);

  useEffect(() => {
    if (!showOverflowMenu) return;
    const items = getOverflowMenuItems();
    items[0]?.focus();
  }, [showOverflowMenu, getOverflowMenuItems]);

  useEffect(() => {
    if (!showOverflowMenu) {
      setOverflowSubmenu(null);
    }
  }, [showOverflowMenu]);

  const handleOverflowButtonKeyDown = useCallback((e: React.KeyboardEvent<HTMLButtonElement>) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setShowOverflowMenu(true);
    } else if (e.key === "Escape") {
      e.preventDefault();
      setShowOverflowMenu(false);
    }
  }, []);

  const handleOverflowMenuKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      const items = getOverflowMenuItems();
      if (items.length === 0) return;
      const activeIndex = items.findIndex((item) => item === document.activeElement);

      if (e.key === "Escape") {
        e.preventDefault();
        setShowOverflowMenu(false);
        overflowToggleBtnRef.current?.focus();
        return;
      }

      if (e.key === "ArrowDown") {
        e.preventDefault();
        const nextIndex = activeIndex < 0 ? 0 : (activeIndex + 1) % items.length;
        items[nextIndex]?.focus();
        return;
      }

      if (e.key === "ArrowUp") {
        e.preventDefault();
        const prevIndex =
          activeIndex < 0 ? items.length - 1 : (activeIndex - 1 + items.length) % items.length;
        items[prevIndex]?.focus();
        return;
      }

      if (e.key === "Home") {
        e.preventDefault();
        items[0]?.focus();
        return;
      }

      if (e.key === "End") {
        e.preventDefault();
        items[items.length - 1]?.focus();
      }
    },
    [getOverflowMenuItems],
  );

  // Close model dropdown from label on click outside (focused mode)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (modelLabelRef.current && !modelLabelRef.current.contains(e.target as Node)) {
        setShowModelDropdownFromLabel(false);
      }
    };
    if (showModelDropdownFromLabel) {
      document.addEventListener("mousedown", handleClickOutside);
    }
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [showModelDropdownFromLabel]);

  // Handle workspace dropdown toggle - load workspaces when opening
  const handleWorkspaceDropdownToggle = async () => {
    if (!showWorkspaceDropdown) {
      try {
        const workspaces = await window.electronAPI.listWorkspaces();
        // Filter out temp workspace and sort by most recently used
        const filteredWorkspaces = workspaces
          .filter((w: Workspace) => !w.isTemp && !isTempWorkspaceId(w.id))
          .sort(
            (a: Workspace, b: Workspace) =>
              (b.lastUsedAt ?? b.createdAt) - (a.lastUsedAt ?? a.createdAt),
          );
        setWorkspacesList(filteredWorkspaces);
      } catch (error) {
        console.error("Failed to load workspaces:", error);
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
    setSkillsSearchQuery("");
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
    setToggledEvents((prev) => {
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
    const effectiveType = getEffectiveTaskEventType(event);
    if (
      effectiveType !== "file_created" &&
      effectiveType !== "file_modified" &&
      effectiveType !== "artifact_created"
    )
      return false;
    const filePath = String(event.payload?.path || event.payload?.from || "");
    const mimeType =
      typeof event.payload?.mimeType === "string" ? event.payload.mimeType.toLowerCase() : "";
    const imageExt = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
    return (
      event.payload?.type === "image" || mimeType.startsWith("image/") || imageExt.test(filePath)
    );
  };

  const isSpreadsheetFileEvent = (event: TaskEvent): boolean => {
    const effectiveType = getEffectiveTaskEventType(event);
    if (
      effectiveType !== "file_created" &&
      effectiveType !== "file_modified" &&
      effectiveType !== "artifact_created"
    )
      return false;
    const filePath = String(event.payload?.path || event.payload?.from || "");
    return event.payload?.type === "spreadsheet" || /\.xlsx?$/i.test(filePath);
  };

  const shouldRenderTimelineEventInStepFeed = (event: TaskEvent): boolean => {
    const effectiveType = getEffectiveTaskEventType(event);
    if (effectiveType === "user_message" || effectiveType === "assistant_message") {
      return false;
    }
    const showEvenWithoutSteps =
      ALWAYS_VISIBLE_TECHNICAL_EVENT_TYPES.has(event.type) ||
      ALWAYS_VISIBLE_TECHNICAL_EVENT_TYPES.has(effectiveType as EventType) ||
      isImageFileEvent(event) ||
      isSpreadsheetFileEvent(event) ||
      (effectiveType === "tool_result" && event.payload?.tool === "schedule_task");
    return showSteps || showEvenWithoutSteps;
  };

  // Check if an event has details to show
  const hasEventDetails = (event: TaskEvent): boolean => {
    const effectiveType = getEffectiveTaskEventType(event);
    if (isImageFileEvent(event)) return true;
    if (isSpreadsheetFileEvent(event)) return true;
    if (workspace?.path && getStepCompletionPreviewPath(event)) return true;
    if (effectiveType === "task_completed") {
      return hasTaskOutputs(resolveTaskOutputSummaryFromCompletionEvent(event, events));
    }
    if (
      !verboseSteps &&
      (event.type === "timeline_group_started" || event.type === "timeline_group_finished")
    ) {
      return false;
    }
    if (
      event.type === "timeline_group_started" ||
      event.type === "timeline_group_finished" ||
      event.type === "timeline_evidence_attached" ||
      event.type === "timeline_error"
    ) {
      return true;
    }
    if (effectiveType === "diagram_created") return true;
    if (
      (event.type === "timeline_artifact_emitted" || effectiveType === "artifact_created") &&
      typeof event.payload?.path === "string"
    )
      return true;
    if (
      effectiveType === "file_created" &&
      (event.payload?.contentPreview || event.payload?.copiedFrom)
    )
      return true;
    if (
      effectiveType === "file_modified" &&
      (event.payload?.oldPreview || event.payload?.action === "rename")
    )
      return true;
    return [
      "plan_created",
      "tool_call",
      "tool_result",
      "assistant_message",
      "error",
      "step_failed",
      "approval_requested",
    ].includes(effectiveType);
  };

  // Determine if an event should be expanded by default
  // Important events (plan, assistant responses, errors) should be expanded
  // Verbose events (tool calls/results) should be collapsed
  const shouldDefaultExpand = (event: TaskEvent): boolean => {
    const effectiveType = getEffectiveTaskEventType(event);
    if (isImageFileEvent(event)) return true;
    if (isSpreadsheetFileEvent(event)) return true;
    if (workspace?.path && getStepCompletionPreviewPath(event)) return true;
    if (effectiveType === "task_completed") return hasEventDetails(event);
    if (
      effectiveType === "artifact_created" ||
      effectiveType === "diagram_created" ||
      event.type === "timeline_evidence_attached" ||
      event.type === "timeline_error"
    )
      return true;
    if (effectiveType === "approval_requested") {
      return isRunCommandApproval(getApprovalPayload(event));
    }
    // Code previews: expand by default unless user opted for collapsed
    if (codePreviewsExpanded) {
      if (
        effectiveType === "file_created" &&
        (event.payload?.contentPreview || event.payload?.copiedFrom)
      )
        return true;
      if (
        effectiveType === "file_modified" &&
        (event.payload?.oldPreview || event.payload?.action === "rename")
      )
        return true;
    }
    return ["plan_created", "assistant_message", "error", "step_failed"].includes(effectiveType);
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

  // Auto-resize textarea as content changes (uses requestAnimationFrame to batch with browser paint)
  const resizeRafRef = useRef<number>(0);
  const autoResizeTextarea = useCallback(() => {
    if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
    resizeRafRef.current = requestAnimationFrame(() => {
      const textarea = textareaRef.current;
      if (textarea) {
        textarea.style.height = "auto";
        textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
      }
    });
  }, []);

  // Cleanup RAF on unmount
  useEffect(() => {
    return () => {
      if (resizeRafRef.current) cancelAnimationFrame(resizeRafRef.current);
    };
  }, []);

  // Auto-resize when input value changes
  useEffect(() => {
    autoResizeTextarea();
  }, [inputValue, autoResizeTextarea]);

  // Active placeholder: rotating prompt when available, personality fallback otherwise
  const personalityPlaceholder = agentContext.getPlaceholder();
  const placeholder =
    rotatingPlaceholders.length > 0
      ? rotatingPlaceholders[rotatingIndex % rotatingPlaceholders.length]
      : personalityPlaceholder;

  // Calculate cursor position based on placeholder text width
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

  // Auto-scroll to bottom when new events arrive or dispatched agents change
  useEffect(() => {
    if (autoScroll && timelineRef.current && mainBodyRef.current) {
      // Scroll the main body to show the latest event
      mainBodyRef.current.scrollTop = mainBodyRef.current.scrollHeight;
    }
  }, [events, autoScroll, childTasks, childEvents]);

  // Reset auto-scroll when task changes
  useEffect(() => {
    setAutoScroll(true);
  }, [task?.id]);

  const reportAttachmentError = (message: string) => {
    setAttachmentError(message);
    window.setTimeout(() => setAttachmentError(null), 5000);
  };

  const readFileAsBase64 = (file: File): Promise<string> =>
    new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => {
        const result = typeof reader.result === "string" ? reader.result : "";
        const [, base64] = result.split(",");
        if (!base64) {
          reject(new Error("Failed to read file data."));
          return;
        }
        resolve(base64);
      };
      reader.onerror = () => reject(reader.error || new Error("Failed to read file data."));
      reader.readAsDataURL(file);
    });

  const appendPendingAttachments = (files: PendingAttachment[]) => {
    if (files.length === 0) return;
    setPendingAttachments((prev) => {
      const existingKeys = new Set(
        prev.map((attachment) => attachment.path || `${attachment.name}-${attachment.size}`),
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
        })),
      );
    } catch (error) {
      console.error("Failed to select files:", error);
      reportAttachmentError("Failed to add attachments. Please try again.");
    }
  };

  const handleRemoveAttachment = (id: string) => {
    setPendingAttachments((prev) => prev.filter((attachment) => attachment.id !== id));
  };

  const isFileDrag = (event: React.DragEvent) =>
    Array.from(event.dataTransfer.types || []).includes("Files");

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
        }),
      );

      appendPendingAttachments(pending);
    } catch (error) {
      console.error("Failed to handle dropped files:", error);
      reportAttachmentError("Failed to attach dropped files.");
    }
  };

  const handlePaste = async (event: React.ClipboardEvent) => {
    const clipboardData = event.clipboardData;
    let clipboardFiles = Array.from(clipboardData?.files || []);
    if (clipboardFiles.length === 0 && clipboardData?.items) {
      Array.from(clipboardData.items).forEach((item: DataTransferItem) => {
        if (item.kind === "file") {
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
        }),
      );

      appendPendingAttachments(pending);
    } catch (error) {
      console.error("Failed to handle pasted files:", error);
      reportAttachmentError("Failed to attach pasted files.");
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
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                    <path d="M14 2v6h6" />
                  </svg>
                </span>
                <span className="attachment-name" title={attachment.name}>
                  {attachment.name}
                </span>
                <span className="attachment-size">{formatFileSize(attachment.size)}</span>
                <button
                  className="attachment-remove"
                  onClick={() => handleRemoveAttachment(attachment.id)}
                  title="Remove attachment"
                  disabled={isUploadingAttachments}
                >
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
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
      throw new Error("Select a workspace before attaching files.");
    }
    const pathAttachments = pendingAttachments.filter(
      (attachment) => attachment.path && !attachment.dataBase64,
    );
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

      // Build native ImageAttachment[] from image-type attachments so the LLM
      // can see the actual pixels (vision) instead of relying on OCR text only.
      const IMAGE_MIME_SET = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
      const nativeImageAttachments: ImageAttachment[] = [];
      for (let i = 0; i < pendingAttachments.length; i++) {
        const pa = pendingAttachments[i];
        if (!pa.mimeType || !IMAGE_MIME_SET.has(pa.mimeType)) continue;
        if (pa.dataBase64) {
          nativeImageAttachments.push({
            data: pa.dataBase64,
            mimeType: pa.mimeType as ImageAttachment["mimeType"],
            filename: pa.name,
            sizeBytes: pa.size,
          });
        } else if (pa.path) {
          nativeImageAttachments.push({
            filePath: pa.path,
            mimeType: pa.mimeType as ImageAttachment["mimeType"],
            filename: pa.name,
            sizeBytes: pa.size,
          });
        }
      }
      const imagePayload = nativeImageAttachments.length > 0 ? nativeImageAttachments : undefined;

      // Compose text message (with OCR fallback for non-image files)
      const composeResult = await composeMessageWithAttachments(
        workspace?.path,
        trimmedInput,
        importedAttachments,
      );
      const hasExtractionWarnings = composeResult.extractionWarnings.length > 0;
      if (hasExtractionWarnings) {
        const warningList = composeResult.extractionWarnings.join(", ");
        setAttachmentError(
          `I had trouble reading ${warningList}. They were attached, but I may not have had full content.`,
        );
      }
      const message = composeResult.message;

      // Use selectedTaskId to determine if we should follow-up or create new task
      // This fixes the bug where old tasks (beyond the 100 most recent) would create new tasks
      // instead of sending follow-up messages
      if (!selectedTaskId && onCreateTask) {
        // No task selected - create new task with optional autonomy enabled
        const titleSource =
          trimmedInput ||
          (pendingAttachments[0]?.name ? `Review ${pendingAttachments[0].name}` : "New task");
        const title = buildTaskTitle(titleSource);
        const modeOptions: CreateTaskOptions = {
          executionMode,
          taskDomain,
        };
        const baseOptions: CreateTaskOptions =
          multiLlmModeEnabled && multiLlmConfig
            ? { ...modeOptions, multiLlmMode: true, multiLlmConfig }
            : collaborativeModeEnabled
              ? { ...modeOptions, collaborativeMode: true }
              : autonomousModeEnabled
                ? { ...modeOptions, autonomousMode: true }
                : modeOptions;
        const options: CreateTaskOptions = verificationAgentEnabled
          ? { ...baseOptions, verificationAgent: true }
          : baseOptions;
        onCreateTask(title, message, options, imagePayload);
        // Reset task mode state
        setAutonomousModeEnabled(false);
        setCollaborativeModeEnabled(false);
        setMultiLlmModeEnabled(false);
        setMultiLlmConfig(null);
        setVerificationAgentEnabled(false);
      } else {
        // Task is selected (even if not in current list) - send follow-up message
        onSendMessage(message, imagePayload);
      }

      setInputValue("");
      setPendingAttachments([]);
      setMentionOpen(false);
      setMentionQuery("");
      setMentionTarget(null);
    } catch (error) {
      console.error("Failed to send message:", error);
      sendFailed = true;
      const baseError = error instanceof Error ? error.message : "Failed to send message.";
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
    const atIndex = uptoCursor.lastIndexOf("@");
    if (atIndex === -1) return null;
    if (atIndex > 0 && /[a-zA-Z0-9]/.test(uptoCursor[atIndex - 1])) {
      return null;
    }
    const query = uptoCursor.slice(atIndex + 1);
    if (query.startsWith(" ")) return null;
    if (query.includes("\n") || query.includes("\r")) return null;
    return { query, start: atIndex, end: cursor };
  };

  const mentionOptions = useMemo<MentionOption[]>(() => {
    if (!mentionOpen) return [];
    const query = normalizeMentionSearch(mentionQuery);
    const options: MentionOption[] = [];
    const includeEveryone =
      query.length > 0 && ["everybody", "everyone", "all"].some((alias) => alias.startsWith(query));
    if (includeEveryone) {
      options.push({
        type: "everyone",
        id: "everyone",
        label: "Everybody",
        description: "Auto-pick the best agents for this task",
        icon: "👥",
        color: "#64748b",
      });
    }

    const filteredAgents = agentRoles
      .filter((role) => {
        if (!query) return true;
        // Use pre-normalized index for O(1) lookup instead of per-keystroke normalization
        const haystack = normalizedRoleIndex.get(role.id) ?? "";
        return haystack.includes(query);
      })
      .sort((a, b) => {
        if (a.sortOrder !== b.sortOrder) {
          return (a.sortOrder ?? 0) - (b.sortOrder ?? 0);
        }
        return a.displayName.localeCompare(b.displayName);
      });

    filteredAgents.forEach((role) => {
      options.push({
        type: "agent",
        id: role.id,
        label: role.displayName,
        description: role.description,
        icon: role.icon,
        color: role.color,
      });
    });

    return options;
  }, [mentionOpen, mentionQuery, agentRoles, normalizedRoleIndex]);

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
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [mentionOpen]);

  const mentionOpenRef = useRef(mentionOpen);
  const mentionQueryRef = useRef(mentionQuery);
  const mentionTargetRef = useRef(mentionTarget);

  useEffect(() => {
    mentionOpenRef.current = mentionOpen;
  }, [mentionOpen]);

  useEffect(() => {
    mentionQueryRef.current = mentionQuery;
  }, [mentionQuery]);

  useEffect(() => {
    mentionTargetRef.current = mentionTarget;
  }, [mentionTarget]);

  // Slash command refs (mirrors mention refs pattern)
  const slashOpenRef = useRef(slashOpen);
  const slashQueryRef = useRef(slashQuery);
  const slashTargetRef = useRef(slashTarget);
  const slashDropdownRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    slashOpenRef.current = slashOpen;
  }, [slashOpen]);

  useEffect(() => {
    slashQueryRef.current = slashQuery;
  }, [slashQuery]);

  useEffect(() => {
    slashTargetRef.current = slashTarget;
  }, [slashTarget]);

  // Close slash dropdown on outside click
  useEffect(() => {
    if (!slashOpen) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (mentionContainerRef.current && !mentionContainerRef.current.contains(e.target as Node)) {
        setSlashOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, [slashOpen]);

  const findSlashAtCursor = (value: string, cursor: number | null) => {
    if (cursor === null) return null;
    const uptoCursor = value.slice(0, cursor);
    // Find the last `/` before cursor
    const slashIndex = uptoCursor.lastIndexOf("/");
    if (slashIndex === -1) return null;
    // `/` must be at position 0 or preceded by a newline
    if (slashIndex > 0 && uptoCursor[slashIndex - 1] !== "\n") return null;
    const query = uptoCursor.slice(slashIndex + 1);
    // No spaces or newlines allowed in query
    if (query.includes(" ") || query.includes("\n") || query.includes("\r")) return null;
    return { query, start: slashIndex, end: cursor };
  };

  const slashOptions = useMemo<SlashCommandOption[]>(() => {
    if (!slashOpen) return [];
    const query = slashQuery.toLowerCase();
    return customSkills
      .filter((skill) => {
        if (!query) return true;
        return (
          skill.name.toLowerCase().includes(query) ||
          skill.id.toLowerCase().includes(query) ||
          (skill.description || "").toLowerCase().includes(query)
        );
      })
      .slice(0, 10)
      .map((skill) => ({
        id: skill.id,
        name: skill.name,
        description: skill.description,
        icon: skill.icon,
        hasParams: !!(skill.parameters && skill.parameters.length > 0),
        skill,
      }));
  }, [slashOpen, slashQuery, customSkills]);

  // Reset slash selected index when options change
  useEffect(() => {
    if (slashSelectedIndex >= slashOptions.length) {
      setSlashSelectedIndex(0);
    }
  }, [slashOptions, slashSelectedIndex]);

  const updateMentionState = useCallback((value: string, cursor: number | null) => {
    const mention = findMentionAtCursor(value, cursor);
    if (!mention) {
      // Only update state if it actually changed — avoids unnecessary re-renders
      if (mentionOpenRef.current) setMentionOpen(false);
      if (mentionQueryRef.current !== "") setMentionQuery("");
      if (mentionTargetRef.current !== null) setMentionTarget(null);
      return;
    }
    // Close slash if mention opens
    if (slashOpenRef.current) setSlashOpen(false);
    if (!mentionOpenRef.current) setMentionOpen(true);
    if (mentionQueryRef.current !== mention.query) setMentionQuery(mention.query);
    const prev = mentionTargetRef.current;
    if (!prev || prev.start !== mention.start || prev.end !== mention.end) {
      setMentionTarget({ start: mention.start, end: mention.end });
    }
    setMentionSelectedIndex(0);
  }, []);

  const updateSlashState = useCallback((value: string, cursor: number | null) => {
    const slash = findSlashAtCursor(value, cursor);
    if (!slash) {
      if (slashOpenRef.current) setSlashOpen(false);
      if (slashQueryRef.current !== "") setSlashQuery("");
      if (slashTargetRef.current !== null) setSlashTarget(null);
      return;
    }
    // Close mention if slash opens
    if (mentionOpenRef.current) setMentionOpen(false);
    if (!slashOpenRef.current) setSlashOpen(true);
    if (slashQueryRef.current !== slash.query) setSlashQuery(slash.query);
    const prev = slashTargetRef.current;
    if (!prev || prev.start !== slash.start || prev.end !== slash.end) {
      setSlashTarget({ start: slash.start, end: slash.end });
    }
    setSlashSelectedIndex(0);
  }, []);

  const handleSlashSelect = (option: SlashCommandOption) => {
    if (!slashTarget) return;
    setSlashOpen(false);
    setSlashQuery("");
    setSlashTarget(null);

    if (option.hasParams) {
      // Show parameter modal
      setInputValue("");
      setSelectedSkillForParams(option.skill);
    } else {
      // No parameters — create task directly with skill prompt
      setInputValue("");
      if (onCreateTask) {
        const title = buildTaskTitle(option.skill.prompt);
        onCreateTask(title, option.skill.prompt);
      }
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const value = e.target.value;
    setInputValue(value);
    updateMentionState(value, e.target.selectionStart);
    updateSlashState(value, e.target.selectionStart);
  };

  const handleInputClick = (e: React.MouseEvent<HTMLTextAreaElement>) => {
    updateMentionState(inputValue, e.currentTarget.selectionStart);
    updateSlashState(inputValue, e.currentTarget.selectionStart);
  };

  const handleInputKeyUp = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (["ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "Home", "End"].includes(e.key)) {
      const cursor = (e.currentTarget as HTMLTextAreaElement).selectionStart;
      updateMentionState(inputValue, cursor);
      updateSlashState(inputValue, cursor);
    }
  };

  const handleMentionSelect = (option: MentionOption) => {
    if (!mentionTarget) return;
    const insertText = option.type === "everyone" ? "@everybody" : `@${option.label}`;
    const before = inputValue.slice(0, mentionTarget.start);
    const after = inputValue.slice(mentionTarget.end);
    const needsSpace = after.length === 0 ? true : !after.startsWith(" ");
    const nextValue = `${before}${insertText}${needsSpace ? " " : ""}${after}`;
    setInputValue(nextValue);
    setMentionOpen(false);
    setMentionQuery("");
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
          const displayLabel = option.type === "everyone" ? "@everybody" : `@${option.label}`;
          return (
            <button
              key={`${option.type}-${option.id}`}
              className={`mention-autocomplete-item ${index === mentionSelectedIndex ? "selected" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault();
                handleMentionSelect(option);
              }}
              onMouseEnter={() => setMentionSelectedIndex(index)}
            >
              <span
                className="mention-autocomplete-icon"
                style={{ backgroundColor: option.color || "#64748b" }}
              >
                <ThemeIcon emoji={option.icon || "👥"} icon={<UsersIcon size={16} />} />
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

  const renderSlashDropdown = () => {
    if (!slashOpen || slashOptions.length === 0) return null;
    return (
      <div
        className="mention-autocomplete-dropdown slash-autocomplete-dropdown"
        ref={slashDropdownRef}
      >
        {slashOptions.map((option, index) => (
          <button
            key={option.id}
            className={`mention-autocomplete-item ${index === slashSelectedIndex ? "selected" : ""}`}
            onMouseDown={(e) => {
              e.preventDefault();
              handleSlashSelect(option);
            }}
            onMouseEnter={() => setSlashSelectedIndex(index)}
          >
            <span className="mention-autocomplete-icon slash-command-icon">{option.icon}</span>
            <div className="mention-autocomplete-details">
              <span className="mention-autocomplete-name">/{option.name}</span>
              {option.description && (
                <span className="mention-autocomplete-desc">{option.description}</span>
              )}
            </div>
          </button>
        ))}
      </div>
    );
  };

  const renderExecutionModeRow = () => (
    <div className="overflow-menu-item" role="none">
      <button
        className={`goal-mode-toggle overflow-submenu-trigger menu-tooltip-target ${
          overflowSubmenu === "mode" ? "active" : ""
        }`}
        style={{ margin: 0 }}
        onClick={() => setOverflowSubmenu((current) => (current === "mode" ? null : "mode"))}
        data-tooltip={EXECUTION_MODE_HINT[executionMode]}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={overflowSubmenu === "mode"}
        data-overflow-menu-item
      >
        <span className="overflow-submenu-trigger-content">
          <span className="goal-mode-toggle-text">
            <span className="goal-mode-label">Mode: {EXECUTION_MODE_LABEL[executionMode]}</span>
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="overflow-submenu-chevron"
            aria-hidden="true"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
      </button>
    </div>
  );

  const renderTaskDomainRow = () => (
    <div className="overflow-menu-item" role="none">
      <button
        className={`goal-mode-toggle overflow-submenu-trigger menu-tooltip-target ${
          overflowSubmenu === "domain" ? "active" : ""
        }`}
        style={{ margin: 0 }}
        onClick={() => setOverflowSubmenu((current) => (current === "domain" ? null : "domain"))}
        data-tooltip={TASK_DOMAIN_HINT[taskDomain]}
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={overflowSubmenu === "domain"}
        data-overflow-menu-item
      >
        <span className="overflow-submenu-trigger-content">
          <span className="goal-mode-toggle-text">
            <span className="goal-mode-label">Domain: {TASK_DOMAIN_LABEL[taskDomain]}</span>
          </span>
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            className="overflow-submenu-chevron"
            aria-hidden="true"
          >
            <path d="M9 6l6 6-6 6" />
          </svg>
        </span>
      </button>
    </div>
  );

  const renderOverflowSubmenu = () => {
    if (overflowSubmenu === null) return null;

    const isModeSubmenu = overflowSubmenu === "mode";
    const title = isModeSubmenu ? "Mode" : "Domain";

    return (
      <div className="overflow-submenu-panel" role="menu" aria-label={`${title} options`}>
        <div className="overflow-submenu-header">
          <span className="overflow-submenu-title">{title}</span>
        </div>
        {(isModeSubmenu ? EXECUTION_MODE_ORDER : TASK_DOMAIN_ORDER).map((value) => {
          const label = isModeSubmenu
            ? EXECUTION_MODE_LABEL[value as ExecutionMode]
            : TASK_DOMAIN_LABEL[value as TaskDomain];
          const selected = isModeSubmenu ? executionMode === value : taskDomain === value;

          return (
            <button
              key={value}
              type="button"
              className={`overflow-submenu-option ${selected ? "active" : ""}`}
              onClick={() => {
                if (isModeSubmenu) {
                  setExecutionMode(value as ExecutionMode);
                } else {
                  setTaskDomain(value as TaskDomain);
                }
                setOverflowSubmenu(null);
              }}
              role="menuitemradio"
              aria-checked={selected}
              data-overflow-menu-item
            >
              <span>{label}</span>
              {selected && (
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  className="overflow-submenu-check"
                  aria-hidden="true"
                >
                  <path d="M20 6L9 17l-5-5" />
                </svg>
              )}
            </button>
          );
        })}
      </div>
    );
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (mentionOpen && mentionOptions.length > 0) {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setMentionSelectedIndex((prev) => (prev + 1) % mentionOptions.length);
          return;
        case "ArrowUp":
          e.preventDefault();
          setMentionSelectedIndex(
            (prev) => (prev - 1 + mentionOptions.length) % mentionOptions.length,
          );
          return;
        case "Enter":
        case "Tab":
          e.preventDefault();
          handleMentionSelect(mentionOptions[mentionSelectedIndex]);
          return;
        case "Escape":
          e.preventDefault();
          setMentionOpen(false);
          return;
      }
    }

    if (slashOpen && slashOptions.length > 0) {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          setSlashSelectedIndex((prev) => (prev + 1) % slashOptions.length);
          return;
        case "ArrowUp":
          e.preventDefault();
          setSlashSelectedIndex((prev) => (prev - 1 + slashOptions.length) % slashOptions.length);
          return;
        case "Enter":
        case "Tab":
          if (parseLeadingSkillSlashCommand(inputValue).matched) {
            break;
          }
          e.preventDefault();
          handleSlashSelect(slashOptions[slashSelectedIndex]);
          return;
        case "Escape":
          e.preventDefault();
          setSlashOpen(false);
          return;
      }
    }

    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void handleSend();
    }
  };

  const handleQuickAction = (action: string) => {
    setInputValue(action);
  };

  useEffect(() => {
    if (task?.status === "paused" && textareaRef.current) {
      const inputEl = textareaRef.current;
      window.requestAnimationFrame(() => {
        inputEl.focus();
      });
    }
  }, [task?.status]);

  const formatTime = (timestamp: number) => {
    return new Date(timestamp).toLocaleTimeString(undefined, {
      hour: "2-digit",
      minute: "2-digit",
    });
  };

  // Get the last assistant message to always show the response
  const lastAssistantMessage = useMemo(() => {
    const assistantMessages = events.filter(
      (event) =>
        getEffectiveTaskEventType(event) === "assistant_message" && event.payload?.internal !== true,
    );
    return assistantMessages.length > 0 ? assistantMessages[assistantMessages.length - 1] : null;
  }, [events]);

  // Welcome/Empty state
  if (!task) {
    return (
      <div className="main-content">
        <div className="main-body welcome-view">
          <div
            className={`welcome-content cli-style${uiDensity === "focused" ? " welcome-content-focused" : ""}`}
          >
            {/* Logo */}
            {uiDensity === "focused" ? (
              <div className="welcome-header-focused modern-only">
                <img
                  src="./cowork-os-logo-text-dark.png"
                  alt="CoWork OS"
                  className="modern-logo-text logo-for-dark"
                />
                <img
                  src="./cowork-os-logo-text.png"
                  alt="CoWork OS"
                  className="modern-logo-text logo-for-light"
                />
                <h1 className="focused-greeting">{agentContext.getMessage("welcomeSubtitle")}</h1>
              </div>
            ) : (
              <div className="welcome-header-modern modern-only">
                <div className="modern-logo-container">
                  <img
                    src="./cowork-os-logo-text-dark.png"
                    alt="CoWork OS"
                    className="modern-logo-text logo-for-dark"
                  />
                  <img
                    src="./cowork-os-logo-text.png"
                    alt="CoWork OS"
                    className="modern-logo-text logo-for-light"
                  />
                  <span className="modern-version">{appVersion ? `v${appVersion}` : ""}</span>
                </div>
                <p className="modern-subtitle">{agentContext.getMessage("welcomeSubtitle")}</p>
              </div>
            )}

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
                <div className="cli-version">{appVersion ? `v${appVersion}` : ""}</div>
              </div>

              {/* Terminal Info */}
              <div className="cli-info">
                <div className="cli-line">
                  <span className="cli-prompt">$</span>
                  <span className="cli-text" title={agentContext.getMessage("welcome")}>
                    {agentContext.getMessage("welcome")}
                  </span>
                </div>
                <div className="cli-line cli-line-secondary">
                  <span className="cli-prompt">&gt;</span>
                  <span className="cli-text">{agentContext.getMessage("welcomeSubtitle")}</span>
                </div>
                <div className="cli-line cli-line-disclosure">
                  <span className="cli-prompt">#</span>
                  <span
                    className="cli-text cli-text-muted"
                    title={agentContext.getMessage("disclaimer")}
                  >
                    {agentContext.getMessage("disclaimer")}
                  </span>
                </div>
              </div>
            </div>

            {/* Quick Start */}
            <div className="cli-commands">
              {uiDensity !== "focused" && (
                <div className="cli-commands-header">
                  <span className="cli-prompt">&gt;</span>
                  <span className="terminal-only">QUICK START</span>
                  <span className="modern-only">Quick start</span>
                </div>
              )}
              {uiDensity === "focused" ? (
                <div className="quick-start-grid focused-cards">
                  {focusedCards.map((card) => {
                    const iconMap: Record<string, React.ReactNode> = {
                      edit: <EditIcon size={22} />,
                      search: <SearchIcon size={22} />,
                      chart: <ChartIcon size={22} />,
                      folder: <FolderIcon size={22} />,
                      zap: <ZapIcon size={22} />,
                      message: <MessageIcon size={22} />,
                      clipboard: <ClipboardIcon size={22} />,
                      filetext: <FileTextIcon size={22} />,
                      code: <CodeIcon size={22} />,
                      globe: <GlobeIcon size={22} />,
                      book: <BookIcon size={22} />,
                      calendar: <CalendarIcon size={22} />,
                      sliders: <SlidersIcon size={22} />,
                      shield: <ShieldIcon size={22} />,
                    };
                    const handleClick = () => {
                      if (card.action.type === "prompt") {
                        handleQuickAction(card.action.prompt);
                      } else {
                        onOpenSettings?.(card.action.tab);
                      }
                    };
                    return (
                      <button
                        key={card.id}
                        className={`quick-start-card ${card.category !== "task" ? "card-" + card.category : ""}`}
                        onClick={handleClick}
                        title={card.desc}
                      >
                        <ThemeIcon
                          className="quick-start-icon"
                          emoji={card.emoji}
                          icon={iconMap[card.iconName] || <ZapIcon size={22} />}
                        />
                        <span className="quick-start-title">{card.title}</span>
                        <span className="quick-start-desc">{card.desc}</span>
                      </button>
                    );
                  })}
                </div>
              ) : (
                <div className="quick-start-grid">
                  <button
                    className="quick-start-card"
                    onClick={() =>
                      handleQuickAction(
                        "Let's organize the files in this folder together. Sort them by type and rename them with clear, consistent names.",
                      )
                    }
                    title="Let's sort and tidy up the workspace"
                  >
                    <ThemeIcon
                      className="quick-start-icon"
                      emoji="📁"
                      icon={<FolderIcon size={22} />}
                    />
                    <span className="quick-start-title">Organize files</span>
                    <span className="quick-start-desc">Let's sort and tidy up the workspace</span>
                  </button>
                  <button
                    className="quick-start-card"
                    onClick={() =>
                      handleQuickAction(
                        "Let's write a document together. I'll describe what I need and we can create it.",
                      )
                    }
                    title="Co-create reports, summaries, or notes"
                  >
                    <ThemeIcon
                      className="quick-start-icon"
                      emoji="📝"
                      icon={<EditIcon size={22} />}
                    />
                    <span className="quick-start-title">Write together</span>
                    <span className="quick-start-desc">Co-create reports, summaries, or notes</span>
                  </button>
                  <button
                    className="quick-start-card"
                    onClick={() =>
                      handleQuickAction(
                        "Let's analyze the data files in this folder together. We'll summarize the key findings and create a report.",
                      )
                    }
                    title="Work through spreadsheets or data files"
                  >
                    <ThemeIcon
                      className="quick-start-icon"
                      emoji="📊"
                      icon={<ChartIcon size={22} />}
                    />
                    <span className="quick-start-title">Analyze data</span>
                    <span className="quick-start-desc">
                      Work through spreadsheets or data files
                    </span>
                  </button>
                  <button
                    className="quick-start-card"
                    onClick={() =>
                      handleQuickAction(
                        "Let's generate documentation for this project together. We can create a README, API docs, or code comments as needed.",
                      )
                    }
                    title="Build documentation for the project"
                  >
                    <ThemeIcon
                      className="quick-start-icon"
                      emoji="📖"
                      icon={<BookIcon size={22} />}
                    />
                    <span className="quick-start-title">Generate docs</span>
                    <span className="quick-start-desc">Build documentation for the project</span>
                  </button>
                  <button
                    className="quick-start-card"
                    onClick={() =>
                      handleQuickAction(
                        "Research the top 3-5 competitors in a market I'll describe. For each, find their positioning, key features, pricing, strengths, and weaknesses. Then identify gaps I could exploit.",
                      )
                    }
                    title="Analyze a market and find opportunities"
                  >
                    <ThemeIcon
                      className="quick-start-icon"
                      emoji="🏁"
                      icon={<SearchIcon size={22} />}
                    />
                    <span className="quick-start-title">Research competitors</span>
                    <span className="quick-start-desc">
                      Analyze a market and find opportunities
                    </span>
                  </button>
                  <button
                    className="quick-start-card"
                    onClick={() =>
                      handleQuickAction(
                        "Help me validate a business idea. I'll describe the concept, and you'll assess the market size, competitors, unique angle, and give a go/no-go recommendation.",
                      )
                    }
                    title="Market size, competitors, and a go/no-go call"
                  >
                    <ThemeIcon
                      className="quick-start-icon"
                      emoji="💡"
                      icon={<ZapIcon size={22} />}
                    />
                    <span className="quick-start-title">Validate an idea</span>
                    <span className="quick-start-desc">
                      Market size, competitors, and a go/no-go call
                    </span>
                  </button>
                </div>
              )}
            </div>

            {/* Input Area */}
            {renderAttachmentPanel()}
            <div
              className={`welcome-input-container cli-input-container ${isDraggingFiles ? "drag-over" : ""}`}
              onDragOver={handleDragOver}
              onDragEnter={handleDragOver}
              onDragLeave={handleDragLeave}
              onDrop={handleDrop}
            >
              {showVoiceNotConfigured && (
                <div className="voice-not-configured-banner">
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
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
                      onOpenSettings?.("voice");
                    }}
                  >
                    Open Voice Settings
                  </button>
                  <button
                    className="voice-banner-close"
                    onClick={() => setShowVoiceNotConfigured(false)}
                    title="Dismiss"
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M18 6L6 18M6 6l12 12" />
                    </svg>
                  </button>
                </div>
              )}
              <div className="cli-input-wrapper">
                <span className="cli-input-prompt">~$</span>
                <span
                  ref={placeholderMeasureRef}
                  className="cli-placeholder-measure"
                  aria-hidden="true"
                />
                <div className="mention-autocomplete-wrapper" ref={mentionContainerRef}>
                  {!inputValue && (
                    <span
                      className={`cli-rotating-placeholder${placeholderFading ? " fading" : ""}`}
                      aria-hidden="true"
                    >
                      {placeholder}
                    </span>
                  )}
                  <textarea
                    ref={textareaRef}
                    className="welcome-input cli-input input-textarea"
                    value={inputValue}
                    onChange={handleInputChange}
                    onKeyDown={handleKeyDown}
                    onPaste={handlePaste}
                    onClick={handleInputClick}
                    onKeyUp={handleInputKeyUp}
                    rows={1}
                  />
                  {renderMentionDropdown()}
                  {renderSlashDropdown()}
                </div>
                {!inputValue && <span className="cli-cursor" style={{ left: cursorLeft }} />}
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
                  {uiDensity === "focused" ? (
                    <>
                      <div className="overflow-menu-container" ref={overflowMenuRef}>
                        <button
                          ref={overflowToggleBtnRef}
                          className={`overflow-menu-btn ${showOverflowMenu ? "active" : ""}`}
                          onClick={() => setShowOverflowMenu(!showOverflowMenu)}
                          onKeyDown={handleOverflowButtonKeyDown}
                          title="More options"
                          aria-label="More options"
                          aria-haspopup="menu"
                          aria-expanded={showOverflowMenu}
                        >
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <circle cx="12" cy="12" r="1" />
                            <circle cx="19" cy="12" r="1" />
                            <circle cx="5" cy="12" r="1" />
                          </svg>
                        </button>
                        {showOverflowMenu && (
                          <div
                            className="overflow-menu-dropdown"
                            role="menu"
                            aria-label="More options"
                            onKeyDown={handleOverflowMenuKeyDown}
                          >
                            <div className="overflow-menu-item" role="none">
                              <button
                                className="folder-selector"
                                onClick={() => {
                                  setOverflowSubmenu(null);
                                  setShowOverflowMenu(false);
                                  handleWorkspaceDropdownToggle();
                                }}
                                role="menuitem"
                                data-overflow-menu-item
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                                </svg>
                                <span>
                                  {workspace?.isTemp || isTempWorkspaceId(workspace?.id)
                                    ? "Work in a folder"
                                    : workspace?.name || "Work in a folder"}
                                </span>
                              </button>
                            </div>
                            <div className="overflow-menu-item" role="none">
                              <button
                                className={`shell-toggle ${shellEnabled ? "enabled" : ""}`}
                                onClick={() => {
                                  setOverflowSubmenu(null);
                                  handleShellToggle();
                                  setShowOverflowMenu(false);
                                }}
                                role="menuitemcheckbox"
                                aria-checked={shellEnabled}
                                aria-label={`Shell commands ${shellEnabled ? "on" : "off"}`}
                                data-overflow-menu-item
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <path d="M4 17l6-6-6-6M12 19h8" />
                                </svg>
                                <span>Shell</span>
                                <span
                                  className={`goal-mode-switch-track ${shellEnabled ? "on" : ""}`}
                                  aria-hidden="true"
                                >
                                  <span className="goal-mode-switch-thumb" />
                                </span>
                              </button>
                            </div>
                            <div className="overflow-menu-item" role="none">
                              <button
                                className="skills-menu-btn"
                                onClick={() => {
                                  setOverflowSubmenu(null);
                                  setShowOverflowMenu(false);
                                  setShowSkillsMenu(!showSkillsMenu);
                                }}
                                role="menuitem"
                                data-overflow-menu-item
                              >
                                <span>/</span>
                                <span>Custom Skills</span>
                              </button>
                            </div>
                            <div className="overflow-menu-item" role="none">
                              <button
                                className="goal-mode-toggle goal-mode-toggle-switch-row menu-tooltip-target"
                                style={{ margin: 0 }}
                                onClick={() => {
                                  setOverflowSubmenu(null);
                                  setAutonomousModeSelection(!autonomousModeEnabled);
                                }}
                                data-tooltip="Runs without asking for approval"
                                role="menuitemcheckbox"
                                aria-checked={autonomousModeEnabled}
                                data-overflow-menu-item
                              >
                                <span className="goal-mode-toggle-switch-content">
                                  <span className="goal-mode-toggle-text">
                                    <span className="goal-mode-label">Autonomous</span>
                                  </span>
                                  <span
                                    className={`goal-mode-switch-track ${
                                      autonomousModeEnabled ? "on" : ""
                                    }`}
                                    aria-hidden="true"
                                  >
                                    <span className="goal-mode-switch-thumb" />
                                  </span>
                                </span>
                              </button>
                            </div>
                            <div className="overflow-menu-item" role="none">
                              <button
                                className="goal-mode-toggle goal-mode-toggle-switch-row menu-tooltip-target"
                                style={{ margin: 0 }}
                                onClick={() => {
                                  setOverflowSubmenu(null);
                                  setCollaborativeModeSelection(!collaborativeModeEnabled);
                                }}
                                data-tooltip="Multiple agents share perspectives"
                                role="menuitemcheckbox"
                                aria-checked={collaborativeModeEnabled}
                                data-overflow-menu-item
                              >
                                <span className="goal-mode-toggle-switch-content">
                                  <span className="goal-mode-toggle-text">
                                    <span className="goal-mode-label">Collab</span>
                                  </span>
                                  <span
                                    className={`goal-mode-switch-track ${
                                      collaborativeModeEnabled ? "on" : ""
                                    }`}
                                    aria-hidden="true"
                                  >
                                    <span className="goal-mode-switch-thumb" />
                                  </span>
                                </span>
                              </button>
                            </div>
                            {availableProviders.filter((p) => p.configured).length >= 2 && (
                              <div className="overflow-menu-item" role="none">
                                <button
                                  className="goal-mode-toggle goal-mode-toggle-switch-row menu-tooltip-target"
                                  style={{ margin: 0 }}
                                  onClick={() => {
                                    setOverflowSubmenu(null);
                                    setMultiLlmModeSelection(!multiLlmModeEnabled);
                                  }}
                                  data-tooltip="Sends task to multiple AI models"
                                  role="menuitemcheckbox"
                                  aria-checked={multiLlmModeEnabled}
                                  data-overflow-menu-item
                                >
                                  <span className="goal-mode-toggle-switch-content">
                                    <span className="goal-mode-toggle-text">
                                      <span className="goal-mode-label">Multi-LLM</span>
                                    </span>
                                    <span
                                      className={`goal-mode-switch-track ${
                                        multiLlmModeEnabled ? "on" : ""
                                      }`}
                                      aria-hidden="true"
                                    >
                                      <span className="goal-mode-switch-thumb" />
                                    </span>
                                  </span>
                                </button>
                              </div>
                            )}
                            {renderExecutionModeRow()}
                            {renderTaskDomainRow()}
                          </div>
                        )}
                        {showOverflowMenu && renderOverflowSubmenu()}
                      </div>
                      <div className="workspace-dropdown-container" ref={workspaceDropdownRef}>
                        {showWorkspaceDropdown && (
                          <div className="workspace-dropdown">
                            {workspacesList.length > 0 && (
                              <>
                                <div className="workspace-dropdown-header">Recent Folders</div>
                                <div className="workspace-dropdown-list">
                                  {workspacesList.slice(0, 10).map((w) => (
                                    <button
                                      key={w.id}
                                      className={`workspace-dropdown-item ${workspace?.id === w.id ? "active" : ""}`}
                                      onClick={() => handleWorkspaceSelect(w)}
                                    >
                                      <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                      >
                                        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                                      </svg>
                                      <div className="workspace-item-info">
                                        <span className="workspace-item-name">{w.name}</span>
                                        <span className="workspace-item-path">{w.path}</span>
                                      </div>
                                      {workspace?.id === w.id && (
                                        <svg
                                          width="14"
                                          height="14"
                                          viewBox="0 0 24 24"
                                          fill="none"
                                          stroke="currentColor"
                                          strokeWidth="2"
                                          className="check-icon"
                                        >
                                          <path d="M20 6L9 17l-5-5" />
                                        </svg>
                                      )}
                                    </button>
                                  ))}
                                </div>
                                <div className="workspace-dropdown-divider" />
                              </>
                            )}
                            <button
                              className="workspace-dropdown-item new-folder"
                              onClick={handleSelectNewFolder}
                            >
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <path d="M12 5v14M5 12h14" />
                              </svg>
                              <span>Work in another folder...</span>
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="skills-menu-container" ref={skillsMenuRef}>
                        {showSkillsMenu && (
                          <div className="skills-dropdown">
                            <div className="skills-dropdown-header">Custom Skills</div>
                            <div className="skills-dropdown-search">
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
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
                                  {filteredSkills.map((skill) => (
                                    <div
                                      key={skill.id}
                                      className="skills-dropdown-item"
                                      style={{ cursor: "pointer" }}
                                      onClick={() => handleSkillSelect(skill)}
                                    >
                                      <span className="skills-dropdown-icon">{skill.icon}</span>
                                      <div className="skills-dropdown-info">
                                        <span className="skills-dropdown-name">{skill.name}</span>
                                        <span className="skills-dropdown-desc">
                                          {skill.description}
                                        </span>
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
                              <div className="skills-dropdown-empty">No custom skills yet.</div>
                            )}
                            <div className="skills-dropdown-footer">
                              <button
                                className="skills-dropdown-create"
                                onClick={() => {
                                  setShowSkillsMenu(false);
                                  setSkillsSearchQuery("");
                                  onOpenSettings?.("skills");
                                }}
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <line x1="12" y1="5" x2="12" y2="19" />
                                  <line x1="5" y1="12" x2="19" y2="12" />
                                </svg>
                                Create New Skill
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    </>
                  ) : (
                    <>
                      <div className="workspace-dropdown-container" ref={workspaceDropdownRef}>
                        <button className="folder-selector" onClick={handleWorkspaceDropdownToggle}>
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                          </svg>
                          <span>
                            {workspace?.isTemp || isTempWorkspaceId(workspace?.id)
                              ? "Work in a folder"
                              : workspace?.name || "Work in a folder"}
                          </span>
                          <svg
                            width="12"
                            height="12"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            className={showWorkspaceDropdown ? "chevron-up" : ""}
                          >
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
                                      className={`workspace-dropdown-item ${workspace?.id === w.id ? "active" : ""}`}
                                      onClick={() => handleWorkspaceSelect(w)}
                                    >
                                      <svg
                                        width="14"
                                        height="14"
                                        viewBox="0 0 24 24"
                                        fill="none"
                                        stroke="currentColor"
                                        strokeWidth="2"
                                      >
                                        <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                                      </svg>
                                      <div className="workspace-item-info">
                                        <span className="workspace-item-name">{w.name}</span>
                                        <span className="workspace-item-path">{w.path}</span>
                                      </div>
                                      {workspace?.id === w.id && (
                                        <svg
                                          width="14"
                                          height="14"
                                          viewBox="0 0 24 24"
                                          fill="none"
                                          stroke="currentColor"
                                          strokeWidth="2"
                                          className="check-icon"
                                        >
                                          <path d="M20 6L9 17l-5-5" />
                                        </svg>
                                      )}
                                    </button>
                                  ))}
                                </div>
                                <div className="workspace-dropdown-divider" />
                              </>
                            )}
                            <button
                              className="workspace-dropdown-item new-folder"
                              onClick={handleSelectNewFolder}
                            >
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
                                <path d="M12 5v14M5 12h14" />
                              </svg>
                              <span>Work in another folder...</span>
                            </button>
                          </div>
                        )}
                      </div>
                      <div className="overflow-menu-container" ref={overflowMenuRef}>
                        <button
                          ref={overflowToggleBtnRef}
                          className={`overflow-menu-btn ${showOverflowMenu ? "active" : ""}`}
                          onClick={() => setShowOverflowMenu(!showOverflowMenu)}
                          onKeyDown={handleOverflowButtonKeyDown}
                          title="More options"
                          aria-label="More options"
                          aria-haspopup="menu"
                          aria-expanded={showOverflowMenu}
                        >
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <circle cx="12" cy="12" r="1" />
                            <circle cx="19" cy="12" r="1" />
                            <circle cx="5" cy="12" r="1" />
                          </svg>
                        </button>
                        {showOverflowMenu && (
                          <div
                            className="overflow-menu-dropdown"
                            role="menu"
                            aria-label="More options"
                            onKeyDown={handleOverflowMenuKeyDown}
                          >
                            <div className="overflow-menu-item" role="none">
                              <button
                                className={`shell-toggle ${shellEnabled ? "enabled" : ""}`}
                                onClick={() => {
                                  setOverflowSubmenu(null);
                                  handleShellToggle();
                                  setShowOverflowMenu(false);
                                }}
                                role="menuitemcheckbox"
                                aria-checked={shellEnabled}
                                aria-label={`Shell commands ${shellEnabled ? "on" : "off"}`}
                                data-overflow-menu-item
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <path d="M4 17l6-6-6-6M12 19h8" />
                                </svg>
                                <span>Shell</span>
                                <span
                                  className={`goal-mode-switch-track ${shellEnabled ? "on" : ""}`}
                                  aria-hidden="true"
                                >
                                  <span className="goal-mode-switch-thumb" />
                                </span>
                              </button>
                            </div>
                            <div className="overflow-menu-item" role="none">
                              <button
                                className="goal-mode-toggle goal-mode-toggle-switch-row menu-tooltip-target"
                                style={{ margin: 0 }}
                                onClick={() => {
                                  setOverflowSubmenu(null);
                                  setAutonomousModeSelection(!autonomousModeEnabled);
                                }}
                                data-tooltip="Runs without asking for approval"
                                role="menuitemcheckbox"
                                aria-checked={autonomousModeEnabled}
                                data-overflow-menu-item
                              >
                                <span className="goal-mode-toggle-switch-content">
                                  <span className="goal-mode-toggle-text">
                                    <span className="goal-mode-label">Autonomous</span>
                                  </span>
                                  <span
                                    className={`goal-mode-switch-track ${
                                      autonomousModeEnabled ? "on" : ""
                                    }`}
                                    aria-hidden="true"
                                  >
                                    <span className="goal-mode-switch-thumb" />
                                  </span>
                                </span>
                              </button>
                            </div>
                            <div className="overflow-menu-item" role="none">
                              <button
                                className="goal-mode-toggle goal-mode-toggle-switch-row menu-tooltip-target"
                                style={{ margin: 0 }}
                                onClick={() => {
                                  setOverflowSubmenu(null);
                                  setCollaborativeModeSelection(!collaborativeModeEnabled);
                                }}
                                data-tooltip="Multiple agents share perspectives"
                                role="menuitemcheckbox"
                                aria-checked={collaborativeModeEnabled}
                                data-overflow-menu-item
                              >
                                <span className="goal-mode-toggle-switch-content">
                                  <span className="goal-mode-toggle-text">
                                    <span className="goal-mode-label">Collab</span>
                                  </span>
                                  <span
                                    className={`goal-mode-switch-track ${
                                      collaborativeModeEnabled ? "on" : ""
                                    }`}
                                    aria-hidden="true"
                                  >
                                    <span className="goal-mode-switch-thumb" />
                                  </span>
                                </span>
                              </button>
                            </div>
                            {availableProviders.filter((p) => p.configured).length >= 2 && (
                              <div className="overflow-menu-item" role="none">
                                <button
                                  className="goal-mode-toggle goal-mode-toggle-switch-row menu-tooltip-target"
                                  style={{ margin: 0 }}
                                  onClick={() => {
                                    setOverflowSubmenu(null);
                                    setMultiLlmModeSelection(!multiLlmModeEnabled);
                                  }}
                                  data-tooltip="Sends task to multiple AI models"
                                  role="menuitemcheckbox"
                                  aria-checked={multiLlmModeEnabled}
                                  data-overflow-menu-item
                                >
                                  <span className="goal-mode-toggle-switch-content">
                                    <span className="goal-mode-toggle-text">
                                      <span className="goal-mode-label">Multi-LLM</span>
                                    </span>
                                    <span
                                      className={`goal-mode-switch-track ${
                                        multiLlmModeEnabled ? "on" : ""
                                      }`}
                                      aria-hidden="true"
                                    >
                                      <span className="goal-mode-switch-thumb" />
                                    </span>
                                  </span>
                                </button>
                              </div>
                            )}
                            {renderExecutionModeRow()}
                            {renderTaskDomainRow()}
                            <div className="overflow-menu-item" role="none">
                              <button
                                className="goal-mode-toggle menu-tooltip-target"
                                style={{ margin: 0 }}
                                onClick={() => {
                                  setOverflowSubmenu(null);
                                  setVerificationAgentEnabled(!verificationAgentEnabled);
                                }}
                                data-tooltip="Double-checks results before finishing"
                                role="menuitemcheckbox"
                                aria-checked={verificationAgentEnabled}
                                data-overflow-menu-item
                              >
                                <span className="goal-mode-label">
                                  Verify {verificationAgentEnabled ? "ON" : "OFF"}
                                </span>
                              </button>
                            </div>
                          </div>
                        )}
                        {showOverflowMenu && renderOverflowSubmenu()}
                      </div>
                      <ModelDropdown
                        models={availableModels}
                        selectedModel={selectedModel}
                        onModelChange={onModelChange}
                        onOpenSettings={onOpenSettings}
                      />
                    </>
                  )}
                </div>
                <div className="input-right-actions">
                  {uiDensity === "focused" ? (
                    <>
                      <div className="model-label-container" ref={modelLabelRef}>
                        <button
                          className="model-label-subtle"
                          onClick={() => setShowModelDropdownFromLabel(!showModelDropdownFromLabel)}
                          title="Change model"
                        >
                          {availableModels.find((m) => m.key === selectedModel)?.displayName ||
                            selectedModel}
                        </button>
                        {showModelDropdownFromLabel && (
                          <div className="model-label-dropdown">
                            {availableModels.map((m) => (
                              <button
                                key={m.key}
                                className={`model-label-dropdown-item ${m.key === selectedModel ? "active" : ""}`}
                                onClick={() => {
                                  onModelChange(m.key);
                                  setShowModelDropdownFromLabel(false);
                                }}
                              >
                                {m.displayName}
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                      <button
                        className={`voice-input-btn ${voiceInput.state}`}
                        onClick={voiceInput.toggleRecording}
                        disabled={voiceInput.state === "processing"}
                        title={
                          voiceInput.state === "idle"
                            ? "Start voice input"
                            : voiceInput.state === "recording"
                              ? "Stop recording"
                              : "Processing..."
                        }
                      >
                        {voiceInput.state === "processing" ? (
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            className="voice-processing-spin"
                          >
                            <circle cx="12" cy="12" r="10" />
                            <path d="M12 6v6l4 2" />
                          </svg>
                        ) : voiceInput.state === "recording" ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <rect x="6" y="6" width="12" height="12" rx="2" />
                          </svg>
                        ) : (
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            <line x1="12" y1="19" x2="12" y2="23" />
                            <line x1="8" y1="23" x2="16" y2="23" />
                          </svg>
                        )}
                        {voiceInput.state === "recording" && (
                          <span
                            className="voice-recording-indicator"
                            style={{ width: `${voiceInput.audioLevel}%` }}
                          />
                        )}
                      </button>
                      <button
                        className="lets-go-btn lets-go-btn-sm"
                        onClick={handleSend}
                        disabled={
                          (!inputValue.trim() && pendingAttachments.length === 0) ||
                          isUploadingAttachments ||
                          isPreparingMessage
                        }
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M12 19V5M5 12l7-7 7 7" />
                        </svg>
                      </button>
                    </>
                  ) : (
                    <>
                      {/* Skills Menu Button */}
                      <div className="skills-menu-container" ref={skillsMenuRef}>
                        <button
                          className={`skills-menu-btn ${showSkillsMenu ? "active" : ""}`}
                          onClick={() => setShowSkillsMenu(!showSkillsMenu)}
                          title="Custom Skills"
                        >
                          <span>/</span>
                        </button>
                        {showSkillsMenu && (
                          <div className="skills-dropdown">
                            <div className="skills-dropdown-header">Custom Skills</div>
                            <div className="skills-dropdown-search">
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                              >
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
                                  {filteredSkills.map((skill) => (
                                    <div
                                      key={skill.id}
                                      className="skills-dropdown-item"
                                      style={{ cursor: "pointer" }}
                                      onClick={() => handleSkillSelect(skill)}
                                    >
                                      <span className="skills-dropdown-icon">{skill.icon}</span>
                                      <div className="skills-dropdown-info">
                                        <span className="skills-dropdown-name">{skill.name}</span>
                                        <span className="skills-dropdown-desc">
                                          {skill.description}
                                        </span>
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
                              <div className="skills-dropdown-empty">No custom skills yet.</div>
                            )}
                            <div className="skills-dropdown-footer">
                              <button
                                className="skills-dropdown-create"
                                onClick={() => {
                                  setShowSkillsMenu(false);
                                  setSkillsSearchQuery("");
                                  onOpenSettings?.("skills");
                                }}
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
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
                        disabled={voiceInput.state === "processing"}
                        title={
                          voiceInput.state === "idle"
                            ? "Start voice input"
                            : voiceInput.state === "recording"
                              ? "Stop recording"
                              : "Processing..."
                        }
                      >
                        {voiceInput.state === "processing" ? (
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                            className="voice-processing-spin"
                          >
                            <circle cx="12" cy="12" r="10" />
                            <path d="M12 6v6l4 2" />
                          </svg>
                        ) : voiceInput.state === "recording" ? (
                          <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                            <rect x="6" y="6" width="12" height="12" rx="2" />
                          </svg>
                        ) : (
                          <svg
                            width="16"
                            height="16"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                            <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                            <line x1="12" y1="19" x2="12" y2="23" />
                            <line x1="8" y1="23" x2="16" y2="23" />
                          </svg>
                        )}
                        {voiceInput.state === "recording" && (
                          <span
                            className="voice-recording-indicator"
                            style={{ width: `${voiceInput.audioLevel}%` }}
                          />
                        )}
                      </button>
                      <button
                        className="lets-go-btn lets-go-btn-sm"
                        onClick={handleSend}
                        disabled={
                          (!inputValue.trim() && pendingAttachments.length === 0) ||
                          isUploadingAttachments ||
                          isPreparingMessage
                        }
                      >
                        <svg
                          width="16"
                          height="16"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M12 19V5M5 12l7-7 7 7" />
                        </svg>
                      </button>
                    </>
                  )}
                </div>
              </div>
              {multiLlmModeEnabled && (
                <MultiLlmSelectionPanel
                  availableProviders={availableProviders}
                  onConfigChange={setMultiLlmConfig}
                />
              )}
            </div>
          </div>
        </div>

        {/* Suggestion hint in focused mode */}
        {uiDensity === "focused" && !task && (
          <p className="welcome-hint">
            Try: &quot;Help me organize my project files&quot; or &quot;Write a summary report
            about...&quot;
          </p>
        )}

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

  const stepFeedTimelineIndexPosition = new Map<number, number>();
  let stepFeedEventCount = 0;
  timelineItems.forEach((timelineItem, timelineIndex) => {
    if (timelineItem.kind !== "event") return;
    const event = timelineItem.event;
    const eventId = event.id;
    if (suppressedParallelEventIds.has(eventId) && !parallelGroupsByAnchorEventId.has(eventId)) {
      return;
    }
    if (
      !parallelGroupsByAnchorEventId.has(eventId) &&
      !shouldRenderTimelineEventInStepFeed(event)
    ) {
      return;
    }
    stepFeedTimelineIndexPosition.set(timelineIndex, stepFeedEventCount);
    stepFeedEventCount += 1;
  });

  const displayPrompt = task.userPrompt || task.prompt;
  const trimmedPrompt = displayPrompt.trim();
  const baseTitle = task.title || buildTaskTitle(trimmedPrompt);
  const normalizedTitle = baseTitle.replace(TITLE_ELLIPSIS_REGEX, "");
  const titleMatchesPrompt =
    normalizedTitle.length > 0 && trimmedPrompt.startsWith(normalizedTitle);
  const isTitleTruncated = titleMatchesPrompt && trimmedPrompt.length > normalizedTitle.length;
  const headerTitle =
    isTitleTruncated && !TITLE_ELLIPSIS_REGEX.test(baseTitle) ? `${baseTitle}...` : baseTitle;
  const headerTooltip = trimmedPrompt || baseTitle;
  const latestPauseEvent = [...events]
    .reverse()
    .find((event) => getEffectiveTaskEventType(event) === "task_paused");
  const latestApprovalEvent = [...events]
    .reverse()
    .find(
      (event) =>
        getEffectiveTaskEventType(event) === "approval_requested" &&
        event.payload?.autoApproved !== true,
    );
  const hasActiveStructuredInputRequest = Boolean(
    task &&
      inputRequest &&
      inputRequest.taskId === task.id &&
      onSubmitInputRequest &&
      onDismissInputRequest,
  );

  // Task view
  return (
    <div className="main-content">
      {/* Header */}
      <div className="main-header">
        <div className="main-header-title" title={headerTooltip}>
          {headerTitle}
        </div>
      </div>
      {isTaskWorking && (
        <div className="main-header-status">
          <span className="chat-status executing">
            <svg
              className="spinner"
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
              <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
            </svg>
            {streamingProgress ? (
              <span className="streaming-stats">
                {agentContext.getMessage("taskWorking")}
                <span className="streaming-separator"> · </span>
                <span className="streaming-token-up" title="Input tokens">
                  ↑{formatTokenCount(streamingProgress.totalInputTokens)}
                </span>{" "}
                <span className="streaming-token-down" title="Output tokens">
                  ↓{formatTokenCount(streamingProgress.totalOutputTokens)}
                </span>
                <span className="streaming-separator"> · </span>
                <span className="streaming-elapsed">
                  {formatStreamElapsed(streamingProgress.elapsedMs)}
                </span>
              </span>
            ) : (
              agentContext.getMessage("taskWorking")
            )}
          </span>
          {continuationStatusChip && (
            <span className="header-continuation-chip" title="Adaptive continuation status">
              <span>{continuationStatusChip.window}</span>
              {continuationStatusChip.progress && (
                <span className="header-continuation-chip-sep">·</span>
              )}
              {continuationStatusChip.progress && <span>{continuationStatusChip.progress}</span>}
              {continuationStatusChip.loopRisk && (
                <span className="header-continuation-chip-sep">·</span>
              )}
              {continuationStatusChip.loopRisk && <span>{continuationStatusChip.loopRisk}</span>}
            </span>
          )}
        </div>
      )}

      {/* Body */}
      <div className="main-body" ref={mainBodyRef} onScroll={handleScroll}>
        <div className="task-content">
          {/* User Prompt - Right aligned like chat */}
          <div className="chat-message user-message">
            <CollapsibleUserBubble>
              <ReactMarkdown remarkPlugins={userMarkdownPlugins} components={markdownComponents}>
                {stripPptxBubbleContent(displayPrompt)}
              </ReactMarkdown>
              {extractAttachmentNames(displayPrompt).length > 0 && (
                <div className="bubble-attachments">
                  {extractAttachmentNames(displayPrompt).map((name, i) => (
                    <span className="bubble-attachment-chip" key={i}>
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2"
                      >
                        <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                        <path d="M14 2v6h6" />
                      </svg>
                      <span className="bubble-attachment-name" title={name}>
                        {name}
                      </span>
                    </span>
                  ))}
                </div>
              )}
            </CollapsibleUserBubble>
            <MessageCopyButton text={displayPrompt} />
          </div>

          {/* View steps toggle - show right after original prompt */}
          {events.some((event) => {
            const effectiveType = getEffectiveTaskEventType(event);
            return effectiveType !== "user_message" && effectiveType !== "assistant_message";
          }) && (
            <div className="timeline-controls">
              <button
                className={`view-steps-btn ${showSteps ? "expanded" : ""}`}
                onClick={() => setShowSteps(!showSteps)}
              >
                {showSteps ? "Hide steps" : "View steps"}
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
              {showSteps && (
                <>
                  <button
                    type="button"
                    className="verbose-switch"
                    role="switch"
                    aria-checked={verboseSteps}
                    aria-label={`Verbose mode ${verboseSteps ? "on" : "off"}`}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      toggleVerboseSteps();
                    }}
                    title={`Verbose mode ${verboseSteps ? "on" : "off"} (click to toggle)`}
                  >
                    <span className="goal-mode-toggle-switch-content">
                      <span className="goal-mode-toggle-text">
                        <span className="verbose-switch-label">Verbose</span>
                      </span>
                      <span
                        className={`goal-mode-switch-track ${verboseSteps ? "on" : ""}`}
                        aria-hidden="true"
                      >
                        <span className="goal-mode-switch-thumb" />
                      </span>
                    </span>
                  </button>
                  <button
                    className={`verbose-toggle-btn ${codePreviewsExpanded ? "active" : ""}`}
                    onClick={toggleCodePreviews}
                    title={
                      codePreviewsExpanded
                        ? "Collapse code previews by default"
                        : "Expand code previews by default"
                    }
                  >
                    {codePreviewsExpanded ? "Code: Open" : "Code: Collapsed"}
                  </button>
                </>
              )}
            </div>
          )}

          {/* Collaborative / Multi-LLM Thoughts - shown in main area when task has a collaborative run */}
          {collaborativeRun && (
            <div className="collaborative-thoughts-main">
              <CollaborativeThoughtsPanel
                teamRunId={collaborativeRun.id}
                teamId={collaborativeRun.teamId}
                runPhase={collaborativeRun.phase}
                mode={collaborativeRun.multiLlmMode ? "multi-llm" : "collaborative"}
                isRunning={collaborativeRun.status === "running"}
                onWrapUp={
                  onWrapUpTask
                    ? () => {
                        if (!wrappingUp) {
                          setWrappingUp(true);
                          onWrapUpTask();
                        }
                      }
                    : undefined
                }
                isWrappingUp={wrappingUp}
              />
            </div>
          )}

          {/* Conversation Flow - renders all events in order */}
          {events.length > 0 && (
            <div className="conversation-flow" ref={timelineRef}>
              {/* Render command outputs that started before any visible event */}
              {renderCommandOutputs(commandOutputSessionsByInsertIndex.get(-1))}
              {timelineItems.map((item, timelineIndex) => {
                if (item.kind === "canvas") {
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

                if (item.kind === "dispatched-agents") {
                  return (
                    <div key="dispatched-agents" className="collaborative-thoughts-main">
                      <DispatchedAgentsPanel
                        parentTaskId={task!.id}
                        childTasks={childTasks}
                        childEvents={childEvents}
                        onSelectChildTask={onSelectChildTask}
                      />
                    </div>
                  );
                }

                const event = item.event;
                const effectiveType = getEffectiveTaskEventType(event);
                const isUserMessage = effectiveType === "user_message";
                const isAssistantMessage = effectiveType === "assistant_message";
                const commandOutputsAfterEvent = commandOutputSessionsByInsertIndex.get(
                  item.eventIndex,
                );

                // Render user messages as chat bubbles on the right
                if (isUserMessage) {
                  const rawMessage = event.payload?.message || "User message";
                  const messageText = stripPptxBubbleContent(rawMessage);
                  const attachmentNames = extractAttachmentNames(rawMessage);
                  return (
                    <Fragment key={event.id || `event-${item.eventIndex}`}>
                      <div className="chat-message user-message">
                        <CollapsibleUserBubble>
                          <ReactMarkdown
                            remarkPlugins={userMarkdownPlugins}
                            components={markdownComponents}
                          >
                            {messageText}
                          </ReactMarkdown>
                          {attachmentNames.length > 0 && (
                            <div className="bubble-attachments">
                              {attachmentNames.map((name, i) => (
                                <span className="bubble-attachment-chip" key={i}>
                                  <svg
                                    width="12"
                                    height="12"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                  >
                                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
                                    <path d="M14 2v6h6" />
                                  </svg>
                                  <span className="bubble-attachment-name" title={name}>
                                    {name}
                                  </span>
                                </span>
                              ))}
                            </div>
                          )}
                        </CollapsibleUserBubble>
                        <MessageCopyButton text={messageText} />
                      </div>
                      {renderCommandOutputs(commandOutputsAfterEvent)}
                    </Fragment>
                  );
                }

                // Render assistant messages as chat bubbles on the left
                if (isAssistantMessage) {
                  const messageText = event.payload?.message || "";
                  const cleanedMessageText = cleanAssistantMessageForDisplay(messageText);
                  const isLastAssistant = event === lastAssistantMessage;
                  return (
                    <Fragment key={event.id || `event-${item.eventIndex}`}>
                      <div className="chat-message assistant-message">
                        <div className="chat-bubble assistant-bubble">
                          {isLastAssistant && (
                            <div className="chat-bubble-header">
                              {task.status === "completed" && (
                                <span className="chat-status">
                                  {task.terminalStatus === "needs_user_action"
                                    ? "Completed - action required"
                                    : task.terminalStatus === "partial_success"
                                      ? "Completed - partial success"
                                      : agentContext.getMessage("taskComplete")}
                                </span>
                              )}
                              {task.status === "paused" && (
                                <span className="chat-status">Waiting for your direction</span>
                              )}
                              {task.status === "blocked" && (
                                <span className="chat-status">
                                  {task.terminalStatus === "awaiting_approval"
                                    ? agentContext.getMessage("taskBlocked") || "Needs approval"
                                    : "Waiting for your input"}
                                </span>
                              )}
                              {task.status === "interrupted" && task.terminalStatus === "resume_available" && (
                                <span className="chat-status">Interrupted - resume available</span>
                              )}
                              {isTaskWorking && (
                                <span className="chat-status executing">
                                  <svg
                                    className="spinner"
                                    width="14"
                                    height="14"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                  >
                                    <circle cx="12" cy="12" r="10" strokeOpacity="0.25" />
                                    <path d="M12 2a10 10 0 0 1 10 10" strokeLinecap="round" />
                                  </svg>
                                  {agentContext.getMessage("taskWorking")}
                                </span>
                              )}
                            </div>
                          )}
                          <div className="chat-bubble-content markdown-content">
                            <ReactMarkdown
                              remarkPlugins={[remarkGfm]}
                              components={markdownComponents}
                            >
                              {cleanedMessageText}
                            </ReactMarkdown>
                          </div>
                        </div>
                        <div className="message-actions">
                          <MessageCopyButton text={messageText} />
                          <MessageSpeakButton text={messageText} voiceEnabled={voiceEnabled} />
                          {isLastAssistant && isTaskWorking && (
                            <button
                              className="bubble-feedback-toggle"
                              onClick={() => setStepFeedbackOpen((o) => !o)}
                              title="Give feedback"
                            >
                              <svg
                                width="14"
                                height="14"
                                viewBox="0 0 24 24"
                                fill="none"
                                stroke="currentColor"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              >
                                <circle cx="12" cy="12" r="1" />
                                <circle cx="19" cy="12" r="1" />
                                <circle cx="5" cy="12" r="1" />
                              </svg>
                            </button>
                          )}
                        </div>
                        {isLastAssistant && stepFeedbackOpen && (
                          <div className="bubble-feedback-panel">
                            {currentStep && (
                              <div className="bubble-feedback-step-label">
                                {currentStep.description}
                              </div>
                            )}
                            <div className="bubble-feedback-actions">
                              {currentStep && (
                                <>
                                  <button
                                    className="bubble-feedback-btn skip"
                                    disabled={stepFeedbackSending}
                                    onClick={() => handleStepFeedback("skip")}
                                  >
                                    Skip
                                  </button>
                                  <button
                                    className="bubble-feedback-btn retry"
                                    disabled={stepFeedbackSending}
                                    onClick={() => handleStepFeedback("retry")}
                                  >
                                    Retry
                                  </button>
                                </>
                              )}
                              <button
                                className="bubble-feedback-btn stop"
                                disabled={stepFeedbackSending || !currentStep}
                                onClick={() => handleStepFeedback("stop")}
                              >
                                Stop
                              </button>
                            </div>
                            <div className="bubble-feedback-input-row">
                              <input
                                className="bubble-feedback-input"
                                type="text"
                                placeholder="Adjust direction…"
                                value={stepFeedbackText}
                                onChange={(e) => setStepFeedbackText(e.target.value)}
                                onKeyDown={(e) => {
                                  if (e.key === "Enter" && stepFeedbackText.trim()) {
                                    handleStepFeedback("drift", stepFeedbackText.trim());
                                  }
                                }}
                                disabled={stepFeedbackSending}
                              />
                              <button
                                className="bubble-feedback-btn drift"
                                disabled={stepFeedbackSending || !stepFeedbackText.trim()}
                                onClick={() => handleStepFeedback("drift", stepFeedbackText.trim())}
                              >
                                Send
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                      {renderCommandOutputs(commandOutputsAfterEvent)}
                    </Fragment>
                  );
                }

                const parallelGroup = parallelGroupsByAnchorEventId.get(event.id);
                if (suppressedParallelEventIds.has(event.id) && !parallelGroup) {
                  if (commandOutputsAfterEvent && commandOutputsAfterEvent.length > 0) {
                    return (
                      <Fragment key={event.id || `event-${item.eventIndex}`}>
                        {renderCommandOutputs(commandOutputsAfterEvent)}
                      </Fragment>
                    );
                  }
                  return null;
                }

                if (!parallelGroup && !shouldRenderTimelineEventInStepFeed(event)) {
                  // Even if we're not showing steps, we may still need to render command output.
                  if (commandOutputsAfterEvent && commandOutputsAfterEvent.length > 0) {
                    return (
                      <Fragment key={event.id || `event-${item.eventIndex}`}>
                        {renderCommandOutputs(commandOutputsAfterEvent)}
                      </Fragment>
                    );
                  }
                  return null;
                }

                const indicatorPosition = stepFeedTimelineIndexPosition.get(timelineIndex);
                const showConnectorAbove =
                  typeof indicatorPosition === "number" && indicatorPosition > 0;
                const showConnectorBelow =
                  typeof indicatorPosition === "number" &&
                  indicatorPosition < stepFeedEventCount - 1;

                if (parallelGroup) {
                  return (
                    <Fragment key={event.id || `event-${item.eventIndex}`}>
                      <ParallelGroupFeed
                        group={parallelGroup}
                        timeLabel={formatTime(parallelGroup.startedAt)}
                        formatTime={formatTime}
                        showConnectorAbove={showConnectorAbove}
                        showConnectorBelow={showConnectorBelow}
                      />
                      {renderCommandOutputs(commandOutputsAfterEvent)}
                    </Fragment>
                  );
                }

                const isExpandable = hasEventDetails(event);
                const isExpanded = isEventExpanded(event);
                const eventTitle = renderEventTitle(
                  event,
                  workspace?.path,
                  setViewerFilePath,
                  agentContext,
                  { summaryMode: !verboseSteps },
                );

                return (
                  <Fragment key={event.id || `event-${item.eventIndex}`}>
                    <StepFeed
                      title={
                        typeof eventTitle === "string" ? (
                          <ReactMarkdown
                            remarkPlugins={[remarkGfm]}
                            components={eventTitleMarkdownComponents}
                          >
                            {normalizeTimelineTitleMarkdownForDisplay(eventTitle)}
                          </ReactMarkdown>
                        ) : (
                          eventTitle
                        )
                      }
                      timeLabel={formatTime(event.timestamp)}
                      indicator={resolveTimelineIndicator(event)}
                      showConnectorAbove={showConnectorAbove}
                      showConnectorBelow={showConnectorBelow}
                      showBranchStub={shouldShowTimelineBranchStub(event)}
                      expandable={isExpandable}
                      expanded={isExpanded}
                      onToggle={isExpandable ? () => toggleEventExpanded(event.id) : undefined}
                      details={
                        isExpanded
                          ? renderEventDetails(event, voiceEnabled, markdownComponents, {
                              workspacePath: workspace?.path,
                              onOpenViewer: setViewerFilePath,
                              events,
                              onViewOutputs: onViewTaskOutputs,
                              hideVerificationSteps: true,
                              summaryMode: !verboseSteps,
                            })
                          : undefined
                      }
                    />
                    {renderCommandOutputs(commandOutputsAfterEvent)}
                  </Fragment>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {/* Footer with Input */}
      <div className="main-footer">
        {/* Scroll to bottom button */}
        {!autoScroll && task && (
          <button
            className="scroll-to-bottom-btn"
            onClick={() => {
              if (mainBodyRef.current) {
                mainBodyRef.current.scrollTo({
                  top: mainBodyRef.current.scrollHeight,
                  behavior: "smooth",
                });
                setAutoScroll(true);
              }
            }}
            title="Scroll to bottom"
          >
            ↓
          </button>
        )}
        {renderAttachmentPanel()}
        <div
          className={`input-container ${isDraggingFiles ? "drag-over" : ""}`}
          onDragOver={handleDragOver}
          onDragEnter={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
        >
          {hasActiveStructuredInputRequest && inputRequest && onSubmitInputRequest && onDismissInputRequest && (
            <StructuredInputPromptCard
              request={inputRequest}
              onSubmit={(answers) => onSubmitInputRequest(inputRequest.id, answers)}
              onDismiss={() => onDismissInputRequest(inputRequest.id)}
            />
          )}
          {showVoiceNotConfigured && (
            <div className="voice-not-configured-banner">
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
              >
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
                  onOpenSettings?.("voice");
                }}
              >
                Open Voice Settings
              </button>
              <button
                className="voice-banner-close"
                onClick={() => setShowVoiceNotConfigured(false)}
                title="Dismiss"
              >
                <svg
                  width="14"
                  height="14"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                >
                  <path d="M18 6L6 18M6 6l12 12" />
                </svg>
              </button>
            </div>
          )}
          {task.status === "paused" && !hasActiveStructuredInputRequest && (
            <div className="task-status-banner task-status-banner-paused">
              <div className="task-status-banner-content">
                <strong>Quick check-in - I'm at a decision point.</strong>
                {latestPauseEvent?.payload?.message && (
                  <span className="task-status-banner-detail">
                    {latestPauseEvent.payload.message}
                  </span>
                )}
                <span className="task-status-banner-detail">
                  Type anything below to continue, or stop this task here.
                </span>
              </div>
              {onStopTask && (
                <div className="task-status-banner-actions">
                  <button
                    className="task-status-banner-stop-btn"
                    onClick={onStopTask}
                    title="Stop task"
                  >
                    Stop task
                  </button>
                </div>
              )}
            </div>
          )}
          {task.status === "blocked" && (
            <div className="task-status-banner task-status-banner-blocked">
              <div className="task-status-banner-content">
                <strong>
                  {task.terminalStatus === "awaiting_approval"
                    ? "Blocked - needs approval"
                    : "Blocked - waiting on you"}
                </strong>
                {latestApprovalEvent?.payload?.approval?.description && task.terminalStatus === "awaiting_approval" && (
                  <span className="task-status-banner-detail">
                    {latestApprovalEvent.payload.approval.description}
                  </span>
                )}
              </div>
            </div>
          )}
          {task.status === "interrupted" && task.terminalStatus === "resume_available" && (
            <div className="task-status-banner task-status-banner-paused">
              <div className="task-status-banner-content">
                <strong>Resume available</strong>
                <span className="task-status-banner-detail">
                  The task stopped before finishing, but its progress and outputs were preserved.
                </span>
              </div>
            </div>
          )}
          {task.status === "completed" && task.terminalStatus === "needs_user_action" && (
            <div className="task-status-banner task-status-banner-blocked">
              <div className="task-status-banner-content">
                <strong>Completed - action required</strong>
                <span className="task-status-banner-detail">
                  Verification is pending user evidence before this can be fully marked done.
                </span>
              </div>
            </div>
          )}
          {task.status === "completed" && task.terminalStatus === "partial_success" && (
            <div className="task-status-banner task-status-banner-paused">
              <div className="task-status-banner-content">
                <strong>Completed with preserved outputs</strong>
                <span className="task-status-banner-detail">
                  Cowork kept the files and summary it produced, even though some checks or steps did not fully finish.
                </span>
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
            {uiDensity === "focused" && (
              <>
                <div className="overflow-menu-container" ref={overflowMenuRef}>
                  <button
                    ref={overflowToggleBtnRef}
                    className={`overflow-menu-btn ${showOverflowMenu ? "active" : ""}`}
                    onClick={() => setShowOverflowMenu(!showOverflowMenu)}
                    onKeyDown={handleOverflowButtonKeyDown}
                    title="More options"
                    aria-label="More options"
                    aria-haspopup="menu"
                    aria-expanded={showOverflowMenu}
                  >
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <circle cx="12" cy="12" r="1" />
                      <circle cx="19" cy="12" r="1" />
                      <circle cx="5" cy="12" r="1" />
                    </svg>
                  </button>
                  {showOverflowMenu && (
                    <div
                      className="overflow-menu-dropdown"
                      role="menu"
                      aria-label="More options"
                      onKeyDown={handleOverflowMenuKeyDown}
                    >
                      <div className="overflow-menu-item" role="none">
                        <button
                          className="folder-selector"
                          onClick={() => {
                            setOverflowSubmenu(null);
                            setShowOverflowMenu(false);
                            handleWorkspaceDropdownToggle();
                          }}
                          role="menuitem"
                          data-overflow-menu-item
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                          </svg>
                          <span>
                            {workspace?.isTemp || isTempWorkspaceId(workspace?.id)
                              ? "Work in a folder"
                              : workspace?.name || "Work in a folder"}
                          </span>
                        </button>
                      </div>
                      <div className="overflow-menu-item" role="none">
                        <button
                          className={`shell-toggle ${shellEnabled ? "enabled" : ""}`}
                          onClick={() => {
                            setOverflowSubmenu(null);
                            handleShellToggle();
                            setShowOverflowMenu(false);
                          }}
                          role="menuitemcheckbox"
                          aria-checked={shellEnabled}
                          aria-label={`Shell commands ${shellEnabled ? "on" : "off"}`}
                          data-overflow-menu-item
                        >
                          <svg
                            width="14"
                            height="14"
                            viewBox="0 0 24 24"
                            fill="none"
                            stroke="currentColor"
                            strokeWidth="2"
                          >
                            <path d="M4 17l6-6-6-6M12 19h8" />
                          </svg>
                          <span>Shell</span>
                          <span
                            className={`goal-mode-switch-track ${shellEnabled ? "on" : ""}`}
                            aria-hidden="true"
                          >
                            <span className="goal-mode-switch-thumb" />
                          </span>
                        </button>
                      </div>
                      {renderExecutionModeRow()}
                      {renderTaskDomainRow()}
                    </div>
                  )}
                  {showOverflowMenu && renderOverflowSubmenu()}
                </div>
                <div className="workspace-dropdown-container" ref={workspaceDropdownRef}>
                  {showWorkspaceDropdown && (
                    <div className="workspace-dropdown">
                      {workspacesList.length > 0 && (
                        <>
                          <div className="workspace-dropdown-header">Recent Folders</div>
                          <div className="workspace-dropdown-list">
                            {workspacesList.slice(0, 10).map((w) => (
                              <button
                                key={w.id}
                                className={`workspace-dropdown-item ${workspace?.id === w.id ? "active" : ""}`}
                                onClick={() => handleWorkspaceSelect(w)}
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <path d="M22 19a2 2 0 01-2 2H4a2 2 0 01-2-2V5a2 2 0 012-2h5l2 3h9a2 2 0 012 2z" />
                                </svg>
                                <div className="workspace-item-info">
                                  <span className="workspace-item-name">{w.name}</span>
                                  <span className="workspace-item-path">{w.path}</span>
                                </div>
                                {workspace?.id === w.id && (
                                  <svg
                                    width="14"
                                    height="14"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    className="check-icon"
                                  >
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
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                        <span>Work in another folder...</span>
                      </button>
                    </div>
                  )}
                </div>
              </>
            )}
            <div className="mention-autocomplete-wrapper" ref={mentionContainerRef}>
              <textarea
                ref={textareaRef}
                className="input-field input-textarea"
                placeholder={agentContext.getMessage("placeholderActive")}
                value={inputValue}
                onChange={handleInputChange}
                onKeyDown={handleKeyDown}
                onPaste={handlePaste}
                onClick={handleInputClick}
                onKeyUp={handleInputKeyUp}
                rows={1}
              />
              {renderMentionDropdown()}
              {renderSlashDropdown()}
            </div>
            <div className="input-actions">
              {uiDensity === "focused" && (
                <div className="model-label-container" ref={modelLabelRef}>
                  <button
                    className="model-label-subtle"
                    onClick={() => setShowModelDropdownFromLabel(!showModelDropdownFromLabel)}
                    title="Change model"
                  >
                    {availableModels.find((m) => m.key === selectedModel)?.displayName ||
                      selectedModel}
                  </button>
                  {showModelDropdownFromLabel && (
                    <div className="model-label-dropdown">
                      {availableModels.map((m) => (
                        <button
                          key={m.key}
                          className={`model-label-dropdown-item ${m.key === selectedModel ? "active" : ""}`}
                          onClick={() => {
                            onModelChange(m.key);
                            setShowModelDropdownFromLabel(false);
                          }}
                        >
                          {m.displayName}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
              <button
                className={`voice-input-btn ${voiceInput.state}`}
                onClick={voiceInput.toggleRecording}
                disabled={voiceInput.state === "processing" || talkMode.isActive}
                title={
                  talkMode.isActive
                    ? "Talk Mode active"
                    : voiceInput.state === "idle"
                      ? "Start voice input"
                      : voiceInput.state === "recording"
                        ? "Stop recording"
                        : "Processing..."
                }
              >
                {voiceInput.state === "processing" ? (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    className="voice-processing-spin"
                  >
                    <circle cx="12" cy="12" r="10" />
                    <path d="M12 6v6l4 2" />
                  </svg>
                ) : voiceInput.state === "recording" ? (
                  <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
                    <rect x="6" y="6" width="12" height="12" rx="2" />
                  </svg>
                ) : (
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M12 1a3 3 0 0 0-3 3v8a3 3 0 0 0 6 0V4a3 3 0 0 0-3-3z" />
                    <path d="M19 10v2a7 7 0 0 1-14 0v-2" />
                    <line x1="12" y1="19" x2="12" y2="23" />
                    <line x1="8" y1="23" x2="16" y2="23" />
                  </svg>
                )}
                {voiceInput.state === "recording" && (
                  <span
                    className="voice-recording-indicator"
                    style={{ width: `${voiceInput.audioLevel}%` }}
                  />
                )}
              </button>
              {isTaskWorking && onStopTask ? (
                <div className="task-control-buttons">
                  <button className="stop-btn-simple" onClick={onStopTask} title="Stop task">
                    <svg
                      width="16"
                      height="16"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <rect x="3" y="3" width="18" height="18" rx="2" />
                    </svg>
                  </button>
                </div>
              ) : (
                <button
                  className="lets-go-btn lets-go-btn-sm"
                  onClick={handleSend}
                  disabled={
                    (!inputValue.trim() && pendingAttachments.length === 0) ||
                    isUploadingAttachments ||
                    isPreparingMessage
                  }
                  title="Send message"
                >
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M12 19V5M5 12l7-7 7 7" />
                  </svg>
                </button>
              )}
            </div>
          </div>
          <div className="input-below-actions">
            {uiDensity !== "focused" && (
              <>
                <ModelDropdown
                  models={availableModels}
                  selectedModel={selectedModel}
                  onModelChange={onModelChange}
                  onOpenSettings={onOpenSettings}
                />
                <div className="workspace-dropdown-container" ref={workspaceDropdownRef}>
                  <button
                    className="folder-selector"
                    onClick={handleWorkspaceDropdownToggle}
                    title={workspace?.path || "Select a workspace folder"}
                  >
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                    >
                      <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                    </svg>
                    <span>
                      {workspace?.isTemp || isTempWorkspaceId(workspace?.id)
                        ? "Work in a folder"
                        : workspace?.name || "Work in a folder"}
                    </span>
                    <svg
                      width="12"
                      height="12"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="currentColor"
                      strokeWidth="2"
                      className={showWorkspaceDropdown ? "chevron-up" : ""}
                    >
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
                                className={`workspace-dropdown-item ${workspace?.id === w.id ? "active" : ""}`}
                                onClick={() => handleWorkspaceSelect(w)}
                              >
                                <svg
                                  width="14"
                                  height="14"
                                  viewBox="0 0 24 24"
                                  fill="none"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                >
                                  <path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z" />
                                </svg>
                                <div className="workspace-item-info">
                                  <span className="workspace-item-name">{w.name}</span>
                                  <span className="workspace-item-path">{w.path}</span>
                                </div>
                                {workspace?.id === w.id && (
                                  <svg
                                    width="14"
                                    height="14"
                                    viewBox="0 0 24 24"
                                    fill="none"
                                    stroke="currentColor"
                                    strokeWidth="2"
                                    className="check-icon"
                                  >
                                    <path d="M20 6L9 17l-5-5" />
                                  </svg>
                                )}
                              </button>
                            ))}
                          </div>
                          <div className="workspace-dropdown-divider" />
                        </>
                      )}
                      <button
                        className="workspace-dropdown-item new-folder"
                        onClick={handleSelectNewFolder}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="2"
                        >
                          <path d="M12 5v14M5 12h14" />
                        </svg>
                        <span>Work in another folder...</span>
                      </button>
                    </div>
                  )}
                </div>
                <button
                  className={`shell-toggle ${shellEnabled ? "enabled" : ""}`}
                  onClick={handleShellToggle}
                  role="switch"
                  aria-checked={shellEnabled}
                  aria-label={`Shell commands ${shellEnabled ? "on" : "off"}`}
                  title={
                    shellEnabled
                      ? "Shell commands enabled - click to disable"
                      : "Shell commands disabled - click to enable"
                  }
                >
                  <svg
                    width="14"
                    height="14"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="M4 17l6-6-6-6M12 19h8" />
                  </svg>
                  <span>Shell</span>
                  <span
                    className={`goal-mode-switch-track ${shellEnabled ? "on" : ""}`}
                    aria-hidden="true"
                  >
                    <span className="goal-mode-switch-thumb" />
                  </span>
                </button>
              </>
            )}
            <span className="keyboard-hint">
              {isPreparingMessage ? (
                <span>Preparing your message...</span>
              ) : (
                <span>
                  <kbd>Enter</kbd> to send · <kbd>Shift+Enter</kbd> for new line
                </span>
              )}
            </span>
          </div>
        </div>
        <div className="footer-disclaimer">{agentContext.getMessage("disclaimer")}</div>
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

function formatTokenCount(count: number): string {
  if (!Number.isFinite(count) || count < 0) return "0";
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
  if (count >= 10_000) return `${Math.round(count / 1_000)}k`;
  if (count >= 1_000) return `${(count / 1_000).toFixed(1)}k`;
  return count.toLocaleString();
}

function formatStreamElapsed(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}m${String(remainingSeconds).padStart(2, "0")}s`;
}

function formatSignedScore(value: number): string {
  if (!Number.isFinite(value)) return "0.00";
  const normalized = Math.max(-1, Math.min(1, value));
  return `${normalized >= 0 ? "+" : ""}${normalized.toFixed(2)}`;
}

function describeLoopRisk(loopRisk: number): "low" | "medium" | "high" {
  if (!Number.isFinite(loopRisk)) return "low";
  if (loopRisk >= 0.7) return "high";
  if (loopRisk >= 0.4) return "medium";
  return "low";
}

/**
 * Truncate long text for display, with expand option handled via CSS
 */
function truncateForDisplay(text: string, maxLength: number = 2000): string {
  if (!text || text.length <= maxLength) return text;
  return text.slice(0, maxLength) + "\n\n... [content truncated for display]";
}

function getSummaryStageLabel(stage: string): string | null {
  switch (stage.trim().toUpperCase()) {
    case "DISCOVER":
      return "Planning the approach";
    case "BUILD":
      return "Working on your request";
    case "VERIFY":
      return "Checking results";
    case "FIX":
      return "Applying fixes";
    case "DELIVER":
      return "Preparing final response";
    default:
      return null;
  }
}

function getApprovalPayload(event: TaskEvent): Any | null {
  if (!event?.payload || typeof event.payload !== "object" || Array.isArray(event.payload)) {
    return null;
  }
  const approval = (event.payload as Any).approval;
  if (!approval || typeof approval !== "object" || Array.isArray(approval)) {
    return null;
  }
  return approval as Any;
}

function getApprovalDescription(approval: Any | null): string {
  const description = approval?.description;
  return typeof description === "string" ? description.trim() : "";
}

function extractApprovalCommand(approval: Any | null): string | null {
  const commandFromDetails = approval?.details?.command;
  if (typeof commandFromDetails === "string") {
    const trimmed = commandFromDetails.trim();
    if (trimmed.length > 0) return trimmed;
  }

  const description = getApprovalDescription(approval);
  if (!description) return null;

  const commandMatch = description.match(/^Run(?:ning)? command(?:\s*\([^)]+\))?:\s*([\s\S]+)$/i);
  if (!commandMatch || typeof commandMatch[1] !== "string") return null;
  const command = commandMatch[1].trim();
  return command.length > 0 ? command : null;
}

function isRunCommandApproval(approval: Any | null): boolean {
  if (approval?.type === "run_command") return true;
  return Boolean(extractApprovalCommand(approval));
}

function renderEventTitle(
  event: TaskEvent,
  workspacePath?: string,
  onOpenViewer?: (path: string) => void,
  agentCtx?: AgentContext,
  options?: {
    summaryMode?: boolean;
  },
): React.ReactNode {
  const summaryMode = options?.summaryMode === true;
  // Build message context for personalized messages
  const msgCtx = agentCtx
    ? {
        agentName: agentCtx.agentName,
        userName: agentCtx.userName,
        personality: agentCtx.personality,
        persona: agentCtx.persona,
        emojiUsage: agentCtx.emojiUsage,
        quirks: agentCtx.quirks,
      }
    : {
        agentName: "CoWork",
        userName: undefined,
        personality: "professional" as const,
        persona: undefined,
        emojiUsage: "minimal" as const,
        quirks: DEFAULT_QUIRKS,
      };
  const effectiveType = getEffectiveTaskEventType(event);

  if (event.type === "timeline_group_started" || event.type === "timeline_group_finished") {
    const stage =
      typeof event.payload?.stage === "string" ? event.payload.stage.trim().toUpperCase() : "";
    const label =
      (typeof event.payload?.groupLabel === "string" && event.payload.groupLabel) ||
      stage ||
      "Group";
    const summaryStageLabel = stage ? getSummaryStageLabel(stage) : null;
    if (summaryMode && summaryStageLabel) {
      return summaryStageLabel;
    }

    const maxParallel =
      typeof event.payload?.maxParallel === "number" && Number.isFinite(event.payload.maxParallel)
        ? Math.max(1, Math.floor(event.payload.maxParallel))
        : null;
    const base = event.type === "timeline_group_started" ? `Starting ${label}` : `Completed ${label}`;
    return !summaryMode && maxParallel && event.type === "timeline_group_started"
      ? `${base} (${maxParallel} parallel)`
      : base;
  }

  if (event.type === "timeline_evidence_attached") {
    const refs = Array.isArray(event.payload?.evidenceRefs) ? event.payload.evidenceRefs : [];
    const count = refs.length;
    return count > 0 ? `Attached ${count} evidence link${count === 1 ? "" : "s"}` : "Attached evidence";
  }

  if (event.type === "timeline_artifact_emitted") {
    const path = typeof event.payload?.path === "string" ? event.payload.path : "";
    const label =
      typeof event.payload?.label === "string" && event.payload.label.trim().length > 0
        ? event.payload.label
        : path;
    return path ? (
      <span>
        Output ready:{" "}
        <ClickableFilePath path={path} workspacePath={workspacePath} onOpenViewer={onOpenViewer} />
        {label && label !== path && <span className="event-title-meta"> ({label})</span>}
      </span>
    ) : "Output ready";
  }

  if (event.type === "timeline_error") {
    const message = typeof event.payload?.message === "string" ? event.payload.message : "";
    return message || getMessage("error", msgCtx);
  }

  if (event.type === "timeline_step_updated" && effectiveType === "progress_update") {
    return typeof event.payload?.message === "string" ? event.payload.message : "Progress update";
  }

  switch (effectiveType) {
    case "task_created":
      return getMessage("taskStart", msgCtx);
    case "task_completed":
      return event.payload?.terminalStatus === "needs_user_action"
        ? "Completed - action required"
        : event.payload?.terminalStatus === "partial_success"
          ? "Completed - partial success"
        : getMessage("taskComplete", msgCtx);
    case "plan_created":
      return getMessage("planCreated", msgCtx);
    case "step_started":
      return getMessage(
        "stepStarted",
        msgCtx,
        sanitizeToolCallTextFromAssistant(event.payload.step?.description || "Getting started...").text ||
          "Getting started...",
      );
    case "step_completed":
      return getMessage(
        "stepCompleted",
        msgCtx,
        sanitizeToolCallTextFromAssistant(event.payload.step?.description || event.payload.message || "").text,
      );
    case "step_failed":
      return `Step failed: ${event.payload.step?.description || "Unknown step"}`;
    case "continuation_decision":
      return typeof event.payload?.reason === "string"
        ? `Continuation decision: ${event.payload.reason}`
        : "Continuation decision";
    case "auto_continuation_started":
      return "Auto continuation started";
    case "auto_continuation_blocked":
      return typeof event.payload?.reason === "string"
        ? `Auto continuation blocked: ${event.payload.reason}`
        : "Auto continuation blocked";
    case "context_compaction_started":
      return "Compacting context for continuation";
    case "context_compaction_completed":
      return "Context compaction completed";
    case "context_compaction_failed":
      return "Context compaction failed";
    case "step_contract_escalated":
      return typeof event.payload?.reason === "string"
        ? `Step contract escalated: ${event.payload.reason}`
        : "Step contract escalated";
    case "no_progress_circuit_breaker":
      return "Stopped by no-progress circuit breaker";
    case "tool_call": {
      const tcTool = event.payload.tool;
      const tcInput = event.payload.input;
      let tcDetail = "";
      if (tcTool === "write_file" && tcInput?.path) {
        const tcLines = tcInput.content ? tcInput.content.split("\n").length : 0;
        tcDetail = ` → ${tcInput.path} (${tcLines} lines)`;
      } else if (tcTool === "edit_file" && tcInput?.file_path) {
        tcDetail = ` → ${tcInput.file_path}`;
      } else if (tcTool === "read_file" && tcInput?.path) {
        tcDetail = ` → ${tcInput.path}`;
      } else if (tcTool === "run_command" && tcInput?.command) {
        const cmd =
          tcInput.command.length > 40 ? tcInput.command.slice(0, 40) + "..." : tcInput.command;
        tcDetail = ` → ${cmd}`;
      } else if (tcTool === "glob" && tcInput?.pattern) {
        tcDetail = ` → ${tcInput.pattern}`;
      } else if ((tcTool === "grep" || tcTool === "search_files") && tcInput?.pattern) {
        tcDetail = ` → /${tcInput.pattern}/`;
      }
      return `Using: ${tcTool}${tcDetail}`;
    }
    case "tool_result": {
      const result = event.payload.result;
      const success = result?.success !== false && !result?.error;
      const status = success ? "done" : "issue";

      // schedule_task is user-facing; surface a compact summary in the title.
      if (event.payload.tool === "schedule_task") {
        const describeEvery = (ms: number): string => {
          if (!Number.isFinite(ms) || ms <= 0) return `${ms}ms`;
          const day = 24 * 60 * 60 * 1000;
          const hour = 60 * 60 * 1000;
          const minute = 60 * 1000;
          const second = 1000;

          if (ms >= day && ms % day === 0) {
            const days = ms / day;
            return `Every ${days} day${days === 1 ? "" : "s"}`;
          }
          if (ms >= hour && ms % hour === 0) {
            const hours = ms / hour;
            return `Every ${hours} hour${hours === 1 ? "" : "s"}`;
          }
          if (ms >= minute && ms % minute === 0) {
            const minutes = ms / minute;
            return `Every ${minutes} minute${minutes === 1 ? "" : "s"}`;
          }
          if (ms >= second && ms % second === 0) {
            const seconds = ms / second;
            return `Every ${seconds} second${seconds === 1 ? "" : "s"}`;
          }
          return `Every ${Math.round(ms / 1000)}s`;
        };

        const describeScheduleShort = (schedule: Any): string | null => {
          if (!schedule || typeof schedule !== "object") return null;
          if (schedule.kind === "every" && typeof schedule.everyMs === "number") {
            return describeEvery(schedule.everyMs);
          }
          if (schedule.kind === "cron" && typeof schedule.expr === "string") {
            return `Cron: ${schedule.expr}`;
          }
          if (schedule.kind === "at" && typeof schedule.atMs === "number") {
            return `Once at ${new Date(schedule.atMs).toLocaleString()}`;
          }
          return null;
        };

        // Error-first title for schedule failures.
        if (!success && result?.error) {
          const errorMsg = typeof result.error === "string" ? result.error : "Unknown error";
          const clipped = errorMsg.slice(0, 80) + (errorMsg.length > 80 ? "..." : "");
          return `schedule_task issue: ${clipped}`;
        }

        // "create"/"update" responses include { success, job }.
        const job = result?.job;
        if (job && typeof job === "object") {
          const jobName = String((job as Any).name || "").trim() || "Scheduled task";
          const scheduleDesc = describeScheduleShort((job as Any).schedule);
          const nextRunAtMs = (job as Any).state?.nextRunAtMs;
          const next =
            typeof nextRunAtMs === "number" ? new Date(nextRunAtMs).toLocaleString() : null;
          const parts = [scheduleDesc, next ? `Next: ${next}` : null].filter(Boolean) as string[];
          return parts.length > 0 ? `${jobName} → ${parts.join(" • ")}` : jobName;
        }

        // "list" returns an array of jobs.
        if (Array.isArray(result)) {
          const n = result.length;
          return `schedule_task ${status} → ${n} task${n === 1 ? "" : "s"}`;
        }
      }

      // Extract useful info from result to show inline
      let detail = "";
      if (result) {
        if (!success && result.error) {
          // Show error message for failed tools
          const errorMsg = typeof result.error === "string" ? result.error : "Unknown error";
          detail = `: ${errorMsg.slice(0, 60)}${errorMsg.length > 60 ? "..." : ""}`;
        } else if (result.path) {
          detail = ` → ${result.path}`;
        } else if (result.content && typeof result.content === "string") {
          const lines = result.content.split("\n").length;
          detail = ` → ${lines} lines`;
        } else if (result.size !== undefined) {
          detail = ` → ${result.size} bytes`;
        } else if (result.files) {
          detail = ` → ${result.files.length} items`;
        } else if (result.matches) {
          detail = ` → ${result.matches.length} matches`;
        } else if (result.exitCode !== undefined) {
          detail = result.exitCode === 0 ? "" : ` → exit ${result.exitCode}`;
        }
      }
      return `${event.payload.tool} ${status}${detail}`;
    }
    case "assistant_message":
      return msgCtx.agentName;
    case "file_created": {
      const fcp = event.payload;
      let fcSuffix = "";
      if (fcp.type === "directory") {
        fcSuffix = " (directory)";
      } else if (fcp.type === "screenshot") {
        fcSuffix = " (screenshot)";
      } else if (fcp.copiedFrom) {
        fcSuffix = " (copy)";
      } else if (fcp.lineCount && fcp.size) {
        fcSuffix = ` (${fcp.lineCount} lines, ${formatFileSize(fcp.size)})`;
      } else if (fcp.size) {
        fcSuffix = ` (${formatFileSize(fcp.size)})`;
      }
      return (
        <span>
          Created:{" "}
          <ClickableFilePath
            path={fcp.path}
            workspacePath={workspacePath}
            onOpenViewer={onOpenViewer}
          />
          {fcSuffix && <span className="event-title-meta">{fcSuffix}</span>}
        </span>
      );
    }
    case "file_modified": {
      const fmp = event.payload;
      const fmPath = fmp.path || fmp.from;
      let fmSuffix = "";
      if (fmp.action === "rename" && fmp.to) {
        const toName = fmp.to.split("/").pop();
        fmSuffix = ` → ${toName}`;
      } else if (fmp.type === "edit" && fmp.replacements) {
        const netStr =
          fmp.netLines != null
            ? fmp.netLines > 0
              ? `, +${fmp.netLines} lines`
              : fmp.netLines < 0
                ? `, ${fmp.netLines} lines`
                : ""
            : "";
        fmSuffix = ` (${fmp.replacements} edit${fmp.replacements > 1 ? "s" : ""}${netStr})`;
      }
      return (
        <span>
          Updated:{" "}
          <ClickableFilePath
            path={fmPath}
            workspacePath={workspacePath}
            onOpenViewer={onOpenViewer}
          />
          {fmSuffix && <span className="event-title-meta">{fmSuffix}</span>}
        </span>
      );
    }
    case "file_deleted":
      return `Removed: ${event.payload.path}`;
    case "artifact_created": {
      const acp = event.payload || {};
      const acPath = typeof acp.path === "string" ? acp.path : "";
      const acType = typeof acp.type === "string" ? acp.type : "artifact";
      return acPath ? (
        <span>
          Output ready:{" "}
          <ClickableFilePath path={acPath} workspacePath={workspacePath} onOpenViewer={onOpenViewer} />
          <span className="event-title-meta"> ({acType})</span>
        </span>
      ) : `Output ready (${acType})`;
    }
    case "diagram_created": {
      const title = typeof event.payload?.title === "string" ? event.payload.title : "Diagram";
      return (
        <span>
          Diagram:{" "}
          <span className="event-title-meta">{title}</span>
        </span>
      );
    }
    case "error":
      return getMessage("error", msgCtx);
    case "approval_requested": {
      const approval = getApprovalPayload(event);
      if (isRunCommandApproval(approval)) {
        return "Running command:";
      }
      const description = getApprovalDescription(approval);
      return description ? `${getMessage("approval", msgCtx)} ${description}` : getMessage("approval", msgCtx);
    }
    case "input_request_created":
      return "Structured input requested";
    case "input_request_resolved":
      return "Structured input submitted";
    case "input_request_dismissed":
      return "Structured input dismissed";
    case "log":
      return event.payload.message;
    case "verification_started":
      return getMessage("verifying", msgCtx);
    case "verification_passed":
      return `${getMessage("verifyPassed", msgCtx)} (attempt ${event.payload.attempt})`;
    case "verification_failed": {
      const attempt = event.payload?.attempt;
      const maxAttempts = event.payload?.maxAttempts;
      if (typeof attempt === "number" && typeof maxAttempts === "number") {
        return `${getMessage("verifyFailed", msgCtx)} (attempt ${attempt}/${maxAttempts})`;
      }
      return getMessage("verifyFailed", msgCtx);
    }
    case "verification_pending_user_action":
      return "Verification requires user action";
    case "retry_started":
      return getMessage("retrying", msgCtx, String(event.payload.attempt));
    default:
      return event.type;
  }
}

function renderEventDetails(
  event: TaskEvent,
  voiceEnabled: boolean,
  markdownComponents: Any,
  options?: {
    workspacePath?: string;
    onOpenViewer?: (path: string) => void;
    events?: TaskEvent[];
    onViewOutputs?: (taskId: string, primaryOutputPath?: string) => void;
    hideVerificationSteps?: boolean;
    summaryMode?: boolean;
  },
) {
  const workspacePath = options?.workspacePath;
  const onOpenViewer = options?.onOpenViewer;
  const eventStream = options?.events || [];
  const onViewOutputs = options?.onViewOutputs;
  const summaryMode = options?.summaryMode === true;
  const imageExt = /\.(png|jpe?g|gif|webp|svg|bmp|ico)$/i;
  const spreadsheetExt = /\.xlsx?$/i;
  const documentPreviewExt = /\.(pdf|docx|md|markdown|txt)$/i;
  const effectiveType = getEffectiveTaskEventType(event);
  const stepCompletionPreviewPath = getStepCompletionPreviewPath(event);

  if (event.type === "timeline_group_started" || event.type === "timeline_group_finished") {
    if (summaryMode) return null;
    const stage =
      typeof event.payload?.stage === "string" && event.payload.stage.trim().length > 0
        ? event.payload.stage.trim()
        : "";
    const groupId = typeof event.groupId === "string" ? event.groupId : event.payload?.groupId;
    const maxParallel =
      typeof event.payload?.maxParallel === "number" && Number.isFinite(event.payload.maxParallel)
        ? Math.max(1, Math.floor(event.payload.maxParallel))
        : undefined;
    return (
      <div className="event-details">
        {stage ? <div>Stage: {stage}</div> : null}
        {groupId ? <div>Group: {String(groupId)}</div> : null}
        {typeof maxParallel === "number" ? <div>Parallel lanes: {maxParallel}</div> : null}
      </div>
    );
  }

  if (event.type === "timeline_evidence_attached") {
    const refs = Array.isArray(event.payload?.evidenceRefs) ? event.payload.evidenceRefs : [];
    if (!refs.length) return null;
    return (
      <div className="event-details evidence-event-details">
        <div className="evidence-event-details-title">Evidence</div>
        <div className="evidence-event-details-scroll">
          <ul className="evidence-event-details-list">
            {refs.map((entry: Any, index: number) => {
              const source =
                typeof entry?.sourceUrlOrPath === "string" ? entry.sourceUrlOrPath.trim() : "";
              if (!source) return null;
              const snippet =
                typeof entry?.snippet === "string" ? stripHtmlTags(entry.snippet) : "";
              const label = snippet || source;
              const isWeb = /^https?:\/\//i.test(source);
              return (
                <li key={`${source}-${index}`} className="evidence-event-details-item">
                  {isWeb ? (
                    <a href={source} target="_blank" rel="noreferrer">
                      {label}
                    </a>
                  ) : (
                    <span>{label}</span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </div>
    );
  }

  if (event.type === "timeline_error") {
    return (
      <div
        className="event-details"
        style={{ background: "rgba(239, 68, 68, 0.1)", borderColor: "rgba(239, 68, 68, 0.2)" }}
      >
        {event.payload?.message || "Timeline error"}
      </div>
    );
  }

  if (effectiveType === "diagram_created") {
    const diagram = typeof event.payload?.diagram === "string" ? event.payload.diagram : "";
    if (!diagram.trim()) return null;
    return (
      <div className="diagram-event-details">
        <MermaidDiagram chart={diagram} />
      </div>
    );
  }

  switch (effectiveType) {
    case "task_completed": {
      const outputSummary = resolveTaskOutputSummaryFromCompletionEvent(event, eventStream);
      const isNeedsUserAction = event.payload?.terminalStatus === "needs_user_action";
      if (!hasTaskOutputs(outputSummary) && !isNeedsUserAction) return null;

      const primaryOutputPath = outputSummary?.primaryOutputPath;
      const primaryOutputName = primaryOutputPath
        ? primaryOutputPath.split("/").pop() || primaryOutputPath
        : "";
      const outputCount = outputSummary?.outputCount ?? 0;
      const outputLabel =
        outputCount === 1
          ? `1 output ready`
          : `${outputCount} outputs ready`;

      const pendingChecklist: string[] = Array.isArray(event.payload?.pendingChecklist)
        ? event.payload.pendingChecklist.filter((item: unknown): item is string => typeof item === "string")
        : [];
      return (
        <div className="event-details completion-output-card">
          <div className="completion-output-header">
            {isNeedsUserAction ? "Action required" : "Output ready"}
          </div>
          {isNeedsUserAction && (
            <div className="completion-output-subtitle">
              Complete the pending verification items to fully close this task.
            </div>
          )}
          {hasTaskOutputs(outputSummary) && (
            <>
              <div className="completion-output-subtitle">{outputLabel}</div>
              {primaryOutputPath && (
                <div className="completion-output-primary">
                  Primary file:{" "}
                  <ClickableFilePath
                    path={primaryOutputPath}
                    workspacePath={workspacePath}
                    onOpenViewer={onOpenViewer}
                  />
                  {primaryOutputName && <span className="event-title-meta"> ({primaryOutputName})</span>}
                </div>
              )}
              <div className="completion-output-actions">
                <button
                  className="completion-output-btn"
                  disabled={!primaryOutputPath}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!primaryOutputPath) return;
                    void window.electronAPI.openFile(primaryOutputPath, workspacePath);
                  }}
                >
                  Open file
                </button>
                <button
                  className="completion-output-btn secondary"
                  disabled={!primaryOutputPath}
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    if (!primaryOutputPath) return;
                    void window.electronAPI.showInFinder(primaryOutputPath, workspacePath);
                  }}
                >
                  Show in Finder
                </button>
                <button
                  className="completion-output-btn secondary"
                  onClick={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    onViewOutputs?.(event.taskId, primaryOutputPath);
                  }}
                >
                  View in Files
                </button>
              </div>
            </>
          )}
          {pendingChecklist.length > 0 && (
            <ul style={{ marginTop: 8, paddingLeft: 18 }}>
              {pendingChecklist.map((item, idx) => (
                <li key={`${idx}-${item}`}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    case "plan_created": {
      const inlinePlanMarkdownComponents = {
        ...markdownComponents,
        // Keep each list item inline; avoid wrapping with extra <p> inside <li>.
        p: ({ children }: Any) => <>{children}</>,
      };
      const planSteps = Array.isArray(event.payload.plan?.steps) ? event.payload.plan.steps : [];
      const visiblePlanSteps = options?.hideVerificationSteps
        ? planSteps.filter((step: Any) => !isVerificationStepDescription(step?.description))
        : planSteps;
      return (
        <div className="event-details markdown-content">
          <div style={{ marginBottom: 8, fontWeight: 500 }}>
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {normalizeMarkdownForDisplay(String(event.payload.plan?.description || ""))}
            </ReactMarkdown>
          </div>
          {visiblePlanSteps.length > 0 && (
            <div className="plan-checklist">
              {visiblePlanSteps.map((step: Any, i: number) => (
                <div key={i} className="plan-checklist-item">
                  <span className="plan-checklist-circle" />
                  <span className="plan-checklist-text">
                    <ReactMarkdown
                      remarkPlugins={[remarkGfm]}
                      components={inlinePlanMarkdownComponents}
                    >
                      {normalizeMarkdownForDisplay(String(step?.description || ""))}
                    </ReactMarkdown>
                  </span>
                </div>
              ))}
            </div>
          )}
        </div>
      );
    }
    case "tool_call": {
      const tcToolName = event.payload.tool;
      const tcInput = event.payload.input;

      // write_file: show path + code preview
      if (tcToolName === "write_file" && tcInput?.path && tcInput?.content) {
        const tcLines = tcInput.content.split("\n");
        const tcPreview = tcLines.slice(0, 20).join("\n");
        const tcExt = (tcInput.path.split(".").pop() || "text").toLowerCase();
        return (
          <div className="event-details event-details-scrollable event-details-code-preview">
            <div className="code-preview-header">
              <span className="code-preview-path">{tcInput.path}</span>
              <span className="code-preview-language">{tcExt}</span>
            </div>
            <pre className="code-preview-content">
              <code>{truncateForDisplay(tcPreview, 1500)}</code>
            </pre>
            {tcLines.length > 20 && (
              <div className="code-preview-truncated">... {tcLines.length - 20} more lines</div>
            )}
          </div>
        );
      }

      // edit_file: show diff-like view
      if (tcToolName === "edit_file" && tcInput?.file_path) {
        return (
          <div className="event-details event-details-scrollable event-details-code-preview">
            <div className="code-preview-header">
              <span className="code-preview-path">{tcInput.file_path}</span>
            </div>
            <div className="edit-diff-preview">
              {tcInput.old_string && (
                <div className="diff-line diff-removed">
                  <span className="diff-marker">-</span>
                  <pre>
                    <code>{truncateForDisplay(tcInput.old_string, 500)}</code>
                  </pre>
                </div>
              )}
              {tcInput.new_string && (
                <div className="diff-line diff-added">
                  <span className="diff-marker">+</span>
                  <pre>
                    <code>{truncateForDisplay(tcInput.new_string, 500)}</code>
                  </pre>
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
    case "tool_result":
      return (
        <div className="event-details event-details-scrollable">
          <pre>{truncateForDisplay(JSON.stringify(event.payload.result, null, 2))}</pre>
        </div>
      );
    case "assistant_message": {
      const cleanedMessage = cleanAssistantMessageForDisplay(event.payload.message);
      const linkedMessage = autolinkBareUrls(cleanedMessage);
      return (
        <div className="event-details assistant-message event-details-scrollable">
          <div className="markdown-content">
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
              {linkedMessage}
            </ReactMarkdown>
          </div>
          <div className="message-actions">
            <MessageCopyButton text={event.payload.message} />
            <MessageSpeakButton text={event.payload.message} voiceEnabled={voiceEnabled} />
          </div>
        </div>
      );
    }
    case "step_completed": {
      if (stepCompletionPreviewPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlineDocumentPreview
              filePath={stepCompletionPreviewPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }
      return null;
    }
    case "step_failed":
      return (
        <div
          className="event-details"
          style={{ background: "rgba(239, 68, 68, 0.1)", borderColor: "rgba(239, 68, 68, 0.2)" }}
        >
          {event.payload?.reason || event.payload?.step?.error || "Step failed."}
        </div>
      );
    case "verification_pending_user_action": {
      const checklist: string[] = Array.isArray(event.payload?.pendingChecklist)
        ? event.payload.pendingChecklist.filter((item: unknown): item is string => typeof item === "string")
        : [];
      return (
        <div className="event-details">
          <div style={{ fontWeight: 600, marginBottom: 6 }}>Verification pending user action</div>
          {typeof event.payload?.message === "string" && event.payload.message.trim().length > 0 && (
            <div style={{ marginBottom: checklist.length > 0 ? 6 : 0 }}>{event.payload.message}</div>
          )}
          {checklist.length > 0 && (
            <ul style={{ margin: 0, paddingLeft: 18 }}>
              {checklist.map((item, idx) => (
                <li key={`${idx}-${item}`}>{item}</li>
              ))}
            </ul>
          )}
        </div>
      );
    }
    case "approval_requested": {
      const approval = getApprovalPayload(event);
      if (!approval) return null;

      const description = getApprovalDescription(approval);
      const command = extractApprovalCommand(approval);
      const cwd = typeof approval?.details?.cwd === "string" ? approval.details.cwd : "";
      const timeoutMs =
        typeof approval?.details?.timeout === "number" && Number.isFinite(approval.details.timeout)
          ? approval.details.timeout
          : null;
      const timeoutLabel =
        typeof timeoutMs === "number" ? `${Math.max(1, Math.round(timeoutMs / 1000))}s` : null;

      if (command) {
        return (
          <div className="event-details event-details-scrollable">
            <div style={{ marginBottom: 6, fontWeight: 600 }}>Running command:</div>
            <pre>
              <code>{truncateForDisplay(command, 8000)}</code>
            </pre>
            {(cwd || timeoutLabel) && (
              <div style={{ marginTop: 8 }}>
                {cwd && <div>CWD: {cwd}</div>}
                {timeoutLabel && <div>Timeout: {timeoutLabel}</div>}
              </div>
            )}
          </div>
        );
      }

      return (
        <div className="event-details event-details-scrollable">
          {description ? <div style={{ marginBottom: approval.details ? 8 : 0 }}>{description}</div> : null}
          {approval.details && <pre>{truncateForDisplay(JSON.stringify(approval.details, null, 2), 4000)}</pre>}
        </div>
      );
    }
    case "input_request_created": {
      const request = event.payload?.request;
      const questions: Array<{ question?: string; options?: Array<{ label?: string }> }> = Array.isArray(
        request?.questions,
      )
        ? request.questions
        : [];
      if (questions.length === 0) return null;
      return (
        <div className="event-details event-details-scrollable">
          <div style={{ marginBottom: 8, fontWeight: 600 }}>Pending structured prompt</div>
          <ol style={{ margin: 0, paddingLeft: 18 }}>
            {questions.map((question, idx) => (
              <li key={`${idx}-${question?.question || "q"}`}>
                <div>{question?.question || "Question"}</div>
                {Array.isArray(question?.options) && question.options.length > 0 && (
                  <div style={{ color: "var(--color-text-muted)", fontSize: 12 }}>
                    {question.options
                      .map((option) => (typeof option?.label === "string" ? option.label : ""))
                      .filter(Boolean)
                      .join(" · ")}
                  </div>
                )}
              </li>
            ))}
          </ol>
        </div>
      );
    }
    case "file_created": {
      const fcPayload = event.payload;
      const fcPath = fcPayload?.path;
      const fcIsImage =
        fcPayload?.type === "image" ||
        (typeof fcPayload?.mimeType === "string" &&
          fcPayload.mimeType.toLowerCase().startsWith("image/")) ||
        imageExt.test(String(fcPath || ""));

      if (fcIsImage && fcPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlineImagePreview
              filePath={fcPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      // Spreadsheet preview
      const fcIsSpreadsheet =
        fcPayload?.type === "spreadsheet" || spreadsheetExt.test(String(fcPath || ""));
      if (fcIsSpreadsheet && fcPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlineSpreadsheetPreview
              filePath={fcPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      const fcMimeType =
        typeof fcPayload?.mimeType === "string" ? fcPayload.mimeType.toLowerCase() : "";
      const fcIsMarkdown =
        fcPayload?.type === "markdown" ||
        fcMimeType === "text/markdown" ||
        /\.md(?:own)?$/i.test(String(fcPath || "")) ||
        String(fcPayload?.language || "").toLowerCase() === "md" ||
        String(fcPayload?.language || "").toLowerCase() === "markdown";
      const fcIsDocument =
        fcPayload?.type === "pdf" ||
        fcPayload?.type === "docx" ||
        fcPayload?.type === "markdown" ||
        fcPayload?.type === "text" ||
        fcPayload?.type === "code" ||
        fcMimeType === "application/pdf" ||
        fcMimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
        fcMimeType === "text/markdown" ||
        documentPreviewExt.test(String(fcPath || ""));

      // For markdown outputs, prefer rendered markdown over raw contentPreview syntax.
      if (fcIsMarkdown && fcPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlineDocumentPreview
              filePath={fcPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      // Content preview for text file writes
      if (fcPayload?.contentPreview) {
        const previewLineCount = fcPayload.contentPreview.split("\n").length;
        return (
          <div className="event-details event-details-scrollable event-details-code-preview">
            <div className="code-preview-header">
              <span className="code-preview-language">{fcPayload.language || "text"}</span>
              {fcPayload.previewTruncated && (
                <span className="code-preview-truncated">
                  showing first {previewLineCount} of {fcPayload.lineCount} lines
                </span>
              )}
            </div>
            <HighlightedCodePreview code={fcPayload.contentPreview} language={fcPayload.language} />
          </div>
        );
      }

      if (fcIsDocument && fcPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlineDocumentPreview
              filePath={fcPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      // Copy source info
      if (fcPayload?.copiedFrom) {
        return (
          <div className="event-details">
            Copied from:{" "}
            <ClickableFilePath
              path={fcPayload.copiedFrom}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      return null;
    }
    case "file_modified": {
      const fmPayload = event.payload;
      const fmPath = fmPayload?.path || fmPayload?.from;
      const fmIsImage =
        fmPayload?.type === "image" ||
        (typeof fmPayload?.mimeType === "string" &&
          fmPayload.mimeType.toLowerCase().startsWith("image/")) ||
        imageExt.test(String(fmPath || ""));

      if (fmIsImage && fmPath && workspacePath) {
        return (
          <div className="event-details event-details-file-preview">
            <InlineImagePreview
              filePath={fmPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      // Edit diff preview
      if (fmPayload?.type === "edit" && (fmPayload?.oldPreview || fmPayload?.newPreview)) {
        return (
          <div className="event-details event-details-scrollable event-details-code-preview">
            <div className="edit-diff-preview">
              {fmPayload.oldPreview && (
                <div className="diff-line diff-removed">
                  <span className="diff-marker">-</span>
                  <pre>
                    <code>{fmPayload.oldPreview}</code>
                  </pre>
                </div>
              )}
              {fmPayload.newPreview && (
                <div className="diff-line diff-added">
                  <span className="diff-marker">+</span>
                  <pre>
                    <code>{fmPayload.newPreview}</code>
                  </pre>
                </div>
              )}
            </div>
          </div>
        );
      }

      // Rename info
      if (fmPayload?.action === "rename" && fmPayload?.from && fmPayload?.to) {
        return (
          <div className="event-details">
            <ClickableFilePath
              path={fmPayload.from}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
            {" → "}
            <ClickableFilePath
              path={fmPayload.to}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }

      return null;
    }
    case "artifact_created": {
      const artifactPath = event.payload?.path;
      if (typeof artifactPath === "string" && artifactPath.trim().length > 0) {
        const artifactMimeType =
          typeof event.payload?.mimeType === "string" ? event.payload.mimeType.toLowerCase() : "";
        const artifactIsImage =
          artifactMimeType.startsWith("image/") || imageExt.test(String(artifactPath || ""));
        const artifactIsSpreadsheet = spreadsheetExt.test(String(artifactPath || ""));
        const artifactIsDocument =
          artifactMimeType === "application/pdf" ||
          artifactMimeType === "application/vnd.openxmlformats-officedocument.wordprocessingml.document" ||
          artifactMimeType === "text/markdown" ||
          artifactMimeType.startsWith("text/") ||
          documentPreviewExt.test(String(artifactPath || ""));

        if (artifactIsImage && workspacePath) {
          return (
            <div className="event-details event-details-file-preview">
              <InlineImagePreview
                filePath={artifactPath}
                workspacePath={workspacePath}
                onOpenViewer={onOpenViewer}
              />
            </div>
          );
        }

        if (artifactIsSpreadsheet && workspacePath) {
          return (
            <div className="event-details event-details-file-preview">
              <InlineSpreadsheetPreview
                filePath={artifactPath}
                workspacePath={workspacePath}
                onOpenViewer={onOpenViewer}
              />
            </div>
          );
        }

        if (artifactIsDocument && workspacePath) {
          return (
            <div className="event-details event-details-file-preview">
              <InlineDocumentPreview
                filePath={artifactPath}
                workspacePath={workspacePath}
                onOpenViewer={onOpenViewer}
              />
            </div>
          );
        }

        return (
          <div className="event-details">
            Saved artifact:{" "}
            <ClickableFilePath
              path={artifactPath}
              workspacePath={workspacePath}
              onOpenViewer={onOpenViewer}
            />
          </div>
        );
      }
      return null;
    }
    case "error":
      return (
        <div
          className="event-details"
          style={{ background: "rgba(239, 68, 68, 0.1)", borderColor: "rgba(239, 68, 68, 0.2)" }}
        >
          {event.payload.error || event.payload.message}
        </div>
      );
    default:
      return null;
  }
}
