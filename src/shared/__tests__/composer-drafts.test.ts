import { describe, expect, it } from "vitest";

import {
  COMPOSER_DRAFT_MAX_TEXT_LENGTH,
  buildComposerDraftKey,
  createEmptyComposerDraft,
  normalizeComposerDraft,
} from "../composer-drafts";

describe("composer draft bounds", () => {
  it("rejects oversized text and malformed attachment metadata", () => {
    const base = createEmptyComposerDraft({ scope: "local", workspaceId: "workspace" });
    expect(
      normalizeComposerDraft({ ...base, text: "x".repeat(COMPOSER_DRAFT_MAX_TEXT_LENGTH + 1) }),
    ).toBeNull();
    expect(
      normalizeComposerDraft({
        ...base,
        attachments: [
          {
            refId: "not-a-ref",
            name: "bad.bin",
            size: 1.5,
            sha256: "not-a-hash",
          },
        ],
      }),
    ).not.toBeNull();
    expect(
      normalizeComposerDraft({
        ...base,
        attachments: [
          {
            refId: "11111111-1111-4111-8111-111111111111",
            name: "bad.bin",
            size: 1.5,
            sha256: "not-a-hash",
          },
        ],
      })?.attachments,
    ).toEqual([]);
    expect(
      normalizeComposerDraft({
        ...base,
        attachments: [
          {
            refId: "11111111-1111-4111-8111-111111111111",
            name: "bad-status.bin",
            size: 1,
            sha256: "a".repeat(64),
            status: "corrupt",
          },
        ],
      })?.attachments,
    ).toEqual([]);
  });

  it("rejects mention spans outside the text and oversized serialized payloads", () => {
    const base = createEmptyComposerDraft({ scope: "local", workspaceId: "workspace" });
    const mention = {
      id: "mcp:example",
      label: "Example",
      source: "mcp" as const,
      providerKey: "example",
      iconKey: "example",
      tools: ["x".repeat(256)],
      promptHint: "hint",
    };
    expect(
      normalizeComposerDraft({
        ...base,
        text: "x",
        mentions: [{ spanId: "span", start: 0, end: 2, mention }],
      })?.mentions,
    ).toEqual([]);

    const oversizedMentions = Array.from({ length: 64 }, (_, index) => ({
      spanId: `span-${index}`,
      start: 0,
      end: 1,
      mention: { ...mention, tools: Array.from({ length: 128 }, () => "x".repeat(256)) },
    }));
    expect(normalizeComposerDraft({ ...base, text: "x", mentions: oversizedMentions })).toBeNull();
    expect(
      normalizeComposerDraft({
        ...base,
        attachments: [
          ...Array.from({ length: 5 }, (_, index) => ({
            refId: `${index + 1}`.padStart(32, "1"),
            name: `attachment-${index}.bin`,
            size: 25 * 1024 * 1024,
            sha256: String.fromCharCode(97 + index).repeat(64),
          })),
        ],
      }),
    ).toBeNull();
  });

  it("does not collide when an owner segment contains a key delimiter", () => {
    expect(
      buildComposerDraftKey({
        scope: "local",
        workspaceId: "workspace:a",
        taskId: "task",
        surface: "main",
      }),
    ).not.toBe(
      buildComposerDraftKey({
        scope: "local",
        workspaceId: "workspace",
        taskId: "a:task",
        surface: "main",
      }),
    );
  });
});
