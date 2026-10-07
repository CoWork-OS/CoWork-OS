import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { LoaderCircle } from "lucide-react";
import { isTempWorkspaceId, type Task } from "../../../shared/types";
import type { BotMascotId } from "../../../shared/bot-mascots";
import {
  BOT_MESSAGE_PAGE_DEFAULT_LIMIT,
  type BotMessage,
  type BotMessageCursor,
} from "../../../shared/bot-messages";
import { BotGlyph } from "../BotGlyph";
import { BotMascot } from "../bot-mascot/BotMascot";
import { MessageCopyButton } from "./message-ui";
import { cleanAssistantMessageForDisplay } from "./markdown-normalization";
import { normalizeInitialPromptText } from "./task-event-presentation";
import { formatBotHistoryDay, type BotMascotLookup } from "./bot-earlier-conversations";

interface ScrollAnchor {
  markerTop: number;
}

export interface BotEarlierConversationsProps {
  currentTask: Task;
  botName: string;
  botMascot: BotMascotId | null;
  /** The transcript's scroll container. */
  scrollContainerRef: RefObject<HTMLDivElement | null>;
  /** Load the newest page once, while the chat is still hidden on open. */
  loadInitialPage: boolean;
  /** Called once that first page (or the decision not to load one) has rendered. */
  onInitialPageDone?: () => void;
  /** The reader has scrolled up and the current conversation has nothing older to load. */
  canLoadMore: boolean;
  /** When the first message shown below this section was sent, if there is one. */
  currentFirstMessageAt: number | null;
  renderMarkdown: (text: string) => ReactNode;
  /** Characters for teammates whose messages were relayed into this chat. */
  mascotForSender?: BotMascotLookup;
}

/**
 * The bot's messages from conversations before the current one, read from the
 * database a page at a time as the user scrolls up. Together with the live
 * transcript below they read as one continuous thread.
 */
export function BotEarlierConversations({
  currentTask,
  botName,
  botMascot,
  scrollContainerRef,
  loadInitialPage,
  onInitialPageDone,
  canLoadMore,
  currentFirstMessageAt,
  renderMarkdown,
  mascotForSender,
}: BotEarlierConversationsProps) {
  const [messages, setMessages] = useState<BotMessage[]>([]);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sentinelVisible, setSentinelVisible] = useState(false);
  const [initialDone, setInitialDone] = useState(false);
  const initialRequestedRef = useRef(false);
  const cursorRef = useRef<BotMessageCursor | null>(null);
  const loadingRef = useRef(false);
  const mountedRef = useRef(true);
  const anchorRef = useRef<ScrollAnchor | null>(null);
  const sentinelRef = useRef<HTMLDivElement | null>(null);
  const endMarkerRef = useRef<HTMLDivElement | null>(null);
  const agentRoleId = currentTask.assignedAgentRoleId;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  const captureAnchor = useCallback(() => {
    const container = scrollContainerRef.current;
    const marker = endMarkerRef.current;
    if (!container || !marker) return;
    anchorRef.current = { markerTop: marker.getBoundingClientRect().top };
  }, [scrollContainerRef]);

  // Keep what the user was reading in place when older messages arrive above it.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    const container = scrollContainerRef.current;
    const marker = endMarkerRef.current;
    anchorRef.current = null;
    if (!anchor || !container || !marker) return;
    const shift = marker.getBoundingClientRect().top - anchor.markerTop;
    if (shift !== 0) container.scrollTop += shift;
  }, [messages, scrollContainerRef]);

  const loadMore = useCallback(
    async (options?: { keepPosition?: boolean }) => {
      const api = window.electronAPI;
      if (loadingRef.current) return;
      if (!agentRoleId || !api?.listBotMessages) {
        setHasMore(false);
        return;
      }
      loadingRef.current = true;
      setLoading(true);
      setError(null);
      try {
        const page = await api.listBotMessages({
          workspaceId: currentTask.workspaceId,
          includeAllWorkspaces: isTempWorkspaceId(currentTask.workspaceId),
          agentRoleId,
          beforeConversationId: currentTask.id,
          cursor: cursorRef.current,
          limit: BOT_MESSAGE_PAGE_DEFAULT_LIMIT,
        });
        if (!mountedRef.current) return;
        cursorRef.current = page.nextCursor;
        if (page.messages.length > 0) {
          if (options?.keepPosition) captureAnchor();
          setMessages((previous) => {
            const known = new Set(previous.map((message) => message.id));
            return [...page.messages.filter((message) => !known.has(message.id)), ...previous];
          });
        }
        setHasMore(page.hasMore && page.nextCursor !== null);
      } catch (cause) {
        if (mountedRef.current) {
          setError(cause instanceof Error ? cause.message : "Could not load earlier messages.");
        }
      } finally {
        loadingRef.current = false;
        if (mountedRef.current) setLoading(false);
      }
    },
    [agentRoleId, captureAnchor, currentTask.id, currentTask.workspaceId],
  );

  useEffect(() => {
    const sentinel = sentinelRef.current;
    const root = scrollContainerRef.current;
    if (!sentinel || !root || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => setSentinelVisible(Boolean(entry?.isIntersecting)),
      // Start fetching a little before the top is reached.
      { root, rootMargin: "400px 0px 0px 0px" },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [scrollContainerRef]);

  // The newest page loads while the chat is still hidden; the host then reveals it at the bottom.
  useEffect(() => {
    if (!loadInitialPage || initialRequestedRef.current) return;
    initialRequestedRef.current = true;
    void loadMore().finally(() => {
      if (!mountedRef.current) return;
      setInitialDone(true);
      onInitialPageDone?.();
    });
  }, [loadInitialPage, loadMore, onInitialPageDone]);

  // After that, older pages load only as the reader scrolls up to them. A long conversation
  // skips the hidden first page, so its first earlier page loads here too.
  useEffect(() => {
    if (!canLoadMore || !sentinelVisible || !hasMore || loading || error) return;
    if (initialRequestedRef.current && !initialDone) return;
    initialRequestedRef.current = true;
    void loadMore({ keepPosition: true }).finally(() => {
      if (mountedRef.current) setInitialDone(true);
    });
  }, [canLoadMore, error, hasMore, initialDone, loadMore, loading, sentinelVisible]);

  const rows: ReactNode[] = [];
  let previousDay = "";
  for (const message of messages) {
    const day = formatBotHistoryDay(message.timestamp);
    if (day !== previousDay) {
      rows.push(<BotHistoryDayDivider key={`day:${message.id}`} label={day} />);
      previousDay = day;
    }
    const relayedBy =
      message.role === "teammate" || (message.senderLabel && message.senderLabel !== botName)
        ? message.senderLabel
        : undefined;
    rows.push(
      <BotHistoryMessageRow
        key={message.id}
        message={message}
        relayedBy={relayedBy}
        senderMascot={relayedBy ? (mascotForSender?.(relayedBy) ?? null) : null}
        renderMarkdown={renderMarkdown}
      />,
    );
  }
  const currentDay =
    currentFirstMessageAt !== null ? formatBotHistoryDay(currentFirstMessageAt) : "";
  const showStart = initialDone && !hasMore && !loading && !error;

  return (
    <section className="bot-history" aria-label={`Earlier messages with ${botName}`}>
      <div ref={sentinelRef} className="bot-history-sentinel" aria-hidden="true" />
      {showStart && (
        <div className="bot-history-start">
          <span className="bot-history-start-avatar" aria-hidden="true">
            {botMascot ? <BotMascot mascot={botMascot} size={56} /> : <BotGlyph size={28} />}
          </span>
          <strong>{botName}</strong>
          <span>This is the start of your conversation.</span>
        </div>
      )}
      {loading && (
        <div className="bot-history-status" role="status">
          <LoaderCircle size={14} className="spinning" aria-hidden="true" />
          <span>Loading earlier messages…</span>
        </div>
      )}
      {error && (
        <div className="bot-history-status" role="alert">
          <span>Couldn’t load earlier messages.</span>
          <button type="button" onClick={() => setError(null)}>
            Retry
          </button>
        </div>
      )}
      {rows}
      {currentDay && messages.length > 0 && currentDay !== previousDay && (
        <BotHistoryDayDivider label={currentDay} />
      )}
      <div ref={endMarkerRef} aria-hidden="true" />
    </section>
  );
}

function BotHistoryDayDivider({ label }: { label: string }) {
  return (
    <div className="bot-history-day" role="separator" aria-label={label}>
      <span>{label}</span>
    </div>
  );
}

function BotHistoryMessageRow({
  message,
  relayedBy,
  senderMascot,
  renderMarkdown,
}: {
  message: BotMessage;
  relayedBy?: string;
  senderMascot: BotMascotId | null;
  renderMarkdown: (text: string) => ReactNode;
}) {
  if (message.role === "user") {
    const text = normalizeInitialPromptText(message.text);
    return (
      <div className="chat-message user-message">
        <div className="chat-bubble user-bubble">
          <div className="markdown-content">{renderMarkdown(text)}</div>
        </div>
        <MessageCopyButton text={text} />
      </div>
    );
  }
  const text =
    message.role === "teammate"
      ? normalizeInitialPromptText(message.text)
      : cleanAssistantMessageForDisplay(message.text);
  return (
    <div className="chat-message assistant-message">
      <div className="chat-bubble assistant-bubble">
        {relayedBy && (
          <div className="bot-message-attribution">
            <BotMessageAvatar mascot={senderMascot} />
            <span>{relayedBy}</span>
          </div>
        )}
        <div className="chat-bubble-content markdown-content">{renderMarkdown(text)}</div>
      </div>
      <div className="message-actions">
        <MessageCopyButton text={text} />
      </div>
    </div>
  );
}

export function BotMessageAvatar({
  mascot,
  animated = false,
}: {
  mascot: BotMascotId | null;
  animated?: boolean;
}) {
  return (
    <span
      className={`bot-message-attribution-avatar${mascot ? " bot-message-attribution-avatar-mascot" : ""}`}
      aria-hidden="true"
    >
      {mascot ? (
        <BotMascot mascot={mascot} size={20} animated={animated} />
      ) : (
        <BotGlyph size={12} />
      )}
    </span>
  );
}
