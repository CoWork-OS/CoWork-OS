import {
  forwardRef,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
} from "react";
import type {
  ClipboardEvent as ReactClipboardEvent,
  KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { IntegrationMentionSelection } from "../../shared/types";
import {
  IntegrationMentionIcon,
  renderIntegrationMentionIconContent,
} from "./IntegrationMentionIcon";

export type IntegrationMentionSpan = {
  spanId: string;
  start: number;
  end: number;
  mention: IntegrationMentionSelection;
};

export type PromptComposerInputHandle = {
  focus: () => void;
  setSelectionRange: (start: number, end: number) => void;
  getSelectionStart: () => number;
  resize: (shrink?: boolean) => void;
};

type PromptComposerInputProps = {
  value: string;
  mentions: IntegrationMentionSpan[];
  className: string;
  placeholder?: string;
  ariaLabel: string;
  onChange: (
    value: string,
    cursor: number,
    mentions: IntegrationMentionSpan[],
    shrink: boolean,
  ) => void;
  onKeyDown: (event: ReactKeyboardEvent<HTMLDivElement>) => void;
  onPaste: (event: ReactClipboardEvent<HTMLDivElement>) => void | Promise<void>;
  onCursorChange: (cursor: number) => void;
  onContentPresenceChange?: (hasContent: boolean) => void;
  onFocus?: () => void;
  onBlur?: () => void;
};

type RenderPart =
  | { type: "text"; key: string; text: string }
  | { type: "mention"; key: string; span: IntegrationMentionSpan }
  | { type: "link"; key: string; span: ComposerLinkSpan };

type ComposerLinkSpan = {
  start: number;
  end: number;
  markdown: string;
  url: string;
  label: string;
  domain: string;
};

const canonicalMentionText = (mention: IntegrationMentionSelection): string => `@${mention.label}`;
const markdownLinkPattern = /\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/gi;

function parseWebUrl(text: string): URL | null {
  try {
    const url = new URL(text);
    return url.protocol === "http:" || url.protocol === "https:" ? url : null;
  } catch {
    return null;
  }
}

function formatComposerLinkLabel(url: URL): string {
  const host = url.hostname.replace(/^www\./i, "");
  const pathParts = url.pathname
    .split("/")
    .filter(Boolean)
    .map((part) => decodeURIComponent(part));

  if (host === "github.com" && pathParts.length >= 2) {
    return `${pathParts[0]}/${pathParts[1].replace(/\.git$/i, "")}`;
  }

  const path = pathParts.slice(0, 2).join("/");
  return path ? `${host}/${path}` : host;
}

export function formatPastedWebLinkAsMarkdown(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  const url = parseWebUrl(trimmed);
  if (!url) return null;
  return `[${formatComposerLinkLabel(url)}](${url.toString()})`;
}

export function getPastedText(clipboardData: Pick<DataTransfer, "getData">): string {
  const plainText = clipboardData.getData("text/plain");
  if (plainText) return plainText;

  const html = clipboardData.getData("text/html");
  if (!html || typeof document === "undefined") return "";

  const container = document.createElement("div");
  container.innerHTML = html;
  return container.textContent ?? "";
}

function getFaviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?domain=${encodeURIComponent(domain)}&sz=32`;
}

function sortedValidMentions(
  value: string,
  mentions: IntegrationMentionSpan[],
): IntegrationMentionSpan[] {
  return mentions
    .filter((span) => {
      if (span.start < 0 || span.end <= span.start || span.end > value.length) return false;
      return value.slice(span.start, span.end) === canonicalMentionText(span.mention);
    })
    .sort((a, b) => a.start - b.start);
}

function parseMarkdownLinks(value: string, mentions: IntegrationMentionSpan[]): ComposerLinkSpan[] {
  const mentionRanges = sortedValidMentions(value, mentions);
  const links: ComposerLinkSpan[] = [];
  markdownLinkPattern.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = markdownLinkPattern.exec(value))) {
    const markdown = match[0];
    const label = match[1]?.trim();
    const urlText = match[2];
    const start = match.index;
    const end = start + markdown.length;
    if (!label || !urlText) continue;
    if (mentionRanges.some((span) => span.start < end && span.end > start)) continue;
    const url = parseWebUrl(urlText);
    if (!url) continue;
    links.push({
      start,
      end,
      markdown,
      url: url.toString(),
      label,
      domain: url.hostname.replace(/^www\./i, ""),
    });
  }
  return links;
}

function buildRenderParts(value: string, mentions: IntegrationMentionSpan[]): RenderPart[] {
  const parts: RenderPart[] = [];
  let cursor = 0;
  const tokens = [
    ...sortedValidMentions(value, mentions).map((span) => ({
      type: "mention" as const,
      start: span.start,
      end: span.end,
      span,
    })),
    ...parseMarkdownLinks(value, mentions).map((span) => ({
      type: "link" as const,
      start: span.start,
      end: span.end,
      span,
    })),
  ].sort((a, b) => a.start - b.start || b.end - a.end);

  for (const token of tokens) {
    if (token.start < cursor) continue;
    if (token.start > cursor) {
      parts.push({
        type: "text",
        key: `text:${cursor}:${token.start}`,
        text: value.slice(cursor, token.start),
      });
    }
    if (token.type === "mention") {
      parts.push({ type: "mention", key: token.span.spanId, span: token.span });
    } else {
      parts.push({ type: "link", key: `link:${token.start}:${token.end}`, span: token.span });
    }
    cursor = token.end;
  }
  if (cursor < value.length) {
    parts.push({ type: "text", key: `text:${cursor}:end`, text: value.slice(cursor) });
  }
  return parts;
}

function getTokenElement(node: Node | null): HTMLElement | null {
  let current: HTMLElement | null =
    node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  while (current) {
    if (current.dataset.integrationMentionId || current.dataset.composerLinkText) return current;
    current = current.parentElement;
  }
  return null;
}

function textLengthForNode(node: Node, mentionsById: Map<string, IntegrationMentionSpan>): number {
  if (node instanceof HTMLElement && node.dataset.integrationMentionId) {
    const span = mentionsById.get(node.dataset.integrationMentionId);
    return span ? canonicalMentionText(span.mention).length : 0;
  }
  if (node instanceof HTMLElement && node.dataset.composerLinkText) {
    return node.dataset.composerLinkText.length;
  }
  if (node.nodeType === Node.TEXT_NODE) {
    return node.textContent?.length ?? 0;
  }
  let length = 0;
  node.childNodes.forEach((child) => {
    length += textLengthForNode(child, mentionsById);
  });
  return length;
}

function getIndexForDomPosition(
  root: HTMLElement,
  targetNode: Node | null,
  targetOffset: number,
  mentionsById: Map<string, IntegrationMentionSpan>,
): number {
  if (!targetNode || !root.contains(targetNode)) return textLengthForNode(root, mentionsById);

  const tokenEl = getTokenElement(targetNode);
  if (tokenEl) {
    let index = 0;
    const children = Array.from(root.childNodes);
    for (const child of children) {
      if (child === tokenEl || child.contains(tokenEl)) {
        return index + (targetOffset > 0 ? textLengthForNode(child, mentionsById) : 0);
      }
      index += textLengthForNode(child, mentionsById);
    }
  }

  let index = 0;
  let found = false;
  const visit = (node: Node): void => {
    if (found) return;
    if (node instanceof HTMLElement && node.dataset.integrationMentionId) {
      index += textLengthForNode(node, mentionsById);
      return;
    }
    if (node instanceof HTMLElement && node.dataset.composerLinkText) {
      index += textLengthForNode(node, mentionsById);
      return;
    }
    if (node === targetNode) {
      if (node.nodeType === Node.TEXT_NODE) {
        index += Math.min(targetOffset, node.textContent?.length ?? 0);
      } else {
        const children = Array.from(node.childNodes).slice(0, targetOffset);
        children.forEach((child) => {
          index += textLengthForNode(child, mentionsById);
        });
      }
      found = true;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      index += node.textContent?.length ?? 0;
      return;
    }
    node.childNodes.forEach(visit);
  };
  visit(root);
  return index;
}

function getSelectionIndex(
  root: HTMLElement,
  mentionsById: Map<string, IntegrationMentionSpan>,
): number {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return textLengthForNode(root, mentionsById);
  return getIndexForDomPosition(root, selection.anchorNode, selection.anchorOffset, mentionsById);
}

function findDomPosition(
  root: HTMLElement,
  target: number,
  mentionsById: Map<string, IntegrationMentionSpan>,
): { node: Node; offset: number } {
  let seen = 0;
  let fallback: { node: Node; offset: number } = { node: root, offset: root.childNodes.length };

  const visit = (node: Node): { node: Node; offset: number } | null => {
    if (node instanceof HTMLElement && node.dataset.integrationMentionId) {
      const length = textLengthForNode(node, mentionsById);
      if (target <= seen) return { node: node.parentNode || root, offset: childOffset(node) };
      if (target <= seen + length) {
        return { node: node.parentNode || root, offset: childOffset(node) + 1 };
      }
      seen += length;
      return null;
    }
    if (node instanceof HTMLElement && node.dataset.composerLinkText) {
      const length = textLengthForNode(node, mentionsById);
      if (target <= seen) return { node: node.parentNode || root, offset: childOffset(node) };
      if (target <= seen + length) {
        return { node: node.parentNode || root, offset: childOffset(node) + 1 };
      }
      seen += length;
      return null;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      const length = node.textContent?.length ?? 0;
      if (target <= seen + length) {
        return { node, offset: Math.max(0, Math.min(length, target - seen)) };
      }
      seen += length;
      fallback = { node, offset: length };
      return null;
    }
    const children = Array.from(node.childNodes);
    if (children.length === 0 && target <= seen) return { node, offset: 0 };
    for (const child of children) {
      const result = visit(child);
      if (result) return result;
    }
    fallback = { node, offset: children.length };
    return null;
  };

  return visit(root) || fallback;
}

function childOffset(node: Node): number {
  if (!node.parentNode) return 0;
  return Array.prototype.indexOf.call(node.parentNode.childNodes, node) as number;
}

function setDomSelection(
  root: HTMLElement,
  start: number,
  end: number,
  mentionsById: Map<string, IntegrationMentionSpan>,
): void {
  const selection = window.getSelection();
  if (!selection) return;
  const range = document.createRange();
  const startPos = findDomPosition(root, start, mentionsById);
  const endPos = findDomPosition(root, end, mentionsById);
  range.setStart(startPos.node, startPos.offset);
  range.setEnd(endPos.node, endPos.offset);
  selection.removeAllRanges();
  selection.addRange(range);
}

function readEditable(
  root: HTMLElement,
  mentionsById: Map<string, IntegrationMentionSpan>,
): { value: string; mentions: IntegrationMentionSpan[]; cursor: number } {
  let value = "";
  const mentions: IntegrationMentionSpan[] = [];

  const visit = (node: Node): void => {
    if (node instanceof HTMLElement && node.dataset.integrationMentionId) {
      const original = mentionsById.get(node.dataset.integrationMentionId);
      if (!original) return;
      const start = value.length;
      value += canonicalMentionText(original.mention);
      mentions.push({ ...original, start, end: value.length });
      return;
    }
    if (node instanceof HTMLElement && node.dataset.composerLinkText) {
      value += node.dataset.composerLinkText;
      return;
    }
    if (node.nodeType === Node.TEXT_NODE) {
      value += node.textContent ?? "";
      return;
    }
    node.childNodes.forEach(visit);
  };

  root.childNodes.forEach(visit);
  return { value, mentions, cursor: getSelectionIndex(root, mentionsById) };
}

function replaceRange(
  value: string,
  mentions: IntegrationMentionSpan[],
  start: number,
  end: number,
  replacement: string,
): { value: string; mentions: IntegrationMentionSpan[]; cursor: number } {
  const nextValue = `${value.slice(0, start)}${replacement}${value.slice(end)}`;
  const delta = replacement.length - (end - start);
  const nextMentions = mentions.flatMap((span) => {
    if (span.end <= start) return [span];
    if (span.start >= end) return [{ ...span, start: span.start + delta, end: span.end + delta }];
    return [];
  });
  return { value: nextValue, mentions: nextMentions, cursor: start + replacement.length };
}

function renderComposerDom(root: HTMLElement, parts: RenderPart[]): void {
  const fragment = document.createDocumentFragment();

  for (const part of parts) {
    if (part.type === "text") {
      fragment.appendChild(document.createTextNode(part.text));
      continue;
    }

    if (part.type === "link") {
      const chip = document.createElement("span");
      chip.className = "composer-link-chip";
      chip.contentEditable = "false";
      chip.dataset.composerLinkText = part.span.markdown;
      chip.title = part.span.url;

      const icon = document.createElement("img");
      icon.className = "composer-link-favicon";
      icon.src = getFaviconUrl(part.span.domain);
      icon.alt = "";
      icon.draggable = false;

      const label = document.createElement("span");
      label.className = "composer-link-label";
      label.textContent = part.span.label;

      chip.append(icon, label);
      fragment.appendChild(chip);
      continue;
    }

    const chip = document.createElement("span");
    chip.className = "integration-mention-chip";
    chip.contentEditable = "false";
    chip.dataset.integrationMentionId = part.span.spanId;

    const icon = document.createElement("span");
    icon.className = "integration-mention-icon integration-mention-icon-xs";
    renderIntegrationMentionIconContent(icon, part.span.mention.iconKey, part.span.mention.label);

    const label = document.createElement("span");
    label.className = "integration-mention-chip-label";
    label.textContent = part.span.mention.label;

    chip.append(icon, label);
    fragment.appendChild(chip);
  }

  root.replaceChildren(fragment);
}

export const PromptComposerInput = forwardRef<PromptComposerInputHandle, PromptComposerInputProps>(
  function PromptComposerInput(
    {
      value,
      mentions,
      className,
      placeholder,
      ariaLabel,
      onChange,
      onKeyDown,
      onPaste,
      onCursorChange,
      onContentPresenceChange,
      onFocus,
      onBlur,
    },
    ref,
  ) {
    const rootRef = useRef<HTMLDivElement>(null);
    const pendingSelectionRef = useRef<{ start: number; end: number } | null>(null);
    const skipNextBeforeInputRef = useRef(false);
    const pasteHandledRef = useRef(false);
    const validMentions = useMemo(() => sortedValidMentions(value, mentions), [mentions, value]);
    const mentionsById = useMemo(
      () => new Map(validMentions.map((span) => [span.spanId, span])),
      [validMentions],
    );
    const parts = useMemo(() => buildRenderParts(value, validMentions), [validMentions, value]);

    const resize = useCallback((shrink = false) => {
      const root = rootRef.current;
      if (!root) return;
      if (shrink) root.style.height = "auto";
      const nextHeight = Math.min(root.scrollHeight, 200);
      root.style.height = `${Math.max(24, nextHeight)}px`;
    }, []);

    const applySelection = useCallback(
      (start: number, end: number) => {
        const root = rootRef.current;
        if (!root) return;
        setDomSelection(root, start, end, mentionsById);
      },
      [mentionsById],
    );

    useImperativeHandle(
      ref,
      () => ({
        focus: () => rootRef.current?.focus(),
        setSelectionRange: (start, end) => {
          pendingSelectionRef.current = { start, end };
          applySelection(start, end);
        },
        getSelectionStart: () =>
          rootRef.current ? getSelectionIndex(rootRef.current, mentionsById) : value.length,
        resize,
      }),
      [applySelection, mentionsById, resize, value.length],
    );

    useLayoutEffect(() => {
      const root = rootRef.current;
      if (root && typeof document !== "undefined") renderComposerDom(root, parts);
      onContentPresenceChange?.(value.length > 0);
      resize();
      const pending = pendingSelectionRef.current;
      if (!pending) return;
      pendingSelectionRef.current = null;
      applySelection(pending.start, pending.end);
    }, [applySelection, onContentPresenceChange, parts, resize, value.length]);

    const emitDomChange = useCallback(
      (shrink: boolean) => {
        const root = rootRef.current;
        if (!root) return;
        const snapshot = readEditable(root, mentionsById);
        pendingSelectionRef.current = { start: snapshot.cursor, end: snapshot.cursor };
        onContentPresenceChange?.(snapshot.value.length > 0);
        onChange(snapshot.value, snapshot.cursor, snapshot.mentions, shrink);
      },
      [mentionsById, onChange, onContentPresenceChange],
    );

    const applyTextReplacement = useCallback(
      (start: number, end: number, replacement: string) => {
        const protectedSpans = [...validMentions, ...parseMarkdownLinks(value, validMentions)];
        const expandedStart = Math.min(
          start,
          ...protectedSpans
            .filter((span) => span.start < end && span.end > start)
            .map((span) => span.start),
        );
        const expandedEnd = Math.max(
          end,
          ...protectedSpans
            .filter((span) => span.start < end && span.end > start)
            .map((span) => span.end),
        );
        const next = replaceRange(value, validMentions, expandedStart, expandedEnd, replacement);
        pendingSelectionRef.current = { start: next.cursor, end: next.cursor };
        onContentPresenceChange?.(next.value.length > 0);
        onChange(next.value, next.cursor, next.mentions, next.value.length < value.length);
      },
      [onChange, onContentPresenceChange, validMentions, value],
    );

    const getSelectionRange = useCallback(() => {
      const root = rootRef.current;
      const selection = window.getSelection();
      if (!root || !selection || selection.rangeCount === 0) {
        const cursor = root ? getSelectionIndex(root, mentionsById) : value.length;
        return { start: cursor, end: cursor };
      }
      const anchor = getIndexForDomPosition(
        root,
        selection.anchorNode,
        selection.anchorOffset,
        mentionsById,
      );
      const focus = getIndexForDomPosition(
        root,
        selection.focusNode,
        selection.focusOffset,
        mentionsById,
      );
      return { start: Math.min(anchor, focus), end: Math.max(anchor, focus) };
    }, [mentionsById, value.length]);

    const deleteSelectionRange = useCallback(
      (direction: "backward" | "forward") => {
        const range = getSelectionRange();
        let start = range.start;
        let end = range.end;
        if (start === end) {
          if (direction === "backward") {
            if (start === 0) return;
            start -= 1;
          } else {
            if (end >= value.length) return;
            end += 1;
          }
        }
        applyTextReplacement(start, end, "");
      },
      [applyTextReplacement, getSelectionRange, value.length],
    );

    const markKeyboardEditHandled = useCallback(() => {
      skipNextBeforeInputRef.current = true;
      window.setTimeout(() => {
        skipNextBeforeInputRef.current = false;
      }, 0);
    }, []);

    const markPasteHandled = useCallback(() => {
      pasteHandledRef.current = true;
      window.setTimeout(() => {
        pasteHandledRef.current = false;
      }, 0);
    }, []);

    const handleNativeBeforeInput = useCallback(
      (nativeEvent: InputEvent) => {
        if (nativeEvent.isComposing) return;
        if (skipNextBeforeInputRef.current) {
          nativeEvent.preventDefault();
          skipNextBeforeInputRef.current = false;
          return;
        }

        const inputType = nativeEvent.inputType;

        if (inputType === "insertFromPaste") {
          if (pasteHandledRef.current) {
            nativeEvent.preventDefault();
            pasteHandledRef.current = false;
            return;
          }

          const dataTransfer = nativeEvent.dataTransfer;
          if (dataTransfer?.files.length) return;
          const text = dataTransfer ? getPastedText(dataTransfer) : nativeEvent.data;
          if (typeof text !== "string" || !text) return;

          nativeEvent.preventDefault();
          const range = getSelectionRange();
          applyTextReplacement(range.start, range.end, formatPastedWebLinkAsMarkdown(text) || text);
          markPasteHandled();
          return;
        }

        if (inputType === "insertText") {
          const text = nativeEvent.data;
          if (typeof text !== "string") return;
          nativeEvent.preventDefault();
          const range = getSelectionRange();
          applyTextReplacement(range.start, range.end, text);
          return;
        }

        if (inputType === "insertParagraph" || inputType === "insertLineBreak") {
          nativeEvent.preventDefault();
          const range = getSelectionRange();
          applyTextReplacement(range.start, range.end, "\n");
          return;
        }

        if (inputType === "deleteContentBackward") {
          nativeEvent.preventDefault();
          deleteSelectionRange("backward");
          return;
        }

        if (inputType === "deleteContentForward") {
          nativeEvent.preventDefault();
          deleteSelectionRange("forward");
        }
      },
      [applyTextReplacement, deleteSelectionRange, getSelectionRange, markPasteHandled],
    );

    useLayoutEffect(() => {
      const root = rootRef.current;
      if (!root) return;
      const listener = (event: Event) => handleNativeBeforeInput(event as InputEvent);
      root.addEventListener("beforeinput", listener);
      return () => root.removeEventListener("beforeinput", listener);
    }, [handleNativeBeforeInput]);

    const handleKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>) => {
      onKeyDown(event);
      if (event.defaultPrevented) return;
      if (event.nativeEvent.isComposing) return;
      if (event.key === "Enter" && event.shiftKey) {
        event.preventDefault();
        markKeyboardEditHandled();
        const range = getSelectionRange();
        applyTextReplacement(range.start, range.end, "\n");
        return;
      }

      if (event.key === "Backspace") {
        event.preventDefault();
        markKeyboardEditHandled();
        deleteSelectionRange("backward");
        return;
      }

      if (event.key === "Delete") {
        event.preventDefault();
        markKeyboardEditHandled();
        deleteSelectionRange("forward");
        return;
      }

      const isPlainTextKey =
        event.key.length === 1 && !event.metaKey && !event.ctrlKey && !event.altKey;
      if (!isPlainTextKey) return;

      event.preventDefault();
      markKeyboardEditHandled();
      const range = getSelectionRange();
      applyTextReplacement(range.start, range.end, event.key);
    };

    const handlePaste = (event: ReactClipboardEvent<HTMLDivElement>) => {
      void onPaste(event);
      if (event.defaultPrevented) {
        pasteHandledRef.current = false;
        return;
      }
      if (pasteHandledRef.current) {
        event.preventDefault();
        pasteHandledRef.current = false;
        return;
      }
      const text = getPastedText(event.clipboardData);
      if (!text) return;
      event.preventDefault();
      const range = getSelectionRange();
      applyTextReplacement(range.start, range.end, formatPastedWebLinkAsMarkdown(text) || text);
      markPasteHandled();
    };

    const handleCopy = (event: ReactClipboardEvent<HTMLDivElement>) => {
      const range = getSelectionRange();
      if (range.start === range.end) return;
      event.clipboardData.setData("text/plain", value.slice(range.start, range.end));
      event.preventDefault();
    };

    const handleCut = (event: ReactClipboardEvent<HTMLDivElement>) => {
      const range = getSelectionRange();
      if (range.start === range.end) return;
      event.clipboardData.setData("text/plain", value.slice(range.start, range.end));
      event.preventDefault();
      applyTextReplacement(range.start, range.end, "");
    };

    const handleCursorChange = () => {
      const root = rootRef.current;
      if (!root) return;
      onCursorChange(getSelectionIndex(root, mentionsById));
    };

    return (
      <div
        ref={rootRef}
        className={`prompt-composer-input ${className}`}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label={ariaLabel}
        data-placeholder={placeholder || ""}
        onInput={() => emitDomChange(false)}
        onKeyDown={handleKeyDown}
        onKeyUp={handleCursorChange}
        onMouseUp={handleCursorChange}
        onPaste={handlePaste}
        onCopy={handleCopy}
        onCut={handleCut}
        onFocus={onFocus}
        onBlur={onBlur}
        spellCheck
      >
        {typeof document === "undefined"
          ? parts.map((part) =>
              part.type === "text" ? (
                <span key={part.key}>{part.text}</span>
              ) : part.type === "mention" ? (
                <span
                  key={part.key}
                  className="integration-mention-chip"
                  contentEditable={false}
                  data-integration-mention-id={part.span.spanId}
                >
                  <IntegrationMentionIcon
                    iconKey={part.span.mention.iconKey}
                    label={part.span.mention.label}
                    size="xs"
                  />
                  <span className="integration-mention-chip-label">{part.span.mention.label}</span>
                </span>
              ) : (
                <span
                  key={part.key}
                  className="composer-link-chip"
                  contentEditable={false}
                  data-composer-link-text={part.span.markdown}
                  title={part.span.url}
                >
                  <img
                    className="composer-link-favicon"
                    src={getFaviconUrl(part.span.domain)}
                    alt=""
                    draggable={false}
                  />
                  <span className="composer-link-label">{part.span.label}</span>
                </span>
              ),
            )
          : null}
      </div>
    );
  },
);
