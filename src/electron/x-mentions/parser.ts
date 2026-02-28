import { XMentionTriggerSettings } from "../../shared/types";

export interface BirdMentionRecord {
  tweetId: string;
  conversationId?: string;
  author: string;
  text: string;
  url: string;
  timestamp: number;
  raw: Record<string, unknown>;
}

export interface ParsedMentionCommand extends BirdMentionRecord {
  command: string;
}

export interface MentionParseResult {
  accepted: boolean;
  reason?: "missing-id" | "missing-author" | "missing-prefix" | "empty-command" | "not-allowlisted";
  mention?: ParsedMentionCommand;
}

const MENTION_ARRAY_KEYS = ["mentions", "items", "results", "tweets", "data"] as const;

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function readString(record: Record<string, unknown> | null, key: string): string | undefined {
  if (!record) return undefined;
  const value = record[key];
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const trimmed = String(value).trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readNestedString(
  record: Record<string, unknown> | null,
  key: string,
  nestedKey: string,
): string | undefined {
  const nested = asRecord(record?.[key]);
  return readString(nested, nestedKey);
}

function readTimestamp(record: Record<string, unknown> | null): number {
  if (!record) return Date.now();
  const candidates: unknown[] = [
    record.createdAt,
    record.created_at,
    record.timestamp,
    record.time,
    readNestedString(record, "tweet", "createdAt"),
    readNestedString(record, "tweet", "created_at"),
  ];

  for (const candidate of candidates) {
    if (typeof candidate === "number" && Number.isFinite(candidate) && candidate > 0) {
      return candidate;
    }
    if (typeof candidate === "string" && candidate.trim().length > 0) {
      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed) && parsed > 0) {
        return parsed;
      }
    }
  }
  return Date.now();
}

function normalizeAuthor(author?: string): string {
  return String(author || "")
    .trim()
    .replace(/^@+/, "")
    .toLowerCase();
}

function normalizeAllowedAuthors(authors: string[]): Set<string> {
  const normalized = authors
    .map((author) => normalizeAuthor(author))
    .filter((author) => author.length > 0);
  return new Set(normalized);
}

function extractMentionsArray(data: unknown): unknown[] {
  if (Array.isArray(data)) {
    return data;
  }

  const record = asRecord(data);
  if (!record) {
    return [];
  }

  for (const key of MENTION_ARRAY_KEYS) {
    const value = record[key];
    if (Array.isArray(value)) {
      return value;
    }
  }

  return [];
}

function resolveTweetId(record: Record<string, unknown> | null): string | undefined {
  const legacy = asRecord(record?.legacy);
  return (
    readString(record, "id") ||
    readString(record, "tweetId") ||
    readString(record, "tweet_id") ||
    readString(record, "rest_id") ||
    readNestedString(record, "tweet", "id") ||
    readNestedString(record, "tweet", "tweetId") ||
    readNestedString(record, "tweet", "rest_id") ||
    readString(legacy, "id_str")
  );
}

function resolveConversationId(record: Record<string, unknown> | null): string | undefined {
  return (
    readString(record, "conversationId") ||
    readString(record, "conversation_id") ||
    readNestedString(record, "tweet", "conversationId") ||
    readNestedString(record, "tweet", "conversation_id")
  );
}

function resolveAuthor(record: Record<string, unknown> | undefined): string | undefined {
  if (!record) return undefined;
  return (
    readNestedString(record, "author", "username") ||
    readNestedString(record, "author", "screen_name") ||
    readNestedString(record, "user", "username") ||
    readNestedString(record, "user", "screen_name") ||
    readString(record, "author") ||
    readString(record, "username")
  );
}

function resolveText(record: Record<string, unknown> | undefined): string {
  if (!record) return "";
  return (
    readString(record, "text") ||
    readString(record, "fullText") ||
    readString(record, "full_text") ||
    readNestedString(record, "tweet", "text") ||
    readNestedString(record, "tweet", "fullText") ||
    readNestedString(record, "tweet", "full_text") ||
    ""
  );
}

function extractCommand(
  text: string,
  prefix: string,
): { matched: boolean; command: string } {
  const normalizedPrefix = prefix.trim();
  if (!normalizedPrefix) return { matched: false, command: "" };

  const source = String(text || "");
  const sourceLower = source.toLowerCase();
  const prefixLower = normalizedPrefix.toLowerCase();
  let index = sourceLower.indexOf(prefixLower);

  while (index >= 0) {
    const previousChar = index === 0 ? "" : source[index - 1] || "";
    const hasBoundary = index === 0 || /\s/.test(previousChar);
    if (hasBoundary) {
      const command = source.slice(index + normalizedPrefix.length).trim();
      return { matched: true, command };
    }
    index = sourceLower.indexOf(prefixLower, index + normalizedPrefix.length);
  }

  return { matched: false, command: "" };
}

export function parseBirdMentions(data: unknown): BirdMentionRecord[] {
  const raw = extractMentionsArray(data);
  const mentions: BirdMentionRecord[] = [];

  for (const candidate of raw) {
    const record = asRecord(candidate);
    if (!record) continue;

    const tweetId = resolveTweetId(record);
    const text = resolveText(record);
    const authorRaw = resolveAuthor(record);
    const author = normalizeAuthor(authorRaw);
    const conversationId = resolveConversationId(record);
    const timestamp = readTimestamp(record);
    const url =
      readString(record, "url") ||
      readNestedString(record, "tweet", "url") ||
      (author
        ? `https://x.com/${author}/status/${tweetId || "unknown"}`
        : `https://x.com/i/web/status/${tweetId || "unknown"}`);

    mentions.push({
      tweetId: tweetId || "",
      conversationId,
      author,
      text,
      url,
      timestamp,
      raw: record,
    });
  }

  return mentions;
}

export function sortMentionsOldestFirst(mentions: BirdMentionRecord[]): BirdMentionRecord[] {
  return [...mentions].sort((a, b) => {
    if (a.timestamp !== b.timestamp) {
      return a.timestamp - b.timestamp;
    }
    return a.tweetId.localeCompare(b.tweetId);
  });
}

export function parseMentionTriggerCommand(
  mention: BirdMentionRecord,
  trigger: XMentionTriggerSettings,
): MentionParseResult {
  if (!mention.tweetId.trim()) {
    return { accepted: false, reason: "missing-id" };
  }

  if (!mention.author.trim()) {
    return { accepted: false, reason: "missing-author" };
  }

  const allowedAuthors = normalizeAllowedAuthors(trigger.allowedAuthors || []);
  if (allowedAuthors.size === 0 || !allowedAuthors.has(mention.author)) {
    return { accepted: false, reason: "not-allowlisted" };
  }

  const extracted = extractCommand(mention.text || "", trigger.commandPrefix || "do:");
  if (!extracted.matched) {
    return { accepted: false, reason: "missing-prefix" };
  }
  if (!extracted.command.trim()) {
    return { accepted: false, reason: "empty-command" };
  }

  return {
    accepted: true,
    mention: {
      ...mention,
      command: extracted.command,
    },
  };
}

export function buildMentionTaskPrompt(mention: ParsedMentionCommand): string {
  const createdAtIso = new Date(mention.timestamp).toISOString();
  const fullText = mention.text || "";
  const conversationId = mention.conversationId || "unknown";
  return [
    "X mention trigger received.",
    "",
    "Metadata:",
    `- author: @${mention.author}`,
    `- tweet_url: ${mention.url}`,
    `- tweet_id: ${mention.tweetId}`,
    `- conversation_id: ${conversationId}`,
    `- created_at: ${createdAtIso}`,
    "",
    "Original mention text:",
    fullText,
    "",
    "Extracted command:",
    mention.command,
  ].join("\n");
}
