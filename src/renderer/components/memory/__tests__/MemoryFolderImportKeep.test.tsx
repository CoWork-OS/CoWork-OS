import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  MemoryRepoEntriesReport,
  MemoryRepoHubEntry,
  MemoryRepoHubFile,
} from "../../../../shared/memory-repo-types";
import { MemoryFolderKnowledge, type MemoryFolderKnowledgeProps } from "../MemoryFolderKnowledge";
import type { MemoryFeaturesSettings } from "../../../../shared/types";
import { MemoryImportSection } from "../MemoryImportSection";
import { importResultMessage, useMemoryRepoController } from "../MemoryRepoCard";
import { keepFolderEntry, type MemoryFolderApi } from "../memory-folder-model";

const WS = "ws-1";

function entry(overrides: Partial<MemoryRepoHubEntry>): MemoryRepoHubEntry {
  return {
    ref: "repo:inbox.md#L3",
    path: "inbox.md",
    line: 3,
    text: "Ships on Fridays",
    by: "agent",
    kind: null,
    added: "2026-10-06",
    taskId: null,
    hash: "a".repeat(64),
    source: "import",
    ...overrides,
  };
}

const INBOX: MemoryRepoHubFile = {
  path: "inbox.md",
  title: "Inbox",
  role: "inbox",
  entries: [entry({})],
};

const ME: MemoryRepoHubFile = {
  path: "me.md",
  title: "About me",
  role: "me",
  entries: [
    entry({
      ref: "repo:me.md#L3",
      path: "me.md",
      text: "Prefers short answers",
      by: "user",
      source: null,
    }),
  ],
};

const REPORT: MemoryRepoEntriesReport = {
  available: true,
  writable: true,
  files: [ME],
  inbox: INBOX,
};

function props(overrides: Partial<MemoryFolderKnowledgeProps> = {}): MemoryFolderKnowledgeProps {
  const noop = () => {};
  return {
    files: [ME],
    inbox: INBOX,
    editing: null,
    busyRef: null,
    canWrite: true,
    canDelete: true,
    canOpenFile: false,
    onStartEdit: noop,
    onEditDraftChange: noop,
    onSaveEdit: noop,
    onCancelEdit: noop,
    onPin: noop,
    onDelete: noop,
    onOpenFile: noop,
    onKeep: noop,
    ...overrides,
  };
}

describe("Keep in the memory folder inbox", () => {
  it("offers Keep for inbox entries only, next to Keep and pin and Delete", () => {
    const markup = renderToStaticMarkup(<MemoryFolderKnowledge {...props()} />);
    const inbox = markup.slice(markup.indexOf('data-group="unreviewed"'));
    for (const label of [
      "Keep: about me",
      "Keep: lesson",
      "Keep: this workspace",
      "Keep and pin",
      "Delete",
    ]) {
      expect(inbox).toContain(`>${label}</button>`);
    }
    expect(inbox).toContain("Imported");
    expect(inbox).toContain("or imported from a folder");
    const me = markup.slice(
      markup.indexOf('data-file="me.md"'),
      markup.indexOf('data-group="unreviewed"'),
    );
    expect(me).not.toContain("Keep:");
    // Without the host method there is no Keep.
    expect(
      renderToStaticMarkup(<MemoryFolderKnowledge {...props({ onKeep: undefined })} />),
    ).not.toContain("Keep:");
  });

  it("keeps an entry through the API and reloads the folder", async () => {
    const reloaded = { ...REPORT, inbox: { ...INBOX, entries: [] } };
    const api = {
      getMemoryRepoEntries: vi.fn(async () => reloaded),
      updateMemoryRepoEntry: vi.fn(),
      removeMemoryRepoEntry: vi.fn(),
      pinMemoryRepoEntry: vi.fn(),
      keepMemoryRepoEntry: vi.fn(async () => ({ ok: true, ref: "repo:lessons.md#L3" })),
    } as unknown as MemoryFolderApi;
    const result = await keepFolderEntry(api, WS, REPORT, INBOX.entries[0], "lessons");
    expect(api.keepMemoryRepoEntry).toHaveBeenCalledWith({
      workspaceId: WS,
      ref: "repo:inbox.md#L3",
      hash: "a".repeat(64),
      target: "lessons",
    });
    expect(result).toEqual({ report: reloaded, notice: "Kept in Lessons." });

    const failing = {
      ...api,
      keepMemoryRepoEntry: vi.fn(async () => ({
        ok: false,
        error: "lessons.md is full; consolidate it first.",
      })),
      getMemoryRepoEntries: vi.fn(async () => REPORT),
    } as unknown as MemoryFolderApi;
    expect(await keepFolderEntry(failing, WS, REPORT, INBOX.entries[0], "lessons")).toEqual({
      report: REPORT,
      error: "lessons.md is full; consolidate it first.",
    });
    const missing = { ...api, keepMemoryRepoEntry: undefined } as unknown as MemoryFolderApi;
    expect(await keepFolderEntry(missing, WS, REPORT, INBOX.entries[0], "me")).toMatchObject({
      error: expect.stringMatching(/not available/),
    });
  });
});

describe("Import notes from a folder", () => {
  function ImportWithFolder(props: { features: MemoryFeaturesSettings; api: unknown }) {
    const repo = useMemoryRepoController({
      features: props.features,
      onFeaturesSaved: vi.fn(),
      api: props.api as never,
    });
    return <MemoryImportSection workspaceId={WS} memoryInUse repo={repo} />;
  }
  const features = {
    contextPackInjectionEnabled: true,
    heartbeatMaintenanceEnabled: true,
    memoryRepoEnabled: true,
  };

  it("shows Folder of notes in the Import row on desktop", () => {
    const api = vi.fn();
    const html = renderToStaticMarkup(<ImportWithFolder features={features} api={api} />);
    expect(html).toContain(">Folder of notes</button>");
    expect(api).not.toHaveBeenCalled();
  });

  it("hides Folder of notes in a browser session without the method", () => {
    vi.stubGlobal("window", {
      coworkBrowserHost: true,
      coworkBrowserHostInfo: {
        desktopMethods: { openMemoryRepoFolder: true, getMemoryRepoStatus: true },
      },
    });
    try {
      const html = renderToStaticMarkup(<ImportWithFolder features={features} api={vi.fn()} />);
      expect(html).toContain(">From another assistant</button>");
      expect(html).not.toContain("Folder of notes");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("summarizes the import result", () => {
    const base = { files: 3, imported: 0, duplicates: 0, skipped: 0, truncated: false };
    expect(importResultMessage({ ...base, cancelled: true })).toBeNull();
    expect(importResultMessage({ ...base, error: "That is your own memory folder." })).toEqual({
      tone: "error",
      text: "That is your own memory folder.",
    });
    expect(importResultMessage({ ...base, folderName: "notes", imported: 1 })?.text).toBe(
      'Imported 1 note from "notes" into the inbox. Keep the ones you want in What CoWork knows.',
    );
    expect(
      importResultMessage({
        ...base,
        folderName: "notes",
        imported: 5,
        duplicates: 2,
        skipped: 1,
        truncated: true,
      })?.text,
    ).toBe(
      'Imported 5 notes from "notes" into the inbox (2 duplicates left out; 1 skipped; a size limit was reached, so some notes were not read). Keep the ones you want in What CoWork knows.',
    );
    expect(importResultMessage({ ...base, files: 0, folderName: "empty" })?.text).toBe(
      'Nothing imported from "empty": no markdown notes were found.',
    );
    expect(importResultMessage({ ...base, duplicates: 3 })?.text).toBe(
      "Nothing imported: your memory already has them.",
    );
  });
});
