import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { ArrowUp } from "lucide-react";
import type { QuotedAssistantMessage } from "../../../shared/types";
import { createSelectionQuote, getSelectionReplySource } from "./selection-reply";

const POPOVER_WIDTH = 360;
const POPOVER_GAP = 8;
const HIGHLIGHT_NAME = "cowork-reply-quote";

interface SelectionReplyState {
  range: Range;
  quote: QuotedAssistantMessage;
}

interface PopoverPosition {
  top: number;
  left: number;
  placement: "below" | "above";
}

function computePosition(rect: DOMRect): PopoverPosition {
  const viewportWidth = window.innerWidth;
  const viewportHeight = window.innerHeight;
  const left = Math.min(
    Math.max(12, rect.left + rect.width / 2 - POPOVER_WIDTH / 2),
    viewportWidth - POPOVER_WIDTH - 12,
  );
  const spaceBelow = viewportHeight - rect.bottom;
  return spaceBelow > 180
    ? { top: rect.bottom + POPOVER_GAP, left, placement: "below" }
    : { top: rect.top - POPOVER_GAP, left, placement: "above" };
}

interface SelectionReplyPopoverProps {
  /** Scroll container holding the conversation; selections outside it are ignored. */
  containerRef: React.RefObject<HTMLElement | null>;
  agentName: string;
  /** Sends the reply with its quote. Resolves false when the message was not accepted. */
  onReply: (reply: string, quote: QuotedAssistantMessage) => Promise<boolean>;
}

/**
 * Select text in an assistant message to reply to it: a small popover shows the quoted text
 * with a reply field, and sending posts a follow-up that carries the quote.
 */
export function SelectionReplyPopover({
  containerRef,
  agentName,
  onReply,
}: SelectionReplyPopoverProps) {
  const [state, setState] = useState<SelectionReplyState | null>(null);
  const [position, setPosition] = useState<PopoverPosition | null>(null);
  const [reply, setReply] = useState("");
  const [isSending, setIsSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const close = useCallback(() => {
    setState(null);
    setPosition(null);
    setReply("");
    setError(null);
  }, []);

  // Open on a finished selection inside an assistant message.
  useEffect(() => {
    const handleSelectionEnd = (event: Event) => {
      if (popoverRef.current?.contains(event.target as Node)) return;
      const container = containerRef.current;
      if (!container) return;
      // Let the browser settle the selection before reading it.
      window.setTimeout(() => {
        const found = getSelectionReplySource(window.getSelection(), container);
        if (!found) return;
        setState({ range: found.range, quote: createSelectionQuote(found.text, found.source) });
        setReply("");
        setError(null);
      }, 0);
    };
    document.addEventListener("mouseup", handleSelectionEnd);
    document.addEventListener("keyup", handleSelectionEnd);
    return () => {
      document.removeEventListener("mouseup", handleSelectionEnd);
      document.removeEventListener("keyup", handleSelectionEnd);
    };
  }, [containerRef]);

  // Close on a click elsewhere, or when the selection is cleared outside the popover.
  useEffect(() => {
    if (!state) return;
    const handlePointerDown = (event: PointerEvent) => {
      if (popoverRef.current?.contains(event.target as Node)) return;
      close();
    };
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", handlePointerDown, true);
    document.addEventListener("keydown", handleKeyDown);
    return () => {
      document.removeEventListener("pointerdown", handlePointerDown, true);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [close, state]);

  // Keep the quoted text highlighted after focus moves into the reply field, which clears the
  // document selection.
  useEffect(() => {
    if (!state || typeof CSS === "undefined" || !("highlights" in CSS)) return;
    const highlights = (CSS as unknown as { highlights: Map<string, unknown> }).highlights;
    const HighlightCtor = (window as unknown as { Highlight?: new (range: Range) => unknown })
      .Highlight;
    if (!HighlightCtor) return;
    highlights.set(HIGHLIGHT_NAME, new HighlightCtor(state.range));
    return () => {
      highlights.delete(HIGHLIGHT_NAME);
    };
  }, [state]);

  // Follow the selection while the conversation scrolls or the window resizes.
  useLayoutEffect(() => {
    if (!state) return;
    const update = () => {
      const rect = state.range.getBoundingClientRect();
      const container = containerRef.current?.getBoundingClientRect();
      // Hide while the quoted text is scrolled out of view (or its row was virtualized away).
      const detached = rect.width === 0 && rect.height === 0;
      const scrolledOut =
        container !== undefined && (rect.bottom < container.top || rect.top > container.bottom);
      setPosition(detached || scrolledOut ? null : computePosition(rect));
    };
    update();
    const container = containerRef.current;
    container?.addEventListener("scroll", update, { passive: true });
    window.addEventListener("resize", update);
    return () => {
      container?.removeEventListener("scroll", update);
      window.removeEventListener("resize", update);
    };
  }, [containerRef, state]);

  const submit = useCallback(async () => {
    if (!state || isSending) return;
    const text = reply.trim();
    if (!text) return;
    setIsSending(true);
    setError(null);
    try {
      const accepted = await onReply(text, state.quote);
      if (accepted) {
        window.getSelection()?.removeAllRanges();
        close();
      } else {
        setError("Couldn't send the reply. Try again.");
      }
    } catch {
      setError("Couldn't send the reply. Try again.");
    } finally {
      setIsSending(false);
    }
  }, [close, isSending, onReply, reply, state]);

  if (!state || !position) return null;
  return createPortal(
    <div
      ref={popoverRef}
      className={`selection-reply-popover placement-${position.placement}`}
      style={{ top: position.top, left: position.left, width: POPOVER_WIDTH }}
      role="dialog"
      aria-label={`Reply to ${agentName} about the selected text`}
    >
      <blockquote className="selection-reply-quote" title={state.quote.message}>
        {state.quote.message}
      </blockquote>
      <div className="selection-reply-field">
        <textarea
          ref={inputRef}
          className="selection-reply-input"
          rows={1}
          value={reply}
          placeholder={`Reply to ${agentName}`}
          aria-label={`Reply to ${agentName}`}
          disabled={isSending}
          onChange={(event) => setReply(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              void submit();
            }
          }}
        />
        <button
          type="button"
          className="selection-reply-send"
          onClick={() => void submit()}
          disabled={isSending || reply.trim().length === 0}
          aria-label="Send reply"
          title="Send reply"
        >
          <ArrowUp size={14} strokeWidth={2.2} aria-hidden="true" />
        </button>
      </div>
      {error ? <div className="selection-reply-error">{error}</div> : null}
    </div>,
    document.body,
  );
}
