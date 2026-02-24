import { Children, type ReactNode } from "react";
import { getEmojiIcon } from "./emoji-icon-map";

/**
 * Matches emoji characters anywhere in a string.
 * Covers modern emoji (1F300-1FAFF), misc symbols (2600-27BF),
 * and info source (2139), with optional variation selectors.
 */
const INLINE_EMOJI_REGEX =
  /([\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}\u{2139}\u{2702}-\u{27B0}][\uFE0F\uFE0E]?)/gu;

function replaceEmojisInString(text: string, size: number): ReactNode[] {
  const parts: ReactNode[] = [];
  let lastIndex = 0;

  INLINE_EMOJI_REGEX.lastIndex = 0;

  let match: RegExpExecArray | null;
  while ((match = INLINE_EMOJI_REGEX.exec(text)) !== null) {
    const emoji = match[1];
    const Icon = getEmojiIcon(emoji);

    if (!Icon) continue;

    if (match.index > lastIndex) {
      parts.push(text.slice(lastIndex, match.index));
    }

    parts.push(
      <span
        key={`ei-${match.index}`}
        className="inline-emoji-icon"
        aria-label={emoji}
        role="img"
      >
        <Icon size={size} strokeWidth={1.8} />
      </span>,
    );

    lastIndex = match.index + match[0].length;
  }

  if (parts.length === 0) return [text];

  if (lastIndex < text.length) {
    parts.push(text.slice(lastIndex));
  }

  return parts;
}

/**
 * Process ReactMarkdown children, replacing emoji characters with Lucide icons.
 * Only direct string children are scanned; React element children pass through unchanged.
 */
export function replaceEmojisInChildren(children: ReactNode, size = 16): ReactNode {
  return Children.map(children, (child) => {
    if (typeof child === "string") {
      const replaced = replaceEmojisInString(child, size);
      if (replaced.length === 1 && replaced[0] === child) return child;
      return <>{replaced}</>;
    }
    return child;
  });
}
