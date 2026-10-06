import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { MemoryHubItem } from "../../../../shared/memory-hub-types";
import type {
  MemoryRepoEntriesReport,
  MemoryRepoHubEntry,
} from "../../../../shared/memory-repo-types";
import {
  deleteFolderEntry,
  editFolderEntry,
  filterFolderFiles,
  pinFolderEntry,
  type MemoryFolderApi,
} from "../memory-folder-model";
import { MemoryKnowledgeView, type MemoryKnowledgeViewProps } from "../MemoryKnowledgeTab";
import {
  addKnowledgeItem,
  clearGlobalKnowledge,
  deleteKnowledgeItem,
  describePurgeCounts,
  editKnowledgeItem,
  groupKnowledge,
  toggleKnowledgePin,
  type MemoryKnowledgeApi,
} from "../memory-knowledge-model";

const WS = "ws-1";

function item(overrides: Partial<MemoryHubItem>): MemoryHubItem {
  return {
    id: "item",
    workspaceId: null,
    scope: "global",
    scopeRef: null,
    kind: "preference",
    subjectKey: "preference:0000000000000000",
    content: "Prefers concise answers",
    source: "user_stated",
    trust: 1,
    confidence: 1,
    status: "active",
    pinned: false,
    private: false,
    reinforcedCount: 0,
    lastUsedAt: null,
    supersedesId: null,
    taskId: null,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const ITEMS: MemoryHubItem[] = [
  item({ id: "name", kind: "identity", content: "Preferred name: Mesut", pinned: true }),
  item({ id: "pref", kind: "preference", content: "Prefers concise answers" }),
  item({
    id: "rule",
    kind: "rule",
    scope: "workspace",
    workspaceId: WS,
    source: "curated",
    content: "Never push to main",
  }),
  item({
    id: "fact",
    kind: "project_fact",
    scope: "workspace",
    workspaceId: WS,
    source: "inferred",
    content: "The API uses PostgreSQL",
    lastUsedAt: Date.now() - 2 * 3600_000,
  }),
  item({ id: "insight", kind: "insight", source: "import", content: "Works best in the morning" }),
  item({
    id: "dana",
    kind: "commitment",
    scope: "contact",
    scopeRef: "contact-dana",
    source: "third_party",
    private: true,
    content: "Dana asked for the Q3 numbers",
  }),
];

function viewProps(overrides: Partial<MemoryKnowledgeViewProps> = {}): MemoryKnowledgeViewProps {
  const noop = () => {};
  return {
    items: ITEMS,
    total: ITEMS.length,
    hasMore: false,
    loading: false,
    error: null,
    notice: null,
    query: "",
    kindFilter: "",
    sourceFilter: "",
    pinnedOnly: false,
    editing: null,
    why: null,
    busyId: null,
    addDraft: { content: "", kind: "preference", scope: "global" },
    canWrite: true,
    canDelete: true,
    onQueryChange: noop,
    onKindFilterChange: noop,
    onSourceFilterChange: noop,
    onPinnedOnlyChange: noop,
    onAddDraftChange: noop,
    onAdd: noop,
    onStartEdit: noop,
    onEditDraftChange: noop,
    onSaveEdit: noop,
    onCancelEdit: noop,
    onTogglePin: noop,
    onDelete: noop,
    onToggleWhy: noop,
    onClearGlobal: noop,
    onLoadMore: noop,
    onDismissMessage: noop,
    ...overrides,
  };
}

function render(overrides: Partial<MemoryKnowledgeViewProps> = {}) {
  return renderToStaticMarkup(React.createElement(MemoryKnowledgeView, viewProps(overrides)));
}

function mockApi(overrides: Partial<Record<keyof MemoryKnowledgeApi, unknown>> = {}) {
  return {
    listMemoryItems: vi.fn(),
    addMemoryItem: vi.fn(),
    updateMemoryItem: vi.fn(),
    setMemoryItemPinned: vi.fn(),
    deleteMemoryItem: vi.fn(),
    getMemoryItemWhy: vi.fn(),
    clearGlobalMemoryItems: vi.fn(),
    ...overrides,
  } as unknown as MemoryKnowledgeApi & Record<keyof MemoryKnowledgeApi, ReturnType<typeof vi.fn>>;
}

describe("What CoWork knows view", () => {
  it("groups items by kind in a fixed order and keeps other people's text apart", () => {
    const { groups, fromOthers } = groupKnowledge(ITEMS);
    expect(groups.map((group) => group.title)).toEqual([
      "Identity",
      "Preferences",
      "Rules",
      "Project facts",
      "Decisions and insights",
    ]);
    expect(fromOthers.map((entry) => entry.id)).toEqual(["dana"]);

    const markup = render();
    const order = ["identity", "preferences", "rules", "project_facts", "decisions"].map((id) =>
      markup.indexOf(`data-group="${id}"`),
    );
    expect(order.every((index) => index >= 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // "From other people" is a collapsed section after the groups.
    expect(markup).toMatch(/<details class="[^"]*memory-knowledge-others"[^>]*>/);
    expect(markup).not.toMatch(/<details[^>]*\sopen/);
    expect(markup.indexOf('data-group="others"')).toBeGreaterThan(order[order.length - 1]);
  });

  it("shows content, source badge, scope, confidence, last used and actions per item", () => {
    const markup = render();
    for (const text of [
      "Preferred name: Mesut",
      "You said",
      "Curated",
      "Inferred",
      "Imported",
      "Third-party",
      "Global",
      "This workspace",
      "Contact",
      "Private",
      "100% confidence",
      "Last used 2h ago",
      "Last used never",
    ]) {
      expect(markup).toContain(text);
    }
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain(">Pinned</button>");
    expect((markup.match(/>Why\?<\/button>/g) || []).length).toBe(ITEMS.length);
    expect((markup.match(/>Delete<\/button>/g) || []).length).toBe(ITEMS.length);
    expect(markup).toContain("Clear global memories");
    expect(markup).toContain('aria-label="Search memories"');
  });

  it("renders the inline editor and the why panel for the selected item", () => {
    const markup = render({
      editing: { id: "pref", draft: "Prefers detailed answers" },
      why: {
        id: "rule",
        loading: false,
        error: null,
        data: {
          itemId: "rule",
          source: "curated",
          summary: "Curated into .cowork/MEMORY.md.",
          store: "curated",
          details: { target: "workspace" },
          mergedRecords: 0,
          task: { id: "task-1", title: "Plan the launch", available: true },
          trust: 0.85,
          confidence: 0.85,
          reinforcedCount: 2,
          lastUsedAt: null,
          createdAt: 1,
          updatedAt: 1,
          revisionCount: 1,
        },
      },
    });
    expect(markup).toContain('aria-label="Edit memory"');
    expect(markup).toContain("Prefers detailed answers</textarea>");
    expect(markup).toContain(">Save</button>");
    expect(markup).toContain("Curated into .cowork/MEMORY.md.");
    expect(markup).toContain("Plan the launch");
    expect(markup).toContain("2 times");
  });

  it("hides write and delete controls without permission and shows the empty state", () => {
    const readOnly = render({ canWrite: false, canDelete: false });
    expect(readOnly).not.toContain('aria-label="New memory"');
    expect(readOnly).not.toContain("Clear global memories");
    const empty = render({ items: [], total: 0 });
    expect(empty).toContain("CoWork does not know anything yet.");
    const filtered = render({ items: [], total: 0, query: "tea" });
    expect(filtered).toContain("No memories match these filters.");
  });
});

describe("What CoWork knows flows", () => {
  it("edit replaces the item with its new revision", async () => {
    const revised = item({
      id: "pref-2",
      content: "Prefers detailed answers",
      supersedesId: "pref",
    });
    const api = mockApi({
      updateMemoryItem: vi.fn(async () => ({ success: true, item: revised })),
    });
    const result = await editKnowledgeItem(api, WS, ITEMS, "pref", "  Prefers detailed answers ");
    expect(api.updateMemoryItem).toHaveBeenCalledWith({
      workspaceId: WS,
      id: "pref",
      content: "Prefers detailed answers",
    });
    expect(result.items.map((entry) => entry.id)).toEqual(
      ITEMS.map((entry) => (entry.id === "pref" ? "pref-2" : entry.id)),
    );
    expect(result.notice).toBe("Memory updated.");

    const refused = mockApi({
      updateMemoryItem: vi.fn(async () => ({ success: false, error: "Memory is turned off." })),
    });
    const failed = await editKnowledgeItem(refused, WS, ITEMS, "pref", "New text");
    expect(failed).toMatchObject({ items: ITEMS, error: "Memory is turned off." });
    expect((await editKnowledgeItem(api, WS, ITEMS, "pref", "   ")).error).toBeTruthy();
  });

  it("pin toggles through the API", async () => {
    const api = mockApi({
      setMemoryItemPinned: vi.fn(async () => ({
        success: true,
        item: { ...ITEMS[1], pinned: true },
      })),
    });
    const result = await toggleKnowledgePin(api, WS, ITEMS, ITEMS[1]);
    expect(api.setMemoryItemPinned).toHaveBeenCalledWith({
      workspaceId: WS,
      id: "pref",
      pinned: true,
    });
    expect(result.items.find((entry) => entry.id === "pref")?.pinned).toBe(true);
    expect(result.notice).toBe("Memory pinned.");
  });

  it("delete asks for confirmation first", async () => {
    const api = mockApi({ deleteMemoryItem: vi.fn(async () => ({ success: true, item: null })) });
    const declined = await deleteKnowledgeItem(api, WS, ITEMS, ITEMS[2], () => false);
    expect(declined.cancelled).toBe(true);
    expect(api.deleteMemoryItem).not.toHaveBeenCalled();

    const confirm = vi.fn((_message: string) => true);
    const result = await deleteKnowledgeItem(api, WS, ITEMS, ITEMS[2], confirm);
    expect(confirm.mock.calls[0][0]).toMatch(/Forget this memory/);
    expect(api.deleteMemoryItem).toHaveBeenCalledWith({ workspaceId: WS, id: "rule" });
    expect(result.items.some((entry) => entry.id === "rule")).toBe(false);

    const failing = mockApi({
      deleteMemoryItem: vi.fn(async () => Promise.reject(new Error("boom"))),
    });
    expect((await deleteKnowledgeItem(failing, WS, ITEMS, ITEMS[2], () => true)).error).toBe(
      "boom",
    );
  });

  it("add puts the new fact first and reports a known fact", async () => {
    const added = item({ id: "new", content: "Uses vim" });
    const api = mockApi({
      addMemoryItem: vi.fn(async () => ({ success: true, item: added, action: "inserted" })),
    });
    const result = await addKnowledgeItem(api, WS, ITEMS, {
      content: " Uses vim ",
      kind: "preference",
      scope: "global",
    });
    expect(api.addMemoryItem).toHaveBeenCalledWith({
      workspaceId: WS,
      content: "Uses vim",
      kind: "preference",
      scope: "global",
    });
    expect(result.items[0].id).toBe("new");
    const known = mockApi({
      addMemoryItem: vi.fn(async () => ({ success: true, item: ITEMS[1], action: "reinforced" })),
    });
    const repeat = await addKnowledgeItem(known, WS, ITEMS, {
      content: "Prefers concise answers",
      kind: "preference",
      scope: "global",
    });
    expect(repeat.items).toHaveLength(ITEMS.length);
    expect(repeat.notice).toBe("CoWork already knew that.");
  });

  it("clearing global memories needs confirmation and keeps workspace items", async () => {
    const api = mockApi({
      clearGlobalMemoryItems: vi.fn(async () => ({ success: true, deleted: 3 })),
    });
    expect((await clearGlobalKnowledge(api, WS, ITEMS, () => false)).cancelled).toBe(true);
    expect(api.clearGlobalMemoryItems).not.toHaveBeenCalled();
    const result = await clearGlobalKnowledge(api, WS, ITEMS, () => true);
    expect(api.clearGlobalMemoryItems).toHaveBeenCalledWith({ workspaceId: WS, confirm: true });
    expect(result.items.every((entry) => entry.scope !== "global")).toBe(true);
    expect(result.items.map((entry) => entry.id)).toEqual(["rule", "fact", "dana"]);
    expect(result.notice).toBe("Cleared 3 global memories.");
  });

  it("describes Clear All Memories counts per store", () => {
    expect(
      describePurgeCounts({ memories: 12, memoryItems: 3, transcripts: 0, curatedEntries: 1 }),
    ).toEqual(["12 archived memories", "3 facts (What CoWork knows)", "1 curated entries"]);
    expect(describePurgeCounts(undefined)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The memory folder (docs/memory-repo-phase3-design.md §5)
// ---------------------------------------------------------------------------

function folderEntry(overrides: Partial<MemoryRepoHubEntry>): MemoryRepoHubEntry {
  return {
    ref: "repo:me.md#L3",
    path: "me.md",
    line: 3,
    text: "Prefers short answers",
    by: "user",
    kind: "preference",
    added: "2026-10-05",
    taskId: null,
    hash: "a".repeat(64),
    source: null,
    ...overrides,
  };
}

const FOLDER: MemoryRepoEntriesReport = {
  available: true,
  writable: true,
  files: [
    {
      path: "MEMORY.md",
      title: "Memory: Mesut",
      role: "entry",
      entries: [folderEntry({ ref: "repo:MEMORY.md#L3", path: "MEMORY.md", text: "Answer in English" })],
    },
    {
      path: "me.md",
      title: "About me",
      role: "me",
      entries: [
        folderEntry({}),
        folderEntry({
          ref: "repo:me.md#L4",
          line: 4,
          text: "Prefers TypeScript",
          by: "agent",
          source: "import",
        }),
      ],
    },
    {
      path: "workspaces/billing.md",
      title: "Billing",
      role: "workspace",
      entries: [
        folderEntry({
          ref: "repo:workspaces/billing.md#L4",
          path: "workspaces/billing.md",
          text: "Deploys go through staging",
          by: "agent",
          kind: "rule",
          taskId: "task-9",
        }),
      ],
    },
  ],
  inbox: {
    path: "inbox.md",
    title: "Inbox",
    role: "inbox",
    entries: [
      folderEntry({ ref: "repo:inbox.md#L3", path: "inbox.md", text: "Send reports elsewhere", by: "agent" }),
    ],
  },
};

function folderView(overrides: Partial<NonNullable<MemoryKnowledgeViewProps["folderView"]>> = {}) {
  const noop = () => {};
  return {
    report: FOLDER,
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

function folderApi(overrides: Partial<Record<keyof MemoryFolderApi, unknown>> = {}) {
  return {
    getMemoryRepoEntries: vi.fn(async () => FOLDER),
    updateMemoryRepoEntry: vi.fn(async () => ({ ok: true, ref: "repo:me.md#L3" })),
    removeMemoryRepoEntry: vi.fn(async () => ({ ok: true })),
    pinMemoryRepoEntry: vi.fn(async () => ({ ok: true, ref: "repo:MEMORY.md#L4" })),
    ...overrides,
  } as unknown as MemoryFolderApi & Record<keyof MemoryFolderApi, ReturnType<typeof vi.fn>>;
}

describe("What CoWork knows over the memory folder", () => {
  it("shows the folder files with entries, keeps only commitments and other people from items", () => {
    const markup = render({
      items: [...ITEMS, item({ id: "loop", kind: "commitment", content: "Send the Q3 deck" })],
      folderView: folderView({ onOpenTask: () => {} }),
    });
    for (const text of [
      "Memory: Mesut",
      "About me",
      "Billing",
      "Answer in English",
      "Prefers TypeScript",
      "Deploys go through staging",
      "By you",
      "By CoWork",
      "Imported",
      "Added 2026-10-05",
      "Source task",
      "Open file",
      "Send the Q3 deck",
      "Dana asked for the Q3 numbers",
      "Unreviewed",
      "Send reports elsewhere",
    ]) {
      expect(markup).toContain(text);
    }
    // Facts from memory_items are not listed next to the folder.
    expect(markup).not.toContain("Never push to main");
    expect(markup).not.toContain('data-group="preferences"');
    expect(markup).toContain('data-group="commitments"');
    // MEMORY.md entries are already pinned; the inbox offers "Keep and pin".
    const pinnedSection = markup.slice(
      markup.indexOf('data-file="MEMORY.md"'),
      markup.indexOf('data-file="me.md"'),
    );
    expect(pinnedSection).not.toContain(">Pin</button>");
    const meSection = markup.slice(markup.indexOf('data-file="me.md"'), markup.indexOf('data-file="workspaces/billing.md"'));
    expect((meSection.match(/>Pin<\/button>/g) || []).length).toBe(2);
    expect(markup).toContain(">Keep and pin</button>");
    expect(markup.indexOf('data-file="inbox.md"')).toBeGreaterThan(markup.indexOf('data-file="workspaces/billing.md"'));
  });

  it("filters folder entries with the tab's filters and hides actions it cannot take", () => {
    const markup = render({
      query: "typescript",
      folderView: folderView({ canOpenFile: false, canWrite: false }),
    });
    expect(markup).toContain("Prefers TypeScript");
    expect(markup).not.toContain("Answer in English");
    expect(markup).not.toContain("Open file");
    expect(markup).not.toContain('data-file="MEMORY.md"');
    const pinnedOnly = render({ pinnedOnly: true, folderView: folderView() });
    expect(pinnedOnly).toContain("Answer in English");
    expect(pinnedOnly).not.toContain("Prefers short answers");
    const imported = filterFolderFiles(FOLDER.files, { query: "", kind: "", source: "import", pinnedOnly: false });
    expect(imported.flatMap((file) => file.entries.map((entry) => entry.text))).toEqual(["Prefers TypeScript"]);
    const mine = filterFolderFiles(FOLDER.files, { query: "", kind: "", source: "user_stated", pinnedOnly: false });
    expect(mine.flatMap((file) => file.entries.map((entry) => entry.by))).toEqual(["user", "user"]);
  });

  it("falls back to the items view when the folder is unavailable", () => {
    const markup = render({ folderView: folderView({ report: { ...FOLDER, available: false } }) });
    expect(markup).toContain('data-group="preferences"');
    expect(markup).not.toContain("About me");
  });

  it("edits, pins and deletes an entry by ref and hash, then reloads the folder", async () => {
    const api = folderApi();
    const entry = FOLDER.files[1].entries[0];
    const edited = await editFolderEntry(api, WS, FOLDER, entry, "  Prefers very short answers ");
    expect(api.updateMemoryRepoEntry).toHaveBeenCalledWith({
      workspaceId: WS,
      ref: entry.ref,
      hash: entry.hash,
      text: "Prefers very short answers",
    });
    expect(edited).toMatchObject({ notice: "Memory updated.", report: FOLDER });
    expect(await editFolderEntry(api, WS, FOLDER, entry, "  ")).toMatchObject({ error: expect.any(String) });

    expect(await pinFolderEntry(api, WS, FOLDER, entry)).toMatchObject({ notice: expect.stringMatching(/pinned/) });
    expect(api.pinMemoryRepoEntry).toHaveBeenCalledWith({ workspaceId: WS, ref: entry.ref, hash: entry.hash });

    expect(await deleteFolderEntry(api, WS, FOLDER, entry, () => false)).toMatchObject({ cancelled: true });
    expect(api.removeMemoryRepoEntry).not.toHaveBeenCalled();
    expect(await deleteFolderEntry(api, WS, FOLDER, entry, () => true)).toMatchObject({
      notice: "Memory forgotten.",
    });
    expect(api.getMemoryRepoEntries).toHaveBeenCalledTimes(3);
  });

  it("reports a refused action and shows the folder as it is now", async () => {
    const fresh = { ...FOLDER, files: FOLDER.files.slice(0, 1) };
    const api = folderApi({
      removeMemoryRepoEntry: vi.fn(async () => ({ ok: false, error: "The memory file changed; reload and try again." })),
      getMemoryRepoEntries: vi.fn(async () => fresh),
    });
    const result = await deleteFolderEntry(api, WS, FOLDER, FOLDER.files[1].entries[0], () => true);
    expect(result).toEqual({ report: fresh, error: "The memory file changed; reload and try again." });
    const thrown = await pinFolderEntry(
      folderApi({ pinMemoryRepoEntry: vi.fn(async () => Promise.reject(new Error("Rate limit exceeded."))) }),
      WS,
      FOLDER,
      FOLDER.files[1].entries[0],
    );
    expect(thrown).toEqual({ report: FOLDER, error: "Rate limit exceeded." });
  });

  it("counts a fact added to the folder as added", async () => {
    const api = mockApi({
      addMemoryItem: vi.fn(async () => ({ success: true, item: null, action: "inserted", ref: "repo:me.md#L5" })),
    });
    const result = await addKnowledgeItem(api, WS, [], { content: "Likes tea", kind: "preference", scope: "global" });
    expect(result).toEqual({ items: [], notice: "Memory added." });
  });
});
