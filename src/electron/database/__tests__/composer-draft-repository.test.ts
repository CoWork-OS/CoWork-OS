import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { createEmptyComposerDraft, type ComposerDraft } from "../../../shared/composer-drafts";
import { ComposerDraftStore } from "../composer-draft-repository";

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

describe("ComposerDraftStore", () => {
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
    const repository = new ComposerDraftStore(db);

    expect(repository.upsertIfNewer(makeDraft(2, { interactionMode: { mode: "chat" } }))).toBe(
      true,
    );
    expect(repository.upsertIfNewer(makeDraft(1))).toBe(false);
    expect(repository.get("local:workspace-1:task-1:main")?.text).toBe("draft-2");
    expect(repository.get("local:workspace-1:task-1:main")?.interactionMode).toEqual({
      mode: "chat",
    });
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
    const repository = new ComposerDraftStore(db);
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
    const repository = new ComposerDraftStore(db);
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
    const repository = new ComposerDraftStore(db);
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
    const repository = new ComposerDraftStore(db);
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
    const repository = new ComposerDraftStore(db);
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

  it("lists the messages a draft owner sent after the draft was started", () => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE tasks (
        id TEXT PRIMARY KEY,
        workspace_id TEXT NOT NULL,
        parent_task_id TEXT,
        prompt TEXT NOT NULL,
        user_prompt TEXT,
        raw_prompt TEXT,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        timestamp INTEGER NOT NULL,
        type TEXT NOT NULL,
        legacy_type TEXT,
        payload TEXT NOT NULL
      );
    `);
    const header = "Attached files (relative to workspace):";
    const withFile = `Fix it\n\n${header}\n- image.png (.cowork/uploads/1/image.png)`;
    const insertTask = db.prepare(
      "INSERT INTO tasks (id, workspace_id, parent_task_id, prompt, user_prompt, raw_prompt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    );
    insertTask.run("before", "workspace-repo", null, withFile, withFile, null, 900);
    insertTask.run("sent", "workspace-repo", null, "Fix it", withFile, withFile, 1_100);
    insertTask.run("child", "workspace-repo", "sent", withFile, withFile, null, 1_200);
    insertTask.run("unrelated", "workspace-other", null, "Plan lunch", null, null, 1_300);
    const insertEvent = db.prepare(
      "INSERT INTO task_events (id, task_id, timestamp, type, legacy_type, payload) VALUES (?, ?, ?, ?, ?, ?)",
    );
    insertEvent.run(
      "e1",
      "sent",
      1_000,
      "timeline_step_updated",
      "user_message",
      JSON.stringify({ message: "too early" }),
    );
    insertEvent.run(
      "e2",
      "sent",
      1_400,
      "timeline_step_updated",
      "user_message",
      JSON.stringify({ message: "Diagnose the error" }),
    );
    insertEvent.run(
      "e3",
      "sent",
      1_500,
      "timeline_step_updated",
      "assistant_message",
      JSON.stringify({ message: "Done" }),
    );
    const repository = new ComposerDraftStore(db);

    // A new-session draft looks across folders, at top-level tasks only.
    expect(
      repository.listMessagesSentSince({ taskId: null, since: 1_000, needle: header }),
    ).toEqual([
      { workspaceId: "workspace-repo", text: withFile },
      { workspaceId: "workspace-repo", text: "Fix it" },
    ]);
    expect(
      repository.listMessagesSentSince({ taskId: null, since: 1_000, needle: "Plan lunch" }),
    ).toEqual([{ workspaceId: "workspace-other", text: "Plan lunch" }]);

    // A task draft looks at that task's prompt and later follow-ups.
    expect(repository.listMessagesSentSince({ taskId: "sent", since: 1_050, needle: "x" })).toEqual(
      [
        { workspaceId: "workspace-repo", text: withFile },
        { workspaceId: "workspace-repo", text: "Fix it" },
        { workspaceId: "workspace-repo", text: "Diagnose the error" },
      ],
    );
    expect(repository.listMessagesSentSince({ taskId: "sent", since: 1_150, needle: "x" })).toEqual(
      [{ workspaceId: "workspace-repo", text: "Diagnose the error" }],
    );
    expect(repository.listMessagesSentSince({ taskId: "gone", since: 0, needle: "x" })).toEqual([]);
  });
});
