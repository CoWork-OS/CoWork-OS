import type { ChannelMessage, ChannelUser } from '../database/repositories';

export interface ChatTranscriptOptions {
  lookupUser?: (userId: string) => ChannelUser | undefined;
  agentName?: string;
  sinceMs?: number;
  untilMs?: number;
  /** Include CoWork OS responses that were sent back into the chat (direction=outgoing). Default: true. */
  includeOutgoing?: boolean;
  /**
   * Include messages sent by the local user account when the channel supports capturing them
   * (direction=outgoing_user). Default: true.
   */
  includeUserOutgoing?: boolean;
  dropCommands?: boolean;
  maxMessages?: number;
  maxChars?: number;
  maxMessageChars?: number;
}

export interface ChatTranscriptResult {
  transcript: string;
  usedCount: number;
  truncated: boolean;
}

const DEFAULT_MAX_MESSAGES = 120;
const DEFAULT_MAX_CHARS = 30_000;
const DEFAULT_MAX_MESSAGE_CHARS = 500;

export function formatChatTranscriptForPrompt(
  messages: ChannelMessage[],
  opts?: ChatTranscriptOptions
): ChatTranscriptResult {
  const lookupUser = opts?.lookupUser;
  const agentName = opts?.agentName || 'Assistant';
  const sinceMs = Number.isFinite(opts?.sinceMs) ? opts!.sinceMs : undefined;
  const untilMs = Number.isFinite(opts?.untilMs) ? opts!.untilMs : undefined;
  const includeOutgoing = opts?.includeOutgoing !== false;
  const includeUserOutgoing = opts?.includeUserOutgoing !== false;
  const dropCommands = opts?.dropCommands !== false;
  const maxMessages = Math.max(1, Math.floor(opts?.maxMessages ?? DEFAULT_MAX_MESSAGES));
  const maxChars = Math.max(256, Math.floor(opts?.maxChars ?? DEFAULT_MAX_CHARS));
  const maxMessageChars = Math.max(64, Math.floor(opts?.maxMessageChars ?? DEFAULT_MAX_MESSAGE_CHARS));

  const candidates = (Array.isArray(messages) ? messages : []).filter((m) => {
    if (!m || typeof m.content !== 'string') return false;
    const content = m.content.trim();
    if (!content) return false;
    if (!includeOutgoing && m.direction === 'outgoing') return false;
    if (!includeUserOutgoing && m.direction === 'outgoing_user') return false;
    if (dropCommands && content.startsWith('/')) return false;
    if (sinceMs !== undefined && Number.isFinite(m.timestamp) && m.timestamp < sinceMs) return false;
    if (untilMs !== undefined && Number.isFinite(m.timestamp) && m.timestamp > untilMs) return false;
    return true;
  });

  // Prefer keeping the most recent messages (chronological order assumed).
  let truncated = false;
  const trimmed = candidates.length > maxMessages ? (truncated = true, candidates.slice(-maxMessages)) : candidates;

  const formatStamp = (ts: number): string => {
    try {
      const iso = new Date(ts).toISOString(); // 2026-02-08T12:34:56.789Z
      return `${iso.slice(0, 16).replace('T', ' ')}Z`; // 2026-02-08 12:34Z
    } catch {
      return 'unknown';
    }
  };

  const formatSpeaker = (m: ChannelMessage): string => {
    if (m.direction === 'outgoing') return agentName;
    if (m.direction === 'outgoing_user') {
      const userId = typeof m.userId === 'string' ? m.userId : '';
      if (userId && lookupUser) {
        const user = lookupUser(userId);
        if (user?.displayName) return user.displayName;
        if (user?.username) return user.username;
      }
      return 'Me';
    }
    const userId = typeof m.userId === 'string' ? m.userId : '';
    if (userId && lookupUser) {
      const user = lookupUser(userId);
      if (user?.displayName) return user.displayName;
      if (user?.username) return user.username;
    }
    return 'User';
  };

  const summarizeAttachments = (m: ChannelMessage): string => {
    const atts = Array.isArray(m.attachments) ? m.attachments : [];
    if (atts.length === 0) return '';
    const parts = atts
      .map((a) => {
        const t = typeof a?.type === 'string' ? a.type.trim() : '';
        const f = typeof a?.fileName === 'string' ? a.fileName.trim() : '';
        if (!t && !f) return null;
        return f ? `${t || 'file'}:${f}` : t;
      })
      .filter((p): p is string => typeof p === 'string' && p.length > 0);
    if (parts.length === 0) return '';
    return ` [attachments: ${parts.slice(0, 6).join(', ')}${parts.length > 6 ? ', ...' : ''}]`;
  };

  const toLine = (m: ChannelMessage): string => {
    const content = m.content.replace(/\s+/g, ' ').trim();
    const clipped = content.length > maxMessageChars ? `${content.slice(0, maxMessageChars - 3)}...` : content;
    const stamp = formatStamp(m.timestamp);
    const speaker = formatSpeaker(m);
    return `[${stamp}] ${speaker}: ${clipped}${summarizeAttachments(m)}`;
  };

  // Enforce maxChars by filling from the end (most recent) then reversing.
  const lines: string[] = [];
  let usedChars = 0;
  for (let i = trimmed.length - 1; i >= 0; i--) {
    const line = toLine(trimmed[i]);
    const nextChars = line.length + 1;
    if (usedChars + nextChars > maxChars) {
      truncated = true;
      if (lines.length === 0) {
        // Still include at least one line, clipped to fit.
        const allowed = Math.max(32, maxChars - 4);
        lines.push(`${line.slice(0, allowed)}...`);
      }
      break;
    }
    lines.push(line);
    usedChars += nextChars;
  }
  lines.reverse();

  return {
    transcript: lines.join('\n'),
    usedCount: lines.length,
    truncated,
  };
}
