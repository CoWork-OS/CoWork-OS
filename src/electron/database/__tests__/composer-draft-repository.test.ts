import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createEmptyComposerDraft, type ComposerDraft } from "../../../shared/composer-drafts";
import { ComposerDraftRepository } from "../composer-draft-repository";

let db: Database.Database | null = null;

function makeDraft(revision: number, overrides: Partial<ComposerDraft> = {}): ComposerDraft {
  return {
    ...createEmptyComposerDraft({ scope: "local", workspaceId: "workspace-1", taskId: "task-1" }),
    text: `draft-${revision}`,
    revision,
    updatedAt: 100 + revision,
    ...overrides,
  };
}

afterEach(() => {
  db?.close();
  db = null;
});

describe("ComposerDraftRepository", () => {
  it("keeps the newest revision and rejects stale writes", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE composer_drafts (
        draft_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id TEXT,
        surface TEXT NOT NULL,
        remote_device_id TEXT,
        payload_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
      )
    `);
    const repository = new ComposerDraftRepository(db);

    expect(repository.upsertIfNewer(makeDraft(2))).toBe(true);
    expect(repository.upsertIfNewer(makeDraft(1))).toBe(false);
    expect(repository.get("local:workspace-1:task-1:main")?.text).toBe("draft-2");
  });

  it("clears only the submitted revision", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE composer_drafts (
        draft_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id TEXT,
        surface TEXT NOT NULL,
        remote_device_id TEXT,
        payload_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
      )
    `);
    const repository = new ComposerDraftRepository(db);
    const draft = makeDraft(4);
    repository.upsertIfNewer(draft);
    expect(repository.clear(draft.draftKey, 3)).toBe(false);
    expect(repository.get(draft.draftKey)).not.toBeNull();
    expect(repository.clear(draft.draftKey, 4)).toBe(true);
    expect(repository.get(draft.draftKey)).toBeNull();
  });

  it("does not return a draft through a mismatched owner", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE composer_drafts (
        draft_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id TEXT,
        surface TEXT NOT NULL,
        remote_device_id TEXT,
        payload_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
      )
    `);
    const repository = new ComposerDraftRepository(db);
    const draft = makeDraft(1);
    repository.upsertIfNewer(draft);
    expect(
      repository.get(draft.draftKey, {
        draftKey: draft.draftKey,
        scope: "local",
        workspaceId: "workspace-2",
        taskId: "task-1",
        surface: "main",
      }),
    ).toBeNull();
  });

  it("rekeys a new-session draft while updating its task owner", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE composer_drafts (
        draft_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id TEXT,
        surface TEXT NOT NULL,
        remote_device_id TEXT,
        payload_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
      )
    `);
    const repository = new ComposerDraftRepository(db);
    const draft = {
      ...createEmptyComposerDraft({ scope: "local", workspaceId: "workspace-1" }),
      text: "kept across task creation",
      revision: 1,
    };
    repository.upsertIfNewer(draft);

    expect(
      repository.rekey(draft.draftKey, "local:workspace-1:task-2:main", { taskId: "task-2" }),
    ).toBe(true);
    expect(repository.get(draft.draftKey)).toBeNull();
    expect(repository.get("local:workspace-1:task-2:main")?.taskId).toBe("task-2");
    expect(repository.get("local:workspace-1:task-2:main")?.text).toBe("kept across task creation");
  });

  it("rejects a destination collision without deleting either draft", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE composer_drafts (
        draft_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id TEXT,
        surface TEXT NOT NULL,
        remote_device_id TEXT,
        payload_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
      )
    `);
    const repository = new ComposerDraftRepository(db);
    const source = makeDraft(2, {
      draftKey: "local:workspace-1:new:main",
      taskId: null,
    });
    const destination = makeDraft(1, {
      draftKey: "local:workspace-1:task-2:main",
      taskId: "task-2",
    });
    expect(repository.upsertIfNewer(source)).toBe(true);
    expect(repository.upsertIfNewer(destination)).toBe(true);

    expect(repository.rekey(source.draftKey, destination.draftKey, { taskId: "task-2" })).toBe(
      false,
    );
    expect(repository.get(source.draftKey)?.text).toBe("draft-2");
    expect(repository.get(destination.draftKey)?.text).toBe("draft-1");
  });

  it("lists only attachment refs from live, valid draft rows", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE composer_drafts (
        draft_key TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        task_id TEXT,
        surface TEXT NOT NULL,
        remote_device_id TEXT,
        payload_json TEXT NOT NULL,
        revision INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        expires_at INTEGER
      )
    `);
    const repository = new ComposerDraftRepository(db);
    const live = makeDraft(1, {
      attachments: [
        {
          refId: "11111111-1111-4111-8111-111111111111",
          name: "note.txt",
          size: 4,
          sha256: "a".repeat(64),
        },
      ],
      expiresAt: Date.now() + 60_000,
    });
    expect(repository.upsertIfNewer(live)).toBe(true);
    expect(repository.listLiveAttachmentRefs().map((ref) => ref.refId)).toEqual([
      "11111111-1111-4111-8111-111111111111",
    ]);
  });
});
