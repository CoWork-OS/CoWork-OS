import {
  buildComposerDraftKey,
  createEmptyComposerDraft,
  normalizeComposerDraft,
  type ComposerDraft,
  type ComposerDraftAttachmentPutRequest,
  type ComposerDraftClearRequest,
  type ComposerDraftGetRequest,
  type ComposerDraftKeyInput,
  type ComposerDraftScope,
  type DraftAttachmentRef,
} from "../../shared/composer-drafts";

export interface ComposerDraftTransport {
  get?: (request: ComposerDraftGetRequest) => Promise<ComposerDraft | null>;
  upsert?: (draft: ComposerDraft) => Promise<{ accepted: boolean; draft: ComposerDraft | null }>;
  clear?: (request: ComposerDraftClearRequest) => Promise<{
    cleared: boolean;
    releasedAttachments: number;
  }>;
  putAttachment?: (request: ComposerDraftAttachmentPutRequest) => Promise<unknown>;
}

export type ComposerDraftListener = (draft: ComposerDraft | null) => void;

export interface ComposerDraftStoreOptions {
  debounceMs?: number;
  transport?: ComposerDraftTransport;
  now?: () => number;
}

export class ComposerDraftStore {
  private readonly drafts = new Map<string, ComposerDraft>();
  private readonly listeners = new Map<string, Set<ComposerDraftListener>>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly loadGenerations = new Map<string, number>();
  private readonly dirtyRevisions = new Map<string, number>();
  private readonly writeChains = new Map<string, Promise<void>>();
  private readonly clearChains = new Map<string, Promise<boolean>>();
  private readonly debounceMs: number;
  private readonly transport: ComposerDraftTransport;
  private readonly now: () => number;

  constructor(options: ComposerDraftStoreOptions = {}) {
    this.debounceMs = Math.max(0, Math.floor(options.debounceMs ?? 200));
    this.transport = options.transport ?? {};
    this.now = options.now ?? Date.now;
  }

  get(key: string): ComposerDraft | null {
    return this.drafts.get(key) ?? null;
  }

  subscribe(key: string, listener: ComposerDraftListener): () => void {
    const listeners = this.listeners.get(key) ?? new Set<ComposerDraftListener>();
    listeners.add(listener);
    this.listeners.set(key, listeners);
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(key);
    };
  }

  async load(input: ComposerDraftKeyInput): Promise<ComposerDraft | null> {
    const key = buildComposerDraftKey(input);
    const generation = (this.loadGenerations.get(key) ?? 0) + 1;
    this.loadGenerations.set(key, generation);
    const request: ComposerDraftGetRequest = {
      draftKey: key,
      scope: input.scope,
      workspaceId: input.workspaceId,
      surface: input.surface ?? "main",
      taskId: input.taskId ?? null,
      ...(input.remoteDeviceId ? { remoteDeviceId: input.remoteDeviceId } : {}),
    };

    let loaded: ComposerDraft | null = null;
    try {
      loaded = this.transport.get ? await this.transport.get(request) : null;
    } catch {
      // Draft restoration is best effort. A task/workspace transition or a
      // transient IPC failure must not become an unhandled promise rejection;
      // the current in-memory draft remains authoritative for this load.
      return this.get(key);
    }
    if (this.loadGenerations.get(key) !== generation) return this.get(key);
    const normalized = normalizeComposerDraft(loaded);
    if (normalized) {
      const current = this.drafts.get(key);
      // A persisted revision never authorizes replacing a local edit that has
      // not been acknowledged by an accepted upsert yet. This remains true
      // when a second load starts after the edit itself.
      if (this.dirtyRevisions.has(key) && current) {
        const reconciled = {
          ...current,
          revision: Math.max(current.revision, normalized.revision + 1),
          updatedAt: Math.max(current.updatedAt, normalized.updatedAt),
        };
        this.drafts.set(key, reconciled);
        this.dirtyRevisions.set(key, reconciled.revision);
        this.emit(key, reconciled);
        this.schedulePersist(key);
        return reconciled;
      }
      if (current && current.revision > normalized.revision) return current;
      this.drafts.set(key, normalized);
      this.emit(key, normalized);
    } else if (!this.drafts.has(key)) {
      this.emit(key, null);
    }
    return normalized;
  }

  ensure(input: ComposerDraftKeyInput): ComposerDraft {
    const key = buildComposerDraftKey(input);
    const existing = this.drafts.get(key);
    if (existing) return existing;
    const created = createEmptyComposerDraft(input, this.now());
    this.drafts.set(key, created);
    this.emit(key, created);
    return created;
  }

  update(
    input: ComposerDraftKeyInput,
    patch: Partial<
      Pick<ComposerDraft, "text" | "mentions" | "quotedAssistantMessage" | "attachments">
    >,
  ): ComposerDraft {
    const current = this.ensure(input);
    const next: ComposerDraft = {
      ...current,
      ...patch,
      revision: current.revision + 1,
      updatedAt: this.now(),
    };
    this.drafts.set(next.draftKey, next);
    this.dirtyRevisions.set(next.draftKey, next.revision);
    this.emit(next.draftKey, next);
    this.schedulePersist(next.draftKey);
    return next;
  }

  setDraft(draft: ComposerDraft, persist = false): ComposerDraft {
    const normalized = normalizeComposerDraft(draft);
    if (!normalized) throw new Error("Invalid composer draft.");
    const current = this.drafts.get(normalized.draftKey);
    if (current && current.revision > normalized.revision) return current;
    this.drafts.set(normalized.draftKey, normalized);
    this.emit(normalized.draftKey, normalized);
    if (persist) {
      this.dirtyRevisions.set(normalized.draftKey, normalized.revision);
      this.schedulePersist(normalized.draftKey);
    }
    return normalized;
  }

  async flush(key: string): Promise<void> {
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }

    const pendingClear = this.clearChains.get(key);
    if (pendingClear) {
      await pendingClear.catch(() => false);
      if (this.drafts.has(key)) await this.flush(key);
      return;
    }

    const draft = this.drafts.get(key);
    if (!draft || !this.transport.upsert || !this.dirtyRevisions.has(key)) return;
    const write = this.writeChains.get(key) ?? Promise.resolve();
    const nextWrite = write
      .catch(() => undefined)
      .then(async () => {
        const current = this.drafts.get(key);
        if (!current || !this.dirtyRevisions.has(key)) return;
        // A queued flush writes the latest edit, not the revision that queued
        // it. Acknowledge that exact revision so a second navigation/unmount
        // flush cannot rebase an unchanged, already-persisted submission.
        const revision = current.revision;
        const result = await this.transport.upsert?.(current);
        // Rebase only onto a known authoritative revision. A rejection without one
        // (expired row, invalid draft) waits for the next edit instead of looping.
        if (
          result &&
          !result.accepted &&
          result.draft &&
          this.drafts.get(key)?.revision === revision
        ) {
          const rebased = {
            ...current,
            revision: Math.max(revision, result.draft.revision + 1),
            updatedAt: Math.max(current.updatedAt, result.draft.updatedAt ?? 0),
          };
          this.drafts.set(key, rebased);
          this.dirtyRevisions.set(key, rebased.revision);
          this.emit(key, rebased);
        } else if (result?.accepted && this.drafts.get(key)?.revision === revision) {
          this.dirtyRevisions.delete(key);
        }
        if (this.drafts.get(key)?.revision !== revision) {
          this.schedulePersist(key);
        }
      });
    this.writeChains.set(key, nextWrite);
    try {
      await nextWrite;
    } catch {
      // Keep the in-memory draft after a transient IPC/database failure. A
      // later edit, visibility change, or unmount will retry the newest
      // revision rather than dropping user input.
    } finally {
      if (this.writeChains.get(key) === nextWrite) this.writeChains.delete(key);
    }
  }

  async clearAfterAccepted(
    input: ComposerDraftKeyInput,
    submittedRevision: number,
  ): Promise<boolean> {
    const key = buildComposerDraftKey(input);
    return this.clearAfterAcceptedAtKey(input, key, submittedRevision);
  }

  async clearAfterAcceptedDraft(
    submittedDraft: ComposerDraft,
    submittedRevision: number,
  ): Promise<boolean> {
    const scope: ComposerDraftScope = submittedDraft.remoteDeviceId ? "remote" : "local";
    const input: ComposerDraftKeyInput = {
      scope,
      workspaceId: submittedDraft.workspaceId,
      taskId: submittedDraft.taskId,
      surface: submittedDraft.surface,
      ...(submittedDraft.remoteDeviceId ? { remoteDeviceId: submittedDraft.remoteDeviceId } : {}),
    };
    const key = buildComposerDraftKey(input);
    if (key !== submittedDraft.draftKey) return false;
    return this.clearAfterAcceptedAtKey(input, key, submittedRevision, submittedDraft);
  }

  private async clearAfterAcceptedAtKey(
    input: ComposerDraftKeyInput,
    key: string,
    submittedRevision: number,
    submittedDraft?: ComposerDraft,
  ): Promise<boolean> {
    const pendingClear = this.clearChains.get(key);
    if (pendingClear) {
      await pendingClear.catch(() => false);
      return this.clearAfterAcceptedAtKey(input, key, submittedRevision, submittedDraft);
    }

    const current = this.drafts.get(key);
    if (!current) return false;
    const submitted =
      current.revision === submittedRevision
        ? current
        : submittedDraft?.revision === submittedRevision
          ? submittedDraft
          : null;
    if (!submitted) return false;
    // Automatic patches (attachment status, mention cleanup) can land between
    // the send and this clear. They carry the accepted prompt forward, so they
    // are not newer user input; only what differs from the submission is kept.
    if (current.revision !== submittedRevision && this.keepUnsentRemainder(key, submitted)) {
      return false;
    }
    const clearRevision = current.revision;
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }

    const pendingWrite = this.writeChains.get(key);
    const clear = this.finishAcceptedClear(input, key, clearRevision, submitted, pendingWrite);
    this.clearChains.set(key, clear);
    try {
      return await clear;
    } finally {
      if (this.clearChains.get(key) === clear) this.clearChains.delete(key);
    }
  }

  private async finishAcceptedClear(
    input: ComposerDraftKeyInput,
    key: string,
    clearRevision: number,
    submitted: ComposerDraft,
    pendingWrite?: Promise<void>,
  ): Promise<boolean> {
    // Any load that started before acceptance must not be allowed to restore
    // the just-accepted revision after the durable clear completes.
    this.loadGenerations.set(key, (this.loadGenerations.get(key) ?? 0) + 1);

    // A blur/unmount flush may already be writing this revision. Wait for it
    // before deleting the persisted row; otherwise that older upsert can
    // finish after the delete and resurrect the accepted draft.
    if (pendingWrite) await pendingWrite.catch(() => undefined);
    if (
      this.drafts.get(key)?.revision !== clearRevision &&
      this.keepUnsentRemainder(key, submitted)
    ) {
      return false;
    }

    if (this.transport.clear) {
      // The persisted row may hold any revision up to the local one, all of
      // which only carry the accepted prompt.
      await this.transport.clear({
        draftKey: key,
        scope: input.scope,
        workspaceId: input.workspaceId,
        surface: input.surface ?? "main",
        taskId: input.taskId ?? null,
        ...(input.remoteDeviceId ? { remoteDeviceId: input.remoteDeviceId } : {}),
        revision: Math.max(clearRevision, this.drafts.get(key)?.revision ?? 0),
      });
      // A draft can be accepted before its debounce timer has reached the
      // database, so "nothing to delete" still discards the accepted local
      // revision. A newer edit made during the round-trip keeps only what the
      // user added after the send.
    }
    if (
      this.drafts.get(key)?.revision !== clearRevision &&
      this.keepUnsentRemainder(key, submitted)
    ) {
      return false;
    }
    this.drafts.delete(key);
    this.dirtyRevisions.delete(key);
    this.emit(key, null);
    return true;
  }

  /**
   * Replace the local draft with whatever was added after `submitted` was
   * sent. Returns false when nothing remains, so the caller discards it.
   */
  private keepUnsentRemainder(key: string, submitted: ComposerDraft): boolean {
    const latest = this.drafts.get(key);
    if (!latest) return false;
    const textChanged = latest.text !== submitted.text;
    const sentRefIds = new Set(submitted.attachments.map((attachment) => attachment.refId));
    const remainder: ComposerDraft = {
      ...latest,
      text: textChanged ? latest.text : "",
      mentions: textChanged ? latest.mentions : [],
      quotedAssistantMessage: textChanged ? latest.quotedAssistantMessage : undefined,
      attachments: latest.attachments.filter((attachment) => !sentRefIds.has(attachment.refId)),
    };
    if (isEmptyComposerDraft(remainder)) return false;
    if (
      remainder.text === latest.text &&
      remainder.attachments.length === latest.attachments.length
    ) {
      return true;
    }
    const next = { ...remainder, revision: latest.revision + 1, updatedAt: this.now() };
    this.drafts.set(key, next);
    this.dirtyRevisions.set(key, next.revision);
    this.emit(key, next);
    this.schedulePersist(key);
    return true;
  }

  /**
   * Move an unsent draft to another owner, such as a new session whose folder
   * changed. The source is cleared so it cannot resurface there later (for
   * example when the app reopens the last scratch workspace on launch).
   */
  async carry(from: ComposerDraftKeyInput, to: ComposerDraftKeyInput): Promise<boolean> {
    const fromKey = buildComposerDraftKey(from);
    const toKey = buildComposerDraftKey(to);
    const source = this.drafts.get(fromKey);
    if (fromKey === toKey || !source || isEmptyComposerDraft(source)) return false;
    await this.flush(fromKey);

    const attachments: DraftAttachmentRef[] = [];
    for (const attachment of source.attachments) {
      const copied = await this.copyAttachment(attachment, from, fromKey, to, toKey);
      if (copied) attachments.push(copied);
    }
    this.update(to, {
      text: source.text,
      mentions: source.mentions,
      quotedAssistantMessage: source.quotedAssistantMessage,
      attachments,
    });
    await this.clearAfterAccepted(from, this.drafts.get(fromKey)?.revision ?? source.revision);
    return true;
  }

  private async copyAttachment(
    attachment: DraftAttachmentRef,
    from: ComposerDraftKeyInput,
    fromKey: string,
    to: ComposerDraftKeyInput,
    toKey: string,
  ): Promise<DraftAttachmentRef | null> {
    if (!this.transport.putAttachment) return null;
    try {
      const result = await this.transport.putAttachment({
        ...toOwnerRequest(to, toKey),
        name: attachment.name,
        size: attachment.size,
        ...(attachment.mimeType ? { mimeType: attachment.mimeType } : {}),
        copyFrom: { ...toOwnerRequest(from, fromKey), refId: attachment.refId },
      });
      const ref = result as DraftAttachmentRef | null;
      return ref && typeof ref.refId === "string" ? ref : null;
    } catch {
      // A file that can no longer be copied is dropped, like any other
      // unavailable draft attachment; the text still moves.
      return null;
    }
  }

  async flushAll(): Promise<void> {
    await Promise.all([...this.drafts.keys()].map((key) => this.flush(key)));
  }

  private schedulePersist(key: string): void {
    if (!this.transport.upsert) return;
    const previous = this.timers.get(key);
    if (previous) clearTimeout(previous);
    const timer = setTimeout(() => {
      this.timers.delete(key);
      void this.flush(key);
    }, this.debounceMs);
    this.timers.set(key, timer);
  }

  private emit(key: string, draft: ComposerDraft | null): void {
    for (const listener of this.listeners.get(key) ?? []) listener(draft);
  }
}

function isEmptyComposerDraft(draft: ComposerDraft): boolean {
  return (
    !draft.text.trim() &&
    draft.mentions.length === 0 &&
    draft.attachments.length === 0 &&
    !draft.quotedAssistantMessage
  );
}

function toOwnerRequest(input: ComposerDraftKeyInput, draftKey: string) {
  return {
    draftKey,
    scope: input.scope,
    workspaceId: input.workspaceId,
    surface: input.surface ?? "main",
    taskId: input.taskId ?? null,
    ...(input.remoteDeviceId ? { remoteDeviceId: input.remoteDeviceId } : {}),
  };
}

export function createWindowComposerDraftTransport(): ComposerDraftTransport {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  return {
    get: api?.getComposerDraft,
    upsert: api?.upsertComposerDraft,
    clear: api?.clearComposerDraft,
    putAttachment: api?.putComposerDraftAttachment,
  };
}

export const composerDraftStore = new ComposerDraftStore({
  transport: createWindowComposerDraftTransport(),
});
