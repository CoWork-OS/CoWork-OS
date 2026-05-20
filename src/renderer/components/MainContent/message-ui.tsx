import {
  memo,
  useState,
  useRef,
  useCallback,
  lazy,
  Suspense,
  useLayoutEffect,
} from "react";
import type { QuotedAssistantMessage, IntegrationMentionSelection } from "../../../shared/types";
import {
  COLLAPSED_USER_BUBBLE_MAX_HEIGHT,
  COLLAPSED_USER_BUBBLE_MIN_HEIGHT,
  MAX_QUOTED_ASSISTANT_MESSAGE_CHARS,
  MAX_QUOTED_ASSISTANT_PREVIEW_CHARS,
} from "./main-content-constants";
import { cleanAssistantMessageForDisplay } from "./markdown-normalization";
import {
  IntegrationMentionText,
  hasRenderableIntegrationMentions,
} from "../IntegrationMentionText";

const LazyMarkdownRenderer = lazy(() =>
  import("../MarkdownRenderer").then((module) => ({ default: module.MarkdownRenderer })),
);
const LazyHighlightedCodePreview = lazy(() =>
  import("../HighlightedCode").then((module) => ({ default: module.HighlightedCodePreview })),
);

export function DeferredMarkdown({
  children,
  components,
  withBreaks = false,
}: {
  children: string;
  components?: unknown;
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

export function summarizeQuotedAssistantMessage(message: string, maxChars = MAX_QUOTED_ASSISTANT_PREVIEW_CHARS): string {
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

// Copy button for user messages
export const MessageCopyButton = memo(function MessageCopyButton({ text }: { text: string }) {
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

export const MessageQuoteButton = memo(function MessageQuoteButton({
  onQuote,
}: {
  onQuote: () => void;
}) {
  return (
    <button type="button" className="message-quote-btn" onClick={onQuote} title="Quote this message">
      <svg
        width="12"
        height="12"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M10 8L6 12l4 4" />
        <path d="M6 12h9a5 5 0 0 1 5 5v0" />
      </svg>
      <span>Quote</span>
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
  markdownComponents: Any;
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
  return mentions?.map((mention) => `${mention.id}:${mention.label}:${mention.iconKey}`).join("|") ?? "";
}
