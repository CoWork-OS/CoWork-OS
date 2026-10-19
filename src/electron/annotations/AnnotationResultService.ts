import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { Annotation, AnnotationUndoResult, ArtifactRevision } from "../../shared/types";
import type { AnnotationRepository } from "../database/repository-facades";
import type { WorkSessionContractService } from "../sessions/WorkSessionContractService";
import type { RevisionSnapshotStore } from "./revision-snapshots";

export interface AnnotationResultDeps {
  annotations: Pick<
    AnnotationRepository,
    "findById" | "list" | "setBaseRevision" | "recordResult" | "clearUndo"
  >;
  contract: Pick<WorkSessionContractService, "recordFileRevision" | "getArtifactRevision">;
  snapshots: RevisionSnapshotStore;
  /** The folder of a task's workspace. Files outside it are never read or written. */
  workspaceRootForTask(taskId: string): Promise<string | undefined>;
  logEvent(taskId: string, type: string, payload: Record<string, unknown>): void;
  log?: (message: string, error?: unknown) => void;
}

type AnchorFields = {
  filePath?: string;
  url?: string;
  sheetName?: string;
  cellRange?: string;
  page?: number;
  blockId?: string;
  selector?: string;
};

/** The file an annotation points into, when it points into one. */
export function annotationTargetFile(annotation: Annotation): string | undefined {
  const target = annotation.targetRef as AnchorFields & { surfaceType?: string };
  return (target.surfaceType === "file" ||
    target.surfaceType === "artifact" ||
    target.surfaceType === "diff") &&
    typeof target.filePath === "string" &&
    target.filePath.trim()
    ? target.filePath.trim()
    : undefined;
}

/** A short place name for an annotation's anchor: file and cells, page, block or selector. */
export function describeAnnotationAnchor(annotation: Annotation): string {
  const target = annotation.targetRef as AnchorFields;
  const where =
    target.sheetName && target.cellRange
      ? `${target.sheetName}!${target.cellRange}`
      : target.cellRange ||
        (typeof target.page === "number" ? `page ${target.page}` : "") ||
        (target.blockId ? `block ${target.blockId}` : "") ||
        target.selector ||
        "";
  const file = target.filePath ? path.basename(target.filePath) : target.url || "";
  return [file, where].filter(Boolean).join(" · ");
}

function sameToken(stored: string, offered: string): boolean {
  const a = Buffer.from(stored);
  const b = Buffer.from(offered);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** `filePath` inside `root` (after resolving links), or undefined when it is outside. */
async function resolveInside(root: string, filePath: string): Promise<string | undefined> {
  const absolute = path.resolve(root, filePath);
  let realRoot: string;
  try {
    realRoot = await fs.realpath(root);
  } catch {
    return undefined;
  }
  let real: string;
  try {
    real = await fs.realpath(absolute);
  } catch {
    try {
      real = path.join(await fs.realpath(path.dirname(absolute)), path.basename(absolute));
    } catch {
      return undefined;
    }
  }
  const relative = path.relative(realRoot, real);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? real : undefined;
}

/**
 * Point at the result: links an annotation to the revision of the file it points at, to the
 * revision that addressed it, and undoes that change by restoring the earlier revision.
 */
export class AnnotationResultService {
  private readonly undoing = new Set<string>();

  constructor(private readonly deps: AnnotationResultDeps) {}

  private async locate(taskId: string, filePath: string) {
    const root = await this.deps.workspaceRootForTask(taskId);
    if (!root) return undefined;
    const resolved = await resolveInside(root, filePath);
    return resolved ? { absolute: path.resolve(root, filePath), resolved } : undefined;
  }

  /** Remove kept revision bytes unused for 30 days. */
  async pruneSnapshots(): Promise<number> {
    return this.deps.snapshots.prune();
  }

  /** Record the revision of the file an annotation points at, keeping its bytes for undo. */
  async pinTarget(annotationId: string): Promise<Annotation | undefined> {
    const annotation = await this.deps.annotations.findById(annotationId);
    if (!annotation || annotation.artifactRevisionId) return annotation;
    const filePath = annotationTargetFile(annotation);
    if (!filePath) return annotation;
    const located = await this.locate(annotation.taskId, filePath);
    if (!located) return annotation;
    const snapshot = await this.deps.snapshots.capture(located.resolved);
    if (!snapshot) return annotation;
    const revision = this.deps.contract.recordFileRevision(annotation.taskId, {
      path: located.absolute,
      sha256: snapshot.sha256,
      size: snapshot.size,
      createdBy: "user",
      metadata: { annotationId, role: "annotation_target", kept: snapshot.kept },
      idempotencyKey: `annotation-target:${annotationId}`,
    });
    if (!revision) return annotation;
    return (await this.deps.annotations.setBaseRevision(annotationId, revision.id)) ?? annotation;
  }

  /**
   * After the agent's turn: every annotation it was addressing becomes `addressed`. When the
   * file changed, the change is recorded as a revision of the one the user pointed at and, when
   * that one's bytes are kept, can be undone.
   */
  async settle(taskId: string): Promise<number> {
    const addressing = await this.deps.annotations.list({
      taskId,
      statuses: ["addressing"],
      limit: 100,
    });
    let settled = 0;
    for (const annotation of addressing) {
      try {
        await this.settleOne(annotation);
        settled += 1;
      } catch (error) {
        this.deps.log?.(`Could not settle annotation ${annotation.id}`, error);
      }
    }
    return settled;
  }

  private async settleOne(annotation: Annotation): Promise<void> {
    const base = annotation.artifactRevisionId
      ? this.deps.contract.getArtifactRevision(annotation.artifactRevisionId)
      : undefined;
    const targetFile = annotationTargetFile(annotation);
    const outputFile = annotation.outputPath || targetFile;
    let result: ArtifactRevision | undefined;
    let undoToken: string | undefined;
    if (outputFile) {
      const located = await this.locate(annotation.taskId, outputFile);
      const snapshot = located ? await this.deps.snapshots.capture(located.resolved) : undefined;
      const inPlace = !annotation.outputPath || annotation.outputPath === targetFile;
      // In place, a change is a different hash from the pointed-at revision; a new version
      // (document editor) is any file at the output path.
      const changed = Boolean(
        located && snapshot && (inPlace ? base && snapshot.sha256 !== base.sha256 : true),
      );
      if (located && snapshot && changed) {
        result = this.deps.contract.recordFileRevision(annotation.taskId, {
          path: located.absolute,
          sha256: snapshot.sha256,
          size: snapshot.size,
          ...(base ? { parentRevisionId: base.id } : {}),
          ...(base?.mimeType ? { mimeType: base.mimeType } : {}),
          createdBy: "agent",
          metadata: { annotationId: annotation.id, role: "annotation_result" },
          idempotencyKey: `annotation-result:${annotation.id}`,
        });
        if (result && inPlace && base && (await this.deps.snapshots.has(base.sha256))) {
          undoToken = crypto.randomUUID();
        }
      }
    }
    await this.deps.annotations.recordResult(annotation.id, {
      ...(result ? { resultRevisionId: result.id } : {}),
      ...(undoToken ? { undoToken } : {}),
    });
    this.deps.logEvent(annotation.taskId, "annotation_addressed", {
      annotationId: annotation.id,
      surfaceType: annotation.surfaceType,
      anchor: describeAnnotationAnchor(annotation),
      ...(annotation.intent ? { intent: annotation.intent } : {}),
      ...(result ? { filePath: result.path, resultRevisionId: result.id } : {}),
      changed: Boolean(result),
      ...(undoToken ? { undoToken } : {}),
    });
  }

  /** Undo the change that addressed an annotation: restore the revision the user pointed at. */
  async undo(annotationId: string, token: string): Promise<AnnotationUndoResult> {
    if (this.undoing.has(annotationId)) {
      return { ok: false, error: "This change is already being undone." };
    }
    this.undoing.add(annotationId);
    try {
      return await this.undoOnce(annotationId, token);
    } finally {
      this.undoing.delete(annotationId);
    }
  }

  private async undoOnce(annotationId: string, token: string): Promise<AnnotationUndoResult> {
    const annotation = await this.deps.annotations.findById(annotationId);
    if (!annotation) return { ok: false, error: "Annotation not found." };
    if (!annotation.undoToken || !token || !sameToken(annotation.undoToken, token)) {
      return { ok: false, error: "This change can no longer be undone." };
    }
    const base = annotation.artifactRevisionId
      ? this.deps.contract.getArtifactRevision(annotation.artifactRevisionId)
      : undefined;
    const result = annotation.resultRevisionId
      ? this.deps.contract.getArtifactRevision(annotation.resultRevisionId)
      : undefined;
    if (!base || !result) return { ok: false, error: "The revisions of this change are missing." };
    const located = await this.locate(annotation.taskId, result.path);
    if (!located) return { ok: false, error: "The file is outside the task's folder." };
    const current = await this.deps.snapshots.capture(located.resolved);
    if (!current || current.sha256 !== result.sha256) {
      return {
        ok: false,
        error: "The file changed after this edit. Undoing it now would discard the later changes.",
      };
    }
    if (!(await this.deps.snapshots.has(base.sha256))) {
      return { ok: false, error: "The earlier version is no longer kept." };
    }
    await this.deps.snapshots.restore(base.sha256, located.resolved);
    const restored = this.deps.contract.recordFileRevision(annotation.taskId, {
      path: result.path,
      sha256: base.sha256,
      size: base.size,
      mimeType: result.mimeType,
      parentRevisionId: result.id,
      createdBy: "user",
      metadata: {
        annotationId,
        role: "annotation_undo",
        restores: base.id,
        reverts: result.id,
      },
      idempotencyKey: `annotation-undo:${annotationId}`,
    });
    const updated = await this.deps.annotations.clearUndo(annotationId);
    this.deps.logEvent(annotation.taskId, "annotation_change_undone", {
      annotationId,
      anchor: describeAnnotationAnchor(annotation),
      filePath: result.path,
      restoredRevisionId: base.id,
      ...(restored ? { revisionId: restored.id } : {}),
    });
    return { ok: true, ...(updated ? { annotation: updated } : {}) };
  }
}
