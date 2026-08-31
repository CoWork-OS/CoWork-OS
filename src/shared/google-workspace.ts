import type {
  GoogleWorkspaceAccount,
  GoogleWorkspaceConnectionMode,
  GoogleWorkspaceSettingsData,
} from "./types";
export type { GoogleWorkspaceConnectionMode } from "./types";

export const GOOGLE_SCOPE_DRIVE = "https://www.googleapis.com/auth/drive";
export const GOOGLE_SCOPE_GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
export const GOOGLE_SCOPE_GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
export const GOOGLE_SCOPE_GMAIL_LABELS = "https://www.googleapis.com/auth/gmail.labels";
export const GOOGLE_SCOPE_GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
export const GOOGLE_SCOPE_CALENDAR = "https://www.googleapis.com/auth/calendar";
export const GOOGLE_SCOPE_SPREADSHEETS = "https://www.googleapis.com/auth/spreadsheets";
export const GOOGLE_SCOPE_DOCUMENTS = "https://www.googleapis.com/auth/documents";
export const GOOGLE_SCOPE_TASKS = "https://www.googleapis.com/auth/tasks";
export const GOOGLE_SCOPE_PRESENTATIONS = "https://www.googleapis.com/auth/presentations";
export const GOOGLE_SCOPE_CHAT_MESSAGES = "https://www.googleapis.com/auth/chat.messages";
export const GOOGLE_SCOPE_CHAT_SPACES_READONLY =
  "https://www.googleapis.com/auth/chat.spaces.readonly";

export const GOOGLE_WORKSPACE_DEFAULT_SCOPES = [
  GOOGLE_SCOPE_DRIVE,
  GOOGLE_SCOPE_GMAIL_READONLY,
  GOOGLE_SCOPE_GMAIL_SEND,
  GOOGLE_SCOPE_GMAIL_LABELS,
  GOOGLE_SCOPE_GMAIL_MODIFY,
  GOOGLE_SCOPE_CALENDAR,
  GOOGLE_SCOPE_SPREADSHEETS,
  GOOGLE_SCOPE_DOCUMENTS,
  GOOGLE_SCOPE_TASKS,
  GOOGLE_SCOPE_PRESENTATIONS,
  GOOGLE_SCOPE_CHAT_MESSAGES,
  GOOGLE_SCOPE_CHAT_SPACES_READONLY,
];

export const GMAIL_DEFAULT_SCOPES = [
  GOOGLE_SCOPE_GMAIL_READONLY,
  GOOGLE_SCOPE_GMAIL_SEND,
  GOOGLE_SCOPE_GMAIL_LABELS,
  GOOGLE_SCOPE_GMAIL_MODIFY,
];

export function hasScope(scopes: string[] | undefined, scope: string): boolean {
  return Boolean(scopes?.some((entry) => entry.trim() === scope));
}

export function normalizeGoogleWorkspaceScopes(scopes: string[] | undefined): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();
  for (const scope of scopes || []) {
    const trimmed = scope.trim();
    if (!trimmed || seen.has(trimmed)) continue;
    seen.add(trimmed);
    normalized.push(trimmed);
  }
  return normalized;
}

export function mergeGoogleWorkspaceScopes(scopes: string[] | undefined): string[] {
  return normalizeGoogleWorkspaceScopes([...(scopes || []), ...GOOGLE_WORKSPACE_DEFAULT_SCOPES]);
}

export function getMissingGoogleWorkspaceScopes(scopes: string[] | undefined): string[] {
  if (!scopes || scopes.length === 0) return [];
  const granted = new Set(normalizeGoogleWorkspaceScopes(scopes));
  return GOOGLE_WORKSPACE_DEFAULT_SCOPES.filter((scope) => !granted.has(scope));
}

export function mergeGoogleScopesForMode(
  scopes: string[] | undefined,
  mode: GoogleWorkspaceConnectionMode | undefined,
): string[] {
  const defaults = mode === "workspace" ? GOOGLE_WORKSPACE_DEFAULT_SCOPES : GMAIL_DEFAULT_SCOPES;
  return normalizeGoogleWorkspaceScopes([...(scopes || []), ...defaults]);
}

export function getMissingGoogleScopesForMode(
  scopes: string[] | undefined,
  mode: GoogleWorkspaceConnectionMode | undefined,
): string[] {
  if (!scopes || scopes.length === 0) return [];
  const defaults = mode === "workspace" ? GOOGLE_WORKSPACE_DEFAULT_SCOPES : GMAIL_DEFAULT_SCOPES;
  const granted = new Set(normalizeGoogleWorkspaceScopes(scopes));
  return defaults.filter((scope) => !granted.has(scope));
}

export function inferGoogleWorkspaceConnectionMode(
  explicitMode: GoogleWorkspaceConnectionMode | undefined,
  scopes: string[] | undefined,
): GoogleWorkspaceConnectionMode {
  if (explicitMode === "gmail" || explicitMode === "workspace") return explicitMode;
  const normalized = new Set(normalizeGoogleWorkspaceScopes(scopes));
  return GOOGLE_WORKSPACE_DEFAULT_SCOPES.some(
    (scope) => !GMAIL_DEFAULT_SCOPES.includes(scope) && normalized.has(scope),
  )
    ? "workspace"
    : "gmail";
}

export function hasGoogleWorkspaceScopeCoverage(
  scopes: string[] | undefined,
  mode: GoogleWorkspaceConnectionMode | undefined,
): boolean {
  return getMissingGoogleScopesForMode(scopes, mode).length === 0;
}

export function normalizeGoogleAccountEmail(email: string | undefined): string | undefined {
  const normalized = email?.trim().toLowerCase();
  return normalized || undefined;
}

export function getActiveGoogleWorkspaceAccount(
  settings: GoogleWorkspaceSettingsData,
  requestedEmail?: string,
): GoogleWorkspaceAccount | undefined {
  const accounts = settings.accounts || [];
  if (accounts.length === 0) return undefined;

  const requested = normalizeGoogleAccountEmail(requestedEmail);
  const active = normalizeGoogleAccountEmail(settings.activeAccountEmail);
  const target = requested || active;
  if (target) {
    const exact = accounts.find((account) => normalizeGoogleAccountEmail(account.email) === target);
    if (exact) return exact;
  }

  return accounts.find((account) => account.accessToken || account.refreshToken) ?? accounts[0];
}

export function getGoogleWorkspaceSettingsForAccount(
  settings: GoogleWorkspaceSettingsData,
  requestedEmail?: string,
): GoogleWorkspaceSettingsData {
  const account = getActiveGoogleWorkspaceAccount(settings, requestedEmail);
  if (!account) return settings;

  return {
    ...settings,
    connectionMode: account.connectionMode ?? settings.connectionMode,
    accessToken: account.accessToken,
    refreshToken: account.refreshToken,
    tokenExpiresAt: account.tokenExpiresAt,
    scopes: account.scopes ?? settings.scopes,
    loginHint: account.email,
  };
}

export function hasGoogleWorkspaceTokens(settings: GoogleWorkspaceSettingsData): boolean {
  return Boolean(
    settings.accessToken ||
    settings.refreshToken ||
    settings.accounts?.some((account) => account.accessToken || account.refreshToken),
  );
}

export function upsertGoogleWorkspaceAccount(
  settings: GoogleWorkspaceSettingsData,
  account: GoogleWorkspaceAccount,
): GoogleWorkspaceSettingsData {
  const email = normalizeGoogleAccountEmail(account.email);
  if (!email) return settings;

  const existingAccounts = settings.accounts || [];
  const existing = existingAccounts.find(
    (item) => normalizeGoogleAccountEmail(item.email) === email,
  );
  const merged: GoogleWorkspaceAccount = {
    ...existing,
    ...account,
    email,
    scopes: normalizeGoogleWorkspaceScopes(account.scopes ?? existing?.scopes ?? settings.scopes),
    connectionMode: account.connectionMode ?? existing?.connectionMode ?? settings.connectionMode,
    refreshToken: account.refreshToken ?? existing?.refreshToken,
    connectedAt: account.connectedAt ?? existing?.connectedAt ?? Date.now(),
  };
  const accounts = [
    ...existingAccounts.filter((item) => normalizeGoogleAccountEmail(item.email) !== email),
    merged,
  ];

  return {
    ...settings,
    enabled: true,
    accounts,
    activeAccountEmail: email,
    connectionMode: merged.connectionMode ?? settings.connectionMode,
    accessToken: merged.accessToken,
    refreshToken: merged.refreshToken,
    tokenExpiresAt: merged.tokenExpiresAt,
    scopes: merged.scopes,
    loginHint: email,
  };
}

export function removeGoogleWorkspaceAccount(
  settings: GoogleWorkspaceSettingsData,
  email: string,
): GoogleWorkspaceSettingsData {
  const target = normalizeGoogleAccountEmail(email);
  if (!target) return settings;
  const accounts = (settings.accounts || []).filter(
    (account) => normalizeGoogleAccountEmail(account.email) !== target,
  );
  const active = getActiveGoogleWorkspaceAccount({ ...settings, accounts });
  return {
    ...settings,
    accounts,
    activeAccountEmail: active?.email,
    accessToken: active?.accessToken,
    refreshToken: active?.refreshToken,
    tokenExpiresAt: active?.tokenExpiresAt,
    scopes: active?.scopes ?? settings.scopes,
    connectionMode: active?.connectionMode ?? settings.connectionMode,
    loginHint: active?.email ?? settings.loginHint,
  };
}
