import type { LLMMessage } from "./llm";

/**
 * Pinned context blocks are runtime-generated user-role messages (user profile,
 * shared context, memory recall, compaction summary, checklist reminder) that the
 * agent loop refreshes before every model call. Each block is wrapped in its own
 * tag pair so it can be found again, replaced or removed - including after
 * consolidateConsecutiveUserMessages has merged it into a neighbouring user
 * message (usually the task or step message at index 0).
 *
 * This is the single source of truth for the tags: the executor, SessionRuntime and
 * the context manager all read them from here.
 */
export const PINNED_CONTEXT_TAGS = {
  compactionSummary: {
    open: "<cowork_compaction_summary>",
    close: "</cowork_compaction_summary>",
  },
  userProfile: { open: "<cowork_user_profile>", close: "</cowork_user_profile>" },
  memoryRepo: { open: "<cowork_memory_repo>", close: "</cowork_memory_repo>" },
  swarm: { open: "<cowork_swarm>", close: "</cowork_swarm>" },
  sharedContext: { open: "<cowork_shared_context>", close: "</cowork_shared_context>" },
  memoryRecall: { open: "<cowork_memory_recall>", close: "</cowork_memory_recall>" },
  taskListReminder: {
    open: "<cowork_task_list_reminder>",
    close: "</cowork_task_list_reminder>",
  },
} as const;

export interface PinnedContextTagPair {
  open: string;
  close: string;
}

export const PINNED_CONTEXT_OPEN_TAGS: readonly string[] = Object.values(PINNED_CONTEXT_TAGS).map(
  (pair) => pair.open,
);

// Names older callers used for the same blocks.
const SYMBOLIC_TAG_ALIASES: Record<string, PinnedContextTagPair> = {
  PINNED_COMPACTION_SUMMARY: PINNED_CONTEXT_TAGS.compactionSummary,
  PINNED_USER_PROFILE: PINNED_CONTEXT_TAGS.userProfile,
  PINNED_MEMORY_REPO: PINNED_CONTEXT_TAGS.memoryRepo,
  PINNED_SWARM: PINNED_CONTEXT_TAGS.swarm,
  PINNED_SHARED_CONTEXT: PINNED_CONTEXT_TAGS.sharedContext,
  PINNED_MEMORY_RECALL: PINNED_CONTEXT_TAGS.memoryRecall,
  PINNED_TASK_LIST_REMINDER: PINNED_CONTEXT_TAGS.taskListReminder,
};

// consolidateConsecutiveUserMessages joins merged user messages with this separator.
const BLOCK_SEPARATOR = "\n\n";

interface PinnedBlockLocation {
  messageIndex: number;
  /** Offset of the open tag. */
  start: number;
  /** Offset just past the close tag. */
  end: number;
}

/**
 * Resolve an open tag ("<cowork_user_profile>") or a symbolic name
 * ("PINNED_USER_PROFILE") to its tag pair.
 */
export function resolvePinnedContextTag(tag: string): PinnedContextTagPair | null {
  const trimmed = String(tag || "").trim();
  if (!trimmed) return null;
  const alias = SYMBOLIC_TAG_ALIASES[trimmed];
  if (alias) return alias;
  const known = Object.values(PINNED_CONTEXT_TAGS).find((pair) => pair.open === trimmed);
  if (known) return known;
  const generic = /^<([a-z][a-z0-9_:-]*)>$/i.exec(trimmed);
  return generic ? { open: trimmed, close: `</${generic[1]}>` } : null;
}

/** Make sure a block starts with its open tag and ends with its close tag. */
export function wrapPinnedContextBlock(tags: PinnedContextTagPair, content: string): string {
  let block = String(content || "").trim();
  if (!block.startsWith(tags.open)) block = `${tags.open}\n${block}`;
  if (!block.endsWith(tags.close)) block = `${block}\n${tags.close}`;
  return block;
}

function isWhitespace(char: string | undefined): boolean {
  return char === " " || char === "\n" || char === "\t" || char === "\r";
}

// A block counts only when it stands on its own: at the start of the message or
// after a blank line, and followed by a blank line or the end of the message.
// That keeps user-written text that merely mentions a tag out of reach.
function startsAtBlockBoundary(text: string, index: number): boolean {
  let cursor = index;
  while (cursor > 0 && isWhitespace(text[cursor - 1])) cursor -= 1;
  return cursor === 0 || text.slice(cursor, index).includes(BLOCK_SEPARATOR);
}

function endsAtBlockBoundary(text: string, index: number): boolean {
  let cursor = index;
  while (cursor < text.length && isWhitespace(text[cursor])) cursor += 1;
  return cursor === text.length || text.slice(index, cursor).includes(BLOCK_SEPARATOR);
}

function findPinnedBlocks(
  messages: LLMMessage[],
  tags: PinnedContextTagPair,
): PinnedBlockLocation[] {
  const found: PinnedBlockLocation[] = [];
  for (let messageIndex = 0; messageIndex < messages.length; messageIndex += 1) {
    const message = messages[messageIndex];
    if (message?.role !== "user" || typeof message.content !== "string") continue;
    const text = message.content;
    let searchFrom = 0;
    while (searchFrom < text.length) {
      const start = text.indexOf(tags.open, searchFrom);
      if (start < 0) break;
      const closeIndex = text.indexOf(tags.close, start + tags.open.length);
      if (closeIndex < 0) break;
      const end = closeIndex + tags.close.length;
      if (startsAtBlockBoundary(text, start) && endsAtBlockBoundary(text, end)) {
        found.push({ messageIndex, start, end });
        searchFrom = end;
      } else {
        searchFrom = start + tags.open.length;
      }
    }
  }
  return found;
}

function replacePinnedBlock(
  messages: LLMMessage[],
  location: PinnedBlockLocation,
  block: string,
): void {
  const message = messages[location.messageIndex];
  const text = message.content as string;
  const next = text.slice(0, location.start) + block + text.slice(location.end);
  if (next !== text) messages[location.messageIndex] = { ...message, content: next };
}

function removePinnedBlockAt(messages: LLMMessage[], location: PinnedBlockLocation): void {
  const message = messages[location.messageIndex];
  const text = message.content as string;
  let before = location.start;
  while (before > 0 && isWhitespace(text[before - 1])) before -= 1;
  let after = location.end;
  while (after < text.length && isWhitespace(text[after])) after += 1;
  const head = text.slice(0, before);
  const tail = text.slice(after);
  const next = head && tail ? `${head}${BLOCK_SEPARATOR}${tail}` : head || tail;
  if (!next.trim()) {
    messages.splice(location.messageIndex, 1);
    return;
  }
  messages[location.messageIndex] = { ...message, content: next };
}

function messageHasBlockType(message: LLMMessage | undefined, type: string): boolean {
  if (!message || !Array.isArray(message.content)) return false;
  return message.content.some((block: Any) => block?.type === type);
}

function resolveSafeInsertIndex(messages: LLMMessage[], desiredIndex: number): number {
  let insertAt = Math.max(0, Math.min(desiredIndex, messages.length));
  // Never separate an assistant tool_use turn from the user turn carrying its results.
  while (insertAt > 0 && insertAt < messages.length) {
    const prev = messages[insertAt - 1];
    const next = messages[insertAt];
    const splitsToolPair =
      prev?.role === "assistant" &&
      messageHasBlockType(prev, "tool_use") &&
      next?.role === "user" &&
      messageHasBlockType(next, "tool_result");
    if (!splitsToolPair) break;
    insertAt += 1;
  }
  return insertAt;
}

/** Inner text of the first block with this tag, or null when there is none. */
export function findPinnedContextBlockContent(messages: LLMMessage[], tag: string): string | null {
  const tags = resolvePinnedContextTag(tag);
  if (!tags) return null;
  const location = findPinnedBlocks(messages, tags)[0];
  if (!location) return null;
  const text = messages[location.messageIndex].content as string;
  return text.slice(location.start + tags.open.length, location.end - tags.close.length).trim();
}

/**
 * Insert or replace one pinned block. An existing block is replaced in place,
 * even when it was merged into another user message, and stray duplicates are
 * removed, so the transcript holds at most one copy per tag. A new block goes
 * right after the `insertAfterTag` block when that exists, otherwise after the
 * first message (the task or step context).
 */
export function upsertPinnedContextBlock(
  messages: LLMMessage[],
  opts: { tag: string; content: string; insertAfterTag?: string },
): void {
  const tags = resolvePinnedContextTag(opts.tag);
  if (!tags) {
    messages.splice(resolveSafeInsertIndex(messages, Math.min(1, messages.length)), 0, {
      role: "user",
      content: opts.content,
    });
    return;
  }
  const block = wrapPinnedContextBlock(tags, opts.content);

  const existing = findPinnedBlocks(messages, tags);
  if (existing.length > 0) {
    for (const duplicate of existing.slice(1).reverse()) {
      removePinnedBlockAt(messages, duplicate);
    }
    replacePinnedBlock(messages, existing[0], block);
    return;
  }

  const anchorTags = opts.insertAfterTag ? resolvePinnedContextTag(opts.insertAfterTag) : null;
  const anchor = anchorTags ? findPinnedBlocks(messages, anchorTags)[0] : undefined;
  if (anchor) {
    const message = messages[anchor.messageIndex];
    const text = message.content as string;
    messages[anchor.messageIndex] = {
      ...message,
      content: text.slice(0, anchor.end) + BLOCK_SEPARATOR + block + text.slice(anchor.end),
    };
    return;
  }

  messages.splice(resolveSafeInsertIndex(messages, Math.min(1, messages.length)), 0, {
    role: "user",
    content: block,
  });
}

/** Remove every block with this tag, wherever it ended up. */
export function removePinnedContextBlock(messages: LLMMessage[], tag: string): void {
  const tags = resolvePinnedContextTag(tag);
  if (!tags) return;
  for (const location of findPinnedBlocks(messages, tags).reverse()) {
    removePinnedBlockAt(messages, location);
  }
}
