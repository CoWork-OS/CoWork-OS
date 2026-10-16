import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import type {
  MemoryRepoEntriesReport,
  MemoryRepoHubFile,
} from "../../../../shared/memory-repo-types";
import { MemoryFolderKnowledge, type MemoryFolderKnowledgeProps } from "../MemoryFolderKnowledge";
import { countFolderEntries, folderFileHint } from "../memory-folder-model";

const bot = (overrides: Partial<MemoryRepoHubFile> = {}): MemoryRepoHubFile => ({
  path: "bots/ember.md",
  title: "Ember",
  role: "bot",
  botId: "bot-ember",
  entries: [
    {
      ref: "repo:bots/ember.md#L4",
      path: "bots/ember.md",
      line: 4,
      text: "Posts the invoice digest on Mondays",
      by: "agent",
      kind: "rule",
      added: "2026-10-15",
      taskId: null,
      hash: "b".repeat(64),
      source: null,
    },
  ],
  ...overrides,
});

function props(overrides: Partial<MemoryFolderKnowledgeProps> = {}): MemoryFolderKnowledgeProps {
  const noop = () => {};
  return {
    files: [],
    inbox: null,
    editing: null,
    busyRef: null,
    canWrite: true,
    canDelete: true,
    canOpenFile: true,
    onStartEdit: noop,
    onEditDraftChange: noop,
    onSaveEdit: noop,
    onCancelEdit: noop,
    onPin: noop,
    onDelete: noop,
    onOpenFile: noop,
    ...overrides,
  };
}

describe("bots in the memory folder view", () => {
  it("groups bots' files under Bots with edit and delete but no pin", () => {
    const html = renderToStaticMarkup(
      <MemoryFolderKnowledge
        {...props({
          bots: [
            bot(),
            bot({ path: "bots/old.md", title: "Old helper", botId: "bot-old", botDeleted: true }),
          ],
          focusBotId: "bot-ember",
        })}
      />,
    );
    expect(html).toContain('data-group="bots"');
    expect(html).toContain("Posts the invoice digest on Mondays");
    expect(html).toContain('data-bot-id="bot-ember"');
    expect(html).toMatch(/memory-knowledge-bot focused[^>]*data-bot-id="bot-ember"/);
    expect(html).toContain("Bot deleted");
    expect(html).toContain(">Edit<");
    expect(html).toContain(">Delete<");
    expect(html).not.toContain(">Pin<");
  });

  it("shows nothing for bots when there are none, and counts bot entries", () => {
    expect(renderToStaticMarkup(<MemoryFolderKnowledge {...props()} />)).not.toContain(
      'data-group="bots"',
    );
    const report: MemoryRepoEntriesReport = {
      available: true,
      writable: true,
      files: [],
      inbox: null,
      bots: [bot()],
    };
    expect(countFolderEntries(report)).toBe(1);
    expect(folderFileHint({ role: "bot" })).toContain("This bot's own memory");
  });
});
