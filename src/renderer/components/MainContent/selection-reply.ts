import type { QuotedAssistantMessage } from "../../../shared/types";

/** Elements whose text can be selected and replied to; carries the quote's source event. */
export const REPLY_SOURCE_SELECTOR = "[data-reply-source]";
const MAX_QUOTE_CHARS = 2000;

/**
 * Returns the reply source shared by both ends of the current selection, or null when the
 * selection is empty or spans more than one message.
 */
export function getSelectionReplySource(
  selection: Selection | null,
  container: HTMLElement,
): { range: Range; text: string; source: HTMLElement } | null {
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) return null;
  const text = selection.toString().replace(/\s+\n/g, "\n").trim();
  if (!text) return null;
  const range = selection.getRangeAt(0);
  const elementOf = (node: Node | null): Element | null =>
    node?.nodeType === 1 ? (node as Element) : (node?.parentElement ?? null);
  const startSource = elementOf(range.startContainer)?.closest<HTMLElement>(REPLY_SOURCE_SELECTOR);
  const endSource = elementOf(range.endContainer)?.closest<HTMLElement>(REPLY_SOURCE_SELECTOR);
  if (!startSource || startSource !== endSource || !container.contains(startSource)) return null;
  return { range: range.cloneRange(), text, source: startSource };
}

export function createSelectionQuote(text: string, source: HTMLElement): QuotedAssistantMessage {
  const truncated = text.length > MAX_QUOTE_CHARS;
  const eventId = source.dataset.replyEventId;
  const taskId = source.dataset.replyTaskId;
  return {
    ...(eventId ? { eventId } : {}),
    ...(taskId ? { taskId } : {}),
    message: truncated ? `${text.slice(0, MAX_QUOTE_CHARS - 1).trimEnd()}…` : text,
    ...(truncated ? { truncated: true } : {}),
  };
}
