export const MICROSOFT_EMAIL_OAUTH_DEFAULT_SCOPES = [
  "https://graph.microsoft.com/Mail.ReadWrite",
  "offline_access",
] as const;

export const MICROSOFT_EMAIL_GRAPH_READWRITE_SCOPES = [
  "https://graph.microsoft.com/Mail.ReadWrite",
  "offline_access",
] as const;

export const MICROSOFT_EMAIL_GRAPH_SEND_SCOPES = [
  "https://graph.microsoft.com/Mail.ReadWrite",
  "https://graph.microsoft.com/Mail.Send",
  "offline_access",
] as const;

export const MICROSOFT_EMAIL_DEFAULT_TENANT = "consumers";

export const MICROSOFT_GRAPH_MAIL_READWRITE_SCOPE = "https://graph.microsoft.com/Mail.ReadWrite";
const OFFLINE_ACCESS_SCOPE = "offline_access";

export function normalizeMicrosoftEmailReadScopes(scopes?: readonly string[]): string[] {
  const normalized = new Set((scopes || []).map((scope) => scope.trim().toLowerCase()));
  const readScopes = normalized.has(MICROSOFT_GRAPH_MAIL_READWRITE_SCOPE.toLowerCase())
    ? [MICROSOFT_GRAPH_MAIL_READWRITE_SCOPE]
    : [];
  return readScopes.length > 0
    ? [...readScopes, OFFLINE_ACCESS_SCOPE]
    : [...MICROSOFT_EMAIL_GRAPH_READWRITE_SCOPES];
}
