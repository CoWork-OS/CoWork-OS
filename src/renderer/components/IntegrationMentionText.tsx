import { Fragment, useMemo } from "react";
import type { IntegrationMentionSelection } from "../../shared/types";
import { IntegrationMentionIcon } from "./IntegrationMentionIcon";

type IntegrationMentionTextPart =
  | { type: "text"; key: string; text: string }
  | { type: "mention"; key: string; mention: IntegrationMentionSelection; text: string };

function hasMentionBoundary(text: string, start: number, end: number): boolean {
  const before = start > 0 ? text[start - 1] : "";
  const after = end < text.length ? text[end] : "";
  return !/[A-Za-z0-9_]/.test(before) && !/[A-Za-z0-9_]/.test(after);
}

function buildIntegrationMentionTextParts(
  text: string,
  mentions?: IntegrationMentionSelection[],
): IntegrationMentionTextPart[] {
  if (!text || !mentions || mentions.length === 0) return [{ type: "text", key: "text:0", text }];

  const sortedMentions = [...mentions]
    .filter((mention) => mention.label.trim().length > 0)
    .sort((a, b) => b.label.length - a.label.length);
  const parts: IntegrationMentionTextPart[] = [];
  let cursor = 0;

  while (cursor < text.length) {
    if (text[cursor] !== "@") {
      const nextAt = text.indexOf("@", cursor + 1);
      const end = nextAt === -1 ? text.length : nextAt;
      parts.push({ type: "text", key: `text:${cursor}:${end}`, text: text.slice(cursor, end) });
      cursor = end;
      continue;
    }

    const match = sortedMentions.find((mention) => {
      const token = `@${mention.label}`;
      const end = cursor + token.length;
      return text.startsWith(token, cursor) && hasMentionBoundary(text, cursor, end);
    });

    if (!match) {
      parts.push({ type: "text", key: `text:${cursor}`, text: text[cursor] });
      cursor += 1;
      continue;
    }

    const token = `@${match.label}`;
    parts.push({
      type: "mention",
      key: `mention:${match.id}:${cursor}`,
      mention: match,
      text: token,
    });
    cursor += token.length;
  }

  return parts;
}

export function hasRenderableIntegrationMentions(
  text: string,
  mentions?: IntegrationMentionSelection[],
): boolean {
  return buildIntegrationMentionTextParts(text, mentions).some((part) => part.type === "mention");
}

export function IntegrationMentionText({
  text,
  mentions,
}: {
  text: string;
  mentions?: IntegrationMentionSelection[];
}) {
  const parts = useMemo(() => buildIntegrationMentionTextParts(text, mentions), [mentions, text]);

  return (
    <span className="integration-mention-message-text">
      {parts.map((part) =>
        part.type === "text" ? (
          <Fragment key={part.key}>{part.text}</Fragment>
        ) : (
          <span
            key={part.key}
            className="integration-mention-chip integration-mention-message-chip"
            title={part.text}
          >
            <IntegrationMentionIcon
              iconKey={part.mention.iconKey}
              label={part.mention.label}
              size="xs"
            />
            <span className="integration-mention-chip-label">{part.mention.label}</span>
          </span>
        ),
      )}
    </span>
  );
}
