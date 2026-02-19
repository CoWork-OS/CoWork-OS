/**
 * Shared LOOM/Email protocol helpers
 */

export type EmailProtocol = 'imap-smtp' | 'loom';

const LOCALHOST_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1']);

export function isLocalhostHost(hostname: string): boolean {
  return LOCALHOST_HOSTNAMES.has(String(hostname).toLowerCase());
}

export function isSecureOrLocalLoomUrl(rawUrl: string): boolean {
  try {
    const parsed = new URL(rawUrl);
    if (LOCALHOST_HOSTNAMES.has(parsed.hostname.toLowerCase())) return true;
    return parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

export function assertSafeLoomBaseUrl(rawBaseUrl: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(String(rawBaseUrl || '').trim());
  } catch {
    throw new Error('LOOM base URL must be a valid URL');
  }

  if (!isSecureOrLocalLoomUrl(parsed.toString())) {
    throw new Error('LOOM base URL must use HTTPS unless it points to localhost/127.0.0.1/::1');
  }

  return parsed;
}

export function normalizeLoomBaseUrl(raw: string | URL): URL {
  const baseUrl = new URL(raw.toString());
  const normalizedPath = baseUrl.pathname.replace(/\/+$/, '');
  baseUrl.pathname = normalizedPath || '/';
  return baseUrl;
}

export function normalizeEmailProtocol(rawProtocol: unknown): EmailProtocol {
  return String(rawProtocol || '').trim().toLowerCase() === 'loom' ? 'loom' : 'imap-smtp';
}

const LOOM_MAILBOX_FOLDER_PATTERN = /^[A-Za-z0-9 ._+()\-/]+$/;

export function assertSafeLoomMailboxFolder(rawFolder: unknown): string {
  const folder = String(rawFolder || 'INBOX').trim() || 'INBOX';
  const hasTraversal = folder.includes('..');
  if (!LOOM_MAILBOX_FOLDER_PATTERN.test(folder) || hasTraversal) {
    throw new Error('LOOM mailbox folder contains invalid characters');
  }
  return folder;
}
