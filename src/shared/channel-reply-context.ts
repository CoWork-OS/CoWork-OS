/**
 * The quote a channel puts in front of a reply, so the agent sees which message it answers.
 *
 * WhatsApp sends the quoted message with the reply; the adapter writes it as a header line and
 * the quoted text with every line prefixed "> ", then a blank line and what the sender typed.
 * The quoted text is someone else's message or the agent's own earlier reply, not the sender's
 * words, so the admin-lane tools (tool-policy-engine.ts, userText) must not read it.
 */

export const CHANNEL_REPLY_CONTEXT_PREFIX = "💬 In reply to ";
const QUOTED_LINE_PREFIX = "> ";

/** The quote block for a reply to `body` from `quotedFrom`, or undefined with no body. */
export function formatChannelReplyContext(quotedFrom: string, body: string): string | undefined {
  const rawBody = String(body || "").trim();
  if (!rawBody) return undefined;
  // One header line: a line break in the name would leave the rest of it outside the quote.
  const from =
    String(quotedFrom || "")
      .replace(/\s+/g, " ")
      .trim() || "a previous message";
  return `${CHANNEL_REPLY_CONTEXT_PREFIX}${from}\n${QUOTED_LINE_PREFIX}${rawBody.replace(
    /\n/g,
    `\n${QUOTED_LINE_PREFIX}`,
  )}`;
}

/**
 * An email body with its quoted history marked as a reply quote. A mail client quotes the
 * message being answered as `> ` lines, usually under an "On … wrote:" line; that attribution
 * becomes the quote's header (one is added where it is missing), so the quoted lines are left
 * out of the sender's words like a WhatsApp quote. Lines typed between quotes are kept.
 */
export function markEmailReplyQuotes(text: string): string {
  const lines = String(text || "").split("\n");
  const out: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const nextQuoted = lines[i + 1]?.startsWith(">") === true;
    if (nextQuoted && /^\s*On\b.*\bwrote:\s*$/i.test(line)) {
      out.push(`${CHANNEL_REPLY_CONTEXT_PREFIX}${line.replace(/\s+/g, " ").trim()}`);
      continue;
    }
    if (line.startsWith(">") && !(out.at(-1) ?? "").startsWith(">")) {
      const previous = out.at(-1) ?? "";
      if (!previous.startsWith(CHANNEL_REPLY_CONTEXT_PREFIX)) {
        out.push(`${CHANNEL_REPLY_CONTEXT_PREFIX}a previous message`);
      }
    }
    out.push(line);
  }
  return out.join("\n");
}

/**
 * `text` without its reply quote blocks: each header line and the quoted lines after it. Every
 * line of a quoted message starts with ">", so its text cannot end the block early; what the
 * sender typed follows a blank line and is kept.
 */
export function withoutChannelReplyContext(text: string): string {
  const value = String(text || "");
  if (!value.includes(CHANNEL_REPLY_CONTEXT_PREFIX)) return value;
  const kept: string[] = [];
  let inQuote = false;
  for (const line of value.split("\n")) {
    if (line.startsWith(CHANNEL_REPLY_CONTEXT_PREFIX)) {
      inQuote = true;
      continue;
    }
    if (inQuote && line.startsWith(">")) continue;
    inQuote = false;
    kept.push(line);
  }
  return kept.join("\n");
}
