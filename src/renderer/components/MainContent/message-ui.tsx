import type { Components } from "react-markdown";
import { memo, useState, useRef, useCallback, Suspense, useLayoutEffect } from "react";
import { Check, Copy, GitFork, LoaderCircle, Quote, Square, Volume2 } from "lucide-react";
import type {
  IntegrationMentionSelection,
  QuotedAssistantMessage,
  TaskEvent,
} from "../../../shared/types";
import {
  isImageAttachmentMimeType,
  type UserMessageAttachmentMetadata,
} from "../../../shared/user-message-attachments";
import { InlineImagePreview } from "../InlineImagePreview";
import {
  COLLAPSED_USER_BUBBLE_MAX_HEIGHT,
  COLLAPSED_USER_BUBBLE_MIN_HEIGHT,
  MAX_QUOTED_ASSISTANT_MESSAGE_CHARS,
  MAX_QUOTED_ASSISTANT_PREVIEW_CHARS,
} from "./main-content-constants";
import { cleanAssistantMessageForDisplay } from "./markdown-normalization";
import { toPlainAnswerText } from "../../../shared/answer-surfaces/blocks";
import {
  IntegrationMentionText,
  hasRenderableIntegrationMentions,
} from "../IntegrationMentionText";
import { LazyHighlightedCodePreview, LazyMarkdownRenderer } from "../lazy-renderers";

export const UserMessageImageGallery = memo(function UserMessageImageGallery({
  attachments,
  workspacePath,
  onOpenViewer,
}: {
  attachments: UserMessageAttachmentMetadata[];
  workspacePath?: string;
  onOpenViewer?: (path: string) => void;
}) {
  const imageAttachments = attachments.filter((attachment) =>
    isImageAttachmentMimeType(attachment.mimeType),
  );
  if (imageAttachments.length === 0) return null;

  const layout =
    imageAttachments.length === 1
      ? "single"
      : imageAttachments.length === 2
        ? "double"
        : "multiple";

  return (
    <div
      className={`user-message-image-gallery user-message-image-gallery-${layout}`}
      role="group"
      aria-label={`${imageAttachments.length} attached image${
        imageAttachments.length === 1 ? "" : "s"
      }`}
    >
      {imageAttachments.map((attachment, index) => {
        const label = attachment.filename || `Image ${index + 1}`;
        const key = `${attachment.filePath || attachment.filename || "image"}-${index}`;

        if (attachment.filePath && workspacePath) {
          return (
            <div className="user-message-image-gallery-item" key={key}>
              <InlineImagePreview
                filePath={attachment.filePath}
                workspacePath={workspacePath}
                onOpenViewer={onOpenViewer}
              />
            </div>
          );
        }

        return (
          <div
            className="user-message-image-gallery-fallback"
            key={key}
            role="img"
            aria-label={label}
          >
            <svg
              width="22"
              height="22"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.7"
              aria-hidden="true"
            >
              <rect x="3" y="3" width="18" height="18" rx="2" />
              <circle cx="8.5" cy="8.5" r="1.5" />
              <path d="m21 15-4.5-4.5L7 20" />
            </svg>
            <span title={label}>{label}</span>
          </div>
        );
      })}
    </div>
  );
});

export function DeferredMarkdown({
  children,
  components,
  withBreaks = false,
}: {
  children: string;
  components?: Components;
  withBreaks?: boolean;
}) {
  return (
    <Suspense fallback={<span className="markdown-deferred-text">{children}</span>}>
      <LazyMarkdownRenderer components={components} withBreaks={withBreaks}>
        {children}
      </LazyMarkdownRenderer>
    </Suspense>
  );
}

export function resolveSafeCollapsedBubbleHeight(
  lineBottoms: number[],
  maxHeight = COLLAPSED_USER_BUBBLE_MAX_HEIGHT,
  minHeight = COLLAPSED_USER_BUBBLE_MIN_HEIGHT,
): number {
  const lastVisibleLineBottom = lineBottoms
    .filter((bottom) => Number.isFinite(bottom) && bottom > 0 && bottom <= maxHeight)
    .at(-1);

  if (lastVisibleLineBottom == null) return maxHeight;

  return Math.max(minHeight, Math.min(maxHeight, Math.floor(lastVisibleLineBottom)));
}

function collectTextLineBottoms(root: HTMLElement): number[] {
  const rootTop = root.getBoundingClientRect().top;
  const lineBottoms: number[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);

  while (walker.nextNode()) {
    const node = walker.currentNode;
    if (!node.textContent?.trim()) continue;

    const range = document.createRange();
    range.selectNodeContents(node);
    for (const rect of Array.from(range.getClientRects())) {
      const bottom = rect.bottom - rootTop;
      if (rect.height > 0 && bottom > 0) {
        lineBottoms.push(bottom);
      }
    }
    range.detach();
  }

  return lineBottoms.sort((a, b) => a - b);
}

function getSafeCollapsedUserBubbleHeight(root: HTMLElement): number {
  return resolveSafeCollapsedBubbleHeight(collectTextLineBottoms(root));
}

export function HighlightedCodePreview({ code, language }: { code: string; language?: string }) {
  return (
    <Suspense
      fallback={
        <pre className="code-preview-content">
          <code>{code}</code>
        </pre>
      }
    >
      <LazyHighlightedCodePreview code={code} language={language} />
    </Suspense>
  );
}

export function normalizeQuotedAssistantMarkdownPreview(
  message: string,
  maxChars?: number,
): string {
  const normalized = message
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (typeof maxChars !== "number") return normalized;
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function summarizeQuotedAssistantMessage(
  message: string,
  maxChars = MAX_QUOTED_ASSISTANT_PREVIEW_CHARS,
): string {
  const collapsed = message.replace(/\s+/g, " ").trim();
  if (collapsed.length <= maxChars) return collapsed;
  return `${collapsed.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

export function createQuotedAssistantMessage(
  message: string,
  eventId?: string,
  taskId?: string,
): QuotedAssistantMessage | null {
  const cleaned = cleanAssistantMessageForDisplay(message).trim();
  if (!cleaned) return null;
  const truncated = cleaned.length > MAX_QUOTED_ASSISTANT_MESSAGE_CHARS;
  return {
    ...(eventId ? { eventId } : {}),
    ...(taskId ? { taskId } : {}),
    message: truncated
      ? `${cleaned.slice(0, MAX_QUOTED_ASSISTANT_MESSAGE_CHARS - 1).trimEnd()}…`
      : cleaned,
    ...(truncated ? { truncated: true } : {}),
  };
}

export function isLastAssistantMessageEvent(
  event: { id?: TaskEvent["id"] },
  lastAssistantMessage?: { id?: TaskEvent["id"] } | null,
): boolean {
  return Boolean(event.id && lastAssistantMessage?.id === event.id);
}

// Copy button for user and assistant messages
export const MessageCopyButton = memo(function MessageCopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(toPlainAnswerText(text));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error("Failed to copy:", err);
    }
  };

  const label = copied ? "Copied" : "Copy message";
  return (
    <button
      type="button"
      className={`message-action-btn message-copy-btn ${copied ? "copied" : ""}`}
      onClick={handleCopy}
      title={label}
      aria-label={label}
    >
      {copied ? (
        <Check size={15} strokeWidth={2} aria-hidden="true" />
      ) : (
        <Copy size={15} strokeWidth={1.75} aria-hidden="true" />
      )}
    </button>
  );
});

export const MessageQuoteButton = memo(function MessageQuoteButton({
  onQuote,
}: {
  onQuote: () => void;
}) {
  return (
    <button
      type="button"
      className="message-action-btn message-quote-btn"
      onClick={onQuote}
      title="Quote this message"
      aria-label="Quote this message"
    >
      <Quote size={15} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
});

export const MessageForkButton = memo(function MessageForkButton({
  onFork,
}: {
  onFork: () => void;
}) {
  return (
    <button
      type="button"
      className="message-action-btn message-fork-btn"
      onClick={onFork}
      title="Fork from this message"
      aria-label="Fork from this message"
    >
      <GitFork size={15} strokeWidth={1.75} aria-hidden="true" />
    </button>
  );
});

// Collapsible user message bubble - limits height and expands on click
export function CollapsibleUserBubble({ children }: { children: React.ReactNode }) {
  const [expanded, setExpanded] = useState(false);
  const [needsCollapse, setNeedsCollapse] = useState(false);
  const [collapsedHeight, setCollapsedHeight] = useState(COLLAPSED_USER_BUBBLE_MAX_HEIGHT);
  const contentRef = useRef<HTMLDivElement>(null);

  const measure = useCallback(() => {
    const node = contentRef.current;
    if (!node) return;

    const shouldCollapse = node.scrollHeight > COLLAPSED_USER_BUBBLE_MAX_HEIGHT;
    setNeedsCollapse(shouldCollapse);
    setCollapsedHeight(
      shouldCollapse ? getSafeCollapsedUserBubbleHeight(node) : COLLAPSED_USER_BUBBLE_MAX_HEIGHT,
    );
  }, []);

  useLayoutEffect(() => {
    measure();

    const node = contentRef.current;
    if (!node) return undefined;

    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }

    const observer = new ResizeObserver(() => measure());
    observer.observe(node);
    return () => observer.disconnect();
  }, [children, measure]);

  const collapsed = needsCollapse && !expanded;

  return (
    <>
      <div
        ref={contentRef}
        className={`chat-bubble user-bubble markdown-content${!collapsed ? " expanded" : ""}`}
        style={collapsed ? { maxHeight: `${collapsedHeight}px` } : undefined}
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

export function stopCurrentAudio() {
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
export const MessageSpeakButton = memo(function MessageSpeakButton({
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
      // Strip markdown for cleaner speech; interactive answer blocks are read as text.
      const cleanText = toPlainAnswerText(text)
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

  const label = speaking ? "Stop speaking" : loading ? "Loading…" : "Read aloud";
  return (
    <button
      type="button"
      className={`message-action-btn message-speak-btn ${speaking ? "speaking" : ""}`}
      onClick={handleClick}
      title={label}
      aria-label={label}
      disabled={loading}
    >
      {speaking ? (
        <Square size={13} strokeWidth={2} fill="currentColor" aria-hidden="true" />
      ) : loading ? (
        <LoaderCircle size={15} strokeWidth={1.75} className="spin" aria-hidden="true" />
      ) : (
        <Volume2 size={15} strokeWidth={1.75} aria-hidden="true" />
      )}
    </button>
  );
});

export const normalizeCommitmentText = (value: unknown): string | null => {
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

export function UserMessageText({
  text,
  integrationMentions,
  markdownComponents,
}: {
  text: string;
  integrationMentions?: IntegrationMentionSelection[];
  markdownComponents: Components;
}) {
  if (hasRenderableIntegrationMentions(text, integrationMentions)) {
    return <IntegrationMentionText text={text} mentions={integrationMentions} />;
  }

  return (
    <DeferredMarkdown withBreaks components={markdownComponents}>
      {text}
    </DeferredMarkdown>
  );
}

export function getIntegrationMentionsSignature(mentions?: IntegrationMentionSelection[]): string {
  return (
    mentions?.map((mention) => `${mention.id}:${mention.label}:${mention.iconKey}`).join("|") ?? ""
  );
}
