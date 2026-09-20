import {
  buildComposerDraftKey,
  createEmptyComposerDraft,
  normalizeComposerDraft,
  type ComposerDraft,
  type ComposerDraftClearRequest,
  type ComposerDraftGetRequest,
  type ComposerDraftKeyInput,
  type ComposerDraftScope,
} from "../../shared/composer-drafts";

export interface ComposerDraftTransport {
  get?: (request: ComposerDraftGetRequest) => Promise<ComposerDraft | null>;
  upsert?: (draft: ComposerDraft) => Promise<{ accepted: boolean; draft: ComposerDraft | null }>;
  clear?: (request: ComposerDraftClearRequest) => Promise<{
    cleared: boolean;
    releasedAttachments: number;
  }>;
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
    if (persist) this.schedulePersist(normalized.draftKey);
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
    if (!draft || !this.transport.upsert) return;
    const revision = draft.revision;
    const write = this.writeChains.get(key) ?? Promise.resolve();
    const nextWrite = write
      .catch(() => undefined)
      .then(async () => {
        const current = this.drafts.get(key);
        if (!current || current.revision < revision) return;
        await this.transport.upsert?.(current);
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
    return this.clearAfterAcceptedAtKey(input, key, submittedRevision);
  }

  private async clearAfterAcceptedAtKey(
    input: ComposerDraftKeyInput,
    key: string,
    submittedRevision: number,
  ): Promise<boolean> {
    const pendingClear = this.clearChains.get(key);
    if (pendingClear) {
      await pendingClear.catch(() => false);
      return this.clearAfterAcceptedAtKey(input, key, submittedRevision);
    }

    const current = this.drafts.get(key);
    if (!current || current.revision !== submittedRevision) return false;
    const timer = this.timers.get(key);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(key);
    }

    const pendingWrite = this.writeChains.get(key);
    const clear = this.finishAcceptedClear(input, key, submittedRevision, pendingWrite);
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
    submittedRevision: number,
    pendingWrite?: Promise<void>,
  ): Promise<boolean> {
    // Any load that started before acceptance must not be allowed to restore
    // the just-accepted revision after the durable clear completes.
    this.loadGenerations.set(key, (this.loadGenerations.get(key) ?? 0) + 1);

    // A blur/unmount flush may already be writing this revision. Wait for it
    // before deleting the persisted row; otherwise that older upsert can
    // finish after the delete and resurrect the accepted draft.
    if (pendingWrite) await pendingWrite.catch(() => undefined);
    if (this.drafts.get(key)?.revision !== submittedRevision) return false;

    if (this.transport.clear) {
      const result = await this.transport.clear({
        draftKey: key,
        scope: input.scope,
        workspaceId: input.workspaceId,
        surface: input.surface ?? "main",
        taskId: input.taskId ?? null,
        ...(input.remoteDeviceId ? { remoteDeviceId: input.remoteDeviceId } : {}),
        revision: submittedRevision,
      });
      // A draft can be accepted before its debounce timer has reached the
      // database. In that case the main process has nothing to delete, but the
      // renderer must still discard the accepted in-memory revision. Recheck
      // the revision after the IPC round-trip so a newer edit remains safe.
      if (!result.cleared && this.drafts.get(key)?.revision !== submittedRevision) {
        return false;
      }
    }
    if (this.drafts.get(key)?.revision !== submittedRevision) return false;
    this.drafts.delete(key);
    this.emit(key, null);
    return true;
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

export function createWindowComposerDraftTransport(): ComposerDraftTransport {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  return {
    get: api?.getComposerDraft,
    upsert: api?.upsertComposerDraft,
    clear: api?.clearComposerDraft,
  };
}

export const composerDraftStore = new ComposerDraftStore({
  transport: createWindowComposerDraftTransport(),
});
