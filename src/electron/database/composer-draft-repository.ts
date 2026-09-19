import Database from "better-sqlite3";

import {
  composerDraftMatchesOwner,
  normalizeComposerDraft,
  type ComposerDraft,
  type ComposerDraftGetRequest,
} from "../../shared/composer-drafts";

type ComposerDraftRow = {
  draft_key: string;
  workspace_id: string;
  task_id: string | null;
  surface: string;
  remote_device_id: string | null;
  payload_json: string;
  revision: number;
  updated_at: number;
  expires_at: number | null;
};

export class ComposerDraftRepository {
  constructor(private readonly db: Database.Database) {}

  get(draftKey: string, owner?: ComposerDraftGetRequest): ComposerDraft | null {
    const normalizedKey = typeof draftKey === "string" ? draftKey.trim() : "";
    if (!normalizedKey) return null;
    const row = this.db
      .prepare("SELECT * FROM composer_drafts WHERE draft_key = ? LIMIT 1")
      .get(normalizedKey) as ComposerDraftRow | undefined;
    if (!row) return null;
    const draft = normalizeComposerDraft(parsePayload(row.payload_json));
    if (!draft || draft.draftKey !== row.draft_key) return null;
    if (row.expires_at !== null && row.expires_at <= Date.now()) return null;
    if (owner && !composerDraftMatchesOwner(draft, owner)) return null;
    return draft;
  }

  upsertIfNewer(draft: ComposerDraft): boolean {
    const normalized = normalizeComposerDraft(draft);
    if (!normalized || normalized.draftKey !== draft.draftKey) return false;
    const payloadJson = JSON.stringify(normalized);
    const result = this.db
      .prepare(
        `
          INSERT INTO composer_drafts (
            draft_key,
            workspace_id,
            task_id,
            surface,
            remote_device_id,
            payload_json,
            revision,
            updated_at,
            expires_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(draft_key) DO UPDATE SET
            workspace_id = excluded.workspace_id,
            task_id = excluded.task_id,
            surface = excluded.surface,
            remote_device_id = excluded.remote_device_id,
            payload_json = excluded.payload_json,
            revision = excluded.revision,
            updated_at = excluded.updated_at,
            expires_at = excluded.expires_at
          WHERE excluded.revision > composer_drafts.revision
        `,
      )
      .run(
        normalized.draftKey,
        normalized.workspaceId,
        normalized.taskId,
        normalized.surface,
        normalized.remoteDeviceId ?? null,
        payloadJson,
        normalized.revision,
        normalized.updatedAt,
        normalized.expiresAt ?? null,
      );
    return result.changes > 0;
  }

  clear(draftKey: string, revision?: number): boolean {
    const normalizedKey = typeof draftKey === "string" ? draftKey.trim() : "";
    if (!normalizedKey) return false;
    const result =
      typeof revision === "number" && Number.isFinite(revision)
        ? this.db
            .prepare("DELETE FROM composer_drafts WHERE draft_key = ? AND revision <= ?")
            .run(normalizedKey, Math.floor(revision))
        : this.db.prepare("DELETE FROM composer_drafts WHERE draft_key = ?").run(normalizedKey);
    return result.changes > 0;
  }

  rekey(
    draftKey: string,
    nextDraftKey: string,
    nextOwner?: { taskId: string | null; remoteDeviceId?: string },
  ): boolean {
    const sourceKey = typeof draftKey === "string" ? draftKey.trim() : "";
    const destinationKey = typeof nextDraftKey === "string" ? nextDraftKey.trim() : "";
    if (!sourceKey || !destinationKey || sourceKey === destinationKey) return false;

    const transaction = this.db.transaction(() => {
      const source = this.db
        .prepare("SELECT * FROM composer_drafts WHERE draft_key = ? LIMIT 1")
        .get(sourceKey) as ComposerDraftRow | undefined;
      if (!source) return false;
      const sourceDraft = normalizeComposerDraft(parsePayload(source.payload_json));
      if (!sourceDraft || sourceDraft.draftKey !== sourceKey) return false;
      const destination = this.db
        .prepare("SELECT 1 FROM composer_drafts WHERE draft_key = ? LIMIT 1")
        .get(destinationKey);
      // Never overwrite a destination draft. The renderer may have started
      // editing it concurrently, and attachments are keyed independently from
      // this row. A safe no-op is preferable to a unique-constraint failure or
      // silently replacing newer user input.
      if (destination) return false;

      const nextTaskId = nextOwner?.taskId ?? sourceDraft.taskId;
      const nextRemoteDeviceId = nextOwner?.remoteDeviceId ?? sourceDraft.remoteDeviceId;
      const nextDraft: ComposerDraft = {
        ...sourceDraft,
        draftKey: destinationKey,
        taskId: nextTaskId,
        ...(nextRemoteDeviceId ? { remoteDeviceId: nextRemoteDeviceId } : {}),
      };

      const result = this.db
        .prepare(
          `
            UPDATE composer_drafts
            SET draft_key = ?,
                task_id = ?,
                remote_device_id = ?,
                payload_json = ?
            WHERE draft_key = ?
          `,
        )
        .run(
          destinationKey,
          nextTaskId,
          nextRemoteDeviceId ?? null,
          JSON.stringify(nextDraft),
          sourceKey,
        );
      return result.changes > 0;
    });

    return Boolean(transaction());
  }

  canRekey(draftKey: string, nextDraftKey: string): boolean {
    const sourceKey = typeof draftKey === "string" ? draftKey.trim() : "";
    const destinationKey = typeof nextDraftKey === "string" ? nextDraftKey.trim() : "";
    if (!sourceKey || !destinationKey || sourceKey === destinationKey) return false;
    const source = this.db
      .prepare("SELECT 1 FROM composer_drafts WHERE draft_key = ? LIMIT 1")
      .get(sourceKey);
    const destination = this.db
      .prepare("SELECT 1 FROM composer_drafts WHERE draft_key = ? LIMIT 1")
      .get(destinationKey);
    return Boolean(source) && !destination;
  }

  pruneExpired(now = Date.now()): number {
    return this.db
      .prepare("DELETE FROM composer_drafts WHERE expires_at IS NOT NULL AND expires_at <= ?")
      .run(now).changes;
  }

  listExpired(now = Date.now()): Array<{ draftKey: string; workspaceId: string }> {
    return this.db
      .prepare(
        "SELECT draft_key AS draftKey, workspace_id AS workspaceId FROM composer_drafts WHERE expires_at IS NOT NULL AND expires_at <= ?",
      )
      .all(now) as Array<{ draftKey: string; workspaceId: string }>;
  }

  listLiveAttachmentRefs(
    now = Date.now(),
  ): Array<{ draftKey: string; workspaceId: string; refId: string }> {
    const rows = this.db
      .prepare(
        `SELECT draft_key AS draftKey, workspace_id AS workspaceId, payload_json AS payloadJson
         FROM composer_drafts
         WHERE expires_at IS NULL OR expires_at > ?`,
      )
      .all(now) as Array<{ draftKey: string; workspaceId: string; payloadJson: string }>;
    const refs: Array<{ draftKey: string; workspaceId: string; refId: string }> = [];
    for (const row of rows) {
      const draft = normalizeComposerDraft(parsePayload(row.payloadJson));
      if (!draft || draft.draftKey !== row.draftKey || draft.workspaceId !== row.workspaceId) {
        continue;
      }
      for (const attachment of draft.attachments) {
        refs.push({
          draftKey: row.draftKey,
          workspaceId: row.workspaceId,
          refId: attachment.refId,
        });
      }
    }
    return refs;
  }
}

function parsePayload(payload: string): unknown {
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}
