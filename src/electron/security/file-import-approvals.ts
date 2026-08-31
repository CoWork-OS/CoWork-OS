import path from "path";

const APPROVAL_TTL_MS = 10 * 60 * 1000;
const MAX_APPROVED_IMPORTS = 512;

const approvedImportPaths = new Map<string, number>();

function normalizeImportPath(filePath: string): string {
  return path.resolve(filePath);
}

function pruneExpiredApprovals(now: number): void {
  for (const [filePath, expiresAt] of approvedImportPaths.entries()) {
    if (expiresAt <= now) {
      approvedImportPaths.delete(filePath);
    }
  }

  if (approvedImportPaths.size <= MAX_APPROVED_IMPORTS) {
    return;
  }

  const oldestEntries = Array.from(approvedImportPaths.entries()).sort(
    (left, right) => left[1] - right[1],
  );
  for (const [filePath] of oldestEntries.slice(
    0,
    approvedImportPaths.size - MAX_APPROVED_IMPORTS,
  )) {
    approvedImportPaths.delete(filePath);
  }
}

export function rememberApprovedImportFiles(filePaths: string[]): void {
  const now = Date.now();
  pruneExpiredApprovals(now);
  const expiresAt = now + APPROVAL_TTL_MS;
  for (const filePath of filePaths) {
    if (typeof filePath !== "string" || filePath.trim().length === 0) continue;
    approvedImportPaths.set(normalizeImportPath(filePath), expiresAt);
  }
  pruneExpiredApprovals(now);
}

export function isApprovedImportFile(filePath: string): boolean {
  const now = Date.now();
  pruneExpiredApprovals(now);
  const normalized = normalizeImportPath(filePath);
  const expiresAt = approvedImportPaths.get(normalized);
  if (!expiresAt || expiresAt <= now) {
    approvedImportPaths.delete(normalized);
    return false;
  }
  return true;
}
