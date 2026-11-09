import type { TaskEvent } from "../../../shared/types";
import { formatAgentMessageProtocolForDisplay } from "../../utils/agent-message-receipt";
import { getEffectiveTaskEventType } from "../../utils/task-event-compat";
import {
  getAssistantOrCompletionText,
  getUserEventDisplayMessage,
} from "./task-event-presentation";

/**
 * The visible conversation of a session as Markdown: each user message and the assistant's
 * replies to it. A turn can record the same reply more than once (an assistant message and its
 * completion summary, or a retried message), so repeats within a turn are kept once. Internal
 * assistant messages are left out, as in the feed.
 */
export function buildTaskTranscriptMarkdown(
  events: readonly TaskEvent[],
  fallbackPrompt: string,
  assistantName: string,
): string {
  const turns: string[] = [];
  const prompt = fallbackPrompt.trim();
  let sawUserMessage = false;
  let turnReplies = new Set<string>();
  // The feed draws the opening prompt from the task, so its message event may be missing.
  const openWithPrompt = () => {
    if (!sawUserMessage && prompt) turns.push(`### You\n\n${prompt}`);
    sawUserMessage = true;
  };

  for (const event of events) {
    const type = getEffectiveTaskEventType(event);
    if (type === "user_message") {
      const text = getUserEventDisplayMessage(event);
      if (!text) continue;
      turns.push(`### You\n\n${text}`);
      sawUserMessage = true;
      turnReplies = new Set();
      continue;
    }
    const isReply =
      (type === "assistant_message" && event.payload?.internal !== true) ||
      type === "task_completed";
    if (!isReply) continue;
    const text = formatAgentMessageProtocolForDisplay(getAssistantOrCompletionText(event)).trim();
    if (!text || turnReplies.has(text)) continue;
    openWithPrompt();
    turnReplies.add(text);
    turns.push(`### ${assistantName}\n\n${text}`);
  }

  openWithPrompt();
  return turns.join("\n\n---\n\n");
}
