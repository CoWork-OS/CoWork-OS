import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { AnnotationStore } from "../repositories";

const nativeSqliteAvailable = await import("better-sqlite3")
  .then((module) => {
    try {
      const Probe = module.default;
      const probe = new Probe(":memory:");
      probe.close();
      return true;
    } catch {
      return false;
    }
  })
  .catch(() => false);

const describeWithSqlite = nativeSqliteAvailable ? describe : describe.skip;

describeWithSqlite("AnnotationStore", () => {
  let db: Database.Database;
  let repo: AnnotationStore;

  beforeEach(() => {
    db = new Database(":memory:");
    db.exec(`
      CREATE TABLE annotations (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        workspace_id TEXT,
        surface_type TEXT NOT NULL,
        surface_id TEXT,
        body TEXT NOT NULL,
        status TEXT NOT NULL,
        target_ref_json TEXT NOT NULL,
        style_patch_json TEXT,
        artifact_id TEXT,
        screenshot_path TEXT,
        created_by TEXT NOT NULL DEFAULT 'user',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        resolved_at INTEGER,
        resolved_by_event_id TEXT,
        intent TEXT,
        before_json TEXT,
        after_json TEXT,
        output_path TEXT,
        artifact_revision_id TEXT,
        result_revision_id TEXT,
        undo_token TEXT
      );
    `);
    repo = new AnnotationStore(db);
  });

  afterEach(() => {
    db.close();
  });

  it("creates and lists browser annotations with target metadata", () => {
    const annotation = repo.create({
      taskId: "task-1",
      workspaceId: "workspace-1",
      surfaceType: "browser",
      surfaceId: "http://127.0.0.1:5173",
      body: "Add a one-line summary.",
      targetRef: {
        surfaceType: "browser",
        url: "http://127.0.0.1:5173",
        title: "Dashboard",
        rect: { x: 40, y: 120, width: 360, height: 44 },
        selector: "main h1",
        textQuote: "Launch health",
      },
    });

    expect(annotation.status).toBe("open");
    expect(annotation.createdBy).toBe("user");

    const list = repo.list({
      taskId: "task-1",
      surfaceType: "browser",
      statuses: ["open"],
    });

    expect(list).toHaveLength(1);
    expect(list[0].body).toBe("Add a one-line summary.");
    expect(list[0].targetRef).toMatchObject({
      surfaceType: "browser",
      selector: "main h1",
      rect: { x: 40, y: 120, width: 360, height: 44 },
    });
  });

  it("marks open annotations as addressing and resolves them", () => {
    const annotation = repo.create({
      taskId: "task-1",
      surfaceType: "browser",
      body: "Tighten the launch copy.",
      targetRef: {
        surfaceType: "browser",
        url: "http://localhost:5173",
      },
      stylePatch: {
        fontSize: "16px",
      },
    });

    expect(repo.markAddressing("task-1", [annotation.id])).toBe(1);
    expect(repo.findById(annotation.id)?.status).toBe("addressing");

    const resolved = repo.update(annotation.id, {
      status: "resolved",
      resolvedByEventId: "event-1",
    });

    expect(resolved?.status).toBe("resolved");
    expect(resolved?.resolvedAt).toEqual(expect.any(Number));
    expect(resolved?.resolvedByEventId).toBe("event-1");
    expect(resolved?.stylePatch).toEqual({ fontSize: "16px" });
  });

  it("moves in-progress annotations to addressed on completion", () => {
    const annotation = repo.create({
      taskId: "task-1",
      surfaceType: "browser",
      body: "Update this label.",
      targetRef: {
        surfaceType: "browser",
        url: "http://localhost:5173",
      },
    });

    repo.markAddressing("task-1", [annotation.id]);

    expect(repo.markAddressed("task-1")).toBe(1);
    expect(repo.findById(annotation.id)?.status).toBe("addressed");
  });

  it("clears optional style metadata without storing a JSON null string", () => {
    const annotation = repo.create({
      taskId: "task-1",
      surfaceType: "browser",
      body: "Remove the color override.",
      targetRef: {
        surfaceType: "browser",
        url: "http://localhost:5173",
      },
      stylePatch: {
        color: "#08213f",
      },
    });

    const updated = repo.update(annotation.id, { stylePatch: null });
    const raw = db
      .prepare("SELECT style_patch_json FROM annotations WHERE id = ?")
      .get(annotation.id) as { style_patch_json: string | null };

    expect(updated?.stylePatch).toBeUndefined();
    expect(raw.style_patch_json).toBeNull();
  });

  it("keeps a pointed-at change: intent, bounded values, revisions and the undo token", () => {
    const manyCells = Object.fromEntries(
      Array.from({ length: 60 }, (_, index) => [`A${index + 1}`, String(index)]),
    );
    const annotation = repo.create({
      taskId: "task-1",
      surfaceType: "artifact",
      body: "Use net figures",
      targetRef: {
        surfaceType: "artifact",
        filePath: "/ws/report.xlsx",
        sheetName: "Q3",
        cellRange: "B2:B61",
      },
      intent: "change",
      before: { ...manyCells, long: "x".repeat(3_000), number: 5 as unknown as string },
      after: { B2: "1200" },
      outputPath: " /ws/report-v2.xlsx ",
    });

    expect(annotation.intent).toBe("change");
    expect(Object.keys(annotation.before!)).toHaveLength(50);
    expect(annotation.before).not.toHaveProperty("number");
    expect(annotation.outputPath).toBe("/ws/report-v2.xlsx");

    repo.setBaseRevision(annotation.id, "rev-1");
    // Only an annotation being addressed takes a result.
    expect(repo.recordResult(annotation.id, { resultRevisionId: "rev-2" })?.status).toBe("open");
    repo.markAddressing("task-1", [annotation.id]);
    const addressed = repo.recordResult(annotation.id, {
      resultRevisionId: "rev-2",
      undoToken: "token-1",
    });
    expect(addressed).toMatchObject({
      status: "addressed",
      intent: "change",
      after: { B2: "1200" },
      artifactRevisionId: "rev-1",
      resultRevisionId: "rev-2",
      undoToken: "token-1",
    });

    const undone = repo.clearUndo(annotation.id);
    expect(undone?.status).toBe("dismissed");
    expect(undone?.undoToken).toBeUndefined();
    expect(undone?.resolvedAt).toBeTypeOf("number");
  });

  it("ignores an unknown intent", () => {
    const annotation = repo.create({
      taskId: "task-1",
      surfaceType: "browser",
      body: "x",
      targetRef: { surfaceType: "browser", url: "http://localhost" },
      intent: "delete-everything" as never,
    });
    expect(repo.findById(annotation.id)?.intent).toBeUndefined();
  });
});
