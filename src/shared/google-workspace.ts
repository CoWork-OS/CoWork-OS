export const GOOGLE_SCOPE_DRIVE = "https://www.googleapis.com/auth/drive";
export const GOOGLE_SCOPE_GMAIL_READONLY = "https://www.googleapis.com/auth/gmail.readonly";
export const GOOGLE_SCOPE_GMAIL_SEND = "https://www.googleapis.com/auth/gmail.send";
export const GOOGLE_SCOPE_GMAIL_LABELS = "https://www.googleapis.com/auth/gmail.labels";
export const GOOGLE_SCOPE_GMAIL_MODIFY = "https://www.googleapis.com/auth/gmail.modify";
export const GOOGLE_SCOPE_CALENDAR = "https://www.googleapis.com/auth/calendar";

export const GOOGLE_WORKSPACE_DEFAULT_SCOPES = [
  GOOGLE_SCOPE_DRIVE,
  GOOGLE_SCOPE_GMAIL_READONLY,
  GOOGLE_SCOPE_GMAIL_SEND,
  GOOGLE_SCOPE_GMAIL_MODIFY,
  GOOGLE_SCOPE_CALENDAR,
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

