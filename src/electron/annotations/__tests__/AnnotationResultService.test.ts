import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Annotation, ArtifactRevision } from "../../../shared/types";
import { AnnotationResultService, describeAnnotationAnchor } from "../AnnotationResultService";
import { RevisionSnapshotStore } from "../revision-snapshots";

let dir: string;
let workspace: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "annotation-results-"));
  workspace = path.join(dir, "workspace");
  await fs.mkdir(workspace);
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

function setup(options: { maxBytes?: number } = {}) {
  const annotations = new Map<string, Annotation>();
  const revisions = new Map<string, ArtifactRevision>();
  const events: Array<{ type: string; payload: Record<string, unknown> }> = [];
  let revisionCount = 0;
  const repo = {
    findById: vi.fn(async (id: string) => annotations.get(id)),
    list: vi.fn(async (query: { taskId?: string; statuses?: string[] }) =>
      [...annotations.values()].filter(
        (annotation) =>
          annotation.taskId === query.taskId &&
          (!query.statuses || query.statuses.includes(annotation.status)),
      ),
    ),
    setBaseRevision: vi.fn(async (id: string, revisionId: string) => {
      const next = { ...annotations.get(id)!, artifactRevisionId: revisionId };
      annotations.set(id, next);
      return next;
    }),
    recordResult: vi.fn(
      async (id: string, result: { resultRevisionId?: string; undoToken?: string }) => {
        const current = annotations.get(id)!;
        if (current.status !== "addressing") return current;
        const next: Annotation = { ...current, status: "addressed", ...result };
        annotations.set(id, next);
        return next;
      },
    ),
    clearUndo: vi.fn(async (id: string) => {
      const { undoToken: _spent, ...rest } = annotations.get(id)!;
      const next: Annotation = { ...rest, status: "dismissed" };
      annotations.set(id, next);
      return next;
    }),
  };
  const contract = {
    recordFileRevision: vi.fn((taskId: string, input: Record<string, Any>) => {
      revisionCount += 1;
      const revision = {
        id: `rev-${revisionCount}`,
        sessionId: "session-1",
        taskId,
        revision: revisionCount,
        path: input.path,
        mimeType: input.mimeType || "application/octet-stream",
        sha256: input.sha256,
        size: input.size,
        parentRevisionId: input.parentRevisionId,
        status: "committed",
        createdBy: input.createdBy,
        metadata: input.metadata,
        createdAt: Date.now(),
      } as ArtifactRevision;
      revisions.set(revision.id, revision);
      return revision;
    }),
    getArtifactRevision: vi.fn((id: string) => revisions.get(id)),
  };
  const service = new AnnotationResultService({
    annotations: repo as Any,
    contract: contract as Any,
    snapshots: new RevisionSnapshotStore(path.join(dir, "snapshots"), options.maxBytes),
    workspaceRootForTask: async (taskId) => (taskId === "task-1" ? workspace : undefined),
    logEvent: (_taskId, type, payload) => events.push({ type, payload }),
  });
  const add = (annotation: Partial<Annotation>) => {
    const full: Annotation = {
      id: `ann-${annotations.size + 1}`,
      taskId: "task-1",
      surfaceType: "artifact",
      body: "Use net figures",
      status: "open",
      targetRef: {
        surfaceType: "artifact",
        filePath: "report.csv",
        sheetName: "Q3",
        cellRange: "B2",
      },
      createdBy: "user",
      createdAt: 1,
      updatedAt: 1,
      ...annotation,
    } as Annotation;
    annotations.set(full.id, full);
    return full;
  };
  const addressing = (id: string) =>
    annotations.set(id, { ...annotations.get(id)!, status: "addressing" });
  return { service, annotations, revisions, events, contract, add, addressing };
}

const file = (name: string) => path.join(workspace, name);

describe("AnnotationResultService", () => {
  it("links the change to the pointed-at revision and undoes it", async () => {
    await fs.writeFile(file("report.csv"), "q,amount\nQ3,1000\n");
    const { service, annotations, events, add, addressing } = setup();
    const annotation = add({});

    const pinned = await service.pinTarget(annotation.id);
    expect(pinned?.artifactRevisionId).toBe("rev-1");

    addressing(annotation.id);
    await fs.writeFile(file("report.csv"), "q,amount\nQ3,1200\n");
    expect(await service.settle("task-1")).toBe(1);

    const addressed = annotations.get(annotation.id)!;
    expect(addressed).toMatchObject({ status: "addressed", resultRevisionId: "rev-2" });
    expect(addressed.undoToken).toBeTruthy();
    expect(events[0]).toMatchObject({
      type: "annotation_addressed",
      payload: {
        annotationId: annotation.id,
        anchor: "report.csv · Q3!B2",
        changed: true,
        undoToken: addressed.undoToken,
      },
    });

    expect(await service.undo(annotation.id, "wrong-token")).toEqual({
      ok: false,
      error: "This change can no longer be undone.",
    });
    const undone = await service.undo(annotation.id, addressed.undoToken!);
    expect(undone.ok).toBe(true);
    expect(await fs.readFile(file("report.csv"), "utf8")).toBe("q,amount\nQ3,1000\n");
    expect(annotations.get(annotation.id)).toMatchObject({ status: "dismissed" });
    expect(annotations.get(annotation.id)?.undoToken).toBeUndefined();
    expect(events.at(-1)).toMatchObject({
      type: "annotation_change_undone",
      payload: { annotationId: annotation.id, restoredRevisionId: "rev-1", revisionId: "rev-3" },
    });
    // The token is spent.
    expect((await service.undo(annotation.id, addressed.undoToken!)).ok).toBe(false);
  });

  it("refuses to undo over a later change to the file", async () => {
    await fs.writeFile(file("report.csv"), "v1");
    const { service, annotations, add, addressing } = setup();
    const annotation = add({});
    await service.pinTarget(annotation.id);
    addressing(annotation.id);
    await fs.writeFile(file("report.csv"), "v2");
    await service.settle("task-1");
    await fs.writeFile(file("report.csv"), "v3 by hand");

    const result = await service.undo(annotation.id, annotations.get(annotation.id)!.undoToken!);
    expect(result).toEqual({
      ok: false,
      error: "The file changed after this edit. Undoing it now would discard the later changes.",
    });
    expect(await fs.readFile(file("report.csv"), "utf8")).toBe("v3 by hand");
  });

  it("marks an unchanged target addressed without a result or undo", async () => {
    await fs.writeFile(file("report.csv"), "same");
    const { service, annotations, events, add, addressing } = setup();
    const annotation = add({});
    await service.pinTarget(annotation.id);
    addressing(annotation.id);
    await service.settle("task-1");

    expect(annotations.get(annotation.id)).toMatchObject({ status: "addressed" });
    expect(annotations.get(annotation.id)?.resultRevisionId).toBeUndefined();
    expect(events[0].payload).toMatchObject({ changed: false });
    expect(events[0].payload).not.toHaveProperty("undoToken");
  });

  it("links a new version file without offering undo, since the source is untouched", async () => {
    await fs.writeFile(file("brief.pdf"), "v1");
    const { service, annotations, revisions, add, addressing } = setup();
    const annotation = add({
      targetRef: { surfaceType: "artifact", filePath: file("brief.pdf"), page: 2 },
      outputPath: file("brief-v2.pdf"),
    });
    await service.pinTarget(annotation.id);
    addressing(annotation.id);
    await fs.writeFile(file("brief-v2.pdf"), "v2");
    await service.settle("task-1");

    const addressed = annotations.get(annotation.id)!;
    expect(addressed.resultRevisionId).toBe("rev-2");
    expect(addressed.undoToken).toBeUndefined();
    expect(revisions.get("rev-2")).toMatchObject({
      path: file("brief-v2.pdf"),
      parentRevisionId: "rev-1",
    });
  });

  it("does not offer undo when the pointed-at file was too large to keep", async () => {
    await fs.writeFile(file("big.csv"), "0123456789");
    const { service, annotations, add, addressing } = setup({ maxBytes: 4 });
    const annotation = add({ targetRef: { surfaceType: "artifact", filePath: "big.csv" } });
    await service.pinTarget(annotation.id);
    addressing(annotation.id);
    await fs.writeFile(file("big.csv"), "9876543210");
    await service.settle("task-1");

    expect(annotations.get(annotation.id)?.resultRevisionId).toBe("rev-2");
    expect(annotations.get(annotation.id)?.undoToken).toBeUndefined();
  });

  it("never reads a file outside the task's folder", async () => {
    await fs.writeFile(path.join(dir, "outside.txt"), "secret");
    const { service, contract, add } = setup();
    const annotation = add({
      targetRef: { surfaceType: "file", filePath: "../outside.txt" },
    });
    const pinned = await service.pinTarget(annotation.id);
    expect(pinned?.artifactRevisionId).toBeUndefined();
    expect(contract.recordFileRevision).not.toHaveBeenCalled();
  });

  it("marks a browser annotation addressed with its anchor", async () => {
    const { service, annotations, events, add, addressing } = setup();
    const annotation = add({
      surfaceType: "browser",
      targetRef: { surfaceType: "browser", url: "http://localhost:5173", selector: "#cta" },
      intent: "change",
    });
    addressing(annotation.id);
    await service.settle("task-1");
    expect(annotations.get(annotation.id)?.status).toBe("addressed");
    expect(events[0].payload).toMatchObject({
      anchor: "http://localhost:5173 · #cta",
      intent: "change",
      changed: false,
    });
  });

  it("describes anchors by cells, page, block or selector", () => {
    const anchor = (targetRef: Record<string, unknown>) =>
      describeAnnotationAnchor({ targetRef } as unknown as Annotation);
    expect(anchor({ filePath: "/ws/a.pdf", page: 3 })).toBe("a.pdf · page 3");
    expect(anchor({ filePath: "/ws/a.docx", blockId: "p-4" })).toBe("a.docx · block p-4");
    expect(anchor({ filePath: "/ws/a.xlsx", cellRange: "C3" })).toBe("a.xlsx · C3");
  });
});
