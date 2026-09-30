import {
  buildComposerDraftKey,
  composerDraftMatchesOwner,
  normalizeComposerDraft,
  type ComposerDraft,
  type ComposerDraftClearRequest,
  type ComposerDraftGetRequest,
  type ComposerDraftRekeyRequest,
} from "../../shared/composer-drafts";

const STORAGE_SCHEMA_VERSION = 1;
const MAX_STORED_DRAFTS = 64;
const MAX_STORAGE_CHARACTERS = 2 * 1024 * 1024;

export interface BrowserComposerDraftOwner extends ComposerDraftGetRequest {}

export interface BrowserComposerDraftStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export interface BrowserComposerDraftLockManager {
  request<T>(name: string, callback: () => T | Promise<T>): Promise<T>;
}

export interface BrowserComposerDraftBridgeOptions {
  installationId: string;
  profileId: string;
  storage?: BrowserComposerDraftStorage;
  lockManager?: BrowserComposerDraftLockManager;
  now?: () => number;
  isActive?: () => boolean;
  rekeyAttachments?: (
    fromOwner: BrowserComposerDraftOwner,
    toOwner: BrowserComposerDraftOwner,
  ) => { rekeyedAttachmentCount: number; rollback: () => void } | false;
  releaseAttachments?: (
    owner: BrowserComposerDraftOwner,
    refs: ComposerDraft["attachments"],
  ) => { releasedAttachmentCount: number };
}

export interface BrowserComposerDraftMethods {
  getComposerDraft(request: ComposerDraftGetRequest): Promise<ComposerDraft | null>;
  upsertComposerDraft(draft: ComposerDraft): Promise<{
    accepted: boolean;
    draft: ComposerDraft | null;
  }>;
  clearComposerDraft(request: ComposerDraftClearRequest): Promise<{
    cleared: boolean;
    releasedAttachments: number;
  }>;
  rekeyComposerDraft(request: ComposerDraftRekeyRequest): Promise<{
    rekeyed: boolean;
    rekeyedAttachmentCount: number;
  }>;
}

interface StoredDrafts {
  schemaVersion: typeof STORAGE_SCHEMA_VERSION;
  drafts: Record<string, ComposerDraft>;
}

/**
 * Browser-only storage for the renderer's composer draft DTO. The key is
 * isolated by host installation and profile. Attachment bytes stay in the
 * file bridge's in-memory staging area; this adapter persists opaque refs only.
 */
export function createBrowserComposerDraftBridge(options: BrowserComposerDraftBridgeOptions): {
  methods: BrowserComposerDraftMethods;
  dispose: () => void;
} {
  const installationId = normalizeIdentityPart(options.installationId, "installationId");
  const profileId = normalizeIdentityPart(options.profileId, "profileId");
  const storageKey = `cowork:browser-composer-drafts:${encodeURIComponent(installationId)}:${encodeURIComponent(profileId)}`;
  const lockName = `${storageKey}:mutation`;
  const now = options.now ?? Date.now;
  let disposed = false;

  const ensureActive = () => {
    if (disposed || options.isActive?.() === false) {
      throw new Error("This browser composer draft bridge is no longer active.");
    }
  };

  const storage = (): BrowserComposerDraftStorage => {
    ensureActive();
    if (options.storage) return options.storage;
    if (typeof window === "undefined") {
      throw new Error("Browser storage is unavailable for composer drafts.");
    }
    try {
      return window.localStorage;
    } catch {
      throw new Error("Browser storage is unavailable for composer drafts.");
    }
  };

  const withMutationLock = async <T>(operation: () => T | Promise<T>): Promise<T> => {
    ensureActive();
    const manager = options.lockManager ?? browserLockManager();
    if (!manager) {
      throw new Error("This browser does not support safe cross-tab composer draft updates.");
    }
    return manager.request(lockName, async () => {
      ensureActive();
      return operation();
    });
  };

  const readDrafts = (): Map<string, ComposerDraft> => {
    const raw = storage().getItem(storageKey);
    if (raw === null) return new Map();
    if (raw.length > MAX_STORAGE_CHARACTERS) {
      throw new Error("Stored browser composer drafts exceed the storage limit.");
    }

    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      throw new Error("Stored browser composer drafts are invalid and were left untouched.");
    }
    if (
      !isRecord(value) ||
      value.schemaVersion !== STORAGE_SCHEMA_VERSION ||
      !isRecord(value.drafts)
    ) {
      throw new Error("Stored browser composer drafts are invalid and were left untouched.");
    }

    const entries = Object.entries(value.drafts);
    if (entries.length > MAX_STORED_DRAFTS) {
      throw new Error("Stored browser composer drafts exceed the record limit.");
    }
    const drafts = new Map<string, ComposerDraft>();
    for (const [key, candidate] of entries) {
      const draft = normalizeOwnedDraft(candidate);
      if (draft && draft.draftKey === key) drafts.set(key, draft);
    }
    return drafts;
  };

  const writeDrafts = (drafts: Map<string, ComposerDraft>): void => {
    if (drafts.size > MAX_STORED_DRAFTS) {
      throw new Error("The browser has reached its saved composer draft limit.");
    }
    const persisted: StoredDrafts = {
      schemaVersion: STORAGE_SCHEMA_VERSION,
      drafts: Object.fromEntries(drafts),
    };
    const serialized = JSON.stringify(persisted);
    if (serialized.length > MAX_STORAGE_CHARACTERS) {
      throw new Error("The browser has reached its saved composer draft storage limit.");
    }
    try {
      storage().setItem(storageKey, serialized);
    } catch (error) {
      if (isQuotaExceeded(error)) {
        throw new Error("The browser could not save this composer draft because storage is full.");
      }
      throw new Error("The browser could not save this composer draft.");
    }
  };

  const getComposerDraft: BrowserComposerDraftMethods["getComposerDraft"] = async (request) => {
    const owner = validateOwner(request);
    const draft = readDrafts().get(owner.draftKey) ?? null;
    if (!draft || (typeof draft.expiresAt === "number" && draft.expiresAt <= now())) return null;
    return composerDraftMatchesOwner(draft, owner) ? cloneDraft(draft) : null;
  };

  const upsertComposerDraft: BrowserComposerDraftMethods["upsertComposerDraft"] = async (value) => {
    const draft = requireOwnedDraft(value);
    return withMutationLock(() => {
      const drafts = readDrafts();
      const existing = drafts.get(draft.draftKey);
      const accepted = !existing || draft.revision > existing.revision;
      if (accepted) {
        drafts.set(draft.draftKey, draft);
        writeDrafts(drafts);
      }
      const stored = drafts.get(draft.draftKey) ?? null;
      const visible =
        stored && stored.expiresAt !== undefined && stored.expiresAt <= now() ? null : stored;
      return { accepted, draft: visible ? cloneDraft(visible) : null };
    });
  };

  const clearComposerDraft: BrowserComposerDraftMethods["clearComposerDraft"] = async (request) => {
    const owner = validateOwner(request);
    const revision = request.revision;
    if (
      revision !== undefined &&
      (!Number.isInteger(revision) || !Number.isFinite(revision) || revision < 0)
    ) {
      throw new Error("Invalid composer draft revision.");
    }
    return withMutationLock(() => {
      const drafts = readDrafts();
      const current = drafts.get(owner.draftKey);
      const cleared = Boolean(
        current &&
        composerDraftMatchesOwner(current, owner) &&
        (revision === undefined || current.revision <= revision),
      );
      if (!cleared || !current) return { cleared: false, releasedAttachments: 0 };

      drafts.delete(owner.draftKey);
      writeDrafts(drafts);
      const result = options.releaseAttachments?.(owner, current.attachments);
      return {
        cleared: true,
        releasedAttachments: nonNegativeCount(result?.releasedAttachmentCount),
      };
    });
  };

  const rekeyComposerDraft: BrowserComposerDraftMethods["rekeyComposerDraft"] = async (request) => {
    const fromOwner = validateOwner(request);
    const toOwner = validateRekeyDestination(request, fromOwner);
    return withMutationLock(() => {
      const drafts = readDrafts();
      const source = drafts.get(fromOwner.draftKey);
      if (
        !source ||
        (typeof source.expiresAt === "number" && source.expiresAt <= now()) ||
        !composerDraftMatchesOwner(source, fromOwner) ||
        drafts.has(toOwner.draftKey) ||
        fromOwner.draftKey === toOwner.draftKey
      ) {
        return { rekeyed: false, rekeyedAttachmentCount: 0 };
      }

      const rekeyedDraft = normalizeComposerDraft({
        ...source,
        draftKey: toOwner.draftKey,
        taskId: toOwner.taskId ?? null,
        ...(toOwner.remoteDeviceId ? { remoteDeviceId: toOwner.remoteDeviceId } : {}),
      });
      if (!rekeyedDraft || !composerDraftMatchesOwner(rekeyedDraft, toOwner)) {
        throw new Error("Composer draft rekey destination is invalid.");
      }

      const attachmentMove = options.rekeyAttachments?.(fromOwner, toOwner);
      if (attachmentMove === false) return { rekeyed: false, rekeyedAttachmentCount: 0 };
      const rekeyedAttachmentCount = nonNegativeCount(attachmentMove?.rekeyedAttachmentCount);
      drafts.delete(fromOwner.draftKey);
      drafts.set(toOwner.draftKey, rekeyedDraft);
      try {
        writeDrafts(drafts);
      } catch (error) {
        try {
          attachmentMove?.rollback();
        } catch {
          // Keep the original storage error; rollback is owned by the file adapter.
        }
        throw error;
      }
      return { rekeyed: true, rekeyedAttachmentCount };
    });
  };

  return {
    methods: {
      getComposerDraft,
      upsertComposerDraft,
      clearComposerDraft,
      rekeyComposerDraft,
    },
    dispose: () => {
      disposed = true;
    },
  };
}

function validateOwner(value: unknown): BrowserComposerDraftOwner {
  if (!isRecord(value)) throw new Error("Invalid composer draft owner.");
  const scope = value.scope === "local" || value.scope === "remote" ? value.scope : null;
  if (!scope) throw new Error("Invalid composer draft scope.");
  const workspaceId = normalizedRequiredString(value.workspaceId, "workspaceId", 256);
  const surface = value.surface === "main" || value.surface === "side-chat" ? value.surface : null;
  if (!surface) throw new Error("Invalid composer draft surface.");
  const taskId = normalizedOptionalString(value.taskId);
  const remoteDeviceId = normalizedOptionalString(value.remoteDeviceId);
  if (taskId && taskId.length > 256) throw new Error("taskId is too long.");
  if (remoteDeviceId && remoteDeviceId.length > 256) throw new Error("remoteDeviceId is too long.");
  if (scope === "local" && remoteDeviceId) {
    throw new Error("Local composer drafts cannot include a remote device.");
  }
  if (scope === "remote" && (!remoteDeviceId || !taskId)) {
    throw new Error("Remote composer drafts require a device and task.");
  }
  const draftKey = normalizedRequiredString(value.draftKey, "draftKey", 1024);
  const owner: BrowserComposerDraftOwner = {
    draftKey,
    scope,
    workspaceId,
    surface,
    taskId,
    ...(remoteDeviceId ? { remoteDeviceId } : {}),
  };
  if (
    draftKey !==
    buildComposerDraftKey({
      scope,
      workspaceId,
      taskId: taskId ?? undefined,
      surface,
      remoteDeviceId: remoteDeviceId ?? undefined,
    })
  ) {
    throw new Error("Composer draft key does not match its owner.");
  }
  return owner;
}

function validateRekeyDestination(
  value: ComposerDraftRekeyRequest,
  fromOwner: BrowserComposerDraftOwner,
): BrowserComposerDraftOwner {
  if (!isRecord(value)) throw new Error("Invalid composer draft rekey request.");
  const taskId = normalizedOptionalString(value.nextTaskId);
  const remoteDeviceId = normalizedOptionalString(value.nextRemoteDeviceId);
  if (taskId && taskId.length > 256) throw new Error("nextTaskId is too long.");
  if (remoteDeviceId && remoteDeviceId.length > 256) {
    throw new Error("nextRemoteDeviceId is too long.");
  }
  if (fromOwner.scope === "remote" && (!taskId || !remoteDeviceId)) {
    throw new Error("Remote composer drafts require a destination device and task.");
  }
  if (fromOwner.scope === "local" && remoteDeviceId) {
    throw new Error("Local composer drafts cannot include a remote device.");
  }
  const draftKey = normalizedRequiredString(value.nextDraftKey, "nextDraftKey", 1024);
  const owner: BrowserComposerDraftOwner = {
    draftKey,
    scope: fromOwner.scope,
    workspaceId: fromOwner.workspaceId,
    surface: fromOwner.surface,
    taskId,
    ...(remoteDeviceId ? { remoteDeviceId } : {}),
  };
  if (
    draftKey !==
    buildComposerDraftKey({
      scope: owner.scope,
      workspaceId: owner.workspaceId,
      taskId: taskId ?? undefined,
      surface: owner.surface,
      remoteDeviceId: remoteDeviceId ?? undefined,
    })
  ) {
    throw new Error("Composer draft rekey must stay within the same workspace and surface.");
  }
  return owner;
}

function requireOwnedDraft(value: unknown): ComposerDraft {
  const draft = normalizeOwnedDraft(value);
  if (!draft) throw new Error("Invalid composer draft.");
  return draft;
}

function normalizeOwnedDraft(value: unknown): ComposerDraft | null {
  const draft = normalizeComposerDraft(value);
  if (!draft) return null;
  const scope = draft.remoteDeviceId ? "remote" : "local";
  const expectedKey = buildComposerDraftKey({
    scope,
    workspaceId: draft.workspaceId,
    taskId: draft.taskId,
    surface: draft.surface,
    remoteDeviceId: draft.remoteDeviceId,
  });
  return draft.draftKey === expectedKey ? draft : null;
}

function cloneDraft(draft: ComposerDraft): ComposerDraft {
  return JSON.parse(JSON.stringify(draft)) as ComposerDraft;
}

function normalizedRequiredString(value: unknown, field: string, maxLength: number): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new Error(`${field} is required.`);
  if (normalized.length > maxLength) throw new Error(`${field} is too long.`);
  return normalized;
}

function normalizedOptionalString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function normalizeIdentityPart(value: unknown, field: string): string {
  return normalizedRequiredString(value, field, 256);
}

function nonNegativeCount(value: unknown): number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function browserLockManager(): BrowserComposerDraftLockManager | null {
  if (typeof navigator === "undefined" || !navigator.locks?.request) return null;
  // The DOM lib currently types LockGrantedCallback as synchronous even
  // though Web Locks holds the lock until a returned promise settles.
  const request = navigator.locks.request.bind(navigator.locks) as unknown as <T>(
    name: string,
    options: LockOptions,
    callback: () => T | Promise<T>,
  ) => Promise<T>;
  return {
    request: <T>(name: string, callback: () => T | Promise<T>): Promise<T> =>
      request<T>(name, { mode: "exclusive" }, callback),
  };
}

function isQuotaExceeded(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const value = error as { name?: unknown; code?: unknown };
  return (
    value.name === "QuotaExceededError" ||
    value.name === "NS_ERROR_DOM_QUOTA_REACHED" ||
    value.code === 22 ||
    value.code === 1014
  );
}
