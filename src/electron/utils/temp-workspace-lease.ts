import { isTempWorkspaceId } from "../../shared/types";

const leaseByWorkspaceId = new Map<string, number>();
const DEFAULT_LEASE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours

export function touchTempWorkspaceLease(workspaceId: string, nowMs: number = Date.now()): void {
  if (!isTempWorkspaceId(workspaceId)) return;
  leaseByWorkspaceId.set(workspaceId, nowMs);
}

export function getActiveTempWorkspaceLeases(
  nowMs: number = Date.now(),
  ttlMs: number = DEFAULT_LEASE_TTL_MS,
): string[] {
  const cutoff = nowMs - Math.max(0, ttlMs);
  const active: string[] = [];
  for (const [workspaceId, touchedAt] of leaseByWorkspaceId.entries()) {
    if (touchedAt >= cutoff) {
      active.push(workspaceId);
      continue;
    }
    leaseByWorkspaceId.delete(workspaceId);
  }
  return active;
}
