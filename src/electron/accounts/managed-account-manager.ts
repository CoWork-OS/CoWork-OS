import { randomUUID } from "node:crypto";
import { SecureSettingsRepository } from "../database/SecureSettingsRepository";

const SETTINGS_CATEGORY: `plugin:${string}` = "plugin:managed-accounts";
const STATE_VERSION = 1 as const;
const MAX_ACCOUNTS = 500;
const MAX_URL_LENGTH = 2048;
const MAX_NOTES_LENGTH = 8000;
const MAX_METADATA_BYTES = 64 * 1024;
const MAX_SECRET_VALUE_LENGTH = 4096;
const MAX_SECRETS_PER_ACCOUNT = 64;

export type ManagedAccountStatus =
  | "draft"
  | "pending_signup"
  | "pending_verification"
  | "active"
  | "blocked"
  | "disabled"
  | "error";

export interface ManagedAccountRecord {
  id: string;
  provider: string;
  label: string;
  status: ManagedAccountStatus;
  signupUrl?: string;
  dashboardUrl?: string;
  docsUrl?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
  secrets?: Record<string, string>;
  lastVerifiedAt?: number;
  lastError?: string;
  createdAt: number;
  updatedAt: number;
}

interface ManagedAccountState {
  version: typeof STATE_VERSION;
  accounts: ManagedAccountRecord[];
}

export interface ManagedAccountListOptions {
  provider?: string;
  status?: ManagedAccountStatus;
}

export interface UpsertManagedAccountInput {
  id?: string;
  provider?: string;
  label?: string;
  status?: ManagedAccountStatus;
  signupUrl?: string;
  dashboardUrl?: string;
  docsUrl?: string;
  notes?: string;
  metadata?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  clearSecrets?: boolean;
  lastVerifiedAt?: number;
  lastError?: string;
}

export type ManagedAccountPublicView = Omit<ManagedAccountRecord, "secrets"> & {
  secrets?: Record<string, string>;
  secretKeys?: string[];
  secretCount?: number;
};

const DEFAULT_STATE: ManagedAccountState = {
  version: STATE_VERSION,
  accounts: [],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function sanitizeIdentifier(value: unknown, maxLength = 120): string {
  if (typeof value !== "string") return "";
  const trimmed = value.trim().toLowerCase();
  if (!trimmed) return "";
  return trimmed
    .replace(/[^a-z0-9._:-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, maxLength);
}

function sanitizeOptionalString(value: unknown, maxLength = 512): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function sanitizeOptionalUrl(value: unknown): string | undefined {
  const candidate = sanitizeOptionalString(value, MAX_URL_LENGTH);
  if (!candidate) return undefined;
  try {
    const url = new URL(candidate);
    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return undefined;
    }
    return url.toString();
  } catch {
    return undefined;
  }
}

function sanitizeStatus(value: unknown): ManagedAccountStatus | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().toLowerCase();
  switch (normalized) {
    case "draft":
    case "pending_signup":
    case "pending_verification":
    case "active":
    case "blocked":
    case "disabled":
    case "error":
      return normalized;
    default:
      return undefined;
  }
}

function sanitizeSecrets(value: unknown): Record<string, string> | undefined {
  if (!isRecord(value)) return undefined;
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(value)) {
    if (Object.keys(out).length >= MAX_SECRETS_PER_ACCOUNT) break;
    const key = sanitizeIdentifier(k, 120);
    if (!key || typeof v !== "string") continue;
    const secret = v.trim();
    if (!secret) continue;
    out[key] = secret.slice(0, MAX_SECRET_VALUE_LENGTH);
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function sanitizeMetadata(value: unknown): Record<string, unknown> | undefined {
  if (!isRecord(value)) return undefined;
  try {
    const json = JSON.stringify(value);
    if (Buffer.byteLength(json, "utf8") > MAX_METADATA_BYTES) {
      throw new Error("metadata too large");
    }
    const parsed = JSON.parse(json) as unknown;
    return isRecord(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function sanitizeTimestamp(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  const rounded = Math.floor(value);
  if (rounded <= 0) return undefined;
  return rounded;
}

function sanitizeStoredRecord(input: unknown): ManagedAccountRecord | undefined {
  if (!isRecord(input)) return undefined;

  const id = sanitizeIdentifier(input.id, 180);
  const provider = sanitizeIdentifier(input.provider);
  if (!id || !provider) return undefined;

  const now = Date.now();
  const createdAt = sanitizeTimestamp(input.createdAt) ?? now;
  const updatedAt = sanitizeTimestamp(input.updatedAt) ?? createdAt;

  const status = sanitizeStatus(input.status) ?? "draft";
  const label = sanitizeOptionalString(input.label, 160) ?? provider;

  return {
    id,
    provider,
    label,
    status,
    signupUrl: sanitizeOptionalUrl(input.signupUrl),
    dashboardUrl: sanitizeOptionalUrl(input.dashboardUrl),
    docsUrl: sanitizeOptionalUrl(input.docsUrl),
    notes: sanitizeOptionalString(input.notes, MAX_NOTES_LENGTH),
    metadata: sanitizeMetadata(input.metadata),
    secrets: sanitizeSecrets(input.secrets),
    lastVerifiedAt: sanitizeTimestamp(input.lastVerifiedAt),
    lastError: sanitizeOptionalString(input.lastError, 500),
    createdAt,
    updatedAt,
  };
}

function normalizeState(raw: unknown): ManagedAccountState {
  if (!isRecord(raw) || !Array.isArray(raw.accounts)) {
    return { ...DEFAULT_STATE };
  }

  const byId = new Map<string, ManagedAccountRecord>();
  for (const candidate of raw.accounts) {
    const normalized = sanitizeStoredRecord(candidate);
    if (!normalized) continue;
    const existing = byId.get(normalized.id);
    if (!existing || normalized.updatedAt >= existing.updatedAt) {
      byId.set(normalized.id, normalized);
    }
  }

  const accounts = Array.from(byId.values())
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, MAX_ACCOUNTS);

  return {
    version: STATE_VERSION,
    accounts,
  };
}

function getRepository(): SecureSettingsRepository {
  if (!SecureSettingsRepository.isInitialized()) {
    throw new Error("SecureSettingsRepository not initialized");
  }
  return SecureSettingsRepository.getInstance();
}

export class ManagedAccountManager {
  static loadAll(): ManagedAccountRecord[] {
    try {
      const repo = getRepository();
      const stored = repo.load<ManagedAccountState>(SETTINGS_CATEGORY);
      return normalizeState(stored).accounts;
    } catch (error) {
      console.error("[ManagedAccountManager] Failed to load accounts:", error);
      return [];
    }
  }

  static list(options?: ManagedAccountListOptions): ManagedAccountRecord[] {
    const providerFilter = sanitizeIdentifier(options?.provider);
    const statusFilter = sanitizeStatus(options?.status);

    return this.loadAll().filter((account) => {
      if (providerFilter && account.provider !== providerFilter) return false;
      if (statusFilter && account.status !== statusFilter) return false;
      return true;
    });
  }

  static getById(id: string): ManagedAccountRecord | undefined {
    const accountId = sanitizeIdentifier(id, 180);
    if (!accountId) return undefined;
    return this.loadAll().find((account) => account.id === accountId);
  }

  static upsert(input: UpsertManagedAccountInput): ManagedAccountRecord {
    const now = Date.now();
    const state = this.readState();

    const normalizedId = sanitizeIdentifier(input.id, 180);
    const existingIndex = normalizedId
      ? state.accounts.findIndex((account) => account.id === normalizedId)
      : -1;

    if (existingIndex >= 0) {
      const existing = state.accounts[existingIndex];
      const provider =
        input.provider !== undefined ? sanitizeIdentifier(input.provider) : existing.provider;
      if (!provider) {
        throw new Error("provider is required");
      }

      const mergedSecrets = (() => {
        const incomingSecrets = sanitizeSecrets(input.secrets);
        if (input.clearSecrets) {
          return incomingSecrets;
        }
        if (!incomingSecrets) {
          return existing.secrets;
        }
        return { ...(existing.secrets || {}), ...incomingSecrets };
      })();

      const updated: ManagedAccountRecord = {
        ...existing,
        provider,
        label:
          input.label !== undefined
            ? sanitizeOptionalString(input.label, 160) || provider
            : existing.label,
        status: sanitizeStatus(input.status) ?? existing.status,
        signupUrl:
          input.signupUrl !== undefined
            ? sanitizeOptionalUrl(input.signupUrl)
            : existing.signupUrl,
        dashboardUrl:
          input.dashboardUrl !== undefined
            ? sanitizeOptionalUrl(input.dashboardUrl)
            : existing.dashboardUrl,
        docsUrl: input.docsUrl !== undefined ? sanitizeOptionalUrl(input.docsUrl) : existing.docsUrl,
        notes:
          input.notes !== undefined
            ? sanitizeOptionalString(input.notes, MAX_NOTES_LENGTH)
            : existing.notes,
        metadata:
          input.metadata !== undefined ? sanitizeMetadata(input.metadata) : existing.metadata,
        secrets: mergedSecrets,
        lastVerifiedAt:
          input.lastVerifiedAt !== undefined
            ? sanitizeTimestamp(input.lastVerifiedAt)
            : existing.lastVerifiedAt,
        lastError:
          input.lastError !== undefined
            ? sanitizeOptionalString(input.lastError, 500)
            : existing.lastError,
        updatedAt: now,
      };

      state.accounts[existingIndex] = updated;
      this.saveState(state);
      return updated;
    }

    const provider = sanitizeIdentifier(input.provider);
    if (!provider) {
      throw new Error("provider is required");
    }

    const id = normalizedId || randomUUID();
    if (state.accounts.some((account) => account.id === id)) {
      throw new Error(`account already exists: ${id}`);
    }

    const created: ManagedAccountRecord = {
      id,
      provider,
      label: sanitizeOptionalString(input.label, 160) || provider,
      status: sanitizeStatus(input.status) ?? "draft",
      signupUrl: sanitizeOptionalUrl(input.signupUrl),
      dashboardUrl: sanitizeOptionalUrl(input.dashboardUrl),
      docsUrl: sanitizeOptionalUrl(input.docsUrl),
      notes: sanitizeOptionalString(input.notes, MAX_NOTES_LENGTH),
      metadata: sanitizeMetadata(input.metadata),
      secrets: sanitizeSecrets(input.secrets),
      lastVerifiedAt: sanitizeTimestamp(input.lastVerifiedAt),
      lastError: sanitizeOptionalString(input.lastError, 500),
      createdAt: now,
      updatedAt: now,
    };

    state.accounts.unshift(created);
    if (state.accounts.length > MAX_ACCOUNTS) {
      state.accounts = state.accounts.slice(0, MAX_ACCOUNTS);
    }

    this.saveState(state);
    return created;
  }

  static remove(id: string): boolean {
    const accountId = sanitizeIdentifier(id, 180);
    if (!accountId) return false;

    const state = this.readState();
    const before = state.accounts.length;
    state.accounts = state.accounts.filter((account) => account.id !== accountId);
    if (state.accounts.length === before) {
      return false;
    }
    this.saveState(state);
    return true;
  }

  static toPublicView(account: ManagedAccountRecord, includeSecrets = false): ManagedAccountPublicView {
    const { secrets, ...rest } = account;

    if (includeSecrets) {
      return {
        ...rest,
        ...(secrets ? { secrets } : {}),
      };
    }

    const secretKeys = secrets ? Object.keys(secrets) : [];
    return {
      ...rest,
      ...(secretKeys.length > 0
        ? {
            secretKeys,
            secretCount: secretKeys.length,
          }
        : {}),
    };
  }

  private static readState(): ManagedAccountState {
    try {
      const repo = getRepository();
      const stored = repo.load<ManagedAccountState>(SETTINGS_CATEGORY);
      return normalizeState(stored);
    } catch (error) {
      console.error("[ManagedAccountManager] Failed to read state:", error);
      return { ...DEFAULT_STATE };
    }
  }

  private static saveState(state: ManagedAccountState): void {
    const normalized = normalizeState(state);
    const repo = getRepository();
    repo.save(SETTINGS_CATEGORY, normalized);
  }
}
