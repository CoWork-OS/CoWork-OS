import type { SessionShareSnapshot } from "../../shared/types";

/**
 * A work context always has one local owner. Treat it as shared only when the
 * user has invited someone, another member joined, or the current actor is a
 * non-owner participant.
 */
export function hasSharedSessionActivity(
  snapshot: Pick<SessionShareSnapshot, "members" | "invites" | "actor">,
): boolean {
  const activeMembers = snapshot.members.filter((member) => member.status === "active");
  const pendingInvites = snapshot.invites.some((invite) => invite.expiresAt > Date.now());
  return activeMembers.length > 1 || pendingInvites || snapshot.actor.role !== "owner";
}

/**
 * Local preview is an opt-in developer surface. A workspace is eligible when
 * its package manifest exposes an explicitly named `dev` script; an already
 * started preview is handled separately by the card so failed/stopped runs
 * remain recoverable.
 */
export function hasLocalPreviewDevScript(manifest: unknown): boolean {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) return false;
  const scripts = (manifest as { scripts?: unknown }).scripts;
  if (!scripts || typeof scripts !== "object" || Array.isArray(scripts)) return false;
  const devScript = (scripts as { dev?: unknown }).dev;
  return typeof devScript === "string" && devScript.trim().length > 0;
}
