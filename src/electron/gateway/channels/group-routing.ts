/**
 * Group message routing shared by the Slack and Discord adapters (Telegram and WhatsApp
 * keep their own copies of the same policy).
 */

import type { EventGateMode } from "../../../shared/types";

export type GroupRoutingMode = "all" | "mentionsOnly" | "mentionsOrCommands" | "commandsOnly";

const MODES: readonly GroupRoutingMode[] = [
  "all",
  "mentionsOnly",
  "mentionsOrCommands",
  "commandsOnly",
];

/** The configured mode, or mention-only when none (or an unknown one) is set. */
export function resolveGroupRoutingMode(value: unknown): GroupRoutingMode {
  return typeof value === "string" && (MODES as readonly string[]).includes(value)
    ? (value as GroupRoutingMode)
    : "mentionsOnly";
}

/** Whether a group message is addressed to the agent under the channel's routing mode. */
export function shouldRouteGroupMessage(
  mode: GroupRoutingMode,
  signals: { isMentioned: boolean; isReplyToBot?: boolean; isCommand: boolean },
): boolean {
  const addressed = signals.isMentioned || signals.isReplyToBot === true;
  switch (mode) {
    case "all":
      return true;
    case "commandsOnly":
      return signals.isCommand;
    case "mentionsOrCommands":
      return addressed || signals.isCommand;
    case "mentionsOnly":
    default:
      return addressed;
  }
}

/**
 * A group message that is not addressed to the agent is dropped, except that it is passed
 * on as ingest-only (stored, never answered) when something downstream may use it: it is
 * a reply inside an existing thread (a task may be subscribed to that thread), the channel
 * is in ambient mode, or its chat is a semantic-gate candidate.
 */
export function shouldIngestUnroutedGroupMessage(params: {
  inExistingThread: boolean;
  ambientMode: boolean;
  chatGateMode: EventGateMode;
}): boolean {
  return params.inExistingThread || params.ambientMode || params.chatGateMode === "candidate";
}

/**
 * Slack thread identity. In a channel every top-level message starts a potential thread
 * (the agent answers in it), so its own ts names the thread and later replies (whose
 * `thread_ts` is that ts) land in the same session. In a DM only real thread replies
 * form a thread, so the DM stays one conversation.
 */
export function slackThreadId(
  message: { ts?: unknown; thread_ts?: unknown },
  isDirect: boolean,
): string | undefined {
  const threadTs = typeof message.thread_ts === "string" ? message.thread_ts.trim() : "";
  if (threadTs) return threadTs;
  if (isDirect) return undefined;
  const ts = typeof message.ts === "string" ? message.ts.trim() : "";
  return ts || undefined;
}
